//! §6.3 geometry results → the §6.5.1 payloads: `SurfacePayload`, `CutPayload`, `CutResult`.
//!
//! Every array crosses as a fresh `js_sys` typed array (§6.4's memory rule) except on the recycled
//! `mesh_cut` path, where wasm `copy_from`s into arrays the **worker** allocated and owns.

use tvx_core::Aabb;
use tvx_geom::{Cut, OrientReport, SurfaceBuffers, SurfaceVariant, TagRange};
use wasm_bindgen::prelude::*;

use crate::jsv;
use crate::CutOut;

pub fn variant_of(s: &str) -> Option<SurfaceVariant> {
    match s {
        "indexed" => Some(SurfaceVariant::Indexed),
        "deindexed" => Some(SurfaceVariant::Deindexed),
        _ => None,
    }
}

fn variant_name(v: SurfaceVariant) -> &'static str {
    match v {
        SurfaceVariant::Indexed => "indexed",
        SurfaceVariant::Deindexed => "deindexed",
    }
}

pub fn orient(o: &OrientReport) -> js_sys::Object {
    let r = jsv::obj();
    jsv::set_u32(&r, "components", o.components);
    jsv::set_u32(&r, "openComponents", o.open_components);
    jsv::set_f64(&r, "nonManifoldEdges", o.non_manifold_edges as f64);
    jsv::set_u32(&r, "flippedComponents", o.flipped_components);
    r
}

pub fn bounds(b: &Aabb) -> js_sys::Object {
    let o = jsv::obj();
    jsv::set(&o, "min", &jsv::vec3(b.min).into());
    jsv::set(&o, "max", &jsv::vec3(b.max).into());
    o
}

fn per_tag(ranges: &[TagRange]) -> js_sys::Array {
    let a = js_sys::Array::new();
    for r in ranges {
        let o = jsv::obj();
        jsv::set_f64(&o, "tag", f64::from(r.tag));
        jsv::set_u32(&o, "first", r.first);
        jsv::set_u32(&o, "count", r.count);
        a.push(&o);
    }
    a
}

/// §6.5.1 `SurfacePayload`.
pub fn to_js(s: &SurfaceBuffers) -> JsValue {
    let o = jsv::obj();
    jsv::set_str(&o, "variant", variant_name(s.variant));
    jsv::set(&o, "positions", &jsv::f32s(&s.positions).into());
    jsv::set(&o, "normals", &jsv::f32s(&s.normals).into());
    if let Some(ix) = &s.indices {
        jsv::set(&o, "indices", &jsv::u32s(ix).into());
    }
    if let Some(ni) = &s.node_index {
        jsv::set(&o, "nodeIndex", &jsv::u32s(ni).into());
    }
    if let Some(c) = &s.corner {
        jsv::set(&o, "corner", &jsv::u8s(c).into());
    }
    jsv::set(&o, "ownerElm", &jsv::u32s(&s.owner_elm).into());
    jsv::set(&o, "faceTag", &jsv::i32s(&s.face_tag).into());
    if let Some(m) = &s.edge_mask {
        jsv::set(&o, "edgeMask", &jsv::u8s(m).into());
    }
    jsv::set(&o, "perTag", &per_tag(&s.per_tag).into());
    jsv::set(&o, "orient", &orient(&s.orient).into());
    jsv::set(&o, "bounds", &bounds(&s.bounds).into());
    o.into()
}

/// Per-plane item counts, the shape §6.5.1 `CutCounts` carries — and, on a truncated recycled call,
/// the **required** capacities (§6.4).
struct Counts {
    vertices: usize,
    triangles: usize,
    edge_segments: usize,
    boundary_segments: usize,
}

fn counts_of(c: &Cut) -> Counts {
    Counts {
        vertices: c.positions.len() / 3,
        triangles: c.tag.len(),
        edge_segments: c.edge_segments.len() / 6,
        boundary_segments: c.boundary_segments.len() / 6,
    }
}

fn counts_js(cuts: &[Cut]) -> js_sys::Array {
    let a = js_sys::Array::new();
    for c in cuts {
        let n = counts_of(c);
        let o = jsv::obj();
        jsv::set_usize(&o, "plane", c.plane);
        jsv::set_usize(&o, "vertices", n.vertices);
        jsv::set_usize(&o, "triangles", n.triangles);
        jsv::set_usize(&o, "edgeSegments", n.edge_segments);
        jsv::set_usize(&o, "boundarySegments", n.boundary_segments);
        a.push(&o);
    }
    a
}

/// The **buffers** path: `{ mode: 'buffers', cuts: CutPayload[] }`, one entry per plane, every
/// array freshly allocated and transferable. §6.4 calls it the correctness reference.
pub fn cuts_to_js(cuts: &[Cut]) -> JsValue {
    let arr = js_sys::Array::new();
    for c in cuts {
        let o = jsv::obj();
        jsv::set_usize(&o, "plane", c.plane);
        jsv::set(&o, "positions", &jsv::f32s(&c.positions).into());
        let mut nodes: Vec<u32> = Vec::with_capacity(c.interp.len() * 2);
        let mut t: Vec<f32> = Vec::with_capacity(c.interp.len());
        for i in &c.interp {
            nodes.push(i.n0);
            nodes.push(i.n1);
            t.push(i.t);
        }
        jsv::set(&o, "interpNodes", &jsv::u32s(&nodes).into());
        jsv::set(&o, "interpT", &jsv::f32s(&t).into());
        jsv::set(&o, "ownerTet", &jsv::u32s(&c.owner_tet).into());
        jsv::set(&o, "tag", &jsv::i32s(&c.tag).into());
        jsv::set(&o, "edgeMask", &jsv::u8s(&c.edge_mask).into());
        jsv::set(&o, "edgeSegments", &jsv::f32s(&c.edge_segments).into());
        jsv::set(
            &o,
            "boundarySegments",
            &jsv::f32s(&c.boundary_segments).into(),
        );
        arr.push(&o);
    }
    let out = jsv::obj();
    jsv::set_str(&out, "mode", "buffers");
    jsv::set(&out, "cuts", &arr.into());
    out.into()
}

/// The **recycled** path (§6.4): one `CutOut` covers all planes, packed plane-major, with
/// `plane_offsets` giving each plane's start in (vertices, triangles, edge segments, boundary
/// segments) and a terminating quad of totals.
///
/// If any array is too small, **nothing is written**: the call returns `truncated: true` with the
/// required capacities so the worker can double the pool and re-call. A partially filled pool is
/// never returned, which is why the capacity check runs to completion before the first write.
pub fn cuts_to_pool(cuts: &[Cut], out: &CutOut) -> JsValue {
    let mut tot = Counts {
        vertices: 0,
        triangles: 0,
        edge_segments: 0,
        boundary_segments: 0,
    };
    for c in cuts {
        let n = counts_of(c);
        tot.vertices += n.vertices;
        tot.triangles += n.triangles;
        tot.edge_segments += n.edge_segments;
        tot.boundary_segments += n.boundary_segments;
    }

    let fits = out.positions.length() as usize >= tot.vertices * 3
        && out.interp_n.length() as usize >= tot.vertices * 2
        && out.interp_t.length() as usize >= tot.vertices
        && out.owner_tet.length() as usize >= tot.triangles
        && out.tag.length() as usize >= tot.triangles
        && out.edge_mask.length() as usize >= tot.triangles
        && out.edge_segments.length() as usize >= tot.edge_segments * 6
        && out.boundary_segments.length() as usize >= tot.boundary_segments * 6
        && out.plane_offsets.length() as usize >= (cuts.len() + 1) * 4;

    let res = jsv::obj();
    jsv::set_str(&res, "mode", "recycled");
    jsv::set_bool(&res, "truncated", !fits);
    if !fits {
        // The counts are the REQUIRED sizes, and nothing was written (§6.4). One entry per plane,
        // so the worker can size the pool from the same shape it reads on the happy path.
        jsv::set(&res, "counts", &counts_js(cuts).into());
        return res.into();
    }

    let mut off = Counts {
        vertices: 0,
        triangles: 0,
        edge_segments: 0,
        boundary_segments: 0,
    };
    let offsets = &out.plane_offsets;
    for (i, c) in cuts.iter().enumerate() {
        offsets.set_index((i * 4) as u32, off.vertices as u32);
        offsets.set_index((i * 4 + 1) as u32, off.triangles as u32);
        offsets.set_index((i * 4 + 2) as u32, off.edge_segments as u32);
        offsets.set_index((i * 4 + 3) as u32, off.boundary_segments as u32);

        let n = counts_of(c);
        let mut nodes: Vec<u32> = Vec::with_capacity(n.vertices * 2);
        let mut t: Vec<f32> = Vec::with_capacity(n.vertices);
        for it in &c.interp {
            nodes.push(it.n0);
            nodes.push(it.n1);
            t.push(it.t);
        }
        copy_f32(&out.positions, off.vertices * 3, &c.positions);
        copy_u32(&out.interp_n, off.vertices * 2, &nodes);
        copy_f32(&out.interp_t, off.vertices, &t);
        copy_u32(&out.owner_tet, off.triangles, &c.owner_tet);
        copy_i32(&out.tag, off.triangles, &c.tag);
        copy_u8(&out.edge_mask, off.triangles, &c.edge_mask);
        copy_f32(&out.edge_segments, off.edge_segments * 6, &c.edge_segments);
        copy_f32(
            &out.boundary_segments,
            off.boundary_segments * 6,
            &c.boundary_segments,
        );

        off.vertices += n.vertices;
        off.triangles += n.triangles;
        off.edge_segments += n.edge_segments;
        off.boundary_segments += n.boundary_segments;
    }
    let last = (cuts.len() * 4) as u32;
    offsets.set_index(last, off.vertices as u32);
    offsets.set_index(last + 1, off.triangles as u32);
    offsets.set_index(last + 2, off.edge_segments as u32);
    offsets.set_index(last + 3, off.boundary_segments as u32);

    jsv::set(&res, "counts", &counts_js(cuts).into());
    res.into()
}

fn copy_f32(dst: &js_sys::Float32Array, at: usize, src: &[f32]) {
    if !src.is_empty() {
        dst.subarray(at as u32, (at + src.len()) as u32)
            .copy_from(src);
    }
}
fn copy_u32(dst: &js_sys::Uint32Array, at: usize, src: &[u32]) {
    if !src.is_empty() {
        dst.subarray(at as u32, (at + src.len()) as u32)
            .copy_from(src);
    }
}
fn copy_i32(dst: &js_sys::Int32Array, at: usize, src: &[i32]) {
    if !src.is_empty() {
        dst.subarray(at as u32, (at + src.len()) as u32)
            .copy_from(src);
    }
}
fn copy_u8(dst: &js_sys::Uint8Array, at: usize, src: &[u8]) {
    if !src.is_empty() {
        dst.subarray(at as u32, (at + src.len()) as u32)
            .copy_from(src);
    }
}
