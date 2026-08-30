//! `tvx-nifti` against the reference dataset (ARCHITECTURE.md §2, §11 rule 2).
//!
//! **Skipped, never failed, when `TETRAVOX_TESTDATA` is unset.**
//!
//! ```sh
//! export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
//! ```
//!
//! Every expected number is `[DATA]`: it comes from `AGENTS.md`'s "Volumes" table and from
//! `scripts/refvalues/nifti_refvalues.json`, which
//! `python3 scripts/refvalues/nifti_refvalues.py` regenerates with nibabel plus the raw 348-byte
//! header. The three quantities that file does not carry — means, nearest-rank percentiles and the
//! 4D warp field — were produced the same way, by nibabel, and each is labelled at its use site
//! with the one-liner that reproduces it. Nothing here was read back out of this reader.

use std::io::Read;
use std::path::PathBuf;

use tvx_core::{Error, NoProgress, PERCENTILES};
use tvx_nifti::{read_nifti, DataType, GpuCaps, GpuFormat, SpaceUnit, TimeUnit, Volume};

const CAPS_FULL: GpuCaps = GpuCaps {
    float_linear: true,
    norm16: true,
    max_3d: 2048,
};

fn root() -> Option<PathBuf> {
    let r = PathBuf::from(std::env::var("TETRAVOX_TESTDATA").ok()?);
    r.is_dir().then_some(r)
}

/// `let bytes = require!("m2m_ernie/T1.nii.gz");` — or return, printing why.
macro_rules! require {
    ($rel:expr) => {{
        let Some(root) = root() else {
            eprintln!("skipping: TETRAVOX_TESTDATA is unset");
            return;
        };
        let p = root.join($rel);
        match std::fs::read(&p) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("skipping: {}: {e}", p.display());
                return;
            }
        }
    }};
}

fn text(rel: &str) -> Option<String> {
    std::fs::read_to_string(root()?.join(rel)).ok()
}

fn gunzip(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(b)
        .read_to_end(&mut out)
        .unwrap();
    out
}

/// `affine · (i, j, k, 1)`, row-major (§3).
fn world_of(v: &Volume, ijk: [usize; 3]) -> [f64; 3] {
    let mut out = [0f64; 3];
    for (r, slot) in out.iter_mut().enumerate() {
        *slot = v.affine[r][0] * ijk[0] as f64
            + v.affine[r][1] * ijk[1] as f64
            + v.affine[r][2] * ijk[2] as f64
            + v.affine[r][3];
    }
    out
}

#[track_caller]
fn close(what: &str, got: f64, want: f64, tol: f64) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: got {got}, want {want} (tol {tol})"
    );
}

/// The largest absolute difference between two row-major affines.
fn max_abs_delta(a: &[[f64; 4]; 4], b: &[[f64; 4]; 4]) -> f64 {
    a.iter()
        .zip(b)
        .flat_map(|(ra, rb)| ra.iter().zip(rb))
        .fold(0f64, |w, (x, y)| w.max((x - y).abs()))
}

#[track_caller]
fn close3(what: &str, got: [f64; 3], want: [f64; 3], tol: f64) {
    for i in 0..3 {
        close(&format!("{what}[{i}]"), got[i], want[i], tol);
    }
}

/// The `#No.\tLabel Name:\tR G B A` SimNIBS LUT beside a label volume: id -> name.
fn simnibs_lut(t: &str) -> Vec<(u32, String)> {
    t.lines()
        .filter(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let id: u32 = it.next()?.parse().ok()?;
            Some((id, it.next().unwrap_or("").to_string()))
        })
        .collect()
}

// -------------------------------------------------------------------------------------
// m2m_ernie/T1.nii.gz — float32, qfac -1, max exactly 65535.0
// -------------------------------------------------------------------------------------

#[test]
fn t1_geometry_dtype_and_affine() {
    let v = read_nifti(require!("m2m_ernie/T1.nii.gz"), &mut NoProgress).unwrap();
    assert_eq!(v.dims, [256, 256, 208]);
    assert_eq!(v.nvols, 1);
    // AGENTS.md: "T1 is float32, not int16" — the trap that makes R16F wrong as a default.
    assert_eq!(v.datatype, DataType::F32);
    assert_eq!((v.scl_slope, v.scl_inter), (1.0, 0.0));
    assert_eq!(v.spacing, [1.0, 1.0, 1.0]);
    assert_eq!(v.xyz_units.space, SpaceUnit::Millimeter);
    assert_eq!(v.xyz_units.time, TimeUnit::Second); // xyzt_units = 10 on disk
    assert!(!v.is_label, "an anatomical scan is not an atlas");

    let h: serde_json::Value = serde_json::from_str(&v.header_json).unwrap();
    assert_eq!(h["sform_code"], 2);
    assert_eq!(h["qform_code"], 2);
    assert_eq!(h["qfac"], -1.0);
    assert_eq!(h["affineSource"], "sform");
    assert_eq!(h["datatype"], 16);
    assert_eq!(h["descrip"], "5.0.10");

    // AGENTS.md "Affine reference (m2m_ernie/T1.nii.gz)".
    let want = [
        [0.0, 0.0, 1.0, -99.737457],
        [-1.0, 0.0, 0.0, 154.1875],
        [0.0, 1.0, 0.0, -143.642273],
        [0.0, 0.0, 0.0, 1.0],
    ];
    for (r, (got, wanted)) in v.affine.iter().zip(&want).enumerate() {
        for (c, (g, w)) in got.iter().zip(wanted).enumerate() {
            close(&format!("affine[{r}][{c}]"), *g, *w, 1e-5);
        }
    }
    close3(
        "world(0,0,0)",
        world_of(&v, [0, 0, 0]),
        [-99.737457, 154.1875, -143.642273],
        1e-5,
    );
    close3(
        "world(255,255,207)",
        world_of(&v, [255, 255, 207]),
        [107.262543, -100.8125, 111.357727],
        1e-5,
    );
}

#[test]
fn the_qform_reproduces_the_sform_only_when_qfac_is_applied() {
    // AGENTS.md: "The qform rebuilt with qfac = -1 on the third column reproduces this affine
    // exactly (max abs error 0.0); dropping qfac gives max abs error 2.0 — the third column flips
    // from (1,0,0) to (-1,0,0). Same check on label_prep/* gives 1.0 (0.5 mm voxels). Assert both
    // files."
    //
    // The reader takes the sform whenever `sform_code > 0`, and both files have `sform_code = 2`,
    // so the qform branch is reached by zeroing `sform_code` (offset 254) in a decompressed copy
    // of the header — the same in-memory-patch technique `testdata/manifest.json`'s `notGenerated`
    // section prescribes for cases with no committed fixture.
    for (rel, third_column_delta) in [
        ("m2m_ernie/T1.nii.gz", 2.0),
        ("m2m_ernie/label_prep/T1_upsampled.nii.gz", 1.0),
    ] {
        let plain = gunzip(&require!(rel));
        let sform = read_nifti(plain.clone(), &mut NoProgress).unwrap();

        let mut patched = plain;
        patched[254..256].copy_from_slice(&0i16.to_le_bytes());
        let qform = read_nifti(patched.clone(), &mut NoProgress).unwrap();
        let h: serde_json::Value = serde_json::from_str(&qform.header_json).unwrap();
        assert_eq!(h["affineSource"], "qform", "{rel}");
        assert_eq!(h["qfac"], -1.0, "{rel}");

        close(
            &format!("{rel}: qform vs sform"),
            max_abs_delta(&qform.affine, &sform.affine),
            0.0,
            1e-4,
        );

        // ... and the same header with pixdim[0] made positive drops qfac, moving the third
        // column by exactly the documented amount.
        patched[76..80].copy_from_slice(&1.0f32.to_le_bytes());
        let no_qfac = read_nifti(patched, &mut NoProgress).unwrap();
        close(
            &format!("{rel}: dropping qfac"),
            max_abs_delta(&no_qfac.affine, &sform.affine),
            third_column_delta,
            1e-6,
        );
        for (r, (dropped, kept)) in no_qfac.affine.iter().zip(&sform.affine).take(3).enumerate() {
            close(
                &format!("{rel}: third column row {r} flips sign"),
                dropped[2],
                -kept[2],
                1e-9,
            );
        }
    }
}

#[test]
fn t1_stats_percentiles_and_payload() {
    let v = read_nifti(require!("m2m_ernie/T1.nii.gz"), &mut NoProgress).unwrap();
    let s = v.stats(0);
    // nifti_refvalues.json: min -41.807507, max 65535.0.
    close("T1 min", s.min as f64, -41.807507, 1e-4);
    assert_eq!(
        s.max, 65535.0,
        "exactly the value that would become +Inf in R16F"
    );
    // np.asanyarray(nib.load(p).dataobj).astype(np.float64).mean() = 3645.415682205731
    close("T1 mean", s.mean, 3645.415682205731, 1e-3);
    assert_eq!(s.histogram.len(), 256);
    assert_eq!(
        s.histogram.iter().map(|c| *c as u64).sum::<u64>(),
        256 * 256 * 208
    );
    assert_eq!(s.histogram_lo, s.min);
    assert_eq!(s.histogram_hi, s.max);

    // np.percentile(d, [0.1,1,2,5,50,95,98,99,99.9], method='inverted_cdf')
    let want = [
        -3.66e-17, 0.0, 0.0, 0.0, 0.0, 15992.0, 20354.0, 21808.0, 24939.0,
    ];
    // Not all-integral and 65576.8 wide, so this is the uniform path: a percentile is its bin's
    // lower edge, at most (max - min) / 65536 below the true value.
    let bin = (s.max as f64 - s.min as f64) / 65536.0;
    for (i, p) in PERCENTILES.iter().enumerate() {
        let got = s.percentiles[i] as f64;
        assert!(
            got <= want[i] + 1e-3 && got >= want[i] - bin - 1e-3,
            "T1 p{p}: got {got}, want {} (bin {bin})",
            want[i]
        );
    }

    // §6.1 row 8: a float volume with a finite range takes R16 on a norm16 context, never R16F.
    let p = v.gpu_payload(0, &CAPS_FULL, true).unwrap();
    assert_eq!(p.format, GpuFormat::R16);
    assert!(p.filterable);
    assert_eq!(p.bytes.len(), 256 * 256 * 208 * 2);
    close(
        "R16 scale",
        p.scale as f64,
        (s.max as f64 - s.min as f64) / 65535.0,
        1e-6,
    );
    assert_eq!(p.offset, s.min);

    // ... R32F on a context without norm16, and a loud failure past MAX_3D_TEXTURE_SIZE.
    let sws = GpuCaps {
        float_linear: true,
        norm16: false,
        max_3d: 2048,
    };
    assert_eq!(
        v.gpu_payload(0, &sws, true).unwrap().format,
        GpuFormat::R32F
    );
    let small = GpuCaps {
        float_linear: true,
        norm16: true,
        max_3d: 128,
    };
    match v.gpu_payload(0, &small, true) {
        Err(Error::Unsupported(m)) => assert!(m.contains("128"), "{m:?}"),
        other => panic!("256^3 must not fit a max_3d of 128, got {other:?}"),
    }

    // A CPU probe at the volume's centre. d[128,128,104] = 2125.0 (nibabel).
    let w = world_of(&v, [128, 128, 104]);
    let got = v
        .sample_nearest(0, [w[0] as f32, w[1] as f32, w[2] as f32])
        .expect("the centre voxel is inside the volume");
    assert_eq!(got, 2125.0);
    assert!(v.sample_nearest(0, [1e6, 1e6, 1e6]).is_none());
}

// -------------------------------------------------------------------------------------
// label volumes
// -------------------------------------------------------------------------------------

#[test]
fn final_tissues_is_a_uint16_atlas_matching_its_lut() {
    let v = read_nifti(require!("m2m_ernie/final_tissues.nii.gz"), &mut NoProgress).unwrap();
    // dim[0] = 4 with dim[4] = 1 on disk, so this is a 3D volume with one frame.
    assert_eq!(v.dims, [256, 256, 208]);
    assert_eq!(v.nvols, 1);
    assert_eq!(v.datatype, DataType::U16);
    assert!(v.is_label);
    assert_eq!(v.xyz_units.space, SpaceUnit::Millimeter);

    let s = v.stats(0);
    assert_eq!((s.min, s.max), (0.0, 10.0));
    // .astype(np.float64).mean() = 1.5025364068838267; the span is integral and 10 wide, so the
    // percentiles are exact.
    close("final_tissues mean", s.mean, 1.5025364068838267, 1e-9);
    assert_eq!(
        s.percentiles,
        [0.0, 0.0, 0.0, 0.0, 0.0, 7.0, 7.0, 8.0, 9.0],
        "np.percentile(..., method='inverted_cdf')"
    );

    // nifti_refvalues.json: 10 unique raw values, and 4 is absent — AGENTS.md's "tags are not
    // contiguous, and code that assumes 1..10 is wrong".
    let idx = v.label_index(0).unwrap();
    assert_eq!(idx.ids, vec![0, 1, 2, 3, 5, 6, 7, 8, 9, 10]);
    assert_eq!(idx.dense_of.len(), 11);
    for (i, id) in idx.ids.iter().enumerate() {
        assert_eq!(idx.dense_of[*id as usize], i as u32);
    }

    // Every id the volume actually uses has a row in the sidecar LUT (0 is background).
    let lut =
        simnibs_lut(&text("m2m_ernie/final_tissues_LUT.txt").expect("the LUT sits beside it"));
    assert!(
        lut.len() >= 14,
        "SimNIBS ships 14 tissue rows: {}",
        lut.len()
    );
    for id in idx.ids.iter().filter(|i| **i != 0) {
        assert!(
            lut.iter().any(|(l, _)| l == id),
            "id {id} is in the volume but not in final_tissues_LUT.txt"
        );
    }
    assert_eq!(lut.iter().find(|(i, _)| *i == 2).unwrap().1, "Gray-Matter");

    // §6.1 rows 1-2: ten ids fit a byte, so R8UI with NEAREST, carrying the dense index.
    let p = v.gpu_payload(0, &CAPS_FULL, false).unwrap();
    assert_eq!(p.format, GpuFormat::R8Ui);
    assert!(!p.filterable);
    assert_eq!((p.scale, p.offset), (1.0, 0.0));
    assert_eq!(p.bytes.len(), 256 * 256 * 208);
    assert!(p.bytes.iter().all(|c| (*c as usize) < idx.ids.len()));
}

#[test]
fn labeling_is_a_float32_atlas_an_integer_dtype_test_would_miss() {
    // §6.1: "segmentation/labeling.nii.gz is float32 with 57 integral unique values spanning
    // 0…530 [DATA] and is a genuine atlas."
    let v = read_nifti(
        require!("m2m_ernie/segmentation/labeling.nii.gz"),
        &mut NoProgress,
    )
    .unwrap();
    assert_eq!(v.dims, [256, 256, 208]);
    assert_eq!(v.datatype, DataType::F32);
    assert!(
        v.is_label,
        "an is_label heuristic that requires an integer dtype misreads the atlas the app browses"
    );
    let h: serde_json::Value = serde_json::from_str(&v.header_json).unwrap();
    assert_eq!(h["sform_code"], 1, "this one is sform_code 1, not 2");
    assert_eq!(h["qform_code"], 1);
    assert_eq!(
        h["intent_code"], 0,
        "is_label got there without intent 1002"
    );

    let s = v.stats(0);
    assert_eq!((s.min, s.max), (0.0, 530.0));
    close("labeling mean", s.mean, 397.7505403665396, 1e-6);
    assert_eq!(
        s.percentiles,
        [0.0, 0.0, 0.0, 0.0, 517.0, 525.0, 525.0, 525.0, 525.0]
    );

    let idx = v.label_index(0).unwrap();
    assert_eq!(idx.ids.len(), 57);
    assert_eq!(idx.ids[0], 0);
    assert_eq!(*idx.ids.last().unwrap(), 530);
    assert_eq!(idx.dense_of[530], 56);
    assert_eq!(
        idx.dense_of.len(),
        531,
        "keyed by id, never indexed by dtype"
    );
    // FreeSurfer's aseg ids are sparse: 1, 6 and 9 are not used.
    for absent in [1u32, 6, 9, 100] {
        assert!(!idx.ids.contains(&absent), "{absent}");
    }

    let lut = simnibs_lut(&text("m2m_ernie/segmentation/labeling_LUT.txt").unwrap());
    assert_eq!(lut.len(), 56, "one row per non-zero id");
    for id in idx.ids.iter().filter(|i| **i != 0) {
        assert!(
            lut.iter().any(|(l, _)| l == id),
            "id {id} missing from the LUT"
        );
    }

    // 57 dense indices still fit a byte.
    let p = v.gpu_payload(0, &CAPS_FULL, false).unwrap();
    assert_eq!(p.format, GpuFormat::R8Ui);
    assert!(p.bytes.iter().all(|c| *c < 57));
}

#[test]
fn tissue_labeling_upsampled_has_an_sform_and_no_qform() {
    // nifti_refvalues.json: sform_code 2, qform_code 0 — the only reference volume where §3's
    // step 2 is unavailable.
    let v = read_nifti(
        require!("m2m_ernie/label_prep/tissue_labeling_upsampled.nii.gz"),
        &mut NoProgress,
    )
    .unwrap();
    assert_eq!(v.dims, [512, 512, 416]);
    assert_eq!(v.datatype, DataType::U16);
    assert_eq!(v.spacing, [0.5, 0.5, 0.5]);
    assert!(v.is_label);
    let h: serde_json::Value = serde_json::from_str(&v.header_json).unwrap();
    assert_eq!(h["sform_code"], 2);
    assert_eq!(h["qform_code"], 0);
    assert_eq!(h["affineSource"], "sform");
    close3(
        "world(0,0,0)",
        world_of(&v, [0, 0, 0]),
        [-99.987457, 154.4375, -143.892273],
        1e-5,
    );
    close3(
        "world(511,511,415)",
        world_of(&v, [511, 511, 415]),
        [107.512543, -101.0625, 111.607727],
        1e-5,
    );
    let s = v.stats(0);
    assert_eq!((s.min, s.max), (0.0, 10.0));
    assert_eq!(
        v.label_index(0).unwrap().ids,
        vec![0, 1, 2, 3, 5, 6, 7, 8, 9, 10]
    );

    // §9.2: "One 512x512x416 volume costs 208 MB as R16". §6.1 fails loudly rather than
    // uploading a truncated texture when the context cannot hold 512.
    let small = GpuCaps {
        float_linear: true,
        norm16: true,
        max_3d: 256,
    };
    assert!(
        v.gpu_payload(0, &small, false).is_err(),
        "spec floor is 256"
    );
}

#[test]
fn t1_upsampled_carries_a_real_scl_slope_that_is_never_folded() {
    // AGENTS.md: on disk slope 1.0041254758834839, inter 32903.18359375 — the one reference file
    // with non-identity scaling. nibabel's in-memory header reports NaN for both; §6.1 says read
    // the raw header, which is what `header_json` reports.
    let v = read_nifti(
        require!("m2m_ernie/label_prep/T1_upsampled.nii.gz"),
        &mut NoProgress,
    )
    .unwrap();
    assert_eq!(v.dims, [512, 512, 416]);
    assert_eq!(v.datatype, DataType::I16);
    close("scl_slope", v.scl_slope as f64, 1.0041254758834839, 1e-9);
    close("scl_inter", v.scl_inter as f64, 32903.18359375, 1e-9);
    let h: serde_json::Value = serde_json::from_str(&v.header_json).unwrap();
    close(
        "raw scl_slope",
        h["scl_slope"].as_f64().unwrap(),
        1.004125,
        1e-6,
    );
    close(
        "raw scl_inter",
        h["scl_inter"].as_f64().unwrap(),
        32903.183594,
        1e-5,
    );

    // The samples stay int16 on the CPU; only the stats are physical.
    assert!(matches!(v.data, tvx_nifti::VolumeData::I16(_)));
    let s = v.stats(0);
    close("min", s.min as f64, 0.0, 1e-3);
    close("max", s.max as f64, 65805.363062, 1.0);
    close("mean", s.mean, 4056.775874432023, 1e-2);
    assert!(!v.is_label, "the physical values are not integral");

    // Physical, not raw: the on-disk minimum is int16's -32768.
    let tvx_nifti::VolumeData::I16(raw) = &v.data else {
        unreachable!()
    };
    assert_eq!(*raw.iter().min().unwrap(), -32768);
}

#[test]
fn thalamus_ti_max_is_a_finite_float_field() {
    let v = read_nifti(
        require!("Simulations/Thalamus/TI/niftis/Thalamus_TI_subject_TI_max.nii.gz"),
        &mut NoProgress,
    )
    .unwrap();
    assert_eq!(v.dims, [256, 256, 208]);
    assert_eq!(v.datatype, DataType::F32);
    assert!(!v.is_label);
    let s = v.stats(0);
    assert_eq!(s.min, 0.0);
    close("max", s.max as f64, 3.1520705223083496, 1e-6);
    close("mean", s.mean, 0.04222875763222585, 1e-6);
    let bin = s.max as f64 / 65536.0;
    // np.percentile(..., method='inverted_cdf')[5] = 0.1502612978219986
    close(
        "p95",
        s.percentiles[5] as f64,
        0.1502612978219986,
        bin + 1e-6,
    );
    assert_eq!(
        v.gpu_payload(0, &CAPS_FULL, true).unwrap().format,
        GpuFormat::R16
    );
}

// -------------------------------------------------------------------------------------
// 4D
// -------------------------------------------------------------------------------------

#[test]
fn the_only_4d_volumes_in_the_dataset_are_the_to_mni_warp_fields() {
    // A scan of all 119 NIfTI files under the reference root finds exactly four with dim[4] > 1:
    // m2m_ernie{,-seeg}/toMNI/{Conform2MNI,MNI2Conform}_nonl.nii.gz. Conform2MNI is the float32
    // one at the T1's own grid, 256x256x208x3, 97,454,086 B gzipped.
    let v = read_nifti(
        require!("m2m_ernie/toMNI/Conform2MNI_nonl.nii.gz"),
        &mut NoProgress,
    )
    .unwrap();
    assert_eq!(v.dims, [256, 256, 208]);
    assert_eq!(v.nvols, 3, "dim[0] = 4, dim[4] = 3");
    assert_eq!(v.datatype, DataType::F32);
    assert!(!v.is_label);
    let h: serde_json::Value = serde_json::from_str(&v.header_json).unwrap();
    assert_eq!(h["dim"][0], 4);
    assert_eq!(h["dim"][4], 3);
    assert_eq!(h["sform_code"], 2);
    assert_eq!(h["qform_code"], 0);

    // Per-volume min / max / float64 mean, from
    // `d = np.asanyarray(nib.load(p).dataobj); d[...,i].astype(np.float64)`.
    let want = [
        (-91.57756042480469, 91.9628677368164, 0.1335370341172196),
        (-139.8990020751953, 113.72676849365234, -5.991274950139713),
        (-158.33306884765625, 110.7132568359375, -15.923636814624912),
    ];
    for (i, (lo, hi, mean)) in want.iter().enumerate() {
        let s = v.stats(i);
        close(&format!("vol {i} min"), s.min as f64, *lo, 1e-4);
        close(&format!("vol {i} max"), s.max as f64, *hi, 1e-4);
        close(&format!("vol {i} mean"), s.mean, *mean, 1e-6);
        assert_eq!(
            s.histogram.iter().map(|c| *c as u64).sum::<u64>(),
            256 * 256 * 208,
            "vol {i}"
        );
        assert_eq!(
            v.gpu_payload(i, &CAPS_FULL, true).unwrap().bytes.len(),
            256 * 256 * 208 * 2,
            "vol {i}"
        );
    }
    assert!(v.gpu_payload(3, &CAPS_FULL, true).is_err(), "nvols = 3");

    // Every frame is addressable by CPU probe, and they disagree — d[60,70,80,:].
    let w = world_of(&v, [60, 70, 80]);
    let probe = |i| {
        v.sample_nearest(i, [w[0] as f32, w[1] as f32, w[2] as f32])
            .unwrap()
    };
    // Compared as f64 so the literals can stay exactly as nibabel printed them.
    assert_eq!(probe(0) as f64, -20.212970733642578);
    assert_eq!(probe(1) as f64, 47.0106201171875);
    assert_eq!(probe(2) as f64, -101.68490600585938);
}

// -------------------------------------------------------------------------------------
// FreeSurfer MGZ — gated on TETRAVOX_MGZ (§6.1)
// -------------------------------------------------------------------------------------

/// **Skipped, never failed, when `TETRAVOX_MGZ` is unset.** The reference subject ships no `.mgz`;
/// on the reference machine the only one is nibabel's own `tests/data/test.mgz` inside the SimNIBS
/// environment, which is what `scripts/refvalues/mgz_refvalues.json` describes:
///
/// ```sh
/// export TETRAVOX_MGZ=~/Applications/SimNIBS-4.6/simnibs_env/lib/python3.11/site-packages/nibabel/tests/data/test.mgz
/// python3 scripts/refvalues/mgz_refvalues.py > scripts/refvalues/mgz_refvalues.json
/// ```
///
/// Every expected number is nibabel's (`MGHImage.affine`, `header['delta']`, the array). The test
/// also skips, with a message, when the file `TETRAVOX_MGZ` names is not the one the JSON was made
/// from (name and size), rather than asserting one file's numbers against another.
#[test]
fn mgz_matches_nibabel() {
    let Some(path) = std::env::var_os("TETRAVOX_MGZ") else {
        eprintln!("skipping: TETRAVOX_MGZ is unset");
        return;
    };
    let path = PathBuf::from(path);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("skipping: {}: {e}", path.display());
            return;
        }
    };
    let refs: serde_json::Value = serde_json::from_str(include_str!(
        "../../../scripts/refvalues/mgz_refvalues.json"
    ))
    .unwrap();
    let file = path.file_name().unwrap().to_string_lossy().into_owned();
    if refs["file"] != file || refs["bytes"].as_u64() != Some(bytes.len() as u64) {
        eprintln!(
            "skipping: {} ({} B) is not the {} ({} B) that mgz_refvalues.json describes; \
             regenerate it with scripts/refvalues/mgz_refvalues.py",
            file,
            bytes.len(),
            refs["file"],
            refs["bytes"]
        );
        return;
    }

    let v = tvx_nifti::read_mgh(bytes, &mut NoProgress).unwrap();
    let dims: Vec<usize> = refs["dims"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d.as_u64().unwrap() as usize)
        .collect();
    assert_eq!(v.dims.to_vec(), dims);
    assert_eq!(v.nvols, refs["nvols"].as_u64().unwrap() as usize);
    let want_dt = match refs["typeCode"].as_i64().unwrap() {
        0 => DataType::U8,
        1 => DataType::I32,
        3 => DataType::F32,
        4 => DataType::I16,
        10 => DataType::U16,
        other => panic!("type code {other}"),
    };
    assert_eq!(v.datatype, want_dt);
    for r in 0..4 {
        for c in 0..4 {
            close(
                &format!("affine[{r}][{c}]"),
                v.affine[r][c],
                refs["affine"][r][c].as_f64().unwrap(),
                1e-4,
            );
        }
    }
    for (i, d) in refs["delta"].as_array().unwrap().iter().enumerate() {
        close(
            &format!("spacing[{i}]"),
            v.spacing[i],
            d.as_f64().unwrap().abs(),
            1e-6,
        );
    }
    for (t, want) in refs["volumeStats"].as_array().unwrap().iter().enumerate() {
        let s = v.stats(t);
        close(
            &format!("vol {t} min"),
            s.min as f64,
            want["min"].as_f64().unwrap(),
            1e-4,
        );
        close(
            &format!("vol {t} max"),
            s.max as f64,
            want["max"].as_f64().unwrap(),
            1e-4,
        );
        close(
            &format!("vol {t} mean"),
            s.mean,
            want["mean"].as_f64().unwrap(),
            1e-4,
        );
    }
    for spot in refs["spotValues"].as_array().unwrap() {
        let ijk: Vec<usize> = spot["voxel"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d.as_u64().unwrap() as usize)
            .collect();
        let t = spot["volume"].as_u64().unwrap() as usize;
        let ijk3 = [ijk[0], ijk[1], ijk[2]];
        let linear = ijk[0] + v.dims[0] * (ijk[1] + v.dims[1] * (ijk[2] + v.dims[2] * t));
        let raw = match &v.data {
            tvx_nifti::VolumeData::F32(d) => d[linear] as f64,
            tvx_nifti::VolumeData::U8(d) => d[linear] as f64,
            tvx_nifti::VolumeData::I16(d) => d[linear] as f64,
            tvx_nifti::VolumeData::U16(d) => d[linear] as f64,
            tvx_nifti::VolumeData::I32(d) => d[linear] as f64,
            other => panic!("unexpected MGH data {other:?}"),
        };
        close(
            &format!("raw{ijk:?}[{t}]"),
            raw,
            spot["raw"].as_f64().unwrap(),
            1e-6,
        );
        let world = world_of(&v, ijk3);
        for r in 0..3 {
            close(
                &format!("world{ijk:?}[{r}]"),
                world[r],
                spot["world"][r].as_f64().unwrap(),
                1e-4,
            );
        }
    }
    assert_eq!(v.xyz_units.space, SpaceUnit::Millimeter);
    assert!(v.gpu_payload(0, &CAPS_FULL, true).is_ok());
}
