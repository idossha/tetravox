//! `elm_to_node` and `node_to_elm` (§6.3).

use crate::util::signed_volume6;
use tvx_core::{Error, Field, Result};
use tvx_mesh_io::{field_stats, field_stats_parts, ElmField, Mesh};

fn tet_volume(mesh: &Mesh, t: &[u32; 4]) -> f32 {
    signed_volume6(
        mesh.nodes[t[0] as usize],
        mesh.nodes[t[1] as usize],
        mesh.nodes[t[2] as usize],
        mesh.nodes[t[3] as usize],
    )
    .abs()
        / 6.0
}

/// Volume-weighted mean of the adjacent tets (§6.3).
///
/// A node touched by no tet — every node of a surface-only mesh, and the interior-free nodes of a
/// mixed one — has no adjacent volume to average, so it is `NaN` and the field is `partial`. That
/// is the same convention `tvx-mesh-io` uses for a file with gaps (§6.2), so the engine's existing
/// NaN handling covers it.
pub fn elm_to_node(mesh: &Mesh, field: &ElmField) -> Result<Field> {
    let ncomp = field.ncomp.max(1);
    if field.tet.len() < mesh.tets.len() * ncomp {
        return Err(Error::Parse(format!(
            "elm_to_node: field \"{}\" has {} tet values, need {}",
            field.name,
            field.tet.len(),
            mesh.tets.len() * ncomp
        )));
    }
    let n = mesh.nodes.len();
    let mut acc = vec![0.0f64; n * ncomp];
    let mut wsum = vec![0.0f64; n];
    for (j, tet) in mesh.tets.iter().enumerate() {
        let w = f64::from(tet_volume(mesh, tet));
        if w <= 0.0 {
            continue;
        }
        let base = j * ncomp;
        for &v in tet {
            let o = v as usize * ncomp;
            for c in 0..ncomp {
                let s = field.tet[base + c];
                if s.is_finite() {
                    acc[o + c] += w * f64::from(s);
                }
            }
            wsum[v as usize] += w;
        }
    }
    let mut data = vec![0.0f32; n * ncomp];
    let mut partial = false;
    for i in 0..n {
        if wsum[i] > 0.0 {
            for c in 0..ncomp {
                data[i * ncomp + c] = (acc[i * ncomp + c] / wsum[i]) as f32;
            }
        } else {
            partial = true;
            for c in 0..ncomp {
                data[i * ncomp + c] = f32::NAN;
            }
        }
    }
    let stats = field_stats(&data, ncomp);
    Ok(Field {
        name: field.name.clone(),
        ncomp,
        data,
        units: field.units.clone(),
        partial: partial || field.partial,
        stats,
    })
}

/// The plain mean of an element's corner values — the exact integral of a linear field over a
/// simplex, for both tets and tris.
pub fn node_to_elm(mesh: &Mesh, field: &Field) -> Result<ElmField> {
    let ncomp = field.ncomp.max(1);
    if field.data.len() < mesh.nodes.len() * ncomp {
        return Err(Error::Parse(format!(
            "node_to_elm: field \"{}\" has {} node values, need {}",
            field.name,
            field.data.len(),
            mesh.nodes.len() * ncomp
        )));
    }
    let mut partial = false;
    let mut gather = |verts: &[u32], out: &mut Vec<f32>| {
        let inv = 1.0 / verts.len() as f32;
        for c in 0..ncomp {
            let mut s = 0.0f32;
            let mut ok = true;
            for &v in verts {
                let x = field.data[v as usize * ncomp + c];
                if x.is_finite() {
                    s += x;
                } else {
                    ok = false;
                }
            }
            if ok {
                out.push(s * inv);
            } else {
                partial = true;
                out.push(f32::NAN);
            }
        }
    };
    let mut tri = Vec::with_capacity(mesh.tris.len() * ncomp);
    for t in &mesh.tris {
        gather(t, &mut tri);
    }
    let mut tet = Vec::with_capacity(mesh.tets.len() * ncomp);
    for t in &mesh.tets {
        gather(t, &mut tet);
    }
    let stats = field_stats_parts(&[&tri, &tet], ncomp);
    Ok(ElmField {
        name: field.name.clone(),
        ncomp,
        tri,
        tet,
        units: field.units.clone(),
        partial: partial || field.partial,
        stats,
    })
}
