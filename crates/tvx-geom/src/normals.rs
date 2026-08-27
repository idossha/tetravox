//! Orientation and normals (§6.3). All three run at **load time** — `tvx_wasm::geom::load_time`
//! calls `orient_surface` on every mesh before the first frame — so they are written for one linear
//! pass plus one counting sort, never a `HashMap`.

use crate::bucket::{for_each_run, MinBuckets};
use crate::util::{cross, dot, normalize, sub};
use crate::OrientReport;

/// Flat normals, 3 per triangle.
pub fn face_normals(nodes: &[[f32; 3]], tris: &[[u32; 3]]) -> Vec<f32> {
    let mut out = vec![0.0f32; tris.len() * 3];
    for (t, tri) in tris.iter().enumerate() {
        let (a, b, c) = (
            nodes[tri[0] as usize],
            nodes[tri[1] as usize],
            nodes[tri[2] as usize],
        );
        let n = normalize(cross(sub(b, a), sub(c, a)));
        out[t * 3..t * 3 + 3].copy_from_slice(&n);
    }
    out
}

/// Area-weighted smooth normals, 3 per **node** (not per referenced vertex): the result is indexed
/// by the internal node row, which is what `SurfaceBuffers::node_index` points at.
///
/// The un-normalised cross product already has magnitude `2 × area`, so accumulating it *is* the
/// area weighting — no separate weight term, and no transcendental.
pub fn vertex_normals(nodes: &[[f32; 3]], tris: &[[u32; 3]]) -> Vec<f32> {
    let mut acc = vec![0.0f32; nodes.len() * 3];
    for tri in tris {
        let (ia, ib, ic) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
        let n = cross(sub(nodes[ib], nodes[ia]), sub(nodes[ic], nodes[ia]));
        for i in [ia, ib, ic] {
            acc[i * 3] += n[0];
            acc[i * 3 + 1] += n[1];
            acc[i * 3 + 2] += n[2];
        }
    }
    for i in 0..nodes.len() {
        let n = normalize([acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]]);
        acc[i * 3..i * 3 + 3].copy_from_slice(&n);
    }
    acc
}

/// Consistently orient `tris` in place and report what was found (§6.3).
///
/// Each connected component (across **manifold** edges only) is made self-consistent by a BFS that
/// flips a triangle whenever it traverses a shared edge in the same direction as its neighbour.
/// A *closed* component is then flipped as a whole when its enclosed signed volume is negative, so
/// closed surfaces end up outward-facing; an *open* component has no meaningful inside, so it is
/// left as the BFS made it and only counted. `open_components > 0` is what forces
/// `MeshLayer.faceMode: 'both'` (§4.4).
#[allow(clippy::ptr_arg)] // `&mut Vec` is §6.3 verbatim and therefore frozen (§12.3).
pub fn orient_surface(nodes: &[[f32; 3]], tris: &mut Vec<[u32; 3]>) -> OrientReport {
    let n_tris = tris.len();
    let mut report = OrientReport::default();
    if n_tris == 0 {
        return report;
    }

    // --- undirected edges, bucketed on the minimum vertex (§6.3: no packed key) ---------------
    // payload: [other vertex, tri * 2 + direction], direction = 1 when the triangle traverses the
    // edge low → high.
    let edges = MinBuckets::<2>::build(nodes.len(), |emit| {
        for (t, tri) in tris.iter().enumerate() {
            for e in 0..3 {
                let (u, v) = (tri[e], tri[(e + 1) % 3]);
                let (lo, hi, dir) = if u < v { (u, v, 1u32) } else { (v, u, 0u32) };
                emit(lo, [hi, (t as u32) * 2 + dir]);
            }
        }
    });

    // --- adjacency across manifold edges, plus the open/non-manifold census -------------------
    let mut pairs: Vec<(u32, u32, bool)> = Vec::new(); // (t0, t1, same_direction => must flip)
    let mut on_boundary = vec![false; n_tris];
    for k in 0..nodes.len() {
        for_each_run(edges.group(k), 1, |run| match run.len() {
            1 => on_boundary[(run[0][1] / 2) as usize] = true,
            2 => {
                let (t0, d0) = (run[0][1] / 2, run[0][1] & 1);
                let (t1, d1) = (run[1][1] / 2, run[1][1] & 1);
                pairs.push((t0, t1, d0 == d1));
            }
            n => {
                report.non_manifold_edges += 1;
                // A non-manifold edge joins no two triangles unambiguously, so it contributes no
                // adjacency; every triangle on it is treated as bounded there.
                for h in run.iter().take(n) {
                    on_boundary[(h[1] / 2) as usize] = true;
                }
            }
        });
    }
    drop(edges);

    // CSR adjacency: neighbour * 2 + must-flip.
    let mut adj_starts = vec![0u32; n_tris + 1];
    for &(a, b, _) in &pairs {
        adj_starts[a as usize + 1] += 1;
        adj_starts[b as usize + 1] += 1;
    }
    for i in 0..n_tris {
        adj_starts[i + 1] += adj_starts[i];
    }
    let mut adj = vec![0u32; adj_starts[n_tris] as usize];
    {
        let mut cur = adj_starts.clone();
        for &(a, b, flip) in &pairs {
            let f = u32::from(flip);
            adj[cur[a as usize] as usize] = b * 2 + f;
            cur[a as usize] += 1;
            adj[cur[b as usize] as usize] = a * 2 + f;
            cur[b as usize] += 1;
        }
    }
    drop(pairs);

    // --- BFS per component --------------------------------------------------------------------
    //
    // Flips are *recorded*, not applied, while the BFS runs. `same_dir` was computed from the
    // triangles' ORIGINAL winding, so mutating a triangle mid-walk would invalidate the flags on
    // every one of its other edges. With `flip[t]` tracked separately the relation stays a pure
    // function of the original data:
    //
    //     consistent  <=>  (d0 ^ flip[t0]) != (d1 ^ flip[t1])
    //     hence         flip[t1] = same_dir ^ flip[t0]
    //
    // and the whole component is rewritten once, after the walk.
    let mut seen = vec![false; n_tris];
    let mut flip = vec![false; n_tris];
    let mut stack: Vec<u32> = Vec::new();
    let mut member: Vec<u32> = Vec::new();
    for seed in 0..n_tris {
        if seen[seed] {
            continue;
        }
        report.components += 1;
        seen[seed] = true;
        stack.push(seed as u32);
        member.clear();
        let mut open = false;
        while let Some(t) = stack.pop() {
            member.push(t);
            open |= on_boundary[t as usize];
            let (a, b) = (
                adj_starts[t as usize] as usize,
                adj_starts[t as usize + 1] as usize,
            );
            for &packed in &adj[a..b] {
                let (nb, same_dir) = ((packed / 2) as usize, packed & 1 == 1);
                if seen[nb] {
                    continue;
                }
                seen[nb] = true;
                flip[nb] = same_dir ^ flip[t as usize];
                stack.push(nb as u32);
            }
        }
        for &t in &member {
            if flip[t as usize] {
                tris[t as usize].swap(1, 2);
            }
        }
        if open {
            report.open_components += 1;
            continue;
        }
        // Closed: six times the enclosed volume, via the divergence theorem about the origin.
        // Accumulated in f64 because a head-sized surface sums ~10^6 terms of ~10^4 mm^3.
        let mut v6 = 0.0f64;
        for &t in &member {
            let tri = tris[t as usize];
            let (a, b, c) = (
                nodes[tri[0] as usize],
                nodes[tri[1] as usize],
                nodes[tri[2] as usize],
            );
            v6 += f64::from(dot(a, cross(b, c)));
        }
        if v6 < 0.0 {
            report.flipped_components += 1;
            for &t in &member {
                tris[t as usize].swap(1, 2);
            }
        }
    }
    report
}
