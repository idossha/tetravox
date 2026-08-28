//! `load_volume`, `volume_frame`, `volume_marching_cubes`, `volume_label_centroids` (§6.4), and the
//! §6.5.1 `VolumeMeta` / `VolumeFrameT` they build.

use tvx_core::Result;
use tvx_nifti::{DataType, GpuCaps, GpuFormat, GpuPayload, SpaceUnit, Volume, VolumeData};
use wasm_bindgen::prelude::*;

use crate::{handles, jsv};

/// §6.5.1 `VolumeMeta.dtype`.
pub fn dtype_name(d: DataType) -> &'static str {
    match d {
        DataType::U8 => "u8",
        DataType::I8 => "i8",
        DataType::U16 => "u16",
        DataType::I16 => "i16",
        DataType::U32 => "u32",
        DataType::I32 => "i32",
        DataType::F32 => "f32",
        DataType::F64 => "f64",
        DataType::Rgb24 => "rgb24",
        DataType::Rgba32 => "rgba32",
    }
}

fn gpu_format_name(f: GpuFormat) -> &'static str {
    match f {
        GpuFormat::R8 => "R8",
        GpuFormat::R8Ui => "R8UI",
        GpuFormat::R16 => "R16",
        GpuFormat::R16Ui => "R16UI",
        GpuFormat::R16F => "R16F",
        GpuFormat::R32F => "R32F",
        GpuFormat::Rgba8 => "RGBA8",
    }
}

fn units_name(u: SpaceUnit) -> Option<&'static str> {
    match u {
        SpaceUnit::Unknown => None,
        SpaceUnit::Meter => Some("m"),
        SpaceUnit::Millimeter => Some("mm"),
        SpaceUnit::Micron => Some("um"),
    }
}

/// A texture upload is **chunked** into z-slabs when a single `texImage3D` would blow §7.2's
/// main-thread budget rule — "no single main-thread call may exceed `frameBudget / 2`", i.e. 4 ms of
/// a 8 ms frame. §7.2 measures 256×256×208 at 3.6–5.5 ms for R16UI (27.3 MB) and 11.1 ms for R32F
/// (54.5 MB), so the achieved upload rate is ~5 GB/s and 4 ms buys ~20 MB. The threshold is 16 MiB.
const CHUNK_ABOVE_BYTES: usize = 16 * 1024 * 1024;

fn gpu_info(p: &GpuPayload) -> js_sys::Object {
    let o = jsv::obj();
    jsv::set_str(&o, "format", gpu_format_name(p.format));
    jsv::set_f64(&o, "scale", f64::from(p.scale));
    jsv::set_f64(&o, "offset", f64::from(p.offset));
    jsv::set_bool(&o, "filterable", p.filterable);
    jsv::set_bool(&o, "chunked", p.bytes.len() > CHUNK_ABOVE_BYTES);
    o
}

/// `VolumeDataset.data` (§4.3): the RAW on-disk samples, in the file's own dtype, kept on the UI
/// thread for probes. One `js_sys` typed array per dtype means one memcpy and no widening — the
/// engine reads it back through `VolumeMeta.dtype`.
fn raw_samples(d: &VolumeData) -> js_sys::ArrayBuffer {
    match d {
        VolumeData::U8(v) | VolumeData::Rgb24(v) | VolumeData::Rgba32(v) => {
            js_sys::Uint8Array::from(&v[..]).buffer()
        }
        VolumeData::I8(v) => js_sys::Int8Array::from(&v[..]).buffer(),
        VolumeData::U16(v) => js_sys::Uint16Array::from(&v[..]).buffer(),
        VolumeData::I16(v) => js_sys::Int16Array::from(&v[..]).buffer(),
        VolumeData::U32(v) => js_sys::Uint32Array::from(&v[..]).buffer(),
        VolumeData::I32(v) => js_sys::Int32Array::from(&v[..]).buffer(),
        VolumeData::F32(v) => js_sys::Float32Array::from(&v[..]).buffer(),
        VolumeData::F64(v) => js_sys::Float64Array::from(&v[..]).buffer(),
    }
}

/// §6.5.1 `VolumeMeta`. `name` is filled in by the worker, which is the only side that knows the
/// `LoadSource` (§6.5.2) — `load_volume` is handed bytes, not a path.
///
/// `fingerprint` is §4.6's `tvxfp1` digest, taken by [`load`] over the input bytes **before**
/// `read_nifti` consumes and frees them (§5 rule 5); it cannot be recomputed from the parsed
/// `Volume`, which is why it is threaded in as an argument.
fn meta(
    handle: u32,
    v: &Volume,
    gpu: &GpuPayload,
    lut: Option<&tvx_core::LabelTable>,
    fingerprint: &str,
) -> JsValue {
    let o = jsv::obj();
    jsv::set_u32(&o, "handle", handle);
    jsv::set_str(&o, "name", "");
    jsv::set_str(&o, "fingerprint", fingerprint);
    jsv::set(
        &o,
        "dims",
        &jsv::nums(v.dims.iter().map(|d| *d as f64)).into(),
    );
    jsv::set_usize(&o, "nvols", v.nvols);
    jsv::set(&o, "affine", &jsv::mat4_from_row_major(&v.affine).into());
    jsv::set(&o, "spacing", &jsv::nums(v.spacing.iter().copied()).into());
    jsv::set_str(&o, "dtype", dtype_name(v.datatype));
    jsv::set_f64(&o, "sclSlope", f64::from(v.scl_slope));
    jsv::set_f64(&o, "sclInter", f64::from(v.scl_inter));
    jsv::set_bool(&o, "isLabel", v.is_label);
    jsv::set_f64(&o, "intentCode", f64::from(v.intent_code));
    if let Some(u) = units_name(v.xyz_units.space) {
        jsv::set_str(&o, "units", u);
    }
    jsv::set(&o, "stats", &jsv::stats(&v.stats(0)).into());
    jsv::set_str(&o, "headerJson", &v.header_json);
    jsv::set(&o, "gpu", &gpu_info(gpu).into());
    if let Some(t) = lut {
        jsv::set(&o, "labelTable", &jsv::label_entries(t).into());
    }
    o.into()
}

/// `load_volume`'s body (§6.4). `read_nifti` reports `Read`/`Inflate`/`Parse`/`Index` itself, so
/// nothing here double-reports; the input `Vec<u8>` is dropped inside `read_nifti` before it
/// returns (§5 rule 5).
pub fn load(
    bytes: Vec<u8>,
    lut_bytes: Option<Vec<u8>>,
    caps: GpuCaps,
    want_linear: bool,
    p: &mut dyn tvx_core::ProgressSink,
) -> Result<JsValue> {
    // §4.6 / §5 rule 3: the digest is taken here, in the worker, over the bytes the loader was
    // handed — `read_nifti` takes ownership of the `Vec` and frees it before it returns (§5 rule 5),
    // and the UI thread never sees a byte of it, so there is nowhere else it could be taken.
    let fingerprint = tvx_core::fingerprint(&bytes);
    let vol = tvx_nifti::read_nifti(bytes, p)?;
    let lut = match &lut_bytes {
        Some(b) => Some(crate::lut::parse(&String::from_utf8_lossy(b))?),
        None => None,
    };
    let gpu = vol.gpu_payload(0, &caps, want_linear)?;
    let index = if vol.is_label {
        Some(vol.label_index(0)?)
    } else {
        None
    };

    let out = jsv::obj();
    jsv::set(&out, "data", &raw_samples(&vol.data).into());
    jsv::set(&out, "gpuBytes", &jsv::u8s(&gpu.bytes).buffer().into());
    if let Some(ix) = &index {
        jsv::set(&out, "labelIds", &jsv::u32s(&ix.ids).into());
        jsv::set(&out, "denseIndexOf", &jsv::u32s(&ix.dense_of).into());
    }

    // The handle is allocated last: nothing is registered unless the whole load succeeded.
    let handle = handles::insert(handles::Dataset::Volume(Box::new(vol)));
    let m = handles::with_volume(handle, |v| {
        Ok(meta(handle, v, &gpu, lut.as_ref(), &fingerprint))
    })?;
    jsv::set(&out, "meta", &m);
    Ok(out.into())
}

/// `volume_frame` (§6.4) — §6.5.1 `VolumeFrameT`, everything that is per-4D-index.
pub fn frame(handle: u32, vol_index: usize, caps: GpuCaps, want_linear: bool) -> Result<JsValue> {
    handles::with_volume(handle, |v| {
        if vol_index >= v.nvols {
            return Err(tvx_core::Error::Parse(format!(
                "volume index {vol_index} of {} volumes",
                v.nvols
            )));
        }
        let gpu = v.gpu_payload(vol_index, &caps, want_linear)?;
        let out = jsv::obj();
        jsv::set_usize(&out, "volumeIndex", vol_index);
        jsv::set(&out, "gpuBytes", &jsv::u8s(&gpu.bytes).buffer().into());
        jsv::set(&out, "gpu", &gpu_info(&gpu).into());
        jsv::set(&out, "stats", &jsv::stats(&v.stats(vol_index)).into());
        if v.is_label {
            let ix = v.label_index(vol_index)?;
            jsv::set(&out, "labelIds", &jsv::u32s(&ix.ids).into());
            jsv::set(&out, "denseIndexOf", &jsv::u32s(&ix.dense_of).into());
        }
        Ok(out.into())
    })
}

/// `volume_label_centroids` (§6.4) → `{ centroids: [{ id, centroid, count }] }`.
pub fn label_centroids(handle: u32, vol_index: usize) -> Result<JsValue> {
    handles::with_volume(handle, |v| {
        let cs = crate::geom::label_centroids(v, vol_index)?;
        let arr = js_sys::Array::new();
        for c in &cs {
            let o = jsv::obj();
            jsv::set_u32(&o, "id", c.id);
            jsv::set(&o, "centroid", &jsv::vec3(c.centroid).into());
            jsv::set_f64(&o, "count", c.count as f64);
            arr.push(&o);
        }
        let out = jsv::obj();
        jsv::set(&out, "centroids", &arr.into());
        Ok(out.into())
    })
}

/// `volume_marching_cubes` (§6.4) → a §6.5.1 `SurfacePayload`.
pub fn marching_cubes(
    handle: u32,
    vol_index: usize,
    iso: f32,
    smooth: bool,
    p: &mut dyn tvx_core::ProgressSink,
) -> Result<JsValue> {
    handles::with_volume(handle, |v| {
        let s = crate::geom::marching_cubes(v, vol_index, iso, smooth, p)?;
        Ok(crate::surface::to_js(&s))
    })
}

/// `volume_marching_cubes_label` (§6.4) → a §6.5.1 `SurfacePayload`.
///
/// One **region** of a label volume, isolated at the sample (`tvx_geom::marching_cubes_label`) —
/// not a level set of the ids, which would be the union of every id above it.
pub fn marching_cubes_label(
    handle: u32,
    vol_index: usize,
    label: f32,
    smooth: bool,
    p: &mut dyn tvx_core::ProgressSink,
) -> Result<JsValue> {
    handles::with_volume(handle, |v| {
        let s = crate::geom::marching_cubes_label(v, vol_index, label, smooth, p)?;
        Ok(crate::surface::to_js(&s))
    })
}
