//! `read_nifti` / `stats` / `gpu_payload` benchmarks (ARCHITECTURE.md §9.1 row 1, ROADMAP Phase 3).
//!
//! Synthetic fixtures are 60-voxel toys — they measure per-call overhead, not throughput. The number
//! that matters comes from `TETRAVOX_TESTDATA` (`m2m_ernie/T1.nii.gz`, 256x256x208 float32, 13.1 MB
//! gzipped / 54.5 MB raw) and lands in `docs/BENCHMARKS.md`. §9.1 row 1 budgets **< 400 ms to first
//! frame on machine A (M1 Pro)** for that file; `read_nifti` + `stats` + `gpu_payload` is the CPU
//! share of it, with the GL upload and the first draw on top — that is what `first_frame/real/T1`
//! measures.
//!
//! ```sh
//! export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
//! cargo bench -p tvx-nifti
//! ```
//!
//! The real-data groups are skipped, never failed, when the variable is unset (§2).

use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;
use std::path::{Path, PathBuf};

use tvx_core::NoProgress;
use tvx_nifti::{read_nifti, GpuCaps, Volume};

const CAPS: GpuCaps = GpuCaps {
    float_linear: true,
    norm16: true,
    max_3d: 2048,
};

fn testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(testdata().join(name)).unwrap_or_default()
}

/// Real-data inputs, skipped (never failed) when `TETRAVOX_TESTDATA` is unset (§2).
fn real(rel: &str) -> Option<Vec<u8>> {
    let root = std::env::var("TETRAVOX_TESTDATA").ok()?;
    std::fs::read(Path::new(&root).join(rel)).ok()
}

fn parse(bytes: &[u8]) -> Volume {
    read_nifti(bytes.to_vec(), &mut NoProgress).expect("fixture parses")
}

fn bench_read_nifti(c: &mut Criterion) {
    let mut group = c.benchmark_group("read_nifti");
    for name in [
        "vol_f32.nii.gz",
        "vol_u8.nii",
        "vol_4d.nii.gz",
        "labels_simnibs.nii.gz",
    ] {
        let bytes = read(name);
        if bytes.is_empty() {
            continue;
        }
        group.bench_function(name, |b| {
            b.iter(|| black_box(read_nifti(bytes.clone(), &mut NoProgress).unwrap()))
        });
    }
    for (label, rel) in [
        ("real/T1.nii.gz", "m2m_ernie/T1.nii.gz"),
        (
            "real/final_tissues.nii.gz",
            "m2m_ernie/final_tissues.nii.gz",
        ),
    ] {
        if let Some(bytes) = real(rel) {
            group.sample_size(10);
            group.bench_function(label, |b| {
                b.iter(|| black_box(read_nifti(bytes.clone(), &mut NoProgress).unwrap()))
            });
        }
    }
    group.finish();
}

fn bench_stats_and_payload(c: &mut Criterion) {
    // §6.1's stats are exact: one O(n) pass into a 65536-bin histogram, no sampling. This is the
    // routine that has to stay off the interaction path.
    let mut group = c.benchmark_group("volume");
    let f32_toy = parse(&read("vol_f32.nii.gz"));
    group.bench_function("stats/vol_f32", |b| b.iter(|| black_box(f32_toy.stats(0))));
    group.bench_function("gpu_payload/vol_f32", |b| {
        b.iter(|| black_box(f32_toy.gpu_payload(0, &CAPS, true).unwrap()))
    });

    if let Some(bytes) = real("m2m_ernie/T1.nii.gz") {
        let t1 = parse(&bytes);
        group.sample_size(10);
        group.bench_function("stats/real/T1", |b| b.iter(|| black_box(t1.stats(0))));
        group.bench_function("gpu_payload/real/T1/R16", |b| {
            b.iter(|| black_box(t1.gpu_payload(0, &CAPS, true).unwrap()))
        });
        // The whole CPU share of §9.1 row 1: gzipped bytes in, texture bytes and a histogram out.
        group.bench_function("first_frame/real/T1", |b| {
            b.iter(|| {
                let v = read_nifti(bytes.clone(), &mut NoProgress).unwrap();
                let s = v.stats(0);
                let p = v.gpu_payload(0, &CAPS, true).unwrap();
                black_box((s.mean, p.bytes.len()))
            })
        });
    }
    if let Some(bytes) = real("m2m_ernie/segmentation/labeling.nii.gz") {
        let atlas = parse(&bytes);
        group.sample_size(10);
        group.bench_function("label_index/real/labeling", |b| {
            b.iter(|| black_box(atlas.label_index(0).unwrap()))
        });
        group.bench_function("gpu_payload/real/labeling/R8UI", |b| {
            b.iter(|| black_box(atlas.gpu_payload(0, &CAPS, false).unwrap()))
        });
    }
    group.finish();
}

criterion_group!(benches, bench_read_nifti, bench_stats_and_payload);
criterion_main!(benches);
