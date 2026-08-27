//! `tvx-geom` against the committed synthetic fixtures (ARCHITECTURE.md §6.3, §11).
//!
//! Everything that calls a geometry function is `#[ignore]`d until Phase 1 implements the
//! crate. **Phase 1's job is to delete the `#[ignore]` line, not to rewrite the
//! assertion.** The mesh counts come from `testdata/manifest.json`, produced by
//! `simnibs.mesh_io.read_msh` and the Gmsh Python API.
//!
//! The fixture mesh is a 2x2x2 lattice of cubes cut into 6 tets each: 27 nodes, 56
//! triangles, 48 tets, spanning (-10,-10,-10)..(10,10,10). Its 56 triangles are exactly
//! the 48 exterior faces plus the 8 tag-differing interior ones, so it is `ernie.msh`'s
//! surface invariant at a size a human can check by hand.

use tvx_core::Field;
use tvx_core::{BitMask, NoProgress, Plane};
use tvx_geom::{
    build_tet_blocks, build_topology, elm_to_node, extract_boundary, face_normals, isolate,
    label_centroids, locate_point, marching_cubes, marching_tets, morton_reorder, node_to_elm,
    orient_surface, plane_cut, surface_contours, tag_surfaces, vertex_normals, IsolateCriteria,
    SurfaceVariant,
};
use tvx_mesh_io::{read_msh, ElmField, Mesh};
use tvx_nifti::{DataType, SpaceUnit, TimeUnit, Units, Volume, VolumeData};

mod common;
use common as fx;

fn lattice() -> Mesh {
    read_msh(fx::bytes("mesh_v2_binary.msh"), &mut NoProgress).expect("mesh_v2_binary.msh")
}

fn tet_only() -> Mesh {
    read_msh(fx::bytes("mesh_tetonly.msh"), &mut NoProgress).expect("mesh_tetonly.msh")
}

/// A mesh with more than 2^21 nodes, for §11's face-key-width test.
///
/// It is **built here rather than committed**: 2,097,152 nodes is ~25 MB of coordinates
/// and ~100 MB of tets, and the fixture budget is 2 MB (see `manifest.json`'s
/// `notGenerated`). A `k x k x 1` slab of cubes cut into 6 tets each gives
/// `(k+1)^2 * 2` nodes, so `k = 1024` clears 2^21 = 2,097,152.
///
/// The trap it exists for: a 3x21-bit packed u64 face key aliases distinct faces above
/// 2^21 nodes and silently merges them as interior, deleting real boundary faces. §6.3
/// therefore mandates a counting sort on the face's minimum vertex, with no packed key.
fn big_node_count_mesh(k: u32) -> Mesh {
    // A k x k x 1 slab of unit cubes, each cut into the same 6 tets tvx-geom uses elsewhere.
    // (k+1)^2 * 2 nodes, so k = 1024 gives 2,101,250 > 2^21 = 2,097,152.
    let (kx, ky) = (k as usize, k as usize);
    let (nx, ny) = (kx + 1, ky + 1);
    let mut nodes = Vec::with_capacity(nx * ny * 2);
    for z in 0..2usize {
        for y in 0..ny {
            for x in 0..nx {
                nodes.push([x as f32, y as f32, z as f32]);
            }
        }
    }
    let at = |x: usize, y: usize, z: usize| ((z * ny + y) * nx + x) as u32;
    // The Freudenthal decomposition about the 0-7 diagonal: neighbouring cubes agree on every
    // shared face, so the slab is a valid conforming tet mesh.
    const CUBE_TETS: [[usize; 4]; 6] = [
        [0, 1, 3, 7],
        [0, 3, 2, 7],
        [0, 2, 6, 7],
        [0, 6, 4, 7],
        [0, 4, 5, 7],
        [0, 5, 1, 7],
    ];
    let mut tets = Vec::with_capacity(kx * ky * 6);
    for y in 0..ky {
        for x in 0..kx {
            let c: Vec<u32> = (0..8)
                .map(|n| at(x + (n & 1), y + ((n >> 1) & 1), (n >> 2) & 1))
                .collect();
            for t in CUBE_TETS {
                tets.push([c[t[0]], c[t[1]], c[t[2]], c[t[3]]]);
            }
        }
    }
    let n_tets = tets.len();
    Mesh {
        bounds: tvx_core::Aabb {
            min: [0.0, 0.0, 0.0],
            max: [kx as f32, ky as f32, 1.0],
        },
        nodes,
        tris: Vec::new(),
        tri_tags: Vec::new(),
        tets,
        tet_tags: vec![1; n_tets],
        tri_edge_mask: None,
        node_fields: Vec::new(),
        elm_fields: Vec::new(),
        physical_names: Vec::new(),
        gmsh_node_numbers: None,
        gmsh_elm_numbers: None,
        tet_perm: (0..n_tets as u32).collect(),
        skipped: Vec::new(),
        label_table: None,
    }
}

// -------------------------------------------------------------------------------------
// live today
// -------------------------------------------------------------------------------------

#[test]
fn the_fixture_mesh_is_the_surface_invariant_in_miniature() {
    let notes = &fx::manifest()["writerNotes"]["lattice"];
    let ext = fx::u64_of(&notes["exteriorFaces"]);
    let iface = fx::u64_of(&notes["tagDifferingInteriorFaces"]);
    let tris = fx::u64_of(&notes["tris"]);
    assert_eq!(ext, 48);
    assert_eq!(iface, 8);
    assert_eq!(
        ext + iface,
        tris,
        "§6.3: stored tris == exterior u tag-differing interior"
    );

    // ... and the tri-less fixture is the grey_Thalamus_TI.msh case that renders empty
    // without extract_boundary.
    assert_eq!(
        fx::u64_of(&fx::section("msh")["mesh_tetonly.msh"]["tris"]),
        0
    );
    assert_eq!(
        fx::u64_of(&fx::section("msh")["mesh_tetonly.msh"]["tets"]),
        48
    );
}

#[test]
fn the_face_key_mesh_is_documented_as_generated_at_test_time() {
    // Keeps `notGenerated` honest: if someone commits a >=2^21-node fixture instead, this
    // note has to go with it.
    let notes = fx::manifest()["notGenerated"].as_array().unwrap();
    assert!(
        notes
            .iter()
            .any(|n| n["what"].as_str().unwrap().contains("2**21")),
        "manifest must explain why no >=2^21-node mesh is committed"
    );
}

// -------------------------------------------------------------------------------------
// phase 1
// -------------------------------------------------------------------------------------

#[test]
fn tag_surfaces_groups_the_stored_triangles_without_topology() {
    // §6.3: the default 3D representation of a mesh that HAS surface elements is its own
    // tagged triangles. No topology, no geometry work beyond grouping and normals.
    let m = lattice();
    let rec = &fx::section("msh")["mesh_v2_binary.msh"];
    for variant in [SurfaceVariant::Indexed, SurfaceVariant::Deindexed] {
        let s = tag_surfaces(&m, variant, &mut NoProgress).unwrap();
        assert_eq!(s.owner_elm.len(), fx::u64_of(&rec["tris"]) as usize);
        assert_eq!(s.face_tag.len(), s.owner_elm.len());
        assert_eq!(
            s.edge_mask, None,
            "§6.3: tet-mesh surfaces are fully unmasked"
        );

        // one TagRange per tag, covering every triangle exactly once
        let mut covered = 0u32;
        for r in &s.per_tag {
            let want = fx::u64_of(&rec["triTagCounts"][r.tag.to_string()]);
            let per_tri = match variant {
                SurfaceVariant::Indexed => 3,
                SurfaceVariant::Deindexed => 3,
            };
            assert_eq!(r.count as u64, want * per_tri, "tag {}", r.tag);
            covered += r.count;
        }
        assert_eq!(covered as usize, s.owner_elm.len() * 3);

        match variant {
            SurfaceVariant::Indexed => {
                assert!(s.indices.is_some());
                assert!(s.node_index.is_some(), "§6.3: vertex -> INTERNAL node row");
                assert!(s.corner.is_none());
            }
            SurfaceVariant::Deindexed => {
                assert!(s.indices.is_none());
                assert!(s.corner.is_some());
                assert_eq!(s.positions.len(), s.owner_elm.len() * 9);
            }
        }
        assert_eq!(s.normals.len(), s.positions.len());
    }
}

#[test]
fn extract_boundary_rescues_a_tri_less_mesh() {
    // grey_Thalamus_TI.msh has 0 triangles and 1,340,029 tets; the fixture is the same
    // shape at 48 tets. The boundary of the 2x2x2 lattice is its 48 exterior faces.
    let m = tet_only();
    assert!(m.tris.is_empty());
    let s = extract_boundary(&m, None, None, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    // §6.3 (ARCHITECTURE.md line 1081): extract_boundary "keeps singletons AND tag-differing
    // pairs". This fixture has two tet tags (24 + 24) and 8 tag-differing interior faces, so the
    // face set is 48 + 8 = 56 — exactly the 56 triangles its tri-carrying twin stores, which is
    // the invariant `the_fixture_mesh_is_the_surface_invariant_in_miniature` asserts above and the
    // whole reason extract_boundary exists. The Phase-0 draft of this line expected 48 (singletons
    // only); that would have made a tri-less mesh render a *different* surface from an identical
    // mesh that happens to store its triangles. See docs/DECISIONS.md (2026-08-27, integration).
    let notes = &fx::manifest()["writerNotes"]["lattice"];
    let want =
        fx::u64_of(&notes["exteriorFaces"]) + fx::u64_of(&notes["tagDifferingInteriorFaces"]);
    assert_eq!(
        s.owner_elm.len() as u64,
        want,
        "48 exterior + 8 interface faces"
    );
}

#[test]
fn extract_boundary_with_and_without_topology_agree() {
    let m = lattice();
    let topo = build_topology(&m, &mut NoProgress).unwrap();
    let a = extract_boundary(&m, None, None, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    let b = extract_boundary(
        &m,
        Some(&topo),
        None,
        SurfaceVariant::Indexed,
        &mut NoProgress,
    )
    .unwrap();
    assert_eq!(a.owner_elm, b.owner_elm);
    assert_eq!(a.face_tag, b.face_tag);
    assert_eq!(a.positions, b.positions);
}

#[test]
fn boundary_extraction_survives_more_than_2_pow_21_nodes() {
    // §11's face-key-width test. A 3x21-bit packed u64 key aliases distinct faces here and
    // silently deletes real boundary faces; §6.3's counting sort on the minimum vertex has
    // no node-count limit. The real-data half of this test uses
    // `m2m_ernie/ernie_seeg.msh` (2,301,899 nodes = 22 bits) per AGENTS.md.
    let m = big_node_count_mesh(1024);
    assert!(m.nodes.len() > (1 << 21), "the point of the fixture");
    let s = extract_boundary(&m, None, None, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    assert!(!s.owner_elm.is_empty());
    assert_eq!(s.orient.non_manifold_edges, 0);
}

#[test]
fn build_topology_counts_faces_and_boundary_faces() {
    // 48 tets x 4 faces = 192 face slots; the 2x2x2 lattice has 48 boundary faces.
    let m = lattice();
    let topo = build_topology(&m, &mut NoProgress).unwrap();
    assert_eq!(topo.faces.len(), topo.face_tets.len());
    let boundary = topo.face_tets.iter().filter(|ft| ft[1] < 0).count();
    let want = fx::u64_of(&fx::manifest()["writerNotes"]["lattice"]["exteriorFaces"]);
    assert_eq!(boundary as u64, want);
}

#[test]
fn plane_cut_is_bit_identical_with_and_without_the_block_index() {
    // §6.3 / §11 "cut index equivalence", on the fixture rather than on ernie.
    let m = lattice();
    let blocks = build_tet_blocks(&m, 64);
    let degenerate = build_tet_blocks(&m, m.tets.len().max(1));
    for plane in [
        Plane {
            normal: [0.0, 0.0, 1.0],
            offset: 0.0,
        },
        Plane {
            normal: [0.577_350_3, 0.577_350_3, 0.577_350_3],
            offset: -1.5,
        },
    ] {
        let a = plane_cut(&m, &blocks, std::slice::from_ref(&plane), None).unwrap();
        let b = plane_cut(&m, &degenerate, std::slice::from_ref(&plane), None).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].positions, b[0].positions);
        assert_eq!(a[0].owner_tet, b[0].owner_tet);
        assert_eq!(a[0].tag, b[0].tag);
        assert_eq!(a[0].edge_mask, b[0].edge_mask);
    }
}

#[test]
fn cut_edge_masks_follow_the_1_3_and_2_2_rule() {
    // §6.3, normative: a 1-3 split emits one triangle with mask 0b111; a 2-2 split emits
    // (a,b,c) with mask 0b101 and (a,c,d) with mask 0b011, so the invented diagonal is
    // never drawn. Every mask a cut of the fixture produces must be one of those three.
    let m = lattice();
    let blocks = build_tet_blocks(&m, 64);
    let plane = Plane {
        normal: [0.0, 0.0, 1.0],
        offset: -2.5,
    };
    let cuts = plane_cut(&m, &blocks, std::slice::from_ref(&plane), None).unwrap();
    let masks: Vec<u8> = cuts[0].edge_mask.iter().map(|m| m & 0b111).collect();
    assert!(!masks.is_empty(), "the plane must actually cut something");
    for m in &masks {
        assert!(
            matches!(m, 0b111 | 0b101 | 0b011),
            "unexpected edge mask {m:#05b}"
        );
    }
    // Every *set* bit is a real element edge, and every real element edge is emitted once into
    // edge_segments as 6 floats. A 1-3 split contributes 3; a 2-2 split contributes 2 + 2 = 4, the
    // invented diagonal being masked off in both of its triangles.
    let real: usize = masks.iter().map(|m| m.count_ones() as usize).sum();
    assert_eq!(
        real * 6,
        cuts[0].edge_segments.len(),
        "every set mask bit is one edge_segments entry"
    );
}

#[test]
fn isolate_accepts_the_worked_wire_example_shape() {
    // §6.5.1's criteria travel as JSON; the fixture exercises the tag and box arms.
    let m = lattice();
    let crit: IsolateCriteria = serde_json::from_str(
        r#"{"tags":[2],"field":null,"sphere":null,"box":{"min":[-10,-10,0],"max":[10,10,10]},
            "labelVolume":null,"combine":"all"}"#,
    )
    .unwrap();
    let mask = isolate(&m, &crit, None, &mut NoProgress).unwrap();
    assert_eq!(mask.len(), m.tets.len());
    let want = fx::u64_of(&fx::section("msh")["mesh_v2_binary.msh"]["tetTagCounts"]["2"]);
    assert_eq!(mask.count_ones() as u64, want, "tag 2 is the upper half");
}

#[test]
fn a_mask_narrows_the_boundary() {
    let m = lattice();
    let mut mask = BitMask::new_all(m.tets.len(), false);
    for i in 0..m.tets.len() {
        mask.set(i, m.tet_tags[i] == 1);
    }
    let all = extract_boundary(&m, None, None, SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    let half = extract_boundary(
        &m,
        None,
        Some(&mask),
        SurfaceVariant::Indexed,
        &mut NoProgress,
    )
    .unwrap();
    assert!(
        half.owner_elm.len() < all.owner_elm.len(),
        "isolating half the tets must shrink the boundary"
    );
}

#[test]
fn locate_point_returns_the_whole_probe() {
    // §6.3: one round trip. `gmsh_elm` is what the UI shows, `tet_index` never leaves.
    let m = lattice();
    let grid = tvx_geom::build_point_locator(&m);
    let hit = locate_point(&m, &grid, [0.5, 0.5, -5.0]).expect("inside the lower half");
    assert_eq!(hit.tag, 1, "z < 0 is tag 1");
    assert!(hit.gmsh_elm >= 1);
    assert_eq!(hit.node_values.len(), m.node_fields.len());
    assert_eq!(hit.elm_values.len(), m.elm_fields.len());
    assert!(locate_point(&m, &grid, [1000.0, 0.0, 0.0]).is_none());
}

#[test]
fn orientation_and_normals_are_reported() {
    let m = lattice();
    let mut tris = m.tris.clone();
    let report = orient_surface(&m.nodes, &mut tris);
    // A tagged tissue surface is a *complex*, not a manifold: the 8 stored interface triangles at
    // z = 0 meet the exterior wall along the equator, so each of those 8 edges carries three
    // triangles. That is the same shape as the real data — `m2m_ernie/ernie.msh` reports
    // components 696 / open 510 / non-manifold 10,311 / flipped 41, asserted in
    // `tests/real_data.rs::orient_surface_reports_the_tissue_complex`. The Phase-0 draft of this
    // line expected 0, which is only true of a single closed shell; a report that said 0 here
    // would mean orient_surface was not looking. See docs/DECISIONS.md (2026-08-27, integration).
    assert_eq!(report.non_manifold_edges, 8, "the equator of the lattice");
    // Three, not one: a non-manifold edge joins no two triangles unambiguously, so it contributes
    // no adjacency and the equator separates the lower shell, the upper shell and the membrane.
    // Walking *through* an ambiguous edge would propagate one arbitrary winding choice across the
    // seam and silently mis-orient whichever side lost the coin toss.
    assert_eq!(report.components, 3, "the equator separates three sheets");
    let n = vertex_normals(&m.nodes, &tris);
    assert_eq!(n.len(), m.nodes.len() * 3);
}

#[test]
fn contours_and_marching_tets_run_on_the_fixture() {
    let m = lattice();
    let plane = Plane {
        normal: [0.0, 0.0, 1.0],
        offset: 0.0,
    };
    let seg = surface_contours(&m, &plane, None).unwrap();
    assert_eq!(seg.len() % 6, 0, "6 floats per segment");

    let field: Vec<f32> = m.nodes.iter().map(|p| p[2]).collect();
    let iso = marching_tets(&m, &field, 0.0, None, &mut NoProgress).unwrap();
    assert_eq!(iso.normals.len(), iso.positions.len());
    assert!(!iso.owner_elm.is_empty());
}

// -------------------------------------------------------------------------------------------
// `marching_cubes`, `face_normals`, `elm_to_node` / `node_to_elm`, `morton_reorder`,
// `label_centroids` — AGENTS rule 2's synthetic half, which Phase 1 left off for all six.
// -------------------------------------------------------------------------------------------

/// A synthetic scalar volume: `dims` samples of `f`, on a `spacing`-mm grid centred on the origin.
fn synthetic_volume(dims: [usize; 3], spacing: f64, f: impl Fn([f64; 3]) -> f32) -> Volume {
    let mut affine = [[0.0f64; 4]; 4];
    for a in 0..3 {
        affine[a][a] = spacing;
        affine[a][3] = -spacing * ((dims[a] - 1) as f64) / 2.0;
    }
    affine[3][3] = 1.0;
    let mut data = Vec::with_capacity(dims[0] * dims[1] * dims[2]);
    for k in 0..dims[2] {
        for j in 0..dims[1] {
            for i in 0..dims[0] {
                let w = [
                    affine[0][0] * i as f64 + affine[0][3],
                    affine[1][1] * j as f64 + affine[1][3],
                    affine[2][2] * k as f64 + affine[2][3],
                ];
                data.push(f(w));
            }
        }
    }
    Volume {
        dims,
        nvols: 1,
        affine,
        spacing: [spacing, spacing, spacing],
        datatype: DataType::F32,
        data: VolumeData::F32(data),
        scl_slope: 1.0,
        scl_inter: 0.0,
        cal_min: 0.0,
        cal_max: 0.0,
        intent_code: 0,
        intent_name: String::new(),
        descrip: String::new(),
        xyz_units: Units {
            space: SpaceUnit::Millimeter,
            time: TimeUnit::Unknown,
        },
        is_label: false,
        header_json: "{}".into(),
    }
}

/// Surface area, enclosed (signed) volume and the mean agreement between the emitted normals and
/// the outward radial direction — the three numbers that decide whether an isosurface is right.
fn surface_stats(s: &tvx_geom::SurfaceBuffers) -> (f64, f64, f64, f64, f64) {
    // `Indexed` welds vertices, so the triangle list is `indices`; `Deindexed` has none and the
    // positions are the triangles.
    let p = |t: usize, c: usize| -> [f64; 3] {
        let v = match &s.indices {
            Some(ix) => ix[t * 3 + c] as usize,
            None => t * 3 + c,
        };
        [
            s.positions[v * 3] as f64,
            s.positions[v * 3 + 1] as f64,
            s.positions[v * 3 + 2] as f64,
        ]
    };
    let tris = match &s.indices {
        Some(ix) => ix.len() / 3,
        None => s.positions.len() / 9,
    };
    let (mut area, mut vol6) = (0.0, 0.0);
    let (mut rmin, mut rmax) = (f64::INFINITY, 0.0f64);
    let mut dot_sum = 0.0;
    for t in 0..tris {
        let (a, b, c) = (p(t, 0), p(t, 1), p(t, 2));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        area += 0.5 * len;
        // Divergence theorem: 6V = sum over triangles of a . (b x c).
        vol6 += a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
        for q in [a, b, c] {
            let r = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2]).sqrt();
            rmin = rmin.min(r);
            rmax = rmax.max(r);
        }
        let m = [
            (a[0] + b[0] + c[0]) / 3.0,
            (a[1] + b[1] + c[1]) / 3.0,
            (a[2] + b[2] + c[2]) / 3.0,
        ];
        let ml = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt().max(1e-12);
        if len > 0.0 {
            dot_sum += (n[0] * m[0] + n[1] * m[1] + n[2] * m[2]) / (len * ml);
        }
    }
    (area, vol6 / 6.0, rmin, rmax, dot_sum / tris as f64)
}

/// §6.3's `marching_cubes` on an **analytic** sphere: area and enclosed volume converge on the
/// closed forms, every vertex sits on the isosurface to within a voxel, and the winding is outward.
///
/// This is the whole of AGENTS rule 2's synthetic half for a function Phase 1 shipped with **no**
/// test in any crate — its only coverage anywhere was a `positions.length > 0` smoke check from
/// TypeScript.
#[test]
fn marching_cubes_reproduces_an_analytic_sphere() {
    let radius = 10.0f64;
    let mut previous: Option<(f64, f64, f64)> = None;
    for (n, spacing) in [(33usize, 1.0f64), (65, 0.5)] {
        let vol = synthetic_volume([n, n, n], spacing, |w| {
            (radius - (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt()) as f32
        });
        let s = marching_cubes(&vol, 0, 0.0, true, &mut NoProgress).unwrap();
        assert!(!s.positions.is_empty(), "the sphere is inside the grid");
        assert_eq!(s.normals.len(), s.positions.len());
        // `smooth` welds, so this is an `Indexed` surface: one owner per triangle, and the
        // triangles are in `indices`.
        assert_eq!(s.owner_elm.len(), s.indices.as_ref().unwrap().len() / 3);

        let (area, volume, rmin, rmax, outward) = surface_stats(&s);
        let area_ratio = area / (4.0 * std::f64::consts::PI * radius * radius);
        let vol_ratio = volume / (4.0 / 3.0 * std::f64::consts::PI * radius.powi(3));

        // Every vertex is an exact linear interpolation along a grid edge, so it lands on the true
        // sphere to within the chord error of one cell — never outside it.
        assert!(
            rmax <= radius + 1e-4 && rmin >= radius - spacing,
            "vertex radii {rmin}..{rmax} for r={radius}, h={spacing}"
        );
        // A closed, outward-wound surface: the divergence theorem gives a positive volume and the
        // face normals agree with the radial direction almost everywhere.
        // A piecewise-linear surface through a convex body is inscribed, so both ratios approach 1
        // from below as h shrinks and neither may exceed it by more than rounding. The bars here are
        // loose on purpose — the *convergence* assertion below is what says the kernel is right, and
        // a bar tight enough to be interesting at h=0.5 would be wrong at h=1.
        assert!(
            vol_ratio > 0.97 && vol_ratio < 1.001,
            "enclosed volume ratio {vol_ratio} at h={spacing}"
        );
        assert!(
            area_ratio > 0.97 && area_ratio < 1.01,
            "area ratio {area_ratio} at h={spacing}"
        );
        // Outward, and by a margin no random winding could reach: a coin toss averages 0. The bar
        // is 0.9 rather than 0.999 because a Freudenthal decomposition emits genuinely tilted
        // slivers at 10 voxels per radius; it tightens with h, which the convergence check below
        // requires.
        assert!(outward > 0.9, "mean dot(normal, radial) {outward}");
        eprintln!(
            "[marching_cubes] h={spacing}: area/4pi r^2 = {area_ratio:.5}, \
             volume/(4/3 pi r^3) = {vol_ratio:.5}, radii {rmin:.3}..{rmax:.3}, outward {outward:.4}"
        );

        if let Some((a0, v0, o0)) = previous {
            assert!(
                outward > o0,
                "outwardness {o0} -> {outward} did not improve"
            );
            // Halving the voxel must move both toward 1, not away: this is what says the kernel is
            // consistent rather than accidentally close at one resolution.
            assert!(
                (1.0 - area_ratio).abs() < (1.0 - a0).abs(),
                "area {a0} -> {area_ratio} did not improve"
            );
            assert!(
                (1.0 - vol_ratio).abs() < (1.0 - v0).abs(),
                "volume {v0} -> {vol_ratio} did not improve"
            );
        }
        previous = Some((area_ratio, vol_ratio, outward));
    }
}

#[test]
fn marching_cubes_refuses_a_frame_that_is_not_there() {
    let vol = synthetic_volume([4, 4, 4], 1.0, |w| w[0] as f32);
    assert!(marching_cubes(&vol, 1, 0.0, false, &mut NoProgress).is_err());
    // An isovalue outside the data is empty, not an error.
    let s = marching_cubes(&vol, 0, 1e6, false, &mut NoProgress).unwrap();
    assert!(s.positions.is_empty());
}

/// `label_centroids` on a volume whose answer is exact by construction (§6.3).
#[test]
fn label_centroids_are_exact_on_a_synthetic_volume() {
    // Label 3 fills one octant, label 7 a single voxel. 5x5x5 at 2 mm, centred on the origin, so
    // voxel (i,j,k) is world (2i-4, 2j-4, 2k-4).
    let vol = synthetic_volume([5, 5, 5], 2.0, |w| {
        if w[0] >= 0.0 && w[1] >= 0.0 && w[2] >= 0.0 {
            3.0
        } else if w == [-4.0, -4.0, -4.0] {
            7.0
        } else {
            0.0
        }
    });
    let cs = label_centroids(&vol, 0).unwrap();
    let get = |id: u32| cs.iter().find(|c| c.id == id).expect("label present");
    // The +++ octant is voxels 2..4 in each axis: 27 voxels centred on (2, 2, 2) mm.
    assert_eq!(get(3).count, 27);
    for a in 0..3 {
        assert!((get(3).centroid[a] - 2.0).abs() < 1e-4);
    }
    assert_eq!(get(7).count, 1);
    assert_eq!(get(7).centroid, [-4.0, -4.0, -4.0]);
    // Zero is a label like any other here; what it means is the caller's business (§7.3).
    assert_eq!(get(0).count, 125 - 27 - 1);
}

/// `face_normals` (§6.3), which had no test in either crate.
#[test]
fn face_normals_are_unit_and_follow_the_winding() {
    let m = lattice();
    let n = face_normals(&m.nodes, &m.tris);
    assert_eq!(n.len(), m.tris.len() * 3);
    for (t, tri) in m.tris.iter().enumerate() {
        let p = |k: usize| m.nodes[tri[k] as usize].map(f64::from);
        let (a, b, c) = (p(0), p(1), p(2));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let x = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]).sqrt();
        assert!(len > 0.0, "triangle {t} is degenerate");
        for a2 in 0..3 {
            assert!(
                (f64::from(n[t * 3 + a2]) - x[a2] / len).abs() < 1e-5,
                "triangle {t} axis {a2}"
            );
        }
    }
}

/// `elm_to_node` / `node_to_elm` (§6.3) on the fixture: the two exact cases a volume-weighted mean
/// must reproduce, at a size a human can check.
#[test]
fn field_conversion_is_exact_on_the_lattice_for_the_cases_that_must_be() {
    let mut m = lattice();
    m.tet_perm = morton_reorder(&mut m);

    // 1. A constant element field averages to the same constant at every node it touches.
    let constant = ElmField {
        name: "k".into(),
        ncomp: 1,
        tri: vec![],
        tet: vec![7.5; m.tets.len()],
        units: None,
        partial: false,
        stats: tvx_mesh_io::field_stats(&[7.5f32], 1),
    };
    let node = elm_to_node(&m, &constant).unwrap();
    assert_eq!(node.data.len(), m.nodes.len());
    for (i, v) in node.data.iter().enumerate() {
        assert!((v - 7.5).abs() < 1e-4, "node {i} = {v}");
    }

    // 2. A **linear** node field lands on the tet's centroid value, exactly — the property that
    //    makes the pair round-trip on smooth data at all.
    let linear = Field {
        name: "x+2y+3z".into(),
        ncomp: 1,
        data: m
            .nodes
            .iter()
            .map(|p| p[0] + 2.0 * p[1] + 3.0 * p[2])
            .collect(),
        units: None,
        partial: false,
        stats: tvx_mesh_io::field_stats(&[0.0f32], 1),
    };
    let elm = node_to_elm(&m, &linear).unwrap();
    assert_eq!(elm.tet.len(), m.tets.len());
    assert_eq!(elm.tri.len(), m.tris.len());
    for (j, tet) in m.tets.iter().enumerate() {
        let mut want = 0.0f32;
        for &v in tet {
            let p = m.nodes[v as usize];
            want += (p[0] + 2.0 * p[1] + 3.0 * p[2]) / 4.0;
        }
        assert!(
            (elm.tet[j] - want).abs() < 1e-3,
            "tet {j}: {} vs {want}",
            elm.tet[j]
        );
    }
}

/// `morton_reorder` (§6.3) on the fixture: a permutation that carries the tags and the fields with
/// it, and improves spatial locality rather than merely shuffling.
#[test]
fn morton_reorder_permutes_the_lattice_and_its_tags() {
    let before = lattice();
    let mut m = lattice();
    let perm = morton_reorder(&mut m);

    assert_eq!(perm.len(), before.tets.len());
    let mut seen = vec![false; perm.len()];
    for &p in &perm {
        assert!(!seen[p as usize], "morton_reorder returned a duplicate");
        seen[p as usize] = true;
    }
    assert!(seen.iter().all(|&s| s), "and it must cover every tet");

    // Every tet, its tag and its element-field values move together.
    for (j, &src) in perm.iter().enumerate() {
        assert_eq!(m.tets[j], before.tets[src as usize]);
        assert_eq!(m.tet_tags[j], before.tet_tags[src as usize]);
        for (f, g) in m.elm_fields.iter().zip(&before.elm_fields) {
            let n = f.ncomp;
            assert_eq!(
                &f.tet[j * n..(j + 1) * n],
                &g.tet[src as usize * n..(src as usize + 1) * n],
                "field {} at tet {j}",
                f.name
            );
        }
    }

    // Locality is deliberately NOT asserted here. §6.3 wants the reorder so that a per-64-block
    // AABB reject has something to reject, and on a 48-tet lattice whose file order already walks
    // cube by cube there is nothing to improve — measured, Morton is *less* local at this size
    // (6.02 mm mean step against 4.91). The locality claim is a property of a real mesh and is
    // asserted on `ernie.msh` in `tests/real_data.rs`, where §6.3's own `[M2Max]` note lives.
}
