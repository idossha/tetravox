//! Spatial locality at load (§6.3): Morton reorder + the per-block AABB index.
//!
//! This is load-bearing, not a micro-optimisation. SimNIBS writes elements grouped by physical tag,
//! so in file order a per-64-block AABB reject at the mid-axial plane visits 4,722,624 of ernie's
//! 4,722,625 tets — **zero** speedup `[M2Max]`.
//!
//! Memory matters here: `ernie_seeg.msh` has 13,033,527 tets, so `Mesh::tets` alone is 208 MB and a
//! naive `tets = order.iter().map(|&i| tets[i]).collect()` would double that against §9.2's 1.0 GB
//! load-path bar. Every array is therefore permuted **in place** by cycle-following, which costs one
//! `bool` per element and no second copy.

use crate::TetBlocks;
use tvx_mesh_io::Mesh;

/// Spread the low 10 bits of `x` so that bit *i* lands at bit *3i*.
fn part1by2(mut x: u32) -> u32 {
    x &= 0x3ff;
    x = (x | (x << 16)) & 0x0300_00FF;
    x = (x | (x << 8)) & 0x0300_F00F;
    x = (x | (x << 4)) & 0x030C_30C3;
    x = (x | (x << 2)) & 0x0924_9249;
    x
}

fn morton30(x: u32, y: u32, z: u32) -> u32 {
    part1by2(x) | (part1by2(y) << 1) | (part1by2(z) << 2)
}

/// `v_new[i] = v_old[order[i]]`.
///
/// A fresh buffer rather than a cycle-following in-place permutation: the in-place walk is random
/// on both the read *and* the write and needs a `visited` array, and measured slower. The transient
/// copy is the largest single allocation here — 208 MB on `ernie_seeg.msh` — but it is taken and
/// released well after the parse, whose own peak is far higher, so it does not move the §9.2
/// high-water mark (see `docs/BENCHMARKS.md`).
fn gather<T: Copy + Default>(v: &mut Vec<T>, order: &[u32]) {
    let mut out = vec![T::default(); v.len()];
    for (o, &src) in out.iter_mut().zip(order) {
        *o = v[src as usize];
    }
    *v = out;
}

/// The same, over rows of `ncomp` values.
fn gather_rows(v: &mut Vec<f32>, ncomp: usize, order: &[u32]) {
    if ncomp == 0 || v.is_empty() {
        return;
    }
    let mut out = vec![0.0f32; v.len()];
    for (i, &src) in order.iter().enumerate() {
        let (d, s) = (i * ncomp, src as usize * ncomp);
        out[d..d + ncomp].copy_from_slice(&v[s..s + ncomp]);
    }
    *v = out;
}

/// Reorder tets by the 30-bit Morton code of their centroid; returns `tet_perm`
/// (**Morton index → original file row**, §6.2).
///
/// `tet_tags` and every tet side of `elm_fields` are permuted with them, so an `$ElementData` row
/// still lines up with its element. The tri side is untouched — only tets move.
pub fn morton_reorder(mesh: &mut Mesh) -> Vec<u32> {
    let n = mesh.tets.len();
    if n == 0 {
        return Vec::new();
    }

    // Quantise centroids into a 1024^3 lattice over the node bounds.
    let bb = mesh.bounds;
    let ext = [
        bb.max[0] - bb.min[0],
        bb.max[1] - bb.min[1],
        bb.max[2] - bb.min[2],
    ];
    let scale = [
        if ext[0] > 0.0 { 1023.0 / ext[0] } else { 0.0 },
        if ext[1] > 0.0 { 1023.0 / ext[1] } else { 0.0 },
        if ext[2] > 0.0 { 1023.0 / ext[2] } else { 0.0 },
    ];
    let mut codes = vec![0u32; n];
    for (j, tet) in mesh.tets.iter().enumerate() {
        let mut c = [0.0f32; 3];
        for &v in tet {
            let p = mesh.nodes[v as usize];
            c[0] += p[0];
            c[1] += p[1];
            c[2] += p[2];
        }
        let q = |a: f32, k: usize| -> u32 {
            let t = (a * 0.25 - bb.min[k]) * scale[k];
            if t <= 0.0 {
                0
            } else if t >= 1023.0 {
                1023
            } else {
                t as u32
            }
        };
        codes[j] = morton30(q(c[0], 0), q(c[1], 1), q(c[2], 2));
    }

    // Three stable 10-bit LSD radix passes (§6.3). The key is `(code << 32) | index`, so each pass
    // reads its buffer **sequentially** — the obvious "sort indices, look up codes[i]" spelling
    // gathers randomly across a 19 MB code array three times and measured 478 ms on ernie against
    // this version's 96 ms `[M2Max]`.
    let mut keys: Vec<u64> = (0..n)
        .map(|i| (u64::from(codes[i]) << 32) | i as u64)
        .collect();
    drop(codes);
    let mut aux = vec![0u64; n];
    for shift in [32u32, 42, 52] {
        let mut count = [0u32; 1025];
        for k in &keys {
            count[((k >> shift) & 0x3ff) as usize + 1] += 1;
        }
        for b in 0..1024 {
            count[b + 1] += count[b];
        }
        for k in &keys {
            let b = ((k >> shift) & 0x3ff) as usize;
            aux[count[b] as usize] = *k;
            count[b] += 1;
        }
        std::mem::swap(&mut keys, &mut aux);
    }
    drop(aux);
    let order: Vec<u32> = keys.iter().map(|k| *k as u32).collect();
    drop(keys);

    gather(&mut mesh.tets, &order);
    gather(&mut mesh.tet_tags, &order);
    for f in &mut mesh.elm_fields {
        let ncomp = f.ncomp;
        gather_rows(&mut f.tet, ncomp, &order);
    }
    order
}

/// Per-block AABBs over the Morton-ordered tets, as `(cx, cy, cz, ex, ey, ez)` — centre and
/// half-extent, which is the form `plane_cut`'s reject test
/// `|n·c + offset| <= ex·|nx| + ey·|ny| + ez·|nz|` consumes directly.
pub fn build_tet_blocks(mesh: &Mesh, blk: usize) -> TetBlocks {
    let blk = blk.max(1);
    let n = mesh.tets.len();
    let nblocks = n.div_ceil(blk);
    let mut aabb = vec![0.0f32; nblocks * 6];
    for b in 0..nblocks {
        let (lo, hi) = (b * blk, ((b + 1) * blk).min(n));
        let mut mn = [f32::INFINITY; 3];
        let mut mx = [f32::NEG_INFINITY; 3];
        for tet in &mesh.tets[lo..hi] {
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
        }
        for c in 0..3 {
            aabb[b * 6 + c] = (mn[c] + mx[c]) * 0.5;
            aabb[b * 6 + 3 + c] = (mx[c] - mn[c]) * 0.5;
        }
    }
    TetBlocks { blk, aabb }
}
