//! `tvx-wasm` against the committed fixtures (ARCHITECTURE.md §6.4, §6.5, §11).
//!
//! This crate is the wasm-bindgen boundary: every §6.4 export takes or returns a
//! `JsValue` and most take an `&js_sys::Function` progress callback, so there is nothing
//! a **native** `cargo test` can call. The real coverage of this layer is
//! `packages/wasm`'s vitest suite driving the built `pkg/`, and the Playwright e2e that
//! loads a fixture through a module Worker (Phase-0 gate item 3).
//!
//! What this file does today is guard the *inputs* to that layer: the fixtures the worker
//! will be handed, and the one-to-one op-to-export mapping §6.5.2 pins.

mod common;
use common as fx;

/// §6.5's 17 ops, and the §6.4 export each one dispatches to. The TypeScript side asserts
/// the same bijection in `packages/protocol/src/index.test.ts`; keeping a copy here means
/// a Rust-side rename cannot drift away from the wire without one of the two failing.
const OP_TO_EXPORT: [(&str, &str); 17] = [
    ("loadVolume", "load_volume"),
    ("loadMesh", "load_mesh"),
    ("volumeFrame", "volume_frame"),
    ("surface", "mesh_surface"),
    ("boundary", "mesh_boundary"),
    ("buildTopology", "mesh_build_topology"),
    ("cut", "mesh_cut"),
    ("isolate", "mesh_isolate"),
    ("field", "mesh_field"),
    ("elmToNode", "mesh_convert_field"),
    ("locate", "mesh_locate"),
    ("marchingCubes", "volume_marching_cubes"),
    ("marchingTets", "mesh_marching_tets"),
    ("contours", "mesh_contours"),
    ("labelCentroids", "volume_label_centroids"),
    ("free", "free"),
    ("freeMask", "free_mask"),
];

#[test]
fn the_op_to_export_map_is_a_bijection_over_17_ops() {
    let mut ops: Vec<&str> = OP_TO_EXPORT.iter().map(|(o, _)| *o).collect();
    let mut exports: Vec<&str> = OP_TO_EXPORT.iter().map(|(_, e)| *e).collect();
    ops.sort_unstable();
    exports.sort_unstable();
    let (before_ops, before_exports) = (ops.len(), exports.len());
    ops.dedup();
    exports.dedup();
    assert_eq!(ops.len(), before_ops, "duplicate op name");
    assert_eq!(exports.len(), before_exports, "duplicate export name");
    assert_eq!(ops.len(), 17, "§6.5 freezes the op list at 17");
    // `wasm_heap_bytes` is the only export without an op (§6.5.2).
    assert!(!exports.contains(&"wasm_heap_bytes"));
}

#[test]
fn the_worker_can_reach_every_fixture_the_load_ops_take() {
    // `loadVolume`/`loadMesh` take a `LoadSource` plus role-keyed sidecars (§6.5.1): a
    // `lut` for both, an `opt` for meshes. Each pairing below is one the worker must be
    // able to fetch and hand to `load_volume(bytes, lut_bytes, ...)` /
    // `load_mesh(bytes, format, opt_bytes, lut_bytes, ...)`.
    let pairs: &[(&str, Option<&str>, Option<&str>)] = &[
        (
            "labels_simnibs.nii.gz",
            Some("labels_simnibs_LUT.txt"),
            None,
        ),
        (
            "labels_freesurfer.nii.gz",
            Some("labels_freesurfer_LUT.txt"),
            None,
        ),
        (
            "labels_float32.nii.gz",
            Some("labels_simnibs_LUT.txt"),
            None,
        ),
        (
            "mesh_v2_binary.msh",
            Some("mesh_v2_binary_LUT.txt"),
            Some("mesh_v2_binary.msh.opt"),
        ),
        ("mesh_v2_ascii.msh", None, Some("mesh_v2_binary.msh.opt")),
        ("vol_4d.nii.gz", None, None),
        ("surf_gzipb64.surf.gii", None, None),
    ];
    for (main, lut, opt) in pairs {
        assert!(!fx::bytes(main).is_empty(), "{main}");
        if let Some(l) = lut {
            assert!(!fx::bytes(l).is_empty(), "{main}: sidecar {l}");
        }
        if let Some(o) = opt {
            assert!(!fx::bytes(o).is_empty(), "{main}: sidecar {o}");
        }
    }
}

#[test]
fn gz_fixtures_carry_the_gzip_magic_the_worker_sniffs() {
    // §5 rule 4: the worker inflates with DecompressionStream('gzip'); the Rust readers
    // also sniff `1f 8b` so the crates stay usable natively and in plain-browser mode.
    for (name, _) in fx::entries("volumes") {
        let b = fx::bytes(name);
        let want_gz = name.ends_with(".gz");
        assert_eq!(
            b[0] == 0x1f && b[1] == 0x8b,
            want_gz,
            "{name}: gzip magic disagrees with the extension"
        );
    }
}

#[test]
#[ignore = "covered from TypeScript: packages/wasm/e2e/{volumes,meshes}.spec.ts"]
fn load_mesh_and_load_volume_round_trip_a_fixture() {
    // Nothing native can construct a `js_sys::Function` progress callback or read a transferable
    // result, so this round trip lives where those exist: `packages/wasm/e2e/volumes.spec.ts`
    // loads every fixture volume through the real module Worker and asserts the `VolumeMeta` it
    // gets back against `testdata/manifest.json`, and `meshes.spec.ts` does the same for every
    // fixture mesh, surface and sidecar. `protocol.spec.ts` covers the envelope itself. This test
    // stays as the pointer, so an agent looking for tvx-wasm's coverage finds where it lives.
    unimplemented!("see packages/wasm/e2e — the wasm boundary is tested from TypeScript");
}
