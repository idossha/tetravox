//! Parsers against `testdata/tract_*`. Expected values are nibabel's and zipfile + numpy's reading of
//! those files (`scripts/gen-fixtures.py`), never the writer's.

use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use tvx_tract::{
    format_for_name, gpu_geometry, load_bytes, tangents_into, LoadOptions, Loader, TractFormat,
    Tractogram,
};

const ALL: LoadOptions = LoadOptions {
    max_points: None,
    seed: 1,
};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata")
}

fn manifest() -> &'static Value {
    static M: OnceLock<Value> = OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str(&std::fs::read_to_string(dir().join("manifest.json")).unwrap())
            .unwrap()
    })
}

fn load(name: &str) -> Tractogram {
    let bytes = std::fs::read(dir().join(name)).unwrap();
    load_bytes(format_for_name(name).unwrap(), &bytes, ALL)
        .unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn floats(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn assert_close(a: &[f32], b: &[f64], tol: f64, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        assert!((f64::from(*x) - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

fn field<'a>(fields: &'a [tvx_tract::TractField], name: &str) -> &'a [f32] {
    &fields
        .iter()
        .find(|f| f.name == name)
        .unwrap_or_else(|| panic!("no field {name}"))
        .values
}

#[test]
fn tck_matches_nibabel() {
    for (name, want) in manifest()["tracts"]["tck"].as_object().unwrap() {
        let t = load(name);
        let offsets: Vec<u64> = want["offsets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert_eq!(
            t.offsets.iter().map(|o| u64::from(*o)).collect::<Vec<_>>(),
            offsets,
            "{name}"
        );
        assert_close(&t.positions, &floats(&want["positions"]), 1e-5, name);
        assert_eq!(t.source_streamlines, 4);
        assert_eq!(t.source_points, 44);
        assert!(t.notes.is_empty(), "{:?}", t.notes);
    }
}

#[test]
fn trk_matches_nibabel_in_world_ras_mm() {
    for (name, want) in manifest()["tracts"]["trk"].as_object().unwrap() {
        let t = load(name);
        assert_close(&t.positions, &floats(&want["positions"]), 1e-4, name);
        let x = want["dpv"]["xval"].as_array().unwrap();
        let flat: Vec<f64> = x
            .iter()
            .map(|v| v.as_array().unwrap()[0].as_f64().unwrap())
            .collect();
        assert_close(field(&t.vertex_fields, "xval"), &flat, 1e-5, "xval");
        let mix = want["dpv"]["mix"].as_array().unwrap();
        for c in 0..2 {
            let col: Vec<f64> = mix
                .iter()
                .map(|v| v.as_array().unwrap()[c].as_f64().unwrap())
                .collect();
            assert_close(
                field(&t.vertex_fields, &format!("mix[{c}]")),
                &col,
                1e-5,
                "mix",
            );
        }
        let w: Vec<f64> = want["dps"]["weight"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v[0].as_f64().unwrap())
            .collect();
        assert_close(field(&t.streamline_fields, "weight"), &w, 1e-5, "weight");
    }
}

#[test]
fn trk_without_a_usable_affine_is_refused_by_name() {
    let bytes = std::fs::read(dir().join("tract_no_affine.trk")).unwrap();
    let e = load_bytes(TractFormat::Trk, &bytes, ALL)
        .unwrap_err()
        .to_string();
    assert!(e.contains("cannot place"), "{e}");
}

fn attach(t: &Tractogram, name: &str, bytes: &[u8]) -> tvx_core::Result<tvx_tract::Attached> {
    let mut l = tvx_tract::SidecarLoader::new(name, t)?;
    for c in bytes.chunks(17) {
        l.push(t, c)?;
    }
    l.finish(t)
}

/// A `.tsf` written by MRtrix, against MRtrix's own per-streamline mean of the same values.
#[test]
fn an_mrtrix_tsf_matches_mrtrix_on_its_own_tractogram() {
    let t = load("mrtrix_small.tck");
    let bytes = std::fs::read(dir().join("mrtrix_small_fa.tsf")).unwrap();
    let a = attach(&t, "mrtrix_small_fa.tsf", &bytes).unwrap();
    assert!(a.per_point && a.notes.is_empty(), "{:?}", a.notes);
    let f = &a.fields[0];
    assert_eq!(f.name, "mrtrix_small_fa");
    assert_eq!(f.values.len(), t.n_points());
    let want: Vec<f64> = std::fs::read_to_string(dir().join("mrtrix_small_fa_mean.txt"))
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with('#'))
        .flat_map(|l| l.split_whitespace())
        .map(|v| v.parse().unwrap())
        .collect();
    assert_eq!(want.len(), t.n_streamlines());
    for (i, w) in t.offsets.windows(2).enumerate() {
        // MRtrix weights each point by half of its two adjoining segments.
        let (a, b) = (w[0] as usize, w[1] as usize);
        let seg = |k: usize| -> f64 {
            (0..3)
                .map(|c| f64::from(t.positions[k * 3 + c] - t.positions[(k + 1) * 3 + c]).powi(2))
                .sum::<f64>()
                .sqrt()
        };
        let (mut integral, mut total) = (0.0, 0.0);
        for k in a..b {
            let before = if k > a { seg(k - 1) } else { 0.0 };
            let after = if k + 1 < b { seg(k) } else { 0.0 };
            let len = (before + after) * 0.5;
            integral += f64::from(f.values[k]) * len;
            total += len;
        }
        let mean = integral / total;
        assert!(
            (mean - want[i]).abs() < 1e-5,
            "streamline {i}: {mean} vs {}",
            want[i]
        );
    }
}

#[test]
fn a_tsf_follows_the_budget_and_refuses_another_tractogram() {
    let bytes = std::fs::read(dir().join("mrtrix_small.tck")).unwrap();
    let all = load("mrtrix_small.tck");
    let budget = LoadOptions {
        max_points: Some(all.n_points() as u64 / 4),
        seed: 1,
    };
    let some = load_bytes(TractFormat::Tck, &bytes, budget).unwrap();
    assert!(some.n_streamlines() < all.n_streamlines());
    let tsf = std::fs::read(dir().join("mrtrix_small_fa.tsf")).unwrap();
    let full = &attach(&all, "a.tsf", &tsf).unwrap().fields[0].values;
    let part = &attach(&some, "a.tsf", &tsf).unwrap().fields[0].values;
    for (i, source) in some.source_index.iter().enumerate() {
        let s = *source as usize;
        let (a, b) = (all.offsets[s] as usize, all.offsets[s + 1] as usize);
        let (c, d) = (some.offsets[i] as usize, some.offsets[i + 1] as usize);
        assert_eq!(&full[a..b], &part[c..d], "streamline {s}");
    }
    let e = attach(&load("tract_f32.tck"), "a.tsf", &tsf)
        .err()
        .unwrap()
        .to_string();
    assert!(e.contains("not made from this tractogram"), "{e}");
    let cut = &tsf[..tsf.len() - 6];
    assert!(
        attach(&all, "a.tsf", cut).is_err(),
        "a truncated tsf is refused"
    );
}

#[test]
fn text_tables_take_every_shape_mrtrix_writes() {
    let t = load("tract_f32.tck"); // 4 streamlines
                                   // tcksift2: one row, with a comment before it.
    let a = attach(&t, "w.txt", b"# command_history: x\n0.5 1.5 2.5 3.5\n").unwrap();
    assert!(!a.per_point);
    assert_eq!(a.fields[0].name, "w");
    assert_eq!(a.fields[0].values, vec![0.5, 1.5, 2.5, 3.5]);
    // One value a row.
    let a = attach(&t, "m.csv", b"1\n2\n3\n4\n").unwrap();
    assert_eq!(a.fields[0].values, vec![1.0, 2.0, 3.0, 4.0]);
    assert!(a.fields[0].categorical);
    // tck2connectome -out_assignments: two columns of node ids, spaces or commas.
    let a = attach(&t, "edges.txt", b"1 2\n1 3\n0 3\n2 2\n").unwrap();
    assert_eq!(a.fields[0].name, "edges[0]");
    assert_eq!(a.fields[1].values, vec![2.0, 3.0, 3.0, 2.0]);
    // A header names its columns, and CRLF is not a value.
    let a = attach(&t, "x.csv", b"age,dose\r\n1,2\r\n3,4\r\n5,6\r\n7,8\r\n").unwrap();
    assert_eq!(a.fields[1].name, "dose");
    assert_eq!(a.fields[1].values, vec![2.0, 4.0, 6.0, 8.0]);
    // What cannot be placed is refused, by name.
    let e = attach(&t, "w.txt", b"1 2 3\n").err().unwrap().to_string();
    assert!(e.contains("4 streamlines"), "{e}");
    let e = attach(&t, "w.txt", b"1 2\n3\n4\n5\n")
        .err()
        .unwrap()
        .to_string();
    assert!(e.contains(".tsf"), "{e}");
    let e = attach(&t, "w.txt", b"1\nx\n3\n4\n")
        .err()
        .unwrap()
        .to_string();
    assert!(e.contains("not a number"), "{e}");
}

#[test]
fn a_table_follows_the_budget() {
    let bytes = std::fs::read(dir().join("mrtrix_small.tck")).unwrap();
    let all = load("mrtrix_small.tck");
    let some = load_bytes(
        TractFormat::Tck,
        &bytes,
        LoadOptions {
            max_points: Some(all.n_points() as u64 / 4),
            seed: 1,
        },
    )
    .unwrap();
    let rows: String = (0..all.n_streamlines()).map(|i| format!("{i}\n")).collect();
    let a = attach(&some, "id.txt", rows.as_bytes()).unwrap();
    let want: Vec<f32> = some.source_index.iter().map(|i| *i as f32).collect();
    assert_eq!(a.fields[0].values, want);
}

#[test]
fn a_keep_field_hides_streamlines_on_top_of_a_filter_and_ends_colour_by_the_whole_line() {
    let mut t = load("tract_f32_stored.trx");
    tvx_tract::set_streamline_field(&mut t, "keep", vec![1.0, 0.0, f32::NAN, 1.0], None).unwrap();
    let spec = tvx_tract::StyleSpec {
        keep_field: Some("keep".into()),
        ends: true,
        ..Default::default()
    };
    let s = tvx_tract::style(&t, &spec).unwrap();
    assert_eq!(s.visible, vec![true, false, false, true]);
    assert_eq!(s.visible_streamlines, 2);
    // Streamline 0 runs along +x, 1 along +y, 2 along +z.
    assert_eq!(&s.rgba[0..3], &[255, 0, 0]);
    assert_eq!(&s.rgba[4..7], &[0, 255, 0]);
    assert_eq!(&s.rgba[8..11], &[0, 0, 255]);
    // A filter still applies, and a field that is not there hides nothing.
    let both = tvx_tract::StyleSpec {
        keep_field: Some("keep".into()),
        filter: Some(("weight".into(), None, Some(1.0))),
        ..Default::default()
    };
    assert_eq!(tvx_tract::style(&t, &both).unwrap().visible_streamlines, 1);
    let missing = tvx_tract::StyleSpec {
        keep_field: Some("gone".into()),
        ..Default::default()
    };
    assert_eq!(
        tvx_tract::style(&t, &missing).unwrap().visible_streamlines,
        4
    );
    // The wrong count is refused rather than padded.
    assert!(tvx_tract::set_streamline_field(&mut t, "x", vec![1.0], None).is_err());
}

#[test]
fn a_float64_tck_reads_like_its_float32_twin() {
    let want = load("tract_f32.tck");
    for name in ["tract_f64.tck", "tract_f64_be.tck"] {
        let t = load(name);
        assert_eq!(t.offsets, want.offsets, "{name}");
        assert_eq!(t.positions, want.positions, "{name}");
    }
}

#[test]
fn every_trk_v1_is_refused_because_the_format_has_no_affine() {
    let bytes = std::fs::read(dir().join("tract_v1.trk")).unwrap();
    let e = load_bytes(TractFormat::Trk, &bytes, ALL)
        .unwrap_err()
        .to_string();
    assert!(e.contains("cannot place") && e.contains("version 1"), "{e}");
}

#[test]
fn trk_n_count_zero_means_read_to_the_end() {
    let want = load("tract_ras.trk");
    let mut bytes = std::fs::read(dir().join("tract_ras.trk")).unwrap();
    bytes[988..992].fill(0);
    let t = load_bytes(TractFormat::Trk, &bytes, ALL).unwrap();
    assert_eq!(t.offsets, want.offsets);
    assert_eq!(t.positions, want.positions);
}

#[test]
fn trk_cut_mid_streamline_keeps_what_completed_and_says_so() {
    let mut bytes = std::fs::read(dir().join("tract_ras.trk")).unwrap();
    bytes.truncate(bytes.len() - 10);
    let t = load_bytes(TractFormat::Trk, &bytes, ALL).unwrap();
    assert_eq!(t.n_streamlines(), 3);
    assert!(!t.notes.is_empty());
}

#[test]
fn a_tck_count_that_disagrees_with_the_data_is_noted_and_the_data_wins() {
    let want = load("tract_f32.tck");
    let bytes = std::fs::read(dir().join("tract_f32.tck")).unwrap();
    let at = bytes.windows(8).position(|w| w == b"count: 4").unwrap();
    let mut wrong = bytes.clone();
    wrong[at + 7] = b'9';
    let t = load_bytes(TractFormat::Tck, &wrong, ALL).unwrap();
    assert_eq!(t.positions, want.positions);
    assert!(
        t.notes.iter().any(|n| n.contains("count 9")),
        "{:?}",
        t.notes
    );
}

#[test]
fn empty_tck_streamlines_are_dropped_and_noted() {
    let mut bytes = b"mrtrix tracks\ncount: 3\ndatatype: Float32LE\nfile: . 64\nEND\n".to_vec();
    bytes.resize(64, 0);
    let mut put = |v: [f32; 3]| {
        v.iter()
            .for_each(|c| bytes.extend_from_slice(&c.to_le_bytes()))
    };
    put([0.0, 0.0, 0.0]);
    put([1.0, 0.0, 0.0]);
    put([f32::NAN; 3]);
    put([f32::NAN; 3]); // the empty one
    put([2.0, 0.0, 0.0]);
    put([3.0, 0.0, 0.0]);
    put([f32::NAN; 3]);
    put([f32::INFINITY; 3]);
    let t = load_bytes(TractFormat::Tck, &bytes, ALL).unwrap();
    assert_eq!(t.n_streamlines(), 2);
    assert_eq!(t.notes.len(), 1, "{:?}", t.notes);
    assert!(t.notes[0].contains("1 empty"), "{:?}", t.notes);
}

#[test]
fn trx_says_what_it_did_not_read_and_what_it_rounded() {
    let t = load("tract_unread_entries.trx");
    let unread = t.notes.iter().find(|n| n.contains("not read")).unwrap();
    assert!(unread.contains("dpv/mask.bit"), "{unread}");
    assert!(unread.contains("dpg/left/mean.float32"), "{unread}");
    assert!(
        t.notes
            .iter()
            .any(|n| n.contains("dps/big_id.int64") && n.contains("2^24")),
        "{:?}",
        t.notes
    );
    assert!(load("tract_f32_stored.trx").notes.is_empty());
}

#[test]
fn trx_variants_match_an_independent_read() {
    let want = manifest()["tracts"]["trx"].as_object().unwrap();
    assert_eq!(want.len(), 11);
    for (name, w) in want {
        let t = load(name);
        assert_eq!(t.source_points, w["nbVertices"].as_u64().unwrap(), "{name}");
        assert_eq!(
            t.n_streamlines() as u64,
            w["nbStreamlines"].as_u64().unwrap(),
            "{name}"
        );
        assert_close(&t.positions, &floats(&w["positions"]), 1e-3, name);
        assert_eq!(
            t.offsets.iter().map(|o| i64::from(*o)).collect::<Vec<_>>(),
            w["offsets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_i64().unwrap())
                .collect::<Vec<_>>(),
            "{name}"
        );
        assert_close(
            field(&t.vertex_fields, "along"),
            &floats(&w["along"]),
            1e-5,
            "along",
        );
        assert_close(
            field(&t.vertex_fields, "half"),
            &floats(&w["half"]),
            1e-3,
            "half",
        );
        assert_close(
            field(&t.streamline_fields, "weight"),
            &floats(&w["weight"]),
            1e-6,
            "weight",
        );
        assert_close(
            field(&t.streamline_fields, "edge_id"),
            &floats(&w["edgeId"]),
            0.0,
            "edge_id",
        );
        assert!(
            t.vertex_fields.iter().any(|f| f.name == "vec[2]"),
            "{name}: multi-component split"
        );
        let left = t.groups.iter().find(|g| g.name == "left").unwrap();
        assert_eq!(left.streamlines, vec![0, 2], "{name}");
        assert!(
            t.streamline_fields
                .iter()
                .find(|f| f.name == "edge_id")
                .unwrap()
                .categorical
        );
        assert!(
            !t.streamline_fields
                .iter()
                .find(|f| f.name == "weight")
                .unwrap()
                .categorical
        );
    }
}

#[test]
fn chunk_boundaries_do_not_change_the_result() {
    for name in [
        "tract_f32.tck",
        "tract_ras.trk",
        "tract_f16_deflated.trx",
        "tract_streamed.trx",
        "tract_positions_first.trx",
        "tract_header_last.trx",
    ] {
        let bytes = std::fs::read(dir().join(name)).unwrap();
        let whole = load_bytes(format_for_name(name).unwrap(), &bytes, ALL).unwrap();
        for size in [1usize, 3, 7, 1021] {
            let mut l =
                Loader::new(format_for_name(name).unwrap(), bytes.len() as u64, ALL).unwrap();
            loop {
                for c in bytes.chunks(size) {
                    l.push(c).unwrap();
                }
                if !l.end_pass().unwrap() {
                    break;
                }
            }
            let t = l.finish().unwrap();
            assert_eq!(t.positions, whole.positions, "{name} chunk {size}");
            assert_eq!(t.offsets, whole.offsets);
            assert_eq!(t.fingerprint, tvx_core::fingerprint(&bytes), "{name}");
        }
    }
}

/// A synthetic TCK of `n` lines, each `len(i)` points, with the end marker.
fn tck(n: u64, len: impl Fn(u64) -> u64) -> Vec<u8> {
    let mut out = b"mrtrix tracks\ndatatype: Float32LE\nfile: . 64\nEND\n".to_vec();
    out.resize(64, 0);
    let f = |v: f32, o: &mut Vec<u8>| o.extend_from_slice(&v.to_le_bytes());
    for i in 0..n {
        for p in 0..len(i) {
            f(i as f32, &mut out);
            f(p as f32, &mut out);
            f(0.0, &mut out);
        }
        for _ in 0..3 {
            f(f32::NAN, &mut out);
        }
    }
    for _ in 0..3 {
        f(f32::INFINITY, &mut out);
    }
    out
}

#[test]
fn the_budget_is_uniform_deterministic_nested_and_metric_neutral() {
    let lens = |i: u64| 5 + (i * 7919) % 90;
    let bytes = tck(20_000, lens);
    let all = load_bytes(TractFormat::Tck, &bytes, ALL).unwrap();
    assert_eq!(all.n_streamlines(), 20_000);
    let cap = all.source_points / 4;
    let opts = LoadOptions {
        max_points: Some(cap),
        seed: 7,
    };
    let a = load_bytes(TractFormat::Tck, &bytes, opts).unwrap();
    let b = load_bytes(TractFormat::Tck, &bytes, opts).unwrap();
    assert_eq!(a.source_index, b.source_index, "deterministic");
    assert_eq!(a.source_streamlines, 20_000);
    assert_eq!(a.source_points, all.source_points);
    assert!(
        (a.n_points() as u64) < cap + cap / 10,
        "{} vs {cap}",
        a.n_points()
    );
    assert!((a.n_points() as u64) > cap / 2);
    // Metric-neutral: kept streamlines have the population's mean length, within sampling error.
    let mean = |t: &Tractogram| t.n_points() as f64 / t.n_streamlines() as f64;
    assert!(
        (mean(&a) - mean(&all)).abs() < 1.5,
        "{} vs {}",
        mean(&a),
        mean(&all)
    );
    // Uniform in file position: the kept indices are not bunched.
    let half = a.source_index.iter().filter(|i| **i < 10_000).count() as f64;
    assert!((half / a.n_streamlines() as f64 - 0.5).abs() < 0.03);
    // Nested: a larger budget is a superset.
    let big = load_bytes(
        TractFormat::Tck,
        &bytes,
        LoadOptions {
            max_points: Some(cap * 2),
            seed: 7,
        },
    )
    .unwrap();
    for i in &a.source_index {
        assert!(
            big.source_index.binary_search(i).is_ok(),
            "{i} missing from the larger budget"
        );
    }
    // Fields stay aligned under subsampling: y of the first kept streamline is 0..n.
    let s0 = &a.positions[a.offsets[0] as usize * 3..a.offsets[1] as usize * 3];
    assert_eq!(s0[0], a.source_index[0] as f32);
    assert_eq!(s0[1], 0.0);
}

#[test]
fn a_subsampled_trx_keeps_every_array_aligned() {
    let bytes = std::fs::read(dir().join("tract_f32_deflated.trx")).unwrap();
    for seed in 0..40 {
        let t = load_bytes(
            TractFormat::Trx,
            &bytes,
            LoadOptions {
                max_points: Some(22),
                seed,
            },
        )
        .unwrap();
        let along = field(&t.vertex_fields, "along");
        assert_eq!(along.len(), t.n_points());
        for (p, a) in t.positions.chunks_exact(3).zip(along) {
            assert_eq!(p[0], *a);
        }
        let weight = field(&t.streamline_fields, "weight");
        for (s, w) in t.source_index.iter().zip(weight) {
            assert_eq!(*w, *s as f32 + 0.5);
        }
    }
}

#[test]
fn a_truncated_tck_keeps_complete_streamlines_and_says_so() {
    let mut bytes = tck(3, |_| 4);
    bytes.truncate(bytes.len() - 12 - 12 - 7);
    let t = load_bytes(TractFormat::Tck, &bytes, ALL).unwrap();
    assert_eq!(t.n_streamlines(), 2);
    assert_eq!(t.n_points(), 8);
    assert!(t.notes[0].contains("truncated"), "{:?}", t.notes);
}

#[test]
fn garbage_and_truncated_zip_are_errors_not_panics() {
    assert!(load_bytes(TractFormat::Trx, b"garbage garbage", ALL).is_err());
    assert!(load_bytes(TractFormat::Tck, b"garbage garbage", ALL).is_err());
    assert!(load_bytes(TractFormat::Trk, b"garbage garbage", ALL).is_err());
    let bytes = std::fs::read(dir().join("tract_f32_stored.trx")).unwrap();
    assert!(load_bytes(TractFormat::Trx, &bytes[..bytes.len() / 2], ALL).is_err());
}

#[test]
fn tangents_are_central_with_one_sided_ends() {
    let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 5.0, 5.0, 5.0];
    let offsets = [0, 3, 4];
    let mut t = [0.0f32; 12];
    tangents_into(&positions, &offsets, 0, &mut t);
    assert_eq!(&t[0..3], &[1.0, 0.0, 0.0]);
    let r = std::f32::consts::FRAC_1_SQRT_2;
    assert!((t[3] - r).abs() < 1e-6 && (t[4] - r).abs() < 1e-6);
    assert_eq!(&t[6..9], &[0.0, 1.0, 0.0]);
    assert_eq!(
        &t[9..12],
        &[0.0, 0.0, 0.0],
        "a one-point streamline has no direction"
    );
    let mut part = [0.0f32; 3];
    tangents_into(&positions, &offsets, 2, &mut part);
    assert_eq!(
        &part,
        &[0.0, 1.0, 0.0],
        "a chunk starting mid-streamline agrees"
    );
}

#[test]
fn gpu_buffers_round_trip_position_and_axis_tangents() {
    let t = load("tract_f32.tck");
    let g = gpu_geometry(&t);
    assert_eq!(g.vertices.len(), t.n_points() * 8);
    assert_eq!(g.streamline_ids.len(), t.n_points());
    assert_eq!(g.indices.len(), t.n_points() + t.n_streamlines());
    assert_eq!(
        g.indices.iter().filter(|i| **i == u32::MAX).count(),
        t.n_streamlines()
    );
    for (i, p) in t.positions.chunks_exact(3).enumerate() {
        for (c, want) in p.iter().enumerate() {
            let b = &g.vertices[i * 8 + c * 2..];
            let q = f32::from(i16::from_le_bytes([b[0], b[1]]));
            assert!(
                (g.origin[c] + q * g.quantum - want).abs() <= g.quantum,
                "{i} {c}"
            );
        }
    }
    // +x, +y, +z, the three fixture axes; octahedral (x, y) with z positive.
    let oct = |i: usize| (g.vertices[i * 8 + 6] as i8, g.vertices[i * 8 + 7] as i8);
    assert_eq!(oct(5), (127, 0));
    assert_eq!(oct(21 + 3), (0, 127));
    assert_eq!(oct(21 + 11 + 3), (0, 0));
}

#[test]
fn a_trx_float16_decodes_exact_binary16_values() {
    let bytes = std::fs::read(dir().join("tract_f16_stored.trx")).unwrap();
    let t = load_bytes(TractFormat::Trx, &bytes, ALL).unwrap();
    assert_eq!(t.positions[0], -10.0);
    assert_eq!(t.positions[3], -9.0);
}

/// Real-data gate: same totals as the file's own header, and the 396 MB TCK scanned at the default budget.
#[test]
fn real_tractograms_when_present() {
    let Ok(root) = std::env::var("TETRAVOX_TRACT_TESTDATA") else {
        eprintln!("skipped: TETRAVOX_TRACT_TESTDATA is unset");
        return;
    };
    let root = PathBuf::from(root);
    let tck = root.join("validation/mrtrix_ref/tracks_ifod2_200k.tck");
    let opts = LoadOptions {
        max_points: Some(8_000_000),
        seed: 1,
    };
    let len = std::fs::metadata(&tck).unwrap().len();
    let mut l = Loader::new(TractFormat::Tck, len, opts).unwrap();
    use std::io::Read;
    let mut f = std::fs::File::open(&tck).unwrap();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        l.push(&buf[..n]).unwrap();
    }
    assert!(!l.end_pass().unwrap());
    let t = l.finish().unwrap();
    assert_eq!(t.source_streamlines, 200_000);
    assert!((t.n_points() as u64) < 8_800_000);
    assert!(t.notes.is_empty(), "{:?}", t.notes);

    let trx = root.join(
        "project/derivatives/SimNIBS/sub-CHN/Simulations/thalamus/tract/thalamocortical_lh.trx",
    );
    let t = load_bytes(TractFormat::Trx, &std::fs::read(trx).unwrap(), ALL).unwrap();
    assert_eq!((t.n_streamlines(), t.n_points()), (2624, 348_789));
    assert!(t.vertex_fields.iter().any(|f| f.name == "ti_along"));
    assert!(
        t.streamline_fields
            .iter()
            .find(|f| f.name == "edge_id")
            .unwrap()
            .categorical
    );
}
