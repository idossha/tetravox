//! Small shared helpers. Only `+ − × ÷ sqrt` and integer ops, per §6.3's determinism rule.

use tvx_core::Aabb;

pub fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Normalise in place; a zero-length vector stays zero rather than becoming NaN.
pub fn normalize(v: [f32; 3]) -> [f32; 3] {
    let n2 = dot(v, v);
    if n2 > 0.0 {
        let inv = 1.0 / n2.sqrt();
        [v[0] * inv, v[1] * inv, v[2] * inv]
    } else {
        [0.0; 3]
    }
}

/// Six times the signed volume of the tet `(a, b, c, d)`. Positive when `d` is on the positive side
/// of the plane through `(a, b, c)` wound counter-clockwise.
pub fn signed_volume6(a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]) -> f32 {
    dot(sub(b, a), cross(sub(c, a), sub(d, a)))
}

pub const EMPTY_AABB: Aabb = Aabb {
    min: [f32::INFINITY; 3],
    max: [f32::NEG_INFINITY; 3],
};

pub fn grow(bb: &mut Aabb, p: [f32; 3]) {
    for (c, &v) in p.iter().enumerate() {
        if v < bb.min[c] {
            bb.min[c] = v;
        }
        if v > bb.max[c] {
            bb.max[c] = v;
        }
    }
}

/// An `Aabb` that never got a point is reported as all-zero rather than as ±inf, so it serialises.
pub fn finish(bb: Aabb) -> Aabb {
    if bb.min[0] > bb.max[0] {
        Aabb {
            min: [0.0; 3],
            max: [0.0; 3],
        }
    } else {
        bb
    }
}

/// Bounds over an explicit vertex list.
pub fn bounds_of(nodes: &[[f32; 3]]) -> Aabb {
    let mut bb = EMPTY_AABB;
    for n in nodes {
        grow(&mut bb, *n);
    }
    finish(bb)
}

/// The Gmsh element number of internal triangle row `i` (§6.2's identity rule).
pub fn tri_gmsh_number(mesh: &tvx_mesh_io::Mesh, i: usize) -> u32 {
    match &mesh.gmsh_elm_numbers {
        Some(v) => v[i] as u32,
        None => (i + 1) as u32,
    }
}

/// The Gmsh element number of **Morton-ordered** tet `j` (§6.2's identity rule, which is written in
/// terms of `tet_perm` precisely because the tets have been reordered).
pub fn tet_gmsh_number(mesh: &tvx_mesh_io::Mesh, j: usize) -> u32 {
    match &mesh.gmsh_elm_numbers {
        Some(v) => v[mesh.tris.len() + j] as u32,
        None => {
            let row = mesh.tet_perm.get(j).copied().unwrap_or(j as u32) as usize;
            (mesh.tris.len() + row + 1) as u32
        }
    }
}

/// Barycentric coordinates of `p` in the tet `(a, b, c, d)`, or `None` when the tet is degenerate.
///
/// Returned in the order `(wa, wb, wc, wd)`, summing to 1. A point is inside when all four are
/// `>= -eps`.
pub fn barycentric(
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    d: [f32; 3],
    p: [f32; 3],
) -> Option<[f32; 4]> {
    let v = signed_volume6(a, b, c, d);
    if v == 0.0 {
        return None;
    }
    let inv = 1.0 / v;
    Some([
        signed_volume6(p, b, c, d) * inv,
        signed_volume6(a, p, c, d) * inv,
        signed_volume6(a, b, p, d) * inv,
        signed_volume6(a, b, c, p) * inv,
    ])
}
