//! `tvx-wasm` — the worker-side wasm-bindgen surface.
//!
//! This crate is [`docs/ARCHITECTURE.md` §6.4](../../../docs/ARCHITECTURE.md) verbatim; every export is
//! **frozen** (§12.3) and maps one-to-one onto a §6.5.2 op. Phase 0 ships signatures only.
//!
//! **No export takes an abort argument.** Cancellation is `worker.terminate()` (§1, §5 rule 6);
//! `on_progress` is present wherever an op can exceed one frame, and the `js_sys::Function` is called at
//! section boundaries (every ~1 M records).
//!
//! **Memory rules for results (never violated, §6.4):**
//!
//! > Bulk results are returned either as `Vec<T>` — wasm-bindgen already `.slice()`s into a fresh
//! > transferable ArrayBuffer, so the worker transfers `result.buffer` **as-is**, with no second copy —
//! > or, for hot-path recycled buffers, by passing `js_sys::*Array`s the worker owns and writing with
//! > `copy_from` (one memcpy, no wasm-side output allocation). **Never** hand a `js_sys::*Array::view()`
//! > onto `wasm.memory.buffer` across a call boundary: `memory.grow` detaches every outstanding view.
//! > Never use `&mut [MaybeUninit<T>]` for outputs — two copies.
//!
//! Op → export, exhaustive (§6.5.2):
//! `loadVolume`→[`load_volume`] · `loadMesh`→[`load_mesh`] · `volumeFrame`→[`volume_frame`] ·
//! `surface`→[`mesh_surface`] · `boundary`→[`mesh_boundary`] · `buildTopology`→[`mesh_build_topology`] ·
//! `cut`→[`mesh_cut`] · `isolate`→[`mesh_isolate`] · `field`→[`mesh_field`] ·
//! `elmToNode`→[`mesh_convert_field`] · `locate`→[`mesh_locate`] ·
//! `marchingCubes`→[`volume_marching_cubes`] · `marchingTets`→[`mesh_marching_tets`] ·
//! `contours`→[`mesh_contours`] · `labelCentroids`→[`volume_label_centroids`] · `free`→[`free`] ·
//! `freeMask`→[`free_mask`]. [`wasm_heap_bytes`] is the only export without an op; it is read after every
//! call and stamped onto `Res`.

#![forbid(unsafe_code)]
// The §6.4 signatures are flattened deliberately — `GpuCaps` travels in the op args as scalars so the
// wasm-bindgen surface carries no shared type.
#![allow(clippy::too_many_arguments)]

use wasm_bindgen::prelude::*;

/// `load_volume` and `volume_frame` take [`tvx_nifti::GpuCaps`] flattened into scalars rather than a
/// struct: the caps come from `probeCapabilities()` on the UI thread and travel in the op args (§6.5.2),
/// and flattening keeps the wasm-bindgen surface free of a shared type.
///
/// `load_volume` produces volume 0's payload; [`volume_frame`] produces any other index's. Both run
/// §6.1's `stats` / `label_index` / `gpu_payload` for that index.
///
/// Resolves to the `loadVolume` op result: `{ meta, data, gpuBytes, labelIds?, denseIndexOf? }` (§6.5.2).
#[wasm_bindgen]
pub fn load_volume(
    bytes: Vec<u8>,
    lut_bytes: Option<Vec<u8>>,
    float_linear: bool,
    norm16: bool,
    max_3d: u32,
    want_linear: bool,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (
        bytes,
        lut_bytes,
        float_linear,
        norm16,
        max_3d,
        want_linear,
        on_progress,
    );
    unimplemented!("phase 1")
}

/// `format` is `'auto'|'msh'|'gii'|'fs'|'stl'|'ply'|'obj'`; `auto` dispatches through
/// [`tvx_mesh_io::sniff`]. Morton reorder, [`tvx_geom::build_tet_blocks`] and
/// [`tvx_geom::build_point_locator`] are built here. Result is `{ meta: MeshMeta }` — no bulk arrays.
#[wasm_bindgen]
pub fn load_mesh(
    bytes: Vec<u8>,
    format: &str,
    opt_bytes: Option<Vec<u8>>,
    lut_bytes: Option<Vec<u8>>,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (bytes, format, opt_bytes, lut_bytes, on_progress);
    unimplemented!("phase 1")
}

/// The **only** way to display a 4D index ≠ 0 (§6.5.2). Returns `VolumeFrameT`.
#[wasm_bindgen]
pub fn volume_frame(
    handle: u32,
    vol_index: u32,
    float_linear: bool,
    norm16: bool,
    max_3d: u32,
    want_linear: bool,
) -> Result<JsValue, JsValue> {
    let _ = (handle, vol_index, float_linear, norm16, max_3d, want_linear);
    unimplemented!("phase 1")
}

/// [`tvx_geom::tag_surfaces`] when the mesh has tris, else [`tvx_geom::extract_boundary`].
/// `variant` is `'indexed' | 'deindexed'`.
#[wasm_bindgen]
pub fn mesh_surface(
    handle: u32,
    mask_id: Option<u32>,
    variant: &str,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (handle, mask_id, variant, on_progress);
    unimplemented!("phase 1")
}

/// Always [`tvx_geom::extract_boundary`]; used after isolation/clip.
#[wasm_bindgen]
pub fn mesh_boundary(
    handle: u32,
    mask_id: Option<u32>,
    variant: &str,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (handle, mask_id, variant, on_progress);
    unimplemented!("phase 1")
}

/// Explicit, awaitable, progress-reporting. Returns `{ faces, boundaryFaces }`.
#[wasm_bindgen]
pub fn mesh_build_topology(
    handle: u32,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (handle, on_progress);
    unimplemented!("phase 1")
}

/// `planes` is 4 f32 per plane (`normal.xyz`, `offset`), ≤ 6 planes.
///
/// Two paths, normatively (§6.4):
/// * `out: None` — **buffers path**. Returns `{ mode: 'buffers', cuts: CutPayload[] }`, one entry per
///   plane, every array a freshly allocated transferable. The correctness reference, and the only path a
///   golden test uses.
/// * `out: Some(pool)` — **recycled path**. `copy_from`s every plane's data into the caller-owned arrays
///   back to back, fills `plane_offsets`, and returns `{ mode: 'recycled', truncated: false, counts }`.
///   If any array is too small, **nothing is written** and `truncated: true` comes back with the
///   *required* capacities; the worker grows the pool (doubling) and re-calls. A partially-filled pool is
///   never returned.
#[wasm_bindgen]
pub fn mesh_cut(
    handle: u32,
    planes: &[f32],
    mask_id: Option<u32>,
    out: Option<CutOut>,
) -> Result<JsValue, JsValue> {
    let _ = (handle, planes, mask_id, out);
    unimplemented!("phase 1")
}

/// `criteria_json` is `JSON.stringify(IsolateCriteriaT)`, deserialised into
/// [`tvx_geom::IsolateCriteria`]. `label_volume` is required iff `criteria.labelVolume` is set and is
/// **cloned, not transferred** (§5 rule 2) — it is the only bulk argument any op takes.
/// Returns `{ maskId, visibleTets, generation }`.
#[wasm_bindgen]
pub fn mesh_isolate(
    handle: u32,
    criteria_json: &str,
    label_volume: Option<Vec<u8>>,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (handle, criteria_json, label_volume, on_progress);
    unimplemented!("phase 1")
}

/// `source` is `'node' | 'elm'`, `component` is `'mag' | '0' | '1' | '2'`.
/// Returns `{ values, stats, n, partial }`.
#[wasm_bindgen]
pub fn mesh_field(
    handle: u32,
    source: &str,
    name: &str,
    component: &str,
) -> Result<JsValue, JsValue> {
    let _ = (handle, source, name, component);
    unimplemented!("phase 1")
}

/// Both directions of §6.3's pair: `direction` is `'elmToNode' | 'nodeToElm'`.
#[wasm_bindgen]
pub fn mesh_convert_field(
    handle: u32,
    direction: &str,
    source_name: &str,
) -> Result<JsValue, JsValue> {
    let _ = (handle, direction, source_name);
    unimplemented!("phase 1")
}

/// One round trip: [`tvx_geom::locate_point`] returns the whole `ProbeHit`. `elementId` in the result is
/// always a Gmsh element number (§6.2).
#[wasm_bindgen]
pub fn mesh_locate(handle: u32, x: f32, y: f32, z: f32) -> Result<JsValue, JsValue> {
    let _ = (handle, x, y, z);
    unimplemented!("phase 1")
}

#[wasm_bindgen]
pub fn volume_marching_cubes(
    handle: u32,
    vol_index: u32,
    iso: f32,
    smooth: bool,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (handle, vol_index, iso, smooth, on_progress);
    unimplemented!("phase 1")
}

#[wasm_bindgen]
pub fn mesh_marching_tets(
    handle: u32,
    source: &str,
    name: &str,
    component: &str,
    iso: f32,
    mask_id: Option<u32>,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let _ = (handle, source, name, component, iso, mask_id, on_progress);
    unimplemented!("phase 1")
}

/// `plane` is 4 f32 (`normal.xyz`, `offset`). Returns `{ segments }`, 6 floats per segment.
#[wasm_bindgen]
pub fn mesh_contours(handle: u32, plane: &[f32], mask_id: Option<u32>) -> Result<JsValue, JsValue> {
    let _ = (handle, plane, mask_id);
    unimplemented!("phase 1")
}

#[wasm_bindgen]
pub fn volume_label_centroids(handle: u32, vol_index: u32) -> Result<JsValue, JsValue> {
    let _ = (handle, vol_index);
    unimplemented!("phase 1")
}

/// Drop the dataset behind `handle` and every mask attached to it. The client then calls
/// `worker.terminate()` — that is the only way to give wasm linear memory back (§5 rule 1).
#[wasm_bindgen]
pub fn free(handle: u32) {
    let _ = handle;
    unimplemented!("phase 1")
}

#[wasm_bindgen]
pub fn free_mask(handle: u32, mask_id: u32) {
    let _ = (handle, mask_id);
    unimplemented!("phase 1")
}

/// Stamped onto every `Res` (§6.5) and read by the §9 memory bar and `scripts/bench.ts`.
/// The only export without an op.
#[wasm_bindgen]
pub fn wasm_heap_bytes() -> u32 {
    unimplemented!("phase 1")
}

/// Recycled cut arena (§6.4). ONE instance covers ALL planes of a [`mesh_cut`] call: each array is packed
/// plane-major, and `plane_offsets` (4 u32 per plane, plus one terminating quad) gives, per plane, the
/// start offsets into (vertices, triangles, edge segments, boundary segments).
///
/// A JS constructor is mandatory — the worker allocates and owns these arrays; wasm only `copy_from`s
/// into them.
#[wasm_bindgen]
pub struct CutOut {
    /// 3 per vertex.
    #[wasm_bindgen(getter_with_clone)]
    pub positions: js_sys::Float32Array,
    /// 2 per vertex.
    #[wasm_bindgen(getter_with_clone)]
    pub interp_n: js_sys::Uint32Array,
    /// 1 per vertex.
    #[wasm_bindgen(getter_with_clone)]
    pub interp_t: js_sys::Float32Array,
    /// 1 per triangle.
    #[wasm_bindgen(getter_with_clone)]
    pub owner_tet: js_sys::Uint32Array,
    /// 1 per triangle.
    #[wasm_bindgen(getter_with_clone)]
    pub tag: js_sys::Int32Array,
    /// 1 per triangle.
    #[wasm_bindgen(getter_with_clone)]
    pub edge_mask: js_sys::Uint8Array,
    /// 6 per segment.
    #[wasm_bindgen(getter_with_clone)]
    pub edge_segments: js_sys::Float32Array,
    /// 6 per segment.
    #[wasm_bindgen(getter_with_clone)]
    pub boundary_segments: js_sys::Float32Array,
    /// `4 * (nplanes + 1)`.
    #[wasm_bindgen(getter_with_clone)]
    pub plane_offsets: js_sys::Uint32Array,
}

#[wasm_bindgen]
impl CutOut {
    #[wasm_bindgen(constructor)]
    pub fn new(
        positions: js_sys::Float32Array,
        interp_n: js_sys::Uint32Array,
        interp_t: js_sys::Float32Array,
        owner_tet: js_sys::Uint32Array,
        tag: js_sys::Int32Array,
        edge_mask: js_sys::Uint8Array,
        edge_segments: js_sys::Float32Array,
        boundary_segments: js_sys::Float32Array,
        plane_offsets: js_sys::Uint32Array,
    ) -> CutOut {
        CutOut {
            positions,
            interp_n,
            interp_t,
            owner_tet,
            tag,
            edge_mask,
            edge_segments,
            boundary_segments,
            plane_offsets,
        }
    }
}
