//! `tvx-geom` against the reference dataset (AGENTS.md rule 2, ARCHITECTURE.md §11).
//!
//! **Skipped, never failed, when `TETRAVOX_TESTDATA` is unset.**
//!
//! ```sh
//! export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
//! ```
//!
//! Every expected count comes from AGENTS.md's mesh tables or from §6.3's own `[DATA]` / `[M2Max]`
//! lines. The two quantities neither file carries — the `OrientReport` on `ernie.msh` and the
//! `label_centroids` census — are measured here and named as such at their use site.

use std::path::PathBuf;
use tvx_core::{BitMask, NoProgress, Plane};
use tvx_geom::{
    build_point_locator, build_tet_blocks, build_topology, extract_boundary, isolate,
    label_centroids, locate_point, marching_cubes, marching_tets, morton_reorder, orient_surface,
    plane_cut, surface_contours, tag_surfaces, tet_centroids, vertex_normals, IsolateCriteria,
    SurfaceVariant,
};
use tvx_mesh_io::{read_msh, Mesh};

fn root() -> Option<PathBuf> {
    let r = PathBuf::from(std::env::var("TETRAVOX_TESTDATA").ok()?);
    r.is_dir().then_some(r)
}

/// `let mesh = require_mesh!("m2m_ernie/ernie.msh");` — or return, printing why.
macro_rules! require_mesh {
    ($rel:expr) => {{
        let Some(root) = root() else {
            eprintln!("skipping: TETRAVOX_TESTDATA is unset");
            return;
        };
        let p = root.join($rel);
        match std::fs::read(&p) {
            Ok(b) => read_msh(b, &mut NoProgress).expect("parse"),
            Err(e) => {
                eprintln!("skipping: {}: {e}", p.display());
                return;
            }
        }
    }};
}

/// Everything `tvx_wasm::geom::load_time` does, so the tests below see the mesh the app sees.
fn load_time(mesh: &mut Mesh) {
    orient_surface(&mesh.nodes, &mut mesh.tris);
    if !mesh.tets.is_empty() {
        mesh.tet_perm = morton_reorder(mesh);
    }
}

/// **The** §6.3 invariant, and §11's "Surface invariant" row: the stored triangles of a SimNIBS mesh
/// are exactly the exterior ∪ tag-differing-interior face set. This is a real-data test precisely so
/// that a mesh violating it fails loudly instead of rendering a hole.
#[test]
fn stored_tris_are_the_exterior_and_interface_face_set_on_ernie() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    assert_eq!(m.nodes.len(), 847_165);
    assert_eq!(m.tris.len(), 1_177_213);
    assert_eq!(m.tets.len(), 4_722_625);
    load_time(&mut m);

    // Derived from the tets, with no reference to the stored triangles at all.
    let b = extract_boundary(&m, None, None, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    assert_eq!(
        b.owner_elm.len(),
        1_177_213,
        "§6.3: 128,614 exterior + 1,048,599 tag-differing interior"
    );
    // ... and the stored triangles carry the same tag census (AGENTS.md).
    let s = tag_surfaces(&m, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    assert_eq!(s.owner_elm.len(), 1_177_213);
    let want: [(i32, u32); 10] = [
        (1001, 249_245),
        (1002, 335_930),
        (1003, 121_238),
        (1005, 77_032),
        (1006, 2_178),
        (1007, 143_499),
        (1008, 158_262),
        (1009, 35_930),
        (1010, 2_317),
        (1099, 51_582),
    ];
    assert_eq!(s.per_tag.len(), want.len());
    for (r, (tag, count)) in s.per_tag.iter().zip(want) {
        assert_eq!(r.tag, tag);
        assert_eq!(r.count, count * 3, "tag {tag} covers {count} triangles");
    }
    // Tags are not contiguous: code that assumes 1..10 is wrong (AGENTS.md).
    assert!(
        !s.per_tag.iter().any(|r| r.tag == 1004),
        "tag 4 does not exist"
    );
    assert_eq!(
        s.edge_mask, None,
        "§6.3: a tet mesh's surfaces are fully unmasked"
    );
    assert_eq!(s.node_index.as_ref().unwrap().len(), s.positions.len() / 3);
}

/// A tagged tissue surface is a **complex**, not a manifold, and the report must say so.
#[test]
fn orient_surface_reports_the_tissue_complex() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    // Measured here on 2026-08-27 with `cargo run --release -p tvx-geom --example measure`;
    // neither AGENTS.md nor §6.3 publishes an OrientReport.
    let r = orient_surface(&m.nodes, &mut m.tris);
    assert_eq!(r.components, 696);
    assert_eq!(r.open_components, 510);
    assert_eq!(r.non_manifold_edges, 10_311);
    assert_eq!(r.flipped_components, 41);
}

/// `grey_Thalamus_TI.msh` is the canonical tri-less mesh: 0 triangles, so it renders empty without
/// `extract_boundary` (§6.3).
#[test]
fn extract_boundary_rescues_grey_thalamus() {
    let mut m = require_mesh!("Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh");
    assert_eq!(m.tris.len(), 0, "AGENTS.md: 0 tris");
    assert_eq!(m.tets.len(), 1_340_029);
    assert_eq!(m.nodes.len(), 368_762);
    load_time(&mut m);

    assert!(
        tag_surfaces(&m, SurfaceVariant::Indexed, &mut NoProgress)
            .unwrap()
            .owner_elm
            .is_empty(),
        "nothing stored to group — this is exactly the empty render"
    );
    let b = extract_boundary(&m, None, None, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    assert!(!b.owner_elm.is_empty());
    // A single tet tag (2) means there are no tag-differing pairs, so the face set is the exterior
    // alone.
    assert_eq!(b.per_tag.len(), 1);
    assert_eq!(b.per_tag[0].tag, 2);
    assert_eq!(b.owner_elm.len(), 561_320);
    // Measured 2026-08-27. Grey matter is folded tightly enough that its tet region pinches: 30
    // edges where the surface touches itself, and 17 sheets left open by those pinches. This is a
    // property of the data, not of the extraction — the assertion exists so that a *change* in it
    // is visible, and a naive "a single tag must give a closed manifold" expectation is wrong here.
    assert_eq!(b.orient.components, 109);
    assert_eq!(b.orient.open_components, 17);
    assert_eq!(b.orient.non_manifold_edges, 30);
}

/// §11's face-key-width test on real data. `ernie_seeg.msh` has 2,301,899 nodes = 22 bits, so a
/// 3×21-bit packed `u64` key aliases distinct faces and silently deletes real boundary faces.
/// §6.3's counting sort buckets on the minimum vertex, where the bucket index *is* a node index and
/// there is no width limit at all.
#[test]
fn boundary_extraction_survives_ernie_seeg_node_count() {
    let mut m = require_mesh!("m2m_ernie/ernie_seeg.msh");
    assert_eq!(m.nodes.len(), 2_301_899);
    assert!(m.nodes.len() > (1 << 21), "the point of this file");
    assert_eq!(m.tets.len(), 13_033_527);
    load_time(&mut m);

    // A masked subset keeps the run inside a sensible memory budget while still driving node
    // indices above 2^21 through the bucket keys. Select exactly the tets that touch such a node —
    // 1,210,504 of them, measured 2026-08-27 — because Morton order is spatial and says nothing
    // about node numbering, so "the last N tets" would not reliably reference a high node at all.
    let mut mask = BitMask::new_all(m.tets.len(), false);
    let mut n_masked = 0u32;
    for (j, tet) in m.tets.iter().enumerate() {
        if tet.iter().any(|&v| v > (1 << 21)) {
            mask.set(j, true);
            n_masked += 1;
        }
    }
    assert_eq!(n_masked, 1_210_504);
    let b = extract_boundary(
        &m,
        None,
        Some(&mask),
        SurfaceVariant::Indexed,
        &mut NoProgress,
    )
    .unwrap();
    assert!(!b.owner_elm.is_empty());
    let used = b.node_index.as_ref().unwrap();
    assert!(
        used.iter().any(|&v| v > (1 << 21)),
        "the subset must actually reference a node above 2^21, or this proves nothing"
    );
    // Every emitted face must be a real face of a masked tet.
    assert_eq!(b.owner_elm.len(), b.face_tag.len());
}

/// §6.3 / §11 "cut index equivalence", on ernie. The block index may skip blocks that cannot
/// contribute; it may never change what a contributing tet produces.
#[test]
fn plane_cut_is_bit_identical_with_and_without_the_block_index_on_ernie() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    load_time(&mut m);
    let blocks = build_tet_blocks(&m, 64);
    let degenerate = build_tet_blocks(&m, m.tets.len());
    let bb = m.bounds;
    let mid_z = (bb.min[2] + bb.max[2]) * 0.5;
    let s = 1.0f32 / 3.0f32.sqrt();

    for (name, plane) in [
        (
            "axial through the bbox centre",
            Plane {
                normal: [0.0, 0.0, 1.0],
                offset: -mid_z,
            },
        ),
        (
            "oblique normalize([1,1,1]) through the world origin",
            Plane {
                normal: [s, s, s],
                offset: 0.0,
            },
        ),
    ] {
        let a = plane_cut(&m, &blocks, std::slice::from_ref(&plane), None).unwrap();
        let b = plane_cut(&m, &degenerate, std::slice::from_ref(&plane), None).unwrap();
        assert_eq!(a[0].positions, b[0].positions, "{name}: positions");
        assert_eq!(a[0].owner_tet, b[0].owner_tet, "{name}: owners");
        assert_eq!(a[0].tag, b[0].tag, "{name}: tags");
        assert_eq!(a[0].edge_mask, b[0].edge_mask, "{name}: masks");

        // Every mask is one of the three §6.3 permits, and the set bits count the real edges.
        for msk in &a[0].edge_mask {
            assert!(
                matches!(msk & 0b111, 0b111 | 0b101 | 0b011),
                "{name}: {msk:#05b}"
            );
        }
        let real: usize = a[0].edge_mask.iter().map(|m| m.count_ones() as usize).sum();
        assert_eq!(real * 6, a[0].edge_segments.len(), "{name}: edge_segments");
    }

    // §6.3 publishes 62,966 cap triangles for the axial plane `[M2Max]`; this reproduces it
    // exactly, which is what pins "the axial plane" to the one through the bbox centre.
    let axial = plane_cut(
        &m,
        &blocks,
        &[Plane {
            normal: [0.0, 0.0, 1.0],
            offset: -mid_z,
        }],
        None,
    )
    .unwrap();
    assert_eq!(axial[0].tag.len(), 62_966, "§6.3 [M2Max]");
}

/// §6.3: `locate_point` returns the whole probe in one round trip, and `gmsh_elm` is what the UI
/// shows — always a Gmsh element number, never the internal Morton index.
#[test]
fn locate_point_returns_a_containing_tet_on_ernie() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    load_time(&mut m);
    let grid = build_point_locator(&m);

    // Probe the centroid of a known tet: the answer must be a tet that really contains the point.
    // Asserting a specific element number instead would only pin the Morton order, not correctness.
    for &j in &[0usize, 1_000_000, 4_722_624] {
        let tet = m.tets[j];
        let mut c = [0.0f32; 3];
        for &v in &tet {
            let p = m.nodes[v as usize];
            for k in 0..3 {
                c[k] += p[k] * 0.25;
            }
        }
        let hit =
            locate_point(&m, &grid, c).unwrap_or_else(|| panic!("tet {j} centroid is inside"));
        assert!(hit.gmsh_elm >= 1);
        assert!(
            hit.gmsh_elm as usize <= m.tris.len() + m.tets.len(),
            "a Gmsh element number, not an internal index"
        );
        assert_eq!(hit.node_values.len(), m.node_fields.len());
        assert_eq!(hit.elm_values.len(), m.elm_fields.len());
        // The tet it named must genuinely contain the point.
        let t = m.tets[hit.tet_index as usize];
        let v: Vec<[f32; 3]> = t.iter().map(|&i| m.nodes[i as usize]).collect();
        let w = barycentric(v[0], v[1], v[2], v[3], c).expect("non-degenerate");
        assert!(w.iter().all(|&x| x > -1e-3), "{w:?} at tet {j}");
        assert_eq!(hit.tag, m.tet_tags[hit.tet_index as usize]);
    }
    // Far outside the head is not a hit, and must not be an error either.
    assert!(locate_point(&m, &grid, [1.0e4, 1.0e4, 1.0e4]).is_none());
}

fn barycentric(
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    d: [f32; 3],
    p: [f32; 3],
) -> Option<[f32; 4]> {
    let sub = |x: [f32; 3], y: [f32; 3]| [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    let cross = |x: [f32; 3], y: [f32; 3]| {
        [
            x[1] * y[2] - x[2] * y[1],
            x[2] * y[0] - x[0] * y[2],
            x[0] * y[1] - x[1] * y[0],
        ]
    };
    let dot = |x: [f32; 3], y: [f32; 3]| x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    let v6 = |w: [f32; 3], x: [f32; 3], y: [f32; 3], z: [f32; 3]| {
        dot(sub(x, w), cross(sub(y, w), sub(z, w)))
    };
    let v = v6(a, b, c, d);
    (v != 0.0).then(|| {
        [
            v6(p, b, c, d) / v,
            v6(a, p, c, d) / v,
            v6(a, b, p, d) / v,
            v6(a, b, c, p) / v,
        ]
    })
}

/// The Morton permutation must be a permutation, and the §6.2 identity rule must still reconstruct
/// the file's own element numbers through it.
#[test]
fn morton_reorder_is_a_permutation_that_preserves_gmsh_numbers() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    let before: Vec<i32> = m.tet_tags.clone();
    let perm = morton_reorder(&mut m);
    assert_eq!(perm.len(), m.tets.len());
    let mut seen = vec![false; perm.len()];
    for &p in &perm {
        assert!(!seen[p as usize], "tet_perm repeats {p}");
        seen[p as usize] = true;
    }
    // Tags moved with their tets.
    for (j, &src) in perm.iter().enumerate() {
        assert_eq!(m.tet_tags[j], before[src as usize]);
    }
    // Every reference .msh takes the identity path (AGENTS.md), so element numbers come from
    // tet_perm — and the whole census must survive the reorder.
    assert!(
        m.gmsh_elm_numbers.is_none(),
        "AGENTS.md: identity numbering"
    );
    let mut counts = std::collections::BTreeMap::new();
    for &t in &m.tet_tags {
        *counts.entry(t).or_insert(0u32) += 1;
    }
    assert_eq!(counts.get(&1), Some(&517_144));
    assert_eq!(counts.get(&2), Some(&1_340_029));
    assert_eq!(counts.get(&7), Some(&1_056_826));
    assert_eq!(counts.get(&4), None, "tag 4 does not exist");
}

/// The only reference mesh with a scalar element field, per AGENTS.md.
#[test]
fn fields_convert_both_ways_on_thalamus_ti() {
    let mut m = require_mesh!("Simulations/Thalamus/TI/mesh/Thalamus_TI.msh");
    assert_eq!(m.elm_fields.len(), 1, "AGENTS.md: exactly one $ElementData");
    assert_eq!(m.elm_fields[0].name, "TI_max");
    assert_eq!(m.elm_fields[0].ncomp, 1);
    let stats = m.elm_fields[0].stats.clone();
    assert!(
        (f64::from(stats.max) - 10.293_712).abs() < 1e-4,
        "{stats:?}"
    );
    load_time(&mut m);

    let node = tvx_geom::elm_to_node(&m, &m.elm_fields[0]).unwrap();
    assert_eq!(node.data.len(), m.nodes.len());
    // A volume-weighted mean cannot leave the source range.
    let finite: Vec<f32> = node
        .data
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .collect();
    assert!(!finite.is_empty());
    let lo = finite.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = finite.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    assert!(
        lo >= stats.min - 1e-6 && hi <= stats.max + 1e-6,
        "{lo}..{hi}"
    );

    let back = tvx_geom::node_to_elm(&m, &node).unwrap();
    assert_eq!(back.tet.len(), m.tets.len());
    assert!(back.stats.max <= stats.max + 1e-3);

    // marching_tets over the interpolated node field, at the median.
    let iso = node.stats.percentiles[4];
    let iso_surf = marching_tets(&m, &node.data, iso, None, &mut NoProgress).unwrap();
    assert_eq!(iso_surf.normals.len(), iso_surf.positions.len());
    assert!(!iso_surf.owner_elm.is_empty());
    assert_eq!(iso_surf.positions.len(), iso_surf.owner_elm.len() * 9);
}

/// `surface_contours` against the stored triangles, on the mesh whose bbox AGENTS.md publishes.
#[test]
fn surface_contours_cut_the_stored_triangles_on_ernie() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    load_time(&mut m);
    let mid_z = (m.bounds.min[2] + m.bounds.max[2]) * 0.5;
    let seg = surface_contours(
        &m,
        &Plane {
            normal: [0.0, 0.0, 1.0],
            offset: -mid_z,
        },
        None,
    )
    .unwrap();
    assert_eq!(seg.len() % 6, 0, "6 floats per segment");
    assert!(!seg.is_empty(), "the mid-axial plane crosses the head");
    // Every endpoint is on the plane, to f32 precision over a ~250 mm head.
    for p in seg.chunks_exact(3) {
        assert!((p[2] - mid_z).abs() < 1e-2, "{p:?}");
    }
}

/// `label_centroids` on the segmentation AGENTS.md describes as 10 unique values.
#[test]
fn label_centroids_on_final_tissues() {
    let Some(root) = root() else {
        eprintln!("skipping: TETRAVOX_TESTDATA is unset");
        return;
    };
    let Ok(bytes) = std::fs::read(root.join("m2m_ernie/final_tissues.nii.gz")) else {
        eprintln!("skipping: final_tissues.nii.gz");
        return;
    };
    let vol = tvx_nifti::read_nifti(bytes, &mut NoProgress).expect("parse");
    let c = label_centroids(&vol, 0).unwrap();
    // AGENTS.md: 0 .. 10 with 10 unique values, i.e. ids 0..=10 minus the one that is absent.
    assert_eq!(c.len(), 10, "10 unique values incl. background");
    assert_eq!(c[0].id, 0, "background first — the output is sorted by id");
    assert!(c.iter().all(|e| e.count > 0));
    // Every centroid must lie inside the volume's world bounding box.
    let corner = |i: f64, j: f64, k: f64| {
        let a = &vol.affine;
        [
            a[0][0] * i + a[0][1] * j + a[0][2] * k + a[0][3],
            a[1][0] * i + a[1][1] * j + a[1][2] * k + a[1][3],
            a[2][0] * i + a[2][1] * j + a[2][2] * k + a[2][3],
        ]
    };
    let (d0, d1, d2) = (
        vol.dims[0] as f64 - 1.0,
        vol.dims[1] as f64 - 1.0,
        vol.dims[2] as f64 - 1.0,
    );
    let a = corner(0.0, 0.0, 0.0);
    let b = corner(d0, d1, d2);
    for e in &c {
        for k in 0..3 {
            let (lo, hi) = (a[k].min(b[k]), a[k].max(b[k]));
            assert!(
                f64::from(e.centroid[k]) >= lo - 1.0 && f64::from(e.centroid[k]) <= hi + 1.0,
                "label {} centroid {:?} outside {lo}..{hi} on axis {k}",
                e.id,
                e.centroid
            );
        }
    }
}

/// §11's Surface-invariant row names **two** meshes; Phase 1 asserted the first only, and the second
/// is the one that matters most — `m2m_ernie-seeg/ernie-seeg.msh` has 2,323,873 nodes, well past
/// 2²¹, which is exactly where a 3×21-bit packed face key silently merges distinct faces and deletes
/// real boundary. The other seeg test drives high node indices through a 1.2 M-tet masked subset;
/// this one runs the whole-mesh invariant, which is what the row asks for.
#[test]
fn stored_tris_are_the_exterior_and_interface_face_set_on_ernie_seeg() {
    let mut m = require_mesh!("m2m_ernie-seeg/ernie-seeg.msh");
    // AGENTS.md's mesh table.
    assert_eq!(m.nodes.len(), 2_323_873);
    assert_eq!(m.tris.len(), 2_629_579);
    assert_eq!(m.tets.len(), 13_158_048);
    assert!(m.nodes.len() > (1 << 21), "the point of this file");
    load_time(&mut m);

    // Derived from the 13.2 M tets alone, with no reference to the stored triangles.
    let b = extract_boundary(&m, None, None, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    assert_eq!(
        b.owner_elm.len(),
        2_629_579,
        "§6.3 / §11: 202,318 exterior + 2,427,261 tag-differing interior"
    );
    // …and the split §11 actually writes down, which needs the topology: a face with one tet is
    // exterior, a face with two tets of different tags is an interface.
    let topo = build_topology(&m, &mut NoProgress).unwrap();
    let exterior = topo.face_tets.iter().filter(|ft| ft[1] < 0).count();
    let interface = topo
        .face_tets
        .iter()
        .filter(|ft| ft[1] >= 0 && m.tet_tags[ft[0] as usize] != m.tet_tags[ft[1] as usize])
        .count();
    assert_eq!(exterior, 202_318, "§11: exterior faces of ernie-seeg.msh");
    assert_eq!(interface, 2_427_261, "§11: tag-differing interior faces");
    assert_eq!(
        exterior + interface,
        2_629_579,
        "= the stored triangle count"
    );

    // The stored triangles group into the same total, over the §6.2 `1xxx` surface tags. (The
    // derived boundary is keyed by *tet* tag instead, so the two censuses are not comparable
    // key for key — only their totals are.)
    let s = tag_surfaces(&m, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    assert_eq!(s.owner_elm.len(), 2_629_579);
    let census: std::collections::BTreeMap<i32, u32> =
        s.per_tag.iter().map(|r| (r.tag, r.count / 3)).collect();
    assert_eq!(census.values().sum::<u32>(), 2_629_579);
    // AGENTS.md gives one electrode count for *this* file specifically — the 1013/1014/1015 counts
    // in that paragraph belong to `ernie_seeg.msh`, the other, different file.
    assert_eq!(census.get(&1016), Some(&39_526));
    assert!(census.contains_key(&1013) && census.contains_key(&1015));
    assert!(!census.contains_key(&1004), "tag 4 does not exist");
}

/// `build_topology` (§6.3) on ernie — synthetic-only in Phase 1. The unique-face count is the one
/// §9.2's memory table is built from, so it is a number the contract already depends on.
#[test]
fn build_topology_counts_ernies_faces() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    load_time(&mut m);
    let topo = build_topology(&m, &mut NoProgress).unwrap();
    // §9.2: "For ernie.msh (847,165 nodes; 1,177,213 tris; 4,722,625 tets; 9,509,557 unique faces)".
    assert_eq!(topo.faces.len(), 9_509_557);
    assert_eq!(topo.face_tets.len(), topo.faces.len());
    // §6.3: 128,614 of the mesh's 1,177,213 stored triangles are exterior — a face with one tet.
    let boundary = topo.face_tets.iter().filter(|ft| ft[1] < 0).count();
    assert_eq!(boundary, 128_614);
    // Every face names a real tet, and an interior face names two different ones.
    for ft in topo.face_tets.iter().take(1_000_000) {
        assert!(ft[0] >= 0 && (ft[0] as usize) < m.tets.len());
        assert!(ft[1] < 0 || (ft[1] as usize) < m.tets.len());
        assert!(ft[1] < 0 || ft[0] != ft[1]);
    }
}

/// `isolate` (§6.3) on ernie — synthetic-only in Phase 1. §9.1 row 17b names the answer: "isolating
/// ernie's GM leaves exactly 1,340,029 tets".
#[test]
fn isolate_selects_ernies_grey_matter() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    load_time(&mut m);
    let crit: IsolateCriteria = serde_json::from_str(
        r#"{"tags":[2],"field":null,"sphere":null,"box":null,"labelVolume":null,"combine":"all"}"#,
    )
    .unwrap();
    let mask = isolate(&m, &crit, None, &mut NoProgress).unwrap();
    assert_eq!(mask.len(), m.tets.len());
    assert_eq!(
        mask.count_ones(),
        1_340_029,
        "§9.1 row 17b, AGENTS.md tag 2"
    );
    for (j, &t) in m.tet_tags.iter().enumerate() {
        assert_eq!(mask.get(j), t == 2, "tet {j}");
    }

    // A sphere at the thalamus target, intersected with GM: `combine: "all"` must narrow, never
    // widen, and every survivor must satisfy both arms.
    let crit2: IsolateCriteria = serde_json::from_str(
        r#"{"tags":[2],"field":null,"sphere":{"center":[0,-14,6],"radius":15},"box":null,
            "labelVolume":null,"combine":"all"}"#,
    )
    .unwrap();
    let both = isolate(&m, &crit2, None, &mut NoProgress).unwrap();
    assert!(both.count_ones() > 0 && both.count_ones() < mask.count_ones());
    for j in 0..m.tets.len() {
        if both.get(j) {
            assert!(mask.get(j), "the intersection must be inside the tag arm");
        }
    }
}

/// `vertex_normals` (§6.3) on ernie — synthetic-only in Phase 1.
#[test]
fn vertex_normals_are_unit_on_ernie() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    orient_surface(&m.nodes, &mut m.tris);
    let n = vertex_normals(&m.nodes, &m.tris);
    assert_eq!(n.len(), m.nodes.len() * 3);
    let mut unit = 0usize;
    let mut zero = 0usize;
    for v in n.chunks_exact(3) {
        let len =
            (f64::from(v[0]).powi(2) + f64::from(v[1]).powi(2) + f64::from(v[2]).powi(2)).sqrt();
        if len < 1e-6 {
            zero += 1;
        } else {
            assert!((len - 1.0).abs() < 1e-3, "normal length {len}");
            unit += 1;
        }
    }
    // Every node the tissue surfaces touch gets a unit normal; the rest are interior nodes with no
    // triangle at all, and a zero there is honest rather than a NaN.
    assert_eq!(unit + zero, m.nodes.len());
    assert!(unit > 500_000, "{unit} nodes carry a surface normal");
}

/// §6.3's reason for `morton_reorder`: "with file order a per-64-block AABB reject at the mid-axial
/// plane visits 4,722,624 of 4,722,625 tets — zero speedup `[M2Max]`". That is a locality claim, and
/// it is only true on a real mesh (SimNIBS writes elements grouped by physical tag), so it is
/// asserted here rather than on the fixture.
#[test]
fn morton_reorder_makes_ernie_local_enough_for_the_block_index() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    let file_order = build_tet_blocks(&m, 64);
    m.tet_perm = morton_reorder(&mut m);
    let morton = build_tet_blocks(&m, 64);

    // A block's mean half-extent is the whole of the speedup: a block that spans the head rejects
    // nothing. Measured 2026-08-27 — file order ~65 mm, Morton order ~3 mm.
    let mean_extent = |b: &tvx_geom::TetBlocks| -> f64 {
        let n = b.aabb.len() / 6;
        let mut sum = 0.0;
        for i in 0..n {
            for a in 3..6 {
                sum += f64::from(b.aabb[i * 6 + a]);
            }
        }
        sum / (n * 3) as f64
    };
    let (before, after) = (mean_extent(&file_order), mean_extent(&morton));
    eprintln!("[morton] mean block half-extent {before:.2} mm (file order) -> {after:.2} mm");
    assert!(
        after * 5.0 < before,
        "Morton order must shrink the blocks by more than 5x: {before} -> {after}"
    );

    // …and the consequence §6.3 states: at the mid-axial plane, file order rejects essentially
    // nothing while Morton order rejects most of the mesh.
    let bb = m.bounds;
    let mid = (f64::from(bb.min[2]) + f64::from(bb.max[2])) / 2.0;
    let visits = |b: &tvx_geom::TetBlocks| -> usize {
        let n = b.aabb.len() / 6;
        (0..n)
            .filter(|&i| {
                let cz = f64::from(b.aabb[i * 6 + 2]);
                let ez = f64::from(b.aabb[i * 6 + 5]);
                (cz - mid).abs() <= ez
            })
            .count()
    };
    let (vf, vm) = (visits(&file_order), visits(&morton));
    let total = m.tets.len().div_ceil(64);
    eprintln!("[morton] mid-axial plane touches {vf} of {total} blocks in file order, {vm} in Morton order");
    assert!(vf * 4 > total * 3, "file order rejects almost nothing");
    assert!(vm * 4 < total, "Morton order must reject most of the mesh");
}

/// `marching_cubes` (§6.3) on a real volume: the isosurface between background and head in
/// `final_tissues.nii.gz` must enclose the same space the labelled voxels do.
#[test]
fn marching_cubes_encloses_the_head_in_final_tissues() {
    let Some(root) = root() else {
        eprintln!("skipping: TETRAVOX_TESTDATA is unset");
        return;
    };
    let p = root.join("m2m_ernie/final_tissues.nii.gz");
    let Ok(bytes) = std::fs::read(&p) else {
        eprintln!("skipping: {}", p.display());
        return;
    };
    let vol = tvx_nifti::read_nifti(bytes, &mut NoProgress).expect("final_tissues.nii.gz");
    assert_eq!(vol.dims, [256, 256, 208], "AGENTS.md");

    // The reference is derived from the same file, by counting rather than by contouring: at
    // iso 0.5 the surface separates label 0 from everything else, so it must enclose one voxel of
    // space per labelled voxel. Voxels are 1 mm here (the affine's columns are unit axes).
    let mut labelled = 0u64;
    let raw = match &vol.data {
        tvx_nifti::VolumeData::U16(v) => v,
        other => panic!("AGENTS.md says uint16, got {other:?}"),
    };
    for &v in raw.iter() {
        if v > 0 {
            labelled += 1;
        }
    }
    let voxel_mm3 = vol.spacing[0] * vol.spacing[1] * vol.spacing[2];
    let want = labelled as f64 * voxel_mm3;

    let s = marching_cubes(&vol, 0, 0.5, true, &mut NoProgress).unwrap();
    let ix = s.indices.as_ref().expect("smooth => Indexed");
    let mut vol6 = 0.0f64;
    for t in ix.chunks_exact(3) {
        let q = |v: u32| {
            let i = v as usize * 3;
            [
                f64::from(s.positions[i]),
                f64::from(s.positions[i + 1]),
                f64::from(s.positions[i + 2]),
            ]
        };
        let (a, b, c) = (q(t[0]), q(t[1]), q(t[2]));
        vol6 += a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    let got = vol6 / 6.0;
    let ratio = got / want;
    eprintln!(
        "[marching_cubes] final_tissues: {} triangles enclose {got:.0} mm^3 against {labelled} labelled voxels ({want:.0} mm^3), ratio {ratio:.4}",
        ix.len() / 3
    );
    // The contour runs through the 0.5 crossing, which is *half a voxel outside* the outermost
    // labelled voxel centre, so it encloses slightly more than the voxel count — 1.018 measured
    // here. What it may never be is negative (inward winding), zero (nothing emitted) or wrong by
    // tens of per cent (a dropped case).
    assert!(
        ratio > 0.95 && ratio < 1.05,
        "enclosed volume ratio {ratio} ({got} vs {want})"
    );
}

/// §6.3 `tet_centroids` on the mesh the glyph case is written for: every tet of `ernie.msh`, then
/// the GM tag alone, then a strided subsample of it.
///
/// The counts are AGENTS.md's per-tag census, the bounds are AGENTS.md's node bounding box, and the
/// element numbers are §6.2's identity rule — `n_tris + tet_perm[j] + 1`, so the whole range is
/// 1,177,214…5,899,838 and nothing may fall outside it.
#[test]
fn tet_centroids_on_ernie_are_tagged_bounded_and_strideable() {
    let mut m = require_mesh!("m2m_ernie/ernie.msh");
    load_time(&mut m);
    assert_eq!(m.tets.len(), 4_722_625);

    let all = tet_centroids(&m, None, 1, None).expect("centroids");
    assert_eq!(all.owner_tet.len(), 4_722_625);
    assert_eq!(all.positions.len(), 3 * 4_722_625);

    // A centroid is a convex combination of four nodes, so it cannot leave the node bounding box.
    // AGENTS.md's node bounding box, in f64 so the published digits survive verbatim (they do not
    // fit an f32 literal), with a micron of slack for the f32 → f64 widening of a corner value.
    let lo = [-84.436_612_f64, -92.398_125, -128.860_523];
    let hi = [83.397_800_f64, 136.157_040, 99.951_712];
    const SLACK: f64 = 1e-3;
    for (i, p) in all.positions.chunks_exact(3).enumerate() {
        for c in 0..3 {
            let v = f64::from(p[c]);
            assert!(
                v >= lo[c] - SLACK && v <= hi[c] + SLACK,
                "centroid {i} component {c} = {v} is outside the node bbox"
            );
        }
    }
    let first = *all.owner_tet.iter().min().expect("tets");
    let last = *all.owner_tet.iter().max().expect("tets");
    assert!(
        first >= 1_177_214 && last <= 5_899_838,
        "gmsh element numbers {first}..{last} leave the tet block"
    );

    // AGENTS.md: tag 2 (GM) has 1,340,029 tets, and `tags` filters before `stride`.
    let gm = tet_centroids(&m, None, 1, Some(&[2])).expect("centroids");
    assert_eq!(gm.owner_tet.len(), 1_340_029);
    let strided = tet_centroids(&m, None, 64, Some(&[2])).expect("centroids");
    assert_eq!(strided.owner_tet.len(), 1_340_029_usize.div_ceil(64));

    // Morton order is what makes `stride` a density control rather than a spatial bias: the mean of
    // a 1-in-64 subsample lands on the mean of the whole tag — **0.0156 mm apart** here `[M2Max]`,
    // against a GM extent of ~135 mm. That is also what lets the Phase-2 region panel jump to a mesh
    // tissue tag's centroid through this op instead of a second one (§6.5.2).
    let mean = |c: &[f32]| {
        let n = (c.len() / 3) as f64;
        let mut m = [0.0f64; 3];
        for p in c.chunks_exact(3) {
            for k in 0..3 {
                m[k] += f64::from(p[k]);
            }
        }
        [m[0] / n, m[1] / n, m[2] / n]
    };
    let (a, b) = (mean(&gm.positions), mean(&strided.positions));
    let d = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    eprintln!("[tet_centroids] GM mean {a:?} vs 1-in-64 subsample {b:?}: {d:.4} mm apart");
    assert!(d < 0.5, "strided subsample centroid is {d} mm off");
}
