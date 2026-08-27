//! `tvx-mesh-io` against the committed synthetic fixtures (ARCHITECTURE.md §6.2, §11).
//!
//! Every test that touches a reader is `#[ignore]`d until Phase 1 implements it — the
//! crate ships `unimplemented!()` stubs. **Phase 1's job is to delete the `#[ignore]`
//! line, not to rewrite the assertion.** The expected numbers live in
//! `testdata/manifest.json` and came from `simnibs.mesh_io.read_msh` and the Gmsh 4.14
//! Python API, never from the writer that produced the fixtures.
//!
//! The fixture mesh is a 2x2x2 lattice of cubes cut into 6 tets each, spanning
//! (-10,-10,-10)..(10,10,10): **27 nodes, 56 triangles, 48 tets**, tet tags 1 and 2
//! (24 each) and tri tags 1001 (24) and 1002 (32). Its 56 triangles are exactly the
//! 48 exterior faces plus the 8 tag-differing interior ones — the same invariant §6.3
//! asserts on `ernie.msh`, at a size a human can check by hand.

use tvx_core::NoProgress;
use tvx_mesh_io::{
    read_fs_annot, read_fs_curv, read_fs_surface, read_gifti, read_msh, read_msh_opt, read_obj,
    read_ply, read_stl, sniff, Format,
};

mod common;
use common as fx;

const MSH_V2: [&str; 3] = [
    "mesh_v2_ascii.msh",
    "mesh_v2_binary.msh",
    "mesh_tetonly.msh",
];
const MSH_ALL: [&str; 6] = [
    "mesh_v2_ascii.msh",
    "mesh_v2_binary.msh",
    "mesh_v2_binary_gmsh.msh",
    "mesh_tetonly.msh",
    "mesh_noncontig.msh",
    "mesh_v41_ascii.msh",
];

// -------------------------------------------------------------------------------------
// live today
// -------------------------------------------------------------------------------------

#[test]
fn manifest_and_fixtures_are_present() {
    for section in ["msh", "surfaces", "gifti"] {
        for (name, rec) in fx::entries(section) {
            assert_eq!(
                fx::bytes(name).len(),
                fx::u64_of(&rec["bytes"]) as usize,
                "{name} changed on disk without the manifest being regenerated"
            );
        }
    }
    for required in [
        "mesh_v2_ascii.msh",
        "mesh_v2_binary.msh",
        "mesh_v2_binary_gmsh.msh",
        "mesh_v41_ascii.msh",
        "mesh_v41_binary.msh",
        "mesh_tetonly.msh",
        "mesh_noncontig.msh",
    ] {
        assert!(
            fx::section("msh").contains_key(required),
            "missing {required}"
        );
    }
    for required in [
        "patch_ascii.stl",
        "patch_binary.stl",
        "patch_tri_ascii.ply",
        "patch_tri_binary.ply",
        "patch_quad_ascii.ply",
        "patch_tri.obj",
        "patch_quad.obj",
    ] {
        assert!(
            fx::section("surfaces").contains_key(required),
            "missing {required}"
        );
    }
    for required in [
        "surf_gzipb64.surf.gii",
        "surf_b64.surf.gii",
        "surf_ascii.surf.gii",
        "surf.func.gii",
        "surf.label.gii",
    ] {
        assert!(
            fx::section("gifti").contains_key(required),
            "missing {required}"
        );
    }
    for required in ["lh.fixture.surf", "lh.fixture.curv", "lh.fixture.annot"] {
        assert!(
            fx::section("freesurfer").contains_key(required),
            "missing {required}"
        );
    }
}

#[test]
fn the_v2_binary_fixture_is_simnibs_dialect() {
    // §6.2: header `2.2 1 8`, then the one-int endianness marker. SimNIBS's own writer
    // emits NO newline before `$End*`; Gmsh's does. Both dialects are committed, which is
    // why the reader must accept optional whitespace there.
    let b = fx::bytes("mesh_v2_binary.msh");
    assert!(b.starts_with(b"$MeshFormat\n2.2 1 8\n"));
    assert_eq!(&b[20..24], &1i32.to_le_bytes());
    let s = String::from_utf8_lossy(&b);
    assert!(
        s.contains("$PhysicalNames"),
        "the fixture carries $PhysicalNames"
    );
    assert!(s.contains("$NodeData") && s.contains("$ElementData"));

    let g = fx::bytes("mesh_v2_binary_gmsh.msh");
    assert!(g.starts_with(b"$MeshFormat\n2.2 1 8\n"));

    let a = String::from_utf8(fx::bytes("mesh_v2_ascii.msh")).unwrap();
    assert!(a.starts_with("$MeshFormat\n2.2 0 8\n"));

    for v41 in ["mesh_v41_ascii.msh", "mesh_v41_binary.msh"] {
        let b = fx::bytes(v41);
        assert!(b.starts_with(b"$MeshFormat\n4.1 "), "{v41}");
    }
}

#[test]
fn the_fixture_mesh_satisfies_the_surface_invariant() {
    // The §6.3 invariant, checked against the writer's own census: stored tris ==
    // exterior faces + tag-differing interior faces. `ernie.msh` is the real-data version.
    let notes = &fx::manifest()["writerNotes"]["lattice"];
    let ext = fx::u64_of(&notes["exteriorFaces"]);
    let iface = fx::u64_of(&notes["tagDifferingInteriorFaces"]);
    let tris = fx::u64_of(&notes["tris"]);
    assert_eq!(ext + iface, tris, "48 + 8 == 56");
    // ... and the independent reader agrees on the total.
    let rec = &fx::section("msh")["mesh_v2_ascii.msh"];
    assert_eq!(fx::u64_of(&rec["tris"]), tris);
}

// -------------------------------------------------------------------------------------
// phase 1 — Gmsh .msh
// -------------------------------------------------------------------------------------

#[test]
fn every_msh_fixture_parses_with_the_manifest_counts() {
    for name in MSH_ALL {
        let rec = &fx::section("msh")[name];
        let m =
            read_msh(fx::bytes(name), &mut NoProgress).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            m.nodes.len() as u64,
            fx::u64_of(&rec["nodes"]),
            "{name}: nodes"
        );

        // SimNIBS-read records name the counts directly; Gmsh-read ones use element types
        // (2 = tri3, 4 = tet4).
        let (want_tris, want_tets) = match rec.get("tris") {
            Some(t) => (fx::u64_of(t), fx::u64_of(&rec["tets"])),
            None => {
                let by = &rec["elementsByGmshType"];
                (
                    by.get("2").map(fx::u64_of).unwrap_or(0),
                    by.get("4").map(fx::u64_of).unwrap_or(0),
                )
            }
        };
        assert_eq!(m.tris.len() as u64, want_tris, "{name}: tris");
        assert_eq!(m.tets.len() as u64, want_tets, "{name}: tets");

        let bb = &rec["bbox"];
        for (i, want) in fx::nums(&bb["min"]).iter().enumerate() {
            fx::close(
                &format!("{name}: bounds.min[{i}]"),
                m.bounds.min[i] as f64,
                *want,
                1e-4,
            );
        }
        for (i, want) in fx::nums(&bb["max"]).iter().enumerate() {
            fx::close(
                &format!("{name}: bounds.max[{i}]"),
                m.bounds.max[i] as f64,
                *want,
                1e-4,
            );
        }

        // Only tri3 and tet4 are kept; anything else is counted, never an error (§6.2).
        for (ty, _) in m.skipped.iter().map(|(a, b)| (*a, *b)) {
            assert!(
                ty != 2 && ty != 4,
                "{name}: tri3/tet4 must never be skipped"
            );
        }
    }
}

#[test]
fn ascii_and_binary_and_v41_agree_element_for_element() {
    // Four encodings of the same mesh: SimNIBS-dialect ascii and binary, Gmsh's own v2.2
    // binary, and Gmsh v4.1 ascii + binary. Node coordinates and tag censuses must match.
    let base = read_msh(fx::bytes("mesh_v2_ascii.msh"), &mut NoProgress).unwrap();
    for other in [
        "mesh_v2_binary.msh",
        "mesh_v2_binary_gmsh.msh",
        "mesh_v41_ascii.msh",
        "mesh_v41_binary.msh",
    ] {
        let m = read_msh(fx::bytes(other), &mut NoProgress).unwrap();
        assert_eq!(m.nodes.len(), base.nodes.len(), "{other}");
        assert_eq!(m.tris.len(), base.tris.len(), "{other}");
        assert_eq!(m.tets.len(), base.tets.len(), "{other}");
        let mut a: Vec<i32> = m.tet_tags.clone();
        let mut b: Vec<i32> = base.tet_tags.clone();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b, "{other}: tet tag census");
        let mut a: Vec<i32> = m.tri_tags.clone();
        let mut b: Vec<i32> = base.tri_tags.clone();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b, "{other}: tri tag census");
    }
}

#[test]
fn tag_censuses_match_the_independent_readers() {
    for name in MSH_V2 {
        let rec = &fx::section("msh")[name];
        let m = read_msh(fx::bytes(name), &mut NoProgress).unwrap();
        for (tag, count) in rec["triTagCounts"].as_object().unwrap() {
            let t: i32 = tag.parse().unwrap();
            let got = m.tri_tags.iter().filter(|x| **x == t).count() as u64;
            assert_eq!(got, fx::u64_of(count), "{name}: tri tag {t}");
        }
        for (tag, count) in rec["tetTagCounts"].as_object().unwrap() {
            let t: i32 = tag.parse().unwrap();
            let got = m.tet_tags.iter().filter(|x| **x == t).count() as u64;
            assert_eq!(got, fx::u64_of(count), "{name}: tet tag {t}");
        }
    }
}

#[test]
fn a_contiguous_file_leaves_gmsh_elm_numbers_none() {
    // §6.2's fast path, and the reason the Morton permutation is kept: `None` costs
    // nothing where `Some` would cost 47.2 MB on ernie.
    for name in MSH_V2 {
        let m = read_msh(fx::bytes(name), &mut NoProgress).unwrap();
        assert!(
            m.gmsh_elm_numbers.is_none(),
            "{name} numbers its elements 1..N in (tris then tets) order"
        );
        assert!(m.gmsh_node_numbers.is_none(), "{name}");
        // The identity rule: tri i -> i+1, tet j -> n_tris + tet_perm[j] + 1.
        assert_eq!(m.tet_perm.len(), m.tets.len(), "{name}");
    }
}

#[test]
fn non_contiguous_numbering_is_preserved_and_field_gaps_become_nan() {
    // mesh_noncontig.msh numbers elements 10, 13, 16, ... and nodes 102, 104, ... — and
    // its `elm_gap` field carries a value for only every other element. §6.2: scatter by
    // id, gaps are NaN and `partial = true`. Positional order is WRONG here.
    let rec = &fx::section("msh")["mesh_noncontig.msh"];
    assert_eq!(rec["elementNumbers"]["contiguousFrom1"], false);
    assert_eq!(rec["nodeNumbers"]["contiguousFrom1"], false);
    let first_elm = fx::u64_of(&rec["elementNumbers"]["first"]);
    let first_node = fx::u64_of(&rec["nodeNumbers"]["first"]);

    let m = read_msh(fx::bytes("mesh_noncontig.msh"), &mut NoProgress).unwrap();
    let elm = m
        .gmsh_elm_numbers
        .as_ref()
        .expect("Some for a renumbered file");
    let nod = m
        .gmsh_node_numbers
        .as_ref()
        .expect("Some for a renumbered file");
    assert_eq!(elm.len(), m.tris.len() + m.tets.len());
    assert_eq!(elm[0], first_elm);
    assert_eq!(nod[0], first_node);

    let gap = m
        .elm_fields
        .iter()
        .find(|f| f.name == "elm_gap")
        .expect("elm_gap");
    assert!(gap.partial, "half the elements have no value");
    let total = gap.tri.len() + gap.tet.len();
    let nan = gap
        .tri
        .iter()
        .chain(gap.tet.iter())
        .filter(|v| v.is_nan())
        .count();
    let want_records = fx::u64_of(&fx::manifest()["writerNotes"]["noncontig"]["gapFieldRecords"]);
    assert_eq!(
        total - nan,
        want_records as usize,
        "one value per record, rest NaN"
    );
}

#[test]
fn element_numbers_beyond_u32_are_refused_not_truncated() {
    use tvx_core::Error;
    // §6.2: `owner_elm` is u32; a file whose largest element number exceeds u32::MAX is
    // Error::Unsupported("element numbers exceed u32"), checked at parse time.
    let src = String::from_utf8(fx::bytes("mesh_v2_ascii.msh")).unwrap();
    let huge = src.replacen("\n1 2 2 1001 1001 ", "\n5000000000 2 2 1001 1001 ", 1);
    match read_msh(huge.into_bytes(), &mut NoProgress) {
        Err(Error::Unsupported(m)) => assert!(m.contains("u32"), "got {m:?}"),
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn a_tri_less_tet_mesh_parses() {
    // The `grey_Thalamus_TI.msh` case (§6.3): 0 triangles, so anything that assumes a mesh
    // ships its own surface renders empty. tvx-geom's extract_boundary is what saves it.
    let rec = &fx::section("msh")["mesh_tetonly.msh"];
    assert_eq!(fx::u64_of(&rec["tris"]), 0);
    let m = read_msh(fx::bytes("mesh_tetonly.msh"), &mut NoProgress).unwrap();
    assert!(m.tris.is_empty());
    assert_eq!(m.tets.len(), fx::u64_of(&rec["tets"]) as usize);
}

#[test]
fn node_and_element_fields_carry_the_manifest_statistics() {
    for name in MSH_V2 {
        let rec = &fx::section("msh")[name];
        let m = read_msh(fx::bytes(name), &mut NoProgress).unwrap();
        for want in rec["fields"].as_array().unwrap() {
            let fname = want["name"].as_str().unwrap();
            let ncomp = fx::u64_of(&want["ncomp"]) as usize;
            let n = fx::u64_of(&want["n"]) as usize;
            if want["source"] == "node" {
                let f = m
                    .node_fields
                    .iter()
                    .find(|f| f.name == fname)
                    .unwrap_or_else(|| panic!("{name}: no node field {fname}"));
                assert_eq!(f.ncomp, ncomp);
                assert_eq!(f.data.len(), n * ncomp);
            } else {
                let f = m
                    .elm_fields
                    .iter()
                    .find(|f| f.name == fname)
                    .unwrap_or_else(|| panic!("{name}: no elm field {fname}"));
                assert_eq!(f.ncomp, ncomp);
                // §6.2 splits element fields by element kind.
                assert_eq!((f.tri.len() + f.tet.len()) / ncomp, n);
                let stats = if ncomp > 1 {
                    &want["magnitudeStats"]
                } else {
                    &want["stats"]
                };
                fx::close(
                    &format!("{name}/{fname}: min"),
                    f.stats.min as f64,
                    fx::num(&stats["min"]),
                    1e-4,
                );
                fx::close(
                    &format!("{name}/{fname}: max"),
                    f.stats.max as f64,
                    fx::num(&stats["max"]),
                    1e-4,
                );
            }
        }
    }
}

#[test]
fn physical_names_are_read() {
    let rec = &fx::section("msh")["mesh_v2_ascii.msh"];
    let want = rec["gmsh"]["physicalNames"].as_array().unwrap();
    let m = read_msh(fx::bytes("mesh_v2_ascii.msh"), &mut NoProgress).unwrap();
    for entry in want {
        let tag = entry[1].as_i64().unwrap() as i32;
        let name = entry[2].as_str().unwrap();
        assert!(
            m.physical_names.iter().any(|(t, n)| *t == tag && n == name),
            "missing $PhysicalNames entry ({tag}, {name:?})"
        );
    }
}

#[test]
fn msh_opt_maps_colours_names_and_visibility_onto_tags() {
    // §6.2's ordering: $PhysicalNames -> sibling _LUT.txt -> sibling .msh.opt -> palette,
    // with surface tag `1xxx` inheriting volume tag `xxx`'s colour. The expectation is in
    // the manifest's `sidecars` section; Gmsh independently proves the file parses
    // (`mshOptParsedByGmsh`).
    let want = &fx::manifest()["sidecars"]["mesh_v2_binary.msh.opt"]["expected"];
    let opt = read_msh_opt(&fx::bytes("mesh_v2_binary.msh.opt")).unwrap();
    for (tag, rgba) in want["tagColor"].as_object().unwrap() {
        let t: i32 = tag.parse().unwrap();
        let got = opt
            .tag_color
            .iter()
            .find(|(k, _)| *k == t)
            .unwrap_or_else(|| panic!("no colour for tag {t}"))
            .1;
        let e = fx::usizes(rgba);
        assert_eq!(got.map(|x| x as usize).to_vec(), e, "tag {t} colour");
    }
    for (tag, vis) in want["tagVisible"].as_object().unwrap() {
        let t: i32 = tag.parse().unwrap();
        let got = opt
            .tag_visible
            .iter()
            .find(|(k, _)| *k == t)
            .map(|(_, v)| *v);
        assert_eq!(got, vis.as_bool(), "tag {t} visibility");
    }
    let v = &want["views"][0];
    assert_eq!(opt.views.len(), 1);
    let view = &opt.views[0];
    fx::close(
        "customMin",
        view.custom_min.unwrap() as f64,
        fx::num(&v["customMin"]),
        1e-6,
    );
    fx::close(
        "customMax",
        view.custom_max.unwrap() as f64,
        fx::num(&v["customMax"]),
        1e-6,
    );
    assert_eq!(view.range_type, Some(fx::num(&v["rangeType"]) as i32));
    assert_eq!(
        view.colormap_number,
        Some(fx::num(&v["colormapNumber"]) as i32)
    );
    assert_eq!(view.saturate_values, v["saturateValues"].as_bool());
    assert_eq!(view.show_scale, v["showScale"].as_bool());
    assert_eq!(view.vector_type, Some(fx::num(&v["vectorType"]) as i32));
}

// -------------------------------------------------------------------------------------
// phase 1 — GIfTI
// -------------------------------------------------------------------------------------

#[test]
fn all_three_gifti_encodings_produce_the_same_surface() {
    // §6.2: ASCII, Base64Binary and GZipBase64Binary. GZipBase64Binary is a **zlib**
    // stream — ZlibDecoder, not GzDecoder.
    let mut prev: Option<(usize, usize)> = None;
    for name in [
        "surf_ascii.surf.gii",
        "surf_b64.surf.gii",
        "surf_gzipb64.surf.gii",
    ] {
        let rec = &fx::section("gifti")[name];
        let pointset = rec["arrays"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["intentCode"] == 1008)
            .unwrap();
        let tri = rec["arrays"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["intentCode"] == 1009)
            .unwrap();
        let m =
            read_gifti(fx::bytes(name), &mut NoProgress).unwrap_or_else(|e| panic!("{name}: {e}"));
        let nn = fx::usizes(&pointset["dims"])[0];
        let nt = fx::usizes(&tri["dims"])[0];
        assert_eq!(m.nodes.len(), nn, "{name}");
        assert_eq!(m.tris.len(), nt, "{name}");
        if let Some(p) = prev {
            assert_eq!(
                (m.nodes.len(), m.tris.len()),
                p,
                "{name} differs from its peers"
            );
        }
        prev = Some((m.nodes.len(), m.tris.len()));

        // §3/§4.3: the CoordinateSystemTransformMatrix is BAKED into the coordinates when
        // TransformedSpace is NIFTI_XFORM_SCANNER_ANAT, and reported in appliedTransform.
        assert_eq!(pointset["transformedSpace"], "NIFTI_XFORM_SCANNER_ANAT");
        assert_eq!(pointset["dataSpace"], "NIFTI_XFORM_UNKNOWN");
        let bb = &pointset["bboxTransformed"];
        for (i, want) in fx::nums(&bb["min"]).iter().enumerate() {
            fx::close(
                &format!("{name}: bounds.min[{i}]"),
                m.bounds.min[i] as f64,
                *want,
                1e-4,
            );
        }
        for (i, want) in fx::nums(&bb["max"]).iter().enumerate() {
            fx::close(
                &format!("{name}: bounds.max[{i}]"),
                m.bounds.max[i] as f64,
                *want,
                1e-4,
            );
        }
    }
}

#[test]
fn func_and_label_gifti_become_node_fields() {
    let m = read_gifti(fx::bytes("surf.func.gii"), &mut NoProgress).unwrap();
    let rec = &fx::section("gifti")["surf.func.gii"]["arrays"][0];
    assert_eq!(m.node_fields.len(), 1);
    assert_eq!(m.node_fields[0].data.len(), fx::usizes(&rec["dims"])[0]);
    fx::close(
        "func min",
        m.node_fields[0].stats.min as f64,
        fx::num(&rec["stats"]["min"]),
        1e-5,
    );

    let l = read_gifti(fx::bytes("surf.label.gii"), &mut NoProgress).unwrap();
    assert_eq!(l.node_fields.len(), 1);
    // The <LabelTable> keys are sparse (0, 3, 7, 11) — a 256x1 LUT cannot address them
    // directly, exactly like a FreeSurfer .annot (§6.2).
    let want = fx::manifest()["gifti"]["surf.label.gii"]["labelTable"]
        .as_array()
        .unwrap();
    assert_eq!(want.len(), 4);
}

#[test]
fn external_file_binary_is_refused_by_name() {
    use tvx_core::Error;
    // §6.2: the byte-slice signature has no sibling-file access, so ExternalFileBinary is
    // Unsupported. No fixture is committed — a rejection needs no valid file.
    let src = String::from_utf8(fx::bytes("surf_ascii.surf.gii")).unwrap();
    let patched = src.replace("Encoding=\"ASCII\"", "Encoding=\"ExternalFileBinary\"");
    assert_ne!(
        patched, src,
        "the fixture must actually declare Encoding=\"ASCII\""
    );
    match read_gifti(patched.into_bytes(), &mut NoProgress) {
        Err(Error::Unsupported(m)) => assert!(m.contains("ExternalFileBinary"), "got {m:?}"),
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

// -------------------------------------------------------------------------------------
// phase 1 — FreeSurfer
// -------------------------------------------------------------------------------------

#[test]
fn freesurfer_surface_curv_and_annot() {
    let rec = &fx::section("freesurfer")["lh.fixture.surf"];
    let m = read_fs_surface(fx::bytes("lh.fixture.surf")).unwrap();
    assert_eq!(m.nodes.len() as u64, fx::u64_of(&rec["nodes"]));
    assert_eq!(m.tris.len() as u64, fx::u64_of(&rec["tris"]));
    // magic 0xFFFFFE big-endian, coordinates big-endian f32 (§6.2)
    let raw = fx::bytes("lh.fixture.surf");
    assert_eq!(&raw[..3], &[0xFF, 0xFF, 0xFE]);
    for (i, want) in fx::nums(&rec["firstNode"]).iter().enumerate() {
        fx::close(&format!("node0[{i}]"), m.nodes[0][i] as f64, *want, 1e-4);
    }

    let crec = &fx::section("freesurfer")["lh.fixture.curv"];
    let c = read_fs_curv(&fx::bytes("lh.fixture.curv")).unwrap();
    assert_eq!(c.data.len() as u64, fx::u64_of(&crec["n"]));
    fx::close(
        "curv first",
        c.data[0] as f64,
        fx::num(&crec["first"]),
        1e-4,
    );

    let arec = &fx::section("freesurfer")["lh.fixture.annot"];
    let (field, table) = read_fs_annot(&fx::bytes("lh.fixture.annot")).unwrap();
    // §6.2: annotation values are remapped to DENSE 0..N-1 at parse time; a 256x1 LUT
    // cannot address the raw packed-RGB values, which here span 255..16,711,680.
    let raw_range = fx::usizes(&arec["rawLabelRange"]);
    assert!(
        raw_range[1] > 65535,
        "the fixture's raw ids really are packed RGB"
    );
    let dense = fx::usizes(&arec["denseLabels"]);
    assert_eq!(field.data.len(), dense.len());
    for (i, want) in dense.iter().enumerate() {
        assert_eq!(field.data[i] as usize, *want, "vertex {i}");
    }
    assert_eq!(
        table.entries.len(),
        arec["colortable"].as_array().unwrap().len()
    );
    for (i, entry) in arec["colortable"].as_array().unwrap().iter().enumerate() {
        // `originalId` is preserved in LabelEntry.id (§6.2).
        assert_eq!(table.entries[i].id as u64, fx::u64_of(&entry["packedId"]));
        let rgba = fx::usizes(&entry["rgba255"]);
        assert_eq!(table.entries[i].color[0] as usize, rgba[0]);
        assert_eq!(table.entries[i].color[1] as usize, rgba[1]);
        assert_eq!(table.entries[i].color[2] as usize, rgba[2]);
    }
}

// -------------------------------------------------------------------------------------
// phase 1 — STL / PLY / OBJ
// -------------------------------------------------------------------------------------

#[test]
fn stl_ascii_and_binary_agree_on_triangles_and_bounds() {
    // STL has no vertex table, so `nodes` is reader policy: Gmsh welds coincident vertices
    // (weldedNodes), a non-welding reader keeps 3 per facet (unweldedVertices). The
    // triangle count and the bounding box are the invariants.
    for name in ["patch_ascii.stl", "patch_binary.stl"] {
        let rec = &fx::section("surfaces")[name];
        let m = read_stl(fx::bytes(name)).unwrap();
        assert_eq!(
            m.tris.len() as u64,
            fx::u64_of(&rec["elementsByGmshType"]["2"])
        );
        let welded = fx::u64_of(&rec["weldedNodes"]) as usize;
        let unwelded = fx::u64_of(&rec["unweldedVertices"]) as usize;
        assert!(
            m.nodes.len() == welded || m.nodes.len() == unwelded,
            "{name}: {} nodes is neither {welded} (welded) nor {unwelded} (unwelded)",
            m.nodes.len()
        );
        // §6.2: read_stl emits no tri_edge_mask — the engine's constant-attribute fast path.
        assert!(m.tri_edge_mask.is_none(), "{name}");
        for (i, want) in fx::nums(&rec["bbox"]["min"]).iter().enumerate() {
            fx::close(
                &format!("{name}: min[{i}]"),
                m.bounds.min[i] as f64,
                *want,
                1e-3,
            );
        }
    }
}

#[test]
fn ply_ascii_and_binary_agree() {
    for name in ["patch_tri_ascii.ply", "patch_tri_binary.ply"] {
        let rec = &fx::section("surfaces")[name];
        let m = read_ply(fx::bytes(name)).unwrap();
        assert_eq!(m.nodes.len() as u64, fx::u64_of(&rec["nodes"]), "{name}");
        assert_eq!(
            m.tris.len() as u64,
            fx::u64_of(&rec["elementsByGmshType"]["2"]),
            "{name}"
        );
    }
}

#[test]
fn n_gon_loaders_emit_a_matching_tri_edge_mask() {
    // §6.2: read_ply and read_obj triangulate n-gons and MUST emit a tri_edge_mask, so the
    // barycentric wireframe does not draw the invented diagonal. patch_quad.obj and
    // patch_quad_ascii.ply hold the same 9 quads over the same 16 vertices.
    let obj_rec = &fx::section("surfaces")["patch_quad.obj"];
    let quads = fx::u64_of(&obj_rec["elementsByGmshType"]["3"]) as usize;
    assert_eq!(quads, 9);

    for (name, m) in [
        (
            "patch_quad.obj",
            read_obj(fx::bytes("patch_quad.obj")).unwrap(),
        ),
        (
            "patch_quad_ascii.ply",
            read_ply(fx::bytes("patch_quad_ascii.ply")).unwrap(),
        ),
    ] {
        assert_eq!(
            m.tris.len(),
            2 * quads,
            "{name}: each quad becomes 2 triangles"
        );
        assert_eq!(
            m.nodes.len() as u64,
            fx::u64_of(&obj_rec["nodes"]),
            "{name}"
        );
        let mask = m
            .tri_edge_mask
            .as_ref()
            .unwrap_or_else(|| panic!("{name}: an n-gon loader must emit tri_edge_mask"));
        assert_eq!(mask.len(), m.tris.len());
        // A quad split as (a,b,c) + (a,c,d): the diagonal a-c is opposite b in the first
        // (bit 1) and opposite d in the second (bit 2) — the §6.3 Cut.edge_mask rule.
        for pair in mask.chunks(2) {
            assert_eq!(pair[0] & 0b111, 0b101, "{name}: first half of a quad");
            assert_eq!(pair[1] & 0b111, 0b011, "{name}: second half of a quad");
        }
    }
    // The triangle-only variants are fully unmasked.
    let tri = read_obj(fx::bytes("patch_tri.obj")).unwrap();
    assert!(tri.tri_edge_mask.is_none() || tri.tri_edge_mask.unwrap().iter().all(|m| m & 7 == 7));
}

#[test]
fn sniff_identifies_every_fixture_from_its_bytes() {
    let cases: &[(&str, Format)] = &[
        ("mesh_v2_ascii.msh", Format::Msh),
        ("mesh_v2_binary.msh", Format::Msh),
        ("mesh_v41_ascii.msh", Format::Msh),
        ("mesh_v41_binary.msh", Format::Msh),
        ("surf_gzipb64.surf.gii", Format::Gifti),
        ("surf_ascii.surf.gii", Format::Gifti),
        ("lh.fixture.surf", Format::FsSurface),
        ("patch_ascii.stl", Format::Stl),
        ("patch_binary.stl", Format::Stl),
        ("patch_tri_ascii.ply", Format::Ply),
        ("patch_tri_binary.ply", Format::Ply),
        ("patch_tri.obj", Format::Obj),
    ];
    for (name, want) in cases {
        let b = fx::bytes(name);
        let ext = std::path::Path::new(name)
            .extension()
            .and_then(|e| e.to_str());
        assert_eq!(&sniff(&b, None).unwrap(), want, "{name}: no extension hint");
        assert_eq!(&sniff(&b, ext).unwrap(), want, "{name}: with hint {ext:?}");
    }
}
