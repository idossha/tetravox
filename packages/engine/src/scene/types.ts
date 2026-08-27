/**
 * `@tetravox/engine` — the scene data model.
 *
 * This file is `docs/ARCHITECTURE.md` §4.1–§4.6 verbatim, with **zero imports**. FROZEN at the end of
 * Phase 0 (§12.3 item 2): changing anything here requires editing `docs/ARCHITECTURE.md` in the same
 * commit and appending a line to `docs/DECISIONS.md`.
 */

// ---------------------------------------------------------------------------------------------
// §4.1 Primitives
// ---------------------------------------------------------------------------------------------

export type vec2 = [number, number];
export type vec3 = [number, number, number];
export type vec4 = [number, number, number, number];

// COLOUR CONVENTION (normative, no exceptions): every `vec4` used as a colour anywhere in §4 —
// LabelEntry.color, MeshTag.color, MshOptions.tagColor, MeshLayer.solidColor/edgeColor,
// tagStyle[].color, IsosurfaceLayer.color, GlyphSpec.color, PointsLayer.color, Scene.background — is
// **RGBA in 0..1 floats**. Rust and the §6.5 wire keep `[u8; 4]` / 0..255. The **only** place that
// divides by 255 is `packages/engine/src/scene/fromMeta.ts`; nothing else in the engine, and nothing
// in the app, may convert. `expectPixel` (§11) asserts 0..255 bytes, so the expected value for a
// tag-coloured pixel is the **wire** `[u8;4]`.

/** Column-major, length 16 (gl-matrix layout). */
export type mat4 = Float32Array;
export type quat = [number, number, number, number];
export type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export type DatasetId = string;
export type LayerId = string;
export type ViewId = string;
/** wasm-side dataset handle. */
export type Handle = number;
/** wasm-side `BitMask` handle. */
export type MaskId = number;

/** Keep side: `dot(normal, x) + offset >= 0`. */
export interface Plane {
  normal: vec3;
  offset: number;
}
export interface Aabb {
  min: vec3;
  max: vec3;
}
/** Opaque; the engine owns the `Worker`. */
export interface WorkerRef {
  readonly id: number;
}

/** Mirrors protocol `Phase` (§6.5). Duplicated deliberately: `scene/types.ts` has zero imports. */
export type LoadPhase = 'read' | 'inflate' | 'parse' | 'topology' | 'index' | 'upload';

export type ColormapName =
  | 'gray'
  | 'viridis'
  | 'plasma'
  | 'inferno'
  | 'magma'
  | 'cividis'
  | 'turbo'
  | 'jet'
  | 'hot'
  | 'cool'
  | 'bone'
  | 'coolwarm'
  | 'bwr'
  | 'freesurfer-heat'
  /** Default negative branch (§7.6). */
  | 'blue-cyan';

// ---------------------------------------------------------------------------------------------
// §4.2 Scalar display model
// ---------------------------------------------------------------------------------------------

export type Scale =
  | { kind: 'linear'; lo: number; hi: number }
  | {
      kind: 'heat';
      min: number;
      mid: number;
      max: number;
      truncate: boolean;
      inverse: boolean;
      negative: 'mirror' | 'hide' | 'separate';
    };

export interface Threshold {
  lo: number;
  hi: number;
  /** Compare `|v|` instead of `v`. */
  symmetric: boolean;
  mode: 'hide' | 'clamp';
  /** Width of the alpha ramp as a fraction of `hi - lo`; 0 = hard discard. */
  softEdge: number;
}

export type PercentileKey = '0.1' | '1' | '2' | '5' | '50' | '95' | '98' | '99' | '99.9';

/** Always in PHYSICAL units (post `scl_slope`/`scl_inter`). */
export interface Stats {
  min: number;
  max: number;
  mean: number;
  percentiles: Record<PercentileKey, number>;
  /** 256 bins over `[histogramLo, histogramHi]`. */
  histogram: Uint32Array;
  histogramLo: number;
  histogramHi: number;
}

/** 0..1 (converted from the wire's 0..255). */
export interface LabelEntry {
  id: number;
  name: string;
  color: vec4;
}
/**
 * Keyed by id, never indexed by id — SimNIBS/FreeSurfer ids are sparse and reach 530 `[DATA]`.
 */
export interface LabelTable {
  entries: LabelEntry[];
  byId: Map<number, LabelEntry>;
}

// ---------------------------------------------------------------------------------------------
// §4.3 Datasets
// ---------------------------------------------------------------------------------------------

export type GpuScalarFormat = 'R8' | 'R8UI' | 'R16' | 'R16UI' | 'R16F' | 'R32F' | 'RGBA8';

export interface GpuFormatInfo {
  format: GpuScalarFormat;
  /** physical = raw * scale + offset */
  scale: number;
  offset: number;
  /** LINEAR is legal on this format on this GPU. */
  filterable: boolean;
  /** Uploaded as z-slabs (§7.3). */
  chunked: boolean;
}

export interface VolumeDataset {
  kind: 'volume';
  id: DatasetId;
  name: string;
  path?: string;
  dims: vec3;
  nvols: number;
  affine: mat4;
  inverseAffine: mat4;
  spacing: vec3;
  bounds: Aabb;
  dtype: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64' | 'rgb24' | 'rgba32';
  /**
   * RAW on-disk samples, `nx*ny*nz*nvols`, i fastest. Kept on the UI thread for probes only; never
   * re-sent to a worker.
   */
  data: TypedArray;
  /** Identity `(1, 0)` when the header says no scaling. */
  sclSlope: number;
  sclInter: number;
  isLabel: boolean;
  /** Sorted unique ids, present iff `isLabel`. */
  labelIds?: Uint32Array;
  /** id -> dense index (0..labelIds.length-1), present iff `isLabel`. */
  denseIndexOf?: Uint32Array;
  labelTable?: LabelTable;
  stats: Stats;
  units?: string;
  /** GPU *description*; the `WebGLTexture` lives in engine-private `GpuResources`. */
  gpu: GpuFormatInfo;
  /** Every raw header field, for the UI header panel. */
  headerJson: string;
  toTemplate?: { name: 'MNI152' | 'MNI305'; kind: 'affine'; matrix: mat4 };
  worker: WorkerRef;
  handle: Handle;
}

export interface MeshFieldInfo {
  name: string;
  source: 'node' | 'elm';
  ncomp: 1 | 3 | 9;
  n: number;
  units?: string;
  /** True when the file left gaps (filled with NaN, §6.2). */
  partial: boolean;
  /** Of the magnitude when `ncomp > 1`. */
  stats: Stats;
}

export interface MeshTag {
  id: number;
  name?: string;
  /** 0..1 */
  color: vec4;
  kind: 'tri' | 'tet';
  count: number;
}

export interface OrientReport {
  components: number;
  openComponents: number;
  nonManifoldEdges: number;
  flippedComponents: number;
}

export interface MshOptions {
  /** 0..1 (wire form is Rust `Vec<(i32,[u8;4])>` / `Record<number,[u8;4]>`). */
  tagColor: Record<number, vec4>;
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
}

export interface MeshDataset {
  kind: 'mesh';
  id: DatasetId;
  name: string;
  path?: string;
  /**
   * USER-EDITABLE ADDITIONAL transform; ALWAYS identity on load. **Mesh coordinates are always
   * delivered in world mm with any file transform already applied** (§3), so an agent that finds
   * itself asking "is `transform` already in the vertices?" has the answer: never.
   */
  transform: mat4;
  /**
   * What the loader already baked into the node coordinates (identity for Gmsh/STL/PLY/OBJ; the
   * GIfTI/FreeSurfer matrix when one was applied).
   */
  appliedTransform: mat4;
  /** GIfTI CoordinateSystem strings, verbatim, when the file carried them. */
  dataSpace?: string;
  transformedSpace?: string;
  /** Of the delivered (world-mm) node coordinates, before `transform`. */
  bounds: Aabb;
  nNodes: number;
  nTris: number;
  nTets: number;
  hasTris: boolean;
  fields: MeshFieldInfo[];
  tags: MeshTag[];
  skipped: { elemType: number; count: number }[];
  opt?: MshOptions;
  orient: OrientReport;
  /** Set by the `buildTopology` op (§6.5). */
  topologyBuilt: boolean;
  worker: WorkerRef;
  handle: Handle;
}

export type Dataset = VolumeDataset | MeshDataset;

// **Mesh bulk arrays never reach the UI thread.** Nodes/tets/tris/fields stay in the dataset's
// worker; the UI thread sees only draw-ready buffers (uploaded to GL, then dropped) and probe results.

// ---------------------------------------------------------------------------------------------
// §4.4 Layers
// ---------------------------------------------------------------------------------------------

export interface LayerBase {
  id: LayerId;
  datasetId: DatasetId;
  name: string;
  visible: boolean;
  opacity: number;
  pickable: boolean;
  showColorbar: boolean;
}

export interface VolumeLayer extends LayerBase {
  kind: 'volume';
  /** 0 unless `nvols > 1`. Changing it is a `volumeFrame` op (§6.5.2): new texture bytes + new Stats. */
  volumeIndex: number;
  /** `string` = user `.json` colormap id (§7.6). */
  colormap: ColormapName | string;
  colormapNegative?: ColormapName | string;
  scale: Scale;
  threshold: Threshold;
  /** Forced to `'nearest'` when `dataset.isLabel`. */
  interpolation: 'linear' | 'nearest';
  labelMode: 'fill' | 'outline' | 'both';
  /** Render-target px (§7.0.5). */
  outlineWidthPx: number;
  /** `undefined` = all. */
  visibleLabels?: Uint32Array;
  labelOpacity?: Record<number, number>;
  /**
   * R5's colour picker: per-label colour overrides, id → 0..1 RGBA, beating the dataset's
   * `LabelTable` (added 2026-08-27 by the Phase-2 integrator — see `docs/DECISIONS.md`).
   *
   * It is on the **layer** and not on the table because §4.6 does not serialise a `LabelTable` (it
   * is re-derived from the LUT on load), and R5 requires that "edits persist in the scene". A plain
   * `Record<number, vec4>` rather than a patched table for the same reason: this is the whole of the
   * edit, it is JSON as it stands, and the file's own colours stay readable underneath it, which is
   * what makes a per-row Reset possible at all.
   */
  labelColors?: Record<number, vec4>;
  /**
   * R5's selection: the labels drawn with the outline emphasis (added 2026-08-27, as above).
   *
   * A plain array, unlike `visibleLabels`' `Uint32Array`: a selection is a handful of ids that a
   * panel edits click by click, not a filter over up to 65535 of them, and keeping it JSON keeps
   * `SerializableLayer` a straight `Omit` of one field rather than two.
   */
  selectedLabels?: number[];
  showIn3D: boolean;
  /** `'f32'` forces R32F, guarded by `caps.floatLinear`. */
  precision: 'auto' | 'f32';
}

export interface ClipPlane {
  plane: Plane;
  enabled: boolean;
  /**
   * The plane's `offset` tracks the cursor (added 2026-08-27 by the Phase-2 integrator — see
   * `docs/DECISIONS.md`).
   *
   * On the layer rather than in the app's UI store because a saved scene that reopens with the
   * plane where it was but no longer following is a scene that did not round-trip. The arithmetic
   * stays outside React either way (`panels/layers/mesh/state.ts`'s `planesThroughCursor`); this
   * field is what makes the answer survive `serialize()` / `load()`.
   */
  followCursor?: boolean;
}

export interface IsolateSpec {
  tags?: number[];
  field?: {
    source: 'node' | 'elm';
    name: string;
    component: 'mag' | 0 | 1 | 2;
    lo: number;
    hi: number;
  };
  sphere?: { center: vec3; radius: number };
  box?: Aabb;
  labelVolume?: { datasetId: DatasetId; volumeIndex: number; labels: number[] };
  combine: 'all' | 'any';
}

export interface GlyphSpec {
  field: { source: 'node' | 'elm'; name: string };
  shape: 'arrow' | 'line';
  subsample: { everyNth: number } | { maxCount: number };
  scale: 'fixed' | 'byMagnitude';
  lengthMm: number;
  colorBy: 'magnitude' | 'solid';
  /** 0..1 */
  color: vec4;
  clipToCutPlane: boolean;
}

export interface MeshLayer extends LayerBase {
  kind: 'mesh';
  colorMode: 'tag' | 'field' | 'solid' | 'label';
  /** 0..1, like every colour in §4 (§4.1). */
  solidColor: vec4;
  field?: { source: 'node' | 'elm'; name: string; component: 'mag' | 0 | 1 | 2 };
  label?: {
    name: string;
    table: LabelTable;
    mode: 'fill' | 'outline' | 'both';
    outlineWidthPx: number;
    visibleLabels?: Uint32Array;
  };
  colormap: ColormapName | string;
  colormapNegative?: ColormapName | string;
  scale: Scale;
  threshold: Threshold;
  tagStyle: Record<number, { visible: boolean; opacity: number; color?: vec4 /* 0..1 */ }>;
  edges: { surface: boolean; caps: boolean };
  /** 0..1 */
  edgeColor: vec4;
  edgeWidthPx: number;
  flatShading: boolean;
  /** `'both'` forced when `orient.openComponents > 0`. */
  faceMode: 'cull' | 'both';
  clip: { planes: ClipPlane[] /* max 6 */; caps: boolean; capColorMode: 'inherit' | 'tag' };
  isolate?: IsolateSpec;
  glyphs?: GlyphSpec;
  contoursIn2D: boolean;
  contourWidthPx: number;
  fillIn2D: boolean;
}

export interface IsosurfaceLayer extends LayerBase {
  kind: 'iso';
  source: {
    datasetId: DatasetId;
    volumeIndex?: number;
    field?: { source: 'node' | 'elm'; name: string; component: 'mag' | 0 | 1 | 2 };
  };
  iso: number;
  /** 0..1 */
  color: vec4;
  smooth: boolean;
  faceMode: 'cull' | 'both';
}

export interface PointsLayer extends LayerBase {
  kind: 'points';
  points: { name?: string; position: vec3; color?: vec4 /* 0..1 */; radiusMm?: number }[];
  shape: 'sphere' | 'dot';
  radiusMm: number;
  /** 0..1 */
  color: vec4;
  showLabels: boolean;
}

export type Layer = VolumeLayer | MeshLayer | IsosurfaceLayer | PointsLayer;

// Layers are ordered bottom→top and appear in every view unless `SliceView.layerVisibility` /
// `View3D.layerVisibility` says otherwise.

// ---------------------------------------------------------------------------------------------
// §4.5 Views, layout, scene
// ---------------------------------------------------------------------------------------------

export type SliceMode = 'axial' | 'coronal' | 'sagittal' | 'oblique';

export interface SliceView {
  id: ViewId;
  mode: SliceMode;
  /** Unit, world RAS. Presets lock it (§3). */
  normal: vec3;
  /**
   * Unit, in-plane, screen up. Re-orthogonalised on load: `up ← normalize(up − (up·n)n)`; rejected if
   * `|up × n| < 1e-4`.
   */
  up: vec3;
  /**
   * In-plane pan/zoom, relative to the **scene bounds centre** — not to the cursor's projection.
   *
   * R3 (*move the crosshair, not the scan*) is why: a pane whose world-to-screen map is a function
   * of `scene.cursor` slides the image whenever the cursor moves, which makes click-to-set-cursor
   * unwritable. See §4.5 and `docs/DECISIONS.md`, 2026-08-27.
   */
  camera: { center: vec2; mmPerPx: number };
  layerVisibility?: Record<LayerId, boolean>;
}
// The plane is DERIVED, never stored: plane = { normal, offset: -dot(normal, scene.cursor) }.
// One source of truth (the cursor) ⇒ cursor sync is identical for canonical and oblique views.

export interface Camera3D {
  target: vec3;
  distance: number;
  rotation: quat;
  fovYDeg: number;
  orthographic: boolean;
  /** `near = max(1 mm, fitRadius/1000)`, `far = fitRadius * 8` (§7.2). */
  near: number;
  far: number;
}

export interface View3D {
  id: ViewId;
  camera: Camera3D;
  showSlicePlanes: boolean;
  layerVisibility?: Record<LayerId, boolean>;
}

export type View = SliceView | View3D;

export type LayoutKind = '1x1' | '1x3' | '1x3-horizontal' | '2x2' | '3d-only';
export interface Layout {
  kind: LayoutKind;
  cells: ViewId[];
}

export interface Annotations {
  orientationLabels: boolean;
  cornerInfo: boolean;
  /** The badge is not optional. */
  conventionBadge: true;
  scaleBar: boolean;
  colorbars: boolean;
  crosshair: boolean;
}

export interface QualityLevel {
  name: 'full' | 'interacting' | 'reduced';
  /** 1 = one device pixel per CSS px. */
  dprScale: number;
  msaa: 0 | 2 | 4;
  edges: boolean;
  /** 1 = exact. */
  capDecimation: number;
  oit: boolean;
}

/**
 * The **runtime** graph: it holds TypedArrays, GPU handles and worker handles, and is *not*
 * JSON-serialisable. GL objects live in an engine-private map keyed by `DatasetId`, declared in
 * `packages/engine/src/gl/resources.ts` (not part of this frozen file).
 */
export interface Scene {
  version: 1;
  datasets: Map<DatasetId, Dataset>;
  /** bottom → top */
  layers: Layer[];
  activeLayerId: LayerId | null;
  /** Independent of layout, so `'3d-only'` keeps plane state. */
  slices: SliceView[];
  view3d: View3D;
  layout: Layout;
  cursor: vec3;
  hover: vec3 | null;
  radiological: boolean;
  /** 0..1 */
  background: vec4;
  lighting: { ambient: number; headlight: boolean };
  annotations: Annotations;
  transparency: { mode: 'twoPhase' | 'sorted' | 'peel'; peelLayers?: number };
  quality: QualityLevel;
}

// ---------------------------------------------------------------------------------------------
// §4.6 ViewSpec — the persisted form (`*.tetravox.json`)
// ---------------------------------------------------------------------------------------------

export interface DatasetRef {
  id: DatasetId;
  kind: 'volume' | 'mesh';
  name: string;
  /** Relative to the scene file. */
  path: string;
  /** Fallback when the relative path misses. */
  absPath?: string;
  /** `tvxfp1-<len:16hex>-<hash:16hex>` — see §4.6; produced by `tvx_core::fingerprint`. */
  fingerprint: string;
}

/**
 * `visibleLabels` is the one field that is not JSON as it stands (`Uint32Array`), so it is the one
 * field this type replaces. `labelColors` and `selectedLabels` were deliberately given JSON shapes
 * on `VolumeLayer` itself so they need no entry here — see their doc comments.
 */
export type SerializableLayer = Omit<Layer, 'visibleLabels'> & {
  visibleLabels?: number[];
  label?: {
    name: string;
    mode: string;
    outlineWidthPx: number;
    visibleLabels?: number[];
  };
};

/**
 * `LabelTable`s are **not** serialised; they are re-derived from the dataset and its LUT on load. A
 * missing dataset opens a "relocate" dialog keyed on `fingerprint`.
 */
export interface ViewSpec {
  version: 1;
  datasets: DatasetRef[];
  layers: SerializableLayer[];
  activeLayerId: LayerId | null;
  slices: SliceView[];
  view3d: View3D;
  layout: Layout;
  cursor: vec3;
  radiological: boolean;
  background: vec4;
  lighting: Scene['lighting'];
  annotations: Annotations;
  transparency: Scene['transparency'];
}
