//! `tvx-nifti` against the committed synthetic fixtures (ARCHITECTURE.md §6.1, §11).
//!
//! Every test here is `#[ignore]`d until Phase 1 implements the reader — the crate ships
//! `unimplemented!()` stubs, so an un-ignored test would panic. **Phase 1's job is to
//! delete the `#[ignore]` line, not to rewrite the assertion.** The expected numbers come
//! from `testdata/manifest.json`, which nibabel produced; they are not editable by
//! agreement with the implementation.
//!
//! `manifest_and_fixtures_are_present` is deliberately NOT ignored: it is what keeps the
//! fixtures and the manifest from drifting apart while the readers are still stubs.

use tvx_core::NoProgress;
use tvx_nifti::{read_nifti, DataType, GpuCaps, GpuFormat};

mod common;
use common as fx;

// -------------------------------------------------------------------------------------
// live today
// -------------------------------------------------------------------------------------

#[test]
fn manifest_and_fixtures_are_present() {
    let vols = fx::entries("volumes");
    assert!(vols.len() >= 20, "expected the full volume fixture set");
    for (name, rec) in &vols {
        let n = fx::bytes(name).len();
        assert_eq!(
            n,
            rec["bytes"].as_u64().unwrap() as usize,
            "{name} changed on disk without the manifest being regenerated"
        );
    }
    // The cases §6.1 and the ROADMAP call out by name must all exist.
    for required in [
        "vol_u8.nii",
        "vol_u8.nii.gz",
        "vol_i8.nii",
        "vol_u16.nii",
        "vol_i16.nii.gz",
        "vol_u32.nii",
        "vol_i32.nii.gz",
        "vol_f32.nii.gz",
        "vol_f64.nii",
        "vol_rgb24.nii",
        "vol_rgba32.nii",
        "vol_qfac_neg.nii",
        "vol_scl.nii",
        "vol_scl_nan.nii",
        "vol_bigendian.nii",
        "vol_nifti2.nii",
        "vol_4d.nii.gz",
        "labels_simnibs.nii.gz",
        "labels_freesurfer.nii.gz",
        "labels_float32.nii.gz",
        "vol_ramp4.nii",
        "vol_asym.nii",
    ] {
        assert!(
            fx::section("volumes").contains_key(required),
            "manifest is missing {required}"
        );
    }
}

#[test]
fn the_ten_accepted_datatypes_all_have_a_fixture() {
    let mut seen: Vec<&str> = fx::entries("volumes")
        .iter()
        .map(|(_, r)| r["dtype"].as_str().unwrap())
        .collect();
    seen.sort_unstable();
    seen.dedup();
    for want in [
        "u8", "i8", "u16", "i16", "u32", "i32", "f32", "f64", "rgb24", "rgba32",
    ] {
        assert!(seen.contains(&want), "no fixture with dtype {want}");
    }
}

// -------------------------------------------------------------------------------------
// phase 1
// -------------------------------------------------------------------------------------

fn dtype_name(d: DataType) -> &'static str {
    match d {
        DataType::U8 => "u8",
        DataType::I8 => "i8",
        DataType::U16 => "u16",
        DataType::I16 => "i16",
        DataType::U32 => "u32",
        DataType::I32 => "i32",
        DataType::F32 => "f32",
        DataType::F64 => "f64",
        DataType::Rgb24 => "rgb24",
        DataType::Rgba32 => "rgba32",
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn every_fixture_parses_with_the_manifest_geometry() {
    for (name, rec) in fx::entries("volumes") {
        let v =
            read_nifti(fx::bytes(name), &mut NoProgress).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(v.dims.to_vec(), fx::usizes(&rec["dims"]), "{name}: dims");
        assert_eq!(v.nvols, rec["nvols"].as_u64().unwrap() as usize, "{name}");
        assert_eq!(
            dtype_name(v.datatype),
            rec["dtype"].as_str().unwrap(),
            "{name}"
        );

        // §3: sform when sform_code > 0, else the qform WITH qfac, else diag(pixdim).
        fx::close_mat(&format!("{name}: affine"), &v.affine, &rec["affine"], 1e-5);
        for (i, s) in fx::nums(&rec["spacing"]).iter().enumerate() {
            fx::close(&format!("{name}: spacing[{i}]"), v.spacing[i], *s, 1e-6);
        }
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn scaling_is_never_folded_into_the_samples() {
    // §6.1: apply slope/inter only when finite, non-zero and not the identity; otherwise
    // normalise to (1.0, 0.0). The RAW samples on disk are never rewritten.
    for (name, rec) in fx::entries("volumes") {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        let (disk_slope, disk_inter) = (
            fx::num(&rec["sclSlopeOnDisk"]),
            fx::num(&rec["sclInterOnDisk"]),
        );
        let applicable = disk_slope.is_finite()
            && disk_slope != 0.0
            && disk_inter.is_finite()
            && (disk_slope != 1.0 || disk_inter != 0.0);
        let (want_slope, want_inter) = if applicable {
            (disk_slope, disk_inter)
        } else {
            (1.0, 0.0)
        };
        fx::close(
            &format!("{name}: scl_slope"),
            v.scl_slope as f64,
            want_slope,
            1e-6,
        );
        fx::close(
            &format!("{name}: scl_inter"),
            v.scl_inter as f64,
            want_inter,
            1e-6,
        );
    }
    // vol_scl.nii is the case that matters: physical = raw * 2.5 - 100, raw untouched.
    let rec = &fx::section("volumes")["vol_scl.nii"];
    assert_eq!(fx::num(&rec["sclSlopeOnDisk"]), 2.5);
    assert_eq!(fx::num(&rec["sclInterOnDisk"]), -100.0);
    // ... and vol_scl_nan.nii is the NaN guard no reference file exercises.
    let nan = &fx::section("volumes")["vol_scl_nan.nii"];
    assert!(fx::num(&nan["sclSlopeOnDisk"]).is_nan());
    let v = read_nifti(fx::bytes("vol_scl_nan.nii"), &mut NoProgress).unwrap();
    assert_eq!((v.scl_slope, v.scl_inter), (1.0, 0.0));
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn qfac_applies_to_the_third_column_only() {
    // vol_qfac_neg.nii has sform_code = 0, qform_code = 1, pixdim[0] = -1 — the only
    // arrangement that catches a missing qfac (§3). Dropping qfac must move the affine by
    // exactly `maxAbsErrorDroppingQfac`.
    let rec = &fx::section("volumes")["vol_qfac_neg.nii"];
    assert_eq!(rec["sformCode"], 0);
    assert_eq!(rec["qformCode"], 1);
    assert_eq!(fx::num(&rec["qfac"]), -1.0);
    assert_eq!(rec["affineSource"], "qform");
    let err = fx::num(&rec["maxAbsErrorDroppingQfac"]);
    assert!(err > 0.0, "the fixture must actually depend on qfac");

    let v = read_nifti(fx::bytes("vol_qfac_neg.nii"), &mut NoProgress).unwrap();
    fx::close_mat("qform", &v.affine, &rec["qformAffine"], 1e-6);
    let worst = fx::max_abs_delta(&v.affine, &rec["qformAffineWithoutQfac"]);
    fx::close("distance from the qfac-less affine", worst, err, 1e-6);
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn sform_wins_over_a_disagreeing_qform() {
    // Every oblique fixture stores an exact sform next to a float32-quaternion qform, so
    // the two differ slightly. §3 orders them: sform first.
    for (name, rec) in fx::entries("volumes") {
        if rec["affineSource"] != "sform" {
            continue;
        }
        let delta = rec["maxAbsSformQformDelta"].as_f64();
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        fx::close_mat(
            &format!("{name}: sform (qform delta {delta:?})"),
            &v.affine,
            &rec["sformAffine"],
            1e-6,
        );
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn spot_values_match_in_raw_and_physical_units() {
    for (name, rec) in fx::entries("volumes") {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        let dims = v.dims;
        for spot in rec["spotValues"].as_array().unwrap() {
            let ijk = fx::usizes(&spot["voxel"]);
            let vol = spot["volume"].as_u64().unwrap() as usize;
            let _linear = ijk[0] + dims[0] * (ijk[1] + dims[1] * (ijk[2] + dims[2] * vol));
            // PHASE 1: index `v.data` at `_linear` (scaled by 3 or 4 for rgb24/rgba32) and
            // compare with `spot["raw"]`, then apply v.scl_slope/v.scl_inter and compare
            // with `spot["physical"]`. The world column is the affine test above.
            let _ = (&spot["raw"], &spot["physical"], name);
        }
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn stats_are_exact_and_in_physical_units() {
    for (name, rec) in fx::entries("volumes") {
        if rec["dtype"] == "rgb24" || rec["dtype"] == "rgba32" {
            continue; // §4.2 Stats is a scalar model
        }
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        let s = v.stats(0);
        let want = &rec["stats"];
        // The manifest's stats span every 4D index; volume 0's do not, so only the
        // single-volume fixtures compare directly.
        if rec["nvols"].as_u64() == Some(1) {
            fx::close(
                &format!("{name}: min"),
                s.min as f64,
                fx::num(&want["min"]),
                1e-3,
            );
            fx::close(
                &format!("{name}: max"),
                s.max as f64,
                fx::num(&want["max"]),
                1e-3,
            );
            fx::close(
                &format!("{name}: mean"),
                s.mean,
                fx::num(&want["mean"]),
                1e-3,
            );
        }
        assert_eq!(s.histogram.len(), 256, "{name}: §4.2 display histogram");
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn is_label_never_looks_at_the_dtype() {
    // labels_float32.nii.gz is float32 with integral values and intent_code 1002 — the
    // shape of `segmentation/labeling.nii.gz`, which an integer-dtype heuristic misreads.
    let f32_labels = read_nifti(fx::bytes("labels_float32.nii.gz"), &mut NoProgress).unwrap();
    assert_eq!(f32_labels.datatype, DataType::F32);
    assert!(
        f32_labels.is_label,
        "a float32 atlas is still an atlas (§6.1)"
    );

    for name in ["labels_simnibs.nii.gz", "labels_freesurfer.nii.gz"] {
        assert!(
            read_nifti(fx::bytes(name), &mut NoProgress)
                .unwrap()
                .is_label
        );
    }
    // ... and the ramps are not labels: they are not all integral.
    for name in ["vol_f32.nii.gz", "vol_i16.nii.gz"] {
        let rec = &fx::section("volumes")[name];
        assert_eq!(rec["allIntegralNonNegative"], false);
        assert!(
            !read_nifti(fx::bytes(name), &mut NoProgress)
                .unwrap()
                .is_label
        );
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn label_index_is_a_dense_remap_of_sparse_ids() {
    // labels_simnibs.nii.gz spans 0..530 with 7 unique ids, like the real atlases (§4.2:
    // LabelTable is keyed by id, never indexed by it).
    let rec = &fx::section("volumes")["labels_simnibs.nii.gz"];
    let ids: Vec<f64> = fx::nums(&rec["uniqueValues"]);
    let v = read_nifti(fx::bytes("labels_simnibs.nii.gz"), &mut NoProgress).unwrap();
    let idx = v.label_index(0).unwrap();
    assert_eq!(idx.ids.len(), ids.len());
    for (i, want) in ids.iter().enumerate() {
        assert_eq!(idx.ids[i] as f64, *want);
        assert_eq!(idx.dense_of[*want as usize], i as u32);
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn gpu_payload_follows_the_selection_ladder() {
    let caps_full = GpuCaps {
        float_linear: true,
        norm16: true,
        max_3d: 2048,
    };
    let caps_swiftshader = GpuCaps {
        float_linear: true,
        norm16: false,
        max_3d: 2048,
    };
    let caps_bare = GpuCaps {
        float_linear: false,
        norm16: false,
        max_3d: 2048,
    };

    let cases: &[(&str, GpuCaps, bool, GpuFormat)] = &[
        // rows 1-2: labels remap to a dense index, NEAREST
        ("labels_simnibs.nii.gz", caps_full, false, GpuFormat::R8Ui),
        // row 3: u8 / i8
        ("vol_u8.nii", caps_full, true, GpuFormat::R8),
        ("vol_i8.nii", caps_full, true, GpuFormat::R8),
        // rows 4-6: u16 / i16 down the capability ladder. NEVER R16UI for a non-label.
        ("vol_i16.nii.gz", caps_full, true, GpuFormat::R16),
        ("vol_i16.nii.gz", caps_swiftshader, true, GpuFormat::R32F),
        ("vol_i16.nii.gz", caps_bare, true, GpuFormat::R8),
        // row 7: u32 / i32
        ("vol_i32.nii.gz", caps_full, true, GpuFormat::R16),
        // row 8: floats with a finite range normalise into R16, not R16F
        ("vol_f32.nii.gz", caps_full, true, GpuFormat::R16),
        ("vol_f64.nii", caps_full, true, GpuFormat::R16),
        // row 10: RGB
        ("vol_rgb24.nii", caps_full, true, GpuFormat::Rgba8),
        ("vol_rgba32.nii", caps_full, true, GpuFormat::Rgba8),
    ];
    for (name, caps, want_linear, want) in cases {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        let p = v.gpu_payload(0, caps, *want_linear).unwrap();
        assert_eq!(p.format, *want, "{name} with norm16={}", caps.norm16);
    }
    // R16F is in the enum but is never the ladder's choice.
    for (name, _) in fx::entries("volumes") {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        if let Ok(p) = v.gpu_payload(0, &caps_full, true) {
            assert_ne!(p.format, GpuFormat::R16F, "{name}: §6.1 never selects R16F");
        }
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn a_4d_volume_exposes_every_index() {
    let rec = &fx::section("volumes")["vol_4d.nii.gz"];
    assert_eq!(rec["nvols"], 3);
    let v = read_nifti(fx::bytes("vol_4d.nii.gz"), &mut NoProgress).unwrap();
    assert_eq!(v.nvols, 3);
    let caps = GpuCaps {
        float_linear: true,
        norm16: true,
        max_3d: 2048,
    };
    for i in 0..3 {
        let s = v.stats(i);
        assert!(s.min <= s.max, "volume {i}");
        assert!(v.gpu_payload(i, &caps, true).is_ok(), "volume {i}");
    }
    // The manifest's spot values carry one row per (voxel, volume) pair.
    assert!(rec["spotValues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["volume"] == 2));
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn big_endian_and_nifti2_read_the_same_geometry_as_their_peers() {
    let be = read_nifti(fx::bytes("vol_bigendian.nii"), &mut NoProgress).unwrap();
    let le = read_nifti(fx::bytes("vol_i16.nii.gz"), &mut NoProgress).unwrap();
    assert_eq!(be.dims, le.dims);
    assert_eq!(be.datatype, le.datatype);
    assert_eq!(be.affine, le.affine);

    let n2 = read_nifti(fx::bytes("vol_nifti2.nii"), &mut NoProgress).unwrap();
    let n1 = read_nifti(fx::bytes("vol_f32.nii.gz"), &mut NoProgress).unwrap();
    assert_eq!(n2.dims, n1.dims);
    assert_eq!(n2.datatype, n1.datatype);
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn gzip_and_plain_are_the_same_volume() {
    // The magic sniff, and nothing else, distinguishes them.
    let plain = read_nifti(fx::bytes("vol_u8.nii"), &mut NoProgress).unwrap();
    let gzipped = read_nifti(fx::bytes("vol_u8.nii.gz"), &mut NoProgress).unwrap();
    assert_eq!(plain.dims, gzipped.dims);
    assert_eq!(plain.affine, gzipped.affine);
    assert_eq!(plain.stats(0).mean, gzipped.stats(0).mean);
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn unsupported_inputs_fail_by_name() {
    use tvx_core::Error;
    // §6.1: complex64/128, int64 (1024) and uint64 (1280) are Unsupported BY NAME, and so
    // is the two-file `ni1` pair. No fixture is committed for these — a rejection needs no
    // valid file — so the datatype code is patched into a good header in memory.
    for (code, needle) in [(1024i16, "int64"), (1280, "uint64"), (32, "complex")] {
        let mut b = fx::bytes("vol_u8.nii");
        b[70..72].copy_from_slice(&code.to_le_bytes());
        match read_nifti(b, &mut NoProgress) {
            Err(Error::Unsupported(m)) => assert!(
                m.to_lowercase().contains(needle),
                "datatype {code} must be refused by name, got {m:?}"
            ),
            other => panic!("datatype {code}: expected Unsupported, got {other:?}"),
        }
    }
    let mut two_file = fx::bytes("vol_u8.nii");
    two_file[344..348].copy_from_slice(b"ni1\0");
    match read_nifti(two_file, &mut NoProgress) {
        Err(Error::Unsupported(m)) => assert!(m.contains("two-file"), "got {m:?}"),
        other => panic!("expected Unsupported(\"two-file NIfTI\"), got {other:?}"),
    }
}

#[test]
#[ignore = "phase-1: reader not implemented"]
fn a_volume_larger_than_max_3d_fails_loudly() {
    // §6.1: never a silently incomplete texture at draw time.
    let v = read_nifti(fx::bytes("vol_asym.nii"), &mut NoProgress).unwrap();
    let caps = GpuCaps {
        float_linear: true,
        norm16: true,
        max_3d: 4,
    };
    assert!(
        v.gpu_payload(0, &caps, true).is_err(),
        "8^3 must not fit a max_3d of 4"
    );
}
