//! `build_point_locator` and `locate_point` (§6.3).
//!
//! The grid buckets tets by **centroid**, one `u32` per tet and nothing more — 52 MB on
//! `ernie_seeg.msh`, against §9.2's 1.0 GB load-path bar. Bucketing by AABB overlap instead would
//! multiply that by the average number of cells a tet touches.
//!
//! Correctness with centroid bucketing needs one invariant: **the cell must be at least as large as
//! the largest tet's extent on each axis.** Then for any point `p` inside tet `T`, the centroid of
//! `T` is within one cell of `p` on every axis, so scanning the 3x3x3 neighbourhood is exhaustive —
//! no "expand the radius until something is found" loop, and no missed hit.
//!
//! That invariant makes the cells **large**: `ernie.msh`'s biggest tet spans tens of millimetres, so
//! a 3x3x3 neighbourhood sweeps a ~100 mm box and a candidate can be a long way from `p`. Candidates
//! are therefore rejected by their **AABB first**, before any barycentric arithmetic — see
//! [`locate_point`]. That is not an optimisation: an f32 barycentric test on a *sliver* tet
//! (`ernie.msh` has tets with 6·V ≈ 1e-8 mm³) is dominated by cancellation, and for a point 60 mm
//! away it can return four positive weights and claim a hit. Measured on `ernie.msh` 2026-08-27: 2 of
//! 48 sampled tet centroids located into a scalp sliver at (49.3, 16.2, −71.9) instead of into the
//! tet they are the centroid of. The AABB test is exact — a point inside a tet is inside its AABB —
//! so it can only remove wrong answers, never a right one.

use crate::util::{barycentric, tet_gmsh_number};
use crate::{PointLocator, ProbeHit};
use tvx_mesh_io::Mesh;

/// Cap on the grid so `starts` stays small on a 13 M-tet mesh.
const MAX_CELLS: u64 = 4_000_000;

pub fn build_point_locator(mesh: &Mesh) -> PointLocator {
    let n = mesh.tets.len();
    let bb = mesh.bounds;
    let ext = [
        (bb.max[0] - bb.min[0]).max(0.0),
        (bb.max[1] - bb.min[1]).max(0.0),
        (bb.max[2] - bb.min[2]).max(0.0),
    ];

    // The largest tet extent per axis — the floor on cell size that makes 3x3x3 exhaustive.
    let mut need = [0.0f32; 3];
    for tet in &mesh.tets {
        let mut mn = [f32::INFINITY; 3];
        let mut mx = [f32::NEG_INFINITY; 3];
        for &v in tet {
            let p = mesh.nodes[v as usize];
            for c in 0..3 {
                if p[c] < mn[c] {
                    mn[c] = p[c];
                }
                if p[c] > mx[c] {
                    mx[c] = p[c];
                }
            }
        }
        for c in 0..3 {
            let e = mx[c] - mn[c];
            if e > need[c] {
                need[c] = e;
            }
        }
    }

    // Aim for roughly one tet per cell, then coarsen until the floor and the cell cap are met.
    let mut dims = [1u32; 3];
    for c in 0..3 {
        if ext[c] <= 0.0 || need[c] <= 0.0 {
            dims[c] = 1;
            continue;
        }
        let by_size = (ext[c] / need[c]).floor().max(1.0);
        let by_count = (n as f32).cbrt().ceil().max(1.0);
        dims[c] = by_size.min(by_count).max(1.0) as u32;
    }
    while u64::from(dims[0]) * u64::from(dims[1]) * u64::from(dims[2]) > MAX_CELLS {
        let k = (0..3).max_by_key(|&i| dims[i]).expect("three axes");
        dims[k] = (dims[k] / 2).max(1);
    }
    let cell = [
        if dims[0] > 0 && ext[0] > 0.0 {
            ext[0] / dims[0] as f32
        } else {
            1.0
        },
        if dims[1] > 0 && ext[1] > 0.0 {
            ext[1] / dims[1] as f32
        } else {
            1.0
        },
        if dims[2] > 0 && ext[2] > 0.0 {
            ext[2] / dims[2] as f32
        } else {
            1.0
        },
    ];
    let origin = bb.min;

    let ncells = (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize);
    let index_of = |p: [f32; 3]| -> usize {
        let mut ix = [0usize; 3];
        for c in 0..3 {
            let q = ((p[c] - origin[c]) / cell[c]).floor();
            ix[c] = if q <= 0.0 {
                0
            } else if q >= (dims[c] - 1) as f32 {
                (dims[c] - 1) as usize
            } else {
                q as usize
            };
        }
        (ix[2] * dims[1] as usize + ix[1]) * dims[0] as usize + ix[0]
    };

    let centroid = |t: &[u32; 4]| -> [f32; 3] {
        let mut c = [0.0f32; 3];
        for &v in t {
            let p = mesh.nodes[v as usize];
            c[0] += p[0];
            c[1] += p[1];
            c[2] += p[2];
        }
        [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25]
    };

    let mut starts = vec![0u32; ncells + 1];
    for tet in &mesh.tets {
        starts[index_of(centroid(tet)) + 1] += 1;
    }
    for i in 0..ncells {
        starts[i + 1] += starts[i];
    }
    let mut items = vec![0u32; n];
    {
        let mut cur = starts.clone();
        for (j, tet) in mesh.tets.iter().enumerate() {
            let c = index_of(centroid(tet));
            items[cur[c] as usize] = j as u32;
            cur[c] += 1;
        }
    }
    PointLocator {
        cell,
        dims,
        origin,
        starts,
        items,
    }
}

/// One round trip: the tag and every node/element field value at `p` (§6.3).
///
/// Returns `None` when `p` is in no tet — which the app draws as "outside the mesh", not as an
/// error.
pub fn locate_point(mesh: &Mesh, grid: &PointLocator, p: [f32; 3]) -> Option<ProbeHit> {
    if grid.items.is_empty() {
        return None;
    }
    // A generous slack on the barycentric test: a point exactly on a shared face must land in one
    // of the two tets rather than in neither.
    const EPS: f32 = -1e-5;

    let mut ix = [0i64; 3];
    for c in 0..3 {
        let q = ((p[c] - grid.origin[c]) / grid.cell[c]).floor();
        // Reject well outside the grid before touching a bucket.
        if q < -1.0 || q > f64::from(grid.dims[c]) as f32 {
            return None;
        }
        ix[c] = q as i64;
    }

    for dz in -1i64..=1 {
        for dy in -1i64..=1 {
            for dx in -1i64..=1 {
                let (x, y, z) = (ix[0] + dx, ix[1] + dy, ix[2] + dz);
                if x < 0
                    || y < 0
                    || z < 0
                    || x >= i64::from(grid.dims[0])
                    || y >= i64::from(grid.dims[1])
                    || z >= i64::from(grid.dims[2])
                {
                    continue;
                }
                let ci = (z as usize * grid.dims[1] as usize + y as usize) * grid.dims[0] as usize
                    + x as usize;
                let (a, b) = (grid.starts[ci] as usize, grid.starts[ci + 1] as usize);
                for &j in &grid.items[a..b] {
                    let tet = mesh.tets[j as usize];
                    if !aabb_contains(mesh, &tet, p) {
                        continue;
                    }
                    let Some(w) = barycentric(
                        mesh.nodes[tet[0] as usize],
                        mesh.nodes[tet[1] as usize],
                        mesh.nodes[tet[2] as usize],
                        mesh.nodes[tet[3] as usize],
                        p,
                    ) else {
                        continue;
                    };
                    if w.iter().any(|&x| x < EPS) {
                        continue;
                    }
                    return Some(probe(mesh, j as usize, &tet, &w));
                }
            }
        }
    }
    None
}

/// Is `p` inside this tet's axis-aligned bounding box?
///
/// The gate in front of [`barycentric`], and the reason is correctness rather than speed (see the
/// module header). The box is grown by a relative slack on each axis so that it keeps the same
/// "a point exactly on a shared face lands in one of the two tets" behaviour the barycentric `EPS`
/// provides; the slack is proportional to the tet's own extent, so it is meaningless for a sliver
/// and generous for a large tet — which is exactly the right way round.
fn aabb_contains(mesh: &Mesh, tet: &[u32; 4], p: [f32; 3]) -> bool {
    const SLACK: f32 = 1e-5;
    let mut mn = [f32::INFINITY; 3];
    let mut mx = [f32::NEG_INFINITY; 3];
    for &v in tet {
        let q = mesh.nodes[v as usize];
        for c in 0..3 {
            if q[c] < mn[c] {
                mn[c] = q[c];
            }
            if q[c] > mx[c] {
                mx[c] = q[c];
            }
        }
    }
    (0..3).all(|c| {
        let s = (mx[c] - mn[c]) * SLACK;
        p[c] >= mn[c] - s && p[c] <= mx[c] + s
    })
}

fn probe(mesh: &Mesh, j: usize, tet: &[u32; 4], w: &[f32; 4]) -> ProbeHit {
    let node_values = mesh
        .node_fields
        .iter()
        .map(|f| {
            let mut v = vec![0.0f32; f.ncomp];
            for (k, &nd) in tet.iter().enumerate() {
                let base = nd as usize * f.ncomp;
                for (c, vc) in v.iter_mut().enumerate() {
                    *vc += w[k] * f.data[base + c];
                }
            }
            (f.name.clone(), v)
        })
        .collect();
    let elm_values = mesh
        .elm_fields
        .iter()
        .map(|f| {
            let base = j * f.ncomp;
            let v = f
                .tet
                .get(base..base + f.ncomp)
                .map(<[f32]>::to_vec)
                .unwrap_or_else(|| vec![f32::NAN; f.ncomp]);
            (f.name.clone(), v)
        })
        .collect();
    ProbeHit {
        gmsh_elm: tet_gmsh_number(mesh, j),
        tet_index: j as u32,
        tag: mesh.tet_tags[j],
        node_values,
        elm_values,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tvx_core::Aabb;

    /// A two-tet mesh: a real `ernie.msh` **sliver** first, then a large tet around the origin.
    ///
    /// The sliver's four node coordinates are copied out of `m2m_ernie/ernie.msh` (internal tet
    /// 608,797, tag 5, 6·V = 2.5e-7 mm³), because the failure this pins is a property of *those*
    /// f32 coordinates: `barycentric` evaluated at a point 60 mm away returns
    /// `[1019.5, 601.5, 5476.4, 2885.1]` — four positive weights, i.e. "inside" — purely from
    /// cancellation. It is first in the list, so a scan with no AABB gate answers with it.
    fn sliver_then_body() -> Mesh {
        Mesh {
            nodes: vec![
                [49.262543, 16.184732, -71.94772],
                [49.262543, 16.184904, -71.940796],
                [49.255653, 16.181803, -71.94242],
                [49.262543, 16.179636, -71.94378],
                [-40.0, -40.0, -40.0],
                [60.0, -40.0, -40.0],
                [-40.0, 60.0, -40.0],
                [-40.0, -40.0, 60.0],
            ],
            tris: Vec::new(),
            tri_tags: Vec::new(),
            tets: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
            tet_tags: vec![5, 2],
            tri_edge_mask: None,
            node_fields: Vec::new(),
            elm_fields: Vec::new(),
            physical_names: Vec::new(),
            gmsh_node_numbers: None,
            gmsh_elm_numbers: None,
            tet_perm: Vec::new(),
            skipped: Vec::new(),
            bounds: Aabb {
                min: [-40.0, -40.0, -40.0],
                max: [60.0, 60.0, 60.0],
            },
            label_table: None,
        }
    }

    /// The regression: the probe point is the centroid of the *second* tet and 60 mm from the
    /// first, and it must locate into the second.
    #[test]
    fn a_far_sliver_never_wins_the_probe() {
        let m = sliver_then_body();
        let grid = build_point_locator(&m);
        let p = [11.533_48, -14.459_766, -27.362_804];

        // The sliver really does claim this point under a bare barycentric test — otherwise this
        // test would pass for the wrong reason.
        let t = m.tets[0];
        let w = barycentric(
            m.nodes[t[0] as usize],
            m.nodes[t[1] as usize],
            m.nodes[t[2] as usize],
            m.nodes[t[3] as usize],
            p,
        )
        .expect("non-degenerate enough to divide");
        assert!(
            w.iter().all(|&x| x > 0.0),
            "the f32 cancellation this guards against is gone: {w:?}"
        );
        assert!(!aabb_contains(&m, &t, p), "the AABB gate must reject it");

        let hit = locate_point(&m, &grid, p).expect("the body tet contains the point");
        assert_eq!(hit.tet_index, 1);
        assert_eq!(hit.tag, 2);
        assert_eq!(hit.gmsh_elm, 2);
    }

    /// The gate may only remove wrong answers: a point inside a tet is inside its AABB, and one on
    /// a face or a vertex still locates.
    #[test]
    fn the_aabb_gate_keeps_every_real_hit() {
        let m = sliver_then_body();
        let grid = build_point_locator(&m);
        // The body tet's slanted face is `x + y + z = -20`, so its interior is `x + y + z < -20`.
        for p in [
            [-10.0, -10.0, -10.0],
            [-39.0, -39.0, -39.0],
            [-40.0, -40.0, -40.0],         // a vertex
            [-10.0, -10.0, -40.0],         // on the z = -40 face
            [49.260_0, 16.183_0, -71.943], // inside the sliver itself
        ] {
            assert!(
                locate_point(&m, &grid, p).is_some(),
                "lost the hit at {p:?}"
            );
        }
        // …and a point outside every tet is still `None`, not a nearest-tet guess.
        assert!(locate_point(&m, &grid, [1000.0, 1000.0, 1000.0]).is_none());
        assert!(locate_point(&m, &grid, [59.0, 59.0, 59.0]).is_none());
    }
}
