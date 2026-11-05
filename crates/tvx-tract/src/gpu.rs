//! §7.4.1's draw buffers and §6.3.1's tangents.

use crate::Tractogram;

const RESTART: u32 = 0xFFFF_FFFF;
const MIN_QUANTUM: f32 = 0.01;

/// Unit tangents, central difference with one-sided ends; zero for a one-point streamline.
/// `out` is 3 per point for the points `first..first + out.len() / 3`.
pub fn tangents_into(positions: &[f32], offsets: &[u32], first: usize, out: &mut [f32]) {
    let count = out.len() / 3;
    if count == 0 {
        return;
    }
    let mut s = offsets
        .partition_point(|o| (*o as usize) <= first)
        .saturating_sub(1);
    for n in 0..count {
        let i = first + n;
        while (offsets[s + 1] as usize) <= i {
            s += 1;
        }
        let (a, b) = (offsets[s] as usize, offsets[s + 1] as usize);
        let lo = i.saturating_sub(1).max(a);
        let hi = (i + 1).min(b - 1);
        let mut d = [0.0f64; 3];
        for c in 0..3 {
            d[c] = f64::from(positions[hi * 3 + c]) - f64::from(positions[lo * 3 + c]);
        }
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        for c in 0..3 {
            out[n * 3 + c] = if len > 0.0 { (d[c] / len) as f32 } else { 0.0 };
        }
    }
}

pub struct GpuGeometry {
    /// 8/point: `i16 × 3` position, `i8 × 2` octahedral tangent, little-endian.
    pub vertices: Vec<u8>,
    pub streamline_ids: Vec<u32>,
    pub indices: Vec<u32>,
    pub origin: [f32; 3],
    pub quantum: f32,
}

fn octahedral(t: [f32; 3]) -> [i8; 2] {
    let sum = t[0].abs() + t[1].abs() + t[2].abs();
    if sum == 0.0 {
        return [0, 0];
    }
    let (mut x, mut y) = (t[0] / sum, t[1] / sum);
    if t[2] < 0.0 {
        let (ox, oy) = (x, y);
        x = (1.0 - oy.abs()) * ox.signum();
        y = (1.0 - ox.abs()) * oy.signum();
    }
    [(x * 127.0).round() as i8, (y * 127.0).round() as i8]
}

pub fn gpu_geometry(t: &Tractogram) -> GpuGeometry {
    let (mn, mx) = (t.bounds.min, t.bounds.max);
    let origin = [
        (mn[0] + mx[0]) * 0.5,
        (mn[1] + mx[1]) * 0.5,
        (mn[2] + mx[2]) * 0.5,
    ];
    let extent = (0..3).map(|c| mx[c] - mn[c]).fold(0.0f32, f32::max);
    let quantum = MIN_QUANTUM.max(extent / 65534.0);

    let n = t.n_points();
    let mut tangents = vec![0.0f32; n * 3];
    tangents_into(&t.positions, &t.offsets, 0, &mut tangents);
    let mut vertices = Vec::with_capacity(n * 8);
    for (p, d) in t.positions.chunks_exact(3).zip(tangents.chunks_exact(3)) {
        for c in 0..3 {
            let q = ((p[c] - origin[c]) / quantum).round() as i16;
            vertices.extend_from_slice(&q.to_le_bytes());
        }
        let o = octahedral([d[0], d[1], d[2]]);
        vertices.push(o[0] as u8);
        vertices.push(o[1] as u8);
    }
    let s = t.n_streamlines();
    let mut streamline_ids = Vec::with_capacity(n);
    let mut indices = Vec::with_capacity(n + s);
    for (id, w) in t.offsets.windows(2).enumerate() {
        for i in w[0]..w[1] {
            streamline_ids.push(id as u32);
            indices.push(i);
        }
        indices.push(RESTART);
    }
    GpuGeometry {
        vertices,
        streamline_ids,
        indices,
        origin,
        quantum,
    }
}
