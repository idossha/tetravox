//! `marching_tets` and `marching_cubes` (§6.3).
//!
//! Both go through **one** simplex kernel. A cube is cut into six tets around its main diagonal
//! (the Freudenthal decomposition, `0-7`), which every neighbouring cell agrees on, so the result
//! is watertight without a 256-entry case table — and without the risk of one wrong row in one.
//! It costs more triangles than a tuned marching-cubes table; §6.3 asks for a correct surface, and
//! the isosurface *layer* is Phase 2's, so that is the trade taken here (see `docs/DECISIONS.md`).

use crate::util::{bounds_of, cross, dot, normalize, sub, tet_gmsh_number};
use crate::{OrientReport, SurfaceBuffers, SurfaceVariant, TagRange};
use tvx_core::{BitMask, Error, Phase, ProgressSink, Result};
use tvx_mesh_io::Mesh;
use tvx_nifti::Volume;

/// The six tets of the Freudenthal decomposition of a cube, as corner ordinals
/// `n = i + 2j + 4k`. All six share the `0-7` diagonal.
const CUBE_TETS: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

/// One tet's contribution to an isosurface: 0, 1 or 2 triangles.
///
/// `v` are the corner positions, `d` the corner values **minus** the isovalue, and `id` a stable
/// identity per corner used to weld vertices when the caller asks for a smooth surface. Emits into
/// `out` as `(position, weld key)` triples.
fn slice_tet(v: [[f32; 3]; 4], d: [f32; 4], id: [u64; 4], out: &mut Vec<([f32; 3], u64)>) -> usize {
    let mut pos = [0usize; 4];
    let mut neg = [0usize; 4];
    let (mut np, mut nn) = (0usize, 0usize);
    for (k, &dk) in d.iter().enumerate() {
        if dk >= 0.0 {
            pos[np] = k;
            np += 1;
        } else {
            neg[nn] = k;
            nn += 1;
        }
    }
    if np == 0 || np == 4 {
        return 0;
    }
    let point = |a: usize, b: usize| -> ([f32; 3], u64) {
        let t = d[a] / (d[a] - d[b]);
        let p = [
            v[a][0] + (v[b][0] - v[a][0]) * t,
            v[a][1] + (v[b][1] - v[a][1]) * t,
            v[a][2] + (v[b][2] - v[a][2]) * t,
        ];
        // The weld key is the *edge*, so two tets sharing it produce the same key regardless of
        // which end they walked from.
        let (lo, hi) = if id[a] <= id[b] {
            (id[a], id[b])
        } else {
            (id[b], id[a])
        };
        (p, lo.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(hi))
    };

    let mut poly: Vec<([f32; 3], u64)> = Vec::with_capacity(4);
    if np == 1 {
        let a = pos[0];
        poly.push(point(a, neg[0]));
        poly.push(point(a, neg[1]));
        poly.push(point(a, neg[2]));
    } else if nn == 1 {
        let b = neg[0];
        poly.push(point(pos[0], b));
        poly.push(point(pos[1], b));
        poly.push(point(pos[2], b));
    } else {
        let (a, bb) = (pos[0], pos[1]);
        let (c, dd) = (neg[0], neg[1]);
        poly.push(point(a, c));
        poly.push(point(a, dd));
        poly.push(point(bb, dd));
        poly.push(point(bb, c));
    }

    // Wind so the normal points away from the >= iso side: the surface faces "outward" from the
    // solid, which is what a headlight shader expects.
    let inside = {
        let mut c = [0.0f32; 3];
        for k in 0..np {
            for a in 0..3 {
                c[a] += v[pos[k]][a];
            }
        }
        [c[0] / np as f32, c[1] / np as f32, c[2] / np as f32]
    };
    let n = cross(sub(poly[1].0, poly[0].0), sub(poly[2].0, poly[0].0));
    if dot(n, sub(inside, poly[0].0)) > 0.0 {
        poly.reverse();
    }

    let ntri = poly.len() - 2;
    for i in 1..poly.len() - 1 {
        out.push(poly[0]);
        out.push(poly[i]);
        out.push(poly[i + 1]);
    }
    ntri
}

/// Turn a raw triangle soup into [`SurfaceBuffers`], welding vertices when `smooth`.
fn build(
    soup: Vec<([f32; 3], u64)>,
    owner_elm: Vec<u32>,
    face_tag: Vec<i32>,
    smooth: bool,
) -> SurfaceBuffers {
    let ntri = owner_elm.len();
    let per_tag = if ntri == 0 {
        Vec::new()
    } else {
        // Marching output is single-tag by construction (one isovalue), so one range covers it.
        vec![TagRange {
            tag: face_tag.first().copied().unwrap_or(0),
            first: 0,
            count: (ntri * 3) as u32,
        }]
    };
    let bounds = bounds_of(&soup.iter().map(|s| s.0).collect::<Vec<_>>());

    if !smooth {
        let mut positions = Vec::with_capacity(soup.len() * 3);
        for (p, _) in &soup {
            positions.extend_from_slice(p);
        }
        let mut normals = vec![0.0f32; positions.len()];
        for t in 0..ntri {
            let g = |k: usize| soup[t * 3 + k].0;
            let n = normalize(cross(sub(g(1), g(0)), sub(g(2), g(0))));
            for k in 0..3 {
                normals[(t * 3 + k) * 3..(t * 3 + k) * 3 + 3].copy_from_slice(&n);
            }
        }
        return SurfaceBuffers {
            variant: SurfaceVariant::Deindexed,
            positions,
            normals,
            indices: None,
            node_index: None,
            corner: Some((0..ntri).flat_map(|_| [0u8, 1, 2]).collect()),
            owner_elm,
            face_tag,
            edge_mask: None,
            per_tag,
            orient: OrientReport::default(),
            bounds,
        };
    }

    // Weld on the edge key. Sorting rather than hashing keeps the output independent of any map's
    // iteration order (§6.3's determinism rule).
    let mut keys: Vec<u64> = soup.iter().map(|s| s.1).collect();
    keys.sort_unstable();
    keys.dedup();
    let mut positions = vec![0.0f32; keys.len() * 3];
    let mut indices = Vec::with_capacity(soup.len());
    for (p, k) in &soup {
        let i = keys.binary_search(k).expect("key present");
        positions[i * 3..i * 3 + 3].copy_from_slice(p);
        indices.push(i as u32);
    }
    let mut normals = vec![0.0f32; keys.len() * 3];
    for tri in indices.chunks_exact(3) {
        let g = |k: usize| {
            let b = tri[k] as usize * 3;
            [positions[b], positions[b + 1], positions[b + 2]]
        };
        let n = cross(sub(g(1), g(0)), sub(g(2), g(0)));
        for &k in tri {
            let o = k as usize * 3;
            normals[o] += n[0];
            normals[o + 1] += n[1];
            normals[o + 2] += n[2];
        }
    }
    for i in 0..keys.len() {
        let n = normalize([normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]]);
        normals[i * 3..i * 3 + 3].copy_from_slice(&n);
    }
    SurfaceBuffers {
        variant: SurfaceVariant::Indexed,
        positions,
        normals,
        indices: Some(indices),
        // Welded isosurface vertices sit on edges, not on mesh nodes, so there is no internal node
        // row to point at.
        node_index: None,
        corner: None,
        owner_elm,
        face_tag,
        edge_mask: None,
        per_tag,
        orient: OrientReport::default(),
        bounds,
    }
}

/// Isosurface of a node field over the (optionally masked) tets (§6.3).
pub fn marching_tets(
    mesh: &Mesh,
    node_field: &[f32],
    iso: f32,
    mask: Option<&BitMask>,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    if node_field.len() < mesh.nodes.len() {
        return Err(Error::Parse(format!(
            "marching_tets: node_field has {} values, need {}",
            node_field.len(),
            mesh.nodes.len()
        )));
    }
    let n = mesh.tets.len();
    p.report(Phase::Topology, 0, n as u64);
    let mut soup = Vec::new();
    let mut owner = Vec::new();
    let mut tag = Vec::new();
    for (j, tet) in mesh.tets.iter().enumerate() {
        if mask.is_some_and(|m| !m.get(j)) {
            continue;
        }
        if j % 1_000_000 == 0 && p.aborted() {
            return Err(Error::Cancelled);
        }
        let v = [
            mesh.nodes[tet[0] as usize],
            mesh.nodes[tet[1] as usize],
            mesh.nodes[tet[2] as usize],
            mesh.nodes[tet[3] as usize],
        ];
        let d = [
            node_field[tet[0] as usize] - iso,
            node_field[tet[1] as usize] - iso,
            node_field[tet[2] as usize] - iso,
            node_field[tet[3] as usize] - iso,
        ];
        if d.iter().any(|x| !x.is_finite()) {
            continue;
        }
        let id = [
            u64::from(tet[0]),
            u64::from(tet[1]),
            u64::from(tet[2]),
            u64::from(tet[3]),
        ];
        let added = slice_tet(v, d, id, &mut soup);
        for _ in 0..added {
            owner.push(tet_gmsh_number(mesh, j));
            tag.push(mesh.tet_tags[j]);
        }
    }
    p.report(Phase::Topology, n as u64, n as u64);
    // Deindexed: §6.3 gives `marching_tets` no `smooth` flag, and face normals are the honest
    // reading of an isosurface through a piecewise-linear field.
    Ok(build(soup, owner, tag, false))
}

/// Isosurface of one frame of a volume (§6.3).
pub fn marching_cubes(
    vol: &Volume,
    vol_index: usize,
    iso: f32,
    smooth: bool,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    marching_cubes_inner(vol, vol_index, iso, smooth, None, p)
}

/// The surface of **one label** of a label volume (§6.3, added 2026-08-28 for §4.4's `iso3d`).
///
/// A label volume's samples are ids, not a field, so the level set `value >= k - 0.5` is the union
/// of every label `>= k` — nothing like region `k` unless the ids happen to nest, which they do not
/// (`final_tissues` is 1 WM, 2 GM, 3 CSF, 5 scalp, 7 compact bone … `[DATA]`). Isolating a region
/// therefore has to happen **at the sample**: the volume is read through
/// `value == label ? 1 : 0` and marched at `0.5`, which is the region's own boundary and nothing
/// else's.
///
/// A separate function rather than an argument on [`marching_cubes`], because §6's signatures are
/// frozen and this is additive. `label` is compared in **physical** units (post `scl_slope` /
/// `scl_inter`, like every other sample this module reads) with a half-unit tolerance, so an id
/// that survives a float round trip — `labeling.nii.gz` is a float32 label volume `[DATA]` — still
/// matches exactly one id.
pub fn marching_cubes_label(
    vol: &Volume,
    vol_index: usize,
    label: f32,
    smooth: bool,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    marching_cubes_inner(vol, vol_index, 0.5, smooth, Some(label), p)
}

fn marching_cubes_inner(
    vol: &Volume,
    vol_index: usize,
    iso: f32,
    smooth: bool,
    label: Option<f32>,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    let [nx, ny, nz] = vol.dims;
    let voxels = nx * ny * nz;
    if vol_index >= vol.nvols || voxels == 0 {
        return Err(Error::Parse(format!(
            "marching_cubes: frame {vol_index} of a {}-frame {nx}x{ny}x{nz} volume",
            vol.nvols
        )));
    }
    if crate::voxel::len(&vol.data) < voxels * (vol_index + 1) {
        return Err(Error::Parse(
            "marching_cubes: volume is shorter than its dims".into(),
        ));
    }
    let base = vol_index * voxels;
    let at = |i: usize, j: usize, k: usize| -> f32 {
        let raw = crate::voxel::raw(&vol.data, base + (k * ny + j) * nx + i);
        let v = raw * vol.scl_slope + vol.scl_inter;
        match label {
            // Binarised: 1 inside the region, 0 everywhere else, so `iso = 0.5` is that region's
            // own boundary and no other's.
            Some(target) => {
                if (v - target).abs() < 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
            None => v,
        }
    };
    let a = &vol.affine;
    let world = |i: usize, j: usize, k: usize| -> [f32; 3] {
        let (x, y, z) = (i as f64, j as f64, k as f64);
        [
            (a[0][0] * x + a[0][1] * y + a[0][2] * z + a[0][3]) as f32,
            (a[1][0] * x + a[1][1] * y + a[1][2] * z + a[1][3]) as f32,
            (a[2][0] * x + a[2][1] * y + a[2][2] * z + a[2][3]) as f32,
        ]
    };

    let mut soup = Vec::new();
    let mut owner = Vec::new();
    let mut tag = Vec::new();
    let total = (nz.saturating_sub(1)) as u64;
    for k in 0..nz.saturating_sub(1) {
        if p.aborted() {
            return Err(Error::Cancelled);
        }
        p.report(Phase::Topology, k as u64, total);
        for j in 0..ny.saturating_sub(1) {
            for i in 0..nx.saturating_sub(1) {
                let mut cv = [[0.0f32; 3]; 8];
                let mut cd = [0.0f32; 8];
                let mut cid = [0u64; 8];
                let mut lo = f32::INFINITY;
                let mut hi = f32::NEG_INFINITY;
                for n in 0..8 {
                    let (di, dj, dk) = (n & 1, (n >> 1) & 1, (n >> 2) & 1);
                    let (x, y, z) = (i + di, j + dj, k + dk);
                    cv[n] = world(x, y, z);
                    let v = at(x, y, z);
                    cd[n] = v - iso;
                    cid[n] = ((z * ny + y) * nx + x) as u64;
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
                // Whole-cell reject before any per-tet work.
                if !(lo <= iso && iso <= hi) || cd.iter().any(|x| !x.is_finite()) {
                    continue;
                }
                let cell = ((k * ny + j) * nx + i) as u32;
                for t in CUBE_TETS {
                    let added = slice_tet(
                        [cv[t[0]], cv[t[1]], cv[t[2]], cv[t[3]]],
                        [cd[t[0]], cd[t[1]], cd[t[2]], cd[t[3]]],
                        [cid[t[0]], cid[t[1]], cid[t[2]], cid[t[3]]],
                        &mut soup,
                    );
                    for _ in 0..added {
                        // A volume has no Gmsh elements; the cell's linear index (1-based, to match
                        // the 1-based convention everywhere else) is the only stable identity.
                        owner.push(cell + 1);
                        tag.push(0);
                    }
                }
            }
        }
    }
    p.report(Phase::Topology, total, total);
    Ok(build(soup, owner, tag, smooth))
}
