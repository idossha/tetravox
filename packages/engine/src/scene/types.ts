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
  toTemplate?: TemplateSpace;
  worker: WorkerRef;
  handle: Handle;
}

/**
 * §4.3's `toTemplate`, widened for directed task 8 (2026-08-28 — `docs/DECISIONS.md`).
 *
 * Phase 2 shipped this as `{ name, kind: 'affine', matrix }`, and §3 said in one line that
 * "nonlinear warps are out of scope". They are not any more: on a SimNIBS subject the affine is the
 * transform that **does not exist** — `charm` writes no `MNI2conform_12DOF.txt` at all `[DATA]` —
 * while the nonlinear pair `toMNI/Conform2MNI_nonl.nii.gz` / `toMNI/MNI2Conform_nonl.nii.gz` is
 * always there. Keeping the readout affine-only meant that on the reference dataset, the MNI column
 * was permanently greyed out with "not in a template space", which is the honest answer to the
 * question Phase 2 asked and the wrong answer to the question a user asks.
 *
 * The Phase-2 shape is still assignable: `kind` gains `'simnibs'`, everything else is optional and
 * additive.
 *
 * **Directions, once.** `matrix` is **world → template**, as it always was. The two field ids point
 * at ordinary `VolumeDataset`s (4-D, three volumes) loaded through the normal §5 worker path;
 * `forwardFieldId` is subject → template and `inverseFieldId` template → subject. A deformation
 * field's voxel values *are* the target-space coordinates, so both directions are a forward
 * trilinear sample of the appropriate field and neither is an iterative inversion
 * (`view/spaces.ts` derives all of this from `simnibs/utils/transformations.py`).
 */
export interface TemplateSpace {
  name: 'MNI152' | 'MNI305';
  /** `'affine'` = the Phase-2 header-derived form; `'simnibs'` = a `toMNI/` folder on disk. */
  kind: 'affine' | 'simnibs';
  /** World RAS mm → template mm. Identity when {@link TemplateSpace.hasAffine} is false. */
  matrix: mat4;
  /**
   * False when no affine transform was found and `matrix` is a placeholder identity — the readout
   * then offers only the nonlinear space, rather than reporting the cursor unchanged as "MNI".
   */
  hasAffine?: boolean;
  /** The file `matrix` came from, e.g. `MNI2conform_12DOF.txt`, for the readout's label. */
  affineFile?: string;
  /**
   * True when a `Conform2MNI_nonl.nii.gz` was **found on disk** for this subject, whether or not it
   * has been loaded yet.
   *
   * Separate from {@link TemplateSpace.forwardFieldId} because the warp is loaded *on demand*, the
   * first time the nonlinear space is selected — and a `<select>` cannot select a disabled option,
   * so an option that is only enabled once the field has loaded can never be the thing that starts
   * the load. The space is therefore offered as soon as the file is known to exist; the readout row
   * says "loading…" for the seconds it takes, and `toSpace` still returns null until it lands.
   */
  nonlinearAvailable?: boolean;
  /** `Conform2MNI_nonl.nii.gz` as a dataset: subject → template. */
  forwardFieldId?: DatasetId;
  /** `MNI2Conform_nonl.nii.gz` as a dataset: template → subject, for typed entry. */
  inverseFieldId?: DatasetId;
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
  /**
   * `MeshMeta.labelTables` (§6.5.1), keyed by **node-field name** — the `<LabelTable>` of a
   * `.label.gii` or the colortable of a `.annot`.
   *
   * Without this the `.label.gii`'s table stopped at the wire: `MeshLayer.colorMode:'label'` and
   * `MeshLayer.label.table` were implemented in the shader and in `layers/mesh.ts`, and nothing
   * could fill them from a file the user opened. R5's "one Region panel for every labelled thing"
   * names surface annotations as one of its three, so this is the field that makes the third
   * reachable.
   */
  labelTables?: Record<string, LabelTable>;
  /**
   * The non-mesh half of a Gmsh **parsed post-processing view** (`.geo` / `.pos`, §6.2) — points,
   * text labels and line segments. `undefined` for every other format.
   *
   * The view's `ST`/`SQ` triangles are not here: they are this dataset's triangles, with the
   * per-corner values on the node field named `value`. This is what `defaultLayerFor` seeds a
   * points layer from, and it is retained on the dataset so the layer can be rebuilt (a colormap
   * change, a Reset) without re-reading the file.
   */
  geo?: GeoData;
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
  /**
   * The volume's **3D surface** (directed task 2, 2026-08-28 — see `docs/DECISIONS.md`).
   *
   * Additive and optional: absent means the volume has no isosurface, which is what every layer
   * written before this field said and still says. Present and `enabled`, it makes the volume layer
   * the **owner** of one or more linked `IsosurfaceLayer`s that the engine derives — it does not add
   * rows to `Scene.layers`. That ownership is the whole point: the surfaces follow the volume's 4D
   * `volumeIndex`, its `visible` flag and (for a label volume) its `visibleLabels` /
   * `selectedLabels` / `labelColors`, and they go when the volume goes.
   *
   * `iso` and `color` describe the **scalar** case: one surface at one level. For a label volume the
   * engine derives one surface per visible-or-selected region at `label − 0.5` in that region's LUT
   * colour (`labelColors` first), so neither field is read.
   */
  iso3d?: VolumeIso3d;
}

/** §4.4's `VolumeLayer.iso3d`. Plain JSON, so `SerializableLayer` needs no new `Omit`. */
export interface VolumeIso3d {
  /** The **3D surface** switch. `false` keeps the settings without building anything. */
  enabled: boolean;
  /** Scalar volumes only: the level, in physical units. Defaults to the volume's p95. */
  iso: number;
  /** Scalar volumes only: 0..1 RGBA, like every colour in §4.1. */
  color: vec4;
  /** The surfaces' opacity, independent of the volume slice's `LayerBase.opacity`. */
  opacity: number;
  /** Smooth (per-vertex) shading; `false` is faceted. */
  smooth: boolean;
  faceMode: 'cull' | 'both';
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

/**
 * How a magnitude becomes an arrow length (added 2026-08-28 — see `docs/DECISIONS.md`).
 *
 * The maths is `derived/glyph-scale.ts`; this is only the state. Every mode sends
 * {@link GlyphScaling.normalizeTo}'s magnitude to exactly {@link GlyphScaling.lengthMm}, which is
 * what the overlay legend line and the colour bar's scaling word both quote.
 */
export interface GlyphScaling {
  /** `'log'` is log10 of |E| above {@link GlyphScaling.logFloor}. */
  mode: 'fixed' | 'linear' | 'sqrt' | 'log';
  /** The length, in **millimetres**, of an arrow at the reference magnitude. */
  lengthMm: number;
  /**
   * The magnitude that maps to `lengthMm`: the field's 99th percentile, its maximum, an explicit
   * value in field units, or `null` for "`lengthMm` per unit of |E|".
   */
  normalizeTo: 'p99' | 'max' | number | null;
  /** `'log'` only, in field units: at and below it an arrow has zero length and is not drawn. */
  logFloor: number;
}

export interface GlyphSpec {
  field: { source: 'node' | 'elm'; name: string };
  shape: 'arrow' | 'line';
  subsample: { everyNth: number } | { maxCount: number };
  /**
   * The legacy strings are still read (`'fixed'`; `'byMagnitude'` = linear, normalised to the field
   * max) so a scene saved before 2026-08-28 round-trips unchanged; new specs carry the object.
   */
  scale: 'fixed' | 'byMagnitude' | GlyphScaling;
  /** Superseded by `scale.lengthMm` when `scale` is an object; kept for the legacy strings. */
  lengthMm: number;
  colorBy: 'magnitude' | 'solid';
  /** 0..1 */
  color: vec4;
  /**
   * @deprecated The 2026-08-28 spelling is {@link GlyphSpec.onCutPlaneOnly}; either being `true`
   * restricts the origins to the slab. It was never implemented under this name (the renderer
   * ignored it outright), which is what the directed task 7 verification found.
   */
  clipToCutPlane: boolean;
  /**
   * Density, third knob (added 2026-08-28): keep only origins within
   * {@link GlyphSpec.cutSlabMm} of the layer's first enabled clip plane. Inert when the layer has
   * none — there is no other "active cut plane" in a 3D pane, and the app's control says so.
   */
  onCutPlaneOnly?: boolean;
  /** Half-thickness, in mm, of the {@link GlyphSpec.onCutPlaneOnly} slab. Default 1. */
  cutSlabMm?: number;
  /**
   * Fraction of the arrow's length taken by the head, 0..0.9 (added 2026-08-28). `0` and
   * `shape: 'line'` are the same picture. Default 0.3, the shape every earlier golden has.
   */
  headProportion?: number;
  /**
   * Where the origins come from (§7.4; added 2026-08-27 — see `docs/DECISIONS.md`).
   *
   * `'surface'` — the default, and what an absent field means — reads them off the de-indexed
   * `SurfacePayload` the layer already has: one origin per surface triangle, with its element number
   * from the same `ownerElm` table §7.2.3 uses. `'volume'` reads them from §6.5.2's `meshCentroids`:
   * **one origin per interior tet**, which is the case a field over all 5,900,498 elements of
   * `ernie_TDCS_1_scalar.msh` invites and which no surface can serve.
   *
   * Both stay inside §7.4's "**No new geometry from WASM**" — `meshCentroids` returns *points*, one
   * per tet, and the renderer binds them as an origin table exactly as it binds the surface's
   * positions. {@link GlyphSpec.subsample} is the density knob in both: for `'volume'` it becomes
   * the op's own `stride`, so a 4.7 M-element mesh never ships 4.7 M origins over the wire.
   */
  origins?: 'surface' | 'volume';
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
  /**
   * The 2D contour's own colour (§7.4, directed task 12), 0..1.
   *
   * `undefined` means "the layer's `edgeColor`", which is what every mesh contour was before this
   * field existed — so a tet mesh, whose contours are tissue boundaries and belong to the wireframe
   * the user already styled, is unaffected. A **surface** layer is seeded with one entry of
   * `SURFACE_CONTOUR_PALETTE` at load, because a surface's contour is the only thing that layer
   * draws in a 2D pane and Freeview's answer to "which outline is which" is one colour per surface.
   */
  contourColor?: vec4;
}

export interface IsosurfaceLayer extends LayerBase {
  kind: 'iso';
  source: {
    datasetId: DatasetId;
    volumeIndex?: number;
    /**
     * **One region of a label volume**, isolated at the sample (appended 2026-08-28 for §4.4's
     * `VolumeLayer.iso3d` — see `docs/DECISIONS.md`).
     *
     * Present means the surface comes from §6.5.2's `marchingCubesLabel` rather than
     * `marchingCubes`, and `iso` is unread. It has to be its own op, not a level: a label volume's
     * samples are ids, so `value >= k - 0.5` is the union of every id at or above `k`, and SimNIBS
     * ids do not nest.
     */
    label?: number;
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
  points: {
    name?: string;
    position: vec3;
    color?: vec4 /* 0..1 */;
    radiusMm?: number;
    /**
     * The point's scalar, if it has one — an `SP`'s value, or a `VP`'s magnitude (§6.2). Kept
     * alongside the colour rather than baked into it so `colorMode: 'value'` can be recomputed
     * when the colormap or the scale changes, which is what makes the editor's colormap picker
     * work without reloading the file.
     */
    value?: number;
  }[];
  shape: 'sphere' | 'dot';
  radiusMm: number;
  /** 0..1 */
  color: vec4;
  showLabels: boolean;

  // -------------------------------------------------------------------------------------------
  // Appended for parsed Gmsh views (`.geo` / `.pos`, directed task 6). Every field is OPTIONAL or
  // has a default that reproduces the previous behaviour exactly, so a Phase-2 scene that names a
  // points layer loads unchanged (ARCHITECTURE §4.4, DECISIONS 2026-08-28).
  // -------------------------------------------------------------------------------------------

  /**
   * Free-standing 3D text labels, screen-projected in the overlay pass (§7.2 pass 3).
   *
   * Separate from `points[].name` because a parsed view's `T3` anchors are independent of its
   * `SP`s: SimNIBS puts each label 5 mm above its electrode so the text does not sit inside the
   * sphere, and a net with more labels than points (or none) is a legal file. When the two counts
   * match the loader ALSO copies the text onto `points[].name`, so the probe row names the
   * electrode under the crosshair.
   */
  labels?: { position: vec3; text: string }[];
  /** Multiplier on the overlay font's size for {@link PointsLayer.labels}. Default 1. */
  labelScale?: number;
  /** 0..1. Defaults to {@link PointsLayer.color} when absent. */
  labelColor?: vec4;
  /**
   * `SL` line segments, **6 floats per segment** (two world-mm endpoints) — the same packing the
   * `contours` op returns, so they draw through the §7.0.6 screen-space quad expansion and get a
   * constant screen width like a 2D contour.
   */
  lineSegments?: Float32Array;
  /** Render-target pixels, like every other `*WidthPx` (§7.0.5). Default 2. */
  lineWidthPx?: number;
  /** 0..1. Defaults to {@link PointsLayer.color} when absent. */
  lineColor?: vec4;
  /**
   * `'solid'` (the default, and the Phase-2 behaviour) paints every point {@link PointsLayer.color};
   * `'value'` runs `points[].value` through {@link PointsLayer.colormap} over
   * {@link PointsLayer.valueRange}.
   *
   * Named `valueMode` and not `colorMode` on purpose. `MeshLayer.colorMode` is a *different*
   * four-value union on the same `Layer` union, and TypeScript widens a spread of
   * `Partial<Layer>` to the union of both — which made every `addLayer({ ...patch })` call site
   * stop compiling (`packages/app`'s scene restore is the one that caught it).
   */
  valueMode?: 'solid' | 'value';
  colormap?: ColormapName | string;
  /** The value range `colorMode: 'value'` maps across. Absent = the layer's own min..max. */
  valueRange?: { lo: number; hi: number };
}

/** A parsed view's points, labels and lines, as they sit on a {@link MeshDataset} (§6.5.1). */
export interface GeoData {
  points: { position: vec3; value: number; view: number }[];
  labels: { position: vec3; text: string }[];
  /** 6 floats per segment. */
  lineSegments: Float32Array;
  viewNames: string[];
  views: { name: string; points: number; labels: number; lines: number; tris: number }[];
  bounds: Aabb;
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

/**
 * **`'1+3'` and `'3d+1'` were appended for directed task 3, 2026-08-28** (see `docs/DECISIONS.md`):
 * "the 3D viewer is always on". The app's *catalogue* — the toolbar and the `x` cycle — offers only
 * the kinds that contain the 3D pane, and migrates a saved scene that names one of the others; the
 * engine's view model is untouched, so `'1x1'` and `'1x3'` remain expressible and remain what §11's
 * single-pane pixel harnesses set.
 */
export type LayoutKind =
  | '1x1'
  | '1x3'
  | '1x3-horizontal'
  | '2x2'
  | '3d-only'
  /** 3D large on the left, the three slices stacked in a narrow column on the right. */
  | '1+3'
  /** The 3D pane and one slice, side by side. */
  | '3d+1';
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
  /**
   * The 3D pane's orientation cube (directed task 10, 2026-08-28; ARCHITECTURE §4.5 / §7.2,
   * `docs/DECISIONS.md`).
   *
   * **Additive, and off by default.** A 3D pane's edge letters say which way is up at the edges;
   * nothing said which way the head is *facing* once the camera left a preset, which is the same
   * laterality-safety gap §8 opened the 2D chrome for. Default `false` for the reason `scaleBar` and
   * `colorbars` are: switching it on by default would move every §11 golden that contains a 3D pane,
   * and that is a `docs/DECISIONS.md` conversation rather than a patch.
   *
   * A scene saved before this field existed deserialises with it absent, which reads as off — the
   * same picture it was saved as.
   */
  orientationCube: boolean;
}

export interface QualityLevel {
  name: 'full' | 'interacting' | 'reduced';
  /** 1 = one device pixel per CSS px. */
  dprScale: number;
  msaa: 0 | 2 | 4;
  /**
   * 1 = exact.
   *
   * There is deliberately **no `edges` field**. §7.2's fallback set may change displayed
   * *resolution*, never what is displayed: element edges are a feature the user switched on, so
   * they stay on through orbit / pan / dolly. Same enforcement as `interpolation`'s — the knob has
   * no field, so no level can name it.
   */
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

/** One role-keyed sidecar of a `DatasetRef` (§6.5.1's `lut` / `opt`). */
export interface SidecarRef {
  /**
   * Relative to the **dataset's own directory**, not to the scene file.
   *
   * A sidecar lives beside the file it describes — `ernie.msh.opt` beside `ernie.msh`,
   * `labeling_LUT.txt` beside `labeling.nii.gz` — so anchoring it to the dataset is what makes a
   * relocated dataset bring its sidecars with it. Anchoring it to the scene file instead would
   * resolve to the old directory the moment the data moved, which is the case relocation exists for.
   */
  path: string;
  /** Fallback when the dataset-relative path misses, exactly as `DatasetRef.absPath` is. */
  absPath?: string;
}

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
  /**
   * The §6.5.1 sidecars this dataset was opened with — the `.msh.opt` and the label LUT.
   *
   * §7.6 makes them load-time inputs, not layer state: tissue **names** come from a `.msh.opt`
   * (`ernie.msh` has no `$PhysicalNames` at all), tag colours and visibility are seeded from it, and
   * a label volume's names and colours come from its `_LUT.txt`. None of that is in `Layer`, so a
   * spec that recorded only `path` reopened the same file as a different-looking dataset: the tissue
   * table read `tag 1` … `tag 1099`, the head rendered in the deterministic fallback palette, and a
   * cursor readout that said `515 · Bone-Cortical` said `515 · —`. R5's "persists through scene
   * save/load" was true of the *edits* and false of the table they are edits against.
   */
  sidecars?: { lut?: SidecarRef; opt?: SidecarRef };
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
  /**
   * **2** since directed task 13 (2026-08-28). `1` is still readable: {@link migrateViewSpec}
   * (`scene/serialize.ts`) upgrades one in place. The only differences are that a v1 file predates
   * the two optional fields below and may name a layout with no 3D pane (directed task 3), so a v1
   * read that skipped the migration would restore a grid the UI can no longer show. Nothing added
   * in v2 is required, which is why the migration is a version stamp and two defaults rather than a
   * rewrite.
   */
  version: 1 | 2;
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
  /**
   * The theme the scene was saved in — v2, optional, and **not** engine state (directed task 13).
   *
   * `Scene` has no theme: §8's choice lives in `settings.json` and reaches the engine only as a
   * chrome palette, so `serialize()` cannot produce this field and does not. The app writes it on
   * save and applies it on load *when it is there*, which is what lets a scene mailed to a
   * colleague look the way its author left it without a scene that never mentioned a theme
   * overriding the reader's preference.
   */
  theme?: 'system' | 'light' | 'dark';
  /**
   * Measurements (directed task 11), carried opaquely — v2, optional.
   *
   * Task 11 owns the shape; this field exists so that a scene saved by a build that *has*
   * measurements survives a round trip through a build that does not, instead of losing them
   * silently on the next save. `Scene` has no measurement list yet, so `serialize()` never writes
   * this field; the app carries it forward from the spec it loaded (`lib/scene.ts`).
   */
  measurements?: unknown[];
}
