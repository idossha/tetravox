//! `tvx-wasm` — the worker-side wasm-bindgen surface.
//!
//! This crate is [`docs/ARCHITECTURE.md` §6.4](../../../docs/ARCHITECTURE.md) verbatim; every export is
//! **frozen** (§12.3) and maps one-to-one onto a §6.5.2 op. Every body below is a thin adapter: it
//! validates its string/scalar arguments, calls the crate that owns the work, and shapes the result
//! into the §6.5.1 payload. The handle table, the sidecar LUT parse and the §6.2 tag ladder are the
//! only state this crate owns — see [`handles`], [`lut`] and [`mesh`].
//!
//! **No export takes an abort argument.** Cancellation is `worker.terminate()` (§1, §5 rule 6);
//! `on_progress` is present wherever an op can exceed one frame, and the `js_sys::Function` is called at
//! section boundaries (every ~1 M records).
//!
//! **Errors.** A failure comes back as a rejected `JsValue` shaped `{ code, message }`, with `code`
//! drawn from §6.5's `ErrorCode` union ([`err`]). A Rust `panic!` is *not* one of those: it traps the
//! module, the worker sees a `WebAssembly.RuntimeError`, and the client tears the worker down and
//! marks the dataset failed (§5 rule 8).
//!
//! **`tvx-geom` is not built in by default.** Every §6.3 call site lives in [`geom`] behind the
//! `geom` cargo feature, because `tvx-geom` is still the Phase-0 `unimplemented!()` stub and calling
//! one from wasm traps the module rather than returning an error. With the feature off the geometry
//! ops answer `{ code: 'unsupported' }` and everything else — both loaders, `volumeFrame`, `field`,
//! `free`, `freeMask`, `wasm_heap_bytes` — works normally. The integrator turns it on in the commit
//! that lands a real `tvx-geom` (`docs/DECISIONS.md`).
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
//! Every bulk array here crosses as `js_sys::*Array::from(&slice)`, which allocates a fresh JS typed
//! array and memcpys into it — an owned buffer, never a view.
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

pub mod err;
pub mod geom;
pub mod handles;
pub mod jsv;
pub mod lut;
pub mod mesh;
pub mod progress;
pub mod stats;
pub mod surface;
pub mod volume;

use progress::JsProgress;
use tvx_nifti::GpuCaps;
use wasm_bindgen::prelude::*;

fn caps_of(float_linear: bool, norm16: bool, max_3d: u32) -> GpuCaps {
    GpuCaps {
        float_linear,
        norm16,
        max_3d,
    }
}

/// `load_volume` and `volume_frame` take [`tvx_nifti::GpuCaps`] flattened into scalars rather than a
/// struct: the caps come from `probeCapabilities()` on the UI thread and travel in the op args (§6.5.2),
/// and flattening keeps the wasm-bindgen surface free of a shared type.
///
/// `load_volume` produces volume 0's payload; [`volume_frame`] produces any other index's. Both run
/// §6.1's `stats` / `label_index` / `gpu_payload` for that index.
///
/// Resolves to the `loadVolume` op result: `{ meta, data, gpuBytes, labelIds?, denseIndexOf? }` (§6.5.2).
/// `meta.name` comes back empty — the worker owns the `LoadSource` and fills it in.
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
    let mut p = JsProgress::new(on_progress);
    volume::load(
        bytes,
        lut_bytes,
        caps_of(float_linear, norm16, max_3d),
        want_linear,
        &mut p,
    )
    .map_err(err::map)
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
    let mut p = JsProgress::new(on_progress);
    mesh::load(bytes, format, opt_bytes, lut_bytes, &mut p).map_err(err::map)
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
    volume::frame(
        handle,
        vol_index as usize,
        caps_of(float_linear, norm16, max_3d),
        want_linear,
    )
    .map_err(err::map)
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
    let mut p = JsProgress::new(on_progress);
    mesh::surface_op(handle, mask_id, variant, &mut p).map_err(err::map)
}

/// Always [`tvx_geom::extract_boundary`]; used after isolation/clip.
#[wasm_bindgen]
pub fn mesh_boundary(
    handle: u32,
    mask_id: Option<u32>,
    variant: &str,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let mut p = JsProgress::new(on_progress);
    mesh::boundary_op(handle, mask_id, variant, &mut p).map_err(err::map)
}

/// Explicit, awaitable, progress-reporting. Returns `{ faces, boundaryFaces }`.
#[wasm_bindgen]
pub fn mesh_build_topology(
    handle: u32,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let mut p = JsProgress::new(on_progress);
    mesh::build_topology(handle, &mut p).map_err(err::map)
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
    mesh::cut(handle, planes, mask_id, out).map_err(err::map)
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
    let mut p = JsProgress::new(on_progress);
    mesh::isolate(handle, criteria_json, label_volume, &mut p).map_err(err::map)
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
    mesh::field(handle, source, name, component).map_err(err::map)
}

/// Both directions of §6.3's pair: `direction` is `'elmToNode' | 'nodeToElm'`.
#[wasm_bindgen]
pub fn mesh_convert_field(
    handle: u32,
    direction: &str,
    source_name: &str,
) -> Result<JsValue, JsValue> {
    mesh::convert_field(handle, direction, source_name).map_err(err::map)
}

/// One round trip: [`tvx_geom::locate_point`] returns the whole `ProbeHit`. `elementId` in the result is
/// always a Gmsh element number (§6.2).
#[wasm_bindgen]
pub fn mesh_locate(handle: u32, x: f32, y: f32, z: f32) -> Result<JsValue, JsValue> {
    mesh::locate(handle, x, y, z).map_err(err::map)
}

#[wasm_bindgen]
pub fn volume_marching_cubes(
    handle: u32,
    vol_index: u32,
    iso: f32,
    smooth: bool,
    on_progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let mut p = JsProgress::new(on_progress);
    volume::marching_cubes(handle, vol_index as usize, iso, smooth, &mut p).map_err(err::map)
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
    let mut p = JsProgress::new(on_progress);
    mesh::marching_tets(handle, source, name, component, iso, mask_id, &mut p).map_err(err::map)
}

/// `plane` is 4 f32 (`normal.xyz`, `offset`). Returns `{ segments }`, 6 floats per segment.
#[wasm_bindgen]
pub fn mesh_contours(handle: u32, plane: &[f32], mask_id: Option<u32>) -> Result<JsValue, JsValue> {
    mesh::contours(handle, plane, mask_id).map_err(err::map)
}

#[wasm_bindgen]
pub fn volume_label_centroids(handle: u32, vol_index: u32) -> Result<JsValue, JsValue> {
    volume::label_centroids(handle, vol_index as usize).map_err(err::map)
}

/// Drop the dataset behind `handle` and every mask attached to it. The client then calls
/// `worker.terminate()` — that is the only way to give wasm linear memory back (§5 rule 1).
#[wasm_bindgen]
pub fn free(handle: u32) {
    handles::free(handle);
}

#[wasm_bindgen]
pub fn free_mask(handle: u32, mask_id: u32) {
    handles::free_mask(handle, mask_id);
}

/// Stamped onto every `Res` (§6.5) and read by the §9 memory bar and `scripts/bench.ts`.
#[wasm_bindgen]
pub fn wasm_heap_bytes() -> u32 {
    handles::heap_bytes()
}

/// Phase-0 liveness: the crate version, so the shell can prove it instantiated *this* module.
///
/// No op maps to it (§6.4). It exists because ROADMAP Phase-0 gate 2 demands a packaged artefact whose
/// triangle colour came from a real WASM call, and every other export was an `unimplemented!()` stub
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
///
/// **wasm-bindgen consumes a `CutOut` passed by value**, so the pool the worker keeps is the nine typed
/// arrays, not this wrapper: it builds a fresh `new CutOut(…)` over the same arrays for each call, which
/// costs nothing — the wrapper only holds references to them.
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
