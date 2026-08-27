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
