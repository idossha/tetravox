//! `load_mesh` and every mesh-side §6.4 export, plus the §6.5.1 `MeshMeta` they build.

use std::collections::BTreeMap;

use tvx_core::{Error, Field, FieldStats, LabelTable, Plane, ProgressSink, Result};
use tvx_geom::IsolateCriteria;
use tvx_mesh_io::{ElmField, Format, Mesh, MshOptions};
use tvx_nifti::VolumeData;
use wasm_bindgen::prelude::*;

use crate::{geom, handles, jsv, lut, stats, surface};

// ---------------------------------------------------------------------------------------------
// load_mesh
// ---------------------------------------------------------------------------------------------

fn dispatch(bytes: Vec<u8>, format: &str, p: &mut dyn ProgressSink) -> Result<Mesh> {
    let chosen = match format {
        "auto" => tvx_mesh_io::sniff(&bytes, None)?,
        "msh" => Format::Msh,
        "gii" => Format::Gifti,
        "fs" => Format::FsSurface,
        "stl" => Format::Stl,
        "ply" => Format::Ply,
        "obj" => Format::Obj,
        other => {
            return Err(Error::Unsupported(format!(
                "load_mesh format {other:?}; expected auto|msh|gii|fs|stl|ply|obj"
            )))
        }
    };
    match chosen {
        Format::Msh => tvx_mesh_io::read_msh(bytes, p),
        Format::Gifti => tvx_mesh_io::read_gifti(bytes, p),
        Format::FsSurface => tvx_mesh_io::read_fs_surface(bytes),
        Format::Stl => tvx_mesh_io::read_stl(bytes),
        Format::Ply => tvx_mesh_io::read_ply(bytes),
        Format::Obj => tvx_mesh_io::read_obj(bytes),
    }
}

/// A deterministic glasbey-like fallback palette (§6.2's last rung). Indexed by the **volume** tag
/// — `1xxx` folds to `1xxx − 1000` first — so a surface and the volume it bounds get the same
/// colour even when neither is named anywhere.
const PALETTE: [[u8; 4]; 20] = [
    [0xE6, 0x19, 0x4B, 255],
    [0x3C, 0xB4, 0x4B, 255],
    [0x43, 0x63, 0xD8, 255],
    [0xF5, 0x82, 0x31, 255],
    [0x91, 0x1E, 0xB4, 255],
    [0x46, 0xF0, 0xF0, 255],
    [0xF0, 0x32, 0xE6, 255],
    [0xBC, 0xF6, 0x0C, 255],
    [0xFA, 0xBE, 0xBE, 255],
    [0x00, 0x80, 0x80, 255],
    [0xE6, 0xBE, 0xFF, 255],
    [0x9A, 0x63, 0x24, 255],
    [0xFF, 0xFA, 0xC8, 255],
    [0x80, 0x00, 0x00, 255],
    [0xAA, 0xFF, 0xC3, 255],
    [0x80, 0x80, 0x00, 255],
    [0xFF, 0xD8, 0xB1, 255],
    [0x00, 0x00, 0x75, 255],
    [0x80, 0x80, 0x80, 255],
    [0xFF, 0xE1, 0x19, 255],
];

/// §6.2: "surface tag `1xxx` inherits the colour of volume tag `1xxx − 1000`".
fn base_tag(t: i32) -> i32 {
    if t > 1000 {
        t - 1000
    } else {
        t
    }
}

fn pick<T>(table: &[(i32, T)], tag: i32) -> Option<&T> {
    let base = base_tag(tag);
    table
        .iter()
        .find(|(k, _)| *k == tag)
        .or_else(|| table.iter().find(|(k, _)| *k == base))
        .map(|(_, v)| v)
}

fn lut_pairs(t: &LabelTable) -> Vec<(i32, (String, [u8; 4]))> {
    t.entries
        .iter()
        .map(|e| (e.id as i32, (e.name.clone(), e.color)))
        .collect()
}

/// Tag names and tag colours, in the same order, one entry per tag the mesh actually uses.
type ResolvedTags = (Vec<(i32, String)>, Vec<(i32, [u8; 4])>);

/// §6.2's tag ladder, resolved once at load: `$PhysicalNames` → sibling `_LUT.txt` → sibling
/// `.msh.opt` → the deterministic palette. Names and colours walk the same ladder, but
/// `$PhysicalNames` carries no colour and the palette carries no name, so the two can land on
/// different rungs for the same tag.
fn resolve_tags(
    mesh: &Mesh,
    table: Option<&LabelTable>,
    opt: Option<&MshOptions>,
    opt_names: &[(i32, String)],
) -> ResolvedTags {
    let lut_entries: Vec<(i32, (String, [u8; 4]))> = table.map(lut_pairs).unwrap_or_default();
    let mut tags: Vec<i32> = mesh
        .tri_tags
        .iter()
        .chain(mesh.tet_tags.iter())
        .copied()
        .collect();
    tags.sort_unstable();
    tags.dedup();

    let mut names = Vec::new();
    let mut colors = Vec::new();
    for t in tags {
        if let Some(n) = pick(&mesh.physical_names, t)
            .cloned()
            .or_else(|| pick(&lut_entries, t).map(|(n, _)| n.clone()))
            .or_else(|| pick(opt_names, t).cloned())
        {
            // Trimmed **here**, at the display layer, not in the parsers. SimNIBS writes
            // `Physical Volume (" Scalp",5)` with a leading space and `testdata/manifest.json`
            // records that verbatim as the parser's ground truth — but `MeshMeta.tags[].name` is
            // what §8's tissue table and the info panel show, and `ernie.msh` has no
            // `$PhysicalNames`, so without this every tissue in the app reads " Scalp", " GM", ….
            names.push((t, n.trim().to_string()));
        }
        let c = pick(&lut_entries, t)
            .map(|(_, c)| *c)
            .or_else(|| opt.and_then(|o| pick(&o.tag_color, t).copied()))
            .unwrap_or_else(|| PALETTE[base_tag(t).rem_euclid(PALETTE.len() as i32) as usize]);
        colors.push((t, c));
    }
    (names, colors)
}

fn field_meta(name: &str, source: &str, ncomp: usize, n: usize, s: &FieldStats) -> js_sys::Object {
    let o = jsv::obj();
    jsv::set_str(&o, "name", name);
    jsv::set_str(&o, "source", source);
    jsv::set_usize(&o, "ncomp", ncomp);
    jsv::set_usize(&o, "n", n);
    jsv::set(&o, "stats", &jsv::stats(s).into());
    o
}

fn opt_to_js(o: &MshOptions) -> js_sys::Object {
    let color = jsv::obj();
    for (tag, c) in &o.tag_color {
        jsv::set(
            &color,
            &tag.to_string(),
            &jsv::nums(c.iter().map(|x| f64::from(*x))).into(),
        );
    }
    let visible = jsv::obj();
    for (tag, v) in &o.tag_visible {
        jsv::set_bool(&visible, &tag.to_string(), *v);
    }
    let views = js_sys::Array::new();
    for v in &o.views {
        let jv = jsv::obj();
        if let Some(n) = &v.name {
            jsv::set_str(&jv, "name", n);
        }
        if let Some(x) = v.custom_min {
            jsv::set_f64(&jv, "customMin", f64::from(x));
        }
        if let Some(x) = v.custom_max {
            jsv::set_f64(&jv, "customMax", f64::from(x));
        }
        if let Some(x) = v.range_type {
            jsv::set_f64(&jv, "rangeType", f64::from(x));
        }
        if let Some(x) = v.saturate_values {
            jsv::set_bool(&jv, "saturateValues", x);
        }
        if let Some(x) = v.colormap_number {
            jsv::set_f64(&jv, "colormapNumber", f64::from(x));
        }
        if let Some(x) = v.show_scale {
            jsv::set_bool(&jv, "showScale", x);
        }
        if let Some(x) = v.vector_type {
            jsv::set_f64(&jv, "vectorType", f64::from(x));
        }
        views.push(&jv);
    }
    let out = jsv::obj();
    jsv::set(&out, "tagColor", &color.into());
    jsv::set(&out, "tagVisible", &visible.into());
    jsv::set(&out, "views", &views.into());
    out
}

/// §6.5.1 `MeshMeta`. `name` is the worker's to fill: `load_mesh` is handed bytes, not a path.
///
/// `fingerprint` is §4.6's `tvxfp1` digest, taken by [`load`] over the input bytes **before** the
/// parser consumes and frees them (§5 rule 5), so it is threaded in rather than recomputed.
fn meta(
    handle: u32,
    st: &handles::MeshState,
    orient: &tvx_geom::OrientReport,
    fingerprint: &str,
) -> JsValue {
    let m = &st.mesh;
    let o = jsv::obj();
    jsv::set_u32(&o, "handle", handle);
    jsv::set_str(&o, "name", "");
    jsv::set_str(&o, "fingerprint", fingerprint);
    jsv::set_usize(&o, "nNodes", m.nodes.len());
    jsv::set_usize(&o, "nTris", m.tris.len());
    jsv::set_usize(&o, "nTets", m.tets.len());
    jsv::set_bool(&o, "hasTris", !m.tris.is_empty());
    // §4.3: what the loader baked into the node coordinates. `tvx-mesh-io` applies GIfTI's
    // CoordinateSystemTransformMatrix but its frozen `Mesh` has nowhere to report *which* matrix
    // (docs/DECISIONS.md), so identity is what this layer can honestly claim.
    jsv::set(
        &o,
        "appliedTransform",
        &jsv::nums([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ])
        .into(),
    );
    jsv::set(&o, "bounds", &surface::bounds(&m.bounds).into());

    let mut counts: BTreeMap<(i32, bool), usize> = BTreeMap::new();
    for t in &m.tri_tags {
        *counts.entry((*t, true)).or_insert(0) += 1;
    }
    for t in &m.tet_tags {
        *counts.entry((*t, false)).or_insert(0) += 1;
    }
    let tags = js_sys::Array::new();
    for ((tag, is_tri), count) in counts {
        let e = jsv::obj();
        jsv::set_f64(&e, "id", f64::from(tag));
        if let Some(n) = st.tag_names.iter().find(|(k, _)| *k == tag) {
            jsv::set_str(&e, "name", &n.1);
        }
        let c = st
            .tag_colors
            .iter()
            .find(|(k, _)| *k == tag)
            .map(|(_, c)| *c)
            .unwrap_or([128, 128, 128, 255]);
        jsv::set(
            &e,
            "color",
            &jsv::nums(c.iter().map(|x| f64::from(*x))).into(),
        );
        jsv::set_str(&e, "kind", if is_tri { "tri" } else { "tet" });
        jsv::set_usize(&e, "count", count);
        tags.push(&e);
    }
    jsv::set(&o, "tags", &tags.into());

    let fields = js_sys::Array::new();
    for f in &m.node_fields {
        let jf = field_meta(
            &f.name,
            "node",
            f.ncomp,
            f.data.len() / f.ncomp.max(1),
            &f.stats,
        );
        if let Some(u) = &f.units {
            jsv::set_str(&jf, "units", u);
        }
        jsv::set_bool(&jf, "partial", f.partial);
        fields.push(&jf);
    }
    for f in &m.elm_fields {
        let n = (f.tri.len() + f.tet.len()) / f.ncomp.max(1);
        let jf = field_meta(&f.name, "elm", f.ncomp, n, &f.stats);
        if let Some(u) = &f.units {
            jsv::set_str(&jf, "units", u);
        }
        jsv::set_bool(&jf, "partial", f.partial);
        fields.push(&jf);
    }
    jsv::set(&o, "fields", &fields.into());

    let skipped = js_sys::Array::new();
    for (ty, n) in &m.skipped {
        let e = jsv::obj();
        jsv::set_u32(&e, "elemType", *ty);
        jsv::set_f64(&e, "count", *n as f64);
        skipped.push(&e);
    }
    jsv::set(&o, "skipped", &skipped.into());
    jsv::set(&o, "orient", &surface::orient(orient).into());
    if let Some(opt) = &st.opt {
        jsv::set(&o, "opt", &opt_to_js(opt).into());
    }
    if !st.label_tables.is_empty() {
        let t = jsv::obj();
        for (name, table) in &st.label_tables {
            jsv::set(&t, name, &jsv::label_entries(table).into());
        }
        jsv::set(&o, "labelTables", &t.into());
    }
    o.into()
}

/// `load_mesh`'s body (§6.4). Morton reorder, `build_tet_blocks` and `build_point_locator` happen
/// here (see `crate::geom`); the result carries **no bulk arrays** — only `{ meta }`.
pub fn load(
    bytes: Vec<u8>,
    format: &str,
    opt_bytes: Option<Vec<u8>>,
    lut_bytes: Option<Vec<u8>>,
    p: &mut dyn ProgressSink,
) -> Result<JsValue> {
    let opt = match &opt_bytes {
        Some(b) => Some(tvx_mesh_io::read_msh_opt(b)?),
        None => None,
    };
    let opt_names: Vec<(i32, String)> =
        opt.as_ref().map(|o| o.tag_name.clone()).unwrap_or_default();
    let table = match &lut_bytes {
        Some(b) => Some(lut::parse(&String::from_utf8_lossy(b))?),
        None => None,
    };

    // §4.6 / §5 rule 3: over the bytes the loader was handed, before `read_msh` (or its sibling)
    // takes ownership and frees them (§5 rule 5). The sidecars are **not** in it — a `.msh.opt`
    // edit must not make the mesh look like a different file.
    let fingerprint = tvx_core::fingerprint(&bytes);
    let mut mesh = dispatch(bytes, format, p)?;
    // §6.2: a `.label.gii` carries its `<LabelTable>` on the mesh (it used to need a second parse
    // of the same bytes through an additive entry point).
    let gifti_labels = mesh.label_table.take();
    let (names, colors) = resolve_tags(&mesh, table.as_ref(), opt.as_ref(), &opt_names);
    let (blocks, locator, orient) = geom::load_time(&mut mesh);

    let mut st = handles::MeshState::new(mesh);
    st.blocks = blocks;
    st.locator = locator;
    st.opt = opt;
    st.tag_names = names;
    st.tag_colors = colors;
    if let Some(t) = gifti_labels {
        if !t.entries.is_empty() {
            // §6.5.1 keys `labelTables` by node-field name. `tvx-mesh-io` names a GIfTI array from
            // its `Name` metadata, falling back to the short intent — `label` for a `.label.gii`.
            let named: Vec<String> = st
                .mesh
                .node_fields
                .iter()
                .filter(|f| f.name.eq_ignore_ascii_case("label"))
                .map(|f| f.name.clone())
                .collect();
            let keys = if named.is_empty() && st.mesh.node_fields.len() == 1 {
                vec![st.mesh.node_fields[0].name.clone()]
            } else {
                named
            };
            for k in keys {
                st.label_tables.push((k, t.clone()));
            }
        }
    }

    let handle = handles::insert(handles::Dataset::Mesh(Box::new(st)));
    let m = handles::with_mesh(handle, |st| Ok(meta(handle, st, &orient, &fingerprint)))?;
    let out = jsv::obj();
    jsv::set(&out, "meta", &m);
    Ok(out.into())
}

// ---------------------------------------------------------------------------------------------
// surface / boundary / topology
// ---------------------------------------------------------------------------------------------

pub fn surface_op(
    handle: u32,
    mask_id: Option<u32>,
    variant: &str,
    p: &mut dyn ProgressSink,
) -> Result<JsValue> {
    let v = surface::variant_of(variant)
        .ok_or_else(|| Error::Parse(format!("variant {variant:?}; expected indexed|deindexed")))?;
    handles::with_mesh(handle, |st| {
        let mask = st.mask(mask_id)?;
        // §6.3: a mesh that ships surface elements is drawn from its own tagged triangles, and
        // `tag_surfaces` takes no topology. Only a tri-less tet mesh needs the boundary.
        let s = if !st.mesh.tris.is_empty() && mask.is_none() {
            geom::tag_surfaces(&st.mesh, v, p)?
        } else {
            geom::extract_boundary(&st.mesh, st.topo.as_ref(), mask, v, p)?
        };
        Ok(surface::to_js(&s))
    })
}

pub fn boundary_op(
    handle: u32,
    mask_id: Option<u32>,
    variant: &str,
    p: &mut dyn ProgressSink,
) -> Result<JsValue> {
    let v = surface::variant_of(variant)
        .ok_or_else(|| Error::Parse(format!("variant {variant:?}; expected indexed|deindexed")))?;
    handles::with_mesh(handle, |st| {
        let mask = st.mask(mask_id)?;
        let s = geom::extract_boundary(&st.mesh, st.topo.as_ref(), mask, v, p)?;
        Ok(surface::to_js(&s))
    })
}

pub fn build_topology(handle: u32, p: &mut dyn ProgressSink) -> Result<JsValue> {
    handles::with_mesh_mut(handle, |st| {
        let topo = geom::build_topology(&st.mesh, p)?;
        let faces = topo.faces.len();
        let boundary = topo
            .face_tets
            .iter()
            .filter(|ft| ft[0] < 0 || ft[1] < 0)
            .count();
        st.topo = Some(topo);
        let o = jsv::obj();
        jsv::set_usize(&o, "faces", faces);
        jsv::set_usize(&o, "boundaryFaces", boundary);
        Ok(o.into())
    })
}

// ---------------------------------------------------------------------------------------------
// cut
// ---------------------------------------------------------------------------------------------

pub fn cut(
    handle: u32,
    planes: &[f32],
    mask_id: Option<u32>,
    out: Option<crate::CutOut>,
) -> Result<JsValue> {
    if !planes.len().is_multiple_of(4) {
        return Err(Error::Parse(format!(
            "cut planes carry {} floats; 4 per plane",
            planes.len()
        )));
    }
    let n = planes.len() / 4;
    if n == 0 || n > 6 {
        return Err(Error::Parse(format!("{n} cut planes; §6.4 allows 1..=6")));
    }
    let ps: Vec<Plane> = planes
        .chunks_exact(4)
        .map(|c| Plane {
            normal: [c[0], c[1], c[2]],
            offset: c[3],
        })
        .collect();
    handles::with_mesh(handle, |st| {
        let mask = st.mask(mask_id)?;
        let cuts = if st.mesh.tets.is_empty() {
            Vec::new()
        } else {
            geom::plane_cut(&st.mesh, st.blocks.as_ref(), &ps, mask)?
        };
        Ok(match &out {
            Some(pool) => surface::cuts_to_pool(&cuts, pool),
            None => surface::cuts_to_js(&cuts),
        })
    })
}

// ---------------------------------------------------------------------------------------------
// isolate
// ---------------------------------------------------------------------------------------------

/// Reinterpret the cloned label volume's bytes per `LabelVolumeCriteria.dtype` (§6.3). A
/// `dtype`/`dims`/byte-length mismatch is `Error::Parse`.
fn label_volume_data(
    bytes: &[u8],
    dtype: &str,
    dims: [usize; 3],
    index: usize,
) -> Result<VolumeData> {
    let voxels = dims[0] * dims[1] * dims[2];
    let width = match dtype {
        "u8" | "i8" => 1,
        "u16" | "i16" => 2,
        "u32" | "i32" | "f32" => 4,
        "f64" => 8,
        other => {
            return Err(Error::Parse(format!(
                "label volume dtype {other:?} is not an index type"
            )))
        }
    };
    if voxels == 0 || !bytes.len().is_multiple_of(voxels * width) {
        return Err(Error::Parse(format!(
            "label volume is {} bytes; dims {dims:?} × {width} does not divide it",
            bytes.len()
        )));
    }
    let nvols = bytes.len() / (voxels * width);
    if index >= nvols {
        return Err(Error::Parse(format!(
            "label volume index {index} of {nvols}"
        )));
    }
    Ok(match dtype {
        "u8" => VolumeData::U8(bytes.to_vec()),
        "i8" => VolumeData::I8(bytes.iter().map(|b| *b as i8).collect()),
        "u16" => VolumeData::U16(
            bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect(),
        ),
        "i16" => VolumeData::I16(
            bytes
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect(),
        ),
        "u32" => VolumeData::U32(
            bytes
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect(),
        ),
        "i32" => VolumeData::I32(
            bytes
                .chunks_exact(4)
                .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect(),
        ),
        "f32" => VolumeData::F32(
            bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect(),
        ),
        _ => VolumeData::F64(
            bytes
                .chunks_exact(8)
                .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]))
                .collect(),
        ),
    })
}

pub fn isolate(
    handle: u32,
    criteria_json: &str,
    label_volume: Option<Vec<u8>>,
    p: &mut dyn ProgressSink,
) -> Result<JsValue> {
    let crit: IsolateCriteria = serde_json::from_str(criteria_json)
        .map_err(|e| Error::Parse(format!("isolate criteria: {e}")))?;
    let data = match (&crit.label_volume, &label_volume) {
        (Some(c), Some(b)) => Some(label_volume_data(b, &c.dtype, c.dims, c.volume_index)?),
        (Some(_), None) => {
            return Err(Error::Parse(
                "criteria.labelVolume is set but the `labelVolume` argument is missing".into(),
            ))
        }
        (None, _) => None,
    };
    handles::with_mesh_mut(handle, |st| {
        let mask = geom::isolate(&st.mesh, &crit, data.as_ref(), p)?;
        let visible = mask.count_ones();
        let id = st.add_mask(mask);
        let o = jsv::obj();
        jsv::set_u32(&o, "maskId", id);
        jsv::set_usize(&o, "visibleTets", visible);
        jsv::set_u32(&o, "generation", st.generation);
        Ok(o.into())
    })
}

// ---------------------------------------------------------------------------------------------
// fields
// ---------------------------------------------------------------------------------------------

enum Component {
    Mag,
    At(usize),
}

fn component_of(s: &str) -> Result<Component> {
    match s {
        "mag" => Ok(Component::Mag),
        "0" => Ok(Component::At(0)),
        "1" => Ok(Component::At(1)),
        "2" => Ok(Component::At(2)),
        other => Err(Error::Parse(format!(
            "component {other:?}; expected mag|0|1|2"
        ))),
    }
}

/// Select one component out of a row-major `n × ncomp` array. `mag` of a scalar is the scalar
/// itself, signed — taking `|v|` there would silently rectify a signed field.
fn select(data: &[f32], ncomp: usize, c: &Component) -> Result<Vec<f32>> {
    let ncomp = ncomp.max(1);
    match c {
        Component::Mag if ncomp == 1 => Ok(data.to_vec()),
        Component::Mag => Ok(data
            .chunks_exact(ncomp)
            .map(|r| r.iter().map(|x| x * x).sum::<f32>().sqrt())
            .collect()),
        Component::At(i) if *i < ncomp => {
            Ok(data.iter().skip(*i).step_by(ncomp).copied().collect())
        }
        Component::At(i) => Err(Error::Parse(format!(
            "component {i} of a {ncomp}-component field"
        ))),
    }
}

/// `true` when the crate's own `stats` already describes exactly this selection (§6.0: "of the
/// magnitude when `ncomp > 1`"), so nothing has to be recomputed.
fn stats_are_reusable(ncomp: usize, c: &Component) -> bool {
    matches!(c, Component::Mag) || (ncomp <= 1 && matches!(c, Component::At(0)))
}

fn elm_values(f: &ElmField) -> Vec<f32> {
    let mut v = Vec::with_capacity(f.tri.len() + f.tet.len());
    v.extend_from_slice(&f.tri);
    v.extend_from_slice(&f.tet);
    v
}

fn find_node_field<'a>(m: &'a Mesh, name: &str) -> Result<&'a Field> {
    m.node_fields
        .iter()
        .find(|f| f.name == name)
        .ok_or_else(|| Error::Parse(format!("no node field {name:?}")))
}

fn find_elm_field<'a>(m: &'a Mesh, name: &str) -> Result<&'a ElmField> {
    m.elm_fields
        .iter()
        .find(|f| f.name == name)
        .ok_or_else(|| Error::Parse(format!("no element field {name:?}")))
}

pub fn field(handle: u32, source: &str, name: &str, component: &str) -> Result<JsValue> {
    let c = component_of(component)?;
    handles::with_mesh(handle, |st| {
        let (values, base, ncomp, partial) = match source {
            "node" => {
                let f = find_node_field(&st.mesh, name)?;
                (select(&f.data, f.ncomp, &c)?, &f.stats, f.ncomp, f.partial)
            }
            "elm" => {
                let f = find_elm_field(&st.mesh, name)?;
                (
                    select(&elm_values(f), f.ncomp, &c)?,
                    &f.stats,
                    f.ncomp,
                    f.partial,
                )
            }
            other => {
                return Err(Error::Parse(format!(
                    "field source {other:?}; expected node|elm"
                )))
            }
        };
        let s = if stats_are_reusable(ncomp, &c) {
            base.clone()
        } else {
            stats::of(&values)
        };
        let o = jsv::obj();
        jsv::set_usize(&o, "n", values.len());
        jsv::set(&o, "values", &jsv::f32s(&values).into());
        jsv::set(&o, "stats", &jsv::stats(&s).into());
        jsv::set_bool(&o, "partial", partial);
        Ok(o.into())
    })
}

pub fn convert_field(handle: u32, direction: &str, source_name: &str) -> Result<JsValue> {
    handles::with_mesh(handle, |st| {
        let (name, values, s) = match direction {
            "elmToNode" => {
                let f = find_elm_field(&st.mesh, source_name)?;
                let out = geom::elm_to_node(&st.mesh, f)?;
                (out.name.clone(), out.data.clone(), out.stats.clone())
            }
            "nodeToElm" => {
                let f = find_node_field(&st.mesh, source_name)?;
                let out = geom::node_to_elm(&st.mesh, f)?;
                (out.name.clone(), elm_values(&out), out.stats.clone())
            }
            other => {
                return Err(Error::Parse(format!(
                    "direction {other:?}; expected elmToNode|nodeToElm"
                )))
            }
        };
        let o = jsv::obj();
        jsv::set_str(&o, "name", &name);
        jsv::set(&o, "values", &jsv::f32s(&values).into());
        jsv::set(&o, "stats", &jsv::stats(&s).into());
        Ok(o.into())
    })
}

// ---------------------------------------------------------------------------------------------
// locate / contours / marching tets
// ---------------------------------------------------------------------------------------------

fn named_values(pairs: &[(String, Vec<f32>)]) -> js_sys::Object {
    let o = jsv::obj();
    for (name, v) in pairs {
        jsv::set(&o, name, &jsv::nums(v.iter().map(|x| f64::from(*x))).into());
    }
    o
}

pub fn locate(handle: u32, x: f32, y: f32, z: f32) -> Result<JsValue> {
    handles::with_mesh(handle, |st| {
        let hit = geom::locate_point(&st.mesh, st.locator.as_ref(), [x, y, z])?;
        let o = jsv::obj();
        match hit {
            None => jsv::set(&o, "hit", &JsValue::NULL),
            Some(h) => {
                let j = jsv::obj();
                jsv::set_u32(&j, "elementId", h.gmsh_elm);
                jsv::set_f64(&j, "tag", f64::from(h.tag));
                jsv::set(&j, "nodeValues", &named_values(&h.node_values).into());
                jsv::set(&j, "elmValues", &named_values(&h.elm_values).into());
                jsv::set(&o, "hit", &j.into());
            }
        }
        Ok(o.into())
    })
}

pub fn contours(handle: u32, plane: &[f32], mask_id: Option<u32>) -> Result<JsValue> {
    if plane.len() != 4 {
        return Err(Error::Parse(format!(
            "contour plane carries {} floats; expected 4",
            plane.len()
        )));
    }
    let pl = Plane {
        normal: [plane[0], plane[1], plane[2]],
        offset: plane[3],
    };
    handles::with_mesh(handle, |st| {
        let mask = st.mask(mask_id)?;
        let segs = geom::surface_contours(&st.mesh, &pl, mask)?;
        let o = jsv::obj();
        jsv::set(&o, "segments", &jsv::f32s(&segs).into());
        Ok(o.into())
    })
}

pub fn marching_tets(
    handle: u32,
    source: &str,
    name: &str,
    component: &str,
    iso: f32,
    mask_id: Option<u32>,
    p: &mut dyn ProgressSink,
) -> Result<JsValue> {
    let c = component_of(component)?;
    handles::with_mesh(handle, |st| {
        let nodal: Vec<f32> = match source {
            "node" => {
                let f = find_node_field(&st.mesh, name)?;
                select(&f.data, f.ncomp, &c)?
            }
            "elm" => {
                // Reduce to a scalar element field first, then interpolate to the nodes: §6.3's
                // `marching_tets` takes one value per node.
                let f = find_elm_field(&st.mesh, name)?;
                let tri = select(&f.tri, f.ncomp, &c)?;
                let tet = select(&f.tet, f.ncomp, &c)?;
                let scalar = ElmField {
                    name: f.name.clone(),
                    ncomp: 1,
                    tri,
                    tet,
                    units: f.units.clone(),
                    partial: f.partial,
                    stats: f.stats.clone(),
                };
                geom::elm_to_node(&st.mesh, &scalar)?.data
            }
            other => {
                return Err(Error::Parse(format!(
                    "field source {other:?}; expected node|elm"
                )))
            }
        };
        let mask = st.mask(mask_id)?;
        let s = geom::marching_tets(&st.mesh, &nodal, iso, mask, p)?;
        Ok(surface::to_js(&s))
    })
}
