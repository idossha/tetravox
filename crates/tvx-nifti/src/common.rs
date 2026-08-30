//! What every voxel reader shares (ARCHITECTURE.md §6.1): the gzip/zlib inflate, the fallible sample
//! allocation, the fixed-width and ASCII sample decoders, the slope/inter rule, the `is_label` test and
//! the [`finish`] step that turns a reader's header fields plus decoded samples into one [`Volume`].
//!
//! `read_nifti`, `read_mgh`, `read_nrrd` and `read_metaimage` all end in [`finish`], so the datatype
//! decode, the scaling rule, the label heuristic and the stats machinery exist exactly once.

use std::io::Read;

use byteorder::ByteOrder;
use tvx_core::{Error, Phase, ProgressSink, Result};

use crate::{DataType, SpaceUnit, TimeUnit, Units, Volume, VolumeData};

/// Progress is reported (and cancellation polled) once per chunk of this many samples/bytes.
pub(crate) const CHUNK: usize = 1 << 20;

/// Refuse to pre-reserve more than this from a gzip trailer, which is attacker-controlled and only
/// 32 bits wide anyway.
const MAX_RESERVE: usize = 1 << 30;

pub(crate) fn is_gzip(b: &[u8]) -> bool {
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

/// Drain a decoder in [`CHUNK`]-sized reads so `Phase::Inflate` and cancellation are observable.
fn drain(mut dec: impl Read, hint: u64, what: &str, p: &mut dyn ProgressSink) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    out.reserve_exact((hint as usize).min(MAX_RESERVE));
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = dec
            .read(&mut buf)
            .map_err(|e| Error::Parse(format!("{what}: {e}")))?;
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

/// Inflate a gzip member (`.nii.gz`, `.mgz`, NRRD `encoding: gzip`).
pub(crate) fn inflate_gzip(src: &[u8], p: &mut dyn ProgressSink) -> Result<Vec<u8>> {
    drain(
        flate2::read::GzDecoder::new(src),
        isize_hint(src),
        "gzip",
        p,
    )
}

/// Inflate a zlib stream (MetaImage `CompressedData = True`). `hint` is the expected size, if known.
pub(crate) fn inflate_zlib(src: &[u8], hint: u64, p: &mut dyn ProgressSink) -> Result<Vec<u8>> {
    drain(flate2::read::ZlibDecoder::new(src), hint, "zlib", p)
}

/// The first step of every public reader: report `Phase::Read`, and if the whole file is one gzip
/// member, inflate it **once** and free the compressed bytes (§5 rule 5).
pub(crate) fn take_inflated(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Vec<u8>> {
    let n_in = bytes.len() as u64;
    p.report(Phase::Read, n_in, n_in);
    if p.aborted() {
        return Err(Error::Cancelled);
    }
    if is_gzip(&bytes) {
        let out = inflate_gzip(&bytes, p)?;
        drop(bytes);
        Ok(out)
    } else {
        Ok(bytes)
    }
}

/// A fallible allocation: a 512x512x416 float64 volume is 872 MB, and wasm32's linear memory tops
/// out at 4032 MiB (§9.2), so this has to be an `Error`, not an abort.
pub(crate) fn alloc<T: Copy + Default>(n: usize, size: usize) -> Result<Vec<T>> {
    let mut v: Vec<T> = Vec::new();
    v.try_reserve_exact(n)
        .map_err(|_| Error::OutOfMemory(format!("{n} samples x {size} B")))?;
    v.resize(n, T::default());
    Ok(v)
}

/// `dims[0]·dims[1]·dims[2]·nvols`, refusing to overflow.
pub(crate) fn voxel_count(dims: [usize; 3], nvols: usize) -> Result<usize> {
    dims[0]
        .checked_mul(dims[1])
        .and_then(|v| v.checked_mul(dims[2]))
        .and_then(|v| v.checked_mul(nvols))
        .ok_or_else(|| Error::Parse("voxel count overflows".into()))
}

/// The `n_vox` samples of `datatype` starting at byte `off` of `raw`, or the truncation error every
/// reader words the same way.
pub(crate) fn data_slice(
    raw: &[u8],
    off: usize,
    n_vox: usize,
    datatype: DataType,
) -> Result<&[u8]> {
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
    Ok(&raw[off..end])
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

/// Decode exactly `n_vox` samples of `datatype` from `src` (whose length [`data_slice`] has already
/// checked) in the given byte order.
pub(crate) fn decode_samples(
    src: &[u8],
    n_vox: usize,
    datatype: DataType,
    le: bool,
    p: &mut dyn ProgressSink,
) -> Result<VolumeData> {
    debug_assert_eq!(src.len(), n_vox * datatype.size());
    Ok(match datatype {
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
    })
}

/// Parse whitespace-separated ASCII samples (NRRD `encoding: ascii`, MetaImage `BinaryData = False`).
/// Integers are range-checked against the declared type; floats accept anything `f64` parses
/// (`nan`, `inf` included). Too few tokens is the truncation error, too many is not an error.
pub(crate) fn decode_ascii(
    text: &[u8],
    n_vox: usize,
    datatype: DataType,
    p: &mut dyn ProgressSink,
) -> Result<VolumeData> {
    let text = std::str::from_utf8(text).map_err(|e| Error::Parse(format!("ascii data: {e}")))?;
    let comps = match datatype {
        DataType::Rgb24 => 3,
        DataType::Rgba32 => 4,
        _ => 1,
    };
    let n = n_vox
        .checked_mul(comps)
        .ok_or_else(|| Error::Parse("data size overflows".into()))?;

    fn ints<T: Copy + Default + TryFrom<i64>>(
        text: &str,
        n: usize,
        name: &str,
        p: &mut dyn ProgressSink,
    ) -> Result<Vec<T>> {
        let mut out = alloc::<T>(n, std::mem::size_of::<T>())?;
        let mut it = text.split_ascii_whitespace();
        for (i, slot) in out.iter_mut().enumerate() {
            let tok = it.next().ok_or_else(|| {
                Error::Parse(format!(
                    "truncated: ascii data has {i} of {n} {name} samples"
                ))
            })?;
            let v: i64 = tok
                .parse()
                .map_err(|_| Error::Parse(format!("ascii sample {i}: {tok:?} is not {name}")))?;
            *slot = T::try_from(v)
                .map_err(|_| Error::Parse(format!("ascii sample {i}: {v} out of {name} range")))?;
            if i % CHUNK == CHUNK - 1 {
                p.report(Phase::Parse, i as u64, n as u64);
                if p.aborted() {
                    return Err(Error::Cancelled);
                }
            }
        }
        p.report(Phase::Parse, n as u64, n as u64);
        Ok(out)
    }
    fn floats(text: &str, n: usize, p: &mut dyn ProgressSink) -> Result<Vec<f64>> {
        let mut out = alloc::<f64>(n, 8)?;
        let mut it = text.split_ascii_whitespace();
        for (i, slot) in out.iter_mut().enumerate() {
            let tok = it.next().ok_or_else(|| {
                Error::Parse(format!(
                    "truncated: ascii data has {i} of {n} float samples"
                ))
            })?;
            *slot = tok
                .parse()
                .map_err(|_| Error::Parse(format!("ascii sample {i}: {tok:?} is not a float")))?;
            if i % CHUNK == CHUNK - 1 {
                p.report(Phase::Parse, i as u64, n as u64);
                if p.aborted() {
                    return Err(Error::Cancelled);
                }
            }
        }
        p.report(Phase::Parse, n as u64, n as u64);
        Ok(out)
    }

    Ok(match datatype {
        DataType::U8 => VolumeData::U8(ints(text, n, "uint8", p)?),
        DataType::I8 => VolumeData::I8(ints(text, n, "int8", p)?),
        DataType::U16 => VolumeData::U16(ints(text, n, "uint16", p)?),
        DataType::I16 => VolumeData::I16(ints(text, n, "int16", p)?),
        DataType::U32 => VolumeData::U32(ints(text, n, "uint32", p)?),
        DataType::I32 => VolumeData::I32(ints(text, n, "int32", p)?),
        DataType::F32 => {
            VolumeData::F32(floats(text, n, p)?.into_iter().map(|v| v as f32).collect())
        }
        DataType::F64 => VolumeData::F64(floats(text, n, p)?),
        DataType::Rgb24 => VolumeData::Rgb24(ints(text, n, "uint8", p)?),
        DataType::Rgba32 => VolumeData::Rgba32(ints(text, n, "uint8", p)?),
    })
}

/// A JSON number that survives NaN/Inf, encoded exactly as `testdata/manifest.json` does.
pub(crate) fn jnum(v: f64) -> serde_json::Value {
    match serde_json::Number::from_f64(v) {
        Some(n) => serde_json::Value::Number(n),
        None if v.is_nan() => serde_json::Value::String("NaN".into()),
        None if v > 0.0 => serde_json::Value::String("Infinity".into()),
        None => serde_json::Value::String("-Infinity".into()),
    }
}

pub(crate) fn jnums(v: &[f64]) -> serde_json::Value {
    serde_json::Value::Array(v.iter().copied().map(jnum).collect())
}

pub(crate) fn jmat(m: &[[f64; 4]; 4]) -> serde_json::Value {
    serde_json::Value::Array(m.iter().map(|r| jnums(r)).collect())
}

/// Row-major identity.
pub(crate) fn identity() -> [[f64; 4]; 4] {
    let mut m = [[0f64; 4]; 4];
    for (i, row) in m.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    m
}

/// Everything a reader knows before the samples are decoded — the header half of a [`Volume`].
/// `scl_slope`/`scl_inter` are the **on-disk** values; [`finish`] applies §6.1's rule to them.
pub(crate) struct Meta {
    pub dims: [usize; 3],
    pub nvols: usize,
    pub affine: [[f64; 4]; 4],
    pub spacing: [f64; 3],
    pub scl_slope: f64,
    pub scl_inter: f64,
    pub cal_min: f32,
    pub cal_max: f32,
    pub intent_code: i16,
    pub intent_name: String,
    pub descrip: String,
    pub xyz_units: Units,
    pub header_json: String,
}

impl Meta {
    /// A 3D, 1 mm, identity-affine, unscaled volume; readers fill in what their header carries.
    pub fn new(dims: [usize; 3], nvols: usize, descrip: &str) -> Meta {
        Meta {
            dims,
            nvols,
            affine: identity(),
            spacing: [1.0; 3],
            scl_slope: 1.0,
            scl_inter: 0.0,
            cal_min: 0.0,
            cal_max: 0.0,
            intent_code: 0,
            intent_name: String::new(),
            descrip: descrip.to_string(),
            xyz_units: Units {
                space: SpaceUnit::Millimeter,
                time: TimeUnit::Unknown,
            },
            header_json: String::new(),
        }
    }
}

/// The last step of every reader: apply §6.1's slope/inter rule, run the `is_label` test, and
/// assemble the [`Volume`].
pub(crate) fn finish(
    meta: Meta,
    datatype: DataType,
    data: VolumeData,
    p: &mut dyn ProgressSink,
) -> Result<Volume> {
    // §6.1: apply slope/inter only when finite, non-zero and not the identity.
    let (slope, inter) = if meta.scl_slope.is_finite()
        && meta.scl_slope != 0.0
        && meta.scl_inter.is_finite()
        && (meta.scl_slope != 1.0 || meta.scl_inter != 0.0)
    {
        (meta.scl_slope as f32, meta.scl_inter as f32)
    } else {
        (1.0f32, 0.0f32)
    };
    let mut vol = Volume {
        dims: meta.dims,
        nvols: meta.nvols,
        affine: meta.affine,
        spacing: meta.spacing,
        datatype,
        data,
        scl_slope: slope,
        scl_inter: inter,
        cal_min: meta.cal_min,
        cal_max: meta.cal_max,
        intent_code: meta.intent_code,
        intent_name: meta.intent_name,
        descrip: meta.descrip,
        xyz_units: meta.xyz_units,
        is_label: false,
        header_json: meta.header_json,
    };
    vol.is_label = label_test(&vol, p)?;
    Ok(vol)
}

/// §6.1: `is_label` = all sample values integral ∧ min ≥ 0 ∧ (`intent_code == 1002` ∨ (unique
/// count ≤ 4096 ∧ (unique count ≤ 255 ∨ piecewise constant))). **The dtype is not part of the
/// test** — `segmentation/labeling.nii.gz` is a float32 atlas `[DATA]`. The piecewise-constancy
/// clause is what separates a 1000-parcel atlas from a non-negative 16-bit MRI: both are integral
/// with a thousand distinct values, but only the atlas repeats its value from one voxel to the next
/// (`scan::run_agreement` ≥ 0.5). An AMOS22 abdominal T1 (1014 grey levels in 0…1027) scored 0.11
/// and was being painted with a label palette before this clause existed.
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
    let Some(n) = crate::stats::unique_count_at_most(v, None, min, max, 4096, p)? else {
        return Ok(false);
    };
    Ok(n <= 255 || crate::scan::run_agreement(v, None) >= 0.5)
}
