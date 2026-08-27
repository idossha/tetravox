//! `tvx-core` against the committed sidecar fixtures (ARCHITECTURE.md §6.0, §11).
//!
//! The LUT parsers and `BitMask` are `unimplemented!()` until Phase 1, so every test that
//! calls one is `#[ignore]`d. **Phase 1's job is to delete the `#[ignore]` line, not to
//! rewrite the assertion.** The expected entries live in `testdata/manifest.json` under
//! `sidecars`; unlike the volume and mesh numbers they are *authored*, because a LUT is a
//! plain text table with no third-party reader that yields §6.0's `LabelTable`.

use tvx_core::{BitMask, LabelTable, NoProgress, Phase, ProgressSink, PERCENTILES};

mod common;
use common as fx;

fn lut(name: &str) -> (&'static serde_json::Value, String) {
    (
        &fx::manifest()["sidecars"][name]["expected"],
        fx::text(name),
    )
}

// -------------------------------------------------------------------------------------
// live today
// -------------------------------------------------------------------------------------

#[test]
fn the_sidecar_fixtures_are_present_and_in_the_manifest() {
    for name in [
        "labels_simnibs_LUT.txt",
        "labels_freesurfer_LUT.txt",
        "mesh_v2_binary_LUT.txt",
        "mesh_v2_binary.msh.opt",
    ] {
        let rec = &fx::manifest()["sidecars"][name];
        assert!(!rec.is_null(), "manifest is missing sidecar {name}");
        assert_eq!(
            fx::bytes(name).len(),
            fx::u64_of(&rec["bytes"]) as usize,
            "{name} changed on disk without the manifest being regenerated"
        );
    }
    // One LUT in each of the two formats §6.0 names.
    assert_eq!(
        fx::manifest()["sidecars"]["labels_simnibs_LUT.txt"]["format"],
        "simnibs"
    );
    assert_eq!(
        fx::manifest()["sidecars"]["labels_freesurfer_LUT.txt"]["format"],
        "freesurfer"
    );
}

#[test]
fn the_percentile_order_is_the_frozen_one() {
    assert_eq!(
        PERCENTILES,
        [0.1, 1.0, 2.0, 5.0, 50.0, 95.0, 98.0, 99.0, 99.9]
    );
}

#[test]
fn no_progress_never_aborts() {
    // §6.0: the wasm ProgressSink returns false unconditionally — there is no
    // SharedArrayBuffer to poll (§1, §5 rule 6), so cancellation is worker.terminate().
    let mut p = NoProgress;
    p.report(Phase::Parse, 1, 2);
    assert!(!p.aborted());
}

// -------------------------------------------------------------------------------------
// phase 1
// -------------------------------------------------------------------------------------

#[test]
fn parse_simnibs_reads_a_tab_separated_lut() {
    // "#No.\tLabel Name:\tR G B A" — the SimNIBS format of `final_tissues_LUT.txt`.
    for name in ["labels_simnibs_LUT.txt", "mesh_v2_binary_LUT.txt"] {
        let (want, text) = lut(name);
        let t = LabelTable::parse_simnibs(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        let want = want.as_array().unwrap();
        assert_eq!(t.entries.len(), want.len(), "{name}");
        for w in want {
            let id = fx::u64_of(&w["id"]) as u32;
            let e = t.get(id).unwrap_or_else(|| panic!("{name}: no entry {id}"));
            assert_eq!(e.name, w["name"].as_str().unwrap(), "{name}: entry {id}");
            let rgba = fx::usizes(&w["rgba255"]);
            for (c, want) in rgba.iter().enumerate() {
                assert_eq!(e.color[c] as usize, *want, "{name}: entry {id} channel {c}");
            }
        }
    }
}

#[test]
fn parse_freesurfer_reads_a_colour_lut() {
    let (want, text) = lut("labels_freesurfer_LUT.txt");
    let t = LabelTable::parse_freesurfer(&text).unwrap();
    let want = want.as_array().unwrap();
    assert_eq!(t.entries.len(), want.len());
    for w in want {
        let id = fx::u64_of(&w["id"]) as u32;
        let e = t.get(id).unwrap_or_else(|| panic!("no entry {id}"));
        assert_eq!(e.name, w["name"].as_str().unwrap());
        let rgba = fx::usizes(&w["rgba255"]);
        for (c, want) in rgba.iter().enumerate() {
            assert_eq!(e.color[c] as usize, *want, "entry {id} channel {c}");
        }
    }
}

#[test]
fn label_tables_are_keyed_by_id_never_indexed_by_it() {
    // §4.2: SimNIBS/FreeSurfer ids are sparse and reach 530 `[DATA]`. The fixture LUT ends
    // at 530 for exactly that reason.
    let t = LabelTable::parse_simnibs(&fx::text("labels_simnibs_LUT.txt")).unwrap();
    assert!(t.get(530).is_some(), "the sparse high id must be reachable");
    assert!(t.get(4).is_none(), "and the gaps must stay gaps");
    assert!(
        t.entries.len() < 530,
        "a dense Vec indexed by id would be a bug"
    );
}

#[test]
fn generic_and_itksnap_parsers_accept_their_own_shapes() {
    // No committed fixture: neither format appears in the reference dataset, and both are
    // a couple of lines. They are written inline so the signatures stay exercised.
    let generic = "1 255 0 0 255 Left\n2 0 255 0 255 Right\n";
    let t = LabelTable::parse_generic(generic).unwrap();
    assert_eq!(t.entries.len(), 2);
    assert_eq!(t.get(2).unwrap().name, "Right");

    let itksnap = "################################################\n\
                   # ITK-SnAP Label Description File\n\
                   ################################################\n\
                       0     0    0    0        0  0  0    \"Clear Label\"\n\
                       1   255    0    0        1  1  1    \"Left\"\n";
    let t = LabelTable::parse_itksnap(itksnap).unwrap();
    assert_eq!(t.entries.len(), 2);
    assert_eq!(t.get(1).unwrap().color[0], 255);
}

#[test]
fn bitmask_round_trips_through_bytes() {
    // `isolate` hands a BitMask to `surface` / `boundary` / `cut` / `marchingTets` by id;
    // `as_bytes` / `from_bytes` is how it crosses a boundary when it must.
    let n = fx::u64_of(&fx::section("msh")["mesh_v2_binary.msh"]["tets"]) as usize;
    let mut m = BitMask::new_all(n, false);
    for i in (0..n).step_by(3) {
        m.set(i, true);
    }
    assert_eq!(m.len(), n);
    assert_eq!(m.count_ones(), n.div_ceil(3));
    let back = BitMask::from_bytes(n, m.as_bytes()).unwrap();
    for i in 0..n {
        assert_eq!(back.get(i), m.get(i), "bit {i}");
    }
    assert!(
        BitMask::from_bytes(n, &m.as_bytes()[..1]).is_err(),
        "a short buffer is an error, never a truncated mask"
    );
}
