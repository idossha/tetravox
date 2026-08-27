//! `read_msh` benchmark skeleton (ARCHITECTURE.md §6.2, §9, ROADMAP Phase 3).
//!
//! The routines are **no-ops today**: `tvx_mesh_io::read_msh` is an `unimplemented!()`
//! stub and `cargo test` runs every `harness = false` bench target once, so a real call
//! here would turn `cargo test --workspace` red. Phase 1 swaps the marked line in each
//! routine for the real call.
//!
//! §6.2's target is on real data, not on these toys: `ernie.msh` (175.7 MiB, 847,165
//! nodes, 1,177,213 tris, 4,722,625 tets) in **< 1.5 s native** and **< 3 s WASM**.

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

fn bench_read_msh(c: &mut Criterion) {
    let mut group = c.benchmark_group("read_msh");
    for name in [
        "mesh_v2_ascii.msh",
        "mesh_v2_binary.msh",
        "mesh_v41_ascii.msh",
        "mesh_v41_binary.msh",
    ] {
        let bytes = read(name);
        if bytes.is_empty() {
            continue;
        }
        group.bench_function(name, |b| {
            b.iter(|| {
                // PHASE 1: tvx_mesh_io::read_msh(bytes.clone(), &mut tvx_core::NoProgress)
                black_box(bytes.len())
            })
        });
    }
    // The only measurement §6.2 states a budget for.
    if let Some(bytes) = real("m2m_ernie/ernie.msh") {
        group.sample_size(10);
        group.bench_function("real/ernie.msh", |b| {
            b.iter(|| {
                // PHASE 1: tvx_mesh_io::read_msh(bytes.clone(), &mut tvx_core::NoProgress)
                black_box(bytes.len())
            })
        });
    }
    group.finish();
}

fn bench_other_readers(c: &mut Criterion) {
    let mut group = c.benchmark_group("mesh_io");
    for (label, name) in [
        ("read_gifti/gzipb64", "surf_gzipb64.surf.gii"),
        ("read_gifti/ascii", "surf_ascii.surf.gii"),
        ("read_stl/binary", "patch_binary.stl"),
        ("read_ply/binary", "patch_tri_binary.ply"),
        ("read_obj", "patch_tri.obj"),
        ("read_fs_surface", "lh.fixture.surf"),
    ] {
        let bytes = read(name);
        if bytes.is_empty() {
            continue;
        }
        group.bench_function(label, |b| {
            b.iter(|| {
                // PHASE 1: call the matching tvx_mesh_io reader
                black_box(bytes.len())
            })
        });
    }
    if let Some(bytes) = real("m2m_ernie/surfaces/lh.central.gii") {
        group.bench_function("real/lh.central.gii", |b| {
            b.iter(|| {
                // PHASE 1: tvx_mesh_io::read_gifti(bytes.clone(), &mut tvx_core::NoProgress)
                black_box(bytes.len())
            })
        });
    }
    group.finish();
}

criterion_group!(benches, bench_read_msh, bench_other_readers);
criterion_main!(benches);
