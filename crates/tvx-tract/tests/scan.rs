//! §6.3.1's scan against a full load of the same bytes, itself pinned to nibabel and numpy by
//! `fixtures.rs`. Pins: every chunk concatenated is the file, byte for byte, at any push boundary; a
//! budget cannot change it; retained memory follows the chunk size; bad inputs refuse.
//! Real data: `TETRAVOX_TRACT_TESTDATA=<Dataset 000>`, numbers from
//! `python3 scripts/refvalues/tract_refvalues.py <Dataset 000>`, a numpy reader of the raw files.

use std::path::PathBuf;
use tvx_tract::{
    apply_attached, format_for_name, load_bytes, LoadOptions, ScanChunk, SidecarLoader,
    TractFormat, TractScanner, Tractogram,
};

const ALL: LoadOptions = LoadOptions {
    max_points: None,
    seed: 1,
};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(dir().join(name)).unwrap()
}

/// A worker's loop: feed in `push` sized pieces, feed sidecars when told, take chunks as they fill.
fn scan_with(
    s: &mut TractScanner,
    bytes: &[u8],
    push: usize,
    cars: &[(u32, &[u8])],
) -> Result<Vec<ScanChunk>, tvx_core::Error> {
    let mut at = vec![0usize; cars.len()];
    let mut feed = |s: &mut TractScanner| -> Result<(), tvx_core::Error> {
        for (k, (id, data)) in cars.iter().enumerate() {
            while s.attach_hungry(*id) {
                if at[k] >= data.len() {
                    s.attach_end(*id)?;
                    break;
                }
                let end = (at[k] + push).min(data.len());
                s.attach_push(*id, &data[at[k]..end])?;
                at[k] = end;
            }
        }
        Ok(())
    };
    feed(s)?;
    let mut out = Vec::new();
    let mut take = |s: &mut TractScanner,
                    feed: &mut dyn FnMut(&mut TractScanner) -> Result<(), tvx_core::Error>|
     -> Result<(), tvx_core::Error> {
        while s.ready()? {
            feed(s)?;
            out.push(s.take()?.expect("ready"));
        }
        Ok(())
    };
    loop {
        for piece in bytes.chunks(push) {
            s.push(piece)?;
            take(s, &mut feed)?;
        }
        if !s.end_pass()? {
            break;
        }
    }
    take(s, &mut feed)?;
    feed(s)?;
    Ok(out)
}

fn scan(
    t: &Tractogram,
    format: TractFormat,
    bytes: &[u8],
    fields: &[&str],
    chunk: u32,
    push: usize,
) -> Result<Vec<ScanChunk>, tvx_core::Error> {
    let names = fields.iter().map(|s| (*s).to_string()).collect();
    let mut s = TractScanner::new(t, format, bytes.len() as u64, names, chunk)?;
    let out = scan_with(&mut s, bytes, push, &[])?;
    let (streamlines, points) = s.finish()?;
    assert_eq!(streamlines, t.source_streamlines);
    assert_eq!(
        points,
        out.iter()
            .map(|c| u64::from(*c.offsets.last().unwrap()))
            .sum::<u64>()
    );
    Ok(out)
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

/// Concatenate chunks, checking the gapless file order the API promises and the named fields.
fn assert_is_full_load(chunks: &[ScanChunk], full: &Tractogram, fields: &[&str], what: &str) {
    let mut positions = Vec::new();
    let mut offsets = vec![0u32];
    for c in chunks {
        assert_eq!(c.first_source as usize, offsets.len() - 1, "{what}: gap");
        assert_eq!(c.offsets[0], 0, "{what}");
        let base = *offsets.last().unwrap();
        offsets.extend(c.offsets[1..].iter().map(|o| o + base));
        positions.extend_from_slice(&c.positions);
    }
    assert_eq!(bits(&positions), bits(&full.positions), "{what}: positions");
    assert_eq!(offsets, full.offsets, "{what}: offsets");
    for (list, per_point) in [
        (&full.vertex_fields, true),
        (&full.streamline_fields, false),
    ] {
        for f in list.iter().filter(|f| fields.contains(&f.name.as_str())) {
            let mut got = Vec::new();
            for c in chunks {
                let from = if per_point {
                    &c.vertex_fields
                } else {
                    &c.streamline_fields
                };
                let found = from.iter().find(|(n, _)| *n == f.name);
                got.extend_from_slice(&found.unwrap_or_else(|| panic!("{what}: no {}", f.name)).1);
            }
            assert_eq!(bits(&got), bits(&f.values), "{what}: {}", f.name);
        }
    }
    for f in fields {
        assert!(
            full.vertex_fields
                .iter()
                .chain(&full.streamline_fields)
                .any(|x| x.name == *f),
            "{what}: {f} is not a field to compare"
        );
    }
}

/// Everything a parser accepts. The two refused TRKs have their own load tests.
fn fixtures() -> Vec<(String, TractFormat)> {
    let mut names: Vec<_> = std::fs::read_dir(dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.starts_with("tract_") || n == "mrtrix_small.tck")
        .filter(|n| !n.ends_with(".nii") && n != "tract_no_affine.trk" && n != "tract_v1.trk")
        .filter_map(|n| format_for_name(&n).map(|f| (n, f)))
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    names
}

#[test]
fn every_fixture_concatenates_to_a_full_load_at_any_boundary() {
    let found = fixtures();
    assert!(found.len() >= 15, "has fixtures to check: {found:?}");
    for (name, format) in found {
        let bytes = read(&name);
        let full = load_bytes(format, &bytes, ALL).unwrap();
        // TRX dpv are refused by design; `every TRX dpv` below says so.
        let fields: Vec<&str> = full
            .streamline_fields
            .iter()
            .chain(if format == TractFormat::Trx {
                [].iter()
            } else {
                full.vertex_fields.iter()
            })
            .map(|f| f.name.as_str())
            .collect();
        for push in [1, 7, 4096, bytes.len()] {
            for chunk in [1, 5, 1_000_000] {
                let chunks = scan(&full, format, &bytes, &fields, chunk, push)
                    .unwrap_or_else(|e| panic!("{name} push {push} chunk {chunk}: {e}"));
                assert_is_full_load(&chunks, &full, &fields, &format!("{name} {push} {chunk}"));
            }
        }
    }
}

#[test]
fn geometry_only_is_the_default_and_delivers_no_fields() {
    let bytes = read("tract_ras.trk");
    let full = load_bytes(TractFormat::Trk, &bytes, ALL).unwrap();
    assert!(
        !full.vertex_fields.is_empty(),
        "the fixture has a field to leave out"
    );
    for c in scan(&full, TractFormat::Trk, &bytes, &[], 4, 64).unwrap() {
        assert!(c.vertex_fields.is_empty() && c.streamline_fields.is_empty());
    }
}

/// A chunk stops at the first streamline that reaches the size, and only the last may fall short.
#[test]
fn a_chunk_holds_whole_streamlines_about_the_asked_size() {
    let bytes = read("mrtrix_small.tck");
    let full = load_bytes(TractFormat::Tck, &bytes, ALL).unwrap();
    let chunks = scan(&full, TractFormat::Tck, &bytes, &[], 10, 4096).unwrap();
    assert!(chunks.len() > 1, "has chunks to check");
    for (i, c) in chunks.iter().enumerate() {
        let n = c.offsets.len();
        let last = c.offsets[n - 1];
        assert_eq!(c.positions.len(), last as usize * 3);
        if i + 1 < chunks.len() {
            assert!(
                last >= 10 && c.offsets[n - 2] < 10,
                "chunk {i}: {:?}",
                c.offsets
            );
        }
    }
}

#[test]
fn a_thinned_load_changes_nothing_a_scan_sees() {
    let bytes = read("mrtrix_small.tck");
    let full = load_bytes(TractFormat::Tck, &bytes, ALL).unwrap();
    let opts = LoadOptions {
        max_points: Some(full.n_points() as u64 / 4),
        seed: 1,
    };
    let thin = load_bytes(TractFormat::Tck, &bytes, opts).unwrap();
    assert!(
        thin.n_streamlines() < full.n_streamlines(),
        "the budget must thin it"
    );
    // `source_points` is the file's whole total at any budget.
    assert_eq!(thin.source_points, full.n_points() as u64);
    assert_eq!(thin.source_streamlines, full.n_streamlines() as u64);
    let chunks = scan(&thin, TractFormat::Tck, &bytes, &[], 10, 4096).unwrap();
    assert_is_full_load(&chunks, &full, &[], "thinned");
}

fn attached_full(tck: &[u8], side: &str) -> Tractogram {
    let mut full = load_bytes(TractFormat::Tck, tck, ALL).unwrap();
    let mut l = SidecarLoader::new(side, &full).unwrap();
    l.push(&full, &read(side)).unwrap();
    let a = l.finish(&full).unwrap();
    apply_attached(&mut full, a);
    full
}

/// Sidecars cover the streamlines the display thinned, where the held copy has no values at all.
#[test]
fn sidecars_cover_every_streamline_on_a_thinned_dataset() {
    let tck = read("mrtrix_small.tck");
    let opts = LoadOptions {
        max_points: Some(20),
        seed: 1,
    };
    let thin = load_bytes(TractFormat::Tck, &tck, opts).unwrap();
    let full_tsf = attached_full(&tck, "mrtrix_small_fa.tsf");
    let full_txt = attached_full(&tck, "mrtrix_small_fa_mean.txt");
    assert!(
        thin.n_streamlines() < full_tsf.n_streamlines(),
        "the budget must thin it"
    );

    let run = |side: &str, field: &str, chunk: u32, push: usize| {
        let mut s = TractScanner::new(
            &thin,
            TractFormat::Tck,
            tck.len() as u64,
            vec![field.to_string()],
            chunk,
        )
        .unwrap();
        let id = s.attach_begin(side).unwrap();
        let data = read(side);
        let out = scan_with(&mut s, &tck, push, &[(id, &data)]).unwrap();
        s.finish().unwrap();
        out
    };
    for push in [1, 13, 4096] {
        for chunk in [1, 10, 1_000_000] {
            let c = run("mrtrix_small_fa.tsf", "mrtrix_small_fa", chunk, push);
            assert_is_full_load(
                &c,
                &full_tsf,
                &["mrtrix_small_fa"],
                &format!("tsf {push} {chunk}"),
            );
            let c = run(
                "mrtrix_small_fa_mean.txt",
                "mrtrix_small_fa_mean",
                chunk,
                push,
            );
            assert_is_full_load(
                &c,
                &full_txt,
                &["mrtrix_small_fa_mean"],
                &format!("txt {push} {chunk}"),
            );
        }
    }
}

#[test]
fn a_tsf_that_does_not_match_is_refused_mid_scan_or_at_the_end() {
    let tck = read("mrtrix_small.tck");
    let t = load_bytes(TractFormat::Tck, &tck, ALL).unwrap();
    let tsf = read("mrtrix_small_fa.tsf");
    let header_end = tsf.windows(5).position(|w| w == b"\nEND\n").unwrap() + 5;
    let offset: usize = String::from_utf8_lossy(&tsf[..header_end])
        .lines()
        .find_map(|l| {
            l.strip_prefix("file: . ")
                .map(|o| o.trim().parse().unwrap())
        })
        .unwrap();
    let run = |data: &[u8]| {
        let mut s = TractScanner::new(
            &t,
            TractFormat::Tck,
            tck.len() as u64,
            vec!["mrtrix_small_fa".to_string()],
            10,
        )
        .unwrap();
        let id = s.attach_begin("mrtrix_small_fa.tsf").unwrap();
        scan_with(&mut s, &tck, 512, &[(id, data)])?;
        s.finish()
    };
    assert!(run(&tsf).is_ok(), "the unmodified file is accepted");

    // One whole streamline's values gone from the front: the next length no longer lines up.
    let width = 4;
    let body = &tsf[offset..];
    let first_nan = body
        .chunks_exact(width)
        .position(|v| f32::from_le_bytes(v.try_into().unwrap()).is_nan())
        .unwrap();
    let mut shifted = tsf[..offset].to_vec();
    shifted.extend_from_slice(&body[(first_nan + 1) * width..]);
    assert!(run(&shifted)
        .unwrap_err()
        .to_string()
        .contains("not made from this tractogram"));

    // A spare streamline at the end is only visible by reading on past the last chunk.
    let mut extra = tsf.clone();
    extra.extend_from_slice(&1.0f32.to_le_bytes());
    extra.extend_from_slice(&f32::NAN.to_le_bytes());
    let e = run(&extra).unwrap_err().to_string();
    assert!(e.contains("more values"), "{e}");
}

fn tck_bytes(streamlines: usize, points_each: usize) -> Vec<u8> {
    let mut head = String::from("mrtrix tracks\ndatatype: Float32LE\nfile: . 64\n");
    head.push_str(&format!("count: {streamlines}\nEND\n"));
    let mut out = head.into_bytes();
    out.resize(64, 0);
    for s in 0..streamlines {
        for p in 0..points_each {
            for v in [s as f32, p as f32, 1.0f32] {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        for _ in 0..3 {
            out.extend_from_slice(&f32::NAN.to_le_bytes());
        }
    }
    for _ in 0..3 {
        out.extend_from_slice(&f32::INFINITY.to_le_bytes());
    }
    out
}

/// A stored zip, in a given member order, so the bound below reaches TRX's own path.
fn stored_trx(members: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, data) in members {
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
    }
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out
}

fn trx_bytes(streamlines: usize, points_each: usize, positions_first: bool) -> Vec<u8> {
    let header = serde_json::json!({
        "NB_VERTICES": streamlines * points_each, "NB_STREAMLINES": streamlines,
        "VOXEL_TO_RASMM": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]], "DIMENSIONS": [1,1,1],
    })
    .to_string()
    .into_bytes();
    let offsets: Vec<u8> = (0..=streamlines)
        .flat_map(|s| ((s * points_each) as u32).to_le_bytes())
        .collect();
    let mut positions = Vec::with_capacity(streamlines * points_each * 12);
    for s in 0..streamlines {
        for p in 0..points_each {
            for v in [s as f32, p as f32, 2.0f32] {
                positions.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    let dps: Vec<u8> = (0..streamlines)
        .flat_map(|s| (s as f32).to_le_bytes())
        .collect();
    let dpv = vec![0u8; streamlines * points_each * 4];
    let mut m = vec![
        ("header.json", header),
        ("offsets.uint32", offsets),
        ("positions.3.float32", positions),
        ("dps/w.float32", dps),
        ("dpv/v.float32", dpv),
    ];
    if positions_first {
        m.swap(0, 2);
    }
    stored_trx(&m)
}

fn trk_bytes(streamlines: usize, points_each: usize) -> Vec<u8> {
    // The header is the fixture's: only the count of its body differs.
    let mut out = read("tract_ras.trk")[..1000].to_vec();
    let (ns, np) = (
        i16::from_le_bytes([out[36], out[37]]) as usize,
        i16::from_le_bytes([out[238], out[239]]) as usize,
    );
    out[988..992].copy_from_slice(&(streamlines as i32).to_le_bytes());
    for s in 0..streamlines {
        out.extend_from_slice(&(points_each as i32).to_le_bytes());
        for p in 0..points_each {
            for v in [s as f32, p as f32, 1.0f32] {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.extend(std::iter::repeat_n(0u8, ns * 4));
        }
        out.extend(std::iter::repeat_n(0u8, np * 4));
    }
    out
}

/// The whole point: retained capacity on a file 100 chunks long stays near one chunk, in every format.
#[test]
fn retained_capacity_stays_near_the_chunk_size_whatever_the_file_size() {
    const CHUNK: u32 = 2_000;
    const PUSH: usize = 4096;
    let cases = [
        ("tck", TractFormat::Tck, tck_bytes(4_000, 50)),
        ("trk", TractFormat::Trk, trk_bytes(4_000, 50)),
        ("trx", TractFormat::Trx, trx_bytes(4_000, 50, false)),
    ];
    for (what, format, bytes) in cases {
        let full = load_bytes(format, &bytes, ALL).unwrap();
        let points = full.n_points();
        assert!(
            points > 90 * CHUNK as usize,
            "{what}: larger than a chunk many times over"
        );
        let mut s = TractScanner::new(&full, format, bytes.len() as u64, vec![], CHUNK).unwrap();
        let mut peak = 0usize;
        let mut seen = 0usize;
        for piece in bytes.chunks(PUSH) {
            s.push(piece).unwrap();
            while s.ready().unwrap() {
                seen += *s.take().unwrap().unwrap().offsets.last().unwrap() as usize;
            }
            peak = peak.max(s.retained_bytes());
        }
        assert!(!s.end_pass().unwrap());
        while s.ready().unwrap() {
            seen += *s.take().unwrap().unwrap().offsets.last().unwrap() as usize;
        }
        s.finish().unwrap();
        assert_eq!(seen, points, "{what}");
        // 12 bytes a point for positions, a little more for offsets and scalars, doubled by `Vec`.
        let per_point = 12 + 4 + 4 * full.vertex_fields.len();
        let bound = 3 * CHUNK as usize * per_point + 4 * PUSH;
        assert!(peak < bound, "{what}: retained {peak} of a bound {bound}");
        assert!(
            peak < points * 12 / 10,
            "{what}: {peak} is not small beside the file's {} points",
            points
        );
    }
}

#[test]
fn a_trx_streams_its_positions_and_delivers_dps_whatever_the_member_order() {
    for positions_first in [false, true] {
        let bytes = trx_bytes(40, 5, positions_first);
        let full = load_bytes(TractFormat::Trx, &bytes, ALL).unwrap();
        let chunks = scan(&full, TractFormat::Trx, &bytes, &["w"], 30, 64).unwrap();
        assert_is_full_load(&chunks, &full, &["w"], &format!("first {positions_first}"));
        let plain = scan(&full, TractFormat::Trx, &bytes, &[], 30, 64).unwrap();
        assert!(plain.iter().all(|c| c.streamline_fields.is_empty()));
    }
}

#[test]
fn every_trx_dpv_and_every_absent_field_is_refused_by_name() {
    let bytes = trx_bytes(4, 5, false);
    let full = load_bytes(TractFormat::Trx, &bytes, ALL).unwrap();
    let e = scan(&full, TractFormat::Trx, &bytes, &["v"], 30, 64)
        .err()
        .unwrap();
    assert!(e.to_string().contains("TRX per-point field v"), "{e}");
    let e = scan(&full, TractFormat::Trx, &bytes, &["nope"], 30, 64)
        .err()
        .unwrap();
    assert!(e.to_string().contains("nope"), "{e}");

    let tck = read("mrtrix_small.tck");
    let t = load_bytes(TractFormat::Tck, &tck, ALL).unwrap();
    let e = scan(&t, TractFormat::Tck, &tck, &["nope"], 10, 64)
        .err()
        .unwrap();
    assert!(e.to_string().contains("nope"), "{e}");
    let trk = read("tract_ras.trk");
    let t = load_bytes(TractFormat::Trk, &trk, ALL).unwrap();
    let e = scan(&t, TractFormat::Trk, &trk, &["nope"], 1_000_000, 64)
        .err()
        .unwrap();
    assert!(e.to_string().contains("nope"), "{e}");
}

#[test]
fn length_mm_is_the_load_built_in_and_a_file_of_the_wrong_length_or_content_is_refused() {
    let tck = read("mrtrix_small.tck");
    let full = load_bytes(TractFormat::Tck, &tck, ALL).unwrap();
    let chunks = scan(&full, TractFormat::Tck, &tck, &["length_mm"], 10, 256).unwrap();
    assert_is_full_load(&chunks, &full, &["length_mm"], "length_mm");

    let mut s =
        TractScanner::new(&full, TractFormat::Tck, tck.len() as u64 + 1, vec![], 10).unwrap();
    let e = scan_with(&mut s, &tck, 256, &[]).err().unwrap();
    assert!(
        e.to_string()
            .contains("the file changed or the length was wrong"),
        "{e}"
    );

    // Same length, other points: the promised check is the fingerprint, which samples the head.
    let mut changed = tck.clone();
    let at = tck.windows(5).position(|w| w == b"\nEND\n").unwrap() + 100;
    changed[at] ^= 0xff;
    let mut s =
        TractScanner::new(&full, TractFormat::Tck, changed.len() as u64, vec![], 10).unwrap();
    scan_with(&mut s, &changed, 256, &[]).unwrap();
    assert!(s
        .finish()
        .unwrap_err()
        .to_string()
        .contains("changed since it was loaded"));
}

#[test]
fn real_tck_every_streamline_against_an_independent_reader() {
    let Ok(root) = std::env::var("TETRAVOX_TRACT_TESTDATA") else {
        eprintln!("skipping: TETRAVOX_TRACT_TESTDATA is unset");
        return;
    };
    let refs: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/refvalues/tract_refvalues.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let mr = PathBuf::from(root).join("derivatives/ti-toolbox/tract_validation/mrtrix_ref");
    let tck = std::fs::read(mr.join("tracks_ifod2_200k.tck")).unwrap();
    let weights = std::fs::read(mr.join("sift2_weights.txt")).unwrap();
    // The default budget, which holds about a quarter of this file.
    let opts = LoadOptions {
        max_points: Some(8_000_000),
        seed: 1,
    };
    let thin = load_bytes(TractFormat::Tck, &tck, opts).unwrap();
    let want = &refs["tck_200k"];
    let (streamlines, points) = (
        want["streamlines"].as_u64().unwrap(),
        want["points"].as_u64().unwrap(),
    );
    assert!((thin.n_points() as u64) < points / 3);
    assert_eq!(
        thin.source_points, points,
        "source_points is the file's, not the budget's"
    );

    let mut s = TractScanner::new(
        &thin,
        TractFormat::Tck,
        tck.len() as u64,
        vec!["sift2_weights".to_string()],
        1_000_000,
    )
    .unwrap();
    let id = s.attach_begin("sift2_weights.txt").unwrap();
    let chunks = scan_with(&mut s, &tck, 1 << 18, &[(id, &weights)]).unwrap();
    assert_eq!(s.finish().unwrap(), (streamlines, points));
    let (mut sum_x, mut sum_w, mut peak) = (0f64, 0f64, 0usize);
    for c in &chunks {
        peak = peak.max(c.positions.len() / 3);
        sum_x += c
            .positions
            .chunks_exact(3)
            .map(|p| f64::from(p[0]))
            .sum::<f64>();
        sum_w += c.streamline_fields[0]
            .1
            .iter()
            .map(|v| f64::from(*v))
            .sum::<f64>();
    }
    // Tolerances absorb f64 summation order only: both sides add the same f32s in file order.
    assert!(
        (sum_x - want["sum_x"].as_f64().unwrap()).abs() < 1e-3,
        "{sum_x}"
    );
    assert!(
        (sum_w - want["sum_sift2"].as_f64().unwrap()).abs() < 1e-3,
        "{sum_w}"
    );
    assert!(peak < 1_100_000, "a chunk is about 1M points, {peak}");

    // TRX: a file's own dps cover every streamline, and its dpv are refused by name.
    let trx = std::fs::read(mr.join("../thalamus_tract/thalamocortical_lh.trx")).unwrap();
    let full = load_bytes(TractFormat::Trx, &trx, ALL).unwrap();
    let opts = LoadOptions {
        max_points: Some(50_000),
        seed: 1,
    };
    let thin = load_bytes(TractFormat::Trx, &trx, opts).unwrap();
    assert!(thin.n_streamlines() < full.n_streamlines());
    let chunks = scan(
        &thin,
        TractFormat::Trx,
        &trx,
        &["edge_id"],
        100_000,
        1 << 16,
    )
    .unwrap();
    assert_is_full_load(&chunks, &full, &["edge_id"], "real trx");
    let e = scan(
        &thin,
        TractFormat::Trx,
        &trx,
        &["ti_along"],
        100_000,
        1 << 16,
    )
    .err()
    .unwrap();
    assert!(e.to_string().contains("ti_along"), "{e}");
}
