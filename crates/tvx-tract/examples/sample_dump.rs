//! Dump what the app's parsers and samplers answer, as raw little-endian arrays, so
//! `scripts/reference/tract_reference.py` can compare them with independent readers.
//!
//!   sample_dump <tract> <max_points|all> <out_dir> [volume|mesh <path> <value|magnitude|dot|abs-dot|abs-cross> <name|-> <out_stem>]...

use std::io::Read;
use std::path::Path;

use tvx_core::NoProgress;
use tvx_tract::{
    format_for_name, sample_mesh, sample_volume, tangents_into, LoadOptions, Loader, SampleOp,
};

fn write_f32(path: &Path, v: &[f32]) {
    let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
    std::fs::write(path, bytes).unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (tract, budget, out) = (&args[0], &args[1], Path::new(&args[2]));
    let max_points = (budget != "all").then(|| budget.parse().unwrap());
    let format = format_for_name(tract).expect("a tractogram name");
    let len = std::fs::metadata(tract).unwrap().len();
    let started = std::time::Instant::now();
    let mut l = Loader::new(
        format,
        len,
        LoadOptions {
            max_points,
            seed: 1,
        },
    )
    .unwrap();
    loop {
        let mut f = std::fs::File::open(tract).unwrap();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            l.push(&buf[..n]).unwrap();
        }
        if !l.end_pass().unwrap() {
            break;
        }
    }
    let t = l.finish().unwrap();
    eprintln!(
        "{tract}: {} of {} streamlines, {} of {} points, parsed in {:?}",
        t.n_streamlines(),
        t.source_streamlines,
        t.n_points(),
        t.source_points,
        started.elapsed()
    );
    std::fs::create_dir_all(out).unwrap();
    write_f32(&out.join("positions.f32"), &t.positions);
    let offsets: Vec<u8> = t.offsets.iter().flat_map(|x| x.to_le_bytes()).collect();
    std::fs::write(out.join("offsets.u32"), offsets).unwrap();
    let source: Vec<u8> = t
        .source_index
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect();
    std::fs::write(out.join("source_index.u32"), source).unwrap();
    for f in &t.vertex_fields {
        write_f32(&out.join(format!("dpv_{}.f32", f.name)), &f.values);
    }
    let mut tangents = vec![0.0f32; t.n_points() * 3];
    tangents_into(&t.positions, &t.offsets, 0, &mut tangents);
    write_f32(&out.join("tangents.f32"), &tangents);

    for job in args[3..].chunks(5) {
        let [kind, path, op, name, stem] = job else {
            panic!("5 arguments per sample")
        };
        let op = SampleOp::parse(op).expect("an op");
        let started = std::time::Instant::now();
        let bytes = std::fs::read(path).unwrap();
        let (values, outside) = if kind == "volume" {
            let v = tvx_nifti::read_volume(bytes, None, &mut NoProgress).unwrap();
            sample_volume(&v, &t.positions, Some(&tangents), 0, op, false).unwrap()
        } else {
            let mut mesh = tvx_mesh_io::read_msh(bytes, &mut NoProgress).unwrap();
            mesh.tet_perm = tvx_geom::morton_reorder(&mut mesh);
            let sampler = tvx_geom::TetSampler::new(&mesh);
            let (source, field) = name.split_once(':').expect("node:name or elm:name");
            sample_mesh(
                &mesh,
                &sampler,
                &t.positions,
                Some(&tangents),
                source,
                field,
                op,
            )
            .unwrap()
        };
        eprintln!(
            "{stem}: {outside} of {} outside, {:?}",
            t.n_points(),
            started.elapsed()
        );
        write_f32(&out.join(format!("{stem}.f32")), &values);
    }
}
