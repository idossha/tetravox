//! `read_nifti` benchmark skeleton (ARCHITECTURE.md §9, ROADMAP Phase 3).
//!
//! The routines are **no-ops today**: `tvx_nifti::read_nifti` is an `unimplemented!()`
//! stub and `cargo test` runs every `harness = false` bench target once, so a real call
//! here would turn `cargo test --workspace` red. Phase 1 swaps the marked line in each
//! routine for the real call; nothing else about this file has to change.
//!
//! Synthetic fixtures are 60-voxel toys — they measure per-call overhead, not throughput.
//! The number that matters comes from `TETRAVOX_TESTDATA` (`m2m_ernie/T1.nii.gz`,
//! 256x256x208 float32) and lands in `docs/BENCHMARKS.md`.

use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;
use std::path::{Path, PathBuf};

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
            b.iter(|| {
                // PHASE 1: tvx_nifti::read_nifti(bytes.clone(), &mut tvx_core::NoProgress)
                black_box(bytes.len())
            })
        });
    }
    if let Some(bytes) = real("m2m_ernie/T1.nii.gz") {
        group.sample_size(10);
        group.bench_function("real/T1.nii.gz", |b| {
            b.iter(|| {
                // PHASE 1: tvx_nifti::read_nifti(bytes.clone(), &mut tvx_core::NoProgress)
                black_box(bytes.len())
            })
        });
    }
    group.finish();
}

fn bench_stats_and_payload(c: &mut Criterion) {
    // §6.1's stats are exact: one O(n) pass into a 65536-bin histogram, no sampling. This
    // is the routine that has to stay off the interaction path.
    let mut group = c.benchmark_group("volume");
    group.bench_function("stats/vol_f32", |b| {
        b.iter(|| {
            // PHASE 1: volume.stats(0)
            black_box(0u32)
        })
    });
    group.bench_function("gpu_payload/vol_f32", |b| {
        b.iter(|| {
            // PHASE 1: volume.gpu_payload(0, &caps, true)
            black_box(0u32)
        })
    });
    group.finish();
}

criterion_group!(benches, bench_read_nifti, bench_stats_and_payload);
criterion_main!(benches);
