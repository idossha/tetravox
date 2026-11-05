//! Exact point-in-tet for sampling along many points (§6.3.1). [`crate::PointLocator`] buckets by
//! centroid with cells as large as the largest tet, which is right for one probe and far too slow for
//! millions; this grid buckets by AABB overlap with small cells, and is only built when asked for.

use tvx_mesh_io::Mesh;

const MAX_CELLS: u64 = 8_000_000;

pub struct TetSampler {
    origin: [f32; 3],
    cell: f32,
    dims: [u32; 3],
    starts: Vec<u32>,
    items: Vec<u32>,
}

#[derive(Clone, Copy, Debug)]
pub struct TetHit {
    /// Internal Morton-ordered tet index.
    pub tet: u32,
    pub weights: [f32; 4],
}

impl TetSampler {
    pub fn new(mesh: &Mesh) -> Self {
        let bb = mesh.bounds;
        let ext = [0, 1, 2].map(|c| (bb.max[c] - bb.min[c]).max(1e-3));
        let n = mesh.tets.len().max(1) as f64;
        let volume = f64::from(ext[0]) * f64::from(ext[1]) * f64::from(ext[2]);
        let mut cell = ((volume / n).cbrt() * 2.0) as f32;
        let mut dims;
        loop {
            dims = ext.map(|e| ((e / cell).ceil() as u32).max(1));
            if u64::from(dims[0]) * u64::from(dims[1]) * u64::from(dims[2]) <= MAX_CELLS {
                break;
            }
            cell *= 1.5;
        }
        let total = dims[0] as usize * dims[1] as usize * dims[2] as usize;
        let clamp = |v: f32, c: usize, d: u32| -> u32 {
            let q = ((v - bb.min[c]) / cell).floor();
            if q <= 0.0 {
                0
            } else {
                (q as u32).min(d - 1)
            }
        };
        let each = |t: &[u32; 4], f: &mut dyn FnMut(usize)| {
            let mut mn = [f32::INFINITY; 3];
            let mut mx = [f32::NEG_INFINITY; 3];
            for &v in t {
                let p = mesh.nodes[v as usize];
                for c in 0..3 {
                    mn[c] = mn[c].min(p[c]);
                    mx[c] = mx[c].max(p[c]);
                }
            }
            let (x0, x1) = (clamp(mn[0], 0, dims[0]), clamp(mx[0], 0, dims[0]));
            let (y0, y1) = (clamp(mn[1], 1, dims[1]), clamp(mx[1], 1, dims[1]));
            let (z0, z1) = (clamp(mn[2], 2, dims[2]), clamp(mx[2], 2, dims[2]));
            for z in z0..=z1 {
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        f(
                            (z as usize * dims[1] as usize + y as usize) * dims[0] as usize
                                + x as usize,
                        );
                    }
                }
            }
        };
        let mut starts = vec![0u32; total + 1];
        for t in &mesh.tets {
            each(t, &mut |c| starts[c + 1] += 1);
        }
        for i in 0..total {
            starts[i + 1] += starts[i];
        }
        let mut items = vec![0u32; starts[total] as usize];
        let mut cursor = starts.clone();
        for (j, t) in mesh.tets.iter().enumerate() {
            each(t, &mut |c| {
                items[cursor[c] as usize] = j as u32;
                cursor[c] += 1;
            });
        }
        Self {
            origin: bb.min,
            cell,
            dims,
            starts,
            items,
        }
    }

    /// `hint` is the previous hit: along a streamline the next point is usually in the same tet.
    pub fn locate(&self, mesh: &Mesh, p: [f32; 3], hint: &mut Option<u32>) -> Option<TetHit> {
        if !(p[0].is_finite() && p[1].is_finite() && p[2].is_finite()) {
            return None;
        }
        if let Some(t) = *hint {
            if let Some(weights) = weights(mesh, t, p) {
                return Some(TetHit { tet: t, weights });
            }
        }
        let mut ix = [0usize; 3];
        for c in 0..3 {
            let q = ((p[c] - self.origin[c]) / self.cell).floor();
            if q < 0.0 || q >= self.dims[c] as f32 {
                // The last cell's far face belongs to it.
                if q == self.dims[c] as f32
                    && p[c] <= self.origin[c] + self.cell * self.dims[c] as f32
                {
                    ix[c] = self.dims[c] as usize - 1;
                    continue;
                }
                return None;
            }
            ix[c] = q as usize;
        }
        let ci = (ix[2] * self.dims[1] as usize + ix[1]) * self.dims[0] as usize + ix[0];
        let (a, b) = (self.starts[ci] as usize, self.starts[ci + 1] as usize);
        for &t in &self.items[a..b] {
            if let Some(weights) = weights(mesh, t, p) {
                *hint = Some(t);
                return Some(TetHit { tet: t, weights });
            }
        }
        None
    }
}

/// Barycentric weights in f64, `None` unless `p` is inside. The f32 form is dominated by cancellation
/// on a sliver (see `locator.rs`), and these answers are read as data.
#[inline]
fn weights(mesh: &Mesh, t: u32, p: [f32; 3]) -> Option<[f32; 4]> {
    const EPS: f64 = -1e-9;
    let tet = mesh.tets[t as usize];
    let q = |i: usize| mesh.nodes[tet[i] as usize].map(f64::from);
    let (a, b, c, d) = (q(0), q(1), q(2), q(3));
    let p = p.map(f64::from);
    let sub = |x: [f64; 3], y: [f64; 3]| [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    let det = |u: [f64; 3], v: [f64; 3], w: [f64; 3]| {
        u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0])
            + u[2] * (v[0] * w[1] - v[1] * w[0])
    };
    let (ab, ac, ad, ap) = (sub(b, a), sub(c, a), sub(d, a), sub(p, a));
    let vol = det(ab, ac, ad);
    if vol == 0.0 {
        return None;
    }
    let w1 = det(ap, ac, ad) / vol;
    let w2 = det(ab, ap, ad) / vol;
    let w3 = det(ab, ac, ap) / vol;
    let w0 = 1.0 - w1 - w2 - w3;
    if w0 < EPS || w1 < EPS || w2 < EPS || w3 < EPS {
        return None;
    }
    Some([w0 as f32, w1 as f32, w2 as f32, w3 as f32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tvx_core::Aabb;

    /// Six tets filling a cube, plus a far outlier so cells are much smaller than the bounds.
    fn cube() -> Mesh {
        let v = |x: f32, y: f32, z: f32| [x, y, z];
        let nodes = vec![
            v(0., 0., 0.),
            v(1., 0., 0.),
            v(0., 1., 0.),
            v(1., 1., 0.),
            v(0., 0., 1.),
            v(1., 0., 1.),
            v(0., 1., 1.),
            v(1., 1., 1.),
        ];
        let tets = vec![
            [0, 1, 3, 7],
            [0, 1, 7, 5],
            [0, 5, 7, 4],
            [0, 3, 2, 7],
            [0, 2, 6, 7],
            [0, 6, 4, 7],
        ];
        Mesh {
            nodes,
            tris: vec![],
            tri_tags: vec![],
            tet_tags: vec![1; tets.len()],
            tets,
            tri_edge_mask: None,
            node_fields: vec![],
            elm_fields: vec![],
            gmsh_field_order: vec![],
            physical_names: vec![],
            gmsh_node_numbers: None,
            gmsh_elm_numbers: None,
            tet_perm: (0..6).collect(),
            skipped: vec![],
            bounds: Aabb {
                min: [0.0; 3],
                max: [1.0; 3],
            },
            label_table: None,
        }
    }

    #[test]
    fn every_interior_point_lands_in_a_tet_whose_weights_rebuild_it() {
        let m = cube();
        let s = TetSampler::new(&m);
        let mut hint = None;
        for i in 0..=10 {
            for j in 0..=10 {
                for k in 0..=10 {
                    let p = [i as f32 / 10.0, j as f32 / 10.0, k as f32 / 10.0];
                    let h = s
                        .locate(&m, p, &mut hint)
                        .unwrap_or_else(|| panic!("{p:?} missed"));
                    let t = m.tets[h.tet as usize];
                    for c in 0..3 {
                        let r: f32 = (0..4)
                            .map(|n| h.weights[n] * m.nodes[t[n] as usize][c])
                            .sum();
                        assert!((r - p[c]).abs() < 1e-5, "{p:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_stale_hint_never_answers_for_a_point_outside_it() {
        let m = cube();
        let s = TetSampler::new(&m);
        let mut hint = None;
        assert!(s.locate(&m, [0.9, 0.1, 0.1], &mut hint).is_some());
        let first = hint;
        let far = s.locate(&m, [0.1, 0.9, 0.9], &mut hint).unwrap();
        assert_ne!(Some(far.tet), first);
        assert!(s.locate(&m, [1.5, 0.5, 0.5], &mut hint).is_none());
        assert!(s.locate(&m, [f32::NAN, 0.5, 0.5], &mut hint).is_none());
    }
}
