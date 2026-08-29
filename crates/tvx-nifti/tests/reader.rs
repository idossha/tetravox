//! Phase-1 coverage that `fixtures.rs` — the frozen, manifest-driven suite — does not reach:
//! percentiles and the derived display histogram, `sample_nearest`, `header_json`, `xyz_units`,
//! progress/cancellation, the exactness claims of the `gpu_payload` ladder's normalised rows, and
//! the header rejections for which no fixture is committed (ARCHITECTURE.md §6.1, §11 rule 2).
//!
//! Everything here is computed from first principles against the committed fixtures — never from a
//! previous run of this reader.

use tvx_core::{Error, NoProgress, Phase, ProgressSink, PERCENTILES};
use tvx_nifti::{
    read_nifti, DataType, GpuCaps, GpuFormat, SpaceUnit, TimeUnit, Volume, VolumeData,
};

mod common;
use common as fx;

const CAPS_FULL: GpuCaps = GpuCaps {
    float_linear: true,
    norm16: true,
    max_3d: 2048,
};

/// Every physical sample of one volume, read straight out of `Volume::data` by the test — the
/// independent path against which `stats` is checked.
fn physical(v: &Volume, vol: usize) -> Vec<f64> {
    let per = v.dims[0] * v.dims[1] * v.dims[2];
    let (slope, inter) = (v.scl_slope as f64, v.scl_inter as f64);
    let take = |d: &[f64]| d[vol * per..(vol + 1) * per].to_vec();
    let widened: Vec<f64> = match &v.data {
        VolumeData::U8(d) => d.iter().map(|x| *x as f64).collect(),
        VolumeData::I8(d) => d.iter().map(|x| *x as f64).collect(),
        VolumeData::U16(d) => d.iter().map(|x| *x as f64).collect(),
        VolumeData::I16(d) => d.iter().map(|x| *x as f64).collect(),
        VolumeData::U32(d) => d.iter().map(|x| *x as f64).collect(),
        VolumeData::I32(d) => d.iter().map(|x| *x as f64).collect(),
        VolumeData::F32(d) => d.iter().map(|x| *x as f64).collect(),
        VolumeData::F64(d) => d.clone(),
        VolumeData::Rgb24(d) | VolumeData::Rgba32(d) => d.iter().map(|x| *x as f64).collect(),
    };
    take(&widened).iter().map(|x| x * slope + inter).collect()
}

fn is_scalar(dtype: DataType) -> bool {
    !matches!(dtype, DataType::Rgb24 | DataType::Rgba32)
}

/// The nearest-rank percentile of a sorted sample: the `ceil(p/100 · n)`-th smallest.
fn nearest_rank(sorted: &[f64], p: f64) -> f64 {
    let n = sorted.len();
    let k = ((p / 100.0 * n as f64).ceil() as usize).clamp(1, n);
    sorted[k - 1]
}

// -------------------------------------------------------------------------------------
// stats
// -------------------------------------------------------------------------------------

#[test]
fn percentiles_match_the_nearest_rank_of_the_samples_themselves() {
    // §6.1: exact for integer dtypes, ≤ 1/65536 of the range for float. Both bounds are
    // asserted — the integer fixtures get zero tolerance.
    for (name, rec) in fx::entries("volumes") {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        if !is_scalar(v.datatype) {
            continue;
        }
        let mut vals = physical(&v, 0);
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        // The exact path needs one bin per integer, so it applies when the physical values are
        // integral AND their span fits 65536 bins — `vol_u32.nii` is integral but spans far more
        // than that, and takes the uniform path like any float volume.
        let _ = rec;
        let exact =
            vals.iter().all(|x| *x == x.trunc()) && vals.last().unwrap() - vals[0] <= 65535.0;
        let tol = if exact {
            0.0
        } else {
            (vals.last().unwrap() - vals[0]) / 65536.0
        };
        let s = v.stats(0);
        for (i, p) in PERCENTILES.iter().enumerate() {
            let want = nearest_rank(&vals, *p as f64);
            let got = s.percentiles[i] as f64;
            // `FieldStats::percentiles` is f32, so allow one f32 ulp on top of the bin width.
            let slack = tol + f64::from(f32::EPSILON) * want.abs() + 1e-6;
            assert!(
                got <= want + slack && got >= want - slack,
                "{name}: p{p} = {got}, want {want} (tolerance {tol}, lower-edge convention)"
            );
        }
        assert!(
            s.percentiles.windows(2).all(|w| w[0] <= w[1]),
            "{name}: percentiles must not decrease"
        );
    }
}

#[test]
fn the_display_histogram_accounts_for_every_finite_sample() {
    for (name, _) in fx::entries("volumes") {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        if !is_scalar(v.datatype) {
            continue;
        }
        for vol in 0..v.nvols {
            let vals = physical(&v, vol);
            let finite = vals.iter().filter(|x| x.is_finite()).count() as u32;
            let s = v.stats(vol);
            assert_eq!(
                s.histogram.iter().sum::<u32>(),
                finite,
                "{name} vol {vol}: the 256 bins must hold every finite sample"
            );
            assert_eq!(s.histogram_lo, s.min, "{name}: histogram spans [min, max]");
            assert_eq!(s.histogram_hi, s.max);
        }
    }
}

#[test]
fn a_four_value_ramp_lands_in_the_bins_arithmetic_predicts() {
    // vol_ramp4.nii is §11's 4x4x4 `v = i` fixture: 16 voxels each of 0, 1, 2, 3.
    let v = read_nifti(fx::bytes("vol_ramp4.nii"), &mut NoProgress).unwrap();
    let s = v.stats(0);
    assert_eq!((s.min, s.max), (0.0, 3.0));
    assert_eq!(s.mean, 1.5);
    // Display bin of value x is floor(x / 3 * 256), clamped to 255.
    for (x, bin) in [(0.0, 0usize), (1.0, 85), (2.0, 170), (3.0, 255)] {
        assert_eq!(
            s.histogram[bin], 16,
            "value {x} belongs in display bin {bin}"
        );
    }
    assert_eq!(s.histogram.iter().sum::<u32>(), 64);
    // Nearest rank over 64 samples: p50 is the 32nd smallest (the last 1), p95 the 61st (a 3).
    assert_eq!(s.percentiles[4], 1.0);
    assert_eq!(s.percentiles[5], 3.0);
}

#[test]
fn stats_of_a_scaled_volume_are_physical_and_the_samples_stay_raw() {
    // vol_scl.nii: physical = raw * 2.5 - 100 (§6.1's "scaling is never folded").
    let v = read_nifti(fx::bytes("vol_scl.nii"), &mut NoProgress).unwrap();
    assert_eq!((v.scl_slope, v.scl_inter), (2.5, -100.0));
    let VolumeData::I16(raw) = &v.data else {
        panic!("vol_scl.nii is int16 on disk")
    };
    assert_eq!(*raw.iter().min().unwrap(), -11700);
    assert_eq!(*raw.iter().max().unwrap(), 11700);
    let s = v.stats(0);
    assert_eq!((s.min, s.max), (-29350.0, 29150.0));
    assert_eq!(s.mean, -100.0);
    // The whole span is integral and under 65536 wide, so the percentiles are exact.
    let mut vals = physical(&v, 0);
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for (i, p) in PERCENTILES.iter().enumerate() {
        assert_eq!(
            s.percentiles[i] as f64,
            nearest_rank(&vals, *p as f64),
            "p{p}"
        );
    }
}

#[test]
fn each_4d_index_gets_its_own_stats() {
    let v = read_nifti(fx::bytes("vol_4d.nii.gz"), &mut NoProgress).unwrap();
    assert_eq!(v.nvols, 3);
    let means: Vec<f64> = (0..3).map(|i| v.stats(i).mean).collect();
    // The fixture is `value = i + 10j + 100k + 1000t` scaled, so consecutive volumes differ by
    // a constant — whatever it is, they must not be equal.
    assert!(means[0] < means[1] && means[1] < means[2], "{means:?}");
    for i in 0..3 {
        let vals = physical(&v, i);
        let want = vals.iter().sum::<f64>() / vals.len() as f64;
        assert!((v.stats(i).mean - want).abs() < 1e-9, "volume {i}");
    }
    // Out of range is an all-zero FieldStats, not a panic.
    let none = v.stats(3);
    assert_eq!((none.min, none.max, none.mean), (0.0, 0.0, 0.0));
}

// -------------------------------------------------------------------------------------
// probes
// -------------------------------------------------------------------------------------

#[test]
fn sample_nearest_returns_the_manifest_spot_values() {
    for (name, rec) in fx::entries("volumes") {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        if !is_scalar(v.datatype) {
            assert!(v.sample_nearest(0, [0.0, 0.0, 0.0]).is_none(), "{name}");
            continue;
        }
        for spot in rec["spotValues"].as_array().unwrap() {
            let world = fx::nums(&spot["world"]);
            let vol = spot["volume"].as_u64().unwrap() as usize;
            let got = v
                .sample_nearest(vol, [world[0] as f32, world[1] as f32, world[2] as f32])
                .unwrap_or_else(|| panic!("{name}: {world:?} is inside the volume"));
            fx::close(
                &format!("{name} probe {world:?}"),
                got as f64,
                fx::num(&spot["physical"]),
                1e-3,
            );
        }
        // A point a long way outside has no sample at all.
        assert!(
            v.sample_nearest(0, [1.0e6, 1.0e6, 1.0e6]).is_none(),
            "{name}"
        );
        assert!(
            v.sample_nearest(v.nvols, [0.0, 0.0, 0.0]).is_none(),
            "{name}"
        );
    }
}

// -------------------------------------------------------------------------------------
// header
// -------------------------------------------------------------------------------------

fn header(v: &Volume) -> serde_json::Value {
    serde_json::from_str(&v.header_json).expect("header_json is valid JSON")
}

#[test]
fn header_json_carries_the_raw_fields_including_a_nan_slope() {
    let nan = read_nifti(fx::bytes("vol_scl_nan.nii"), &mut NoProgress).unwrap();
    let h = header(&nan);
    // The normalised (1.0, 0.0) is on the Volume; the header panel still shows what is on disk.
    assert_eq!(h["scl_slope"], "NaN");
    assert_eq!(h["scl_inter"], "NaN");
    assert_eq!((nan.scl_slope, nan.scl_inter), (1.0, 0.0));
    assert_eq!(h["magic"], "n+1");
    assert_eq!(h["niftiVersion"], 1);
    assert_eq!(h["endian"], "little");
    assert_eq!(h["datatype"], 4);
    assert_eq!(h["sizeof_hdr"], 348);
    assert_eq!(h["dim"][0], 3);
    assert_eq!(h["dim"][1], 5);
    // NIfTI-1-only fields are present, NIfTI-2 has none of them.
    assert!(h.get("glmax").is_some() && h.get("db_name").is_some());

    let n2 = read_nifti(fx::bytes("vol_nifti2.nii"), &mut NoProgress).unwrap();
    let h2 = header(&n2);
    assert_eq!(h2["niftiVersion"], 2);
    assert_eq!(h2["sizeof_hdr"], 540);
    assert_eq!(h2["magic"], "n+2");
    assert!(h2.get("glmax").is_none(), "glmax exists only in NIfTI-1");

    let be = read_nifti(fx::bytes("vol_bigendian.nii"), &mut NoProgress).unwrap();
    assert_eq!(header(&be)["endian"], "big");

    let q = read_nifti(fx::bytes("vol_qfac_neg.nii"), &mut NoProgress).unwrap();
    let hq = header(&q);
    assert_eq!(hq["affineSource"], "qform");
    assert_eq!(hq["qfac"], -1.0);
    assert_eq!(hq["sform_code"], 0);
    assert_eq!(header(&nan)["affineSource"], "sform");
}

#[test]
fn xyz_units_decode_the_xyzt_bitfield() {
    // No committed fixture sets xyzt_units — every one is 0 — so the byte is patched in memory,
    // exactly as the two-file rejection is (`testdata/manifest.json`'s `notGenerated`).
    let unknown = read_nifti(fx::bytes("vol_u8.nii"), &mut NoProgress).unwrap();
    assert_eq!(unknown.xyz_units.space, SpaceUnit::Unknown);
    assert_eq!(unknown.xyz_units.time, TimeUnit::Unknown);

    for (byte, space, time) in [
        (2u8, SpaceUnit::Millimeter, TimeUnit::Unknown),
        (1, SpaceUnit::Meter, TimeUnit::Unknown),
        (3, SpaceUnit::Micron, TimeUnit::Unknown),
        (10, SpaceUnit::Millimeter, TimeUnit::Second), // 2 | 8 — the real T1.nii.gz value
        (2 | 16, SpaceUnit::Millimeter, TimeUnit::Millisecond),
        (2 | 24, SpaceUnit::Millimeter, TimeUnit::Microsecond),
        (2 | 32, SpaceUnit::Millimeter, TimeUnit::Hz),
        (2 | 40, SpaceUnit::Millimeter, TimeUnit::Ppm),
        (2 | 48, SpaceUnit::Millimeter, TimeUnit::Rads),
    ] {
        let mut b = fx::bytes("vol_u8.nii");
        b[123] = byte;
        let v = read_nifti(b, &mut NoProgress).unwrap();
        assert_eq!(v.xyz_units.space, space, "xyzt_units = {byte}");
        assert_eq!(v.xyz_units.time, time, "xyzt_units = {byte}");
    }
}

#[test]
fn every_rejected_datatype_is_named() {
    for (code, needle) in [
        (32i16, "complex64"),
        (1792, "complex128"),
        (2048, "complex256"),
        (1024, "int64"),
        (1280, "uint64"),
        (1536, "float128"),
        (1, "binary"),
        (0, "unknown"),
        (4242, "unrecognised"),
    ] {
        let mut b = fx::bytes("vol_u8.nii");
        b[70..72].copy_from_slice(&code.to_le_bytes());
        match read_nifti(b, &mut NoProgress) {
            Err(Error::Unsupported(m)) => assert!(
                m.to_lowercase().contains(needle),
                "datatype {code}: {m:?} does not name {needle}"
            ),
            other => panic!("datatype {code}: expected Unsupported, got {other:?}"),
        }
    }
}

#[test]
fn a_missing_sform_and_qform_fall_back_to_pixdim() {
    // §3 step 3. vol_u8.nii's pixdim is (1.5, 2.0, 3.0).
    let mut b = fx::bytes("vol_u8.nii");
    b[252..254].copy_from_slice(&0i16.to_le_bytes()); // qform_code
    b[254..256].copy_from_slice(&0i16.to_le_bytes()); // sform_code
    let v = read_nifti(b, &mut NoProgress).unwrap();
    assert_eq!(header(&v)["affineSource"], "pixdim");
    let want = [
        [1.5, 0.0, 0.0, 0.0],
        [0.0, 2.0, 0.0, 0.0],
        [0.0, 0.0, 3.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    assert_eq!(v.affine, want);
    assert_eq!(v.spacing, [1.5, 2.0, 3.0]);
}

#[test]
fn malformed_input_is_a_parse_error_not_a_panic() {
    match read_nifti(vec![0u8; 16], &mut NoProgress) {
        Err(Error::Parse(m)) => assert!(m.contains("NIfTI"), "{m:?}"),
        other => panic!("expected Parse, got {other:?}"),
    }
    match read_nifti(Vec::new(), &mut NoProgress) {
        Err(Error::Parse(_)) => {}
        other => panic!("expected Parse for an empty file, got {other:?}"),
    }
    // A valid header whose data block was cut off.
    let full = fx::bytes("vol_u8.nii");
    let short = full[..full.len() - 10].to_vec();
    match read_nifti(short, &mut NoProgress) {
        Err(Error::Parse(m)) => assert!(m.contains("truncated"), "{m:?}"),
        other => panic!("expected Parse, got {other:?}"),
    }
    // Gzip magic with nothing behind it.
    match read_nifti(vec![0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0], &mut NoProgress) {
        Err(Error::Parse(m)) => assert!(m.contains("gzip"), "{m:?}"),
        other => panic!("expected Parse, got {other:?}"),
    }
}

// -------------------------------------------------------------------------------------
// progress and cancellation
// -------------------------------------------------------------------------------------

#[derive(Default)]
struct Recorder {
    phases: Vec<Phase>,
}
impl ProgressSink for Recorder {
    fn report(&mut self, phase: Phase, done: u64, total: u64) {
        assert!(done <= total || total == 0, "{phase:?}: {done}/{total}");
        if self.phases.last() != Some(&phase) {
            self.phases.push(phase);
        }
    }
    fn aborted(&self) -> bool {
        false
    }
}

struct AbortAt(u32);
impl ProgressSink for AbortAt {
    fn report(&mut self, _p: Phase, _d: u64, _t: u64) {
        self.0 = self.0.saturating_sub(1);
    }
    fn aborted(&self) -> bool {
        self.0 == 0
    }
}

#[test]
fn progress_reports_read_inflate_parse_and_index() {
    let mut r = Recorder::default();
    read_nifti(fx::bytes("vol_i16.nii.gz"), &mut r).unwrap();
    assert_eq!(r.phases[0], Phase::Read);
    assert!(r.phases.contains(&Phase::Inflate), "{:?}", r.phases);
    assert!(r.phases.contains(&Phase::Parse), "{:?}", r.phases);
    assert!(r.phases.contains(&Phase::Index), "{:?}", r.phases);

    let mut plain = Recorder::default();
    read_nifti(fx::bytes("vol_u8.nii"), &mut plain).unwrap();
    assert!(
        !plain.phases.contains(&Phase::Inflate),
        "a plain .nii never inflates: {:?}",
        plain.phases
    );
}

#[test]
fn an_aborting_sink_cancels_the_read() {
    for n in 0..4 {
        match read_nifti(fx::bytes("vol_i16.nii.gz"), &mut AbortAt(n)) {
            Err(Error::Cancelled) => {}
            other => panic!("abort after {n} reports: expected Cancelled, got {other:?}"),
        }
    }
}

// -------------------------------------------------------------------------------------
// gpu_payload
// -------------------------------------------------------------------------------------

fn as_u16(bytes: &[u8]) -> Vec<u16> {
    bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect()
}

#[test]
fn the_r16_row_round_trips_a_16_bit_input_exactly() {
    // §6.1 row 4: "scale = (max−min)/65535, offset = min; exact for any 16-bit input".
    for name in ["vol_i16.nii.gz", "vol_u16.nii", "vol_scl.nii"] {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        let p = v.gpu_payload(0, &CAPS_FULL, true).unwrap();
        assert_eq!(p.format, GpuFormat::R16, "{name}");
        assert!(p.filterable, "{name}");
        let s = v.stats(0);
        let want = ((s.max - s.min) / 65535.0) as f32;
        assert!(
            (p.scale - want).abs() <= f32::EPSILON * want.abs(),
            "{name}"
        );
        assert_eq!(p.offset, s.min, "{name}");
        let codes = as_u16(&p.bytes);
        let vals = physical(&v, 0);
        assert_eq!(codes.len(), vals.len(), "{name}");
        for (i, (c, x)) in codes.iter().zip(&vals).enumerate() {
            let back = *c as f64 * p.scale as f64 + p.offset as f64;
            assert!(
                (back - x).abs() <= 1e-3 * (1.0 + x.abs()),
                "{name}[{i}]: code {c} decodes to {back}, sample is {x}"
            );
        }
    }
}

#[test]
fn the_r8_row_uses_the_same_code_convention() {
    let v = read_nifti(fx::bytes("vol_u8.nii"), &mut NoProgress).unwrap();
    let p = v.gpu_payload(0, &CAPS_FULL, true).unwrap();
    assert_eq!(p.format, GpuFormat::R8);
    let s = v.stats(0);
    assert_eq!(p.offset, s.min);
    assert!((p.scale as f64 - (s.max - s.min) as f64 / 255.0).abs() < 1e-6);
    let vals = physical(&v, 0);
    assert_eq!(p.bytes.len(), vals.len());
    for (i, (c, x)) in p.bytes.iter().zip(&vals).enumerate() {
        let back = *c as f64 * p.scale as f64 + p.offset as f64;
        assert!((back - x).abs() < 1.0, "byte {i}: {back} vs {x}");
    }
}

#[test]
fn a_constant_volume_does_not_divide_by_zero() {
    // Every sample the same: span 0, so the normalised rows must still produce a payload whose
    // decode gives that value back.
    let mut b = fx::bytes("vol_u8.nii");
    for byte in b[352..].iter_mut() {
        *byte = 7;
    }
    let v = read_nifti(b, &mut NoProgress).unwrap();
    let s = v.stats(0);
    assert_eq!((s.min, s.max, s.mean), (7.0, 7.0, 7.0));
    assert_eq!(s.histogram[0], 60);
    assert!(s.percentiles.iter().all(|p| *p == 7.0));
    let p = v.gpu_payload(0, &CAPS_FULL, true).unwrap();
    assert_eq!(p.format, GpuFormat::R8);
    assert!(p.bytes.iter().all(|c| *c == 0));
    assert_eq!(p.bytes[0] as f32 * p.scale + p.offset, 7.0);
}

#[test]
fn the_label_rows_upload_a_dense_index_not_the_raw_id() {
    let v = read_nifti(fx::bytes("labels_simnibs.nii.gz"), &mut NoProgress).unwrap();
    let idx = v.label_index(0).unwrap();
    let p = v.gpu_payload(0, &CAPS_FULL, false).unwrap();
    assert_eq!(p.format, GpuFormat::R8Ui);
    assert!(!p.filterable, "labels are NEAREST (§6.1 rows 1-2)");
    assert_eq!((p.scale, p.offset), (1.0, 0.0));
    let vals = physical(&v, 0);
    assert_eq!(p.bytes.len(), vals.len());
    for (i, (code, x)) in p.bytes.iter().zip(&vals).enumerate() {
        assert_eq!(
            *code as u32, idx.dense_of[*x as usize],
            "voxel {i}: raw id {x} must upload as its dense index"
        );
        assert_eq!(idx.ids[*code as usize] as f64, *x);
    }
    // The largest raw id is 530, far past what a byte can hold — that is the point of the remap.
    assert_eq!(*idx.ids.last().unwrap(), 530);
    assert!(p.bytes.iter().all(|c| (*c as usize) < idx.ids.len()));
}

#[test]
fn rgb24_widens_to_rgba8_with_an_opaque_alpha() {
    for (name, ncomp) in [("vol_rgb24.nii", 3usize), ("vol_rgba32.nii", 4)] {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        let p = v.gpu_payload(0, &CAPS_FULL, true).unwrap();
        assert_eq!(p.format, GpuFormat::Rgba8, "{name}");
        assert!(p.filterable && (p.scale, p.offset) == (1.0, 0.0), "{name}");
        let n = v.dims.iter().product::<usize>();
        assert_eq!(p.bytes.len(), n * 4, "{name}");
        let raw = match &v.data {
            VolumeData::Rgb24(d) | VolumeData::Rgba32(d) => d,
            _ => panic!("{name} is a colour volume"),
        };
        for i in 0..n {
            for c in 0..3 {
                assert_eq!(p.bytes[i * 4 + c], raw[i * ncomp + c], "{name} voxel {i}");
            }
            let want_a = if ncomp == 3 { 255 } else { raw[i * 4 + 3] };
            assert_eq!(p.bytes[i * 4 + 3], want_a, "{name} voxel {i} alpha");
        }
    }
}

#[test]
fn a_float_volume_carrying_nan_takes_the_r32f_row() {
    // §6.1 row 8 requires a *finite* range; row 9 is what keeps NaN/Inf alive.
    let mut b = fx::bytes("vol_f64.nii");
    let off = b.len() - 8;
    b[off..].copy_from_slice(&f64::NAN.to_le_bytes());
    let v = read_nifti(b, &mut NoProgress).unwrap();
    assert!(!v.is_label);
    let p = v.gpu_payload(0, &CAPS_FULL, true).unwrap();
    assert_eq!(p.format, GpuFormat::R32F);
    assert_eq!((p.scale, p.offset), (1.0, 0.0));
    let last = &p.bytes[p.bytes.len() - 4..];
    assert!(f32::from_le_bytes([last[0], last[1], last[2], last[3]]).is_nan());
    // Its stats ignore the NaN rather than propagating it.
    let s = v.stats(0);
    assert!(s.min.is_finite() && s.max.is_finite() && s.mean.is_finite());
    assert_eq!(s.histogram.iter().sum::<u32>(), 59);
}

#[test]
fn a_label_volume_asked_for_linear_filtering_takes_its_dtype_row() {
    // The `want_linear` gate, stated in the crate docs: `vol_u8.nii` is 60 small non-negative
    // integers and therefore `is_label`, but a caller that wants LINEAR gets row 3, not row 1.
    let v = read_nifti(fx::bytes("vol_u8.nii"), &mut NoProgress).unwrap();
    assert!(
        v.is_label,
        "60 integral values in 0..234 satisfy §6.1's rule"
    );
    assert_eq!(
        v.gpu_payload(0, &CAPS_FULL, true).unwrap().format,
        GpuFormat::R8
    );
    assert_eq!(
        v.gpu_payload(0, &CAPS_FULL, false).unwrap().format,
        GpuFormat::R8Ui
    );
}

#[test]
fn every_ladder_row_is_reachable_and_none_of_them_is_r16f() {
    let bare = GpuCaps {
        float_linear: false,
        norm16: false,
        max_3d: 2048,
    };
    let float_only = GpuCaps {
        float_linear: true,
        norm16: false,
        max_3d: 2048,
    };
    let mut seen = std::collections::BTreeSet::new();
    for (name, _) in fx::entries("volumes") {
        let v = read_nifti(fx::bytes(name), &mut NoProgress).unwrap();
        for caps in [CAPS_FULL, float_only, bare] {
            for want_linear in [true, false] {
                let p = v.gpu_payload(0, &caps, want_linear).unwrap();
                assert_ne!(p.format, GpuFormat::R16F, "{name}: §6.1 never selects R16F");
                assert_eq!(
                    p.filterable,
                    !matches!(p.format, GpuFormat::R8Ui | GpuFormat::R16Ui),
                    "{name}: only the integer label formats are NEAREST"
                );
                seen.insert(format!("{:?}", p.format));
            }
        }
    }
    for want in ["R8", "R8Ui", "R16", "R32F", "Rgba8"] {
        assert!(seen.contains(want), "no fixture reaches {want}: {seen:?}");
    }
}

#[test]
fn label_index_refuses_what_is_not_an_index() {
    let f = read_nifti(fx::bytes("vol_f32.nii.gz"), &mut NoProgress).unwrap();
    assert!(matches!(f.label_index(0), Err(Error::Unsupported(_))));
    let rgb = read_nifti(fx::bytes("vol_rgb24.nii"), &mut NoProgress).unwrap();
    assert!(matches!(rgb.label_index(0), Err(Error::Unsupported(_))));
    let ok = read_nifti(fx::bytes("labels_freesurfer.nii.gz"), &mut NoProgress).unwrap();
    assert!(
        matches!(ok.label_index(1), Err(Error::Parse(_))),
        "nvols = 1"
    );
}

// -------------------------------------------------------------------------------------
// is_label: the piecewise-constancy clause (DECISIONS 2026-08-29)
// -------------------------------------------------------------------------------------

/// A single-file NIfTI-1 of uint16 samples, built from first principles.
fn nifti_u16(dims: [usize; 3], f: impl Fn(usize, usize, usize) -> u16) -> Vec<u8> {
    let mut h = vec![0u8; 352];
    h[0..4].copy_from_slice(&348i32.to_le_bytes());
    let dim: [i16; 8] = [3, dims[0] as i16, dims[1] as i16, dims[2] as i16, 1, 1, 1, 1];
    for (i, d) in dim.iter().enumerate() {
        h[40 + i * 2..42 + i * 2].copy_from_slice(&d.to_le_bytes());
    }
    h[70..72].copy_from_slice(&512i16.to_le_bytes()); // NIFTI_TYPE_UINT16
    h[72..74].copy_from_slice(&16i16.to_le_bytes());
    for i in 0..8 {
        h[76 + i * 4..80 + i * 4].copy_from_slice(&1f32.to_le_bytes());
    }
    h[108..112].copy_from_slice(&352f32.to_le_bytes());
    h[344..348].copy_from_slice(b"n+1\0");
    for k in 0..dims[2] {
        for j in 0..dims[1] {
            for i in 0..dims[0] {
                h.extend_from_slice(&f(i, j, k).to_le_bytes());
            }
        }
    }
    h
}

#[test]
fn a_non_negative_integer_mri_with_a_thousand_grey_levels_is_not_a_label_map() {
    // The AMOS22 shape: int16 ≥ 0, ~1000 distinct values, and a value that changes almost every
    // voxel. Integral ∧ non-negative ∧ ≤ 4096 unique all hold, and it is still not an atlas.
    let b = nifti_u16([64, 64, 8], |i, j, k| ((i * 7 + j * 13 + k * 3) % 1000 + 1) as u16);
    let v = read_nifti(b, &mut NoProgress).unwrap();
    assert!(!v.is_label, "an intensity image is not an atlas");
    assert_eq!(
        v.gpu_payload(0, &CAPS_FULL, true).unwrap().format,
        GpuFormat::R16
    );
}

#[test]
fn a_parcellation_with_thousands_of_regions_is_still_a_label_map() {
    // 2048 distinct ids in blocks of 4×2×2 voxels: more than 255 values, and piecewise constant.
    let b = nifti_u16([64, 64, 8], |i, j, k| (i / 4 + 16 * (j / 2) + 512 * (k / 2)) as u16);
    let v = read_nifti(b, &mut NoProgress).unwrap();
    assert!(v.is_label, "a fine parcellation must keep its label palette");
    assert_eq!(v.label_index(0).unwrap().ids.len(), 2048);
}
