/**
 * `@tetravox/protocol` — the dataset-worker protocol.
 *
 * This file is `docs/ARCHITECTURE.md` §6.5 verbatim. **Zero imports; the only runtime code is the type
 * guards plus the two frozen lookup tables §6.5's preamble names — `OP_NAMES` and `OP_TO_EXPORT`, both
 * of which mirror a declaration already in §6.5/§6.5.2.** FROZEN at the end of Phase 0 (§12.3 item 1):
 * changing anything here requires editing `docs/ARCHITECTURE.md` in the same commit and appending a
 * line to `docs/DECISIONS.md`.
 *
 * Every op runs on its dataset's worker (§5 rule 1: worker-per-dataset, one wasm instance each).
 * `handle` is that worker's single dataset unless stated.
 */

// ---------------------------------------------------------------------------------------------
// §6.5 — envelope
// ---------------------------------------------------------------------------------------------

export type Phase = 'read' | 'inflate' | 'parse' | 'topology' | 'index' | 'upload';
export type ErrorCode = 'parse' | 'unsupported' | 'io' | 'oom' | 'cancelled' | 'panic';
export interface WorkerError {
  code: ErrorCode;
  message: string;
}

export type OpName =
  | 'loadVolume'
  | 'loadMesh'
  | 'volumeFrame'
  | 'surface'
  | 'boundary'
  | 'buildTopology'
  | 'cut'
  | 'isolate'
  | 'field'
  | 'elmToNode'
  | 'locate'
  | 'marchingCubes'
  | 'marchingTets'
  | 'contours'
  | 'labelCentroids'
  | 'meshCentroids'
  | 'free'
  | 'freeMask'; // 18 ops

export interface Req<K extends OpName = OpName> {
  id: number;
  /** Latest-wins key, e.g. `${layerId}:cut`. Opaque to the worker. */
  key: string;
  op: K;
  args: OpArgs[K];
}

export type Res<K extends OpName = OpName> =
  | { id: number; op: K; ok: true; result: OpResult[K]; transfer: ArrayBuffer[]; heapBytes: number }
  | { id: number; op: K; ok: false; error: WorkerError };

export interface Progress {
  kind: 'progress';
  id: number;
  phase: Phase;
  done: number;
  total: number;
}
export interface Cancel {
  kind: 'cancel';
  id: number;
}

export type ToWorker = Req | Cancel;
export type FromWorker = Res | Progress;

// ---------------------------------------------------------------------------------------------
// §6.5.1 — shared payload types
// ---------------------------------------------------------------------------------------------

export type PlaneT = { normal: [number, number, number]; offset: number };
/** Length 16, column-major. */
export type Mat4x4 = number[];
export type SurfaceVariant = 'indexed' | 'deindexed';
export type FieldSource = 'node' | 'elm';
export type ComponentSel = 'mag' | 0 | 1 | 2;

export interface StatsT {
  min: number;
  max: number;
  mean: number;
  /** 0.1, 1, 2, 5, 50, 95, 98, 99, 99.9 */
  percentiles: [number, number, number, number, number, number, number, number, number];
  histogram: Uint32Array;
  histogramLo: number;
  histogramHi: number;
}

export interface LabelEntryT {
  id: number;
  name: string;
  /** RGBA 0..255 (§4.1). The 0..1 float form exists only past `scene/fromMeta.ts`. */
  color: [number, number, number, number];
}

/** `locate` result; mirrors §6.3 `ProbeHit`. */
export interface ProbeHitT {
  /** ALWAYS the Gmsh element number (§6.2). */
  elementId: number;
  tag: number;
  /** Every node field, interpolated at the point. */
  nodeValues: Record<string, number[]>;
  /** Every element field, at the containing tet. */
  elmValues: Record<string, number[]>;
}

export interface VolumeMeta {
  handle: number;
  name: string;
  /**
   * §4.6 `DatasetRef.fingerprint` — `tvxfp1-<len:16hex>-<hash:16hex>`, digested in the dataset
   * worker over the bytes the loader was handed, before §5 rule 5 drops them
   * (`tvx_core::fingerprint`). The UI thread never sees those bytes (§5 rule 3), so this is the
   * only place the value can come from.
   */
  fingerprint: string;
  dims: [number, number, number];
  nvols: number;
  affine: Mat4x4;
  spacing: [number, number, number];
  dtype: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64' | 'rgb24' | 'rgba32';
  sclSlope: number;
  sclInter: number;
  isLabel: boolean;
  intentCode: number;
  units?: string;
  /** OF VOLUME 0 ONLY. Other 4D indices come from `volumeFrame` (§6.5.2). */
  stats: StatsT;
  headerJson: string;
  /** Also volume 0 only. */
  gpu: {
    format: 'R8' | 'R8UI' | 'R16' | 'R16UI' | 'R16F' | 'R32F' | 'RGBA8';
    scale: number;
    offset: number;
    filterable: boolean;
    chunked: boolean;
  };
  /** Parsed from `LoadSource.sidecars.lut`; colours 0..255 (§4.1). */
  labelTable?: LabelEntryT[];
}

/** `volumeFrame` result — everything that is per-4D-index. */
export interface VolumeFrameT {
  volumeIndex: number;
  gpuBytes: ArrayBuffer;
  gpu: VolumeMeta['gpu'];
  stats: StatsT;
  /** Present iff `isLabel`. */
  labelIds?: Uint32Array;
  /** Present iff `isLabel`. */
  denseIndexOf?: Uint32Array;
}

export interface MeshFieldMeta {
  name: string;
  source: FieldSource;
  ncomp: 1 | 3 | 9;
  n: number;
  units?: string;
  partial: boolean;
  stats: StatsT;
}

export interface MeshMeta {
  handle: number;
  name: string;
  /**
   * §4.6 `DatasetRef.fingerprint` — `tvxfp1-<len:16hex>-<hash:16hex>` over the mesh bytes alone;
   * the `.msh.opt` / `_LUT.txt` sidecars are not digested, so recolouring a tag does not make the
   * mesh look like a different file.
   */
  fingerprint: string;
  nNodes: number;
  nTris: number;
  nTets: number;
  hasTris: boolean;
  /** Baked into the node coordinates by the loader; identity when none (§4.3). */
  appliedTransform: Mat4x4;
  /** GIfTI CoordinateSystem strings, verbatim (§6.2). */
  dataSpace?: string;
  transformedSpace?: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  tags: {
    id: number;
    name?: string;
    /** 0..255 (§4.1). */
    color: [number, number, number, number];
    kind: 'tri' | 'tet';
    count: number;
  }[];
  fields: MeshFieldMeta[];
  skipped: { elemType: number; count: number }[];
  orient: {
    components: number;
    openComponents: number;
    nonManifoldEdges: number;
    flippedComponents: number;
  };
  opt?: {
    tagColor: Record<number, [number, number, number, number]>;
    tagVisible: Record<number, boolean>;
    views: {
      name?: string;
      customMin?: number;
      customMax?: number;
      rangeType?: number;
      saturateValues?: boolean;
      colormapNumber?: number;
      showScale?: boolean;
      vectorType?: number;
    }[];
  };
  /** Keyed by node-field name (`.annot` / `.label.gii`). */
  labelTables?: Record<string, LabelEntryT[]>;
}

export interface SurfacePayload {
  variant: SurfaceVariant;
  /** 3/vertex. */
  positions: Float32Array;
  /** 3/vertex. */
  normals: Float32Array;
  /** Indexed only. */
  indices?: Uint32Array;
  /**
   * Indexed only: vertex -> INTERNAL 0-based node index (row in `Mesh.nodes`), which is what the §7.4
   * node-field texture is indexed by.
   */
  nodeIndex?: Uint32Array;
  /** Deindexed only: 0|1|2. */
  corner?: Uint8Array;
  /** 1/triangle, Gmsh element number (§6.2). */
  ownerElm: Uint32Array;
  /** 1/triangle. */
  faceTag: Int32Array;
  /** 1/triangle, low 3 bits; absent = fully unmasked. */
  edgeMask?: Uint8Array;
  perTag: { tag: number; first: number; count: number }[];
  orient: MeshMeta['orient'];
  bounds: MeshMeta['bounds'];
}

export interface CutCounts {
  plane: number;
  vertices: number;
  triangles: number;
  edgeSegments: number;
  boundarySegments: number;
}

export type CutResult =
  | { mode: 'buffers'; cuts: CutPayload[] }
  /** `truncated` ⇒ `counts` are REQUIRED sizes and nothing was written (§6.4). */
  | { mode: 'recycled'; truncated: boolean; counts: CutCounts[] };

export interface CutPayload {
  plane: number;
  /** 3/vertex. */
  positions: Float32Array;
  /** 2/vertex (n0, n1). */
  interpNodes: Uint32Array;
  /** 1/vertex. */
  interpT: Float32Array;
  /** 1/triangle. */
  ownerTet: Uint32Array;
  /** 1/triangle. */
  tag: Int32Array;
  /** 1/triangle. */
  edgeMask: Uint8Array;
  /** 6/segment — 2D overlay only. */
  edgeSegments: Float32Array;
  /** 6/segment — 2D overlay only. */
  boundarySegments: Float32Array;
}

/**
 * Sent as `JSON.stringify(criteria)` into `mesh_isolate(criteria_json, …)`, so it contains NO typed
 * arrays and NO ArrayBuffers: a `Uint32Array` stringifies to `{"0":…}` and an `ArrayBuffer` to `{}`.
 * The label volume's samples travel as the separate `labelVolume` argument of the `isolate` op
 * (§6.5.2). Field names and enum encodings are pinned to §6.3's serde attributes: camelCase members,
 * `box` kept as `box`, lowercase enum strings.
 */
export interface IsolateCriteriaT {
  tags?: number[];
  field?: { source: FieldSource; name: string; component: ComponentSel; lo: number; hi: number };
  sphere?: { center: [number, number, number]; radius: number };
  box?: { min: [number, number, number]; max: [number, number, number] };
  labelVolume?: {
    dims: [number, number, number];
    worldToVoxel: Mat4x4;
    dtype: VolumeMeta['dtype'];
    volumeIndex: number;
    /** Plain JSON numbers, NOT a `Uint32Array`. */
    labels: number[];
  };
  combine: 'all' | 'any';
}

/**
 * Sidecars are keyed BY ROLE, never positional: the worker must be able to tell a `_LUT.txt` from a
 * `.msh.opt` without sniffing. `lut` -> `load_volume`/`load_mesh`'s `lut_bytes`; `opt` ->
 * `load_mesh`'s `opt_bytes`.
 */
export type LoadSource =
  /** `tetravox://file/…` */
  | { kind: 'url'; url: string; sidecars?: { lut?: string; opt?: string } }
  | { kind: 'file'; file: File; sidecars?: { lut?: File; opt?: File } }
  | {
      kind: 'bytes';
      name: string;
      bytes: ArrayBuffer;
      sidecars?: { lut?: ArrayBuffer; opt?: ArrayBuffer };
    };

// ---------------------------------------------------------------------------------------------
// §6.5.2 — op table. `OpArgs` and `OpResult` are written out in full — one member per `OpName`,
// exhaustive, no index signature — so `Req<'cut'>` and `Res<'cut'>` are fully typed.
// ---------------------------------------------------------------------------------------------

export interface GpuCapsT {
  floatLinear: boolean;
  norm16: boolean;
  max3d: number;
}

export type MeshFormatSel = 'auto' | 'msh' | 'gii' | 'fs' | 'stl' | 'ply' | 'obj';

export interface OpArgs {
  loadVolume: { source: LoadSource; caps: GpuCapsT; wantLinear: boolean };
  loadMesh: { source: LoadSource; format: MeshFormatSel };
  volumeFrame: {
    handle: number;
    volumeIndex: number;
    caps: GpuCapsT;
    wantLinear: boolean;
  };
  surface: { handle: number; variant: SurfaceVariant; maskId?: number };
  boundary: { handle: number; maskId?: number; variant: SurfaceVariant };
  buildTopology: { handle: number };
  /** `planes` is at most 6. `recycle: true` ⇒ the worker passes its `CutOut` pool (§6.4). */
  cut: { handle: number; planes: PlaneT[]; maskId?: number; recycle?: boolean };
  /**
   * `labelVolume` is required iff `criteria.labelVolume` is set, is **cloned not transferred**
   * (§5 rule 2), and is the only bulk argument any op takes.
   */
  isolate: { handle: number; criteria: IsolateCriteriaT; labelVolume?: ArrayBuffer };
  field: { handle: number; source: FieldSource; name: string; component: ComponentSel };
  elmToNode: { handle: number; direction: 'elmToNode' | 'nodeToElm'; name: string };
  locate: { handle: number; world: [number, number, number] };
  marchingCubes: { handle: number; volumeIndex: number; iso: number; smooth: boolean };
  marchingTets: {
    handle: number;
    source: FieldSource;
    name: string;
    component: ComponentSel;
    iso: number;
    maskId?: number;
  };
  contours: { handle: number; plane: PlaneT; maskId?: number };
  labelCentroids: { handle: number; volumeIndex: number };
  /**
   * Volumetric `GlyphSpec` origins (§7.4). `stride` keeps every `stride`-th tet that survives
   * `maskId` and `tags` — filtering happens **first**, so a small tag still gets glyphs — and
   * `stride: 0` is a parse error. `tags` absent means every tag.
   */
  meshCentroids: { handle: number; maskId?: number; stride: number; tags?: number[] };
  free: { handle: number };
  freeMask: { handle: number; maskId: number };
}

export interface OpResult {
  /** `data` = raw samples for probes; `gpuBytes` = the `gpu_payload` texture bytes. */
  loadVolume: {
    meta: VolumeMeta;
    data: ArrayBuffer;
    gpuBytes: ArrayBuffer;
    labelIds?: Uint32Array;
    denseIndexOf?: Uint32Array;
  };
  /** No bulk arrays; Morton reorder + `TetBlocks` + `PointLocator` are built here. */
  loadMesh: { meta: MeshMeta };
  volumeFrame: VolumeFrameT;
  surface: SurfacePayload;
  boundary: SurfacePayload;
  buildTopology: { faces: number; boundaryFaces: number };
  cut: CutResult;
  /** The client owns `maskId` and must `freeMask`. */
  isolate: { maskId: number; visibleTets: number; generation: number };
  field: { values: Float32Array; stats: StatsT; n: number; partial: boolean };
  elmToNode: { name: string; values: Float32Array; stats: StatsT };
  locate: { hit: ProbeHitT | null };
  marchingCubes: SurfacePayload;
  marchingTets: SurfacePayload;
  /** 6 floats per segment. */
  contours: { segments: Float32Array };
  labelCentroids: {
    centroids: { id: number; centroid: [number, number, number]; count: number }[];
  };
  /**
   * 3 floats per origin and one Gmsh element number per origin (§6.2), in Morton order. No
   * triangles and no normals: §7.4's "no new geometry from WASM" is what this op keeps true.
   */
  meshCentroids: { positions: Float32Array; ownerTet: Uint32Array };
  /** The client then calls `worker.terminate()`. */
  free: Record<string, never>;
  /** Masks are also dropped when the mesh handle is freed. */
  freeMask: Record<string, never>;
}

/**
 * Every `OpName`, in the order §6.5 declares them. Runtime data, not a type — the compute client
 * iterates it and the §6.5.2 op→export mapping is asserted exhaustive against it.
 */
export const OP_NAMES = [
  'loadVolume',
  'loadMesh',
  'volumeFrame',
  'surface',
  'boundary',
  'buildTopology',
  'cut',
  'isolate',
  'field',
  'elmToNode',
  'locate',
  'marchingCubes',
  'marchingTets',
  'contours',
  'labelCentroids',
  'meshCentroids',
  'free',
  'freeMask',
] as const satisfies readonly OpName[];

/**
 * Op → §6.4 wasm export, one-to-one and exhaustive (§6.5.2). `wasm_heap_bytes()` is the only export
 * without an op; it is read after every call and stamped onto `Res`.
 */
export const OP_TO_EXPORT = {
  loadVolume: 'load_volume',
  loadMesh: 'load_mesh',
  volumeFrame: 'volume_frame',
  surface: 'mesh_surface',
  boundary: 'mesh_boundary',
  buildTopology: 'mesh_build_topology',
  cut: 'mesh_cut',
  isolate: 'mesh_isolate',
  field: 'mesh_field',
  elmToNode: 'mesh_convert_field',
  locate: 'mesh_locate',
  marchingCubes: 'volume_marching_cubes',
  marchingTets: 'mesh_marching_tets',
  contours: 'mesh_contours',
  labelCentroids: 'volume_label_centroids',
  meshCentroids: 'mesh_centroids',
  free: 'free',
  freeMask: 'free_mask',
} as const satisfies Record<OpName, string>;

// ---------------------------------------------------------------------------------------------
// Type guards — with OP_NAMES / OP_TO_EXPORT above, the only runtime code §6.5 permits in this file.
// ---------------------------------------------------------------------------------------------

export function isProgress(m: FromWorker): m is Progress {
  return (m as Progress).kind === 'progress';
}

export function isRes(m: FromWorker): m is Res {
  return (m as Progress).kind !== 'progress';
}

export function isCancel(m: ToWorker): m is Cancel {
  return (m as Cancel).kind === 'cancel';
}

export function isReq(m: ToWorker): m is Req {
  return (m as Cancel).kind !== 'cancel';
}

export function isOk<K extends OpName>(r: Res<K>): r is Extract<Res<K>, { ok: true }> {
  return r.ok;
}
