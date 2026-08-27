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
//! `freeMask`→[`free_mask`]. [`wasm_heap_bytes`] is read after every call and stamped onto `Res`;
//! [`tvx_version`], [`tvx_ping`] and [`tvx_ping_bytes`] are the Phase-0 liveness set. Those four are
//! the only exports without an op.

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
#[wasm_bindgen]
pub fn wasm_heap_bytes() -> u32 {
    unimplemented!("phase 1")
}

/// Phase-0 liveness: the crate version, so the shell can prove it instantiated *this* module.
///
/// No op maps to it (§6.4). It exists because ROADMAP Phase-0 gate 2 demands a packaged artefact whose
/// triangle colour came from a real WASM call, and every other export is an `unimplemented!()` stub
/// until Phase 1.
#[wasm_bindgen]
pub fn tvx_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Phase-0 liveness: a pure 32-bit avalanche of `x` (the murmur3 finalizer with a
/// `0x9E37_79B9` pre-whitening), so a caller can predict the answer analytically instead of
/// comparing against a previous run (§11 rule 0).
///
/// Reference: `tvx_ping(0x54565830) == 0x58E5_D634`; the Phase-0 e2e recomputes it in JS with
/// `Math.imul` and asserts the triangle's pixel bytes against `(h >> 16, h >> 8, h) & 0xff`.
#[wasm_bindgen]
pub fn tvx_ping(x: u32) -> u32 {
    let mut h = x ^ 0x9E37_79B9;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^= h >> 16;
    h
}

/// Phase-0 liveness: fold [`tvx_ping`] over `bytes`, so "a module Worker under that origin fetches a
/// file and hands the bytes to WASM" (ROADMAP Phase-0 gate 3) is a real wasm call over the real bytes
/// and not a byte count computed in JS. `Vec<u8>` is wasm-bindgen's copy-in, matching §5 rule 5.
#[wasm_bindgen]
pub fn tvx_ping_bytes(bytes: Vec<u8>) -> u32 {
    bytes
        .iter()
        .fold(bytes.len() as u32, |h, &b| tvx_ping(h ^ u32::from(b)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the constant the Phase-0 e2e recomputes in JS. If this changes, the expected triangle
    /// colour changes with it.
    #[test]
    fn ping_avalanche_is_stable() {
        assert_eq!(tvx_ping(0x5456_5830), 0x58E5_D634);
        assert_eq!(tvx_ping(0), tvx_ping(0));
        assert_ne!(tvx_ping(0), tvx_ping(1));
    }

    /// The e2e recomputes this in JS over `resources/phase0-fixture.bin` (bytes 0..=255).
    #[test]
    fn ping_bytes_folds_over_the_phase0_fixture() {
        let fixture: Vec<u8> = (0..=255u8).collect();
        assert_eq!(tvx_ping_bytes(fixture), 0xFEC4_15B3);
        assert_eq!(tvx_ping_bytes(Vec::new()), 0);
    }

    #[test]
    fn version_is_the_crate_version() {
        assert_eq!(tvx_version(), env!("CARGO_PKG_VERSION"));
    }
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
