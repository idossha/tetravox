//! `plane_cut` and `surface_contours` (§6.3).
//!
//! The block reject is `|n·c + offset| <= ex·|nx| + ey·|ny| + ez·|nz|`, and the output must be
//! **bit-identical with and without the block index** — the index may only skip blocks that cannot
//! contribute, never change what a contributing tet produces. `plane_cut` takes no topology;
//! `boundary_segments` adjacency is built locally over the cut tets only.

use crate::util::{cross, dot, sub};
use crate::{Cut, CutInterp};
use tvx_core::{BitMask, Plane, Result};
use tvx_mesh_io::Mesh;

/// One vertex of a cut polygon: its position, where it came from, and whether the polygon edge
/// leaving it is a **real element edge** (§6.3's `edge_mask` rule) rather than an invented diagonal
/// or a segment introduced by another clip plane.
#[derive(Clone, Copy)]
struct PolyVert {
    pos: [f32; 3],
    interp: CutInterp,
    real_to_next: bool,
}

fn lerp(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn signed(plane: &Plane, p: [f32; 3]) -> f32 {
    dot(plane.normal, p) + plane.offset
}

/// The cut point on the mesh edge `(i0, i1)`, where `d0 >= 0 > d1`.
fn cut_vertex(nodes: &[[f32; 3]], i0: u32, i1: u32, d0: f32, d1: f32) -> PolyVert {
    let t = d0 / (d0 - d1);
    PolyVert {
        pos: lerp(nodes[i0 as usize], nodes[i1 as usize], t),
        interp: CutInterp { n0: i0, n1: i1, t },
        real_to_next: true,
    }
}

/// The cut polygon of one tet, on the stack.
///
/// A tet's cap is a triangle or a quad; each of the ≤ 5 *other* clip planes can add at most one
/// vertex to a convex polygon, so 9 is the true bound and 12 is the round number above it. This is
/// a fixed-size buffer rather than a `Vec` because `plane_cut` visits ~63,000 cut tets for one
/// mid-axial plane on ernie and a `Vec` per tet is ~63,000 allocate/free pairs — free enough under
/// the system allocator to hide, and the difference between meeting and missing §9.1 row 10 under
/// wasm's dlmalloc, which is the environment the row is written for.
const MAX_POLY: usize = 12;

#[derive(Clone, Copy)]
struct Poly {
    v: [PolyVert; MAX_POLY],
    n: usize,
}

impl Poly {
    const EMPTY: PolyVert = PolyVert {
        pos: [0.0; 3],
        interp: CutInterp {
            n0: 0,
            n1: 0,
            t: 0.0,
        },
        real_to_next: false,
    };

    fn new() -> Self {
        Self {
            v: [Self::EMPTY; MAX_POLY],
            n: 0,
        }
    }

    fn push(&mut self, pv: PolyVert) {
        if self.n < MAX_POLY {
            self.v[self.n] = pv;
            self.n += 1;
        }
    }

    fn as_slice(&self) -> &[PolyVert] {
        &self.v[..self.n]
    }
}

/// Clip a cut polygon by one *other* plane (Sutherland–Hodgman), into `out`.
///
/// A vertex introduced here lies on the clip plane, **not** on a mesh edge, so it has no honest
/// `CutInterp`. It is marked `n0 == n1` — read that as "sample node `n0` directly" — and the edge
/// leaving it is flagged not-real so no wireframe draws it. See `docs/DECISIONS.md`.
fn clip_by(poly: &Poly, plane: &Plane, out: &mut Poly) {
    out.n = 0;
    let n = poly.n;
    for i in 0..n {
        let (cur, nxt) = (poly.v[i], poly.v[(i + 1) % n]);
        let (dc, dn) = (signed(plane, cur.pos), signed(plane, nxt.pos));
        if dc >= 0.0 {
            out.push(cur);
        }
        if (dc >= 0.0) != (dn >= 0.0) {
            let t = dc / (dc - dn);
            let entering = dc < 0.0;
            out.push(PolyVert {
                pos: lerp(cur.pos, nxt.pos, t),
                interp: CutInterp {
                    n0: cur.interp.n0,
                    n1: cur.interp.n0,
                    t: 0.0,
                },
                // Leaving the solid: the rest of this original edge is gone, and the next edge runs
                // along the clip plane. Entering: the remainder of the original edge is real again.
                real_to_next: if entering { cur.real_to_next } else { false },
            });
        }
    }
}

/// Exact per-element caps for up to 6 planes (§6.3).
pub fn plane_cut(
    mesh: &Mesh,
    blocks: &crate::TetBlocks,
    planes: &[Plane],
    mask: Option<&BitMask>,
) -> Result<Vec<Cut>> {
    if planes.len() > 6 {
        return Err(tvx_core::Error::Unsupported(format!(
            "plane_cut takes at most 6 planes, got {}",
            planes.len()
        )));
    }
    let blk = blocks.blk.max(1);
    let nblocks = blocks.aabb.len() / 6;
    let mut out = Vec::with_capacity(planes.len());

    for (pi, plane) in planes.iter().enumerate() {
        let mut cut = Cut {
            plane: pi,
            positions: Vec::new(),
            interp: Vec::new(),
            owner_tet: Vec::new(),
            tag: Vec::new(),
            edge_mask: Vec::new(),
            edge_segments: Vec::new(),
            boundary_segments: Vec::new(),
        };
        // (edge key lo, edge key hi, tag, index into `cut.edge_segments`) for the local boundary
        // pass. The endpoints are **not** carried here: every real edge has already been pushed to
        // `edge_segments`, so an index costs 4 bytes against 24 and halves what the sort below
        // moves — ~200,000 entries for one mid-axial plane on ernie.
        let mut poly_edges: Vec<(u64, u64, i32, u32)> = Vec::new();
        // Reused across every cut tet — see `Poly`.
        let mut poly = Poly::new();
        let mut clipped = Poly::new();

        for b in 0..nblocks {
            let a = &blocks.aabb[b * 6..b * 6 + 6];
            let c = [a[0], a[1], a[2]];
            let r = a[3] * plane.normal[0].abs()
                + a[4] * plane.normal[1].abs()
                + a[5] * plane.normal[2].abs();
            if (dot(plane.normal, c) + plane.offset).abs() > r {
                continue;
            }
            let (lo, hi) = (b * blk, ((b + 1) * blk).min(mesh.tets.len()));
            for t in lo..hi {
                if mask.is_some_and(|m| !m.get(t)) {
                    continue;
                }
                let tet = mesh.tets[t];
                let mut d = [0.0f32; 4];
                let mut npos = 0usize;
                for (k, dk) in d.iter_mut().enumerate() {
                    *dk = signed(plane, mesh.nodes[tet[k] as usize]);
                    if *dk >= 0.0 {
                        npos += 1;
                    }
                }
                if npos == 0 || npos == 4 {
                    continue;
                }
                // Split the corners. `pos` keeps the kept side, `neg` the removed side.
                let mut pos = [0usize; 4];
                let mut neg = [0usize; 4];
                let (mut np, mut nn) = (0, 0);
                for (k, &dk) in d.iter().enumerate() {
                    if dk >= 0.0 {
                        pos[np] = k;
                        np += 1;
                    } else {
                        neg[nn] = k;
                        nn += 1;
                    }
                }

                // The cut polygon, in cyclic order. Both 1-3 orientations give a triangle; the
                // 2-2 split gives the quad (ac, ad, bd, bc), whose edges each lie on one tet face.
                poly.n = 0;
                let v = |i: usize, j: usize| cut_vertex(&mesh.nodes, tet[i], tet[j], d[i], d[j]);
                if np == 1 {
                    let a = pos[0];
                    poly.push(v(a, neg[0]));
                    poly.push(v(a, neg[1]));
                    poly.push(v(a, neg[2]));
                } else if nn == 1 {
                    // Mirror case: interpolate from the positive side so `t` keeps its meaning.
                    let b = neg[0];
                    poly.push(v(pos[0], b));
                    poly.push(v(pos[1], b));
                    poly.push(v(pos[2], b));
                } else {
                    let (a, bb) = (pos[0], pos[1]);
                    let (c0, d0) = (neg[0], neg[1]);
                    poly.push(v(a, c0));
                    poly.push(v(a, d0));
                    poly.push(v(bb, d0));
                    poly.push(v(bb, c0));
                }

                // Wind the cap so its normal faces the removed side: it closes the kept solid.
                if poly.n >= 3 {
                    let nrm = cross(
                        sub(poly.v[1].pos, poly.v[0].pos),
                        sub(poly.v[2].pos, poly.v[0].pos),
                    );
                    if dot(nrm, plane.normal) > 0.0 {
                        let n = poly.n;
                        poly.v[..n].reverse();
                        // `real_to_next` is a property of the edge *leaving* a vertex, so reversing
                        // the ring moves each flag one step back.
                        let first = poly.v[0].real_to_next;
                        for i in 0..n - 1 {
                            poly.v[i].real_to_next = poly.v[i + 1].real_to_next;
                        }
                        poly.v[n - 1].real_to_next = first;
                    }
                }

                for (qi, other) in planes.iter().enumerate() {
                    if qi != pi && poly.n >= 3 {
                        clip_by(&poly, other, &mut clipped);
                        std::mem::swap(&mut poly, &mut clipped);
                    }
                }
                if poly.n < 3 {
                    continue;
                }

                let tag = mesh.tet_tags[t];
                let gmsh = crate::util::tet_gmsh_number(mesh, t);
                for pv in poly.as_slice() {
                    cut.positions.extend_from_slice(&pv.pos);
                    cut.interp.push(pv.interp);
                }
                // Fan (0, i, i+1). For a triangle that is the whole polygon with every edge real
                // (mask 0b111); for a quad it is (a,b,c) then (a,c,d), and bit i means "the edge
                // opposite vertex i is a real element edge" — so the invented diagonal a-c is bit 1
                // of the first triangle and bit 2 of the second, giving 0b101 and 0b011 (§6.3).
                let n = poly.n;
                for i in 1..n - 1 {
                    let (v0, v1, v2) = (0usize, i, i + 1);
                    let mut m = 0u8;
                    // Edge opposite vertex 0 of this triangle is v1->v2.
                    if poly.v[v1].real_to_next {
                        m |= 0b001;
                    }
                    // Edge opposite vertex 1 is v2->v0: real only when it closes the ring.
                    if v2 == n - 1 && poly.v[v2].real_to_next {
                        m |= 0b010;
                    }
                    // Edge opposite vertex 2 is v0->v1: real only on the first fan triangle.
                    if v1 == 1 && poly.v[v0].real_to_next {
                        m |= 0b100;
                    }
                    cut.edge_mask.push(m);
                    cut.owner_tet.push(gmsh);
                    cut.tag.push(tag);
                }
                // Real polygon edges become both `edge_segments` and candidates for the tag
                // boundary. The identity `popcount(edge_mask).sum() * 6 == edge_segments.len()`
                // holds by construction.
                for i in 0..n {
                    if !poly.v[i].real_to_next {
                        continue;
                    }
                    let (p0, p1) = (poly.v[i].pos, poly.v[(i + 1) % n].pos);
                    cut.edge_segments.extend_from_slice(&p0);
                    cut.edge_segments.extend_from_slice(&p1);
                    let ka = edge_key(poly.v[i].interp);
                    let kb = edge_key(poly.v[(i + 1) % n].interp);
                    let (ka, kb) = if ka <= kb { (ka, kb) } else { (kb, ka) };
                    let seg = (cut.edge_segments.len() / 6 - 1) as u32;
                    poly_edges.push((ka, kb, tag, seg));
                }
            }
        }

        // Tag-boundary contours: a cap edge shared by two cut tets of the same tag is interior to
        // one tissue and is dropped; anything else (a silhouette edge, or a tag change) is drawn.
        // Keyed on (edge, tag) only: the segment index is never a tiebreak, so the output does not
        // depend on the order edges happened to be produced in (§6.3's determinism rule).
        poly_edges.sort_unstable_by_key(|e| (e.0, e.1, e.2));
        let mut i = 0;
        while i < poly_edges.len() {
            let mut j = i + 1;
            while j < poly_edges.len()
                && poly_edges[j].0 == poly_edges[i].0
                && poly_edges[j].1 == poly_edges[i].1
            {
                j += 1;
            }
            let same_tag = j - i == 2 && poly_edges[i].2 == poly_edges[j - 1].2;
            if !same_tag {
                let seg = poly_edges[i].3 as usize * 6;
                let e: [f32; 6] = cut.edge_segments[seg..seg + 6]
                    .try_into()
                    .expect("6 floats");
                cut.boundary_segments.extend_from_slice(&e);
            }
            i = j;
        }
        out.push(cut);
    }
    Ok(out)
}

/// A stable identity for a cut vertex: the mesh edge it sits on.
fn edge_key(c: CutInterp) -> u64 {
    let (a, b) = if c.n0 <= c.n1 {
        (c.n0, c.n1)
    } else {
        (c.n1, c.n0)
    };
    (u64::from(a) << 32) | u64::from(b)
}

/// Contour segments of the **surface triangles** against `plane`; 6 floats per segment (§6.3).
///
/// Contour lines of the mesh's **stored triangles** on one plane (§6.3).
///
/// A tri-less tet mesh therefore yields **nothing** — `grey_Thalamus_TI.msh` has 1,340,029 tets and
/// 0 triangles — and that is correct, not a fallback to write: its 2D tissue boundaries are
/// [`plane_cut`]'s `boundary_segments`, which the overlay gets from the same `cut` call that gives
/// it the `fillIn2D` polygons (§6.5.2, §7.4).
///
/// Every other §6.3 function takes a mask over tets. Triangles are not tets, so a mask is applied
/// here only when its length matches `Mesh::tris` — a tet-length mask means "these tets are
/// isolated", which says nothing about which stored triangles to draw, and is ignored rather than
/// misinterpreted.
pub fn surface_contours(mesh: &Mesh, plane: &Plane, mask: Option<&BitMask>) -> Result<Vec<f32>> {
    let tri_mask = mask.filter(|m| m.len() == mesh.tris.len());
    let mut out = Vec::new();
    for (i, tri) in mesh.tris.iter().enumerate() {
        if tri_mask.is_some_and(|m| !m.get(i)) {
            continue;
        }
        let p: [[f32; 3]; 3] = [
            mesh.nodes[tri[0] as usize],
            mesh.nodes[tri[1] as usize],
            mesh.nodes[tri[2] as usize],
        ];
        let d = [
            signed(plane, p[0]),
            signed(plane, p[1]),
            signed(plane, p[2]),
        ];
        let mut hits: Vec<[f32; 3]> = Vec::with_capacity(2);
        for k in 0..3 {
            let (a, b) = (k, (k + 1) % 3);
            if (d[a] >= 0.0) != (d[b] >= 0.0) {
                hits.push(lerp(p[a], p[b], d[a] / (d[a] - d[b])));
            }
        }
        if hits.len() == 2 {
            out.extend_from_slice(&hits[0]);
            out.extend_from_slice(&hits[1]);
        }
    }
    Ok(out)
}

/// Categorical surface contours. Split at barycentric dominance changes and carry one dense
/// node-label index per segment; interpolating label numbers would invent regions.
pub fn labeled_surface_contours(
    mesh: &Mesh,
    plane: &Plane,
    mask: Option<&BitMask>,
    labels: &[f32],
) -> Result<(Vec<f32>, Vec<u32>)> {
    if labels.len() != mesh.nodes.len()
        || labels
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0 || v.fract() != 0.0)
    {
        return Err(tvx_core::Error::Parse(
            "invalid surface label indices".into(),
        ));
    }
    let tri_mask = mask.filter(|m| m.len() == mesh.tris.len());
    let mut segments = Vec::new();
    let mut indices = Vec::new();
    for (i, tri) in mesh.tris.iter().enumerate() {
        if tri_mask.is_some_and(|m| !m.get(i)) {
            continue;
        }
        let p = tri.map(|n| mesh.nodes[n as usize]);
        let d = p.map(|p| signed(plane, p));
        let mut hits = Vec::with_capacity(2);
        for a in 0..3 {
            let b = (a + 1) % 3;
            if (d[a] >= 0.0) != (d[b] >= 0.0) {
                let t = d[a] / (d[a] - d[b]);
                let mut bary = [0.0; 3];
                bary[a] = 1.0 - t;
                bary[b] = t;
                hits.push((lerp(p[a], p[b], t), bary));
            }
        }
        if hits.len() != 2 {
            continue;
        }
        let (a, ba) = hits[0];
        let (b, bb) = hits[1];
        let mut cuts = vec![0.0_f32, 1.0];
        for j in 0..3 {
            for k in j + 1..3 {
                let start = ba[j] - ba[k];
                let delta = (bb[j] - bb[k]) - start;
                if delta != 0.0 {
                    let t = -start / delta;
                    if t > 0.0 && t < 1.0 {
                        cuts.push(t);
                    }
                }
            }
        }
        cuts.sort_by(f32::total_cmp);
        cuts.dedup();
        let first_segment = indices.len();
        for interval in cuts.windows(2) {
            let mid = (interval[0] + interval[1]) * 0.5;
            let weights = lerp(ba, bb, mid);
            // Stable ties choose the lowest original vertex id, independent of triangle winding.
            let mut winner = 0;
            for k in 1..3 {
                if weights[k] > weights[winner]
                    || (weights[k] == weights[winner] && tri[k] < tri[winner])
                {
                    winner = k;
                }
            }
            let label = labels[tri[winner] as usize] as u32;
            let end = lerp(a, b, interval[1]);
            if indices.len() > first_segment && indices.last() == Some(&label) {
                // Non-dominant weight crossings need no visual boundary. Keeping one interval
                // per label also avoids overlapping alpha-blended line caps within a region.
                let tail = segments.len() - 3;
                segments[tail..].copy_from_slice(&end);
            } else {
                segments.extend_from_slice(&lerp(a, b, interval[0]));
                segments.extend_from_slice(&end);
                indices.push(label);
            }
        }
    }
    Ok((segments, indices))
}

/// Surface intersections with two linearly interpolated scalar values per segment, one per endpoint.
/// `values` contains one value per node; partial-field NaNs remain NaN.
pub fn valued_surface_contours(
    mesh: &Mesh,
    plane: &Plane,
    mask: Option<&BitMask>,
    values: &[f32],
) -> Result<(Vec<f32>, Vec<f32>)> {
    if values.len() != mesh.nodes.len() {
        return Err(tvx_core::Error::Parse(format!(
            "contour field carries {} values for {} nodes",
            values.len(),
            mesh.nodes.len()
        )));
    }
    let tri_mask = mask.filter(|m| m.len() == mesh.tris.len());
    let mut segments = Vec::new();
    let mut out_values = Vec::new();
    for (i, tri) in mesh.tris.iter().enumerate() {
        if tri_mask.is_some_and(|m| !m.get(i)) {
            continue;
        }
        let p = tri.map(|n| mesh.nodes[n as usize]);
        let d = p.map(|p| signed(plane, p));
        let mut hits: Vec<([f32; 3], f32)> = Vec::with_capacity(2);
        for a in 0..3 {
            let b = (a + 1) % 3;
            if (d[a] >= 0.0) != (d[b] >= 0.0) {
                let t = d[a] / (d[a] - d[b]);
                let (va, vb) = (values[tri[a] as usize], values[tri[b] as usize]);
                hits.push((lerp(p[a], p[b], t), va + (vb - va) * t));
            }
        }
        if hits.len() == 2 {
            segments.extend_from_slice(&hits[0].0);
            segments.extend_from_slice(&hits[1].0);
            out_values.extend_from_slice(&[hits[0].1, hits[1].1]);
        }
    }
    Ok((segments, out_values))
}

#[cfg(test)]
mod valued_tests {
    use super::*;

    /// Two triangles over the unit-ish square `[0,4]²` at z = 0, split along the diagonal.
    fn square() -> Mesh {
        Mesh {
            nodes: vec![
                [0.0, 0.0, 0.0],
                [4.0, 0.0, 0.0],
                [4.0, 4.0, 0.0],
                [0.0, 4.0, 0.0],
            ],
            tris: vec![[0, 1, 2], [0, 2, 3]],
            tri_tags: vec![1, 1],
            tets: vec![],
            tet_tags: vec![],
            tri_edge_mask: None,
            node_fields: vec![],
            elm_fields: vec![],
            gmsh_field_order: Vec::new(),
            physical_names: vec![],
            gmsh_node_numbers: None,
            gmsh_elm_numbers: None,
            tet_perm: vec![],
            skipped: vec![],
            bounds: tvx_core::Aabb {
                min: [0.0; 3],
                max: [4.0, 4.0, 0.0],
            },
            label_table: None,
        }
    }

    /// The field is `f = x + 10·y`, linear, so any linear interpolation along an edge reproduces
    /// it exactly and the segment value is `f` at the segment's midpoint.
    fn linear_field(m: &Mesh) -> Vec<f32> {
        m.nodes.iter().map(|n| n[0] + 10.0 * n[1]).collect()
    }

    #[test]
    fn a_linear_field_is_sampled_exactly_at_each_endpoint() {
        let m = square();
        let f = linear_field(&m);
        // The plane x = 1 crosses the lower triangle (0,1,2) on edges (0,1) at (1,0) and (0,2) at
        // (1,1), and the upper triangle (0,2,3) on (0,2) at (1,1) and (2,3) at (1,4).
        let plane = Plane {
            normal: [1.0, 0.0, 0.0],
            offset: -1.0,
        };
        let (segs, vals) = valued_surface_contours(&m, &plane, None, &f).unwrap();
        assert_eq!(segs.len(), 12);
        assert_eq!(vals.len(), 4);
        for (p, value) in segs.chunks_exact(3).zip(&vals) {
            assert!((p[0] - 1.0).abs() < 1e-6);
            let expected = p[0] + 10.0 * p[1];
            assert!((value - expected).abs() < 1e-5);
        }
    }

    #[test]
    fn the_segments_are_exactly_the_plain_contours() {
        let m = square();
        let f = linear_field(&m);
        let plane = Plane {
            normal: [0.0, 1.0, 0.0],
            offset: -2.5,
        };
        let plain = surface_contours(&m, &plane, None).unwrap();
        let (segs, vals) = valued_surface_contours(&m, &plane, None, &f).unwrap();
        assert_eq!(segs, plain);
        assert_eq!(vals.len(), segs.len() / 3);
    }

    #[test]
    fn a_nan_node_makes_its_segment_nan_and_a_bad_length_is_an_error() {
        let m = square();
        let mut f = linear_field(&m);
        f[2] = f32::NAN;
        let plane = Plane {
            normal: [1.0, 0.0, 0.0],
            offset: -1.0,
        };
        let (_, vals) = valued_surface_contours(&m, &plane, None, &f).unwrap();
        assert!(
            vals.chunks_exact(2).all(|v| v.iter().any(|x| x.is_nan())),
            "both segments touch node 2"
        );
        assert!(valued_surface_contours(&m, &plane, None, &f[..3]).is_err());
        let mask = BitMask::new_all(2, false);
        let (s, v) = valued_surface_contours(&m, &plane, Some(&mask), &f).unwrap();
        assert!(s.is_empty() && v.is_empty());
    }
}

#[cfg(test)]
mod annotation_tests {
    use super::*;

    fn triangle() -> Mesh {
        Mesh {
            nodes: vec![[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]],
            tris: vec![[0, 1, 2]],
            tri_tags: vec![1],
            tets: vec![],
            tet_tags: vec![],
            tri_edge_mask: None,
            node_fields: vec![],
            elm_fields: vec![],
            gmsh_field_order: Vec::new(),
            physical_names: vec![],
            gmsh_node_numbers: None,
            gmsh_elm_numbers: None,
            tet_perm: vec![],
            skipped: vec![],
            bounds: tvx_core::Aabb {
                min: [0.0; 3],
                max: [4.0, 4.0, 0.0],
            },
            label_table: None,
        }
    }

    // Authored right triangle: at y=1, barycentrics are (3-x,x,1)/4. Thus the categorical
    // transition is x=1.5, and the complete contour is [0,3] with total length 3.
    #[test]
    fn labels_split_at_dominant_barycentric_boundary_without_blending_ids() {
        let mesh = triangle();
        let plane = Plane {
            normal: [0.0, 1.0, 0.0],
            offset: -1.0,
        };
        for tri in [[0, 1, 2], [2, 1, 0]] {
            let mut m = mesh.clone();
            m.tris[0] = tri;
            let (segments, labels) =
                labeled_surface_contours(&m, &plane, None, &[10.0, 20.0, 30.0]).unwrap();
            assert_eq!(segments.len(), labels.len() * 6);
            assert_eq!(labels.len(), 2, "one interval per actual region");
            let mut length = 0.0;
            for (s, id) in segments.chunks_exact(6).zip(labels) {
                assert_eq!([s[1], s[2], s[4], s[5]], [1.0, 0.0, 1.0, 0.0]);
                let mid = (s[0] + s[3]) * 0.5;
                assert_eq!(id, if mid < 1.5 { 10 } else { 20 });
                assert!(s[0].max(s[3]) <= 1.5 || s[0].min(s[3]) >= 1.5);
                length += (s[3] - s[0]).abs();
            }
            assert!((length - 3.0).abs() < 1e-6);
        }
    }

    #[test]
    fn annotation_contours_respect_mask_and_reject_invalid_label_fields() {
        let m = triangle();
        let p = Plane {
            normal: [0.0, 1.0, 0.0],
            offset: -1.0,
        };
        let mask = BitMask::new_all(1, false);
        let (s, ids) = labeled_surface_contours(&m, &p, Some(&mask), &[0.0; 3]).unwrap();
        assert!(s.is_empty() && ids.is_empty());
        for bad in [
            &[0.0, 1.0][..],
            &[0.0, f32::NAN, 1.0],
            &[0.0, -1.0, 1.0],
            &[0.0, 0.5, 1.0],
        ] {
            assert!(labeled_surface_contours(&m, &p, None, bad).is_err());
        }
    }
}
