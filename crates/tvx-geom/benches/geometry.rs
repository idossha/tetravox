//! `build_topology` / `plane_cut` benchmark skeletons (ARCHITECTURE.md §6.3, §9).
//!
//! The routines are **no-ops today**: `tvx-geom` ships `unimplemented!()` stubs and
//! `cargo test` runs every `harness = false` bench target once, so a real call here would
//! turn `cargo test --workspace` red. Phase 1 swaps the marked line in each routine for
//! the real call.
//!
//! The budgets §6.3 states are all on ernie and all in WASM — `morton_reorder` < 250 ms,
//! `build_tet_blocks` < 500 ms, `buildTopology` < 1.5 s — so the fixture rows below
//! measure per-call overhead only. `plane_cut` is the one on the interaction path: it must
//! hold a cut-plane drag at >= 30 fps, which is what the block-AABB reject buys.

use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;
use std::path::{Path, PathBuf};

fn testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(testdata().join(name)).unwrap_or_default()
}

fn real(rel: &str) -> Option<Vec<u8>> {
    let root = std::env::var("TETRAVOX_TESTDATA").ok()?;
    std::fs::read(Path::new(&root).join(rel)).ok()
}

fn bench_build_topology(c: &mut Criterion) {
    let mut group = c.benchmark_group("build_topology");
    for name in ["mesh_v2_binary.msh", "mesh_tetonly.msh"] {
        let bytes = read(name);
        if bytes.is_empty() {
            continue;
        }
        group.bench_function(name, |b| {
            b.iter(|| {
                // PHASE 1: build_topology(&mesh, &mut tvx_core::NoProgress)
                black_box(bytes.len())
            })
        });
    }
    if real("m2m_ernie/ernie.msh").is_some() {
        group.sample_size(10);
        group.bench_function("real/ernie.msh", |b| {
            b.iter(|| {
                // PHASE 1: build_topology(&ernie, &mut tvx_core::NoProgress) — bar: < 1.5 s
                black_box(0u32)
            })
        });
    }
    group.finish();
}

fn bench_plane_cut(c: &mut Criterion) {
    let mut group = c.benchmark_group("plane_cut");
    // Axial and oblique, the two planes §11's "cut index equivalence" test pins.
    for label in ["axial", "oblique"] {
        group.bench_function(format!("fixture/{label}"), |b| {
            b.iter(|| {
                // PHASE 1: plane_cut(&mesh, &blocks, &[plane], None)
                black_box(0u32)
            })
        });
        group.bench_function(format!("fixture/{label}/no-block-index"), |b| {
            b.iter(|| {
                // PHASE 1: the same cut with a single degenerate block, to price the reject
                black_box(0u32)
            })
        });
    }
    if real("m2m_ernie/ernie.msh").is_some() {
        group.sample_size(10);
        group.bench_function("real/ernie/axial", |b| b.iter(|| black_box(0u32)));
    }
    group.finish();
}

fn bench_surfaces(c: &mut Criterion) {
    let mut group = c.benchmark_group("surfaces");
    group.bench_function("tag_surfaces/fixture", |b| b.iter(|| black_box(0u32)));
    group.bench_function("extract_boundary/fixture", |b| b.iter(|| black_box(0u32)));
    group.bench_function("morton_reorder/fixture", |b| b.iter(|| black_box(0u32)));
    group.bench_function("build_tet_blocks/fixture", |b| b.iter(|| black_box(0u32)));
    group.finish();
}

criterion_group!(
    benches,
    bench_build_topology,
    bench_plane_cut,
    bench_surfaces
);
criterion_main!(benches);
