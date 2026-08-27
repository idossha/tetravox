//! `isolate` (§6.3): evaluate the isolation predicate over the tets.

use crate::voxel;
use crate::{Combine, Component, FieldSource, IsolateCriteria, MagTag};
use tvx_core::{BitMask, Error, Phase, ProgressSink, Result};
use tvx_mesh_io::Mesh;
use tvx_nifti::VolumeData;

fn component_of(values: &[f32], c: Component) -> f32 {
    match c {
        Component::Mag(MagTag::Mag) => {
            if values.len() == 1 {
                values[0]
            } else {
                let s: f64 = values.iter().map(|v| f64::from(*v) * f64::from(*v)).sum();
                s.sqrt() as f32
            }
        }
        Component::C(i) => values.get(i as usize).copied().unwrap_or(f32::NAN),
    }
}

pub fn isolate(
    mesh: &Mesh,
    crit: &IsolateCriteria,
    label_volume: Option<&VolumeData>,
    p: &mut dyn ProgressSink,
) -> Result<BitMask> {
    let n = mesh.tets.len();
    p.report(Phase::Index, 0, n as u64);

    // Resolve the label-volume criterion once, and refuse a mismatch loudly (§6.3).
    let lv = match (&crit.label_volume, label_volume) {
        (Some(c), Some(d)) => {
            let voxels = c.dims[0] * c.dims[1] * c.dims[2];
            if voxel::dtype_name(d) != c.dtype {
                return Err(Error::Parse(format!(
                    "isolate: labelVolume dtype is \"{}\" but the samples are {}",
                    c.dtype,
                    voxel::dtype_name(d)
                )));
            }
            let have = voxel::len(d);
            if voxels == 0 || have < voxels * (c.volume_index + 1) {
                return Err(Error::Parse(format!(
                    "isolate: labelVolume dims {:?} x frame {} need {} samples, got {have}",
                    c.dims,
                    c.volume_index,
                    voxels * (c.volume_index + 1)
                )));
            }
            let mut labels = c.labels.clone();
            labels.sort_unstable();
            Some((c, d, voxels, labels))
        }
        (Some(_), None) => {
            return Err(Error::Parse(
                "isolate: a labelVolume criterion was given with no label volume".into(),
            ))
        }
        _ => None,
    };

    let mut mask = BitMask::new_all(n, false);
    for j in 0..n {
        if j % 1_000_000 == 0 {
            if p.aborted() {
                return Err(Error::Cancelled);
            }
            p.report(Phase::Index, j as u64, n as u64);
        }
        let tet = mesh.tets[j];
        let mut c = [0.0f32; 3];
        for &v in &tet {
            let q = mesh.nodes[v as usize];
            c[0] += q[0];
            c[1] += q[1];
            c[2] += q[2];
        }
        let centroid = [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25];

        // `all` starts true and is ANDed; `any` starts false and is ORed. With no criterion at all
        // that makes `all` select everything (a vacuous conjunction) and `any` select nothing.
        let mut acc = matches!(crit.combine, Combine::All);
        let fold = |hit: bool, acc: &mut bool| match crit.combine {
            Combine::All => *acc &= hit,
            Combine::Any => *acc |= hit,
        };

        if let Some(tags) = &crit.tags {
            fold(tags.contains(&mesh.tet_tags[j]), &mut acc);
        }
        if let Some(f) = &crit.field {
            let v = match f.source {
                FieldSource::Elm => mesh
                    .elm_fields
                    .iter()
                    .find(|e| e.name == f.name)
                    .map(|e| {
                        let b = j * e.ncomp;
                        component_of(e.tet.get(b..b + e.ncomp).unwrap_or(&[]), f.component)
                    })
                    .unwrap_or(f32::NAN),
                // A node field has no single value on a tet: §6.3 does not pick one, and the mean
                // of the four corners is the only choice that is symmetric in them.
                FieldSource::Node => mesh
                    .node_fields
                    .iter()
                    .find(|e| e.name == f.name)
                    .map(|e| {
                        let mut s = 0.0f32;
                        for &v in &tet {
                            let b = v as usize * e.ncomp;
                            s += component_of(
                                e.data.get(b..b + e.ncomp).unwrap_or(&[]),
                                f.component,
                            );
                        }
                        s * 0.25
                    })
                    .unwrap_or(f32::NAN),
            };
            fold(v >= f.lo && v <= f.hi, &mut acc);
        }
        if let Some(s) = &crit.sphere {
            let d = [
                centroid[0] - s.center[0],
                centroid[1] - s.center[1],
                centroid[2] - s.center[2],
            ];
            fold(
                d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= s.radius * s.radius,
                &mut acc,
            );
        }
        if let Some(b) = &crit.bbox {
            fold(
                (0..3).all(|k| centroid[k] >= b.min[k] && centroid[k] <= b.max[k]),
                &mut acc,
            );
        }
        if let Some((c, d, voxels, labels)) = &lv {
            let v = voxel::world_to_voxel(&c.world_to_voxel, centroid);
            let hit = (0..3).all(|k| v[k] >= -0.5 && v[k] < c.dims[k] as f64 - 0.5) && {
                // Nearest, per §6.3.
                let ix = [
                    (v[0] + 0.5) as usize,
                    (v[1] + 0.5) as usize,
                    (v[2] + 0.5) as usize,
                ];
                let li = (ix[2] * c.dims[1] + ix[1]) * c.dims[0] + ix[0] + c.volume_index * voxels;
                voxel::label(d, li).is_some_and(|id| labels.binary_search(&id).is_ok())
            };
            fold(hit, &mut acc);
        }
        if acc {
            mask.set(j, true);
        }
    }
    p.report(Phase::Index, n as u64, n as u64);
    Ok(mask)
}
