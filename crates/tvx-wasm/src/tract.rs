//! The §6.3.1 / §6.5.2 tractogram exports: thin adapters over `tvx-tract`, and the two samplers.

use std::cell::RefCell;
use std::collections::BTreeMap;

use tvx_core::{Error, Result};
use tvx_geom::TetSampler;
use tvx_tract::{LoadOptions, Loader, SampleOp, StyleSpec, TractField, TractFormat, Tractogram};
use wasm_bindgen::prelude::*;

use crate::handles::{self, Dataset, TractState};
use crate::jsv;

thread_local! {
    static STREAMS: RefCell<BTreeMap<u32, Loader>> = const { RefCell::new(BTreeMap::new()) };
    static NEXT: RefCell<u32> = const { RefCell::new(1) };
}

pub fn stream_begin(
    format: &str,
    total_len: f64,
    max_points: Option<f64>,
    seed: u32,
) -> Result<u32> {
    let format = TractFormat::parse(format)
        .ok_or_else(|| Error::Parse(format!("unknown tractogram format {format}")))?;
    let options = LoadOptions {
        max_points: max_points.map(|m| m as u64),
        seed,
    };
    let loader = Loader::new(format, total_len as u64, options)?;
    let id = NEXT.with(|n| {
        let mut n = n.borrow_mut();
        *n += 1;
        *n - 1
    });
    STREAMS.with(|s| s.borrow_mut().insert(id, loader));
    Ok(id)
}

fn with_stream<R>(id: u32, f: impl FnOnce(&mut Loader) -> Result<R>) -> Result<R> {
    STREAMS.with(|s| match s.borrow_mut().get_mut(&id) {
        Some(l) => f(l),
        None => Err(Error::Parse(format!("tract stream {id} is not open"))),
    })
}

pub fn stream_push(id: u32, chunk: &[u8]) -> Result<()> {
    with_stream(id, |l| l.push(chunk))
}

pub fn stream_end_pass(id: u32) -> Result<bool> {
    with_stream(id, Loader::end_pass)
}

pub fn stream_finish(id: u32) -> Result<JsValue> {
    let loader = STREAMS
        .with(|s| s.borrow_mut().remove(&id))
        .ok_or_else(|| Error::Parse(format!("tract stream {id} is not open")))?;
    let tract = loader.finish()?;
    let meta = meta_of(&tract);
    let handle = handles::insert(Dataset::Tract(Box::new(TractState {
        tract,
        visible: None,
    })));
    jsv::set_u32(&meta, "handle", handle);
    let out = jsv::obj();
    jsv::set(&out, "meta", &meta.into());
    Ok(out.into())
}

fn field_meta(f: &TractField) -> js_sys::Object {
    let o = jsv::obj();
    jsv::set_str(&o, "name", &f.name);
    if let Some(u) = &f.units {
        jsv::set_str(&o, "units", u);
    }
    jsv::set(&o, "stats", &jsv::stats(&f.stats).into());
    jsv::set_f64(&o, "nanCount", f.nan_count as f64);
    if f.builtin {
        jsv::set(&o, "builtin", &JsValue::TRUE);
    }
    if f.categorical {
        jsv::set(&o, "categorical", &JsValue::TRUE);
    }
    if f.sampled {
        jsv::set(&o, "sampled", &JsValue::TRUE);
    }
    o
}

fn field_metas(list: &[TractField]) -> js_sys::Array {
    let a = js_sys::Array::new();
    for f in list {
        a.push(&field_meta(f));
    }
    a
}

fn meta_of(t: &Tractogram) -> js_sys::Object {
    let o = jsv::obj();
    jsv::set_str(&o, "fingerprint", &t.fingerprint);
    jsv::set_f64(&o, "nStreamlines", t.n_streamlines() as f64);
    jsv::set_f64(&o, "nPoints", t.n_points() as f64);
    jsv::set_f64(&o, "sourceStreamlines", t.source_streamlines as f64);
    jsv::set_f64(&o, "sourcePoints", t.source_points as f64);
    let b = jsv::obj();
    jsv::set(&b, "min", &jsv::vec3(t.bounds.min).into());
    jsv::set(&b, "max", &jsv::vec3(t.bounds.max).into());
    jsv::set(&o, "bounds", &b.into());
    jsv::set(&o, "vertexFields", &field_metas(&t.vertex_fields).into());
    jsv::set(
        &o,
        "streamlineFields",
        &field_metas(&t.streamline_fields).into(),
    );
    let groups = js_sys::Array::new();
    for g in &t.groups {
        let r = jsv::obj();
        jsv::set_u32(&r, "id", g.id);
        jsv::set_str(&r, "name", &g.name);
        jsv::set_u32(&r, "count", g.streamlines.len() as u32);
        if let Some(c) = g.color {
            jsv::set(
                &r,
                "color",
                &jsv::nums(c.iter().map(|v| f64::from(*v))).into(),
            );
        }
        groups.push(&r);
    }
    jsv::set(&o, "groups", &groups.into());
    let notes = js_sys::Array::new();
    for n in &t.notes {
        notes.push(&JsValue::from_str(n));
    }
    jsv::set(&o, "notes", &notes.into());
    jsv::set_str(&o, "headerJson", &t.header_json);
    o
}

pub fn geometry(handle: u32) -> Result<JsValue> {
    handles::with_tract_mut(handle, |s| {
        let g = tvx_tract::gpu_geometry(&s.tract);
        let o = jsv::obj();
        jsv::set(
            &o,
            "vertices",
            &js_sys::Uint8Array::from(g.vertices.as_slice()).into(),
        );
        jsv::set(
            &o,
            "streamlineIds",
            &js_sys::Uint32Array::from(g.streamline_ids.as_slice()).into(),
        );
        jsv::set(
            &o,
            "indices",
            &js_sys::Uint32Array::from(g.indices.as_slice()).into(),
        );
        jsv::set(&o, "origin", &jsv::vec3(g.origin).into());
        jsv::set_f64(&o, "quantum", f64::from(g.quantum));
        Ok(o.into())
    })
}

pub fn scalar(handle: u32, kind: &str, name: &str) -> Result<JsValue> {
    let per_streamline = match kind {
        "vertex" => false,
        "streamline" => true,
        other => return Err(Error::Parse(format!("unknown tract field kind {other}"))),
    };
    handles::with_tract_mut(handle, |s| {
        let v = tvx_tract::scalar_u16(&s.tract, per_streamline, name)?;
        let o = jsv::obj();
        jsv::set(
            &o,
            "values",
            &js_sys::Uint16Array::from(v.values.as_slice()).into(),
        );
        jsv::set_f64(&o, "lo", f64::from(v.lo));
        jsv::set_f64(&o, "hi", f64::from(v.hi));
        Ok(o.into())
    })
}

pub fn style(handle: u32, spec_json: &str) -> Result<JsValue> {
    let v: serde_json::Value = serde_json::from_str(spec_json)
        .map_err(|e| Error::Parse(format!("tractStyle spec: {e}")))?;
    let bound = |x: &serde_json::Value| x.as_f64().map(|f| f as f32);
    let spec = StyleSpec {
        filter: v.get("filter").filter(|f| !f.is_null()).and_then(|f| {
            Some((
                f.get("field")?.as_str()?.to_string(),
                bound(&f["lo"]),
                bound(&f["hi"]),
            ))
        }),
        group_field: v
            .get("groupField")
            .and_then(|g| g.as_str())
            .map(str::to_string),
        visible_groups: v
            .get("visibleGroups")
            .and_then(|g| g.as_array())
            .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect()),
    };
    handles::with_tract_mut(handle, |s| {
        let st = tvx_tract::style(&s.tract, &spec)?;
        let o = jsv::obj();
        jsv::set(
            &o,
            "rgba",
            &js_sys::Uint8Array::from(st.rgba.as_slice()).into(),
        );
        jsv::set_u32(&o, "visibleStreamlines", st.visible_streamlines);
        let groups = js_sys::Array::new();
        for g in &st.groups {
            let r = jsv::obj();
            jsv::set_f64(&r, "id", g.id as f64);
            jsv::set_str(&r, "name", &g.name);
            jsv::set_u32(&r, "count", g.count);
            jsv::set(
                &r,
                "color",
                &jsv::nums(g.color.iter().map(|c| f64::from(*c))).into(),
            );
            groups.push(&r);
        }
        jsv::set(&o, "groups", &groups.into());
        s.visible = Some(st.visible);
        Ok(o.into())
    })
}

fn value_rows(rows: &[(String, f32, Option<String>)]) -> js_sys::Array {
    let a = js_sys::Array::new();
    for (name, value, units) in rows {
        let r = jsv::obj();
        jsv::set_str(&r, "name", name);
        jsv::set_f64(&r, "value", f64::from(*value));
        if let Some(u) = units {
            jsv::set_str(&r, "units", u);
        }
        a.push(&r);
    }
    a
}

pub fn probe(
    handle: u32,
    world: [f32; 3],
    radius_mm: f32,
    streamline: Option<u32>,
) -> Result<JsValue> {
    handles::with_tract_mut(handle, |s| {
        let o = jsv::obj();
        match tvx_tract::probe(&s.tract, s.visible.as_deref(), world, radius_mm, streamline) {
            None => jsv::set(&o, "hit", &JsValue::NULL),
            Some(h) => {
                let r = jsv::obj();
                jsv::set_u32(&r, "held", h.held);
                jsv::set_u32(&r, "streamline", h.streamline);
                jsv::set_u32(&r, "vertex", h.vertex);
                jsv::set(&r, "world", &jsv::vec3(h.world).into());
                jsv::set_f64(&r, "distanceMm", f64::from(h.distance_mm));
                jsv::set(&r, "vertexFields", &value_rows(&h.vertex_fields).into());
                jsv::set(
                    &r,
                    "streamlineFields",
                    &value_rows(&h.streamline_fields).into(),
                );
                let groups = js_sys::Array::new();
                for g in &h.groups {
                    groups.push(&JsValue::from_str(g));
                }
                jsv::set(&r, "groups", &groups.into());
                jsv::set(&o, "hit", &r.into());
            }
        }
        Ok(o.into())
    })
}

pub fn points(handle: u32, first: u32, count: u32, tangents: bool) -> Result<JsValue> {
    handles::with_tract_mut(handle, |s| {
        let t = &s.tract;
        let (a, b) = (first as usize, first as usize + count as usize);
        if b > t.n_points() {
            return Err(Error::Parse(format!(
                "tractPoints asked for {a}..{b} of {} points",
                t.n_points()
            )));
        }
        let o = jsv::obj();
        jsv::set(
            &o,
            "positions",
            &js_sys::Float32Array::from(&t.positions[a * 3..b * 3]).into(),
        );
        if tangents {
            let mut out = vec![0.0f32; (b - a) * 3];
            tvx_tract::tangents_into(&t.positions, &t.offsets, a, &mut out);
            jsv::set(
                &o,
                "tangents",
                &js_sys::Float32Array::from(out.as_slice()).into(),
            );
        }
        Ok(o.into())
    })
}

pub fn field_chunk(
    handle: u32,
    name: &str,
    units: Option<String>,
    first: u32,
    values: &[f32],
    done: bool,
) -> Result<JsValue> {
    handles::with_tract_mut(handle, |s| {
        let f =
            tvx_tract::write_field_chunk(&mut s.tract, name, units, first as usize, values, done)?;
        let o = jsv::obj();
        if let Some(f) = f {
            jsv::set(&o, "field", &field_meta(f).into());
        }
        Ok(o.into())
    })
}

fn op_of(op: &str) -> Result<SampleOp> {
    SampleOp::parse(op).ok_or_else(|| Error::Parse(format!("unknown sample op {op}")))
}

fn result(values: Vec<f32>, outside: u32) -> JsValue {
    let o = jsv::obj();
    jsv::set(
        &o,
        "values",
        &js_sys::Float32Array::from(values.as_slice()).into(),
    );
    jsv::set_u32(&o, "outside", outside);
    o.into()
}

pub fn volume_sample(
    handle: u32,
    points: &[f32],
    tangents: Option<&[f32]>,
    volume_index: u32,
    op: &str,
    basis: &str,
) -> Result<JsValue> {
    let op = op_of(op)?;
    let voxel_basis = match basis {
        "world" | "" => false,
        "voxel" => true,
        other => return Err(Error::Parse(format!("unknown vector basis {other}"))),
    };
    handles::with_volume(handle, |v| {
        let (values, outside) =
            tvx_tract::sample_volume(v, points, tangents, volume_index as usize, op, voxel_basis)?;
        Ok(result(values, outside))
    })
}

pub fn mesh_sample(
    handle: u32,
    points: &[f32],
    tangents: Option<&[f32]>,
    source: &str,
    name: &str,
    op: &str,
) -> Result<JsValue> {
    let op = op_of(op)?;
    handles::with_mesh_mut(handle, |m| {
        if m.sampler.is_none() {
            m.sampler = Some(TetSampler::new(&m.mesh));
        }
        let sampler = m.sampler.as_ref().expect("built above");
        let (values, outside) =
            tvx_tract::sample_mesh(&m.mesh, sampler, points, tangents, source, name, op)?;
        Ok(result(values, outside))
    })
}
