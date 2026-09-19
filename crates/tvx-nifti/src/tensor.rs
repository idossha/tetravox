//! §6.1 / §7.3: opt-in six-component diffusion tensors; raw frames are never changed.
//! FSL: xx,xy,xz,yy,yz,zz in scaled voxel axes, with X flipped for positive determinant.
//! NIfTI SYMMATRIX: xx,xy,yy,xz,yz,zz. Component order does not specify a coordinate basis.

use crate::{Volume, VolumeData};
use tvx_core::{Error, Result};

#[derive(Clone, Copy, Debug)]
pub enum TensorOrder {
    Fsl,
    Nifti,
}
#[derive(Clone, Copy, Debug)]
pub enum TensorBasis {
    Fsl,
    Voxel,
    World,
}

/// Eight R32F slabs: symmetric inverse shape (xx,xy,xz,yy,yz,zz), packed RGB, FA.
pub struct TensorPayload {
    pub dims: [usize; 3],
    pub data: Vec<f32>,
}

fn sample(v: &Volume, i: usize) -> f64 {
    let x = match &v.data {
        VolumeData::U8(a) => a[i] as f64,
        VolumeData::I8(a) => a[i] as f64,
        VolumeData::U16(a) => a[i] as f64,
        VolumeData::I16(a) => a[i] as f64,
        VolumeData::U32(a) => a[i] as f64,
        VolumeData::I32(a) => a[i] as f64,
        VolumeData::F32(a) => a[i] as f64,
        VolumeData::F64(a) => a[i],
        _ => f64::NAN,
    };
    x * v.scl_slope as f64 + v.scl_inter as f64
}

// Fixed-size matrix indices express the Jacobi similarity transform directly.
#[allow(clippy::needless_range_loop)]
fn eigen(mut a: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut r = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    for _ in 0..16 {
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if a[p][q].abs() < 1e-15 {
                continue;
            }
            let angle = 0.5 * (2. * a[p][q]).atan2(a[q][q] - a[p][p]);
            let (s, c) = angle.sin_cos();
            let app = a[p][p];
            let aqq = a[q][q];
            let apq = a[p][q];
            a[p][p] = c * c * app - 2. * s * c * apq + s * s * aqq;
            a[q][q] = s * s * app + 2. * s * c * apq + c * c * aqq;
            a[p][q] = 0.;
            a[q][p] = 0.;
            for k in 0..3 {
                if k != p && k != q {
                    let x = a[k][p];
                    let y = a[k][q];
                    a[k][p] = c * x - s * y;
                    a[p][k] = a[k][p];
                    a[k][q] = s * x + c * y;
                    a[q][k] = a[k][q];
                }
                let x = r[k][p];
                let y = r[k][q];
                r[k][p] = c * x - s * y;
                r[k][q] = s * x + c * y;
            }
        }
    }
    ([a[0][0], a[1][1], a[2][2]], r)
}

/// Normalised inverse ellipsoid shape in world axes, plus direction colour and FA.
/// Non-finite, zero and non-positive-definite tensors have no glyph (all-zero payload).
#[allow(clippy::needless_range_loop)]
fn glyph(c: [f64; 6], rotation: [[f64; 3]; 3]) -> [f32; 8] {
    if c.iter().any(|v| !v.is_finite()) {
        return [0.; 8];
    }
    let scale = c.iter().fold(0_f64, |a, b| a.max(b.abs()));
    if scale == 0. {
        return [0.; 8];
    }
    let c = c.map(|v| v / scale);
    let (l, e) = eigen([[c[0], c[1], c[2]], [c[1], c[3], c[4]], [c[2], c[4], c[5]]]);
    if l.iter().any(|v| *v <= 0. || !v.is_finite()) {
        return [0.; 8];
    }
    let top = (0..3).max_by(|&a, &b| l[a].total_cmp(&l[b])).unwrap();
    let mean = l.iter().sum::<f64>() / 3.;
    let fa = (1.5 * l.iter().map(|v| (v - mean).powi(2)).sum::<f64>()
        / l.iter().map(|v| v * v).sum::<f64>())
    .sqrt()
    .clamp(0., 1.);
    let mut world = [[0.; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                world[i][j] += rotation[i][k] * e[k][j];
            }
        }
    }
    let mut q = [[0.; 3]; 3];
    // A display-only 2% minor-axis floor keeps near-singular glyphs numerically stable.
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                q[i][j] += world[i][k] * world[j][k] / (l[k] / l[top]).max(0.02).powi(2);
            }
        }
    }
    let rgb = std::array::from_fn::<_, 3, _>(|i| {
        if fa < 1e-6 {
            166_u32
        } else {
            (255. * world[i][top].abs()).round() as u32
        }
    });
    [
        q[0][0] as f32,
        q[0][1] as f32,
        q[0][2] as f32,
        q[1][1] as f32,
        q[1][2] as f32,
        q[2][2] as f32,
        (rgb[0] + 256 * rgb[1] + 65536 * rgb[2]) as f32,
        fa as f32,
    ]
}

/// §6.1: derive a bounded regular glyph grid in the dataset worker, never on the UI thread.
#[allow(clippy::needless_range_loop)]
pub fn tensor_payload(
    v: &Volume,
    order: TensorOrder,
    basis: TensorBasis,
    stride: usize,
    max_3d: usize,
) -> Result<TensorPayload> {
    if v.nvols != 6 || !matches!(v.data, VolumeData::F32(_) | VolumeData::F64(_)) {
        return Err(Error::Unsupported(
            "tensor display needs six floating-point component volumes".into(),
        ));
    }
    if ![1, 2, 4, 8].contains(&stride) {
        return Err(Error::Parse(
            "tensor spacing must be 1, 2, 4 or 8 voxels".into(),
        ));
    }
    let dims = v.dims.map(|n| n.div_ceil(stride));
    let n = dims.iter().product::<usize>();
    if dims[0] > max_3d || dims[1] > max_3d || dims[2] * 8 > max_3d || n > 128 * 1024 * 1024 / 32 {
        return Err(Error::Unsupported(
            "tensor glyph grid exceeds texture/memory limits; increase glyph spacing".into(),
        ));
    }
    let mut rotation = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    if !matches!(basis, TensorBasis::World) {
        for j in 0..3 {
            let length = (0..3).map(|i| v.affine[i][j].powi(2)).sum::<f64>().sqrt();
            if !length.is_finite() || length <= 0. {
                return Err(Error::Parse("tensor affine has a degenerate axis".into()));
            }
            for i in 0..3 {
                rotation[i][j] = v.affine[i][j] / length;
            }
        }
        // A sheared basis is not an orthonormal frame; reject rather than silently distort tensors.
        for i in 0..3 {
            for j in i + 1..3 {
                if (0..3)
                    .map(|k| rotation[k][i] * rotation[k][j])
                    .sum::<f64>()
                    .abs()
                    > 1e-4
                {
                    return Err(Error::Unsupported("tensor voxel axes are sheared; use a resampled image or world-basis tensors".into()));
                }
            }
        }
        let r = rotation;
        let det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
            - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
            + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
        if matches!(basis, TensorBasis::Fsl) && det > 0. {
            for row in &mut rotation {
                row[0] *= -1.;
            }
        }
    }
    let per = v.dims.iter().product::<usize>();
    let mut data = vec![0.; n * 8];
    for z in 0..dims[2] {
        for y in 0..dims[1] {
            for x in 0..dims[0] {
                let at = (z * stride * v.dims[1] + y * stride) * v.dims[0] + x * stride;
                let mut c = std::array::from_fn(|k| sample(v, at + k * per));
                if matches!(order, TensorOrder::Nifti) {
                    c.swap(2, 3);
                }
                let g = glyph(c, rotation);
                let i = (z * dims[1] + y) * dims[0] + x;
                for k in 0..8 {
                    data[i + k * n] = g[k];
                }
            }
        }
    }
    Ok(TensorPayload {
        dims: [dims[0], dims[1], dims[2] * 8],
        data,
    })
}
