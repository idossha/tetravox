//! `read_nifti` — magic sniff, inflate, header, samples (ARCHITECTURE.md §6.1).

use std::io::Read;

use byteorder::ByteOrder;
use tvx_core::{Error, Phase, ProgressSink, Result};

use crate::header::RawHeader;
use crate::{DataType, SpaceUnit, TimeUnit, Units, Volume, VolumeData};

/// Progress is reported (and cancellation polled) once per chunk of this many samples/bytes.
const CHUNK: usize = 1 << 20;

/// Refuse to pre-reserve more than this from a gzip trailer, which is attacker-controlled and only
/// 32 bits wide anyway.
const MAX_RESERVE: usize = 1 << 30;

fn is_gzip(b: &[u8]) -> bool {
    b.len() >= 2 && b[0] == 0x1f && b[1] == 0x8b
}

/// gzip's trailer carries the uncompressed size mod 2^32 — a hint for `Vec::reserve` and for the
/// progress bar's denominator, never trusted as a length.
fn isize_hint(b: &[u8]) -> u64 {
    if b.len() < 4 {
        return 0;
    }
    let t = &b[b.len() - 4..];
    u32::from_le_bytes([t[0], t[1], t[2], t[3]]) as u64
}

fn inflate(src: &[u8], p: &mut dyn ProgressSink) -> Result<Vec<u8>> {
    let hint = isize_hint(src);
    let mut out: Vec<u8> = Vec::new();
    out.reserve_exact((hint as usize).min(MAX_RESERVE));
    let mut dec = flate2::read::GzDecoder::new(src);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = dec
            .read(&mut buf)
            .map_err(|e| Error::Parse(format!("gzip: {e}")))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        p.report(Phase::Inflate, out.len() as u64, hint);
        if p.aborted() {
            return Err(Error::Cancelled);
        }
    }
    Ok(out)
}

/// §6.1's accepted datatypes, and the rejections *by name*.
fn datatype_of(code: i16) -> Result<DataType> {
    let name = |n: &str| Err(Error::Unsupported(format!("NIfTI datatype {n} ({code})")));
    match code {
        2 => Ok(DataType::U8),
        256 => Ok(DataType::I8),
        512 => Ok(DataType::U16),
        4 => Ok(DataType::I16),
        768 => Ok(DataType::U32),
        8 => Ok(DataType::I32),
        16 => Ok(DataType::F32),
        64 => Ok(DataType::F64),
        128 => Ok(DataType::Rgb24),
        2304 => Ok(DataType::Rgba32),
        32 => name("complex64"),
        1792 => name("complex128"),
        2048 => name("complex256"),
        1024 => name("int64"),
        1280 => name("uint64"),
        1536 => name("float128"),
        1 => name("binary (1 bit per voxel)"),
        0 => name("unknown (0)"),
        _ => name("unrecognised"),
    }
}

impl DataType {
    /// Bytes on disk per voxel.
    pub(crate) fn size(self) -> usize {
        match self {
            DataType::U8 | DataType::I8 => 1,
            DataType::U16 | DataType::I16 => 2,
            DataType::U32 | DataType::I32 | DataType::F32 | DataType::Rgba32 => 4,
            DataType::F64 => 8,
            DataType::Rgb24 => 3,
        }
    }
    pub(crate) fn name(self) -> &'static str {
        match self {
            DataType::U8 => "uint8",
            DataType::I8 => "int8",
            DataType::U16 => "uint16",
            DataType::I16 => "int16",
            DataType::U32 => "uint32",
            DataType::I32 => "int32",
            DataType::F32 => "float32",
            DataType::F64 => "float64",
            DataType::Rgb24 => "rgb24",
            DataType::Rgba32 => "rgba32",
        }
    }
    /// True for the two colour types, which §4.2's scalar display model does not cover.
    pub(crate) fn is_color(self) -> bool {
        matches!(self, DataType::Rgb24 | DataType::Rgba32)
    }
}

fn units_of(xyzt: i32) -> Units {
    Units {
        space: match xyzt & 0x07 {
            1 => SpaceUnit::Meter,
            2 => SpaceUnit::Millimeter,
            3 => SpaceUnit::Micron,
            _ => SpaceUnit::Unknown,
        },
        time: match xyzt & 0x38 {
            8 => TimeUnit::Second,
            16 => TimeUnit::Millisecond,
            24 => TimeUnit::Microsecond,
            32 => TimeUnit::Hz,
            40 => TimeUnit::Ppm,
            48 => TimeUnit::Rads,
            _ => TimeUnit::Unknown,
        },
    }
}

/// §3: sform when `sform_code > 0`, else the qform with **`qfac` on the third column only**, else
/// `diag(pixdim[1..4], 1)`. Row-major `m[row][col]`.
fn affine_of(h: &RawHeader) -> ([[f64; 4]; 4], &'static str) {
    let mut m = [[0f64; 4]; 4];
    m[3] = [0.0, 0.0, 0.0, 1.0];
    if h.sform_code > 0 {
        m[0] = h.srow[0];
        m[1] = h.srow[1];
        m[2] = h.srow[2];
        return (m, "sform");
    }
    if h.qform_code > 0 {
        let (b, c, d) = (h.quatern[0], h.quatern[1], h.quatern[2]);
        let a = (1.0 - (b * b + c * c + d * d)).max(0.0).sqrt();
        let r = [
            [
                a * a + b * b - c * c - d * d,
                2.0 * (b * c - a * d),
                2.0 * (b * d + a * c),
            ],
            [
                2.0 * (b * c + a * d),
                a * a + c * c - b * b - d * d,
                2.0 * (c * d - a * b),
            ],
            [
                2.0 * (b * d - a * c),
                2.0 * (c * d + a * b),
                a * a + d * d - b * b - c * c,
            ],
        ];
        let s = [h.pixdim[1], h.pixdim[2], h.pixdim[3] * h.qfac()];
        for (row, dst) in m.iter_mut().take(3).enumerate() {
            for col in 0..3 {
                dst[col] = r[row][col] * s[col];
            }
            dst[3] = h.qoffset[row];
        }
        return (m, "qform");
    }
    for (i, dst) in m.iter_mut().take(3).enumerate() {
        dst[i] = h.pixdim[i + 1];
    }
    (m, "pixdim")
}

/// A JSON number that survives NaN/Inf, encoded exactly as `testdata/manifest.json` does.
fn jnum(v: f64) -> serde_json::Value {
    match serde_json::Number::from_f64(v) {
        Some(n) => serde_json::Value::Number(n),
        None if v.is_nan() => serde_json::Value::String("NaN".into()),
        None if v > 0.0 => serde_json::Value::String("Infinity".into()),
        None => serde_json::Value::String("-Infinity".into()),
    }
}

fn jnums(v: &[f64]) -> serde_json::Value {
    serde_json::Value::Array(v.iter().copied().map(jnum).collect())
}

fn header_json(h: &RawHeader, affine_source: &str) -> String {
    use serde_json::{json, Map, Value};
    let mut m = Map::new();
    m.insert("niftiVersion".into(), json!(h.version));
    m.insert(
        "endian".into(),
        json!(if h.little_endian { "little" } else { "big" }),
    );
    m.insert("sizeof_hdr".into(), json!(h.sizeof_hdr));
    m.insert("dim_info".into(), json!(h.dim_info));
    m.insert("dim".into(), json!(h.dim));
    m.insert("intent_p1".into(), jnum(h.intent_p[0]));
    m.insert("intent_p2".into(), jnum(h.intent_p[1]));
    m.insert("intent_p3".into(), jnum(h.intent_p[2]));
    m.insert("intent_code".into(), json!(h.intent_code));
    m.insert("datatype".into(), json!(h.datatype));
    m.insert("bitpix".into(), json!(h.bitpix));
    m.insert("slice_start".into(), json!(h.slice_start));
    m.insert("pixdim".into(), jnums(&h.pixdim));
    m.insert("vox_offset".into(), json!(h.vox_offset));
    m.insert("scl_slope".into(), jnum(h.scl_slope));
    m.insert("scl_inter".into(), jnum(h.scl_inter));
    m.insert("slice_end".into(), json!(h.slice_end));
    m.insert("slice_code".into(), json!(h.slice_code));
    m.insert("xyzt_units".into(), json!(h.xyzt_units));
    m.insert("cal_max".into(), jnum(h.cal_max));
    m.insert("cal_min".into(), jnum(h.cal_min));
    m.insert("slice_duration".into(), jnum(h.slice_duration));
    m.insert("toffset".into(), jnum(h.toffset));
    m.insert("descrip".into(), json!(h.descrip));
    m.insert("aux_file".into(), json!(h.aux_file));
    m.insert("qform_code".into(), json!(h.qform_code));
    m.insert("sform_code".into(), json!(h.sform_code));
    m.insert("quatern_b".into(), jnum(h.quatern[0]));
    m.insert("quatern_c".into(), jnum(h.quatern[1]));
    m.insert("quatern_d".into(), jnum(h.quatern[2]));
    m.insert("qoffset_x".into(), jnum(h.qoffset[0]));
    m.insert("qoffset_y".into(), jnum(h.qoffset[1]));
    m.insert("qoffset_z".into(), jnum(h.qoffset[2]));
    m.insert("srow_x".into(), jnums(&h.srow[0]));
    m.insert("srow_y".into(), jnums(&h.srow[1]));
    m.insert("srow_z".into(), jnums(&h.srow[2]));
    m.insert("intent_name".into(), json!(h.intent_name));
    m.insert("magic".into(), json!(h.magic));
    if let Some(n1) = &h.n1 {
        m.insert("data_type".into(), json!(n1.data_type));
        m.insert("db_name".into(), json!(n1.db_name));
        m.insert("extents".into(), json!(n1.extents));
        m.insert("session_error".into(), json!(n1.session_error));
        m.insert("regular".into(), json!(n1.regular));
        m.insert("glmax".into(), json!(n1.glmax));
        m.insert("glmin".into(), json!(n1.glmin));
    }
    // Derived, so the header panel can show what the reader actually did with the header.
    m.insert("qfac".into(), jnum(h.qfac()));
    m.insert("affineSource".into(), json!(affine_source));
    Value::Object(m).to_string()
}

/// A fallible allocation: a 512x512x416 float64 volume is 872 MB, and wasm32's linear memory tops
/// out at 4032 MiB (§9.2), so this has to be an `Error`, not an abort.
fn alloc<T: Copy + Default>(n: usize, size: usize) -> Result<Vec<T>> {
    let mut v: Vec<T> = Vec::new();
    v.try_reserve_exact(n)
        .map_err(|_| Error::OutOfMemory(format!("{n} samples x {size} B")))?;
    v.resize(n, T::default());
    Ok(v)
}

/// Decode `n` fixed-width samples in either byte order, chunked so progress and cancellation are
/// observable on a 54 MB volume.
macro_rules! decode_scalar {
    ($src:expr, $n:expr, $le:expr, $p:expr, $t:ty, $sz:expr, $read:ident) => {{
        let mut out = alloc::<$t>($n, $sz)?;
        let mut i = 0usize;
        while i < $n {
            let end = (i + CHUNK).min($n);
            let src = &$src[i * $sz..end * $sz];
            if $le {
                byteorder::LittleEndian::$read(src, &mut out[i..end]);
            } else {
                byteorder::BigEndian::$read(src, &mut out[i..end]);
            }
            i = end;
            $p.report(Phase::Parse, i as u64, $n as u64);
            if $p.aborted() {
                return Err(Error::Cancelled);
            }
        }
        out
    }};
}

/// Parse a `.nii` / `.nii.gz` byte vector. Takes ownership and frees it before returning (§5 rule 5).
pub fn read_nifti(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    let n_in = bytes.len() as u64;
    p.report(Phase::Read, n_in, n_in);
    if p.aborted() {
        return Err(Error::Cancelled);
    }

    let raw: Vec<u8> = if is_gzip(&bytes) {
        let out = inflate(&bytes, p)?;
        drop(bytes);
        out
    } else {
        bytes
    };

    let h = RawHeader::parse(&raw)?;
    let datatype = datatype_of(h.datatype)?;
    let dims = h.spatial_dims()?;
    let nvols = h.nvols()?;

    let n_vox = dims[0]
        .checked_mul(dims[1])
        .and_then(|v| v.checked_mul(dims[2]))
        .and_then(|v| v.checked_mul(nvols))
        .ok_or_else(|| Error::Parse("voxel count overflows".into()))?;

    let hdr_len = if h.version == 1 { 348 } else { 540 };
    let off = if h.vox_offset < hdr_len as i64 {
        hdr_len
    } else {
        h.vox_offset as usize
    };
    let need = n_vox
        .checked_mul(datatype.size())
        .ok_or_else(|| Error::Parse("data size overflows".into()))?;
    let end = off
        .checked_add(need)
        .ok_or_else(|| Error::Parse("data extent overflows".into()))?;
    if raw.len() < end {
        return Err(Error::Parse(format!(
            "truncated: {} voxels of {} need {need} B at offset {off}, file has {}",
            n_vox,
            datatype.name(),
            raw.len()
        )));
    }
    let src = &raw[off..end];
    let le = h.little_endian;

    let data = match datatype {
        DataType::U8 => VolumeData::U8(src.to_vec()),
        DataType::I8 => VolumeData::I8(src.iter().map(|&b| b as i8).collect()),
        DataType::U16 => VolumeData::U16(decode_scalar!(src, n_vox, le, p, u16, 2, read_u16_into)),
        DataType::I16 => VolumeData::I16(decode_scalar!(src, n_vox, le, p, i16, 2, read_i16_into)),
        DataType::U32 => VolumeData::U32(decode_scalar!(src, n_vox, le, p, u32, 4, read_u32_into)),
        DataType::I32 => VolumeData::I32(decode_scalar!(src, n_vox, le, p, i32, 4, read_i32_into)),
        DataType::F32 => VolumeData::F32(decode_scalar!(src, n_vox, le, p, f32, 4, read_f32_into)),
        DataType::F64 => VolumeData::F64(decode_scalar!(src, n_vox, le, p, f64, 8, read_f64_into)),
        DataType::Rgb24 => VolumeData::Rgb24(src.to_vec()),
        DataType::Rgba32 => VolumeData::Rgba32(src.to_vec()),
    };
    drop(raw);

    // §6.1: apply slope/inter only when finite, non-zero and not the identity.
    let (slope, inter) = if h.scl_slope.is_finite()
        && h.scl_slope != 0.0
        && h.scl_inter.is_finite()
        && (h.scl_slope != 1.0 || h.scl_inter != 0.0)
    {
        (h.scl_slope as f32, h.scl_inter as f32)
    } else {
        (1.0f32, 0.0f32)
    };

    let (affine, affine_source) = affine_of(&h);
    let mut vol = Volume {
        dims,
        nvols,
        affine,
        spacing: [h.pixdim[1].abs(), h.pixdim[2].abs(), h.pixdim[3].abs()],
        datatype,
        data,
        scl_slope: slope,
        scl_inter: inter,
        cal_min: h.cal_min as f32,
        cal_max: h.cal_max as f32,
        intent_code: h.intent_code as i16,
        intent_name: h.intent_name.clone(),
        descrip: h.descrip.clone(),
        xyz_units: units_of(h.xyzt_units),
        is_label: false,
        header_json: header_json(&h, affine_source),
    };
    vol.is_label = label_test(&vol, p)?;
    Ok(vol)
}

/// §6.1: `is_label` = all sample values integral ∧ min ≥ 0 ∧ (`intent_code == 1002` ∨ unique
/// count ≤ 4096). **The dtype is not part of the test** — `segmentation/labeling.nii.gz` is a
/// float32 atlas `[DATA]`.
fn label_test(v: &Volume, p: &mut dyn ProgressSink) -> Result<bool> {
    if v.datatype.is_color() {
        return Ok(false);
    }
    let Some((min, max)) = crate::scan::integral_range(v, None, p)? else {
        return Ok(false);
    };
    if v.intent_code == 1002 {
        return Ok(true);
    }
    Ok(crate::stats::unique_count_at_most(v, None, min, max, 4096, p)?.is_some())
}
