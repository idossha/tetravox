//! Parsed Gmsh post-processing views (`.geo` / `.pos`) on the `load_mesh` seam (§6.4, §6.5.2).
//!
//! **Why `load_mesh` and not a nineteenth op.** A parsed view's `ST`/`SQ` triangles *are* a
//! surface with a node field: once they are a [`Mesh`] every downstream op — `surface`, `field`,
//! `contours`, `cut`, `locate`, the whole §7.4 shader path — works on them unchanged. Adding an
//! op would have duplicated all of that to gain nothing, so §6.5.2's `loadMesh` gains a `'geo'`
//! format and its result gains an additive, optional `geo` payload for the three things a `Mesh`
//! has no room for: **points, text labels and line segments** (`docs/DECISIONS.md`, 2026-08-28).
//!
//! **The mesh is de-indexed.** A parsed view has no node table; `ST(…)` lists three independent
//! corners. Welding them would need a tolerance, and a tolerance would silently merge two
//! electrodes of a dense net, so every corner becomes its own node and the per-corner values land
//! on a node field named `value`. That is also what makes the field *node*-sourced rather than
//! element-sourced: Gmsh's per-corner values are exactly a node field on a de-indexed mesh, and it
//! is the source §7.4 interpolates across a triangle.
//!
//! Views are **concatenated** into one dataset, one `tri_tag` per view, so a multi-view file opens
//! as a single layer whose per-view visibility is the existing tag machinery (§4.4 `tagStyle`).

use tvx_core::{Aabb, Field, Result};
use tvx_mesh_io::{field_stats, GeoView, Mesh};
use wasm_bindgen::JsValue;

use crate::jsv;

/// The name of the node field a parsed view's per-corner values land on.
pub const VALUE_FIELD: &str = "value";

/// Fold every view's triangles into one de-indexed [`Mesh`], tagged by view index.
///
/// A view with no triangles contributes nothing here — its points and labels travel in
/// [`payload`] instead — so an electrode net becomes a mesh with 0 nodes and 0 triangles, which
/// every §6.3 load-time step already handles (`grey_*.msh` is the 0-triangle case §6.2 names).
pub fn to_mesh(views: &[GeoView]) -> Mesh {
    let ntris: usize = views.iter().map(|v| v.tris.len()).sum();
    let mut nodes: Vec<[f32; 3]> = Vec::with_capacity(ntris * 3);
    let mut tris: Vec<[u32; 3]> = Vec::with_capacity(ntris);
    let mut tri_tags: Vec<i32> = Vec::with_capacity(ntris);
    let mut values: Vec<f32> = Vec::with_capacity(ntris * 3);

    for (i, v) in views.iter().enumerate() {
        for (t, tri) in v.tris.iter().enumerate() {
            let base = nodes.len() as u32;
            nodes.extend_from_slice(tri);
            tris.push([base, base + 1, base + 2]);
            // Tags are 1-based so the fallback palette (§6.2) and `tagStyle` behave like they do
            // for a `.msh`, where tag 0 is not a thing either.
            tri_tags.push(i as i32 + 1);
            for k in 0..3 {
                values.push(*v.tri_values.get(t * 3 + k).unwrap_or(&0.0));
            }
        }
    }

    let mut bounds = Aabb {
        min: [f32::INFINITY; 3],
        max: [f32::NEG_INFINITY; 3],
    };
    for n in &nodes {
        for (a, v) in n.iter().enumerate() {
            bounds.min[a] = bounds.min[a].min(*v);
            bounds.max[a] = bounds.max[a].max(*v);
        }
    }
    if nodes.is_empty() {
        bounds = Aabb {
            min: [0.0; 3],
            max: [0.0; 3],
        };
    }

    let node_fields = if values.is_empty() {
        Vec::new()
    } else {
        vec![Field {
            name: VALUE_FIELD.to_string(),
            ncomp: 1,
            stats: field_stats(&values, 1),
            data: values,
            units: None,
            partial: false,
        }]
    };

    Mesh {
        nodes,
        tris,
        tri_tags,
        tets: Vec::new(),
        tet_tags: Vec::new(),
        tri_edge_mask: None,
        node_fields,
        elm_fields: Vec::new(),
        physical_names: views
            .iter()
            .enumerate()
            .map(|(i, v)| (i as i32 + 1, view_name(i, v)))
            .collect(),
        gmsh_node_numbers: None,
        // Identity numbering: the triangles are numbered 1..N in the order they are stored, which
        // is what §6.2's `None` means and what makes `ownerElm - 1` a row of `field`'s values.
        gmsh_elm_numbers: None,
        tet_perm: Vec::new(),
        skipped: Vec::new(),
        bounds,
        label_table: None,
    }
}

/// `View""` — SimNIBS's spelling — has no name at all, so a positional one is synthesised rather
/// than showing the user an empty string in the layer list.
fn view_name(i: usize, v: &GeoView) -> String {
    if v.name.is_empty() {
        format!("view {}", i + 1)
    } else {
        v.name.clone()
    }
}

/// The additive `geo` half of `loadMesh`'s result (§6.5.1 `GeoPayloadT`).
///
/// Bulk arrays are `js_sys` typed arrays built by `jsv`, i.e. freshly allocated in the JS heap —
/// the worker transfers their buffers as-is, with no second copy (§6.4's memory rules).
pub fn payload(views: &[GeoView]) -> JsValue {
    let mut points: Vec<f32> = Vec::new();
    let mut point_values: Vec<f32> = Vec::new();
    let mut point_view: Vec<u32> = Vec::new();
    let mut label_pos: Vec<f32> = Vec::new();
    let labels = js_sys::Array::new();
    let mut segments: Vec<f32> = Vec::new();
    let mut segment_values: Vec<f32> = Vec::new();
    let names = js_sys::Array::new();
    let counts = js_sys::Array::new();
    let mut bounds = Aabb {
        min: [f32::INFINITY; 3],
        max: [f32::NEG_INFINITY; 3],
    };

    for (i, v) in views.iter().enumerate() {
        for p in &v.points {
            points.extend_from_slice(p);
            point_view.push(i as u32);
        }
        point_values.extend_from_slice(&v.point_values);
        for (pos, text) in &v.labels {
            label_pos.extend_from_slice(pos);
            labels.push(&JsValue::from_str(text));
        }
        for seg in &v.lines {
            segments.extend_from_slice(&seg[0]);
            segments.extend_from_slice(&seg[1]);
        }
        segment_values.extend_from_slice(&v.line_values);

        names.push(&JsValue::from_str(&view_name(i, v)));
        let c = jsv::obj();
        jsv::set_str(&c, "name", &view_name(i, v));
        jsv::set_usize(&c, "points", v.points.len());
        jsv::set_usize(&c, "labels", v.labels.len());
        jsv::set_usize(&c, "lines", v.lines.len());
        jsv::set_usize(&c, "tris", v.tris.len());
        jsv::set_usize(&c, "timeSteps", v.time_steps);
        let skipped = js_sys::Array::new();
        for (tag, n) in &v.skipped {
            let e = jsv::obj();
            jsv::set_str(&e, "primitive", tag);
            jsv::set_f64(&e, "count", *n as f64);
            skipped.push(&e);
        }
        jsv::set(&c, "skipped", &skipped.into());
        counts.push(&c);

        for a in 0..3 {
            bounds.min[a] = bounds.min[a].min(v.bounds.min[a]);
            bounds.max[a] = bounds.max[a].max(v.bounds.max[a]);
        }
    }
    if points.is_empty() && label_pos.is_empty() && segments.is_empty() {
        bounds = Aabb {
            min: [0.0; 3],
            max: [0.0; 3],
        };
    }

    let o = jsv::obj();
    jsv::set(&o, "points", &jsv::f32s(&points).into());
    jsv::set(&o, "pointValues", &jsv::f32s(&point_values).into());
    jsv::set(&o, "pointView", &jsv::u32s(&point_view).into());
    jsv::set(&o, "labelPositions", &jsv::f32s(&label_pos).into());
    jsv::set(&o, "labelTexts", &labels.into());
    jsv::set(&o, "lineSegments", &jsv::f32s(&segments).into());
    jsv::set(&o, "lineValues", &jsv::f32s(&segment_values).into());
    jsv::set(&o, "viewNames", &names.into());
    jsv::set(&o, "views", &counts.into());
    jsv::set(&o, "bounds", &crate::surface::bounds(&bounds).into());
    o.into()
}

/// Read a parsed view file. Split out so `load` reads as one line per format.
pub fn read(bytes: Vec<u8>) -> Result<Vec<GeoView>> {
    tvx_mesh_io::read_geo_view(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(tris: Vec<[[f32; 3]; 3]>, tri_values: Vec<f32>) -> GeoView {
        GeoView {
            tris,
            tri_values,
            ..GeoView::default()
        }
    }

    #[test]
    fn triangles_become_a_de_indexed_mesh_with_a_node_field() {
        let v = view(
            vec![[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]],
            vec![1.0, 2.0, 3.0],
        );
        let m = to_mesh(&[v]);
        assert_eq!(m.nodes.len(), 3, "de-indexed: three corners, three nodes");
        assert_eq!(m.tris, vec![[0, 1, 2]]);
        assert_eq!(m.tri_tags, vec![1], "tags are 1-based, one per view");
        assert!(m.tets.is_empty());
        assert_eq!(m.node_fields.len(), 1);
        assert_eq!(m.node_fields[0].name, VALUE_FIELD);
        assert_eq!(m.node_fields[0].data, vec![1.0, 2.0, 3.0]);
        assert_eq!(m.bounds.max, [1.0, 1.0, 0.0]);
        assert!(
            m.gmsh_elm_numbers.is_none(),
            "identity numbering, so ownerElm - 1 indexes `field`"
        );
    }

    #[test]
    fn each_view_gets_its_own_tag_and_name() {
        let mut a = view(vec![[[0.0; 3]; 3]], vec![0.0; 3]);
        a.name = "first".into();
        let b = view(vec![[[0.0; 3]; 3]], vec![0.0; 3]);
        let m = to_mesh(&[a, b]);
        assert_eq!(m.tri_tags, vec![1, 2]);
        assert_eq!(
            m.physical_names,
            vec![(1, "first".to_string()), (2, "view 2".to_string())]
        );
    }

    /// An electrode net is points and labels only: the mesh half is legitimately empty, exactly
    /// like `grey_Thalamus_TI.msh`'s zero triangles (§6.2).
    #[test]
    fn a_points_only_view_yields_an_empty_mesh_with_a_finite_box() {
        let m = to_mesh(&[GeoView {
            points: vec![[1.0, 2.0, 3.0]],
            point_values: vec![0.0],
            ..GeoView::default()
        }]);
        assert!(m.nodes.is_empty() && m.tris.is_empty());
        assert_eq!(m.bounds.min, [0.0; 3]);
        assert!(m.node_fields.is_empty());
    }
}
