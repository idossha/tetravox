//! The sidecar LUT parse, against `testdata/manifest.json`'s authored tables and against the real
//! SimNIBS LUTs.
//!
//! §6.4 puts this parse **in the worker** — "sidecar LUT text is parsed in the worker as part of
//! `load_volume` / `load_mesh`, from their `lut_bytes` argument" — and `tvx_core::LabelTable`'s
//! `parse_*` are still Phase-0 stubs in a crate this agent does not own, so `tvx_wasm::lut` is
//! where it lives for now (`docs/DECISIONS.md`). These are its tests; the wire-level checks that the
//! table reaches `VolumeMeta.labelTable` are `packages/wasm/e2e/volumes.spec.ts`'s.

mod common;
use common as fx;

use serde_json::Value;

fn expected(sidecar: &str) -> &'static Vec<Value> {
    fx::manifest()["sidecars"][sidecar]["expected"]
        .as_array()
        .unwrap_or_else(|| panic!("manifest sidecars/{sidecar} has no `expected` array"))
}

fn check(sidecar: &str, file: &str) {
    let table = tvx_wasm::lut::parse(&fx::text(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
    let want = expected(sidecar);
    assert_eq!(table.entries.len(), want.len(), "{file}: entry count");
    for (got, w) in table.entries.iter().zip(want) {
        assert_eq!(u64::from(got.id), fx::u64_of(&w["id"]), "{file}: id");
        assert_eq!(got.name, w["name"].as_str().unwrap(), "{file}: name");
        let rgba = fx::usizes(&w["rgba255"]);
        assert_eq!(
            got.color.map(usize::from).to_vec(),
            rgba,
            "{file}: colour of {}",
            got.name
        );
    }
}

#[test]
fn the_simnibs_volume_lut_is_the_manifest() {
    check("labels_simnibs_LUT.txt", "labels_simnibs_LUT.txt");
}

#[test]
fn the_freesurfer_lut_is_the_manifest_including_its_zero_alpha() {
    check("labels_freesurfer_LUT.txt", "labels_freesurfer_LUT.txt");
}

#[test]
fn the_mesh_lut_is_the_manifest() {
    check("mesh_v2_binary_LUT.txt", "mesh_v2_binary_LUT.txt");
}

#[test]
fn the_two_lut_shapes_are_told_apart_without_a_format_hint() {
    // The worker is handed `lut_bytes` with no format: `lut` is a role, not a type (§6.5.1). The
    // SimNIBS table is tab-padded and the FreeSurfer one is space-aligned, and both must read the
    // same way round — id first, name second, colour last.
    let simnibs = tvx_wasm::lut::parse(&fx::text("labels_simnibs_LUT.txt")).unwrap();
    let freesurfer = tvx_wasm::lut::parse(&fx::text("labels_freesurfer_LUT.txt")).unwrap();
    assert_eq!(simnibs.entries[1].name, "WM");
    assert_eq!(freesurfer.entries[1].name, "Alpha");
    assert_eq!(freesurfer.entries[1].id, 3);
}

/// Real data (AGENTS rule 2): skips, never fails, when `TETRAVOX_TESTDATA` is unset.
fn real_root() -> Option<std::path::PathBuf> {
    std::env::var_os("TETRAVOX_TESTDATA").map(std::path::PathBuf::from)
}

#[test]
fn the_reference_simnibs_luts_parse() {
    let Some(root) = real_root() else { return };
    for (rel, id, name, color) in [
        (
            "m2m_ernie/final_tissues_LUT.txt",
            1u32,
            "White-Matter",
            [230u8, 230, 230, 255],
        ),
        (
            "m2m_ernie/segmentation/labeling_LUT.txt",
            3u32,
            "Left-Cerebral-Cortex",
            [205u8, 62, 78, 255],
        ),
    ] {
        let path = root.join(rel);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let table = tvx_wasm::lut::parse(&text).unwrap_or_else(|e| panic!("{rel}: {e}"));
        assert!(
            table.entries.len() >= 10,
            "{rel}: {} entries",
            table.entries.len()
        );
        let entry = table
            .entries
            .iter()
            .find(|e| e.id == id)
            .unwrap_or_else(|| panic!("{rel}: no entry {id}"));
        assert_eq!(entry.name, name, "{rel}: name of {id}");
        assert_eq!(entry.color, color, "{rel}: colour of {id}");

        // Ids come back sorted and unique, because `VolumeMeta.labelTable` is read by lookup.
        let ids: Vec<u32> = table.entries.iter().map(|e| e.id).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ids, sorted, "{rel}: entries are sorted and unique");
    }
}
