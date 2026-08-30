/* tslint:disable */
/* eslint-disable */

/**
 * Recycled cut arena (§6.4). ONE instance covers ALL planes of a [`mesh_cut`] call: each array is packed
 * plane-major, and `plane_offsets` (4 u32 per plane, plus one terminating quad) gives, per plane, the
 * start offsets into (vertices, triangles, edge segments, boundary segments).
 *
 * A JS constructor is mandatory — the worker allocates and owns these arrays; wasm only `copy_from`s
 * into them.
 *
 * **wasm-bindgen consumes a `CutOut` passed by value**, so the pool the worker keeps is the nine typed
 * arrays, not this wrapper: it builds a fresh `new CutOut(…)` over the same arrays for each call, which
 * costs nothing — the wrapper only holds references to them.
 */
export class CutOut {
    free(): void;
    [Symbol.dispose](): void;
    constructor(positions: Float32Array, interp_n: Uint32Array, interp_t: Float32Array, owner_tet: Uint32Array, tag: Int32Array, edge_mask: Uint8Array, edge_segments: Float32Array, boundary_segments: Float32Array, plane_offsets: Uint32Array);
    /**
     * 6 per segment.
     */
    boundary_segments: Float32Array;
    /**
     * 1 per triangle.
     */
    edge_mask: Uint8Array;
    /**
     * 6 per segment.
     */
    edge_segments: Float32Array;
    /**
     * 2 per vertex.
     */
    interp_n: Uint32Array;
    /**
     * 1 per vertex.
     */
    interp_t: Float32Array;
    /**
     * 1 per triangle.
     */
    owner_tet: Uint32Array;
    /**
     * `4 * (nplanes + 1)`.
     */
    plane_offsets: Uint32Array;
    /**
     * 3 per vertex.
     */
    positions: Float32Array;
    /**
     * 1 per triangle.
     */
    tag: Int32Array;
}

/**
 * Drop the dataset behind `handle` and every mask attached to it. The client then calls
 * `worker.terminate()` — that is the only way to give wasm linear memory back (§5 rule 1).
 */
export function free(handle: number): void;

export function free_mask(handle: number, mask_id: number): void;

/**
 * `format` is `'auto'|'msh'|'gii'|'fs'|'stl'|'ply'|'obj'`; `auto` dispatches through
 * [`tvx_mesh_io::sniff`]. Morton reorder, [`tvx_geom::build_tet_blocks`] and
 * [`tvx_geom::build_point_locator`] are built here. Result is `{ meta: MeshMeta }` — no bulk arrays.
 */
export function load_mesh(bytes: Uint8Array, format: string, opt_bytes: Uint8Array | null | undefined, lut_bytes: Uint8Array | null | undefined, on_progress: Function): any;

/**
 * `load_volume` and `volume_frame` take [`tvx_nifti::GpuCaps`] flattened into scalars rather than a
 * struct: the caps come from `probeCapabilities()` on the UI thread and travel in the op args (§6.5.2),
 * and flattening keeps the wasm-bindgen surface free of a shared type.
 *
 * `load_volume` produces volume 0's payload; [`volume_frame`] produces any other index's. Both run
 * §6.1's `stats` / `label_index` / `gpu_payload` for that index.
 *
 * The bytes may be NIfTI-1/2, FreeSurfer MGH/MGZ, NRRD (attached header) or MetaImage (`.mha`);
 * the format is sniffed by content (`tvx_nifti::read_volume`), never by a name the worker would
 * have to pass — the signature is frozen (§6.4).
 *
 * Resolves to the `loadVolume` op result: `{ meta, data, gpuBytes, labelIds?, denseIndexOf? }` (§6.5.2).
 * `meta.name` comes back empty — the worker owns the `LoadSource` and fills it in.
 */
export function load_volume(bytes: Uint8Array, lut_bytes: Uint8Array | null | undefined, float_linear: boolean, norm16: boolean, max_3d: number, want_linear: boolean, on_progress: Function): any;

/**
 * Always [`tvx_geom::extract_boundary`]; used after isolation/clip.
 */
export function mesh_boundary(handle: number, mask_id: number | null | undefined, variant: string, on_progress: Function): any;

/**
 * Explicit, awaitable, progress-reporting. Returns `{ faces, boundaryFaces }`.
 */
export function mesh_build_topology(handle: number, on_progress: Function): any;

/**
 * Glyph origins for a **volumetric** `GlyphSpec` (§7.4): one centroid per surviving tet, in Morton
 * order, with the Gmsh element number that keys the field texture. `stride` keeps every `stride`-th
 * tet that survives `mask_id` and `tags` — filtering first, so a small tag still gets glyphs — and
 * `stride = 0` is `Error::Parse`. `tags` is `None` for "every tag". Returns
 * `{ positions, ownerTet }`; no triangles, no normals.
 */
export function mesh_centroids(handle: number, mask_id: number | null | undefined, stride: number, tags?: Int32Array | null): any;

/**
 * `plane` is 4 f32 (`normal.xyz`, `offset`). Returns `{ segments }`, 6 floats per segment.
 */
export function mesh_contours(handle: number, plane: Float32Array, mask_id?: number | null): any;

/**
 * Both directions of §6.3's pair: `direction` is `'elmToNode' | 'nodeToElm'`.
 */
export function mesh_convert_field(handle: number, direction: string, source_name: string): any;

/**
 * `planes` is 4 f32 per plane (`normal.xyz`, `offset`), ≤ 6 planes.
 *
 * Two paths, normatively (§6.4):
 * * `out: None` — **buffers path**. Returns `{ mode: 'buffers', cuts: CutPayload[] }`, one entry per
 *   plane, every array a freshly allocated transferable. The correctness reference, and the only path a
 *   golden test uses.
 * * `out: Some(pool)` — **recycled path**. `copy_from`s every plane's data into the caller-owned arrays
 *   back to back, fills `plane_offsets`, and returns `{ mode: 'recycled', truncated: false, counts }`.
 *   If any array is too small, **nothing is written** and `truncated: true` comes back with the
 *   *required* capacities; the worker grows the pool (doubling) and re-calls. A partially-filled pool is
 *   never returned.
 */
export function mesh_cut(handle: number, planes: Float32Array, mask_id?: number | null, out?: CutOut | null): any;

/**
 * `source` is `'node' | 'elm'`, `component` is `'mag' | '0' | '1' | '2'`.
 * Returns `{ values, stats, n, partial }`.
 *
 * **Ordering is part of the contract** (§6.5.2). `node` values are indexed by the internal node
 * index — what `SurfacePayload.nodeIndex` and `CutPayload.interpNodes` carry. `elm` values are
 * `[tris…, tets…]` in the **file's element order**, with the tet block un-permuted out of §6.3's
 * Morton order, so row `i` is the file's `i`-th element and `MeshMeta.identityElementNumbers`
 * says whether its Gmsh number is `i + 1`.
 */
export function mesh_field(handle: number, source: string, name: string, component: string): any;

/**
 * `criteria_json` is `JSON.stringify(IsolateCriteriaT)`, deserialised into
 * [`tvx_geom::IsolateCriteria`]. `label_volume` is required iff `criteria.labelVolume` is set and is
 * **cloned, not transferred** (§5 rule 2) — it is the only bulk argument any op takes.
 * Returns `{ maskId, visibleTets, generation }`.
 */
export function mesh_isolate(handle: number, criteria_json: string, label_volume: Uint8Array | null | undefined, on_progress: Function): any;

/**
 * One round trip: [`tvx_geom::locate_point`] returns the whole `ProbeHit`. `elementId` in the result is
 * always a Gmsh element number (§6.2).
 */
export function mesh_locate(handle: number, x: number, y: number, z: number): any;

export function mesh_marching_tets(handle: number, source: string, name: string, component: string, iso: number, mask_id: number | null | undefined, on_progress: Function): any;

/**
 * The mesh node nearest a world point (directed task 8e): `{ vertex, coord }`, or
 * `{ vertex: null }` for a mesh with no nodes. `vertex` is the **internal 0-based node index** —
 * the row in `Mesh::nodes`, the same numbering `SurfaceBuffers::node_index` uses and the one a
 * FreeSurfer/GIfTI surface's vertex ids are — not a Gmsh node number.
 */
export function mesh_nearest_vertex(handle: number, x: number, y: number, z: number): any;

/**
 * [`tvx_geom::tag_surfaces`] when the mesh has tris, else [`tvx_geom::extract_boundary`].
 * `variant` is `'indexed' | 'deindexed'`.
 */
export function mesh_surface(handle: number, mask_id: number | null | undefined, variant: string, on_progress: Function): any;

/**
 * Node coordinates by index: `{ positions }`, 3 f32 per requested index, world mm with the file's
 * transform already applied (§3). `indices = undefined` returns **every** node in file order.
 */
export function mesh_vertices(handle: number, indices?: Uint32Array | null): any;

/**
 * Subject `sphere.reg` vertex -> nearest fsaverage `sphere` vertex, on the **unit sphere**
 * (directed task 8e). `handle` is the subject's registered sphere; `target` is the fsaverage
 * sphere's coordinates as flat xyz triples, obtained with `mesh_vertices` from the worker that
 * owns that file — §5 rule 1 gives one worker one dataset, so this cannot take two handles.
 * Returns `{ map }`, one `u32` per subject node. Both sides are normalised before the search:
 * fsaverage's sphere has a 0.0157 radius spread, which swamps the ~0.003 chord between true
 * neighbours, so the un-normalised nearest neighbour is a different vertex almost every time
 * `[DATA]`.
 */
export function surface_sphere_map(handle: number, target: Float32Array): any;

/**
 * Phase-0 liveness: a pure 32-bit avalanche of `x` (the murmur3 finalizer with a
 * `0x9E37_79B9` pre-whitening), so a caller can predict the answer analytically instead of
 * comparing against a previous run (§11 rule 0).
 *
 * Reference: `tvx_ping(0x54565830) == 0x58E5_D634`; the Phase-0 e2e recomputes it in JS with
 * `Math.imul` and asserts the triangle's pixel bytes against `(h >> 16, h >> 8, h) & 0xff`.
 */
export function tvx_ping(x: number): number;

/**
 * Phase-0 liveness: fold [`tvx_ping`] over `bytes`, so "a module Worker under that origin fetches a
 * file and hands the bytes to WASM" (ROADMAP Phase-0 gate 3) is a real wasm call over the real bytes
 * and not a byte count computed in JS. `Vec<u8>` is wasm-bindgen's copy-in, matching §5 rule 5.
 */
export function tvx_ping_bytes(bytes: Uint8Array): number;

/**
 * Phase-0 liveness: the crate version, so the shell can prove it instantiated *this* module.
 *
 * No op maps to it (§6.4). It exists because ROADMAP Phase-0 gate 2 demands a packaged artefact whose
 * triangle colour came from a real WASM call, and every other export was an `unimplemented!()` stub
 * until Phase 1.
 */
export function tvx_version(): string;

/**
 * The **only** way to display a 4D index ≠ 0 (§6.5.2). Returns `VolumeFrameT`.
 */
export function volume_frame(handle: number, vol_index: number, float_linear: boolean, norm16: boolean, max_3d: number, want_linear: boolean): any;

export function volume_label_centroids(handle: number, vol_index: number): any;

export function volume_marching_cubes(handle: number, vol_index: number, iso: number, smooth: boolean, on_progress: Function): any;

/**
 * One region of a label volume, isolated at the sample (§6.4, added 2026-08-28 for §4.4's `iso3d`).
 */
export function volume_marching_cubes_label(handle: number, vol_index: number, label: number, smooth: boolean, on_progress: Function): any;

/**
 * Stamped onto every `Res` (§6.5) and read by the §9 memory bar and `scripts/bench.ts`.
 */
export function wasm_heap_bytes(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_cutout_free: (a: number, b: number) => void;
    readonly __wbg_get_cutout_boundary_segments: (a: number) => any;
    readonly __wbg_get_cutout_edge_mask: (a: number) => any;
    readonly __wbg_get_cutout_edge_segments: (a: number) => any;
    readonly __wbg_get_cutout_interp_n: (a: number) => any;
    readonly __wbg_get_cutout_interp_t: (a: number) => any;
    readonly __wbg_get_cutout_owner_tet: (a: number) => any;
    readonly __wbg_get_cutout_plane_offsets: (a: number) => any;
    readonly __wbg_get_cutout_positions: (a: number) => any;
    readonly __wbg_get_cutout_tag: (a: number) => any;
    readonly __wbg_set_cutout_boundary_segments: (a: number, b: any) => void;
    readonly __wbg_set_cutout_edge_mask: (a: number, b: any) => void;
    readonly __wbg_set_cutout_edge_segments: (a: number, b: any) => void;
    readonly __wbg_set_cutout_interp_n: (a: number, b: any) => void;
    readonly __wbg_set_cutout_interp_t: (a: number, b: any) => void;
    readonly __wbg_set_cutout_owner_tet: (a: number, b: any) => void;
    readonly __wbg_set_cutout_plane_offsets: (a: number, b: any) => void;
    readonly __wbg_set_cutout_positions: (a: number, b: any) => void;
    readonly __wbg_set_cutout_tag: (a: number, b: any) => void;
    readonly cutout_new: (a: any, b: any, c: any, d: any, e: any, f: any, g: any, h: any, i: any) => number;
    readonly load_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: any) => [number, number, number];
    readonly load_volume: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: any) => [number, number, number];
    readonly mesh_boundary: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly mesh_build_topology: (a: number, b: any) => [number, number, number];
    readonly mesh_centroids: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly mesh_contours: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mesh_convert_field: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly mesh_cut: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly mesh_field: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly mesh_isolate: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number];
    readonly mesh_locate: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mesh_marching_tets: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: any) => [number, number, number];
    readonly mesh_nearest_vertex: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly mesh_surface: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly mesh_vertices: (a: number, b: number, c: number) => [number, number, number];
    readonly surface_sphere_map: (a: number, b: number, c: number) => [number, number, number];
    readonly tvx_ping: (a: number) => number;
    readonly tvx_ping_bytes: (a: number, b: number) => number;
    readonly tvx_version: () => [number, number];
    readonly volume_frame: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly volume_label_centroids: (a: number, b: number) => [number, number, number];
    readonly volume_marching_cubes: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly volume_marching_cubes_label: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly wasm_heap_bytes: () => number;
    readonly free_mask: (a: number, b: number) => void;
    readonly free: (a: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
