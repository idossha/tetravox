//! GIfTI (`.surf.gii`, `.func.gii`, `.shape.gii`, `.label.gii`) — XML via `quick-xml` (§6.2).
//!
//! The three encodings §6.2 accepts are `ASCII`, `Base64Binary` and `GZipBase64Binary`.
//! **`GZipBase64Binary` is a zlib stream, not gzip** — `ZlibDecoder`, never `GzDecoder`; the
//! reference surfaces are written that way `[DATA]` and a `GzDecoder` fails on their first byte.
//! `ExternalFileBinary` is `Error::Unsupported` by name: the byte-slice signature has no
//! sibling-file access.

use std::io::Read;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use flate2::read::ZlibDecoder;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader as XmlReader;
use tvx_core::{Aabb, Field, LabelEntry, LabelTable, Phase, ProgressSink, Result};

use crate::stats::field_stats;
use crate::util::{parse_err, unsupported};
use crate::Mesh;

const INTENT_POINTSET: &str = "NIFTI_INTENT_POINTSET";
const INTENT_TRIANGLE: &str = "NIFTI_INTENT_TRIANGLE";
const SCANNER_ANAT: &str = "NIFTI_XFORM_SCANNER_ANAT";

#[derive(Default, Clone)]
struct ArrayHeader {
    intent: String,
    dtype: String,
    encoding: String,
    endian: String,
    order: String,
    dims: Vec<usize>,
    name: Option<String>,
    transformed_space: String,
    matrix: Option<[f64; 16]>,
}

impl ArrayHeader {
    fn count(&self) -> usize {
        self.dims.iter().product::<usize>()
    }
    fn rows(&self) -> usize {
        self.dims.first().copied().unwrap_or(0)
    }
    fn cols(&self) -> usize {
        let c: usize = self.dims.iter().skip(1).product();
        c.max(1)
    }
}

struct Array {
    head: ArrayHeader,
    values: Vec<f64>,
}

struct Document {
    arrays: Vec<Array>,
    labels: LabelTable,
}

#[derive(Default)]
struct State {
    head: Option<ArrayHeader>,
    arrays: Vec<Array>,
    labels: LabelTable,
    in_label_table: bool,
    in_label: bool,
    label_key: Option<u32>,
    label_rgba: [u8; 4],
    label_name: String,
    in_data: bool,
    data_text: String,
    in_matrix: bool,
    matrix_text: String,
    in_transformed: bool,
    in_md_name: bool,
    in_md_value: bool,
    md_name: String,
    md_value: String,
}

fn parse(bytes: &[u8], p: &mut dyn ProgressSink, want_data: bool) -> Result<Document> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| parse_err(format!("GIfTI is not valid UTF-8 XML: {e}")))?;
    let mut xml = XmlReader::from_str(text);
    xml.config_mut().trim_text(false);
    let mut s = State::default();

    loop {
        let ev = xml
            .read_event()
            .map_err(|e| parse_err(format!("GIfTI XML: {e}")))?;
        match ev {
            Event::Eof => break,
            Event::Start(e) => on_open(&mut s, &e)?,
            Event::Empty(e) => {
                // A self-closing element has no text children, so it opens and closes at once.
                // `<LabelTable />` and `<MetaData />` both occur in the reference surfaces, and
                // treating them as `Start` would leave the parser inside them forever.
                on_open(&mut s, &e)?;
                on_close(&mut s, e.name().0, want_data, p)?;
            }
            Event::Text(t) => {
                let raw: &str = &t;
                on_text(&mut s, raw);
            }
            Event::CData(t) => {
                let raw: &str = &t;
                let owned = raw.to_string();
                on_text(&mut s, &owned);
            }
            Event::End(e) => on_close(&mut s, e.name().0, want_data, p)?,
            _ => {}
        }
    }

    Ok(Document {
        arrays: s.arrays,
        labels: s.labels,
    })
}

fn on_open(s: &mut State, e: &BytesStart) -> Result<()> {
    match e.name().0 {
        "DataArray" => {
            let mut h = ArrayHeader::default();
            let mut dims: Vec<(usize, usize)> = Vec::new();
            for attr in e.attributes() {
                let attr = attr.map_err(|x| parse_err(format!("GIfTI XML: {x}")))?;
                let v = attr.value.as_ref().to_string();
                match attr.key.0 {
                    "Intent" => h.intent = v,
                    "DataType" => h.dtype = v,
                    "Encoding" => h.encoding = v,
                    "Endian" => h.endian = v,
                    "ArrayIndexingOrder" => h.order = v,
                    k if k.starts_with("Dim") => {
                        if let (Ok(i), Ok(d)) = (k[3..].parse::<usize>(), v.parse::<usize>()) {
                            dims.push((i, d));
                        }
                    }
                    _ => {}
                }
            }
            dims.sort_by_key(|(i, _)| *i);
            h.dims = dims.into_iter().map(|(_, d)| d).collect();
            s.head = Some(h);
        }
        "Data" => {
            s.in_data = true;
            s.data_text.clear();
        }
        "MatrixData" => {
            s.in_matrix = true;
            s.matrix_text.clear();
        }
        "TransformedSpace" => s.in_transformed = true,
        "LabelTable" => s.in_label_table = true,
        "Name" => {
            s.in_md_name = true;
            s.md_name.clear();
        }
        "Value" => {
            s.in_md_value = true;
            s.md_value.clear();
        }
        "Label" if s.in_label_table => {
            s.in_label = true;
            s.label_name.clear();
            s.label_key = None;
            s.label_rgba = [0, 0, 0, 255];
            for attr in e.attributes() {
                let attr = attr.map_err(|x| parse_err(format!("GIfTI XML: {x}")))?;
                let v = attr.value.as_ref().to_string();
                match attr.key.0 {
                    "Key" | "Index" => s.label_key = v.trim().parse::<i64>().ok().map(|k| k as u32),
                    "Red" => s.label_rgba[0] = unit_to_u8(&v),
                    "Green" => s.label_rgba[1] = unit_to_u8(&v),
                    "Blue" => s.label_rgba[2] = unit_to_u8(&v),
                    "Alpha" => s.label_rgba[3] = unit_to_u8(&v),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn on_text(s: &mut State, raw: &str) {
    if s.in_data {
        s.data_text.push_str(raw);
    } else if s.in_matrix {
        s.matrix_text.push_str(raw);
    } else if s.in_transformed {
        if let Some(h) = s.head.as_mut() {
            h.transformed_space.push_str(raw.trim());
        }
    } else if s.in_md_name {
        s.md_name.push_str(raw.trim());
    } else if s.in_md_value {
        s.md_value.push_str(raw.trim());
    } else if s.in_label {
        s.label_name.push_str(raw.trim());
    }
}

fn on_close(s: &mut State, name: &str, want_data: bool, p: &mut dyn ProgressSink) -> Result<()> {
    match name {
        "Data" => {
            s.in_data = false;
            if let Some(h) = s.head.clone() {
                let values = if want_data {
                    decode(&h, &s.data_text)?
                } else {
                    Vec::new()
                };
                s.arrays.push(Array { head: h, values });
            }
            s.data_text.clear();
        }
        "MatrixData" => {
            s.in_matrix = false;
            let nums: Vec<f64> = s
                .matrix_text
                .split_whitespace()
                .filter_map(|t| t.parse::<f64>().ok())
                .collect();
            if nums.len() == 16 {
                if let Some(h) = s.head.as_mut() {
                    let mut m = [0f64; 16];
                    m.copy_from_slice(&nums);
                    h.matrix = Some(m);
                }
            }
        }
        "TransformedSpace" => s.in_transformed = false,
        "Name" => s.in_md_name = false,
        "Value" => {
            s.in_md_value = false;
            if s.md_name == "Name" && !s.md_value.is_empty() {
                if let Some(h) = s.head.as_mut() {
                    h.name = Some(s.md_value.clone());
                }
            }
            s.md_name.clear();
            s.md_value.clear();
        }
        "Label" => {
            if s.in_label {
                s.in_label = false;
                if let Some(k) = s.label_key {
                    s.labels.entries.push(LabelEntry {
                        id: k,
                        name: std::mem::take(&mut s.label_name),
                        color: s.label_rgba,
                    });
                }
            }
        }
        "LabelTable" => s.in_label_table = false,
        "DataArray" => {
            s.head = None;
            p.report(Phase::Parse, s.arrays.len() as u64, 0);
        }
        _ => {}
    }
    Ok(())
}

fn unit_to_u8(v: &str) -> u8 {
    match v.trim().parse::<f64>() {
        // GIfTI writes 0..1 floats; a file that writes 0..255 is still readable.
        Ok(x) if x <= 1.0 => (x.clamp(0.0, 1.0) * 255.0).round() as u8,
        Ok(x) => x.clamp(0.0, 255.0).round() as u8,
        Err(_) => 0,
    }
}

fn decode(h: &ArrayHeader, text: &str) -> Result<Vec<f64>> {
    let n = h.count();
    match h.encoding.as_str() {
        "ASCII" => {
            let mut out = Vec::with_capacity(n);
            for tok in text.split_whitespace() {
                out.push(
                    tok.parse::<f64>()
                        .map_err(|e| parse_err(format!("GIfTI ASCII value {tok:?}: {e}")))?,
                );
            }
            if out.len() != n {
                return Err(parse_err(format!(
                    "GIfTI array declares {n} values, ASCII data holds {}",
                    out.len()
                )));
            }
            Ok(reorder(h, out))
        }
        "Base64Binary" | "GZipBase64Binary" => {
            let mut packed = Vec::with_capacity(text.len());
            packed.extend(text.bytes().filter(|c| !c.is_ascii_whitespace()));
            let raw = B64
                .decode(&packed)
                .map_err(|e| parse_err(format!("GIfTI base64: {e}")))?;
            let raw = if h.encoding == "GZipBase64Binary" {
                // §6.2: a **zlib** stream, not gzip.
                let mut out = Vec::new();
                ZlibDecoder::new(raw.as_slice())
                    .read_to_end(&mut out)
                    .map_err(|e| {
                        parse_err(format!("GIfTI GZipBase64Binary (zlib) inflate: {e}"))
                    })?;
                out
            } else {
                raw
            };
            let big = h.endian == "BigEndian";
            let values = widen(&h.dtype, &raw, big, n)?;
            Ok(reorder(h, values))
        }
        "ExternalFileBinary" => Err(unsupported(
            "GIfTI ExternalFileBinary (the reader is handed bytes, not a path)",
        )),
        other => Err(unsupported(format!("GIfTI Encoding {other:?}"))),
    }
}

fn widen(dtype: &str, raw: &[u8], big: bool, n: usize) -> Result<Vec<f64>> {
    macro_rules! read {
        ($w:expr, $conv:expr) => {{
            let w: usize = $w;
            if raw.len() < n * w {
                return Err(parse_err(format!(
                    "GIfTI array declares {n} values of {w} bytes, data holds {}",
                    raw.len()
                )));
            }
            let f: fn(&[u8], bool) -> f64 = $conv;
            raw[..n * w].chunks_exact(w).map(|c| f(c, big)).collect()
        }};
    }
    Ok(match dtype {
        "NIFTI_TYPE_UINT8" => read!(1, |c, _| c[0] as f64),
        "NIFTI_TYPE_INT8" => read!(1, |c, _| c[0] as i8 as f64),
        "NIFTI_TYPE_UINT16" => read!(2, |c, b| {
            let a: [u8; 2] = c.try_into().unwrap();
            (if b {
                u16::from_be_bytes(a)
            } else {
                u16::from_le_bytes(a)
            }) as f64
        }),
        "NIFTI_TYPE_INT16" => read!(2, |c, b| {
            let a: [u8; 2] = c.try_into().unwrap();
            (if b {
                i16::from_be_bytes(a)
            } else {
                i16::from_le_bytes(a)
            }) as f64
        }),
        "NIFTI_TYPE_UINT32" => read!(4, |c, b| {
            let a: [u8; 4] = c.try_into().unwrap();
            (if b {
                u32::from_be_bytes(a)
            } else {
                u32::from_le_bytes(a)
            }) as f64
        }),
        "NIFTI_TYPE_INT32" => read!(4, |c, b| {
            let a: [u8; 4] = c.try_into().unwrap();
            (if b {
                i32::from_be_bytes(a)
            } else {
                i32::from_le_bytes(a)
            }) as f64
        }),
        "NIFTI_TYPE_FLOAT32" => read!(4, |c, b| {
            let a: [u8; 4] = c.try_into().unwrap();
            (if b {
                f32::from_be_bytes(a)
            } else {
                f32::from_le_bytes(a)
            }) as f64
        }),
        "NIFTI_TYPE_FLOAT64" => read!(8, |c, b| {
            let a: [u8; 8] = c.try_into().unwrap();
            if b {
                f64::from_be_bytes(a)
            } else {
                f64::from_le_bytes(a)
            }
        }),
        other => return Err(unsupported(format!("GIfTI DataType {other:?}"))),
    })
}

/// §6.2 honours `ArrayIndexingOrder`; everything downstream is row-major.
fn reorder(h: &ArrayHeader, v: Vec<f64>) -> Vec<f64> {
    if h.order != "ColumnMajorOrder" || h.dims.len() < 2 {
        return v;
    }
    let (rows, cols) = (h.rows(), h.cols());
    if rows * cols != v.len() {
        return v;
    }
    let mut out = vec![0f64; v.len()];
    for r in 0..rows {
        for c in 0..cols {
            out[r * cols + c] = v[c * rows + r];
        }
    }
    out
}

/// §6.2's `read_gifti`.
pub fn read(bytes: &[u8], p: &mut dyn ProgressSink) -> Result<Mesh> {
    let doc = parse(bytes, p, true)?;
    let mut nodes: Vec<[f32; 3]> = Vec::new();
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let mut node_fields: Vec<Field> = Vec::new();

    for a in &doc.arrays {
        match a.head.intent.as_str() {
            INTENT_POINTSET => {
                let cols = a.head.cols();
                if cols != 3 {
                    return Err(parse_err(format!(
                        "GIfTI pointset has {cols} components, expected 3"
                    )));
                }
                // §3/§6.2: bake the CoordinateSystemTransformMatrix in when the target space is
                // scanner-anatomical, so `Mesh.nodes` is always world mm.
                let m = if a.head.transformed_space == SCANNER_ANAT {
                    a.head.matrix
                } else {
                    None
                };
                nodes.reserve_exact(a.values.len() / 3);
                for v in a.values.chunks_exact(3) {
                    let (x, y, z) = (v[0], v[1], v[2]);
                    let q = match m {
                        Some(m) => [
                            m[0] * x + m[1] * y + m[2] * z + m[3],
                            m[4] * x + m[5] * y + m[6] * z + m[7],
                            m[8] * x + m[9] * y + m[10] * z + m[11],
                        ],
                        None => [x, y, z],
                    };
                    nodes.push([q[0] as f32, q[1] as f32, q[2] as f32]);
                }
            }
            INTENT_TRIANGLE => {
                let cols = a.head.cols();
                if cols != 3 {
                    return Err(parse_err(format!(
                        "GIfTI triangle array has {cols} components, expected 3"
                    )));
                }
                tris.reserve_exact(a.values.len() / 3);
                for v in a.values.chunks_exact(3) {
                    tris.push([v[0] as u32, v[1] as u32, v[2] as u32]);
                }
            }
            _ => {
                let ncomp = a.head.cols();
                let data: Vec<f32> = a.values.iter().map(|x| *x as f32).collect();
                let stats = field_stats(&data, ncomp);
                node_fields.push(Field {
                    name: a
                        .head
                        .name
                        .clone()
                        .unwrap_or_else(|| short_intent(&a.head.intent)),
                    ncomp,
                    data,
                    units: None,
                    partial: false,
                    stats,
                });
            }
        }
    }

    for t in &tris {
        for i in t {
            if *i as usize >= nodes.len() {
                return Err(parse_err(format!(
                    "GIfTI triangle references vertex {i} of {}",
                    nodes.len()
                )));
            }
        }
    }

    let tri_tags = vec![0i32; tris.len()];
    // §6.2: a `.label.gii`'s `<LabelTable>` becomes a `LabelTable`. `parse` always builds one; an
    // empty table means the file had none.
    let label_table = (!doc.labels.entries.is_empty()).then_some(doc.labels);
    Ok(Mesh {
        bounds: bounds_of(&nodes),
        nodes,
        tris,
        tri_tags,
        tets: Vec::new(),
        tet_tags: Vec::new(),
        // §6.2: GIfTI ships triangles, so there is no invented diagonal to mask.
        tri_edge_mask: None,
        node_fields,
        elm_fields: Vec::new(),
        physical_names: Vec::new(),
        gmsh_node_numbers: None,
        gmsh_elm_numbers: None,
        tet_perm: Vec::new(),
        skipped: Vec::new(),
        label_table,
    })
}

fn short_intent(intent: &str) -> String {
    intent
        .strip_prefix("NIFTI_INTENT_")
        .unwrap_or(intent)
        .to_ascii_lowercase()
}

pub fn bounds_of(nodes: &[[f32; 3]]) -> Aabb {
    if nodes.is_empty() {
        return Aabb {
            min: [0.0; 3],
            max: [0.0; 3],
        };
    }
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for n in nodes {
        for k in 0..3 {
            if n[k] < min[k] {
                min[k] = n[k];
            }
            if n[k] > max[k] {
                max[k] = n[k];
            }
        }
    }
    Aabb { min, max }
}

/// Cheap sniff: a GIfTI is XML whose root element is `<GIFTI`.
pub fn looks_like(bytes: &[u8]) -> bool {
    crate::util::find(&bytes[..bytes.len().min(2048)], b"<GIFTI").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_major_is_transposed_into_row_major() {
        let h = ArrayHeader {
            order: "ColumnMajorOrder".into(),
            dims: vec![2, 3],
            ..Default::default()
        };
        // Column-major (2 rows, 3 cols) source: all of column 0, then column 1, then column 2.
        let v = vec![0.0, 3.0, 1.0, 4.0, 2.0, 5.0];
        assert_eq!(reorder(&h, v), vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn a_gifti_label_colour_is_a_zero_to_one_float() {
        assert_eq!(unit_to_u8("1.0"), 255);
        assert_eq!(unit_to_u8("0.5019607843137255"), 128);
        assert_eq!(unit_to_u8("0.0"), 0);
    }

    #[test]
    fn an_unknown_encoding_is_named_in_the_error() {
        let h = ArrayHeader {
            encoding: "ExternalFileBinary".into(),
            ..Default::default()
        };
        let e = decode(&h, "").unwrap_err();
        assert!(format!("{e}").contains("ExternalFileBinary"), "{e}");
    }
}
