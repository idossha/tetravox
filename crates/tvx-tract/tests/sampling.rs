//! Sampled values against first principles (§6.3.1): hand-built fields whose answer is arithmetic.

use std::f32::consts::FRAC_1_SQRT_2;
use std::path::PathBuf;

use tvx_core::NoProgress;
use tvx_nifti::tensor::TensorBasis;
use tvx_nifti::{read_volume, Volume, VolumeData};
use tvx_tract::{sample_mesh, sample_volume, SampleOp};

fn testdata(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata")
            .join(name),
    )
    .unwrap()
}

const IDENTITY: [[f64; 4]; 4] = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
];

fn volume(nvols: usize, data: Vec<f32>, affine: [[f64; 4]; 4], is_label: bool) -> Volume {
    let mut v = read_volume(testdata("tract_sample_vector.nii"), None, &mut NoProgress).unwrap();
    v.dims = [2, 2, 2];
    v.nvols = nvols;
    v.data = VolumeData::F32(data);
    v.affine = affine;
    v.is_label = is_label;
    v.scl_slope = 1.0;
    v.scl_inter = 0.0;
    v
}

/// The same vector in all 8 voxels, frame by frame.
fn constant_vector(d: [f32; 3], affine: [[f64; 4]; 4]) -> Volume {
    let data = d.iter().flat_map(|c| [*c; 8]).collect();
    volume(3, data, affine, false)
}

fn one(v: &Volume, p: [f32; 3], t: [f32; 3], op: SampleOp, basis: TensorBasis) -> f32 {
    let (values, _) = sample_volume(v, &p, Some(&t), 0, op, basis).unwrap();
    values[0]
}

fn near(a: f32, b: f32) {
    assert!((a - b).abs() < 1e-5, "{a} vs {b}");
}

#[test]
fn a_label_volume_reads_its_nearest_id_and_never_a_blend() {
    let ids: Vec<f32> = (0..8)
        .map(|i| if i % 2 == 0 { 3.0 } else { 42.0 })
        .collect();
    let labels = volume(1, ids.clone(), IDENTITY, true);
    let scalar = volume(1, ids, IDENTITY, false);
    let at = |v: &Volume, x: f32| {
        one(
            v,
            [x, 0.0, 0.0],
            [0.0; 3],
            SampleOp::Value,
            TensorBasis::World,
        )
    };
    assert_eq!(at(&labels, 0.4), 3.0);
    assert_eq!(at(&labels, 0.6), 42.0);
    near(at(&scalar, 0.5), 22.5);
    assert!(at(&labels, 1.5).is_nan(), "outside is still NaN");
}

#[test]
fn the_ops_on_a_known_vector() {
    let v = constant_vector([3.0, 4.0, 0.0], IDENTITY);
    let t = [1.0, 0.0, 0.0];
    let p = [0.5, 0.5, 0.5];
    near(one(&v, p, t, SampleOp::Magnitude, TensorBasis::World), 5.0);
    near(one(&v, p, t, SampleOp::Dot, TensorBasis::World), 3.0);
    near(one(&v, p, t, SampleOp::AbsCross, TensorBasis::World), 4.0);
    let negative = constant_vector([-3.0, 4.0, 0.0], IDENTITY);
    near(
        one(&negative, p, t, SampleOp::Dot, TensorBasis::World),
        -3.0,
    );
    near(
        one(&negative, p, t, SampleOp::AbsDot, TensorBasis::World),
        3.0,
    );
}

/// A dtifit V1 on a positive-determinant image is flipped in x against world.
#[test]
fn the_fsl_basis_flips_x_only_when_the_determinant_is_positive() {
    let d = [FRAC_1_SQRT_2, 0.0, FRAC_1_SQRT_2];
    let t = [-FRAC_1_SQRT_2, 0.0, FRAC_1_SQRT_2];
    let p = [0.5, 0.5, 0.5];
    let ras = constant_vector(d, IDENTITY);
    near(one(&ras, p, t, SampleOp::AbsDot, TensorBasis::World), 0.0);
    near(one(&ras, p, t, SampleOp::AbsDot, TensorBasis::Voxel), 0.0);
    near(one(&ras, p, t, SampleOp::AbsDot, TensorBasis::Fsl), 1.0);

    let mut las = IDENTITY;
    las[0][0] = -1.0;
    let las = constant_vector(d, las);
    let inside = [-0.5, 0.5, 0.5];
    near(
        one(&las, inside, t, SampleOp::AbsDot, TensorBasis::Fsl),
        1.0,
    );
    near(
        one(&las, inside, t, SampleOp::AbsDot, TensorBasis::Voxel),
        1.0,
    );
    near(
        one(&las, inside, t, SampleOp::AbsDot, TensorBasis::World),
        0.0,
    );
}

#[test]
fn the_voxel_basis_follows_an_oblique_affine_and_ignores_its_scale() {
    // 30° about z at 2 mm: voxel +x points along (cos 30°, sin 30°, 0) in world.
    let (c, s) = (30f64.to_radians().cos(), 30f64.to_radians().sin());
    let affine = [
        [2.0 * c, -2.0 * s, 0.0, 0.0],
        [2.0 * s, 2.0 * c, 0.0, 0.0],
        [0.0, 0.0, 2.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let v = constant_vector([1.0, 0.0, 0.0], affine);
    let p = [0.0, 1.0, 1.0];
    let along = [c as f32, s as f32, 0.0];
    near(one(&v, p, along, SampleOp::Dot, TensorBasis::Voxel), 1.0);
    near(
        one(&v, p, along, SampleOp::Dot, TensorBasis::World),
        c as f32,
    );
}

#[test]
fn a_sheared_affine_refuses_a_direction_op_in_a_voxel_frame_only() {
    let mut sheared = IDENTITY;
    sheared[0][1] = 0.5;
    let v = constant_vector([3.0, 4.0, 0.0], sheared);
    let (p, t) = ([0.5f32, 0.5, 0.5], [1.0f32, 0.0, 0.0]);
    for basis in [TensorBasis::Voxel, TensorBasis::Fsl] {
        assert!(sample_volume(&v, &p, Some(&t), 0, SampleOp::AbsDot, basis).is_err());
        near(one(&v, p, t, SampleOp::Magnitude, basis), 5.0);
    }
    near(one(&v, p, t, SampleOp::Dot, TensorBasis::World), 3.0);
}

#[test]
fn mesh_fields_read_the_containing_tet_and_nan_outside() {
    let mut mesh = tvx_mesh_io::read_msh(testdata("mesh_v2_binary.msh"), &mut NoProgress).unwrap();
    mesh.tet_perm = tvx_geom::morton_reorder(&mut mesh);
    let sampler = tvx_geom::TetSampler::new(&mesh);
    let node = |n: u32, c: usize| mesh.nodes[n as usize][c];
    let scalar = mesh
        .elm_fields
        .iter()
        .find(|f| f.name == "elm_scalar")
        .unwrap();
    let e = mesh.elm_fields.iter().find(|f| f.name == "E").unwrap();
    let nodal = mesh
        .node_fields
        .iter()
        .find(|f| f.name == "node_scalar")
        .unwrap();
    let t = [0.0f32, 1.0, 0.0];
    for (i, tet) in mesh.tets.iter().enumerate().step_by(7) {
        let p: [f32; 3] =
            std::array::from_fn(|c| tet.iter().map(|n| node(*n, c)).sum::<f32>() / 4.0);
        let read = |source, name, op| {
            sample_mesh(&mesh, &sampler, &p, Some(&t), source, name, op)
                .unwrap()
                .0[0]
        };
        // Piecewise constant, so the centroid reads this tet's own value exactly.
        assert_eq!(
            read("elm", "elm_scalar", SampleOp::Value),
            scalar.tet[i],
            "tet {i}"
        );
        near(read("elm", "E", SampleOp::Dot), e.tet[i * 3 + 1]);
        let mean = tet.iter().map(|n| nodal.data[*n as usize]).sum::<f32>() / 4.0;
        near(read("node", "node_scalar", SampleOp::Value), mean);
    }
    let far = [1e6f32, 1e6, 1e6];
    let (values, outside) = sample_mesh(
        &mesh,
        &sampler,
        &far,
        None,
        "elm",
        "elm_scalar",
        SampleOp::Value,
    )
    .unwrap();
    assert!(values[0].is_nan());
    assert_eq!(outside, 1);
}
