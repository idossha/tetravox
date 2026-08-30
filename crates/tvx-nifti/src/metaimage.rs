//! `read_metaimage` — MetaImage with an attached header, `.mha` (ARCHITECTURE.md §6.1).
//!
//! `Key = Value` lines up to `ElementDataFile = LOCAL`; the samples follow that line (or start at
//! `HeaderSize` when it is given, or are the last N bytes when it is `-1`). Keys are matched
//! case-insensitively. `.mhd` (any other `ElementDataFile`) is `Error::Unsupported`: the byte-slice
//! signature has no sibling-file access. `CompressedData = True` is one **zlib** stream of
//! `CompressedDataSize` bytes; `BinaryData = False` is whitespace-separated ASCII.
//!
//! MetaImage coordinates are **LPS**. The affine is `[TransformMatrix·diag(ElementSpacing) | Offset]`
//! — `TransformMatrix` stores the per-axis direction vectors consecutively, i.e. the direction matrix
//! column-major, exactly what SimpleITK's `GetDirection()` transposes back — with the first two world
//! rows negated to reach RAS, as a SimpleITK→nibabel conversion does.

use std::collections::BTreeMap;

use tvx_core::{Error, ProgressSink, Result};

use crate::common::{
    data_slice, decode_ascii, decode_samples, finish, identity, inflate_zlib, jmat, jnums,
    take_inflated, voxel_count, Meta,
};
use crate::{DataType, Volume};

/// The header, lower-cased keys, plus the byte offset of the line after `ElementDataFile`.
struct Header {
    fields: BTreeMap<String, String>,
    /// The keys as written, for `header_json`.
    written: Vec<(String, String)>,
    data_start: usize,
}

fn parse_header(raw: &[u8]) -> Result<Header> {
    let mut fields = BTreeMap::new();
    let mut written = Vec::new();
    let mut pos = 0usize;
    loop {
        if pos >= raw.len() {
            return Err(Error::Parse(
                "MetaImage header has no `ElementDataFile` line (truncated file?)".into(),
            ));
        }
        let rest = &raw[pos..];
        let nl = rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len());
        let line = String::from_utf8_lossy(&rest[..nl]);
        let line = line.trim_end_matches('\r');
        pos += nl + 1;
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some((k, v)) = t.split_once('=') else {
            return Err(Error::Parse(format!(
                "MetaImage header line {t:?} is not `Key = Value`"
            )));
        };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim().to_string();
        written.push((k.trim().to_string(), val.clone()));
        let last = key == "elementdatafile";
        fields.insert(key, val);
        if last {
            break;
        }
    }
    Ok(Header {
        fields,
        written,
        data_start: pos.min(raw.len()),
    })
}

fn datatype_of(s: &str) -> Result<DataType> {
    Ok(match s.trim().to_ascii_uppercase().as_str() {
        "MET_UCHAR" => DataType::U8,
        "MET_CHAR" => DataType::I8,
        "MET_USHORT" => DataType::U16,
        "MET_SHORT" => DataType::I16,
        "MET_UINT" => DataType::U32,
        "MET_INT" => DataType::I32,
        "MET_FLOAT" => DataType::F32,
        "MET_DOUBLE" => DataType::F64,
        "MET_LONG" | "MET_LONG_LONG" | "MET_ULONG" | "MET_ULONG_LONG" => {
            return Err(Error::Unsupported(format!(
                "MetaImage ElementType {s} (64-bit integer)"
            )))
        }
        _ => {
            return Err(Error::Parse(format!(
                "MetaImage ElementType {s:?} is not a MET_ type"
            )))
        }
    })
}

fn floats(key: &str, v: &str) -> Result<Vec<f64>> {
    v.split_whitespace()
        .map(|t| {
            t.parse::<f64>()
                .map_err(|_| Error::Parse(format!("MetaImage {key}: {t:?} is not a number")))
        })
        .collect()
}

fn boolean(key: &str, v: &str) -> Result<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(Error::Parse(format!(
            "MetaImage {key}: {other:?} is not True/False"
        ))),
    }
}

/// Parse a `.mha` byte vector. Takes ownership and frees it before returning (§5 rule 5).
pub fn read_metaimage(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    let raw = take_inflated(bytes, p)?;
    read_metaimage_raw(raw, p)
}

/// The MetaImage reader proper.
pub(crate) fn read_metaimage_raw(raw: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    use serde_json::{json, Map, Value};

    let h = parse_header(&raw)?;
    let field = |k: &str| h.fields.get(k).map(|s| s.as_str());
    let required = |k: &str| {
        field(&k.to_ascii_lowercase()).ok_or_else(|| Error::Parse(format!("MetaImage: no `{k}`")))
    };

    if let Some(ot) = field("objecttype") {
        if !ot.eq_ignore_ascii_case("image") {
            return Err(Error::Unsupported(format!("MetaImage ObjectType {ot}")));
        }
    }
    let data_file = required("ElementDataFile")?;
    if !data_file.eq_ignore_ascii_case("local") {
        return Err(Error::Unsupported(format!(
            "detached MetaImage header (.mhd): the samples are in the sibling file \
             `ElementDataFile = {data_file}`, which this reader cannot open — convert to a .mha"
        )));
    }

    let ndims = floats("NDims", required("NDims")?)?;
    let ndims = match ndims.as_slice() {
        [n] if *n == 3.0 || *n == 4.0 => *n as usize,
        [n] => {
            return Err(Error::Unsupported(format!(
                "MetaImage NDims {n} (only 3 or 4)"
            )))
        }
        _ => return Err(Error::Parse("MetaImage NDims must be one integer".into())),
    };
    let dim_size = floats("DimSize", required("DimSize")?)?;
    if dim_size.len() != ndims || dim_size.iter().any(|&d| d < 1.0 || d.fract() != 0.0) {
        return Err(Error::Parse(format!(
            "MetaImage DimSize {dim_size:?} does not match NDims {ndims} or is not positive"
        )));
    }
    let dims = [
        dim_size[0] as usize,
        dim_size[1] as usize,
        dim_size[2] as usize,
    ];
    let nvols = if ndims == 4 { dim_size[3] as usize } else { 1 };

    let elem = datatype_of(required("ElementType")?)?;
    let channels = match field("elementnumberofchannels") {
        Some(c) => floats("ElementNumberOfChannels", c)?
            .first()
            .copied()
            .unwrap_or(1.0) as usize,
        None => 1,
    };
    let datatype = match (channels, elem) {
        (1, dt) => dt,
        (3, DataType::U8) => DataType::Rgb24,
        (4, DataType::U8) => DataType::Rgba32,
        (c, dt) => {
            return Err(Error::Unsupported(format!(
                "MetaImage with ElementNumberOfChannels = {c} of {}; only 1, or 3/4 of MET_UCHAR \
                 (RGB24/RGBA32)",
                dt.name()
            )))
        }
    };

    let binary = match field("binarydata") {
        Some(v) => boolean("BinaryData", v)?,
        None => true,
    };
    let msb = match field("binarydatabyteordermsb").or_else(|| field("elementbyteordermsb")) {
        Some(v) => boolean("BinaryDataByteOrderMSB", v)?,
        None => false,
    };
    let compressed = match field("compresseddata") {
        Some(v) => boolean("CompressedData", v)?,
        None => false,
    };
    let compressed_size = match field("compresseddatasize") {
        Some(v) => Some(
            floats("CompressedDataSize", v)?
                .first()
                .copied()
                .unwrap_or(0.0) as usize,
        ),
        None => None,
    };
    let header_size: i64 = match field("headersize") {
        Some(v) => floats("HeaderSize", v)?.first().copied().unwrap_or(-2.0) as i64,
        None => -2, // absent: data follows the header
    };

    // Geometry (LPS): spacing, offset, direction — the latter as per-axis column vectors.
    let spacing_all = match field("elementspacing") {
        Some(v) => floats("ElementSpacing", v)?,
        None => vec![1.0; ndims],
    };
    if spacing_all.len() != ndims {
        return Err(Error::Parse(format!(
            "MetaImage ElementSpacing has {} values for NDims {ndims}",
            spacing_all.len()
        )));
    }
    let offset_all = match field("offset")
        .or_else(|| field("origin"))
        .or_else(|| field("position"))
    {
        Some(v) => floats("Offset", v)?,
        None => vec![0.0; ndims],
    };
    if offset_all.len() != ndims {
        return Err(Error::Parse(format!(
            "MetaImage Offset has {} values for NDims {ndims}",
            offset_all.len()
        )));
    }
    let matrix_all = match field("transformmatrix")
        .or_else(|| field("orientation"))
        .or_else(|| field("rotation"))
    {
        Some(v) => Some(floats("TransformMatrix", v)?),
        None => None,
    };
    if let Some(m) = &matrix_all {
        if m.len() != ndims * ndims {
            return Err(Error::Parse(format!(
                "MetaImage TransformMatrix has {} values for NDims {ndims}",
                m.len()
            )));
        }
    }
    let mut affine = identity();
    let mut spacing = [1.0f64; 3];
    for col in 0..3 {
        spacing[col] = spacing_all[col].abs();
        for r in 0..3 {
            let d = match &matrix_all {
                Some(m) => m[ndims * col + r],
                None if r == col => 1.0,
                None => 0.0,
            };
            affine[r][col] = d * spacing_all[col];
        }
        affine[col][3] = offset_all[col];
    }
    // LPS → RAS.
    for row in affine.iter_mut().take(2) {
        for v in row.iter_mut() {
            *v = -*v;
        }
    }

    // Samples.
    let n_vox = voxel_count(dims, nvols)?;
    let need = n_vox
        .checked_mul(datatype.size())
        .ok_or_else(|| Error::Parse("data size overflows".into()))?;
    let start = match header_size {
        -1 => {
            let n = if compressed {
                compressed_size.unwrap_or(0)
            } else {
                need
            };
            raw.len().checked_sub(n).ok_or_else(|| {
                Error::Parse(format!(
                    "truncated: HeaderSize -1 needs {n} B of {}",
                    raw.len()
                ))
            })?
        }
        n if n >= 0 => (n as usize).min(raw.len()),
        _ => h.data_start,
    };
    let data = if !binary {
        if compressed {
            return Err(Error::Unsupported(
                "MetaImage ASCII data with CompressedData".into(),
            ));
        }
        decode_ascii(&raw[start..], n_vox, datatype, p)?
    } else if compressed {
        let end = match compressed_size {
            Some(n) => start
                .checked_add(n)
                .filter(|e| *e <= raw.len())
                .ok_or_else(|| {
                    Error::Parse(format!(
                        "truncated: CompressedDataSize {n} at offset {start}, file has {}",
                        raw.len()
                    ))
                })?,
            None => raw.len(),
        };
        let inflated = inflate_zlib(&raw[start..end], need as u64, p)?;
        let src = data_slice(&inflated, 0, n_vox, datatype)?;
        decode_samples(src, n_vox, datatype, !msb, p)?
    } else {
        let src = data_slice(&raw, start, n_vox, datatype)?;
        decode_samples(src, n_vox, datatype, !msb, p)?
    };
    drop(raw);

    let mut hdr = Map::new();
    for (k, v) in &h.written {
        hdr.insert(k.clone(), json!(v));
    }
    hdr.insert("dataOffset".into(), json!(start));
    hdr.insert("dtype".into(), json!(datatype.name()));
    hdr.insert("endian".into(), json!(if msb { "big" } else { "little" }));
    hdr.insert(
        "affineSource".into(),
        json!("TransformMatrix·ElementSpacing | Offset, LPS→RAS"),
    );
    hdr.insert("affine".into(), jmat(&affine));
    hdr.insert("spacing".into(), jnums(&spacing));

    let mut meta = Meta::new(dims, nvols, "MetaImage");
    meta.affine = affine;
    meta.spacing = spacing;
    meta.header_json = Value::Object(hdr).to_string();
    finish(meta, datatype, data, p)
}
