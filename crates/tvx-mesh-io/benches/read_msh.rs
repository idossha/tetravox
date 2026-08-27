//! `read_msh` benchmarks (ARCHITECTURE.md §6.2, §9 row 3, ROADMAP Phase 3).
//!
//! §6.2's target is on real data, not on these toys: `ernie.msh` (175.7 MiB, 847,165
//! nodes, 1,177,213 tris, 4,722,625 tets) in **< 1.5 s native** and **< 3 s WASM**.
//! `real/*` routines need `TETRAVOX_TESTDATA` and are skipped without it.
//!
//! Run with `cargo bench -p tvx-mesh-io`. Under `cargo test` criterion runs each routine
//! once in test mode, which is why every body has to be a real, cheap-enough call.

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
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
                black_box(tvx_mesh_io::read_msh(bytes.clone(), &mut tvx_core::NoProgress).unwrap())
            })
        });
    }
    // `real/ernie.msh` is the only measurement §6.2 states a budget for (< 1.5 s native); the
    // others are §9's rows 5, 6 and 7b, whose targets are whole-load, not parse alone.
    let heavy: [(&str, &str); 4] = [
        ("real/ernie.msh", "m2m_ernie/ernie.msh"),
        (
            "real/Thalamus_TI.msh",
            "Simulations/Thalamus/TI/mesh/Thalamus_TI.msh",
        ),
        (
            "real/ernie_TDCS_1_scalar.msh",
            "Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh",
        ),
        ("real/ernie_seeg.msh", "m2m_ernie/ernie_seeg.msh"),
    ];
    let mut sized = false;
    for (label, rel) in heavy {
        if let Some(bytes) = real(rel) {
            if !sized {
                group.sample_size(10);
                sized = true;
            }
            group.bench_function(label, |b| {
                // `read_msh` takes ownership, so each iteration needs its own copy — and a
                // 492 MB memcpy inside the timed region would be a third of the measurement.
                // `iter_batched` moves the clone into criterion's untimed setup.
                b.iter_batched(
                    || bytes.clone(),
                    |raw| black_box(tvx_mesh_io::read_msh(raw, &mut tvx_core::NoProgress).unwrap()),
                    BatchSize::LargeInput,
                )
            });
        }
    }
    group.finish();
}

/// Dispatches one of the non-`.msh` readers by the label the group uses.
fn call(label: &str, bytes: Vec<u8>) -> usize {
    let m = match label {
        l if l.starts_with("read_gifti") => {
            tvx_mesh_io::read_gifti(bytes, &mut tvx_core::NoProgress).unwrap()
        }
        l if l.starts_with("read_stl") => tvx_mesh_io::read_stl(bytes).unwrap(),
        l if l.starts_with("read_ply") => tvx_mesh_io::read_ply(bytes).unwrap(),
        l if l.starts_with("read_obj") => tvx_mesh_io::read_obj(bytes).unwrap(),
        l if l.starts_with("read_fs_surface") => tvx_mesh_io::read_fs_surface(bytes).unwrap(),
        other => panic!("no reader for {other}"),
    };
    m.nodes.len() + m.tris.len()
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
        group.bench_function(label, |b| b.iter(|| black_box(call(label, bytes.clone()))));
    }
    if let Some(bytes) = real("m2m_ernie/segmentation/lh.ernie_DK40.annot") {
        group.bench_function("real/lh.ernie_DK40.annot", |b| {
            b.iter(|| black_box(tvx_mesh_io::read_fs_annot(&bytes).unwrap().0.data.len()))
        });
    }
    if let Some(bytes) = real("m2m_ernie/surfaces/lh.central.gii") {
        group.bench_function("real/lh.central.gii", |b| {
            b.iter_batched(
                || bytes.clone(),
                |raw| black_box(tvx_mesh_io::read_gifti(raw, &mut tvx_core::NoProgress).unwrap()),
                BatchSize::LargeInput,
            )
        });
    }
    group.finish();
}

criterion_group!(benches, bench_read_msh, bench_other_readers);
criterion_main!(benches);
