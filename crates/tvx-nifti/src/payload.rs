//! `label_index`, the `gpu_payload` selection ladder and `sample_nearest` (ARCHITECTURE.md §6.1).

use tvx_core::{Error, NoProgress, ProgressSink, Result};

use crate::scan::{for_each, Scan};
use crate::stats::unique_ids;
use crate::{DataType, GpuCaps, GpuFormat, GpuPayload, LabelIndex, Volume, VolumeData};

/// §6.1 row 2's ceiling: a dense index has to fit `R16UI`.
const MAX_DENSE: usize = 65536;

pub(crate) fn label_index(v: &Volume, vol: usize, p: &mut dyn ProgressSink) -> Result<LabelIndex> {
    if vol >= v.nvols {
        return Err(Error::Parse(format!(
            "volume index {vol} is out of range (nvols = {})",
            v.nvols
        )));
    }
    if v.datatype.is_color() {
        return Err(Error::Unsupported(format!(
            "{} is a colour volume, not a label volume",
            v.datatype.name()
        )));
    }
    let s = Scan::of(v, Some(vol), p)?;
    if !s.all_integral || s.min < 0.0 {
        return Err(Error::Unsupported(format!(
            "label_index needs integral, non-negative samples; volume {vol} spans {} … {} and is {}",
            s.min,
            s.max,
            if s.all_integral {
                "signed"
            } else {
                "not integral"
            }
        )));
    }
    let ids = unique_ids(v, Some(vol), s.min, s.max, MAX_DENSE, p)?.ok_or_else(|| {
        Error::Unsupported(format!(
            "label volume with ids spanning {} … {} has more than {MAX_DENSE} dense indices",
            s.min, s.max
        ))
    })?;
    // `dense_of` is indexed by raw id, so it is as long as the largest id — never as long as the
    // value range of the dtype (§4.2: sparse ids reach 530 `[DATA]`). Ids absent from the volume map
    // to 0, which is the id the ladder's texture would show for an unmapped sample anyway.
    let max_id = ids.last().copied().unwrap_or(0);
    let mut dense_of = vec![0u32; max_id as usize + 1];
    for (i, id) in ids.iter().enumerate() {
        dense_of[*id as usize] = i as u32;
    }
    Ok(LabelIndex { ids, dense_of })
}

/// The normalised-integer rows of the ladder store a code `c` in `0 ..= full`, and the shader
/// recovers physical units as `v = c * scale + offset` (§6.1 row 4: `scale = (max−min)/65535`,
/// `offset = min`). Exact for any input whose distinct values number at most `full + 1`, which
/// covers u8/i8 into `R8` and u16/i16 into `R16`.
fn normalised(s: &Scan, full: f64) -> (f32, f32) {
    if s.span() <= 0.0 {
        (1.0, s.min as f32)
    } else {
        ((s.span() / full) as f32, s.min as f32)
    }
}

fn code_of(x: f64, s: &Scan, full: f64) -> f64 {
    if !x.is_finite() || s.span() <= 0.0 {
        return 0.0;
    }
    ((x - s.min) / s.span() * full).round().clamp(0.0, full)
}

fn bytes_r8(v: &Volume, vol: usize, s: &Scan) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(voxels(v));
    for_each(v, Some(vol), &mut NoProgress, |x| {
        out.push(code_of(x, s, 255.0) as u8)
    })?;
    Ok(out)
}

fn bytes_r16(v: &Volume, vol: usize, s: &Scan) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(voxels(v) * 2);
    for_each(v, Some(vol), &mut NoProgress, |x| {
        out.extend_from_slice(&(code_of(x, s, 65535.0) as u16).to_le_bytes())
    })?;
    Ok(out)
}

/// `R32F` carries physical units directly, NaN/Inf included — that is what row 9 is for.
fn bytes_r32f(v: &Volume, vol: usize) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(voxels(v) * 4);
    for_each(v, Some(vol), &mut NoProgress, |x| {
        out.extend_from_slice(&(x as f32).to_le_bytes())
    })?;
    Ok(out)
}

fn voxels(v: &Volume) -> usize {
    v.dims[0] * v.dims[1] * v.dims[2]
}

/// Row 10: RGB24 widens to RGBA8 with an opaque alpha; RGBA32 is already the GL layout.
fn bytes_rgba8(v: &Volume, vol: usize) -> Vec<u8> {
    let n = voxels(v);
    let mut out = vec![0u8; n * 4];
    match &v.data {
        VolumeData::Rgb24(d) => {
            let base = vol * n * 3;
            for i in 0..n {
                out[i * 4] = d[base + i * 3];
                out[i * 4 + 1] = d[base + i * 3 + 1];
                out[i * 4 + 2] = d[base + i * 3 + 2];
                out[i * 4 + 3] = 255;
            }
        }
        VolumeData::Rgba32(d) => {
            let base = vol * n * 4;
            out.copy_from_slice(&d[base..base + n * 4]);
        }
        _ => unreachable!("bytes_rgba8 is only reached for the two colour dtypes"),
    }
    out
}

fn label_bytes(v: &Volume, vol: usize, idx: &LabelIndex, wide: bool) -> Result<Vec<u8>> {
    let n = voxels(v);
    let mut out = Vec::with_capacity(if wide { n * 2 } else { n });
    for_each(v, Some(vol), &mut NoProgress, |x| {
        let d = if x.is_finite() && x >= 0.0 {
            idx.dense_of.get(x as usize).copied().unwrap_or(0)
        } else {
            0
        };
        if wide {
            out.extend_from_slice(&(d as u16).to_le_bytes());
        } else {
            out.push(d as u8);
        }
    })?;
    Ok(out)
}

pub(crate) fn gpu_payload(
    v: &Volume,
    vol: usize,
    caps: &GpuCaps,
    want_linear: bool,
) -> Result<GpuPayload> {
    if vol >= v.nvols {
        return Err(Error::Parse(format!(
            "volume index {vol} is out of range (nvols = {})",
            v.nvols
        )));
    }
    // §6.1: a volume larger than MAX_3D_TEXTURE_SIZE fails loudly here, never as a silently
    // incomplete texture at draw time.
    let biggest = v.dims.iter().copied().max().unwrap_or(0);
    if biggest > caps.max_3d as usize {
        return Err(Error::Unsupported(format!(
            "{}x{}x{} exceeds this context's MAX_3D_TEXTURE_SIZE of {}; downsample to load it",
            v.dims[0], v.dims[1], v.dims[2], caps.max_3d
        )));
    }

    // Row 10 — colour volumes never reach the scalar ladder.
    if v.datatype.is_color() {
        return Ok(GpuPayload {
            format: GpuFormat::Rgba8,
            bytes: bytes_rgba8(v, vol),
            scale: 1.0,
            offset: 0.0,
            filterable: true,
        });
    }

    // Rows 1-2 — labels, as a dense index and NEAREST. `want_linear` is false exactly when the
    // layer is a label or `interpolation === 'nearest'` (§6.1), so a scalar volume that happens to
    // hold small integers still takes its dtype's row.
    if v.is_label && !want_linear {
        let idx = label_index(v, vol, &mut NoProgress)?;
        let max_dense = idx.ids.len().saturating_sub(1);
        if max_dense <= 255 {
            return Ok(GpuPayload {
                format: GpuFormat::R8Ui,
                bytes: label_bytes(v, vol, &idx, false)?,
                scale: 1.0,
                offset: 0.0,
                filterable: false,
            });
        }
        if max_dense <= 65535 {
            return Ok(GpuPayload {
                format: GpuFormat::R16Ui,
                bytes: label_bytes(v, vol, &idx, true)?,
                scale: 1.0,
                offset: 0.0,
                filterable: false,
            });
        }
        return Err(Error::Unsupported(format!(
            "{} distinct labels exceed R16UI's 65536",
            idx.ids.len()
        )));
    }

    let s = Scan::of(v, Some(vol), &mut NoProgress)?;
    let r8 = |s: &Scan| -> Result<GpuPayload> {
        let (scale, offset) = normalised(s, 255.0);
        Ok(GpuPayload {
            format: GpuFormat::R8,
            bytes: bytes_r8(v, vol, s)?,
            scale,
            offset,
            filterable: true,
        })
    };
    let r16 = |s: &Scan| -> Result<GpuPayload> {
        let (scale, offset) = normalised(s, 65535.0);
        Ok(GpuPayload {
            format: GpuFormat::R16,
            bytes: bytes_r16(v, vol, s)?,
            scale,
            offset,
            filterable: true,
        })
    };
    let r32f = || -> Result<GpuPayload> {
        Ok(GpuPayload {
            format: GpuFormat::R32F,
            bytes: bytes_r32f(v, vol)?,
            scale: 1.0,
            offset: 0.0,
            filterable: true,
        })
    };

    match v.datatype {
        // Row 3.
        DataType::U8 | DataType::I8 => r8(&s),
        // Rows 4-6.
        DataType::U16 | DataType::I16 => {
            if caps.norm16 {
                r16(&s)
            } else if caps.float_linear {
                r32f()
            } else {
                // Never R16UI for a non-label layer — that is the silent black-slice case.
                r8(&s)
            }
        }
        // Row 7, plus the fallbacks the table leaves implicit for a context with neither
        // capability: an integer layer is still displayable at reduced precision.
        DataType::U32 | DataType::I32 => {
            if caps.norm16 {
                r16(&s)
            } else if caps.float_linear {
                r32f()
            } else {
                r8(&s)
            }
        }
        // Rows 8-9. Row 8 requires a finite range; a volume carrying NaN/Inf needs R32F to keep it.
        DataType::F32 | DataType::F64 => {
            if !s.any_nonfinite && caps.norm16 {
                r16(&s)
            } else if caps.float_linear {
                r32f()
            } else if caps.norm16 {
                r16(&s)
            } else {
                r8(&s)
            }
        }
        DataType::Rgb24 | DataType::Rgba32 => unreachable!("handled by row 10 above"),
    }
}

/// Invert the 4x4 affine, which is always `[[R, t], [0, 0, 0, 1]]`, by inverting `R` and
/// back-substituting `t`. Returns `None` for a singular `R`.
fn inverse_affine(m: &[[f64; 4]; 4]) -> Option<[[f64; 4]; 4]> {
    let a = [
        [m[0][0], m[0][1], m[0][2]],
        [m[1][0], m[1][1], m[1][2]],
        [m[2][0], m[2][1], m[2][2]],
    ];
    let det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let inv_det = 1.0 / det;
    let mut inv = [[0f64; 4]; 4];
    inv[0][0] = (a[1][1] * a[2][2] - a[1][2] * a[2][1]) * inv_det;
    inv[0][1] = (a[0][2] * a[2][1] - a[0][1] * a[2][2]) * inv_det;
    inv[0][2] = (a[0][1] * a[1][2] - a[0][2] * a[1][1]) * inv_det;
    inv[1][0] = (a[1][2] * a[2][0] - a[1][0] * a[2][2]) * inv_det;
    inv[1][1] = (a[0][0] * a[2][2] - a[0][2] * a[2][0]) * inv_det;
    inv[1][2] = (a[0][2] * a[1][0] - a[0][0] * a[1][2]) * inv_det;
    inv[2][0] = (a[1][0] * a[2][1] - a[1][1] * a[2][0]) * inv_det;
    inv[2][1] = (a[0][1] * a[2][0] - a[0][0] * a[2][1]) * inv_det;
    inv[2][2] = (a[0][0] * a[1][1] - a[0][1] * a[1][0]) * inv_det;
    for row in inv.iter_mut().take(3) {
        row[3] = -(row[0] * m[0][3] + row[1] * m[1][3] + row[2] * m[2][3]);
    }
    inv[3] = [0.0, 0.0, 0.0, 1.0];
    Some(inv)
}

pub(crate) fn sample_nearest(v: &Volume, vol: usize, world: [f32; 3]) -> Option<f32> {
    if vol >= v.nvols || v.datatype.is_color() {
        return None;
    }
    let inv = inverse_affine(&v.affine)?;
    let w = [world[0] as f64, world[1] as f64, world[2] as f64];
    let mut ijk = [0usize; 3];
    for (r, slot) in ijk.iter_mut().enumerate() {
        let c = inv[r][0] * w[0] + inv[r][1] * w[1] + inv[r][2] * w[2] + inv[r][3];
        let c = c.round();
        if !c.is_finite() || c < 0.0 || c >= v.dims[r] as f64 {
            return None;
        }
        *slot = c as usize;
    }
    let per = voxels(v);
    let i = vol * per + ijk[0] + v.dims[0] * (ijk[1] + v.dims[1] * ijk[2]);
    let raw = match &v.data {
        VolumeData::U8(d) => d[i] as f64,
        VolumeData::I8(d) => d[i] as f64,
        VolumeData::U16(d) => d[i] as f64,
        VolumeData::I16(d) => d[i] as f64,
        VolumeData::U32(d) => d[i] as f64,
        VolumeData::I32(d) => d[i] as f64,
        VolumeData::F32(d) => d[i] as f64,
        VolumeData::F64(d) => d[i],
        VolumeData::Rgb24(_) | VolumeData::Rgba32(_) => return None,
    };
    Some((raw * v.scl_slope as f64 + v.scl_inter as f64) as f32)
}
