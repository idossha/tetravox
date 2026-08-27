//! `tag_surfaces`, `extract_boundary`, `build_topology` (§6.3) and the shared assembler that turns a
//! bag of oriented triangles into draw-ready [`SurfaceBuffers`].

use crate::bucket::{for_each_run, MinBuckets};
use crate::normals::{face_normals, orient_surface};
use crate::util::{
    bounds_of, cross, normalize, signed_volume6, sub, tet_gmsh_number, tri_gmsh_number,
};
use crate::{OrientReport, SurfaceBuffers, SurfaceVariant, TagRange, TetTopology};
use tvx_core::{BitMask, Error, Phase, ProgressSink, Result};
use tvx_mesh_io::Mesh;

/// An unordered bag of oriented triangles plus their per-triangle attributes, before grouping.
pub(crate) struct FaceSoup {
    pub tris: Vec<[u32; 3]>,
    pub owner: Vec<u32>,
    pub tag: Vec<i32>,
    pub edge_mask: Option<Vec<u8>>,
}

/// Group by tag and expand into the requested variant.
///
/// The grouping is a **stable** counting sort over the distinct tags in ascending order, so the
/// output order is a pure function of the input order — which is what makes `extract_boundary`'s
/// two paths (with and without a `TetTopology`) byte-identical.
pub(crate) fn assemble(
    nodes: &[[f32; 3]],
    soup: FaceSoup,
    variant: SurfaceVariant,
    orient: OrientReport,
) -> SurfaceBuffers {
    let n = soup.tris.len();
    let mut tags: Vec<i32> = soup.tag.clone();
    tags.sort_unstable();
    tags.dedup();
    let rank = |t: i32| tags.binary_search(&t).expect("tag present");

    let mut counts = vec![0u32; tags.len() + 1];
    for &t in &soup.tag {
        counts[rank(t) + 1] += 1;
    }
    for i in 0..tags.len() {
        counts[i + 1] += counts[i];
    }
    let mut order = vec![0u32; n];
    {
        let mut cur = counts.clone();
        for (i, &t) in soup.tag.iter().enumerate() {
            let r = rank(t);
            order[cur[r] as usize] = i as u32;
            cur[r] += 1;
        }
    }

    let per_tag: Vec<TagRange> = tags
        .iter()
        .enumerate()
        .map(|(r, &tag)| TagRange {
            tag,
            // Both variants address triples: `indices` for Indexed, vertices for Deindexed.
            first: counts[r] * 3,
            count: (counts[r + 1] - counts[r]) * 3,
        })
        .collect();

    let owner_elm: Vec<u32> = order.iter().map(|&i| soup.owner[i as usize]).collect();
    let face_tag: Vec<i32> = order.iter().map(|&i| soup.tag[i as usize]).collect();
    let edge_mask = soup
        .edge_mask
        .as_ref()
        .map(|m| order.iter().map(|&i| m[i as usize]).collect());

    match variant {
        SurfaceVariant::Indexed => {
            // Compact to the referenced nodes only: `node_index` exists precisely so the §7.4
            // node-field texture can be addressed by the internal node row (§6.3).
            let mut remap = vec![u32::MAX; nodes.len()];
            let mut node_index: Vec<u32> = Vec::new();
            let mut indices: Vec<u32> = Vec::with_capacity(n * 3);
            for &i in &order {
                for &v in &soup.tris[i as usize] {
                    let slot = &mut remap[v as usize];
                    if *slot == u32::MAX {
                        *slot = node_index.len() as u32;
                        node_index.push(v);
                    }
                    indices.push(*slot);
                }
            }
            let mut positions = Vec::with_capacity(node_index.len() * 3);
            for &v in &node_index {
                positions.extend_from_slice(&nodes[v as usize]);
            }
            // Area-weighted smooth normals over the compacted surface only. The unnormalised cross
            // product already has magnitude 2 x area, so accumulating it *is* the weighting.
            let mut normals = vec![0.0f32; node_index.len() * 3];
            for tri in indices.chunks_exact(3) {
                let g = |k: usize| {
                    let b = tri[k] as usize * 3;
                    [positions[b], positions[b + 1], positions[b + 2]]
                };
                let (a, b, c) = (g(0), g(1), g(2));
                let fnl = cross(sub(b, a), sub(c, a));
                for &k in tri {
                    let o = k as usize * 3;
                    normals[o] += fnl[0];
                    normals[o + 1] += fnl[1];
                    normals[o + 2] += fnl[2];
                }
            }
            for i in 0..node_index.len() {
                let v = normalize([normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]]);
                normals[i * 3..i * 3 + 3].copy_from_slice(&v);
            }
            let bounds = bounds_of(
                &positions
                    .chunks_exact(3)
                    .map(|c| [c[0], c[1], c[2]])
                    .collect::<Vec<_>>(),
            );
            SurfaceBuffers {
                variant,
                positions,
                normals,
                indices: Some(indices),
                node_index: Some(node_index),
                corner: None,
                owner_elm,
                face_tag,
                edge_mask,
                per_tag,
                orient,
                bounds,
            }
        }
        SurfaceVariant::Deindexed => {
            let mut positions = Vec::with_capacity(n * 9);
            let mut tris = Vec::with_capacity(n);
            for &i in &order {
                let t = soup.tris[i as usize];
                tris.push(t);
                for &v in &t {
                    positions.extend_from_slice(&nodes[v as usize]);
                }
            }
            let fnl = face_normals(nodes, &tris);
            let mut normals = Vec::with_capacity(n * 9);
            for f in fnl.chunks_exact(3) {
                for _ in 0..3 {
                    normals.extend_from_slice(f);
                }
            }
            let corner: Vec<u8> = (0..n).flat_map(|_| [0u8, 1, 2]).collect();
            let bounds = bounds_of(
                &positions
                    .chunks_exact(3)
                    .map(|c| [c[0], c[1], c[2]])
                    .collect::<Vec<_>>(),
            );
            SurfaceBuffers {
                variant,
                positions,
                normals,
                indices: None,
                node_index: None,
                corner: Some(corner),
                owner_elm,
                face_tag,
                edge_mask,
                per_tag,
                orient,
                bounds,
            }
        }
    }
}

/// The mesh's own tagged triangles, grouped by tag (§6.3).
///
/// **No topology and no geometry work beyond grouping and normals** — that is the whole point of
/// this function. SimNIBS's stored triangles already *are* the exterior ∪ tag-differing-interior
/// face set (0 missing / 0 extra on `ernie.msh`: 128,614 + 1,048,599 = 1,177,213 `[DATA]`), so
/// deriving them from the tets instead would emit every interface twice — 2,225,812 faces, 1.89x
/// the geometry for the same picture.
///
/// `orient` is reported as [`OrientReport::default`]: orienting is a topology pass, which this
/// function is defined not to do. `tvx_wasm::geom::load_time` runs `orient_surface` on
/// `Mesh::tris` once at load and carries the real report in `MeshMeta`, so nothing is lost.
pub fn tag_surfaces(
    mesh: &Mesh,
    variant: SurfaceVariant,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    let n = mesh.tris.len();
    p.report(Phase::Index, 0, n as u64);
    if p.aborted() {
        return Err(Error::Cancelled);
    }
    let soup = FaceSoup {
        tris: mesh.tris.clone(),
        owner: (0..n).map(|i| tri_gmsh_number(mesh, i)).collect(),
        tag: mesh.tri_tags.clone(),
        // §6.3: a tet mesh's surfaces are fully unmasked. A mask survives only when the reader made
        // one, which happens exactly for the n-gon formats (STL/PLY/OBJ, FreeSurfer quad files).
        edge_mask: mesh.tri_edge_mask.clone(),
    };
    p.report(Phase::Index, n as u64, n as u64);
    Ok(assemble(
        &mesh.nodes,
        soup,
        variant,
        OrientReport::default(),
    ))
}

/// The four faces of a tet, as `(sorted triple, apex)`. Face *i* is the one opposite vertex *i*.
fn tet_face(t: &[u32; 4], i: usize) -> ([u32; 3], u32) {
    let mut f = [0u32; 3];
    let mut k = 0;
    for (j, &v) in t.iter().enumerate() {
        if j != i {
            f[k] = v;
            k += 1;
        }
    }
    f.sort_unstable();
    (f, t[i])
}

/// Wind `f` so its normal points **away** from the apex.
fn outward(nodes: &[[f32; 3]], f: [u32; 3], apex: u32) -> [u32; 3] {
    let (a, b, c, d) = (
        nodes[f[0] as usize],
        nodes[f[1] as usize],
        nodes[f[2] as usize],
        nodes[apex as usize],
    );
    if signed_volume6(a, b, c, d) > 0.0 {
        [f[0], f[2], f[1]]
    } else {
        f
    }
}

fn in_mask(mask: Option<&BitMask>, i: usize) -> bool {
    mask.is_none_or(|m| m.get(i))
}

/// Unique-face boundary of the (optionally masked) tet set (§6.3).
///
/// Keeps **singletons and tag-differing pairs**, so a tri-less mesh comes back with the same face
/// set its tri-carrying twin stores. Faces are emitted in one canonical order — bucketed on the
/// minimum vertex, then `(v1, v2)` — which is also the order `build_topology` produces, so the two
/// paths below are byte-identical.
pub fn extract_boundary(
    mesh: &Mesh,
    topo: Option<&TetTopology>,
    mask: Option<&BitMask>,
    variant: SurfaceVariant,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let mut owner: Vec<u32> = Vec::new();
    let mut tag: Vec<i32> = Vec::new();
    let n_tets = mesh.tets.len();

    match topo {
        Some(topo) => {
            p.report(Phase::Topology, 0, topo.faces.len() as u64);
            for (i, f) in topo.faces.iter().enumerate() {
                let ft = topo.face_tets[i];
                let a = ft[0];
                let b = ft[1];
                let a_in = a >= 0 && in_mask(mask, a as usize);
                let b_in = b >= 0 && in_mask(mask, b as usize);
                let owner_tet = match (a_in, b_in) {
                    (false, false) => continue,
                    (true, false) => a as usize,
                    (false, true) => b as usize,
                    (true, true) => {
                        if mesh.tet_tags[a as usize] == mesh.tet_tags[b as usize] {
                            continue;
                        }
                        a as usize
                    }
                };
                let apex = apex_of(&mesh.tets[owner_tet], f);
                push_face(mesh, owner_tet, *f, apex, &mut tris, &mut owner, &mut tag);
            }
        }
        None => {
            // One-shot counting sort of the 4.N canonical face keys (§6.3). The key buffer is
            // dropped before this function returns — it is the transient that the [MODEL] budget of
            // ~227 MB on ernie refers to.
            p.report(Phase::Topology, 0, n_tets as u64);
            if p.aborted() {
                return Err(Error::Cancelled);
            }
            let faces = MinBuckets::<3>::build(mesh.nodes.len(), |emit| {
                for (t, tet) in mesh.tets.iter().enumerate() {
                    if !in_mask(mask, t) {
                        continue;
                    }
                    for i in 0..4 {
                        let (f, _) = tet_face(tet, i);
                        emit(f[0], [f[1], f[2], (t as u32) * 4 + i as u32]);
                    }
                }
            });
            for k in 0..mesh.nodes.len() {
                for_each_run(faces.group(k), 2, |run| {
                    let keep_it = match run.len() {
                        1 => true,
                        2 => {
                            let t0 = (run[0][2] / 4) as usize;
                            let t1 = (run[1][2] / 4) as usize;
                            mesh.tet_tags[t0] != mesh.tet_tags[t1]
                        }
                        // A face shared by three or more tets is non-manifold input; emit it once
                        // rather than dropping real geometry, and let `orient_surface` count it.
                        _ => true,
                    };
                    if !keep_it {
                        return;
                    }
                    let packed = run[0][2];
                    let (t, i) = ((packed / 4) as usize, (packed % 4) as usize);
                    let (f, apex) = tet_face(&mesh.tets[t], i);
                    push_face(mesh, t, f, apex, &mut tris, &mut owner, &mut tag);
                });
            }
            drop(faces);
        }
    }

    if p.aborted() {
        return Err(Error::Cancelled);
    }
    // The faces were wound outward from their owning tet one by one; `orient_surface` is what turns
    // that into a globally consistent surface and produces the report the UI shows.
    let orient = orient_surface(&mesh.nodes, &mut tris);
    p.report(Phase::Topology, n_tets as u64, n_tets as u64);
    Ok(assemble(
        &mesh.nodes,
        FaceSoup {
            tris,
            owner,
            tag,
            edge_mask: None,
        },
        variant,
        orient,
    ))
}

/// Wind one tet face outward and record its owner and tag.
#[allow(clippy::too_many_arguments)]
fn push_face(
    mesh: &Mesh,
    t: usize,
    f: [u32; 3],
    apex: u32,
    tris: &mut Vec<[u32; 3]>,
    owner: &mut Vec<u32>,
    tag: &mut Vec<i32>,
) {
    tris.push(outward(&mesh.nodes, f, apex));
    owner.push(tet_gmsh_number(mesh, t));
    tag.push(mesh.tet_tags[t]);
}

/// The vertex of `tet` that is not in the sorted face `f`.
fn apex_of(tet: &[u32; 4], f: &[u32; 3]) -> u32 {
    for &v in tet {
        if !f.contains(&v) {
            return v;
        }
    }
    tet[0]
}

/// Unique tet faces and their owners (§6.3). Explicit, awaitable, progress-reporting — never called
/// lazily from inside a drag.
///
/// Carries no `tet_faces`: nothing consumes it and it would cost 75.6 MB on ernie `[MODEL]`.
pub fn build_topology(mesh: &Mesh, p: &mut dyn ProgressSink) -> Result<TetTopology> {
    let n_tets = mesh.tets.len();
    p.report(Phase::Topology, 0, n_tets as u64);
    if p.aborted() {
        return Err(Error::Cancelled);
    }
    let buckets = MinBuckets::<3>::build(mesh.nodes.len(), |emit| {
        for (t, tet) in mesh.tets.iter().enumerate() {
            for i in 0..4 {
                let (f, _) = tet_face(tet, i);
                emit(f[0], [f[1], f[2], (t as u32) * 4 + i as u32]);
            }
        }
    });
    let mut faces: Vec<[u32; 3]> = Vec::new();
    let mut face_tets: Vec<[i32; 2]> = Vec::new();
    for k in 0..mesh.nodes.len() {
        if p.aborted() {
            return Err(Error::Cancelled);
        }
        for_each_run(buckets.group(k), 2, |run| {
            faces.push([k as u32, run[0][0], run[0][1]]);
            let t0 = (run[0][2] / 4) as i32;
            // Runs are sorted, so `run[0]` is the lowest-numbered owning tet — the deterministic
            // choice that makes `extract_boundary`'s two paths agree.
            let t1 = if run.len() >= 2 {
                (run[1][2] / 4) as i32
            } else {
                -1
            };
            face_tets.push([t0, t1]);
        });
    }
    p.report(Phase::Topology, n_tets as u64, n_tets as u64);
    Ok(TetTopology { faces, face_tets })
}
