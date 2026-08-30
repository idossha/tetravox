//! `read_nrrd` — NRRD with an attached header (ARCHITECTURE.md §6.1).
//!
//! `NRRD000x`, then `key: value` field lines and `key:=value` key/value pairs, `#` comments, a blank
//! line, and the samples. Field names are case-insensitive. Detached headers (`.nhdr`, a `data file`
//! field) are `Error::Unsupported`: the byte-slice signature has no sibling-file access. Encodings:
//! `raw`, `gzip`/`gz`, `ascii`/`txt`/`text`; `bzip2` is `Unsupported` by name.
//!
//! **Orientation.** `space directions` are per-axis column vectors and `space origin` the
//! translation, in the `space` the header names. `left-posterior-superior` (ITK/Slicer's default)
//! and every other `<x>-<y>-<z>` anatomical space is converted to RAS by negating the world rows
//! whose anatomical direction is L, P or I. A header with **no** `space` is read the way ITK reads
//! it: as LPS. Non-anatomical spaces (`scanner-xyz`, `3d-right-handed`, …) are taken as-is.
//!
//! **Axes.** Three spatial axes (`kinds` `domain`/`space`, or the axes whose `space directions` are
//! not `none`) plus at most one non-spatial one. A non-spatial **last** axis is `nvols`; a
//! non-spatial **first** axis of `3-color`/`RGB-color` (size 3) or `4-color`/`RGBA-color` (size 4)
//! over `uint8` is RGB24/RGBA32; any other channel-first layout is `Unsupported`.

use std::collections::BTreeMap;

use tvx_core::{Error, ProgressSink, Result};

use crate::common::{
    data_slice, decode_ascii, decode_samples, finish, identity, inflate_gzip, jmat, jnums,
    take_inflated, voxel_count, Meta,
};
use crate::{DataType, SpaceUnit, TimeUnit, Units, Volume};

/// The parsed header: fields (lower-cased keys) and `key:=value` pairs (as written).
struct Header {
    fields: BTreeMap<String, String>,
    pairs: BTreeMap<String, String>,
    /// Byte offset of the first sample byte (the byte after the blank line).
    data_start: usize,
    version: u32,
}

fn parse_header(raw: &[u8]) -> Result<Header> {
    if !raw.starts_with(b"NRRD000") || raw.len() < 8 {
        return Err(Error::Parse("not a NRRD file (no NRRD000x magic)".into()));
    }
    let version = (raw[7] as char)
        .to_digit(10)
        .ok_or_else(|| Error::Parse(format!("NRRD magic version byte {:?}", raw[7] as char)))?;
    let mut fields = BTreeMap::new();
    let mut pairs = BTreeMap::new();
    let mut pos = 0usize;
    let mut first = true;
    loop {
        let rest = &raw[pos..];
        let Some(nl) = rest.iter().position(|&b| b == b'\n') else {
            return Err(Error::Parse(
                "NRRD header has no terminating blank line (detached .nhdr or truncated file?)"
                    .into(),
            ));
        };
        let line = String::from_utf8_lossy(&rest[..nl]);
        let line = line.trim_end_matches('\r');
        pos += nl + 1;
        if first {
            first = false;
            continue; // the magic line
        }
        if line.is_empty() {
            break;
        }
        if line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once(":=") {
            pairs.insert(k.trim().to_string(), v.trim().to_string());
        } else if let Some((k, v)) = line.split_once(':') {
            fields.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        } else {
            return Err(Error::Parse(format!(
                "NRRD header line {line:?} is not `key: value`"
            )));
        }
    }
    Ok(Header {
        fields,
        pairs,
        data_start: pos,
        version,
    })
}

/// Every alias the NRRD spec lists for its scalar types, plus the ones it rejects by name.
fn datatype_of(s: &str) -> Result<DataType> {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(match t.to_ascii_lowercase().as_str() {
        "signed char" | "int8" | "int8_t" => DataType::I8,
        "uchar" | "unsigned char" | "uint8" | "uint8_t" => DataType::U8,
        "short" | "short int" | "signed short" | "signed short int" | "int16" | "int16_t" => {
            DataType::I16
        }
        "ushort" | "unsigned short" | "unsigned short int" | "uint16" | "uint16_t" => DataType::U16,
        "int" | "signed int" | "int32" | "int32_t" => DataType::I32,
        "uint" | "unsigned int" | "uint32" | "uint32_t" => DataType::U32,
        "float" => DataType::F32,
        "double" => DataType::F64,
        "longlong"
        | "long long"
        | "long long int"
        | "signed long long"
        | "signed long long int"
        | "int64"
        | "int64_t" => return Err(Error::Unsupported(format!("NRRD type {t} (int64)"))),
        "ulonglong" | "unsigned long long" | "unsigned long long int" | "uint64" | "uint64_t" => {
            return Err(Error::Unsupported(format!("NRRD type {t} (uint64)")))
        }
        "block" => return Err(Error::Unsupported("NRRD type block".into())),
        _ => return Err(Error::Parse(format!("NRRD type {s:?} is not a NRRD type"))),
    })
}

fn ints(field: &str, v: &str) -> Result<Vec<i64>> {
    v.split_whitespace()
        .map(|t| {
            t.parse::<i64>()
                .map_err(|_| Error::Parse(format!("NRRD {field}: {t:?} is not an integer")))
        })
        .collect()
}

fn float(field: &str, t: &str) -> Result<f64> {
    let l = t.to_ascii_lowercase();
    if l == "nan" {
        return Ok(f64::NAN);
    }
    t.parse::<f64>()
        .map_err(|_| Error::Parse(format!("NRRD {field}: {t:?} is not a number")))
}

/// `(a,b,c) none (d,e,f)` → one `Option<Vec<f64>>` per axis.
fn vectors(field: &str, v: &str) -> Result<Vec<Option<Vec<f64>>>> {
    let mut out = Vec::new();
    let mut rest = v.trim();
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix('(') {
            let end = r
                .find(')')
                .ok_or_else(|| Error::Parse(format!("NRRD {field}: unbalanced parenthesis")))?;
            let nums = r[..end]
                .split(',')
                .map(|t| float(field, t.trim()))
                .collect::<Result<Vec<_>>>()?;
            out.push(Some(nums));
            rest = r[end + 1..].trim_start();
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let tok = &rest[..end];
            if tok.eq_ignore_ascii_case("none") {
                out.push(None);
            } else {
                return Err(Error::Parse(format!(
                    "NRRD {field}: unexpected token {tok:?}"
                )));
            }
            rest = rest[end..].trim_start();
        }
    }
    Ok(out)
}

/// A `space` name → per-axis sign relative to RAS (`+1` keep, `-1` flip), or `None` for a space
/// that is not anatomical (taken as-is).
fn space_signs(space: &str) -> Option<[f64; 3]> {
    let s = space.trim().to_ascii_lowercase();
    let s = s.strip_suffix("-time").unwrap_or(&s).to_string();
    let words: Vec<&str> = s.split('-').collect();
    let sign = |w: &str| -> Option<f64> {
        match w {
            "right" | "r" | "anterior" | "a" | "superior" | "s" => Some(1.0),
            "left" | "l" | "posterior" | "p" | "inferior" | "i" => Some(-1.0),
            _ => None,
        }
    };
    if words.len() == 3 {
        return Some([sign(words[0])?, sign(words[1])?, sign(words[2])?]);
    }
    if words.len() == 1 && s.len() == 3 {
        let c: Vec<String> = s.chars().map(|c| c.to_string()).collect();
        return Some([sign(&c[0])?, sign(&c[1])?, sign(&c[2])?]);
    }
    None
}

/// Parse a `.nrrd` byte vector. Takes ownership and frees it before returning (§5 rule 5).
pub fn read_nrrd(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    let raw = take_inflated(bytes, p)?;
    read_nrrd_raw(raw, p)
}

/// The NRRD reader proper.
pub(crate) fn read_nrrd_raw(raw: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    use serde_json::{json, Map, Value};

    let h = parse_header(&raw)?;
    let field = |k: &str| h.fields.get(k).map(|s| s.as_str());
    let required = |k: &str| field(k).ok_or_else(|| Error::Parse(format!("NRRD: no `{k}` field")));

    if let Some(df) = field("data file").or_else(|| field("datafile")) {
        return Err(Error::Unsupported(format!(
            "detached NRRD header (.nhdr): the samples are in the sibling file `data file: {df}`, \
             which this reader cannot open — convert to an attached-header .nrrd"
        )));
    }

    let datatype0 = datatype_of(required("type")?)?;
    let dimension = ints("dimension", required("dimension")?)?;
    let dimension = match dimension.as_slice() {
        [d] if *d == 3 || *d == 4 => *d as usize,
        [d] => {
            return Err(Error::Unsupported(format!(
                "NRRD dimension {d} (only 3 or 4)"
            )))
        }
        _ => return Err(Error::Parse("NRRD dimension must be one integer".into())),
    };
    let sizes = ints("sizes", required("sizes")?)?;
    if sizes.len() != dimension || sizes.iter().any(|&s| s <= 0) {
        return Err(Error::Parse(format!(
            "NRRD sizes {sizes:?} do not match dimension {dimension} or are not positive"
        )));
    }
    let sizes: Vec<usize> = sizes.iter().map(|&s| s as usize).collect();
    let encoding = required("encoding")?.to_ascii_lowercase();

    // Which axes are spatial.
    let kinds: Option<Vec<String>> = field("kinds").map(|k| {
        k.split_whitespace()
            .map(|s| s.to_ascii_lowercase())
            .collect()
    });
    if let Some(k) = &kinds {
        if k.len() != dimension {
            return Err(Error::Parse(format!(
                "NRRD kinds has {} entries for dimension {dimension}",
                k.len()
            )));
        }
    }
    let directions = match field("space directions") {
        Some(v) => Some(vectors("space directions", v)?),
        None => None,
    };
    if let Some(d) = &directions {
        if d.len() != dimension {
            return Err(Error::Parse(format!(
                "NRRD space directions has {} entries for dimension {dimension}",
                d.len()
            )));
        }
    }
    let spatial: Vec<bool> = (0..dimension)
        .map(|a| {
            if let Some(k) = &kinds {
                matches!(k[a].as_str(), "domain" | "space")
            } else if let Some(d) = &directions {
                d[a].is_some()
            } else {
                a < 3
            }
        })
        .collect();
    let n_spatial = spatial.iter().filter(|s| **s).count();
    if n_spatial != 3 {
        return Err(Error::Unsupported(format!(
            "NRRD with {n_spatial} spatial axes (kinds {:?}); a volume needs exactly 3",
            kinds.as_deref().unwrap_or(&[])
        )));
    }
    let non_spatial = spatial.iter().position(|s| !*s);
    let (dims, nvols, datatype, channel_axis) = match non_spatial {
        None => ([sizes[0], sizes[1], sizes[2]], 1, datatype0, None),
        Some(3) => ([sizes[0], sizes[1], sizes[2]], sizes[3], datatype0, Some(3)),
        Some(0) => {
            let kind = kinds.as_ref().map(|k| k[0].clone()).unwrap_or_default();
            let color = matches!(
                (kind.as_str(), sizes[0]),
                ("3-color" | "rgb-color", 3) | ("4-color" | "rgba-color", 4)
            );
            if !(color && datatype0 == DataType::U8) {
                return Err(Error::Unsupported(format!(
                    "channel-first NRRD (axis 0 is kind {kind:?} of size {}, type {}); only \
                     3-color/4-color over uint8 is read, as RGB24/RGBA32",
                    sizes[0],
                    datatype0.name()
                )));
            }
            let dt = if sizes[0] == 3 {
                DataType::Rgb24
            } else {
                DataType::Rgba32
            };
            ([sizes[1], sizes[2], sizes[3]], 1, dt, Some(0))
        }
        Some(a) => {
            return Err(Error::Unsupported(format!(
                "NRRD whose non-spatial axis is axis {a} (neither first nor last)"
            )))
        }
    };
    let spatial_axes: Vec<usize> = (0..dimension).filter(|a| spatial[*a]).collect();

    // Geometry, in the header's own space.
    let mut affine = identity();
    let mut spacing = [1.0f64; 3];
    let affine_source;
    if let Some(d) = &directions {
        for (col, &axis) in spatial_axes.iter().enumerate() {
            let v = d[axis].as_ref().ok_or_else(|| {
                Error::Parse(format!(
                    "NRRD space directions: spatial axis {axis} is `none`"
                ))
            })?;
            if v.len() != 3 {
                return Err(Error::Unsupported(format!(
                    "NRRD space directions with {} components (space dimension must be 3)",
                    v.len()
                )));
            }
            for r in 0..3 {
                affine[r][col] = v[r];
            }
            spacing[col] = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        }
        affine_source = "space directions";
    } else if let Some(s) = field("spacings") {
        let sp: Vec<f64> = s
            .split_whitespace()
            .map(|t| float("spacings", t))
            .collect::<Result<_>>()?;
        if sp.len() != dimension {
            return Err(Error::Parse(format!(
                "NRRD spacings has {} entries for dimension {dimension}",
                sp.len()
            )));
        }
        for (col, &axis) in spatial_axes.iter().enumerate() {
            let v = if sp[axis].is_finite() { sp[axis] } else { 1.0 };
            affine[col][col] = v;
            spacing[col] = v.abs();
        }
        affine_source = "spacings";
    } else {
        affine_source = "none (unit spacing)";
    }
    if let Some(o) = field("space origin") {
        let v = vectors("space origin", o)?;
        match v.as_slice() {
            [Some(t)] if t.len() == 3 => {
                for r in 0..3 {
                    affine[r][3] = t[r];
                }
            }
            _ => {
                return Err(Error::Parse(format!(
                    "NRRD space origin {o:?} is not one 3-vector"
                )))
            }
        }
    }
    // ... and into RAS.
    let space = field("space").map(|s| s.to_string());
    let (signs, space_note) = match &space {
        None => ([-1.0, -1.0, 1.0], "absent: read as LPS, like ITK"),
        Some(s) => match space_signs(s) {
            Some(sg) => (sg, "anatomical: flipped to RAS"),
            None => ([1.0, 1.0, 1.0], "not anatomical: taken as-is"),
        },
    };
    for (row, sign) in affine.iter_mut().zip(signs) {
        for v in row.iter_mut() {
            *v *= sign;
        }
    }

    // Units.
    let units = field("space units").map(|u| {
        u.split_whitespace()
            .map(|t| t.trim_matches('"').to_ascii_lowercase())
            .collect::<Vec<_>>()
    });
    let space_unit = match units.as_ref().and_then(|u| u.first()).map(|s| s.as_str()) {
        None => SpaceUnit::Millimeter,
        Some("mm" | "millimeter" | "millimeters") => SpaceUnit::Millimeter,
        Some("m" | "meter" | "meters") => SpaceUnit::Meter,
        Some("um" | "µm" | "micron" | "microns" | "micrometer" | "micrometers") => {
            SpaceUnit::Micron
        }
        Some(_) => SpaceUnit::Unknown,
    };

    // Samples.
    let n_vox = voxel_count(dims, nvols)?;
    let le = match field("endian").map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("little") | None => true,
        Some("big") => false,
        Some(e) => return Err(Error::Parse(format!("NRRD endian {e:?}"))),
    };
    let mut start = h.data_start;
    let byte_skip = match field("byte skip").or_else(|| field("byteskip")) {
        Some(v) => ints("byte skip", v)?.first().copied().unwrap_or(0),
        None => 0,
    };
    let line_skip = match field("line skip").or_else(|| field("lineskip")) {
        Some(v) => ints("line skip", v)?.first().copied().unwrap_or(0),
        None => 0,
    };
    for _ in 0..line_skip.max(0) {
        let rest = &raw[start.min(raw.len())..];
        match rest.iter().position(|&b| b == b'\n') {
            Some(nl) => start += nl + 1,
            None => start = raw.len(),
        }
    }
    let data = match encoding.as_str() {
        "raw" => {
            if byte_skip == -1 {
                let need = n_vox * datatype.size();
                start = raw.len().checked_sub(need).ok_or_else(|| {
                    Error::Parse(format!(
                        "truncated: byte skip -1 needs {need} B of {}",
                        raw.len()
                    ))
                })?;
            } else {
                start += byte_skip.max(0) as usize;
            }
            let src = data_slice(&raw, start.min(raw.len()), n_vox, datatype)?;
            decode_samples(src, n_vox, datatype, le, p)?
        }
        "gzip" | "gz" => {
            if byte_skip == -1 {
                return Err(Error::Unsupported(
                    "NRRD byte skip -1 with gzip encoding".into(),
                ));
            }
            start += byte_skip.max(0) as usize;
            let inflated = inflate_gzip(&raw[start.min(raw.len())..], p)?;
            let src = data_slice(&inflated, 0, n_vox, datatype)?;
            decode_samples(src, n_vox, datatype, le, p)?
        }
        "ascii" | "txt" | "text" => decode_ascii(&raw[start.min(raw.len())..], n_vox, datatype, p)?,
        "bzip2" | "bz2" => return Err(Error::Unsupported("NRRD encoding bzip2".into())),
        "hex" => return Err(Error::Unsupported("NRRD encoding hex".into())),
        other => return Err(Error::Unsupported(format!("NRRD encoding {other:?}"))),
    };
    drop(raw);

    let mut hdr = Map::new();
    hdr.insert("nrrdVersion".into(), json!(h.version));
    for (k, v) in &h.fields {
        hdr.insert(k.clone(), json!(v));
    }
    if !h.pairs.is_empty() {
        let mut kv = Map::new();
        for (k, v) in &h.pairs {
            kv.insert(k.clone(), json!(v));
        }
        hdr.insert("keyValuePairs".into(), Value::Object(kv));
    }
    hdr.insert("dataOffset".into(), json!(h.data_start));
    hdr.insert("dtype".into(), json!(datatype.name()));
    hdr.insert("spatialAxes".into(), json!(spatial_axes));
    hdr.insert("channelAxis".into(), json!(channel_axis));
    hdr.insert("spaceHandling".into(), json!(space_note));
    hdr.insert("affineSource".into(), json!(affine_source));
    hdr.insert("affine".into(), jmat(&affine));
    hdr.insert("spacing".into(), jnums(&spacing));

    let descrip = field("content").unwrap_or("NRRD").to_string();
    let mut meta = Meta::new(dims, nvols, &descrip);
    meta.affine = affine;
    meta.spacing = spacing;
    meta.xyz_units = Units {
        space: space_unit,
        time: TimeUnit::Unknown,
    };
    meta.header_json = Value::Object(hdr).to_string();
    finish(meta, datatype, data, p)
}
