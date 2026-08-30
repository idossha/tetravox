//! VTK XML `.vtu` (UnstructuredGrid) and `.vtp` (PolyData) (§6.2).
//!
//! `format="ascii"`, `format="binary"` (base64 inline) and `format="appended"` (raw or base64
//! after the `_` of `<AppendedData>`), with `compressor="vtkZLibDataCompressor"`. The binary
//! header is one `header_type` word (default `UInt32`) holding the byte count when uncompressed;
//! compressed data carries `[nblocks, blocksize, last_size, size_0 … size_{nblocks−1}]` followed
//! by that many zlib streams. Inline base64 encodes the compressed header and the block data as
//! **two** separate base64 runs (padding in the middle), so the header is decoded first and the
//! data run starts at the next 4-character boundary. Little-endian by default; `byte_order`
//! honoured. Multiple `<Piece>`s are concatenated with index offsets.

use std::io::Read;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use flate2::read::ZlibDecoder;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader as XmlReader;
use tvx_core::{Phase, ProgressSink, Result};

use crate::cells::{
    narrow, to_indices, to_points, Assembly, NamedArray, Num, VTK_POLY_LINE, VTK_POLY_VERTEX,
    VTK_TRIANGLE_STRIP,
};
use crate::util::{find, parse_err, unsupported};
use crate::Mesh;

pub fn looks_like(bytes: &[u8]) -> bool {
    find(&bytes[..bytes.len().min(2048)], b"<VTKFile").is_some()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fmt {
    Ascii,
    Binary,
    Appended,
}

#[derive(Debug)]
struct Array {
    name: String,
    ty: Num,
    ncomp: usize,
    fmt: Fmt,
    offset: usize,
    text: String,
}

#[derive(Default, Debug)]
struct Piece {
    n_points: usize,
    n_cells: usize,
    points: Option<Array>,
    /// `(container, arrays)` — `Cells`, `Verts`, `Lines`, `Polys`, `Strips`.
    conn: Vec<(String, Vec<Array>)>,
    point_data: Vec<Array>,
    cell_data: Vec<Array>,
}

#[derive(Default)]
struct Doc {
    polydata: bool,
    big: bool,
    header: Option<Num>,
    compressed: bool,
    pieces: Vec<Piece>,
    /// Element stack, innermost last.
    stack: Vec<String>,
    /// The `<DataArray>` being read.
    cur: Option<Array>,
}

fn attr(e: &BytesStart, key: &str) -> Result<Option<String>> {
    for a in e.attributes() {
        let a = a.map_err(|e| parse_err(format!("VTK XML attribute: {e}")))?;
        if a.key.as_ref() == key {
            return Ok(Some(
                a.normalized_value(quick_xml::XmlVersion::default())
                    .map_err(|e| parse_err(format!("VTK XML attribute: {e}")))?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}

fn attr_usize(e: &BytesStart, key: &str) -> Result<usize> {
    attr(e, key)?
        .map(|s| s.trim().parse::<usize>())
        .transpose()
        .map_err(|e| parse_err(format!("VTK XML {key}: {e}")))
        .map(|v| v.unwrap_or(0))
}

fn on_open(d: &mut Doc, e: &BytesStart) -> Result<()> {
    let name = e.name().0.to_string();
    match name.as_str() {
        "VTKFile" => {
            match attr(e, "type")?.as_deref() {
                Some("UnstructuredGrid") => d.polydata = false,
                Some("PolyData") => d.polydata = true,
                other => {
                    return Err(unsupported(format!(
                        "VTKFile type {}; only UnstructuredGrid and PolyData are read",
                        other.unwrap_or("?")
                    )))
                }
            }
            d.big = attr(e, "byte_order")?.as_deref() == Some("BigEndian");
            d.header = Some(match attr(e, "header_type")?.as_deref() {
                None | Some("UInt32") => Num::U32,
                Some("UInt64") => Num::U64,
                Some(other) => return Err(unsupported(format!("VTK header_type {other:?}"))),
            });
            d.compressed = match attr(e, "compressor")?.as_deref() {
                None | Some("") => false,
                Some("vtkZLibDataCompressor") => true,
                Some(other) => return Err(unsupported(format!("VTK compressor {other:?}"))),
            };
        }
        "Piece" => {
            let n_cells = if d.polydata {
                attr_usize(e, "NumberOfVerts")?
                    + attr_usize(e, "NumberOfLines")?
                    + attr_usize(e, "NumberOfPolys")?
                    + attr_usize(e, "NumberOfStrips")?
            } else {
                attr_usize(e, "NumberOfCells")?
            };
            d.pieces.push(Piece {
                n_points: attr_usize(e, "NumberOfPoints")?,
                n_cells,
                ..Default::default()
            });
        }
        "DataArray" => {
            let ty_s = attr(e, "type")?.unwrap_or_default();
            let ty = Num::parse(&ty_s)
                .ok_or_else(|| unsupported(format!("VTK DataArray type {ty_s:?}")))?;
            let fmt = match attr(e, "format")?.as_deref() {
                None | Some("ascii") => Fmt::Ascii,
                Some("binary") => Fmt::Binary,
                Some("appended") => Fmt::Appended,
                Some(other) => return Err(unsupported(format!("VTK DataArray format {other:?}"))),
            };
            d.cur = Some(Array {
                name: attr(e, "Name")?.unwrap_or_default(),
                ty,
                ncomp: attr_usize(e, "NumberOfComponents")?.max(1),
                fmt,
                offset: attr_usize(e, "offset")?,
                text: String::new(),
            });
        }
        _ => {}
    }
    d.stack.push(name);
    Ok(())
}

fn on_close(d: &mut Doc, name: &str) -> Result<()> {
    d.stack.pop();
    if name == "DataArray" {
        let a = d
            .cur
            .take()
            .ok_or_else(|| parse_err("VTK XML: </DataArray> without <DataArray>"))?;
        let container = d.stack.last().cloned().unwrap_or_default();
        let piece = d
            .pieces
            .last_mut()
            .ok_or_else(|| parse_err("VTK XML: DataArray outside a Piece"))?;
        match container.as_str() {
            "Points" => piece.points = Some(a),
            "Cells" | "Verts" | "Lines" | "Polys" | "Strips" => {
                match piece.conn.iter_mut().find(|(c, _)| *c == container) {
                    Some((_, v)) => v.push(a),
                    None => piece.conn.push((container, vec![a])),
                }
            }
            "PointData" => piece.point_data.push(a),
            "CellData" => piece.cell_data.push(a),
            // `FieldData`, `Coordinates`, … — not ours.
            _ => {}
        }
    }
    Ok(())
}

/// Split the appended payload off the XML: everything after the `_` that follows
/// `<AppendedData …>` is raw or base64 bytes, not XML.
/// `(is_base64, payload after the `_`)`.
type Appended<'a> = Option<(bool, &'a [u8])>;

fn split_appended(bytes: &[u8]) -> Result<(&[u8], Appended<'_>)> {
    let Some(at) = find(bytes, b"<AppendedData") else {
        return Ok((bytes, None));
    };
    let tag_end = at
        + find(&bytes[at..], b">")
            .ok_or_else(|| parse_err("VTK XML: unterminated <AppendedData"))?;
    let tag = String::from_utf8_lossy(&bytes[at..tag_end]);
    let b64 = tag.contains("encoding=\"base64\"");
    let us = tag_end
        + find(&bytes[tag_end..], b"_")
            .ok_or_else(|| parse_err("VTK XML: <AppendedData> without its `_`"))?;
    Ok((&bytes[..at], Some((b64, &bytes[us + 1..]))))
}

/// Base64 characters needed for `n` bytes.
fn chars_for(n: usize) -> usize {
    n.div_ceil(3) * 4
}

fn b64_decode(text: &[u8]) -> Result<Vec<u8>> {
    B64.decode(text)
        .map_err(|e| parse_err(format!("VTK XML base64: {e}")))
}

fn inflate_blocks(header: &[u64], data: &[u8]) -> Result<Vec<u8>> {
    let nblocks = header[0] as usize;
    let mut out = Vec::new();
    let mut at = 0usize;
    for size in &header[3..3 + nblocks] {
        let size = *size as usize;
        let block = data
            .get(at..at + size)
            .ok_or_else(|| parse_err("VTK XML: compressed block extends past the data"))?;
        ZlibDecoder::new(block)
            .read_to_end(&mut out)
            .map_err(|e| parse_err(format!("VTK XML zlib inflate: {e}")))?;
        at += size;
    }
    Ok(out)
}

/// The data bytes of one binary array. `raw = true` for appended raw, else `src` is base64.
fn binary_payload(src: &[u8], raw: bool, hdr: Num, big: bool, compressed: bool) -> Result<Vec<u8>> {
    let w = hdr.size();
    let word = |b: &[u8], i: usize| -> Result<u64> {
        let s = b
            .get(i * w..(i + 1) * w)
            .ok_or_else(|| parse_err("VTK XML: truncated binary header"))?;
        Ok(hdr.decode(s, big) as u64)
    };
    if raw {
        if !compressed {
            let n = word(src, 0)? as usize;
            return src
                .get(w..w + n)
                .map(<[u8]>::to_vec)
                .ok_or_else(|| parse_err("VTK XML: truncated appended array"));
        }
        let nblocks = word(src, 0)? as usize;
        let header: Vec<u64> = (0..3 + nblocks)
            .map(|i| word(src, i))
            .collect::<Result<_>>()?;
        return inflate_blocks(&header, &src[w * (3 + nblocks)..]);
    }
    if !compressed {
        let first = b64_decode(&src[..chars_for(w).min(src.len())])?;
        let n = word(&first, 0)? as usize;
        let all = b64_decode(&src[..chars_for(w + n).min(src.len())])?;
        return all
            .get(w..w + n)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| parse_err("VTK XML: truncated base64 array"));
    }
    let first = b64_decode(&src[..chars_for(w).min(src.len())])?;
    let nblocks = word(&first, 0)? as usize;
    let hchars = chars_for(w * (3 + nblocks));
    let hbytes = b64_decode(
        src.get(..hchars)
            .ok_or_else(|| parse_err("VTK XML: truncated base64 header"))?,
    )?;
    let header: Vec<u64> = (0..3 + nblocks)
        .map(|i| word(&hbytes, i))
        .collect::<Result<_>>()?;
    let total: usize = header[3..].iter().map(|s| *s as usize).sum();
    let dchars = chars_for(total);
    let data = b64_decode(
        src.get(hchars..hchars + dchars)
            .ok_or_else(|| parse_err("VTK XML: truncated base64 data"))?,
    )?;
    inflate_blocks(&header, &data)
}

impl Array {
    fn decode(&self, d: &Doc, appended: Appended<'_>) -> Result<Vec<f64>> {
        let hdr = d.header.unwrap_or(Num::U32);
        match self.fmt {
            Fmt::Ascii => self
                .text
                .split_ascii_whitespace()
                .map(|t| {
                    t.parse::<f64>()
                        .map_err(|e| parse_err(format!("VTK XML value {t:?}: {e}")))
                })
                .collect(),
            Fmt::Binary => {
                let packed: Vec<u8> = self
                    .text
                    .bytes()
                    .filter(|c| !c.is_ascii_whitespace())
                    .collect();
                let raw = binary_payload(&packed, false, hdr, d.big, d.compressed)?;
                self.ty.decode_all(&raw, raw.len() / self.ty.size(), d.big)
            }
            Fmt::Appended => {
                let (b64, payload) = appended
                    .ok_or_else(|| parse_err("VTK XML: appended array without <AppendedData>"))?;
                let src = payload.get(self.offset..).ok_or_else(|| {
                    parse_err(format!(
                        "VTK XML: appended offset {} past the data",
                        self.offset
                    ))
                })?;
                let raw = if b64 {
                    let end = src.iter().position(|c| *c == b'<').unwrap_or(src.len());
                    let packed: Vec<u8> = src[..end]
                        .iter()
                        .copied()
                        .filter(|c| !c.is_ascii_whitespace())
                        .collect();
                    binary_payload(&packed, false, hdr, d.big, d.compressed)?
                } else {
                    binary_payload(src, true, hdr, d.big, d.compressed)?
                };
                self.ty.decode_all(&raw, raw.len() / self.ty.size(), d.big)
            }
        }
    }
}

/// Fields accumulated across pieces; a piece that lacks an array pads it with NaN (`partial`).
#[derive(Default)]
struct Merged {
    arrays: Vec<(String, usize, Vec<f32>, bool)>,
}

impl Merged {
    fn add_piece(
        &mut self,
        rows_before: usize,
        rows: usize,
        arrays: Vec<NamedArray>,
    ) -> Result<()> {
        let mut seen = vec![false; self.arrays.len()];
        for (name, ncomp, values) in arrays {
            if values.len() != rows * ncomp {
                return Err(parse_err(format!(
                    "VTK XML array {name:?} holds {} values for {rows} × {ncomp}",
                    values.len()
                )));
            }
            match self
                .arrays
                .iter()
                .position(|(n, c, _, _)| *n == name && *c == ncomp)
            {
                Some(i) => {
                    seen[i] = true;
                    self.arrays[i].2.extend_from_slice(&values);
                }
                None => {
                    let mut data = vec![f32::NAN; rows_before * ncomp];
                    let partial = rows_before > 0;
                    data.extend_from_slice(&values);
                    self.arrays.push((name, ncomp, data, partial));
                    seen.push(true);
                }
            }
        }
        for (i, s) in seen.iter().enumerate() {
            if !s {
                let a = &mut self.arrays[i];
                a.2.resize((rows_before + rows) * a.1, f32::NAN);
                a.3 = true;
            }
        }
        Ok(())
    }
}

fn cell_arrays<'a>(piece: &'a Piece, container: &str) -> Option<&'a [Array]> {
    piece
        .conn
        .iter()
        .find(|(c, _)| c == container)
        .map(|(_, v)| v.as_slice())
}

fn named<'a>(arrays: &'a [Array], name: &str) -> Result<&'a Array> {
    arrays
        .iter()
        .find(|a| a.name == name)
        .ok_or_else(|| parse_err(format!("VTK XML: no {name:?} array")))
}

/// `(connectivity, offsets)` → per-cell index lists, shifted by `base`.
fn cells_of(
    arrays: &[Array],
    d: &Doc,
    app: Appended<'_>,
    base: u32,
    n_points: usize,
) -> Result<Vec<Vec<u32>>> {
    let conn = to_indices(&named(arrays, "connectivity")?.decode(d, app)?)?;
    let offsets = to_indices(&named(arrays, "offsets")?.decode(d, app)?)?;
    let mut out = Vec::with_capacity(offsets.len());
    let mut at = 0usize;
    for o in offsets {
        let o = o as usize;
        if o < at || o > conn.len() {
            return Err(parse_err(format!(
                "VTK XML offsets {at}..{o} exceed connectivity"
            )));
        }
        let mut c = Vec::with_capacity(o - at);
        for i in &conn[at..o] {
            if *i as usize >= n_points {
                return Err(parse_err(format!(
                    "VTK XML cell references point {i} of {n_points}"
                )));
            }
            c.push(*i + base);
        }
        out.push(c);
        at = o;
    }
    Ok(out)
}

pub fn read(bytes: &[u8], p: &mut dyn ProgressSink) -> Result<Mesh> {
    let total = bytes.len() as u64;
    p.report(Phase::Parse, 0, total);
    let (xml_bytes, appended) = split_appended(bytes)?;

    let mut xml = XmlReader::from_reader(xml_bytes);
    xml.config_mut().trim_text(false);
    let mut d = Doc::default();
    let mut buf = Vec::new();
    loop {
        let ev = xml
            .read_event_into(&mut buf)
            .map_err(|e| parse_err(format!("VTK XML: {e}")))?;
        match ev {
            Event::Eof => break,
            Event::Start(e) => on_open(&mut d, &e)?,
            Event::Empty(e) => {
                on_open(&mut d, &e)?;
                let n = e.name().0.to_string();
                on_close(&mut d, &n)?;
            }
            Event::Text(t) => {
                if let Some(a) = d.cur.as_mut() {
                    a.text.push_str(&t);
                }
            }
            Event::End(e) => on_close(&mut d, e.name().0)?,
            _ => {}
        }
        buf.clear();
    }
    if d.header.is_none() {
        return Err(parse_err("not a VTK XML file (no <VTKFile>)"));
    }

    let mut a = Assembly::default();
    let mut points = Merged::default();
    let mut cells = Merged::default();
    for (pi, piece) in d.pieces.iter().enumerate() {
        p.report(Phase::Parse, pi as u64, d.pieces.len() as u64);
        let base = a.nodes.len() as u32;
        let rows_before_cells = a.refs.len();
        let pts = match &piece.points {
            Some(arr) => to_points(&arr.decode(&d, appended)?)?,
            None if piece.n_points == 0 => Vec::new(),
            None => return Err(parse_err("VTK XML: Piece without <Points>")),
        };
        if pts.len() != piece.n_points {
            return Err(parse_err(format!(
                "VTK XML: Piece declares {} points, <Points> holds {}",
                piece.n_points,
                pts.len()
            )));
        }
        let np = pts.len();
        a.nodes.extend(pts);

        if d.polydata {
            // vtkPolyData cell order: Verts, Lines, Polys, Strips.
            for (container, code) in [
                ("Verts", Some(VTK_POLY_VERTEX)),
                ("Lines", Some(VTK_POLY_LINE)),
                ("Polys", None),
                ("Strips", Some(VTK_TRIANGLE_STRIP)),
            ] {
                let Some(arrays) = cell_arrays(piece, container) else {
                    continue;
                };
                for c in cells_of(arrays, &d, appended, base, np)? {
                    match code {
                        Some(code) => a.drop(code),
                        None => a.add_polygon(&c),
                    }
                }
            }
        } else if let Some(arrays) = cell_arrays(piece, "Cells") {
            let conn = cells_of(arrays, &d, appended, base, np)?;
            let types = to_indices(&named(arrays, "types")?.decode(&d, appended)?)?;
            if types.len() != conn.len() {
                return Err(parse_err(format!(
                    "VTK XML: {} cells but {} types",
                    conn.len(),
                    types.len()
                )));
            }
            for (c, t) in conn.iter().zip(types) {
                a.add_vtk_cell(t, c);
            }
        }
        let n_cells = a.refs.len() - rows_before_cells;
        if n_cells != piece.n_cells {
            return Err(parse_err(format!(
                "VTK XML: Piece declares {} cells, holds {n_cells}",
                piece.n_cells
            )));
        }

        let decode_all = |arrays: &[Array]| -> Result<Vec<NamedArray>> {
            arrays
                .iter()
                .map(|arr| {
                    Ok((
                        arr.name.clone(),
                        arr.ncomp,
                        narrow(&arr.decode(&d, appended)?),
                    ))
                })
                .collect()
        };
        points.add_piece(base as usize, np, decode_all(&piece.point_data)?)?;
        cells.add_piece(rows_before_cells, n_cells, decode_all(&piece.cell_data)?)?;
    }
    for (name, ncomp, data, partial) in points.arrays {
        a.push_point_field(&name, ncomp, data);
        if partial {
            a.node_fields.last_mut().unwrap().partial = true;
        }
    }
    for (name, ncomp, data, partial) in cells.arrays {
        a.push_cell_field(&name, ncomp, &data);
        if partial {
            a.elm_fields.last_mut().unwrap().partial = true;
        }
    }
    p.report(Phase::Parse, total, total);
    a.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tvx_core::{Error, NoProgress};

    const ASCII_VTU: &str = r#"<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">
<UnstructuredGrid><Piece NumberOfPoints="5" NumberOfCells="3">
<Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0 0 0 1 1 1 1</DataArray></Points>
<Cells>
<DataArray type="Int64" Name="connectivity" format="ascii">0 1 2 3 0 1 2 0 1 2 4</DataArray>
<DataArray type="Int64" Name="offsets" format="ascii">4 7 11</DataArray>
<DataArray type="UInt8" Name="types" format="ascii">10 5 10</DataArray>
</Cells>
<PointData><DataArray type="Float64" Name="s" format="ascii">1 2 3 4 5</DataArray></PointData>
<CellData><DataArray type="Int32" Name="gmsh:physical" format="ascii">2 1002 3</DataArray></CellData>
</Piece></UnstructuredGrid></VTKFile>
"#;

    #[test]
    fn ascii_vtu() {
        let m = read(ASCII_VTU.as_bytes(), &mut NoProgress).unwrap();
        assert_eq!(m.nodes.len(), 5);
        assert_eq!(m.tets, vec![[0, 1, 2, 3], [0, 1, 2, 4]]);
        assert_eq!(m.tris, vec![[0, 1, 2]]);
        assert_eq!(m.tet_tags, vec![2, 3]);
        assert_eq!(m.tri_tags, vec![1002]);
        assert_eq!(m.node_fields[0].data, vec![1.0, 2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn an_unknown_cell_type_is_skipped_and_a_bad_index_refused() {
        let src = ASCII_VTU.replace(">10 5 10<", ">10 12 10<");
        let m = read(src.as_bytes(), &mut NoProgress).unwrap();
        assert_eq!(m.skipped, vec![(12, 1)]);
        let src = ASCII_VTU.replace(">0 1 2 3 0 1 2 0 1 2 4<", ">0 1 2 3 0 1 2 0 1 2 9<");
        assert!(matches!(
            read(src.as_bytes(), &mut NoProgress),
            Err(Error::Parse(_))
        ));
    }

    fn b64(b: &[u8]) -> String {
        B64.encode(b)
    }

    #[test]
    fn inline_base64_uncompressed_and_compressed_headers() {
        // Uncompressed: one base64 run of [nbytes][data].
        let data: Vec<u8> = [1.0f32, 2.0, 3.0]
            .iter()
            .flat_map(|x| x.to_le_bytes())
            .collect();
        let mut raw = (data.len() as u32).to_le_bytes().to_vec();
        raw.extend_from_slice(&data);
        let got = binary_payload(b64(&raw).as_bytes(), false, Num::U32, false, false).unwrap();
        assert_eq!(got, data);

        // Compressed: header run and data run encoded separately, 2 blocks.
        use flate2::write::ZlibEncoder;
        use std::io::Write;
        let block = |b: &[u8]| {
            let mut e = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(b).unwrap();
            e.finish().unwrap()
        };
        let (c0, c1) = (block(&data[..8]), block(&data[8..]));
        let mut hdr = Vec::new();
        for w in [2u32, 8, 4, c0.len() as u32, c1.len() as u32] {
            hdr.extend_from_slice(&w.to_le_bytes());
        }
        let mut cat = c0.clone();
        cat.extend_from_slice(&c1);
        let text = format!("{}{}", b64(&hdr), b64(&cat));
        let got = binary_payload(text.as_bytes(), false, Num::U32, false, true).unwrap();
        assert_eq!(got, data);
        // Raw appended, same header layout.
        let mut rawc = hdr.clone();
        rawc.extend_from_slice(&cat);
        assert_eq!(
            binary_payload(&rawc, true, Num::U32, false, true).unwrap(),
            data
        );
        // Truncated raw appended data.
        assert!(binary_payload(&rawc[..rawc.len() - 3], true, Num::U32, false, true).is_err());
    }

    #[test]
    fn two_pieces_concatenate_with_offsets() {
        let src = r#"<VTKFile type="PolyData" byte_order="LittleEndian"><PolyData>
<Piece NumberOfPoints="3" NumberOfPolys="1"><Points><DataArray type="Float32" NumberOfComponents="3">0 0 0 1 0 0 0 1 0</DataArray></Points>
<Polys><DataArray type="Int32" Name="connectivity">0 1 2</DataArray><DataArray type="Int32" Name="offsets">3</DataArray></Polys>
<PointData><DataArray type="Float32" Name="s">1 2 3</DataArray></PointData></Piece>
<Piece NumberOfPoints="4" NumberOfPolys="1"><Points><DataArray type="Float32" NumberOfComponents="3">0 0 1 1 0 1 1 1 1 0 1 1</DataArray></Points>
<Polys><DataArray type="Int32" Name="connectivity">0 1 2 3</DataArray><DataArray type="Int32" Name="offsets">4</DataArray></Polys>
</Piece></PolyData></VTKFile>"#;
        let m = read(src.as_bytes(), &mut NoProgress).unwrap();
        assert_eq!(m.nodes.len(), 7);
        assert_eq!(m.tris, vec![[0, 1, 2], [3, 4, 5], [3, 5, 6]]);
        assert_eq!(m.tri_edge_mask.as_deref(), Some(&[0b111, 0b101, 0b011][..]));
        let s = &m.node_fields[0];
        assert!(s.partial);
        assert_eq!(s.data.len(), 7);
        assert!(s.data[3].is_nan());
    }
}
