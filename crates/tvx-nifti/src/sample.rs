//! Trilinear reads at world points (§6.3.1). NaN outside `[0, n−1]` on any axis, the same rule as
//! `sampleVolumeAt` and scipy `map_coordinates(order=1, mode='constant', cval=nan)`. A label volume
//! reads its nearest voxel, because a value between two ids is not a label (§7.3's display rule).

use tvx_core::{Error, Result};

use crate::payload::inverse_affine;
use crate::tensor::{basis_rotation, TensorBasis};
use crate::{Volume, VolumeData};

pub struct VolumeSampler<'a> {
    v: &'a Volume,
    inv: [[f64; 4]; 4],
    per: usize,
    /// A vector's components to world; `None` when they already are.
    rot: Option<[[f64; 3]; 3]>,
}

impl<'a> VolumeSampler<'a> {
    pub fn new(v: &'a Volume) -> Result<Self> {
        Self::with_basis(v, TensorBasis::World)
    }

    /// `basis` is the frame a 3-frame volume's components are stored in.
    pub fn with_basis(v: &'a Volume, basis: TensorBasis) -> Result<Self> {
        if v.datatype.is_color() {
            return Err(Error::Unsupported(
                "sampling an RGB volume, which has no scalar value".into(),
            ));
        }
        let inv = inverse_affine(&v.affine)
            .ok_or_else(|| Error::Parse("this volume's affine is singular".into()))?;
        let rot = match basis {
            TensorBasis::World => None,
            other => Some(basis_rotation(&v.affine, other)?),
        };
        Ok(Self {
            v,
            inv,
            per: v.dims[0] * v.dims[1] * v.dims[2],
            rot,
        })
    }

    #[inline]
    fn raw(&self, i: usize) -> f64 {
        match &self.v.data {
            VolumeData::U8(d) => f64::from(d[i]),
            VolumeData::I8(d) => f64::from(d[i]),
            VolumeData::U16(d) => f64::from(d[i]),
            VolumeData::I16(d) => f64::from(d[i]),
            VolumeData::U32(d) => f64::from(d[i]),
            VolumeData::I32(d) => f64::from(d[i]),
            VolumeData::F32(d) => f64::from(d[i]),
            VolumeData::F64(d) => d[i],
            VolumeData::Rgb24(_) | VolumeData::Rgba32(_) => f64::NAN,
        }
    }

    #[inline]
    fn voxel(&self, w: [f32; 3]) -> Option<[f64; 3]> {
        let w = w.map(f64::from);
        let mut ijk = [0.0; 3];
        for (r, slot) in ijk.iter_mut().enumerate() {
            let m = self.inv[r];
            let c = m[0] * w[0] + m[1] * w[1] + m[2] * w[2] + m[3];
            if !(c >= 0.0 && c <= (self.v.dims[r] - 1) as f64) {
                return None;
            }
            *slot = c;
        }
        Some(ijk)
    }

    fn interp(&self, frame: usize, c: [f64; 3]) -> f32 {
        let [nx, ny, nz] = self.v.dims;
        let base = frame * self.per;
        let (i, j, k) = (c[0] as usize, c[1] as usize, c[2] as usize);
        let (fx, fy, fz) = (c[0] - i as f64, c[1] - j as f64, c[2] - k as f64);
        let (i1, j1, k1) = (
            (i + 1).min(nx - 1),
            (j + 1).min(ny - 1),
            (k + 1).min(nz - 1),
        );
        let at = |a: usize, b: usize, d: usize| self.raw(base + a + nx * (b + ny * d));
        let lerp = |p: f64, q: f64, t: f64| p * (1.0 - t) + q * t;
        let x00 = lerp(at(i, j, k), at(i1, j, k), fx);
        let x10 = lerp(at(i, j1, k), at(i1, j1, k), fx);
        let x01 = lerp(at(i, j, k1), at(i1, j, k1), fx);
        let x11 = lerp(at(i, j1, k1), at(i1, j1, k1), fx);
        let raw = lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
        (raw * f64::from(self.v.scl_slope) + f64::from(self.v.scl_inter)) as f32
    }

    /// Physical value of `frame`, or NaN outside.
    pub fn scalar(&self, frame: usize, world: [f32; 3]) -> f32 {
        let Some(c) = self.voxel(world) else {
            return f32::NAN;
        };
        if !self.v.is_label {
            return self.interp(frame, c);
        }
        let [nx, ny, _] = self.v.dims;
        let [i, j, k] = c.map(|x| x.round() as usize);
        let raw = self.raw(frame * self.per + i + nx * (j + ny * k));
        (raw * f64::from(self.v.scl_slope) + f64::from(self.v.scl_inter)) as f32
    }

    /// Frames 0, 1, 2 as a vector, or `None` outside. Each component interpolates separately.
    pub fn vector(&self, world: [f32; 3]) -> Option<[f32; 3]> {
        let c = self.voxel(world)?;
        let v = [self.interp(0, c), self.interp(1, c), self.interp(2, c)];
        let Some(rot) = &self.rot else {
            return Some(v);
        };
        let d = v.map(f64::from);
        let mut out = [0.0f32; 3];
        for (r, o) in out.iter_mut().enumerate() {
            *o = (rot[r][0] * d[0] + rot[r][1] * d[1] + rot[r][2] * d[2]) as f32;
        }
        Some(out)
    }
}
