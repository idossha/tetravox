//! Reading samples out of a [`VolumeData`] without caring which variant it is.

use tvx_nifti::VolumeData;

pub fn len(d: &VolumeData) -> usize {
    match d {
        VolumeData::U8(v) => v.len(),
        VolumeData::I8(v) => v.len(),
        VolumeData::U16(v) => v.len(),
        VolumeData::I16(v) => v.len(),
        VolumeData::U32(v) => v.len(),
        VolumeData::I32(v) => v.len(),
        VolumeData::F32(v) => v.len(),
        VolumeData::F64(v) => v.len(),
        // RGB/RGBA carry 3 or 4 bytes per voxel; a label or scalar reading of them is meaningless,
        // so they report zero samples and every caller treats them as empty.
        VolumeData::Rgb24(_) | VolumeData::Rgba32(_) => 0,
    }
}

/// The §6.5.1 `dtype` name of a variant, for the mismatch check §6.3 requires.
pub fn dtype_name(d: &VolumeData) -> &'static str {
    match d {
        VolumeData::U8(_) => "u8",
        VolumeData::I8(_) => "i8",
        VolumeData::U16(_) => "u16",
        VolumeData::I16(_) => "i16",
        VolumeData::U32(_) => "u32",
        VolumeData::I32(_) => "i32",
        VolumeData::F32(_) => "f32",
        VolumeData::F64(_) => "f64",
        VolumeData::Rgb24(_) => "rgb24",
        VolumeData::Rgba32(_) => "rgba32",
    }
}

/// One raw sample as `f32`. Slope/intercept are **not** applied — §6.1 keeps `Volume::data` raw.
pub fn raw(d: &VolumeData, i: usize) -> f32 {
    match d {
        VolumeData::U8(v) => v.get(i).map_or(f32::NAN, |&x| f32::from(x)),
        VolumeData::I8(v) => v.get(i).map_or(f32::NAN, |&x| f32::from(x)),
        VolumeData::U16(v) => v.get(i).map_or(f32::NAN, |&x| f32::from(x)),
        VolumeData::I16(v) => v.get(i).map_or(f32::NAN, |&x| f32::from(x)),
        VolumeData::U32(v) => v.get(i).map_or(f32::NAN, |&x| x as f32),
        VolumeData::I32(v) => v.get(i).map_or(f32::NAN, |&x| x as f32),
        VolumeData::F32(v) => v.get(i).copied().unwrap_or(f32::NAN),
        VolumeData::F64(v) => v.get(i).map_or(f32::NAN, |&x| x as f32),
        VolumeData::Rgb24(_) | VolumeData::Rgba32(_) => f32::NAN,
    }
}

/// A raw sample read as a label id. Non-finite and negative samples map to `None`.
pub fn label(d: &VolumeData, i: usize) -> Option<u32> {
    let v = raw(d, i);
    // `labeling.nii.gz` is a **float32** label volume with 57 integral unique values `[DATA]`, so
    // rounding rather than truncating is what makes a float atlas index correctly.
    if !v.is_finite() || v < -0.5 {
        None
    } else {
        Some((v + 0.5) as u32)
    }
}

/// `voxel = M · world` with `M` flat, length 16, **column-major** (§6.5.1 `Mat4x4`).
pub fn world_to_voxel(m: &[f64; 16], w: [f32; 3]) -> [f64; 3] {
    let w = [f64::from(w[0]), f64::from(w[1]), f64::from(w[2]), 1.0];
    let mut out = [0.0f64; 3];
    for (row, o) in out.iter_mut().enumerate() {
        *o = (0..4).map(|col| m[col * 4 + row] * w[col]).sum();
    }
    out
}
