//! Sampling a volume or a tet mesh at tractogram points (§6.3.1). Nothing here names a stimulation
//! quantity: a field goes in, an op reduces it, and a point in nothing is NaN.

use tvx_core::{Error, Result};
use tvx_geom::TetSampler;
use tvx_mesh_io::Mesh;
use tvx_nifti::tensor::TensorBasis;
use tvx_nifti::{Volume, VolumeSampler};

use crate::{reduce_vector, SampleOp};

fn check_sizes(points: &[f32], tangents: Option<&[f32]>, op: SampleOp) -> Result<usize> {
    if !points.len().is_multiple_of(3) {
        return Err(Error::Parse(format!(
            "{} floats is not whole xyz triples",
            points.len()
        )));
    }
    if op.needs_tangent() && tangents.map(<[f32]>::len) != Some(points.len()) {
        return Err(Error::Parse(
            "this sample op needs one tangent per point".into(),
        ));
    }
    Ok(points.len() / 3)
}

fn tangent(tangents: Option<&[f32]>, i: usize) -> [f32; 3] {
    tangents.map_or([0.0; 3], |t| [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]])
}

/// One value per point, and how many fell outside.
pub fn sample_volume(
    v: &Volume,
    points: &[f32],
    tangents: Option<&[f32]>,
    frame: usize,
    op: SampleOp,
    basis: TensorBasis,
) -> Result<(Vec<f32>, u32)> {
    let n = check_sizes(points, tangents, op)?;
    // Only an op that compares against a direction depends on the frame.
    let basis = if op.needs_tangent() {
        basis
    } else {
        TensorBasis::World
    };
    let s = VolumeSampler::with_basis(v, basis)?;
    let mut values = vec![f32::NAN; n];
    let mut outside = 0u32;
    if op == SampleOp::Value {
        if frame >= v.nvols {
            return Err(Error::Parse(format!(
                "volume index {frame} of a volume with {} frames",
                v.nvols
            )));
        }
        for (i, p) in points.chunks_exact(3).enumerate() {
            values[i] = s.scalar(frame, [p[0], p[1], p[2]]);
            outside += u32::from(values[i].is_nan());
        }
        return Ok((values, outside));
    }
    if v.nvols != 3 {
        return Err(Error::Parse(format!(
            "a vector op needs a 3-frame volume; this one has {}",
            v.nvols
        )));
    }
    for (i, p) in points.chunks_exact(3).enumerate() {
        match s.vector([p[0], p[1], p[2]]) {
            Some(d) => values[i] = reduce_vector(op, d, tangent(tangents, i)),
            None => outside += 1,
        }
    }
    Ok((values, outside))
}

enum Src<'a> {
    Node(&'a [f32]),
    Elm(&'a [f32]),
}

/// An element field is piecewise constant, a node field barycentric. Tris are not sampled.
pub fn sample_mesh(
    mesh: &Mesh,
    sampler: &TetSampler,
    points: &[f32],
    tangents: Option<&[f32]>,
    source: &str,
    name: &str,
    op: SampleOp,
) -> Result<(Vec<f32>, u32)> {
    let n = check_sizes(points, tangents, op)?;
    if mesh.tets.is_empty() {
        return Err(Error::Parse("this mesh has no tets to sample".into()));
    }
    let (src, ncomp) = match source {
        "node" => {
            let f = mesh.node_fields.iter().find(|f| f.name == name);
            let f = f.ok_or_else(|| Error::Parse(format!("no node field {name}")))?;
            (Src::Node(&f.data), f.ncomp)
        }
        "elm" => {
            let f = mesh.elm_fields.iter().find(|f| f.name == name);
            let f = f.ok_or_else(|| Error::Parse(format!("no element field {name}")))?;
            (Src::Elm(&f.tet), f.ncomp)
        }
        other => return Err(Error::Parse(format!("unknown field source {other}"))),
    };
    match (op, ncomp) {
        (SampleOp::Value, 1)
        | (SampleOp::Magnitude | SampleOp::Dot | SampleOp::AbsDot | SampleOp::AbsCross, 3) => {}
        (SampleOp::Value, c) => {
            return Err(Error::Parse(format!(
                "{name} has {c} components: choose a vector op, not value"
            )));
        }
        (_, c) => {
            return Err(Error::Parse(format!(
                "a vector op needs a 3-component field; {name} has {c}"
            )));
        }
    }
    let mut values = vec![f32::NAN; n];
    let mut outside = 0u32;
    let mut hint = None;
    let mut comp = [0.0f32; 3];
    for (i, p) in points.chunks_exact(3).enumerate() {
        let Some(hit) = sampler.locate(mesh, [p[0], p[1], p[2]], &mut hint) else {
            outside += 1;
            continue;
        };
        let tet = mesh.tets[hit.tet as usize];
        for (c, slot) in comp.iter_mut().enumerate().take(ncomp) {
            *slot = match src {
                Src::Elm(d) => d
                    .get(hit.tet as usize * ncomp + c)
                    .copied()
                    .unwrap_or(f32::NAN),
                Src::Node(d) => (0..4)
                    .map(|k| hit.weights[k] * d[tet[k] as usize * ncomp + c])
                    .sum(),
            };
        }
        values[i] = if ncomp == 1 {
            comp[0]
        } else {
            reduce_vector(op, comp, tangent(tangents, i))
        };
    }
    Ok((values, outside))
}
