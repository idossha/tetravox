# Tetravox — Architecture Contract (v2)

> Desktop viewer for **voxel volumes** (NIfTI) and **finite-element / surface meshes** (Gmsh `.msh`, GIfTI,
> FreeSurfer, STL/PLY/OBJ) with a linked **3D view + sagittal/axial/coronal 2D slices**. macOS + Linux.

This file is the **contract** every implementation agent builds against. Deviating requires editing this file in
the same commit and appending a line to `docs/DECISIONS.md`.

v2 supersedes v1 (2026-08-27) and implements the planner directives A1–G2 in `docs/review/2026-08-27-directives.md`
against the 68 findings and 14 adversarial verifications in `docs/review/2026-08-27-design-review.json`.

**Provenance tags used for every measured number in this document:**

| Tag | Meaning |
|---|---|
| `[M2Max]` | Apple M2 Max, Chromium WebGL2 on `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)`, 2880×1620, design review 2026-08-27 |
| `[SwS]` | Headless Chromium / SwiftShader, same review |
| `[N25]` | Node 25.4.0 (same V8 as Electron's Chromium), rustc 1.93.0 |
| `[DATA]` | Measured from the reference dataset by `scripts/refvalues/{mesh,nifti}_refvalues.py`, 2026-08-27 |
| `[MODEL]` | Arithmetic from `[DATA]` counts and stated element sizes — not a wall-clock measurement |

---

## 1. Stack decisions (settled)

| Concern | Decision | Why (short) |
|---|---|---|
| Shell / packaging | **Electron ≥ 38.2** (electron-vite, electron-builder → `.dmg`, `.AppImage`, `.deb`) | One Chromium build ⇒ identical WebGL2/ESSL **semantics** on macOS and Linux. *Not* identical GPU availability: Chromium M137 removed the automatic SwiftShader WebGL fallback, so a blocklisted driver yields `getContext('webgl2') === null`. Electron 38 made Wayland native by default and removed `ELECTRON_OZONE_PLATFORM_HINT`, so no ozone flags are needed — but the floor is pinned. Tauri's WebKitGTK WebGL2 is inconsistent — rejected. |
| Rendering | **Custom WebGL2 engine in TypeScript** (`packages/engine`), no three.js, no NiiVue | Small specialised primitive set (3D-texture slices with N composited layers, tet clip + exact caps, ID picking). One context / one depth buffer for volumes *and* meshes. WebGPU is a later backend behind the `GpuBackend` boundary, not a v1 goal. |
| Heavy compute | **Rust → WASM** (`crates/`), **one worker + one wasm instance per dataset** | Parsing 184–497 MB `.msh`, face extraction over 4.7–13.2 M tets, plane cuts, marching cubes, isolation masks. Pure-Rust crates (no wasm-specific code in `tvx-nifti`/`tvx-mesh-io`/`tvx-geom`) so the same code builds native/CLI. |
| WASM threading | **Single-threaded, permanently** | wasm threads need `SharedArrayBuffer` ⇒ `crossOriginIsolated` ⇒ COOP/COEP headers, plus `-Zbuild-std` on nightly for `+atomics,+bulk-memory`. Parallelism comes from worker-per-dataset instead. `rayon` is not a dependency and must not become one. |
| UI | **React 18 + TypeScript + Tailwind**; small Zustand store | UI is chrome only — all rendering is imperative in the engine. |
| Math | `gl-matrix` | Small, fast, standard. Column-major `mat4` as `Float32Array(16)`. |
| Tests | `cargo test` · `vitest` · Playwright (Chromium headless **and** Electron) with **analytic pixel assertions + goldens** (§11) | An agent cannot judge a PNG; it can judge a number. |

**Non-goals for v1:** WebGPU, Windows, DICOM, 4D playback (loading a 4D NIfTI and picking a volume index *is* in
scope), remote/URL loading, plugins, streamlines/tractography, wasm64, wasm threads, auto-update, nonlinear
template warps, two-file `.hdr`/`.img` NIfTI.

---

## 2. Repository layout (pnpm + cargo workspaces)

```
tetravox/
├── Cargo.toml / Cargo.lock       # cargo workspace; lockfile committed and FROZEN after Phase 0 (§12.3)
├── package.json / pnpm-lock.yaml # pnpm workspace root; lockfile committed and FROZEN after Phase 0
├── rust-toolchain.toml           # pinned stable (1.93.0); nightly is forbidden
├── crates/
│   ├── tvx-core/                 # shared types: Plane, BitMask, Field, LabelTable, Aabb, Error, ProgressSink
│   ├── tvx-nifti/                # NIfTI-1/2 reader (+gzip), stats, GPU payload selection
│   ├── tvx-mesh-io/              # Gmsh .msh v2/v4.1, .msh.opt, GIfTI, FreeSurfer surf/curv/annot, STL/PLY/OBJ
│   ├── tvx-geom/                 # surfaces, boundary extraction, Morton order, tet blocks, plane cut, isolation,
│   │                             #   marching cubes/tets, elm↔node, contours, point location, orientation
│   └── tvx-wasm/                 # wasm-bindgen bindings (handle-based) → packages/wasm/pkg (git-ignored)
├── packages/
│   ├── protocol/                 # @tetravox/protocol — worker envelope + every op args/result type (§6.5). FROZEN.
│   ├── wasm/                     # @tetravox/wasm — HAND-WRITTEN package.json; imports ./pkg/tvx_wasm.js (generated,
│   │                             #   git-ignored, `pkg/tvx_wasm.d.ts` stub committed) + compute-worker.ts / compute-client.ts
│   ├── engine/                   # @tetravox/engine — WebGL2 renderer, scene model, views, interaction, colormaps.
│   │                             #   Framework-free, browser-compatible. Exports MockEngine for UI tests.
│   └── app/                      # @tetravox/app — Electron main/preload/renderer (React UI), packaging config
├── testdata/                     # synthetic fixtures from scripts/gen-fixtures.py + expected.json (committed, < 2 MB)
├── scripts/                      # build-wasm.sh, gen-fixtures.py, bench.ts, refvalues/{mesh,nifti}_refvalues.py
├── docs/                         # ARCHITECTURE.md (this), DECISIONS.md, FORMATS.md, ROADMAP.md, BENCHMARKS.md, USER_GUIDE.md
└── .github/workflows/ci.yml      # the matrix in §12
```

Rules:
* `packages/wasm/pkg` is **never** a pnpm workspace member. wasm-pack writes `pkg/package.json` named after the
  crate and a `pkg/.gitignore` containing `*`; the hand-written `@tetravox/wasm` wraps it. `pnpm wasm` is a
  prerequisite of `pnpm build` / `pnpm test` / `pnpm typecheck`.
* `wasm-bindgen` is pinned exactly (`=0.2.127`) in `Cargo.toml` and wasm-pack's version is pinned in
  `scripts/build-wasm.sh`; CI caches `~/.cache/.wasm-pack`.
* Real-data tests are gated by `TETRAVOX_TESTDATA` (a directory laid out like
  `/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie`). Skipped, not failed, when unset.

---

## 3. Coordinate conventions

* **World space = scanner RAS millimetres.** Everything renders in world space.
* Volume `affine: mat4` maps voxel index `(i,j,k,1)` → world. Voxel centres are at integer indices. Source order:
  1. `sform` when `sform_code > 0` (`srow_x/y/z`).
  2. else the **qform**: with `a = sqrt(max(0, 1 − b² − c² − d²))` from `(quatern_b, quatern_c, quatern_d)`,
     ```
     R = [[a²+b²−c²−d², 2(bc−ad),     2(bd+ac)    ],
          [2(bc+ad),     a²+c²−b²−d², 2(cd−ab)    ],
          [2(bd−ac),     2(cd+ab),    a²+d²−b²−c²]]
     M[:3,0] = R[:,0]·pixdim[1];  M[:3,1] = R[:,1]·pixdim[2];
     M[:3,2] = R[:,2]·pixdim[3]·qfac        where qfac = (pixdim[0] < 0 ? −1 : +1)
     M[:3,3] = (qoffset_x, qoffset_y, qoffset_z)
     ```
     **`qfac` applies to the third column only.** Every volume in the reference dataset has `pixdim[0] = −1`
     `[DATA]`; dropping `qfac` changes `m2m_ernie/T1.nii.gz`'s third column from `(1,0,0)` to `(−1,0,0)` —
     max abs affine error 2.0 mm/voxel and an A↔P flip `[DATA]`.
  3. else `diag(pixdim[1], pixdim[2], pixdim[3], 1)`.
* `scl_slope`/`scl_inter` are **not** folded into the samples (§6.1); they are carried and applied in the shader
  and in the CPU probe path.
* Gmsh/SimNIBS meshes are already in the subject's world mm (same space as the m2m `T1.nii.gz`); loaded as-is.
  GIfTI applies `CoordinateSystemTransformMatrix` when `TransformedSpace == NIFTI_XFORM_SCANNER_ANAT`.
  FreeSurfer binary surfaces are in *tkr-RAS*; with a companion volume apply `vox2ras · inv(vox2ras-tkr)`,
  otherwise load as-is and expose the per-dataset `transform: mat4` the user can edit.
* 2D views: the plane is **derived from the cursor and the view basis**, never stored (§4.5). Canonical presets:
  axial `normal = +Z`, coronal `normal = +Y`, sagittal `normal = +X`.
* Handedness: `right = cross(up, normal)` in **neurological** (subject left on screen left, the default).
  `radiological` negates `right` only — a mirror about the vertical screen axis. It never touches `up`. This is
  the only definition; it is what makes the flag well-defined for oblique planes.
* Cursor = one world point shared by all views. `hover` is a second, transient world point (§8).
* Optional per-dataset `toTemplate?: { name, kind:'affine', matrix }` adds an MNI column to the readout. Affine
  only; nonlinear warps are out of scope.

---

## 4. Data model (engine, TypeScript)

`packages/engine/src/scene/types.ts` is exactly this section, with **zero imports**. Frozen at the end of Phase 0.

### 4.1 Primitives

```ts
export type vec2 = [number, number];
export type vec3 = [number, number, number];
export type vec4 = [number, number, number, number];
export type mat4 = Float32Array;                    // column-major, length 16 (gl-matrix layout)
export type quat = [number, number, number, number];
export type TypedArray =
  | Uint8Array | Int8Array | Uint16Array | Int16Array
  | Uint32Array | Int32Array | Float32Array | Float64Array;

export type DatasetId = string;
export type LayerId = string;
export type ViewId = string;
export type Handle = number;                        // wasm-side dataset handle
export type MaskId = number;                        // wasm-side BitMask handle

export interface Plane { normal: vec3; offset: number }   // keep side: dot(normal, x) + offset >= 0
export interface Aabb { min: vec3; max: vec3 }
export interface WorkerRef { readonly id: number }        // opaque; the engine owns the Worker

// Mirrors protocol `Phase` (§6.5). Duplicated deliberately: scene/types.ts has zero imports.
export type LoadPhase = 'read' | 'inflate' | 'parse' | 'topology' | 'index' | 'upload';

export type ColormapName =
  | 'gray' | 'viridis' | 'plasma' | 'inferno' | 'magma' | 'cividis' | 'turbo' | 'jet'
  | 'hot' | 'cool' | 'bone' | 'coolwarm' | 'bwr' | 'freesurfer-heat'
  | 'blue-cyan';                                    // default negative branch (§7.6)
```

### 4.2 Scalar display model

```ts
export type Scale =
  | { kind: 'linear'; lo: number; hi: number }
  | { kind: 'heat'; min: number; mid: number; max: number;
      truncate: boolean; inverse: boolean; negative: 'mirror' | 'hide' | 'separate' };

export interface Threshold {
  lo: number; hi: number;
  symmetric: boolean;                 // compare |v| instead of v
  mode: 'hide' | 'clamp';
  softBins: number;                   // §7.0.5: alpha ramps over this fraction of [lo,hi]; 0 = hard discard
}

export type PercentileKey = '0.1' | '1' | '2' | '5' | '50' | '95' | '98' | '99' | '99.9';

export interface Stats {                            // always in PHYSICAL units (post scl_slope/scl_inter)
  min: number; max: number; mean: number;
  percentiles: Record<PercentileKey, number>;
  histogram: Uint32Array;                           // 256 bins over [histogramLo, histogramHi]
  histogramLo: number; histogramHi: number;
}

export interface LabelEntry { id: number; name: string; color: vec4 }   // color components 0..255
export interface LabelTable { entries: LabelEntry[]; byId: Map<number, LabelEntry> }
```

`LabelTable` is keyed by id, never indexed by id — SimNIBS/FreeSurfer ids are sparse and reach 530 `[DATA]`.

### 4.3 Datasets

```ts
export type GpuScalarFormat = 'R8' | 'R8UI' | 'R16' | 'R16UI' | 'R16F' | 'R32F' | 'RGBA8';
export interface GpuFormatInfo {
  format: GpuScalarFormat;
  scale: number; offset: number;      // physical = raw * scale + offset
  filterable: boolean;                // LINEAR is legal on this format on this GPU
  chunked: boolean;                   // uploaded as z-slabs (§7.3)
}

export interface VolumeDataset {
  kind: 'volume'; id: DatasetId; name: string; path?: string;
  dims: vec3; nvols: number;
  affine: mat4; inverseAffine: mat4; spacing: vec3; bounds: Aabb;
  dtype: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64' | 'rgb24' | 'rgba32';
  data: TypedArray;                   // RAW on-disk samples, nx*ny*nz*nvols, i fastest. Kept on the UI thread
                                      // for probes only; never re-sent to a worker.
  sclSlope: number; sclInter: number;  // identity (1, 0) when the header says no scaling
  isLabel: boolean;
  labelIds?: Uint32Array;             // sorted unique ids, present iff isLabel
  denseIndexOf?: Uint32Array;         // id -> dense index (0..labelIds.length-1), present iff isLabel
  labelTable?: LabelTable;
  stats: Stats;
  units?: string;
  gpu: GpuFormatInfo;                 // GPU *description*; the WebGLTexture lives in engine-private GpuResources
  headerJson: string;                 // every raw header field, for the UI header panel
  toTemplate?: { name: 'MNI152' | 'MNI305'; kind: 'affine'; matrix: mat4 };
  worker: WorkerRef; handle: Handle;
}

export interface MeshFieldInfo {
  name: string; source: 'node' | 'elm'; ncomp: 1 | 3 | 9; n: number;
  units?: string; partial: boolean;   // true when the file left gaps (filled with NaN, §6.2)
  stats: Stats;                       // of the magnitude when ncomp > 1
}
export interface MeshTag { id: number; name?: string; color: vec4; kind: 'tri' | 'tet'; count: number }
export interface OrientReport {
  components: number; openComponents: number; nonManifoldEdges: number; flippedComponents: number;
}
export interface MshOptions {
  tagColor: Record<number, vec4>;
  tagVisible: Record<number, boolean>;
  views: { name?: string; customMin?: number; customMax?: number; rangeType?: number;
           saturateValues?: boolean; colormapNumber?: number; showScale?: boolean; vectorType?: number }[];
}

export interface MeshDataset {
  kind: 'mesh'; id: DatasetId; name: string; path?: string;
  transform: mat4; bounds: Aabb;
  nNodes: number; nTris: number; nTets: number; hasTris: boolean;
  fields: MeshFieldInfo[];
  tags: MeshTag[];
  skipped: { elemType: number; count: number }[];
  opt?: MshOptions;
  orient: OrientReport;
  topologyBuilt: boolean;             // set by the buildTopology op (§6.5)
  worker: WorkerRef; handle: Handle;
}

export type Dataset = VolumeDataset | MeshDataset;
```

**Mesh bulk arrays never reach the UI thread.** Nodes/tets/tris/fields stay in the dataset's worker; the UI thread
sees only draw-ready buffers (uploaded to GL, then dropped) and probe results.

### 4.4 Layers

```ts
export interface LayerBase {
  id: LayerId; datasetId: DatasetId; name: string;
  visible: boolean; opacity: number; pickable: boolean; showColorbar: boolean;
}

export interface VolumeLayer extends LayerBase {
  kind: 'volume';
  volumeIndex: number;                                  // 0 unless nvols > 1
  colormap: ColormapName | string;                      // string = user .json colormap id (§7.6)
  colormapNegative?: ColormapName | string;
  scale: Scale; threshold: Threshold;
  interpolation: 'linear' | 'nearest';                  // forced to 'nearest' when dataset.isLabel
  labelMode: 'fill' | 'outline' | 'both';
  outlineWidthPx: number;                               // render-target px (§7.0.5)
  visibleLabels?: Uint32Array;                          // undefined = all
  labelOpacity?: Record<number, number>;
  showIn3D: boolean;
  precision: 'auto' | 'f32';                            // 'f32' forces R32F, guarded by caps.floatLinear
}

export interface ClipPlane { plane: Plane; enabled: boolean }

export interface IsolateSpec {
  tags?: number[];
  field?: { source: 'node' | 'elm'; name: string; component: 'mag' | 0 | 1 | 2; lo: number; hi: number };
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
  colorBy: 'magnitude' | 'solid'; color: vec4;
  clipToCutPlane: boolean;
}

export interface MeshLayer extends LayerBase {
  kind: 'mesh';
  colorMode: 'tag' | 'field' | 'solid' | 'label';
  solidColor: vec4;
  field?: { source: 'node' | 'elm'; name: string; component: 'mag' | 0 | 1 | 2 };
  label?: { name: string; table: LabelTable; mode: 'fill' | 'outline' | 'both';
            outlineWidthPx: number; visibleLabels?: Uint32Array };
  colormap: ColormapName | string; colormapNegative?: ColormapName | string;
  scale: Scale; threshold: Threshold;
  tagStyle: Record<number, { visible: boolean; opacity: number; color?: vec4 }>;
  edges: { surface: boolean; caps: boolean };
  edgeColor: vec4; edgeWidthPx: number;
  flatShading: boolean;
  faceMode: 'cull' | 'both';                            // 'both' forced when orient.openComponents > 0
  clip: { planes: ClipPlane[] /* max 6 */; caps: boolean; capColorMode: 'inherit' | 'tag' };
  isolate?: IsolateSpec;
  glyphs?: GlyphSpec;
  contoursIn2D: boolean; contourWidthPx: number; fillIn2D: boolean;
}

export interface IsosurfaceLayer extends LayerBase {
  kind: 'iso';
  source: { datasetId: DatasetId; volumeIndex?: number;
            field?: { source: 'node' | 'elm'; name: string; component: 'mag' | 0 | 1 | 2 } };
  iso: number; color: vec4; smooth: boolean; faceMode: 'cull' | 'both';
}

export interface PointsLayer extends LayerBase {
  kind: 'points';
  points: { name?: string; position: vec3; color?: vec4; radiusMm?: number }[];
  shape: 'sphere' | 'dot'; radiusMm: number; color: vec4; showLabels: boolean;
}

export type Layer = VolumeLayer | MeshLayer | IsosurfaceLayer | PointsLayer;
```

Layers are ordered bottom→top and appear in every view unless `SliceView.layerVisibility` / `View3D.layerVisibility`
says otherwise.

### 4.5 Views, layout, scene

```ts
export type SliceMode = 'axial' | 'coronal' | 'sagittal' | 'oblique';

export interface SliceView {
  id: ViewId; mode: SliceMode;
  normal: vec3;                                  // unit, world RAS. Presets lock it (§3).
  up: vec3;                                      // unit, in-plane, screen up.
                                                 // Re-orthogonalised on load: up ← normalize(up − (up·n)n);
                                                 // rejected if |up × n| < 1e-4.
  camera: { center: vec2; mmPerPx: number };     // in-plane pan/zoom, relative to the cursor's projection
  layerVisibility?: Record<LayerId, boolean>;
}
// The plane is DERIVED, never stored: plane = { normal, offset: -dot(normal, scene.cursor) }.
// One source of truth (the cursor) ⇒ cursor sync is identical for canonical and oblique views.

export interface Camera3D {
  target: vec3; distance: number; rotation: quat;
  fovYDeg: number; orthographic: boolean;
  near: number; far: number;                     // near = max(1 mm, fitRadius/1000), far = fitRadius * 8 (§7.2)
}
export interface View3D { id: ViewId; camera: Camera3D; showSlicePlanes: boolean;
                          layerVisibility?: Record<LayerId, boolean> }
export type View = SliceView | View3D;

export type LayoutKind = '1x1' | '1x3' | '1x3-horizontal' | '2x2' | '3d-only';
export interface Layout { kind: LayoutKind; cells: ViewId[] }

export interface Annotations {
  orientationLabels: boolean; cornerInfo: boolean; conventionBadge: true;   // badge is not optional
  scaleBar: boolean; colorbars: boolean; crosshair: boolean;
}

export interface QualityLevel {
  name: 'full' | 'interacting' | 'reduced';
  dprScale: number;                 // 1 = one device pixel per CSS px
  msaa: 0 | 2 | 4;
  edges: boolean;
  capDecimation: number;            // 1 = exact
  oit: boolean;
}

export interface Scene {
  version: 1;
  datasets: Map<DatasetId, Dataset>;
  layers: Layer[];                                  // bottom → top
  activeLayerId: LayerId | null;
  slices: SliceView[];                              // independent of layout, so '3d-only' keeps plane state
  view3d: View3D;
  layout: Layout;
  cursor: vec3;
  hover: vec3 | null;
  radiological: boolean;
  background: vec4;
  lighting: { ambient: number; headlight: boolean };
  annotations: Annotations;
  transparency: { mode: 'twoPhase' | 'sorted' | 'peel'; peelLayers?: number };
  quality: QualityLevel;
}
```

`Scene` is the **runtime** graph: it holds TypedArrays, GPU handles and worker handles, and is *not*
JSON-serialisable. GL objects live in an engine-private map keyed by `DatasetId`, declared in
`packages/engine/src/gl/resources.ts` (not part of the frozen `scene/types.ts`):

```ts
export interface GpuResources {
  volumeTexture?: WebGLTexture;      // one 3D texture per (dataset, selected 4D index)
  paletteTexture?: WebGLTexture;     // N×1 RGBA8, label datasets only
  nodeFieldTexture?: WebGLTexture;   // 2D R32F, mesh datasets — cap interpolation + de-indexed field lookup
  indexed?: MeshGeometry; deindexed?: MeshGeometry;
  capBuffers?: [MeshGeometry, MeshGeometry];   // double-buffered, grown by doubling (§7.4)
}
export interface MeshGeometry { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[];
                                perTag: { tag: number; first: number; count: number }[];
                                cacheKey: string /* `${datasetId}|${maskId ?? ''}|${clipStateHash}` */ }
```

### 4.6 ViewSpec — the persisted form (`*.tetravox.json`)

```ts
export interface DatasetRef {
  id: DatasetId; kind: 'volume' | 'mesh'; name: string;
  path: string;                     // relative to the scene file
  absPath?: string;                 // fallback when the relative path misses
  fingerprint: string;              // "<size>-<sha256 of first 1 MiB>-<sha256 of last 1 MiB>", 16 hex each
}
export type SerializableLayer =
  Omit<Layer, 'visibleLabels'> & { visibleLabels?: number[]; label?: { name: string; mode: string;
                                   outlineWidthPx: number; visibleLabels?: number[] } };

export interface ViewSpec {
  version: 1;
  datasets: DatasetRef[];
  layers: SerializableLayer[];
  activeLayerId: LayerId | null;
  slices: SliceView[]; view3d: View3D; layout: Layout;
  cursor: vec3; radiological: boolean; background: vec4;
  lighting: Scene['lighting']; annotations: Annotations;
  transparency: Scene['transparency'];
}
```

`LabelTable`s are **not** serialised; they are re-derived from the dataset and its LUT on load. A missing dataset
opens a "relocate" dialog keyed on `fingerprint`.

### 4.7 Engine facade

`packages/engine/src/api.ts` is exactly this interface. Frozen at the end of Phase 0. `MockEngine` implements it
with no GL so the app agent can build the entire UI in Phase 1. It imports exactly two things — the §4.1–§4.6
types from `./scene/types` and `Capabilities` from `./gl/caps` (§7.1) — and nothing else.

```ts
export type DatasetSource =
  | { kind: 'path'; path: string }
  | { kind: 'file'; file: File }
  | { kind: 'bytes'; name: string; bytes: ArrayBuffer };

export type NewLayer = { datasetId: DatasetId; kind: Layer['kind'] } & Partial<Layer>;

export interface PickResult {
  layerId: LayerId; datasetId: DatasetId;
  elementId: number;                            // Gmsh element number, or plane index for slice quads
  elementKind: 'tri' | 'tet' | 'slice';
  world: vec3; depth: number;
}
export interface ProbeRow {
  layerId: LayerId; layerName: string; kind: Layer['kind'];
  voxel?: vec3; value?: number | vec3;
  labelId?: number; labelName?: string;
  elementId?: number; tag?: number; tagName?: string;
  fields?: { name: string; value: number | number[] }[];
}
export interface ProbeResult { world: vec3; mni?: vec3; rows: ProbeRow[] }

export interface ScreenshotOptions {
  target: 'view' | 'grid'; viewId?: ViewId;
  width?: number; height?: number; scale?: number; dpi?: number;   // dpi written to the PNG pHYs chunk
  background: 'scene' | 'white' | 'transparent';
  include: { colorbar: boolean; orientationLabels: boolean; crosshair: boolean;
             cornerInfo: boolean; scaleBar: boolean };
  autoTrim: boolean;
}

export interface LoadProgress { datasetId: DatasetId; phase: LoadPhase; done: number; total: number }

export interface EngineEvents {
  cursor: vec3;
  hover: vec3 | null;
  pick: PickResult | null;
  layers: Layer[];
  datasets: Dataset[];
  progress: LoadProgress;
  frame: { viewId: ViewId; cpuMs: number; gpuMs?: number; quality: QualityLevel['name'] };
  quality: QualityLevel;
  error: { code: string; message: string; datasetId?: DatasetId };
}

export interface EngineOptions {
  dpr?: number; deterministic?: boolean;        // deterministic: fixed clock, no timer query, sync render (§11)
  forceDiscardClip?: boolean;                   // §7.4 fallback-path test axis
  aa?: 'auto' | 'off';
}

export interface Engine {
  readonly caps: Capabilities;                  // §7.1
  readonly scene: Readonly<Scene>;
  readonly views: ReadonlyArray<View>;

  addDataset(src: DatasetSource): Promise<Dataset>;
  removeDataset(id: DatasetId): void;           // terminates that dataset's worker (§5)
  cancelDataset(id: DatasetId): void;           // cancels an in-flight load

  addLayer(spec: NewLayer): Layer;
  removeLayer(id: LayerId): void;
  updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void;
  reorderLayers(order: LayerId[]): void;
  setActiveLayer(id: LayerId | null): void;

  setCursor(world: vec3): void;
  stepCursor(viewId: ViewId, steps: number): void;   // ±1 voxel along the view normal (§7.5)
  setLayout(layout: Layout): void;
  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void;
  setRadiological(on: boolean): void;

  pick(viewId: ViewId, px: number, py: number): PickResult | null;
  setCursorFromPick(viewId: ViewId, px: number, py: number): boolean;
  probe(world: vec3): ProbeResult;

  requestRender(viewId?: ViewId): void;
  whenSettled(): Promise<void>;                 // §7.2 — every golden test awaits this
  screenshot(opts: ScreenshotOptions): Promise<Blob>;
  readPixel(viewId: ViewId, px: number, py: number): Uint8Array;   // RGBA8, backs expectPixel (§11)

  serialize(): ViewSpec;
  load(spec: ViewSpec, resolve: (r: DatasetRef) => string | null): Promise<void>;

  on<E extends keyof EngineEvents>(e: E, cb: (p: EngineEvents[E]) => void): () => void;
  destroy(): void;
}

export function create(canvas: HTMLCanvasElement, opts?: EngineOptions): Engine;
```

---

## 5. Process / thread architecture

```
┌──────────────────── Electron main ─────────────────────┐
│ protocol.registerSchemesAsPrivileged([{ scheme:        │
│   'tetravox', privileges:{ standard, secure,           │   ipc (small JSON only):
│   supportFetchAPI, stream, corsEnabled }}])            │   openDialog() -> string[]
│ protocol.handle('tetravox', …)                         │   getDroppedFilePath(File) -> string
│   tetravox://app/…   renderer bundle + *_bg.wasm       │   menu / window / CLI argv
│                      (content-type: application/wasm)  │
│   tetravox://file/<percent-encoded absolute path>      │
│                      streaming Response over the disk  │
│ win.loadURL('tetravox://app/index.html')  — NEVER loadFile()
│ app.commandLine.appendSwitch('enable-unsafe-swiftshader')
│ app.commandLine.appendSwitch('enable-webgl-developer-extensions')
└───────────────────────────┬────────────────────────────┘
                            │ contextBridge (preload)
┌───────────────────────────▼────────────────────────────┐
│ Renderer (UI thread)                                   │        postMessage (transferables)
│  React chrome · @tetravox/engine (WebGL2)              │◄──────────────────────────────────────┐
│  holds: GPU textures/VBOs, VolumeDataset.data (probes) │                                       │
│  holds: NO mesh bulk arrays, NO raw file bytes         │                                       │
└────────────────────────────────────────────────────────┘                                       │
        ▲ spawns one worker per dataset                                                          │
        │                                                                                        │
┌───────┴────────────────────────────────────────────────────────────────────────────────────────┴───┐
│ dataset worker  (module Worker under the tetravox:// origin, one wasm instance)                     │
│   fetch('tetravox://file/…')  →  DecompressionStream('gzip') when .gz  →  Uint8Array  →  WASM       │
│   owns exactly one parsed dataset by handle. Closing the dataset = worker.terminate().              │
│   ops: §6.5.  progress + cancel are part of the protocol.                                           │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rules:

1. **Worker-per-dataset.** Each volume or mesh gets its own Web Worker and its own WASM instance.
   `removeDataset(id)` ⇒ `worker.terminate()`. That is the only way to give wasm linear memory back:
   `WebAssembly.Memory` has `grow` and no shrink (`Object.getOwnPropertyNames(WebAssembly.Memory.prototype)` =
   `['constructor','grow','buffer']` `[N25]`), and Rust's wasm dlmalloc keeps freed pages, so a worker's
   high-water mark is permanent for its lifetime.
2. **No utility worker in v1.** Directive A1 permits one for cross-dataset ops. The only cross-dataset op is
   `isolate` with a `labelVolume` criterion, and it is evaluated in the *mesh* worker from a transferred copy of
   the label volume the UI thread already holds for probes (27 MB for `final_tissues.nii.gz` `[DATA]`), which is
   cheaper than shipping 4.7 M tet centroids (56 MB) the other way. A second cross-dataset op gets the utility
   worker, and that is an ARCHITECTURE.md edit.
3. **Bytes never cross IPC and never touch the UI thread.** Electron IPC serialises with structured clone over
   Mojo and *copies* ArrayBuffers — only `MessagePort` transfers across processes. IPC carries dialogs, menus,
   paths and CLI args. The worker fetches `tetravox://file/…` itself.
4. **Gzip in the worker.** `.gz` is inflated with a streaming `DecompressionStream('gzip')` piped from the fetch
   body. The Rust readers *also* sniff `1f 8b` and inflate with `flate2`'s rust backend, so the crates stay usable
   natively/CLI and in plain-browser mode (where the source is a `File`/`ArrayBuffer`).
5. **Input bytes are copied into WASM once** and the input buffer is dropped before the parser returns; the
   inflate output is dropped too (§6.2).
6. **Latest-wins** is keyed on the caller-supplied opaque `key` (`"${layerId}:cut"`). It drops *queued* requests.
   An in-flight WASM call **runs to completion** — WASM is not preemptible. Ops that can exceed one frame
   (`loadVolume`, `loadMesh`, `buildTopology`, `marchingCubes`, `marchingTets`) poll an abort flag at section
   boundaries (every ~1 M records) so `cancel(requestId)` is honoured; sub-frame ops (`cut`, `isolate`, `locate`,
   `contours`) simply finish.
7. **Results are owned buffers, never views.** See §6.4.
8. A wasm `panic!` or `Error::OutOfMemory` poisons the module: the client tears down the worker, marks the
   dataset failed, and emits `error`. It never retries into the same instance.

---

## 6. Rust crates — public API contract

`unimplemented!()` stubs with exactly these signatures compile at the end of Phase 0 (§12.3).

Crate dependency direction (no cycles): `tvx-core` ← `tvx-nifti` ← `tvx-geom`; `tvx-core` ← `tvx-mesh-io` ←
`tvx-geom`; `tvx-wasm` depends on all four. `tvx-geom` uses `tvx_nifti::{Volume, VolumeData}` for
`marching_cubes`, `label_centroids` and the `label_volume` isolation criterion, and
`tvx_mesh_io::{Mesh, ElmField}` throughout.

### 6.0 `tvx-core` — shared types

```rust
pub struct Plane { pub normal: [f32; 3], pub offset: f32 }          // keep side: normal·x + offset >= 0

pub struct BitMask { bits: Vec<u64>, len: usize }
impl BitMask {
    pub fn new_all(len: usize, value: bool) -> Self;
    pub fn get(&self, i: usize) -> bool;
    pub fn set(&mut self, i: usize, v: bool);
    pub fn count_ones(&self) -> usize;
    pub fn len(&self) -> usize;
    pub fn as_bytes(&self) -> &[u8];
    pub fn from_bytes(len: usize, bytes: &[u8]) -> Result<Self>;
}

pub struct FieldStats {
    pub min: f32, pub max: f32, pub mean: f64,
    pub percentiles: [f32; 9],      // 0.1, 1, 2, 5, 50, 95, 98, 99, 99.9  (fixed order)
    pub histogram: [u32; 256],
    pub histogram_lo: f32, pub histogram_hi: f32,
}
pub const PERCENTILES: [f32; 9] = [0.1, 1.0, 2.0, 5.0, 50.0, 95.0, 98.0, 99.0, 99.9];

pub struct Field {
    pub name: String,
    pub ncomp: usize,               // 1 | 3 | 9
    pub data: Vec<f32>,             // n * ncomp, row-major
    pub units: Option<String>,
    pub partial: bool,              // gaps filled with NaN (§6.2)
    pub stats: FieldStats,          // of the magnitude when ncomp > 1
}

pub struct LabelEntry { pub id: u32, pub name: String, pub color: [u8; 4] }
pub struct LabelTable { pub entries: Vec<LabelEntry> }
impl LabelTable {
    pub fn get(&self, id: u32) -> Option<&LabelEntry>;
    pub fn parse_freesurfer(text: &str) -> Result<Self>;   // FreeSurferColorLUT.txt
    pub fn parse_simnibs(text: &str) -> Result<Self>;      // "#No. Label Name: R G B A"
    pub fn parse_itksnap(text: &str) -> Result<Self>;
    pub fn parse_generic(text: &str) -> Result<Self>;      // "id r g b [a] [name]"
}

pub struct Aabb { pub min: [f32; 3], pub max: [f32; 3] }

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("parse: {0}")]        Parse(String),
    #[error("unsupported: {0}")]  Unsupported(String),
    #[error("io: {0}")]           Io(String),
    #[error("out of memory: {0}")] OutOfMemory(String),
    #[error("cancelled")]         Cancelled,
}
pub type Result<T> = std::result::Result<T, Error>;

/// Progress + cancellation. Implemented by tvx-wasm over a js_sys::Function and an AtomicBool;
/// `NoProgress` is the native/CLI no-op implementation.
pub trait ProgressSink {
    fn report(&mut self, phase: Phase, done: u64, total: u64);
    fn aborted(&self) -> bool;
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase { Read, Inflate, Parse, Topology, Index, Upload }
pub struct NoProgress;
impl ProgressSink for NoProgress { /* report: no-op, aborted: false */ }
```

### 6.1 `tvx-nifti`

```rust
pub enum DataType { U8, I8, U16, I16, U32, I32, F32, F64, Rgb24, Rgba32 }
pub enum VolumeData { U8(Vec<u8>), I8(Vec<i8>), U16(Vec<u16>), I16(Vec<i16>),
                      U32(Vec<u32>), I32(Vec<i32>), F32(Vec<f32>), F64(Vec<f64>),
                      Rgb24(Vec<u8>), Rgba32(Vec<u8>) }

pub struct Volume {
    pub dims: [usize; 3], pub nvols: usize,
    pub affine: [[f64; 4]; 4], pub spacing: [f64; 3],
    pub datatype: DataType, pub data: VolumeData,       // RAW samples; slope/inter NOT applied
    pub scl_slope: f32, pub scl_inter: f32,             // normalised to (1.0, 0.0) when inapplicable
    pub cal_min: f32, pub cal_max: f32,
    pub intent_code: i16, pub intent_name: String, pub descrip: String,
    pub xyz_units: Units, pub is_label: bool,   // Units { space: SpaceUnit, time: TimeUnit }
    pub header_json: String,
}

pub struct GpuPayload { pub format: GpuFormat, pub bytes: Vec<u8>, pub scale: f32, pub offset: f32,
                        pub filterable: bool }
pub enum GpuFormat { R8, R8Ui, R16, R16Ui, R16F, R32F, Rgba8 }
pub struct GpuCaps { pub float_linear: bool, pub norm16: bool, pub max_3d: u32 }

pub struct Units { pub space: SpaceUnit, pub time: TimeUnit }
pub enum SpaceUnit { Unknown, Meter, Millimeter, Micron }
pub enum TimeUnit  { Unknown, Second, Millisecond, Microsecond, Hz, Ppm, Rads }

pub struct LabelIndex { pub ids: Vec<u32>, pub dense_of: Vec<u32> }   // dense_of[id] -> index; cap 65535

pub fn read_nifti(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume>;

impl Volume {
    pub fn stats(&self, vol: usize) -> FieldStats;                    // PHYSICAL units
    pub fn label_index(&self, vol: usize) -> Result<LabelIndex>;
    pub fn gpu_payload(&self, vol: usize, caps: &GpuCaps, want_linear: bool) -> Result<GpuPayload>;
    pub fn sample_nearest(&self, vol: usize, world: [f32; 3]) -> Option<f32>;   // physical units
}
```

Rules:

* **Formats:** NIfTI-1 (348) and NIfTI-2 (540), `.nii`/`.nii.gz` (magic sniff), little- and big-endian.
  Accepted datatypes: uint8, int8, uint16, int16, uint32, int32, float32, float64 (→ f32 at GPU time only),
  RGB24, RGBA32. `Error::Unsupported` **by name** for complex64/128, int64 (1024), uint64 (1280).
  Two-file `ni1` (`.hdr`/`.img`) ⇒ `Error::Unsupported("two-file NIfTI")`.
* **Scaling is never folded.** Apply slope/inter only when
  `slope.is_finite() && slope != 0.0 && inter.is_finite() && (slope != 1.0 || inter != 0.0)`; otherwise normalise
  to `(1.0, 0.0)`. The affine is carried in `GpuPayload{scale, offset}` and applied as `v = raw*scale + offset`
  in the fragment shader and in the probe path. Widening to f32 happens only for `float64` input and
  `RGB24 → RGBA8`.
  *Correction to the review:* the reviewer's "`scl_slope` is NaN in T1.nii.gz and T1_upsampled.nii.gz" is an
  artefact of reading `nib.load(p).header` — `Nifti1Image.from_file_map` calls `set_slope_inter(None, None)`
  after handing scaling to the array proxy. On disk `[DATA]`: `T1.nii.gz` slope 1.0 / inter 0.0;
  `label_prep/T1_upsampled.nii.gz` slope 1.0041254758834839 / inter 32903.18359375. The NaN guard stays — NaN
  slopes do occur in the wild — but no reference file exercises it, so the fixture must.
* **`is_label`** = all sample values integral ∧ min ≥ 0 ∧ (`intent_code == 1002` ∨ unique count ≤ 4096).
  **The dtype must not be part of the test**: `m2m_ernie/segmentation/labeling.nii.gz` is float32 with 57 integral
  unique values spanning 0…530 `[DATA]` and is a genuine atlas.
* **Stats** are exact: one O(n) pass into a 65536-bin histogram over `[min, max]` gives the percentiles
  (exact for integer dtypes, ≤ 1/65536 relative error for float); the 256-bin display histogram is derived from
  it. No sampling — sampling is not deterministic.
* **`gpu_payload` selection ladder, first match wins:**

  | # | Input | Format | Filter | Note |
  |---|---|---|---|---|
  | 1 | `is_label`, `max_dense_index ≤ 255` | `R8UI` | NEAREST | dense index remap, not raw id |
  | 2 | `is_label`, `≤ 65535` | `R16UI` | NEAREST | `> 65535` ⇒ `Error::Unsupported` |
  | 3 | u8 / i8 | `R8` | LINEAR | normalised, scale/offset to physical |
  | 4 | u16 / i16, `caps.norm16` | `R16` | LINEAR | `scale=(max−min)/65535`, `offset=min`; exact for any 16-bit input |
  | 5 | u16 / i16, `caps.float_linear` | `R32F` | LINEAR | |
  | 6 | u16 / i16, neither | `R8` | LINEAR | "reduced precision" flag in the status bar. **Never `R16UI`** for a non-label layer — that is the silent black-slice case |
  | 7 | u32 / i32, `caps.norm16` | `R16` | LINEAR | display only; probes read the CPU array |
  | 8 | f32 / f64, finite range, `caps.norm16` | `R16` | LINEAR | normalised over exact `[min,max]`, no clamping; uniform 1/65535 relative step |
  | 9 | f32 / f64 with NaN/Inf, or `precision:'f32'`, `caps.float_linear` | `R32F` | LINEAR | |
  | 10 | RGB24 / RGBA32 | `RGBA8` | LINEAR | |

  `R16F` stays in the enum only as a fallback for float data whose range **and** precision have both been
  checked. It is **not** the default: `T1.nii.gz`'s max is exactly 65535.0 `[DATA]` and half-float's largest
  finite value is 65504, so it becomes `+Inf`; half-float is also inexact above 2048.
  `want_linear` is false when the layer is a label or `interpolation === 'nearest'`.
* Volumes whose `max(dims) > caps.max_3d` (2048 `[M2Max]`, spec floor 256) fail loudly at load with a downsample
  offer — never a silently incomplete texture at draw time.

### 6.2 `tvx-mesh-io`

```rust
pub struct ElmField { pub name: String, pub ncomp: usize,
                      pub tri: Vec<f32>, pub tet: Vec<f32>,        // split by element kind, row-major
                      pub units: Option<String>, pub partial: bool,
                      pub stats: FieldStats }

pub struct Mesh {
    pub nodes: Vec<[f32; 3]>,
    pub tris: Vec<[u32; 3]>,  pub tri_tags: Vec<i32>,
    pub tets: Vec<[u32; 4]>,  pub tet_tags: Vec<i32>,
    pub tri_edge_mask: Option<Vec<u8>>,        // low 3 bits per tri; Some only from n-gon triangulation
    pub node_fields: Vec<Field>,
    pub elm_fields: Vec<ElmField>,
    pub physical_names: Vec<(i32, String)>,
    pub gmsh_node_numbers: Option<Vec<u64>>,
    pub gmsh_elm_numbers: Option<Vec<u64>>,    // per element, in (tris then tets) order
    pub tet_perm: Vec<u32>,                    // Morton order -> original file row (§6.3)
    pub skipped: Vec<(u32, u64)>,              // (gmsh element type, count) for types we drop
    pub bounds: Aabb,
}

pub struct MshOptions {
    pub tag_color: Vec<(i32, [u8; 4])>,
    pub tag_visible: Vec<(i32, bool)>,
    pub views: Vec<MshView>,
}
pub struct MshView { pub name: Option<String>, pub custom_min: Option<f32>, pub custom_max: Option<f32>,
                     pub range_type: Option<i32>, pub saturate_values: Option<bool>,
                     pub colormap_number: Option<i32>, pub show_scale: Option<bool>,
                     pub vector_type: Option<i32> }

pub fn read_msh(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Mesh>;
pub fn read_msh_opt(bytes: &[u8]) -> Result<MshOptions>;
pub fn read_gifti(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Mesh>;
pub fn read_fs_surface(bytes: Vec<u8>) -> Result<Mesh>;
pub fn read_fs_curv(bytes: &[u8]) -> Result<Field>;
pub fn read_fs_annot(bytes: &[u8]) -> Result<(Field, LabelTable)>;   // Field = DENSE 0..N-1 indices
pub fn read_stl(bytes: Vec<u8>) -> Result<Mesh>;
pub fn read_ply(bytes: Vec<u8>) -> Result<Mesh>;
pub fn read_obj(bytes: Vec<u8>) -> Result<Mesh>;
pub fn sniff(bytes: &[u8], hint_ext: Option<&str>) -> Result<Format>;
pub enum Format { Msh, Gifti, FsSurface, Stl, Ply, Obj }
```

**Gmsh v2 binary layout (the SimNIBS default, header `2.2 1 8`) — normative:**

* `$Nodes` records are `i32 id + 3×f64`. `$Elements` blocks are `[elm_type: i32, count: i32, n_tags: i32]`
  followed by `count` records of `i32 id + n_tags×i32 + nodes_per_type×i32`. The skip for an unsupported type is
  `count × (1 + n_tags + nodes_per_type) × 4` bytes. (SimNIBS's own reader hard-codes 2 tags into a 3 — do not
  copy it.)
* `$NodeData`/`$ElementData` records are `i32 id + ncomp×f64` (`data-size 8`). Header tag counts are variable:
  read `n_string_tags` / `n_real_tags` / `n_integer_tags` and skip the extras (SimNIBS writes 1/1/4; Gmsh may
  write 2 string tags for an interpolation scheme). `ncomp = integer_tags[1]`, `nr = integer_tags[2]`;
  `integer_tags[0]` is the time-step index and `> 1` step ⇒ `Error::Unsupported`.
* Values are read as f64 and narrowed to f32 **streaming, per block** — never "read all f64 then map".
* Ids are 1-based and may be non-contiguous. **Scatter by id** through an `elm_number → index` map (fast path
  when ids are exactly `1..N`, which is the SimNIBS case `[DATA]`); positional order is not guaranteed by the
  format and is wrong for cropped meshes. Gaps ⇒ `f32::NAN` and `partial = true`.
* Only element types 2 (tri3) and 4 (tet4) are kept in v1; everything else is counted into `skipped`, not an error.
* `read_msh` **takes ownership of the byte vector and frees it (and any inflate output) before returning.**
* Tag names and colours, in order: `$PhysicalNames` → sibling `<mesh>_LUT.txt` (SimNIBS
  `#No.\tLabel Name:\tR G B A`) → sibling `<mesh>.msh.opt` (`Physical Volume(" GM",2)` + `Mesh.Color.<Ordinal>`)
  → deterministic glasbey-like palette. Rule: **surface tag `1xxx` inherits the colour of volume tag `1xxx − 1000`**.
* Gmsh 4.1 ascii+binary is supported; there is no local reference implementation (SimNIBS refuses v4), so its
  fixtures must be generated with `~/Applications/SimNIBS-4.6/bin/gmsh` (recorded in DECISIONS).

**GIfTI:** XML via `quick-xml`. `Encoding` ∈ {`ASCII`, `Base64Binary`, `GZipBase64Binary`}; `ExternalFileBinary`
⇒ `Error::Unsupported` (the byte-slice signature has no sibling-file access). **`GZipBase64Binary` is a zlib
stream, not gzip — use `ZlibDecoder`, not `GzDecoder`.** Honour `Endian` and `ArrayIndexingOrder`
(Row/ColumnMajorOrder); apply `CoordinateSystemTransformMatrix` when
`TransformedSpace == NIFTI_XFORM_SCANNER_ANAT`, and record `DataSpace`/`TransformedSpace` in the dataset.
`.func/.shape/.label.gii` become node `Field`s keyed by `Intent`; `<LabelTable>` becomes a `LabelTable`.
Reference files use `GZipBase64Binary` / `LittleEndian` / `RowMajorOrder`, `DataSpace = NIFTI_XFORM_UNKNOWN`,
`TransformedSpace = NIFTI_XFORM_SCANNER_ANAT` `[DATA]`.

**FreeSurfer:** triangle-file magic is `0xFFFFFE` **big-endian**, coordinates big-endian f32; the quad file is
also read. `read_fs_curv` reads the new format (magic `0xFFFFFF`). `read_fs_annot` remaps packed-RGB annotation
values to **dense 0..N−1** through the embedded colortable at parse time and returns that colortable, with
`originalId` preserved in `LabelEntry.id` — a 256×1 LUT cannot address raw annotation values. Unassigned vertices
(`-1`) map to dense index 0 with a transparent entry.

Loaders that triangulate n-gons (`read_fs_surface` quad file, `read_ply`, `read_obj`) must emit a matching
`tri_edge_mask`. `read_msh` and `read_stl` emit `None`, which the engine maps to the constant-attribute fast path.

**Performance target:** `ernie.msh` (184,207,351 B = 175.7 MiB, 847,165 nodes, 1,177,213 tris, 4,722,625 tets
`[DATA]`) parses in **< 1.5 s** native, **< 3 s** WASM.

### 6.3 `tvx-geom`

```rust
pub enum SurfaceVariant { Indexed, Deindexed }
pub struct TagRange { pub tag: i32, pub first: u32, pub count: u32 }

pub struct SurfaceBuffers {
    pub variant: SurfaceVariant,
    pub positions: Vec<f32>,            // 3 per vertex
    pub normals: Vec<f32>,              // 3 per vertex (smooth for Indexed, face for Deindexed)
    pub indices: Option<Vec<u32>>,      // Some iff Indexed
    pub node_index: Option<Vec<u32>>,   // Some iff Indexed: vertex -> mesh node id (node-field lookup)
    pub corner: Option<Vec<u8>>,        // Some iff Deindexed: 0|1|2 corner ordinal
    pub owner_elm: Vec<u32>,            // 1 per triangle: Gmsh element number
    pub face_tag: Vec<i32>,             // 1 per triangle
    pub edge_mask: Option<Vec<u8>>,     // 1 per triangle, low 3 bits; None = fully unmasked
    pub per_tag: Vec<TagRange>,         // ranges into `indices` (Indexed) or vertices (Deindexed)
    pub orient: OrientReport,
    pub bounds: Aabb,
}
pub struct OrientReport { pub components: u32, pub open_components: u32,
                          pub non_manifold_edges: u64, pub flipped_components: u32 }

pub struct TetTopology { pub faces: Vec<[u32; 3]>, pub face_tets: Vec<[i32; 2]> }
pub struct TetBlocks { pub blk: usize, pub aabb: Vec<f32> }   // 6 f32 per block: (cx,cy,cz, ex,ey,ez)
pub struct PointLocator { cell: [f32; 3], dims: [u32; 3], origin: [f32; 3],
                          starts: Vec<u32>, items: Vec<u32> }

pub struct CutInterp { pub n0: u32, pub n1: u32, pub t: f32 }
pub struct Cut {
    pub plane: usize,                   // index into the `planes` slice
    pub positions: Vec<f32>,            // 3 per vertex, de-indexed triangles
    pub interp: Vec<CutInterp>,         // 1 per vertex
    pub owner_tet: Vec<u32>,            // 1 per triangle: Gmsh element number
    pub tag: Vec<i32>,                  // 1 per triangle
    pub edge_mask: Vec<u8>,             // 1 per triangle, low 3 bits
    pub edge_segments: Vec<f32>,        // 6 per segment — 2D overlay only (§7.4)
    pub boundary_segments: Vec<f32>,    // 6 per segment — tag-boundary contours for the 2D overlay
}

pub struct IsolateCriteria {
    pub tags: Option<Vec<i32>>,
    pub field: Option<FieldRange>,
    pub sphere: Option<([f32; 3], f32)>,
    pub bbox: Option<Aabb>,
    pub label_volume: Option<LabelVolumeCriteria>,
    pub combine: Combine,
}
pub struct FieldRange { pub source: FieldSource, pub name: String, pub component: Component,
                        pub lo: f32, pub hi: f32 }
pub enum FieldSource { Node, Elm }
pub enum Component { Mag, C(u8) }
pub enum Combine { All, Any }
pub struct LabelVolumeCriteria { pub dims: [usize; 3], pub world_to_voxel: [[f64; 4]; 4],
                                 pub data: VolumeData, pub vol_index: usize, pub labels: Vec<u32> }

pub struct LabelCentroid { pub id: u32, pub centroid: [f32; 3], pub count: u64 }

// --- load-time (called inside loadMesh, not exported individually — see §6.4)
pub fn morton_reorder(mesh: &mut Mesh) -> Vec<u32>;                   // returns tet_perm; < 250 ms WASM on ernie
pub fn build_tet_blocks(mesh: &Mesh, blk: usize /* default 64 */) -> TetBlocks;   // < 500 ms WASM on ernie
pub fn build_point_locator(mesh: &Mesh) -> PointLocator;
pub fn orient_surface(nodes: &[[f32; 3]], tris: &mut Vec<[u32; 3]>) -> OrientReport;
pub fn vertex_normals(nodes: &[[f32; 3]], tris: &[[u32; 3]]) -> Vec<f32>;
pub fn face_normals(nodes: &[[f32; 3]], tris: &[[u32; 3]]) -> Vec<f32>;

// --- exported ops (§6.4)
pub fn tag_surfaces(mesh: &Mesh, variant: SurfaceVariant, p: &mut dyn ProgressSink)
    -> Result<SurfaceBuffers>;
pub fn extract_boundary(mesh: &Mesh, topo: Option<&TetTopology>, mask: Option<&BitMask>,
                        variant: SurfaceVariant, p: &mut dyn ProgressSink) -> Result<SurfaceBuffers>;
pub fn build_topology(mesh: &Mesh, p: &mut dyn ProgressSink) -> Result<TetTopology>;
pub fn plane_cut(mesh: &Mesh, blocks: &TetBlocks, planes: &[Plane] /* max 6 */,
                 mask: Option<&BitMask>) -> Result<Vec<Cut>>;
pub fn isolate(mesh: &Mesh, crit: &IsolateCriteria) -> Result<BitMask>;
pub fn elm_to_node(mesh: &Mesh, field: &ElmField) -> Result<Field>;    // volume-weighted mean of adjacent tets
pub fn node_to_elm(mesh: &Mesh, field: &Field) -> Result<ElmField>;
pub fn marching_cubes(vol: &Volume, vol_index: usize, iso: f32, smooth: bool,
                      p: &mut dyn ProgressSink) -> Result<SurfaceBuffers>;
pub fn marching_tets(mesh: &Mesh, node_field: &[f32], iso: f32, mask: Option<&BitMask>,
                     p: &mut dyn ProgressSink) -> Result<SurfaceBuffers>;
pub fn surface_contours(mesh: &Mesh, plane: &Plane, mask: Option<&BitMask>) -> Result<Vec<f32>>;
pub fn locate_point(mesh: &Mesh, grid: &PointLocator, p: [f32; 3]) -> Option<u32>;
pub fn label_centroids(vol: &Volume, vol_index: usize) -> Result<Vec<LabelCentroid>>;
```

Rules:

* **Default 3D representation of a mesh that has surface elements is its own tagged triangles.** SimNIBS
  invariant: the stored tris are exactly the exterior ∪ inter-tissue-interface face set — verified 0 missing /
  0 extra on `ernie.msh` (128,614 exterior + 1,048,599 tag-differing interior = 1,177,213) and on
  `m2m_ernie-seeg/ernie-seeg.msh` (202,318 + 2,427,261 = 2,629,579) `[DATA]`. This is a **real-data test**, so a
  mesh violating it fails loudly instead of rendering a hole. Deriving the same surfaces from tets instead yields
  2,225,812 faces — every interface emitted twice — i.e. 1.89× the geometry for the same picture.
  `tag_surfaces` therefore takes **no topology** and does no geometry work beyond grouping and normals.
* `extract_boundary` serves (a) tri-less tet meshes — `grey_Thalamus_TI.msh` has 1,340,029 tets and **0 tris**
  `[DATA]`, and renders empty without it — and (b) post-isolation / post-clip boundaries. With `topo = None` it
  does a one-shot sort of the 4·N canonical face keys, keeps singletons and tag-differing pairs, and **drops the
  key buffer before returning**.
* **Unique faces without a packed key.** Counting sort on the face's *minimum vertex* into an
  `n_nodes + 1` count array, then sort within buckets on the remaining `(v1, v2)` pair. No packed key, no
  node-count limit: a 3×21-bit u64 key aliases distinct faces on `ernie_seeg.msh` (2,301,899 nodes = 22 bits)
  and `ernie-seeg.msh` (2,323,873 nodes) `[DATA]`, silently merging them as interior and deleting real boundary
  faces. Transient drops from ~453 MB to ~227 MB for ernie `[MODEL]`. `TetTopology` carries no `tet_faces`
  (nothing consumes it; 75.6 MB on ernie `[MODEL]`).
* **`build_topology` is explicit, awaitable and progress-reporting.** It is called eagerly *after the first
  frame*, and only when isolation or clipping needs it — never lazily from inside a drag.
* **Spatial locality at load.** After parsing, tets are reordered by the 30-bit Morton code of their centroid
  (3 × 10-bit radix passes); `tet_tags` and every tet-side `elm_fields` entry are permuted with them.
  `tet_perm` and `gmsh_elm_numbers` preserve the mapping back to `$ElementData` row order and to Gmsh element
  numbers. **The UI always reports Gmsh element numbers, never internal indices.** This is load-bearing: SimNIBS
  writes elements grouped by physical tag, so with file order a per-64-block AABB reject at the mid-axial plane
  visits 4,722,624 of 4,722,625 tets — zero speedup `[M2Max]`.
* `plane_cut` visits a block iff `|n·c + offset| <= ex·|nx| + ey·|ny| + ez·|nz|`, then runs the per-tet kernel on
  survivors: 4 node signs → 1 triangle (1-3 split) or 2 triangles (2-2 split). It takes no topology;
  `boundary_segments` adjacency is built locally over the cut tets only (~30–60 k for ernie).
  With multiple planes, each `Cut` is clipped by the *other* planes. Output must be **bit-identical with and
  without the block index** — a golden test asserts equality on ernie for an axial and an oblique plane
  (62,966 and 67,189 cap triangles `[M2Max]`).
* **`Cut.edge_mask` emission rule (normative).** Bit *i* means "the edge opposite vertex *i* is a real element
  edge". A 1-3 split emits one triangle, mask `0b111`. A 2-2 split emits quad `(a,b,c,d)` in cut-polygon order as
  `(a,b,c)` and `(a,c,d)`; the diagonal is `a–c`, opposite `b` (index 1) in the first ⇒ mask `0b101`, and
  opposite `d` (index 2) in the second ⇒ mask `0b011`. A `cargo test` cuts a single unit tet at a 1-3 and a 2-2
  plane and asserts exactly these masks and that the union of unmasked edges equals the 4 cut-edge segments.
* `tag_surfaces` / `extract_boundary` output on a tet mesh is always fully unmasked (`edge_mask = None`).
* **De-indexing, normal generation and any vertex-buffer expansion are geometry**: they happen here, in the
  worker, and arrive as transferables. The engine never builds a vertex buffer element-by-element.
* `isolate` evaluates `label_volume` by sampling the transferred label volume at tet centroids through
  `world_to_voxel` (nearest).
* **Determinism.** Geometry outputs are byte-identical across native and wasm builds; they use only
  `+ − × ÷ sqrt` and integer ops, which are correctly rounded and identical on both. Any function using a
  transcendental (`sin/cos/exp/pow`) is marked `#[doc(hidden)] // non-portable` and excluded from cross-build
  golden tests. No `HashMap` iteration order appears in any output.

### 6.4 `tvx-wasm` — worker-side exports

```rust
#[wasm_bindgen] pub fn load_volume(bytes: Vec<u8>, on_progress: &js_sys::Function,
                                   abort: &js_sys::Uint8Array) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn load_mesh(bytes: Vec<u8>, format: &str, opt_bytes: Option<Vec<u8>>,
                                 on_progress: &js_sys::Function,
                                 abort: &js_sys::Uint8Array) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_surface(handle: u32, mask_id: Option<u32>, variant: &str) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_boundary(handle: u32, mask_id: Option<u32>, variant: &str) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_build_topology(handle: u32, on_progress: &js_sys::Function,
                                           abort: &js_sys::Uint8Array) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_cut(handle: u32, planes: &[f32] /* 4 per plane */, mask_id: Option<u32>,
                                out: Option<CutOut>) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_isolate(handle: u32, criteria_json: &str,
                                    label_volume: Option<Vec<u8>>) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_field(handle: u32, source: &str, name: &str,
                                  component: &str) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_convert_field(handle: u32, direction: &str, source_name: &str)
                                         -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_locate(handle: u32, x: f32, y: f32, z: f32) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn volume_marching_cubes(handle: u32, vol_index: u32, iso: f32, smooth: bool,
                                             on_progress: &js_sys::Function,
                                             abort: &js_sys::Uint8Array) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_marching_tets(handle: u32, source: &str, name: &str, component: &str,
                                          iso: f32, mask_id: Option<u32>,
                                          on_progress: &js_sys::Function,
                                          abort: &js_sys::Uint8Array) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_contours(handle: u32, plane: &[f32], mask_id: Option<u32>)
                                    -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn volume_label_centroids(handle: u32, vol_index: u32) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn free(handle: u32);
#[wasm_bindgen] pub fn free_mask(handle: u32, mask_id: u32);
#[wasm_bindgen] pub fn wasm_heap_bytes() -> u32;      // stamped onto every Res (§6.5), backs the §9 memory bar

#[wasm_bindgen] pub struct CutOut { positions: js_sys::Float32Array, interp_n: js_sys::Uint32Array,
                                    interp_t: js_sys::Float32Array, owner_tet: js_sys::Uint32Array,
                                    tag: js_sys::Int32Array, edge_mask: js_sys::Uint8Array }
```

**Rust functions with no wasm export, and why:**

| Rust fn | Reason |
|---|---|
| `morton_reorder`, `build_tet_blocks`, `build_point_locator`, `orient_surface`, `vertex_normals`, `face_normals` | Run inside `load_mesh` / `mesh_surface`; their results are load-time invariants, not client-callable state. `OrientReport` is returned in `load_mesh`'s meta and in `SurfaceBuffers`. |
| `read_msh_opt` | Run inside `load_mesh` from the optional sibling bytes the worker fetches; result appears as `MeshMeta.opt`. |
| `read_msh` / `read_gifti` / `read_fs_*` / `read_stl` / `read_ply` / `read_obj` / `sniff` | Dispatched by `load_mesh(format)`; exporting each separately would duplicate the handle-table logic. |
| `read_nifti`, `Volume::stats`, `Volume::label_index`, `Volume::gpu_payload`, `Volume::sample_nearest` | Run inside `load_volume`; probes are served from the UI thread's retained `data` array (§4.3), so `sample_nearest` exists for the native/CLI build only. |
| `LabelTable::parse_*` | Sidecar LUT text is parsed in the worker as part of `load_volume`/`load_mesh` and returned in the meta. |
| `elm_to_node` / `node_to_elm` | Both reachable through `mesh_convert_field(direction)`. |
| `BitMask::*`, `Field`, `Plane`, `Aabb`, `Error`, `ProgressSink` | Types and helpers, not operations. |

**Memory rules for results (never violated):**

> Bulk results are returned either as `Vec<T>` — wasm-bindgen already `.slice()`s into a fresh transferable
> ArrayBuffer, so the worker transfers `result.buffer` **as-is**, with no second copy — or, for hot-path recycled
> buffers, by passing `js_sys::*Array`s the worker owns and writing with `copy_from` (one memcpy, no wasm-side
> output allocation). **Never** hand a `js_sys::*Array::view()` onto `wasm.memory.buffer` across a call boundary:
> `memory.grow` detaches every outstanding view. Never use `&mut [MaybeUninit<T>]` for outputs — two copies.

`mesh_cut` at ≥ 30 fps uses the `CutOut` pool: the worker keeps recycled ArrayBuffers, the UI thread transfers
them **back** after upload, and `mesh_cut` returns only element counts.

---

## 6.5 Worker protocol

`packages/protocol/src/index.ts` is exactly this. Zero imports, zero runtime code beyond type guards.
**FROZEN at the end of Phase 0 — changing it requires an ARCHITECTURE.md edit in the same commit.**

```ts
export type Phase = 'read' | 'inflate' | 'parse' | 'topology' | 'index' | 'upload';
export type ErrorCode = 'parse' | 'unsupported' | 'io' | 'oom' | 'cancelled' | 'panic';
export interface WorkerError { code: ErrorCode; message: string }

export type OpName =
  | 'loadVolume' | 'loadMesh' | 'surface' | 'boundary' | 'buildTopology' | 'cut' | 'isolate'
  | 'field' | 'elmToNode' | 'locate' | 'marchingCubes' | 'marchingTets' | 'contours'
  | 'labelCentroids' | 'free' | 'freeMask';

export interface Req<K extends OpName = OpName> {
  id: number;
  key: string;            // latest-wins key, e.g. `${layerId}:cut`. Opaque to the worker.
  op: K;
  args: OpArgs[K];
}
export type Res<K extends OpName = OpName> =
  | { id: number; op: K; ok: true;  result: OpResult[K]; transfer: ArrayBuffer[]; heapBytes: number }
  | { id: number; op: K; ok: false; error: WorkerError };
export interface Progress { kind: 'progress'; id: number; phase: Phase; done: number; total: number }
export interface Cancel   { kind: 'cancel'; id: number }

export type ToWorker   = Req | Cancel;
export type FromWorker = Res | Progress;
```

### 6.5.1 Shared payload types

```ts
export type PlaneT = { normal: [number, number, number]; offset: number };
export type Mat4x4 = number[];                       // length 16, column-major
export type SurfaceVariant = 'indexed' | 'deindexed';
export type FieldSource = 'node' | 'elm';
export type ComponentSel = 'mag' | 0 | 1 | 2;

export interface StatsT {
  min: number; max: number; mean: number;
  percentiles: [number, number, number, number, number, number, number, number, number];  // 0.1,1,2,5,50,95,98,99,99.9
  histogram: Uint32Array; histogramLo: number; histogramHi: number;
}
export interface LabelEntryT { id: number; name: string; color: [number, number, number, number] }

export interface VolumeMeta {
  handle: number; name: string;
  dims: [number, number, number]; nvols: number;
  affine: Mat4x4; spacing: [number, number, number];
  dtype: 'u8'|'i8'|'u16'|'i16'|'u32'|'i32'|'f32'|'f64'|'rgb24'|'rgba32';
  sclSlope: number; sclInter: number;
  isLabel: boolean; intentCode: number; units?: string;
  stats: StatsT; headerJson: string;
  gpu: { format: 'R8'|'R8UI'|'R16'|'R16UI'|'R16F'|'R32F'|'RGBA8';
         scale: number; offset: number; filterable: boolean; chunked: boolean };
  labelTable?: LabelEntryT[];
}
export interface MeshFieldMeta {
  name: string; source: FieldSource; ncomp: 1 | 3 | 9; n: number;
  units?: string; partial: boolean; stats: StatsT;
}
export interface MeshMeta {
  handle: number; name: string;
  nNodes: number; nTris: number; nTets: number; hasTris: boolean;
  bounds: { min: [number,number,number]; max: [number,number,number] };
  tags: { id: number; name?: string; color: [number,number,number,number];
          kind: 'tri' | 'tet'; count: number }[];
  fields: MeshFieldMeta[];
  skipped: { elemType: number; count: number }[];
  orient: { components: number; openComponents: number;
            nonManifoldEdges: number; flippedComponents: number };
  opt?: { tagColor: Record<number, [number,number,number,number]>;
          tagVisible: Record<number, boolean>;
          views: { name?: string; customMin?: number; customMax?: number; rangeType?: number;
                   saturateValues?: boolean; colormapNumber?: number; showScale?: boolean;
                   vectorType?: number }[] };
  labelTables?: Record<string, LabelEntryT[]>;        // keyed by node-field name (.annot / .label.gii)
}
export interface SurfacePayload {
  variant: SurfaceVariant;
  positions: Float32Array;          // 3/vertex
  normals: Float32Array;            // 3/vertex
  indices?: Uint32Array;            // indexed only
  nodeIndex?: Uint32Array;          // indexed only: vertex -> mesh node id
  corner?: Uint8Array;              // deindexed only: 0|1|2
  ownerElm: Uint32Array;            // 1/triangle, Gmsh element number
  faceTag: Int32Array;              // 1/triangle
  edgeMask?: Uint8Array;            // 1/triangle, low 3 bits; absent = fully unmasked
  perTag: { tag: number; first: number; count: number }[];
  orient: MeshMeta['orient'];
  bounds: MeshMeta['bounds'];
}
export interface CutPayload {
  plane: number;
  positions: Float32Array;          // 3/vertex
  interpNodes: Uint32Array;         // 2/vertex (n0, n1)
  interpT: Float32Array;            // 1/vertex
  ownerTet: Uint32Array;            // 1/triangle
  tag: Int32Array;                  // 1/triangle
  edgeMask: Uint8Array;             // 1/triangle
  edgeSegments: Float32Array;       // 6/segment — 2D overlay only
  boundarySegments: Float32Array;   // 6/segment — 2D overlay only
}
export interface IsolateCriteriaT {
  tags?: number[];
  field?: { source: FieldSource; name: string; component: ComponentSel; lo: number; hi: number };
  sphere?: { center: [number,number,number]; radius: number };
  box?: { min: [number,number,number]; max: [number,number,number] };
  labelVolume?: { dims: [number,number,number]; worldToVoxel: Mat4x4;
                  dtype: VolumeMeta['dtype']; volumeIndex: number;
                  data: ArrayBuffer; labels: Uint32Array };
  combine: 'all' | 'any';
}
export type LoadSource =
  | { kind: 'url'; url: string; sidecarUrls?: string[] }   // tetravox://file/… ; sidecars: _LUT.txt, .msh.opt
  | { kind: 'bytes'; name: string; bytes: ArrayBuffer; sidecars?: Record<string, ArrayBuffer> };
```

### 6.5.2 Op table

Every op runs on its dataset's worker. `handle` is that worker's single dataset unless stated.

| op | args | result | notes |
|---|---|---|---|
| `loadVolume` | `{ source: LoadSource; caps: { floatLinear: boolean; norm16: boolean; max3d: number }; wantLinear: boolean }` | `{ meta: VolumeMeta; data: ArrayBuffer; gpuBytes: ArrayBuffer; labelIds?: Uint32Array; denseIndexOf?: Uint32Array }` | `data` = raw samples for probes; `gpuBytes` = the `gpu_payload` texture bytes |
| `loadMesh` | `{ source: LoadSource; format: 'auto'\|'msh'\|'gii'\|'fs'\|'stl'\|'ply'\|'obj' }` | `{ meta: MeshMeta }` | no bulk arrays; Morton reorder + `TetBlocks` + `PointLocator` are built here |
| `surface` | `{ handle: number; variant: SurfaceVariant; maskId?: number }` | `SurfacePayload` | `tag_surfaces` when `hasTris`, else `extract_boundary` |
| `boundary` | `{ handle: number; maskId?: number; variant: SurfaceVariant }` | `SurfacePayload` | always `extract_boundary`; used after isolation/clip |
| `buildTopology` | `{ handle: number }` | `{ faces: number; boundaryFaces: number }` | explicit, awaitable, progress-reporting |
| `cut` | `{ handle: number; planes: PlaneT[] /* ≤6 */; maskId?: number; recycle?: ArrayBuffer[] }` | `{ cuts: CutPayload[] }` | one `Cut` per plane, each clipped by the others |
| `isolate` | `{ handle: number; criteria: IsolateCriteriaT }` | `{ maskId: number; visibleTets: number; generation: number }` | client owns `maskId` and must `freeMask` |
| `field` | `{ handle: number; source: FieldSource; name: string; component: ComponentSel }` | `{ values: Float32Array; stats: StatsT; n: number; partial: boolean }` | |
| `elmToNode` | `{ handle: number; direction: 'elmToNode' \| 'nodeToElm'; name: string }` | `{ name: string; values: Float32Array; stats: StatsT }` | both directions of §6.3's pair |
| `locate` | `{ handle: number; world: [number,number,number] }` | `{ elementId: number \| null; tag?: number; nodeValues?: Record<string, number[]>; elmValues?: Record<string, number[]> }` | latest-wins on its own key |
| `marchingCubes` | `{ handle: number; volumeIndex: number; iso: number; smooth: boolean }` | `SurfacePayload` | |
| `marchingTets` | `{ handle: number; source: FieldSource; name: string; component: ComponentSel; iso: number; maskId?: number }` | `SurfacePayload` | |
| `contours` | `{ handle: number; plane: PlaneT; maskId?: number }` | `{ segments: Float32Array }` | 6 floats per segment |
| `labelCentroids` | `{ handle: number; volumeIndex: number }` | `{ centroids: { id: number; centroid: [number,number,number]; count: number }[] }` | |
| `free` | `{ handle: number }` | `{}` | the client then calls `worker.terminate()` |
| `freeMask` | `{ handle: number; maskId: number }` | `{}` | masks are also dropped when the mesh handle is freed |

`OpArgs` and `OpResult` are written out in full — one member per `OpName`, exhaustive, no index signature — so
`Req<'cut'>` and `Res<'cut'>` are fully typed:

```ts
export interface OpArgs   { loadVolume: {…}; loadMesh: {…}; surface: {…}; /* …all 16… */ }
export interface OpResult { loadVolume: {…}; loadMesh: {…}; surface: SurfacePayload; /* …all 16… */ }
```

**Op → wasm export (§6.4), one-to-one and exhaustive:**
`loadVolume`→`load_volume` · `loadMesh`→`load_mesh` · `surface`→`mesh_surface` · `boundary`→`mesh_boundary` ·
`buildTopology`→`mesh_build_topology` · `cut`→`mesh_cut` · `isolate`→`mesh_isolate` · `field`→`mesh_field` ·
`elmToNode`→`mesh_convert_field` · `locate`→`mesh_locate` · `marchingCubes`→`volume_marching_cubes` ·
`marchingTets`→`mesh_marching_tets` · `contours`→`mesh_contours` ·
`labelCentroids`→`volume_label_centroids` · `free`→`free` · `freeMask`→`free_mask`.
`wasm_heap_bytes()` is the only export without an op; it is read after every call and stamped onto `Res`.

Lifecycle rules:
* Progress messages carry the same `id` as their `Req`; a `Cancel` with that `id` sets the abort byte in the
  shared `Uint8Array` the wasm call polls.
* Masks: `isolate` returns `{maskId, generation}`; the client frees eagerly on every isolation change. The worker
  drops all masks when its handle is freed. A stale `maskId` is `Error::Parse`, never silent.
* Every successful `Res` carries `heapBytes` from `wasm_heap_bytes()`; the status bar and `scripts/bench.ts` read
  the §9 memory bar from it.

---

## 7. Engine (WebGL2) — rendering contract

### 7.0 Antialiasing & target chain

1. **AA is per-view and 3D-only.** 2D slice views draw one screen-filling quad with no interior geometric edges;
   they render single-sample. Every visible edge in a 2D view is shader-derived, and MSAA cannot touch it (item 5).
2. **v1 (Phases 1–2): create the canvas with `antialias: true` and render passes 1–3 directly to the default
   framebuffer.** Verified to yield `SAMPLES = 4`, `SAMPLE_BUFFERS = 1` with no FBO chain `[M2Max]`. Do not build
   an MSAA FBO chain yet.
3. `Framebuffer` (§7.1) carries `samples: number` **from day one**, even while unused, and allocates via
   `renderbufferStorageMultisample` when `samples > 0`. Phase-3 OIT forces the main render offscreen and the free
   canvas MSAA disappears there; without the field that is a breaking rewrite.
4. **Hard GL constraints:**
   * `MAX_SAMPLES = 4` `[M2Max]`; `samples = 8` ⇒ `INVALID_OPERATION`. Choose the count from
     `getInternalformatParameter(RENDERBUFFER, fmt, SAMPLES)` per format (returns `[4,2]` for RGBA8 / RGBA16F /
     RGBA32F / R8 / R16F / DEPTH24_STENCIL8 / DEPTH_COMPONENT24 / 32F `[M2Max]`), take the first entry, expose it
     as a quality setting clamped to that list.
   * **Integer formats support zero sample counts**: `getInternalformatParameter(..., RGBA32UI|RGBA8UI|R32UI,
     SAMPLES)` returns `[]`, and `renderbufferStorageMultisample(..., 4, RGBA32UI, ...)` ⇒ `INVALID_OPERATION`
     (so does `samples = 1`) `[M2Max]`. The pick target is allocated with `texStorage2D` / `renderbufferStorage`,
     never the multisample entry point.
   * `blitFramebuffer` cannot resolve **and** rescale in one call: MS→SS with a size change ⇒
     `INVALID_OPERATION`; SS→SS downscale with LINEAR is fine `[M2Max]`. Resolve and SSAA downsample are two steps.
   * MS→SS blit of `DEPTH_BUFFER_BIT` (and COLOR|DEPTH|STENCIL together) is `NO_ERROR` `[M2Max]`, so the overlay
     pass may run after the resolve and still depth-test.
5. **MSAA is coverage-only and does not antialias this design's dominant edges.** WebGL2 is GLSL ES 3.00 with no
   per-sample shading: `sample in` fails to compile ("'sample' : Illegal use of reserved word") and `gl_SampleID`
   is undeclared `[M2Max]`. `fwidth` compiles fine. Each of these needs its own analytic AA, in the shader:
   * §7.4 barycentric wireframe: `smoothstep(0, fwidth(bary)·w, min3(bary))`.
   * §7.3 label outlines: derive a distance-to-boundary from the neighbour-label test and `fwidth`-scale the
     smoothstep, not a binary "different label ⇒ outline colour".
   * §7.3 threshold edges: `discard` kills all samples, so thresholded stat-map boundaries stay hard at any sample
     count. Ramp alpha over `Threshold.softBins` of the last bin; `SAMPLE_ALPHA_TO_COVERAGE` is available but not
     used in v1.
   * `outlineWidthPx`, `contourWidthPx`, `edgeWidthPx` are in **render-target** pixels and must be scaled by the
     DPR/SSAA factor.
6. **`gl.lineWidth()` is a no-op** — `ALIASED_LINE_WIDTH_RANGE` is `[1,1]` `[M2Max]`. Every `*WidthPx` knob on
   line-drawn geometry (`contourWidthPx`, crosshair, gizmo, annotation lines) is implemented as instanced
   screen-space quad expansion, never `LINES` + `lineWidth`. `outlineWidthPx` and `edgeWidthPx` are
   fragment-shader based and unaffected.
7. **Progressive refinement (Phase 3, but the API shape is Phase 1).** Because per-sample shading is unavailable
   and MSAA caps at 4, jittered-projection accumulation is the only thing that fixes shading aliasing together
   with wireframe/outline/threshold edges. Accumulate 8–16 jittered frames into an RGBA16F target while the camera
   is still (`EXT_color_buffer_float` and `EXT_float_blend` both present `[M2Max]`; RGBA16F supports 4×/2× MSAA).
   Cost is zero during interaction and it converges in ~200 ms after the user stops — the frame a user judges and
   the frame a screenshot captures. `requestRender()` is therefore a **converging state machine**, not
   single-shot, and `whenSettled()` (§7.2) resolves only after convergence. §8's 1×/2×/4× screenshot path routes
   through the same accumulation.
8. **Goldens use `aa: 'off'`.** MSAA resolve is driver-dependent and §12's golden authority is SwiftShader while
   release rendering is ANGLE/Metal. `EngineOptions.aa = 'off'` is a deterministic mode that golden pixel
   assertions use (§11).

Context for the AA budget: ernie's 1,177,213 surface triangles are **ten nested tissue shells** — 1001 WM 249,245 ·
1002 GM 335,930 · 1003 CSF 121,238 · 1005 scalp 77,032 · 1006 eyes 2,178 · 1007 compact bone 143,499 · 1008 spongy
bone 158,262 · 1009 blood 35,930 · 1010 muscle 2,317 · 1099 internal air 51,582 `[DATA]`. Only the scalp's 77,032
tris (~5 px edges) form the default silhouette; the severe case is the GM surface at 335,930 folded triangles
(~2 px edges) — exactly the surface E-field results are displayed on.

### 7.1 GL kit and capabilities (`packages/engine/src/gl/`)

Thin wrappers: `Program` (compile/link, uniform cache, `#include`-style chunks, **variant cache keyed on
`(colorMode, flatShading, isLabel, activeClipPlaneCount)`**), `Buffer`, `VertexArray`,
`Texture2D` / `Texture3D`, `Framebuffer` (colour + depth, MRT-ready, `samples`, RGBA16F support), `Timer`
(optional). Single shared context per engine; **no per-frame allocations**.

```ts
export interface Capabilities {
  renderer: string; vendor: string;             // WEBGL_debug_renderer_info
  isSoftware: boolean;                          // /SwiftShader|llvmpipe|softpipe/i
  floatLinear: boolean;                         // OES_texture_float_linear
  norm16: boolean;                              // EXT_texture_norm16  (R16 = 0x822A, R16_SNORM = 0x8F98)
  clipDistance: boolean;                        // WEBGL_clip_cull_distance
  maxClipDistances: number;
  colorBufferFloat: boolean; colorBufferHalfFloat: boolean; floatBlend: boolean;
  drawBuffersIndexed: boolean;
  timerQuery: boolean;                          // EXT_disjoint_timer_query_webgl2
  max3d: number; maxSamples: number; maxDrawBuffers: number;
  maxTextureImageUnits: number; maxVaryingVectors: number;
}
export function probeCapabilities(gl: WebGL2RenderingContext): Capabilities;
```

Rules:
* `probeCapabilities` runs **once, at context creation, before any texture exists**, and is cached on the engine.
  `getExtension` is a *request*, not a query — it must be **called**, or the feature is unavailable even where the
  driver has it.
* **Invariant:** never leave `TEXTURE_MIN/MAG_FILTER = LINEAR` on a format `caps` says is not filterable. The
  texture becomes incomplete and samples 0 **with no GL error** `[M2Max]`.
* Binding an integer texture to a `sampler3D` uniform is `INVALID_OPERATION` (error 1282) `[M2Max]`, so the slice
  shader has two compiled variants keyed off `isLabel`, not a uniform switch.
* Required vs optional: **REQUIRED = WebGL2 core only.** Each optional extension has a named fallback —
  `OES_texture_float_linear` absent ⇒ force `interpolation:'nearest'` on R32F layers and flag it in the layer
  panel; `EXT_texture_norm16` absent ⇒ the §6.1 ladder steps to R32F or R8 (document the 2× VRAM in §9);
  `WEBGL_clip_cull_distance` absent ⇒ the `discard` clip path (§7.4);
  `EXT_disjoint_timer_query_webgl2` absent ⇒ wall-clock frame time only.
* **Never use `gl_CullDistance`; a lint forbids the identifier.** `MAX_CULL_DISTANCES_WEBGL` is 0 on ANGLE/Metal
  `[M2Max]` but **8 under headless SwiftShader** `[SwS]` — CI goldens would pass while every real Mac fails.
* `Capabilities` is surfaced verbatim in the §8 status bar, in scene JSON dumps and in bench output, so every
  reported number carries its renderer string.
* `getContext('webgl2') === null` ⇒ a real error screen naming `chrome://gpu`, never a white window.

### 7.2 Passes per frame, frame pump, transparency, picking

**Pass order (per view):**

1. **Opaque** — volume base slices (2D: the slice; 3D: the plane of each `SliceView` whose owning volume layer has
   `showIn3D`), opaque meshes, opaque isosurfaces, points, and the cut caps of opaque layers.
2. **Transparent, scene-wide, two phases:**
   * **2a — back faces:** `cullFace(FRONT)`, depth test on, depth write off; objects sorted back-to-front by the
     depth of their **far** extent.
   * **2b — front faces:** `cullFace(BACK)`, depth test on, depth write off; objects sorted back-to-front by the
     depth of their **near** extent.
   Unified rule: *in each phase, objects are sorted back-to-front by the depth of the sheet that phase draws.*
   Exact for nested, individually near-convex shells (scalp, skull, CSF, blood — median 2 crossings `[M2Max]`);
   a partial improvement for GM/WM (median 4–6, p90 8–10). Layers with `faceMode:'both'` are excluded from the
   split and drawn last in 2b. Per-tag sub-draws mean per-tag opacity sorts naturally.
   Cut caps are drawn **in the same pass as their owning layer, with that layer's opacity**; in the transparent
   pass a cap is a single sheet — `CULL_FACE` disabled, sorted by the clip plane's depth at the object centre.
   *Invariant:* a cap must exist wherever the clip discards geometry, or the phase split shows the shell interior
   through the cut.
3. **Overlay** — crosshair, cut-plane gizmo, contours on slices, glyph labels, annotations, orientation letters,
   corner info, RAD/NEU badge, colour bars, scale bar, orientation cube. **All clip distances disabled** in this
   pass, or the gizmo gets clipped by the plane it manipulates.
4. **Pick (on demand)** — §7.2.3.

**Frame pump:**

* `requestRender(viewId?)` sets a dirty bit; it **never** renders synchronously. One `requestAnimationFrame`
  callback per engine drains all dirty bits and renders each dirty view **at most once**. Chromium already
  coalesces `pointermove`/`wheel`/`touchmove` to one dispatch per frame, but discrete events (pointerdown/up, key
  repeat for arrow/PgUp stepping) and — the real hazard — **worker `message` and IPC callbacks are ordinary tasks
  and never frame-aligned**, so latest-wins results would otherwise each drive an off-vsync render mid-gesture.
  Worker results mutate scene state and call `requestRender()`; they never draw.
* **Budget is stated per cadence:** ≤ 8 ms at 60 Hz, ≤ 5 ms at 120 Hz. The reference machine's display is
  ProMotion, where Chrome drives rAF at 120 Hz; the pump skips alternate vsyncs when the last full-quality frame
  exceeded ~6 ms.
* **`interacting` state** lives on the engine (not in React): entered on pointerdown / wheel / key-repeat / gizmo
  drag, left `settleMs` (default 120 ms) after the last input. While interacting, the `interacting` `QualityLevel`
  applies: `dprScale 1`, `msaa 0`, `edges false`, `capDecimation` per §9. Leaving it triggers exactly one
  full-quality re-render.
  **Forbidden in the fallback set: any knob that changes displayed *values* rather than displayed *resolution*.**
  `interpolation` (nearest vs linear) is a reading, not a rendering setting, and must never be degraded.
* **Automatic degradation:** when the median full-quality frame over the last 30 frames exceeds the budget, drop
  one `QualityLevel` (DPR → 1, then edges/wireframe off, then decimate tag surfaces) and **surface it in the
  status bar**. Never degrade silently.
* **Main-thread budget rule:** no single main-thread call may exceed `frameBudget / 2` while interacting. This is
  what forces the chunked texture upload in §7.3 (measured `texImage3D` 256×256×208: R16UI 3.6–5.5 ms, R32F
  11.1 ms `[M2Max]`) and the async cap path in §6.3.
* **`whenSettled(): Promise<void>`** resolves after `interacting` has cleared, all pending worker requests for
  visible layers have landed, any §7.0.7 accumulation has converged, and one full-quality frame has completed.
  Every golden screenshot and every `screenshot()` call awaits it and renders at full quality regardless of the
  current `QualityLevel`. Without this the adaptive pump makes every golden test racy.

**Depth:**

* Standard OpenGL NDC (−1..1). **`EXT_clip_control` is not used and reverse-Z is not used.** Measured on
  ANGLE/Metal with a 24-bit buffer at near = 1 / far = 2000: 0.02 mm of separation resolves 100 % of pixels —
  three orders finer than any geometry here — while reverse-Z + `ZERO_TO_ONE` turns the coplanar slice-layer case
  from 4.4 % dropout into 98.9 % `[M2Max]`.
* The 3D camera fits `near = max(1 mm, fitRadius/1000)` and `far = fitRadius × 8`; never a fixed sub-millimetre
  near plane (0.01 mm breaks ordering even at 0.1 mm separation `[M2Max]`).

### 7.2.3 Pick pass

* Target: one `R32UI` colour texture + `DEPTH_COMPONENT24` renderbuffer, **single-sample**, sized to the *same*
  device-pixel dimensions as the colour target so ids are 1:1 with displayed pixels. Verified FBO-complete;
  `clearBufferuiv([0,0,0,0])`; `readPixels(RED_INTEGER, UNSIGNED_INT)` returns the exact value; 1×1 sync readback
  0.031 ms — no PBO needed `[M2Max]`. (`RGBA32UI` also works, 0.043 ms `[M2Max]`, but costs 75 MB at 2880×1620
  against R32UI's 19 MB.)
* Payload: `id = (layerIndex + 1) << 24 | (elementIndex & 0x00FFFFFF)`. **0 means miss** — hence the zero clear.
  24 bits is 16.7 M primitives; ernie's largest count is 4.72 M tets and ernie-seeg's is 13.16 M `[DATA]`, so a
  mesh over 16.7 M elements falls back to per-tag pick ids and reports the tag only.
* **Depth is read from a second colour attachment, never from the depth attachment.** WebGL2 restricts
  `readPixels` to RGBA / RGBA_INTEGER and the implementation-defined format; `DEPTH_COMPONENT` is not a legal
  read format. `COLOR_ATTACHMENT1` is a second `R32UI` target written as `floatBitsToUint(gl_FragCoord.z)`
  (`MAX_DRAW_BUFFERS` floor is 4 by spec, 8 measured `[M2Max]`). The engine keeps the `viewProj` used by the
  pick draw and unprojects with it.
* **Element ids come from a per-vertex `uint` attribute.** WebGL2 has no `gl_PrimitiveID` (verified compile error
  `[M2Max]`). Cut caps and flat-shaded field geometry are already de-indexed and carry `ownerElm`; indexed
  tag-surface draws use a de-indexed pick-only VAO with `gl_VertexID / 3`.
* The pick pass reproduces **every** discard of the main pass: the up-to-6 clip planes (same enable set), §7.3
  threshold/label discards, the isolation `BitMask`, and face culling. Otherwise double-click lands on geometry
  the user cannot see.
* Pick only layers with `visible && pickable && opacity >= pickOpacityMin` (default 0.25), depth-tested, nearest
  wins. Volume slice quads participate (`elementKind: 'slice'`, `elementId` = plane index) — double-clicking a
  slice plane in the 3D view is the primary Freeview gesture.
* **2D views use no GPU pick**: cursor = pointer ray ∩ that view's derived slice plane, on the CPU.
* Cost: `gl.scissor` a 9×9 rect around the pointer with the *unmodified* projection, `gl.readBuffer(...)`, then a
  9×9 `readPixels`; resolve by taking the nearest non-zero id within a 3–5 px radius. The sync stall is on demand
  and outside the §9 frame budget. The pick target is cached and invalidated on camera/scene change.
* Unprojection: `world = inverse(viewProj) · (2(px+0.5)/w − 1, 2(py+0.5)/h − 1, 2z − 1, 1)`. At near = 1 mm,
  far = 1000 mm, z_eye = 500 mm the float32 window-z quantum reconstructs to ~0.008 mm — three orders below the
  1 mm voxel, so no world-position attachment is needed.

### 7.3 Volume slice shader

**Slice geometry is owned by the plane, not by any volume.** For each slice plane the engine builds exactly one
quad in the `(right, up)` basis, centred on the cursor's projection and sized to the **scene** bounding-sphere
radius; every volume layer on that plane is drawn from that same VAO/vertex buffer through the same vertex shader.
Per-volume extent is handled in the fragment shader. Two coplanar quads with different vertex data do **not**
produce identical interpolated depth — measured 1.6 %–11.8 % overlay-pixel dropout on ANGLE/Metal at scene scale
`[M2Max]` — so identical geometry is the correctness mechanism, not an optimisation. All slice vertex shaders
declare `invariant gl_Position;`.

* **2D views:** `DEPTH_TEST` disabled for the whole slice-layer pass; compositing order is layer order
  (bottom→top) with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. There is nothing else in a 2D view to depth-test against.
* **3D views (`showIn3D`):** `DEPTH_TEST` on, `depthFunc(LEQUAL)`, `depthMask(true)` for every slice layer of that
  plane. Shared geometry + shared vertex shader ⇒ bit-identical depth ⇒ LEQUAL passes for all layers. **Do not use
  a separate full-plane depth prepass** — it would occlude meshes behind the plane where no volume layer draws.
  Additionally discard fragments outside the owning layer's world AABB so `showIn3D` planes terminate at the data.
* **One draw per (layer, plane).** There is no single-pass N-layer shader: ESSL 3.00 forbids indexing a sampler
  array with anything but a constant expression ("`'[' : array index for samplers must be constant integral
  expressions`" for a loop counter, a uniform int, and a loop over `sampler3D u[8]`) `[M2Max]`; layers need
  heterogeneous sampler types (`sampler3D` scalars vs `usampler3D` labels) and per-layer filtering;
  `MAX_TEXTURE_IMAGE_UNITS = 16` caps single-pass at ~14 layers; and perf is a wash (3 layers: 1.10 ms
  single-pass vs 1.04 ms three draws `[M2Max]`).
* Fragment: `voxel = inverseAffine · world`, `texcoord = (voxel + 0.5)/dims`; `sampler3D` (trilinear) for scalars,
  `usampler3D` (nearest) for labels; `v = raw·scale + offset`; window/threshold/colormap through a 256×1 RGBA8 LUT
  (512×1 signed when `scale.negative === 'separate'`); `discard` outside `[0,1]³`, outside `visibleLabels`, and
  below threshold (alpha-ramped over `Threshold.softBins`); symmetric thresholds compare `|v|`.
* **Label outlines — normative formula.** Let
  `duv = (inverseAffine · dFdx(worldPos)) / dims` and `dvv = (inverseAffine · dFdy(worldPos)) / dims`
  (the texture-space extent of one screen pixel). Sample the label at
  `texcoord ± 0.5 · outlineWidthPx · duv` and `texcoord ± 0.5 · outlineWidthPx · dvv`, clamped to `[0,1]³`;
  a fragment whose centre label differs from any tap is outline. The drawn band is then `outlineWidthPx` wide —
  the `0.5` is because both sides of the boundary are flagged, and a naive `± outlineWidthPx` offset draws twice
  the requested width. **4 taps. Do not re-derive the step from voxel size.**
  Rationale, recorded so this is not "fixed" again: the step is screen-relative on purpose. It keeps the outline a
  constant screen width at any zoom, and it stays correct on `showIn3D` planes under perspective where world-per-
  pixel varies across a single quad. Simulated on `labeling.nii.gz` and `tissue_labeling_upsampled.nii.gz`: at
  0.05 mm/px the outline is **1.00 px thick with 100 % boundary coverage**; across 0.05 → 10 mm/px, **0 of
  12,663 / 38,744 / 46,602 / 19,332 / 7,099 / 1,706 / 554 fill-boundary pixels were uncovered (0.0 % gaps)**. The
  proposed voxel-space step (`inPlaneVoxelAxis · max(1, outlineWidthPx·pxInVoxels)`) yields a **12.87 px** band
  covering 42.3 % of the viewport at 0.05 mm/px — a 13× regression — and cannot recover a distance from 4 binary
  taps anyway. 8 taps buy nothing: measured perpendicular thickness 2.00 px axis-aligned / 2.69 px at 45° with 4
  taps vs 2.00 / 2.76 with 8, at 12 % more slice-composite cost (1.10 ms → 1.23 ms `[M2Max]`).
  Offsetting in texture space (rather than adding a small world delta to a large world coordinate) also avoids f32
  cancellation at extreme magnification.
* **Label texture path:** labels upload as a **dense index remap** (`denseIndexOf`, cap 65535) in R8UI/R16UI with
  an `N×1 RGBA8` palette texture, `usampler3D`, NEAREST forced. Outline detection compares dense indices; the info
  panel maps back to the original id.
* **Upload:** `texStorage3D` + per-z-slab `texSubImage3D` (slabs ≤ 32 MB, yielding between slabs) for any texture
  over ~64 MB, which also renders progressively. Measured one-shot cost is 69–96 ms for the 416 MB R32F case and
  9–16 ms for the 52 MB one `[M2Max]`; this is a load-time hitch, not an interactive one, so **do not build a
  per-frame upload budget scheduler**. The justification for the format ladder is filterability and VRAM, not
  upload milliseconds.

### 7.4 Mesh shaders

* **Two geometry variants per mesh layer, both built in the worker:**
  * **indexed (default, always built):** one shared vertex buffer — `position`, smooth `normal`, optional
    per-node `scalar` — plus one index buffer, drawn as one sub-range per tag (`SurfacePayload.perTag`) with the
    tag colour as a **uniform**. Covers `colorMode: 'tag' | 'solid'` and `field.source === 'node'`.
    `tagStyle[tag].visible` becomes skipping a sub-draw (free).
    **There is no per-vertex `tag` attribute**: 1,048,599 of ernie's 1,177,213 interface faces are shared between
    two tissue tags `[DATA]`, so a per-vertex tag is ill-defined on shared nodes. Cost: 30 MB (stored tris) /
    47 MB (`extract_boundary`) `[MODEL]`.
  * **de-indexed (lazy, cached):** built in the worker on first use of `field.source === 'elm'`,
    `edges.surface`, or `colorMode: 'label'`. Attributes are **`position` + `normal` + `corner` (1 byte)** only,
    drawn with `drawArrays`; barycentric comes from `corner`, the per-face scalar from
    `texelFetch(elmFieldTex, ivec2(...), 0)` at `gl_VertexID / 3`, and the label id likewise. Cost 85 MB (stored
    tris) / 160 MB (`extract_boundary`) `[MODEL]`; switching which field or component is displayed is a **texture
    swap**, always free. Oct-encoded RGBA8 normals (→ 57 / 107 MB) are a Phase-3 memory option.
    Rejected shortcuts, so nobody re-litigates: duplicating only the provoking vertex (ES flat shading is
    last-vertex with no `glProvokingVertex`, and ANGLE has shipped provoking-vertex bugs), and a separate
    `GL_LINES` wireframe (line width is clamped to 1 px, §7.0.6).
  * Cache key `(dataset, maskId, clip state)`. Isolation or clip changes invalidate both variants.
  * **UX consequence (§8):** the first toggle of `edges.surface`, the first switch to an element field, and the
    first `colorMode:'label'` on a given mask are **async loads with a progress state**, not instant checkboxes.
    They are free thereafter.
* **Clipping:** up to 6 world-space planes. Primary path is hardware `gl_ClipDistance` via
  `WEBGL_clip_cull_distance`; the `vec4`-uniform + `discard` shader is a **compile-time-selected fallback**. Both
  paths must be pixel-identical under the same goldens (`EngineOptions.forceDiscardClip` / env
  `TETRAVOX_FORCE_DISCARD_CLIP=1` is a Playwright axis, §11).
  * Sign convention is byte-for-byte §6.0's `Plane`: `gl_ClipDistance[i] = dot(plane.normal, worldPos) +
    plane.offset`, keep `>= 0`. No negation, no separate GPU convention.
  * `Program` emits **N variants keyed on the active plane count** N ∈ 0..6. At N = 0: no `#extension`, no
    redeclaration. At N > 0: `#extension GL_ANGLE_clip_cull_distance : require` (`require`, not `enable`, so a
    driver lacking it fails at compile time and trips the fallback rather than rendering unclipped) +
    `out highp float gl_ClipDistance[N];` + N **unrolled constant-index** assignments. Redeclaration is not
    strictly required (six unrolled constant-index writes compile without it `[M2Max]`) but pins the size for the
    variant scheme.
    Why specialise: on ANGLE/Metal each clip distance consumes one **full varying vector**.
    `MAX_VARYING_VECTORS = 30`; user varyings linkable alongside clip 0/1/2/4/6/8 = 30/29/28/26/24/22 `[M2Max]`.
    A blanket `[6]` costs 20 % of the varying budget on every mesh program forever.
  * The GL kit tracks `CLIP_DISTANCE0_WEBGL + i` (`0x3000 + i`) as render state — it is global and survives
    `useProgram` `[M2Max]`. Reset **per pass**: opaque and transparent mesh draws enable exactly that layer's
    active planes; the pick pass enables the same set; the overlay pass disables all.
  * **Cap rule (this is the one that breaks the product):** when drawing the cap geometry generated by plane *i*,
    **disable `CLIP_DISTANCE(i)` for that draw** while leaving the others enabled. Cap vertices lie exactly on
    plane *i*; measured on ANGLE/Metal, `gl_ClipDistance == 0.0` keeps the primitive (16384/16384 px) and
    `gl_ClipDistance == −1e-7` deletes it entirely (0/16384 px) `[M2Max]`. CPU f32 interpolation vs vertex-shader
    recomputation straddles zero per vertex and drops cap triangles wholesale. The same applies to `fillIn2D` cut
    polygons.
  * On a layer with `threshold.mode === 'hide'` the shader still discards, so the early-Z benefit is partly
    forfeit; clip distance still wins by culling at primitive level, but do not expect the full 28 %.
* **Element edges — one mechanism, masked barycentric, for surfaces and caps alike (no extra draw call).**
  Every triangle carries a 3-bit `edgeMask`; bit *i* means "the edge opposite vertex *i* is a real element edge".
  The shader computes `d = bary / fwidth(bary)`, sets `d[i] = 1e9` for cleared bits, and shades
  `1 − smoothstep(w − 0.5, w + 0.5, min(d))` with `w = edgeWidthPx`. Cleared bits are excluded from the `min`, so
  a suppressed edge never contributes and slivers do not flood. Default mask `0b111`; when a whole draw is
  unmasked the attribute array is **disabled** and a constant vertex attribute supplied, so the common case costs
  zero memory. Corner ordinal comes from the 1-byte `corner` attribute expanded to `vec3` in the vertex shader —
  never three floats per vertex. Barycentric requires de-indexed geometry (`gl_PrimitiveID` does not exist; under
  `drawElements` `gl_VertexID` is the index value, not the corner ordinal).
  **Cap edges use the same shader.** `Cut.edge_segments` is **not** used in the 3D passes — it exists for the 2D
  overlay (`contoursIn2D`).
* **Caps** come from `plane_cut` (exact per-element polygons), drawn with the same material (`capColorMode`).
  A cap vertex's scalar for `colorMode:'field'`: node fields live in a 2D R32F texture, and the vertex shader does
  `texelFetch` + `mix` from the `ivec2` `interpNodes` attribute (`vertexAttribIPointer`) plus the float `interpT`,
  so changing the displayed field costs zero re-cut. **Cap normals are the (negated) clip-plane normal, generated
  engine-side; `Cut` carries no normal buffer.**
* **Cap upload:** a pre-sized, double-buffered VBO set (positions, tag, owner, `interpNodes`, `interpT`,
  `edgeMask`), written with `bufferSubData` after an orphaning `bufferData(null)` — never a fresh sized
  `bufferData` per frame. Buffers grow by doubling and never shrink during a drag. Budget ~6 MB per buffer set for
  ernie (62,966 cap triangles at the mid-axial plane `[M2Max]`).
  `plane_cut` stays **exact, always** — with the block index it is 2.7 ms, so there is no coarse-while-held proxy
  (it would add a visible pop on release and a second code path to the feature the product is judged on).
  Latest-wins (§5) is the only drag mechanism.
* **Lighting:** headlight Blinn-Phong with configurable ambient; flat shading optional; two-sided lighting.
* **Surfaces on 2D slices:** `contours` line segments drawn in the overlay pass as instanced screen-space quads;
  tet cut polygons drawn in the opaque pass with tag/field colour when `fillIn2D`.
* **Winding:** any triangle set rendered with `faceMode:'cull'` or in the transparency phase split passes through
  `orient_surface` first. The engine sets `faceMode:'both'` automatically when `orient.openComponents > 0`.
  Reference expectation `[M2Max]`: ernie's per-tag signed volumes are 1001 −603, 1002 −1309, 1003 −1495,
  1099 −75, 1005 +4841, 1007 +2333, 1008 +112, 1009 +66, 1006 +19 cm³ with 974–2920 non-manifold edges per tag —
  so `orient_surface` flips four of ten tags and marks all ten open.
* **Glyphs** (`GlyphSpec`): one instanced draw of a shared cone+shaft VAO with per-instance origin/direction/
  magnitude, in the opaque pass. No new geometry from WASM. Origins restricted to visible tags and, when a cut
  plane is active and `clipToCutPlane`, to elements the plane intersects.

### 7.5 Views & interaction

Layouts: `1x1`, `1x3`, `1x3-horizontal`, `2x2`, `3d-only`; `mosaic` is Phase 3.
Every view has its own camera. 2D cameras are orthographic, pan/zoom only — **orientation comes from the view's
`SliceView.{normal, up}`**, and in-plane rotation is `up` rotated about `normal` (there is no separate roll: that
would be a second source of truth). 3D camera: orbit (arcball) / pan / dolly, `fit()` to scene bounds, presets
(A/P/L/R/S/I), orthographic toggle.

**Slice stepping, defined once so it needs no rewrite for oblique:**
`step_mm = max over voxel axes a of |dot(normal, A[:,a])|`, where `A` is the 3×3 of the topmost visible volume
layer's affine (this reduces to voxel spacing for canonical views on an axis-aligned volume). Fall back to
`min(spacing)` of any volume, else `bboxDiagonal / 256` for mesh-only scenes. Wheel / PgUp / PgDn / arrows do
`cursor += normal · step · k`, then **snap the cursor's along-normal component to the nearest voxel plane** of that
layer to stop drift over repeated steps.

Input (Freeview-like):
* **2D** — left-click/drag sets the cursor; wheel = slice ±1 (⌘/Ctrl+wheel = zoom); right-drag = window/level on
  the **active** layer, falling back to the topmost non-label volume layer; middle/space-drag = pan; arrows nudge
  the cursor; PgUp/PgDn slice.
* **3D** — left orbit, right pan, wheel dolly, double-click = `setCursorFromPick`.
* Keys: `r` reset view, `1..6` presets, `c` toggle crosshair, `x` cycle layout, `o` orthographic,
  `[`/`]` cycle the active layer, `v` toggle the active layer's visibility, `Shift+drag` its opacity,
  `Ctrl+↑/↓` reorder it, `,`/`.` step the 4D volume index.
* Cut plane: sliders (normal preset + free normal + offset) and a draggable gizmo.

Phase 1 exposes the three canonical presets in the UI; `mode:'oblique'` is fully supported by the model and the
shader path from Phase 1 and gets its **affordances** (gizmo, rotate handles, plane-from-3-points) in Phase 2.

### 7.6 Colormaps and LUTs

`ColormapName` is declared in §4.1 (it is part of the frozen `scene/types.ts`): `gray`, `viridis`, `plasma`,
`inferno`, `magma`, `cividis`, `turbo`, `jet`, `hot`, `cool`, `bone`, `coolwarm`, `bwr`, `freesurfer-heat`,
`blue-cyan`.

* Continuous colormaps are a **256×1 RGBA8** texture baked on the CPU from `Scale`. `kind:'heat'` (min/mid/max,
  `truncate`, `inverse`) costs nothing extra in the shader — it is a different bake. `negative:'separate'` bakes a
  **512×1** signed LUT with a dead band around zero; `negative:'mirror'` mirrors the positive branch;
  `negative:'hide'` discards. `bwr`/`coolwarm` centre at 0 when `threshold.symmetric`.
* User colormaps: a `.json` array of RGB stops, registered by id.
* **Label LUTs are a separate path** — a 256×1 texture cannot address FreeSurfer/`.annot` ids. See §7.3's dense
  index remap + `N×1 RGBA8` palette.
* LUT parsers: FreeSurfer `FreeSurferColorLUT.txt`, SimNIBS `*_LUT.txt` (`#No. Label Name: R G B A`), ITK-SNAP
  label description, and a generic `id r g b [a] [name]` fallback. Auto-associate `<volume>_LUT.txt` or
  `<volume>.txt` next to the volume; otherwise a deterministic glasbey-like palette.
* **Default mesh tag palette must cover the electrode/gel ranges**: simulation meshes add tri tags
  1013/1014/1015/1016 and 1101/1102/1501/1502/2101/2102 and tet tags 13/14/15/16 and 101/102/501/502. A viewer
  colouring only 1–10 / 1001–1010 renders electrodes as untagged grey on the most common file a SimNIBS user
  opens. Tags are **not** contiguous — tag 4 is absent from ernie `[DATA]`.
* `<mesh>.msh.opt` seeds tag colours/visibility, field range, colormap and colorbar on open, with a
  "defaults from X.msh.opt" chip and a one-click Reset.

---

## 8. App (Electron) — UX contract

**Regions.** Dark theme. **Left**: layer panel (ordered list, eye, opacity slider, per-kind property editor,
1 px accent border on the active layer, per-dataset **load card** with phase + percent + elapsed + Cancel).
**Centre**: view grid (coloured border on the active view pane). **Right/bottom**: info panel.
**Top**: toolbar (Open, layout, radiological toggle, screenshot, save/load scene). **Status bar**.

**2D view chrome (Phase 1 — this is a laterality-safety requirement, not decoration):**
* Orientation letters `L/R/A/P/S/I` on all four edges of every 2D view, **derived from the affine and the
  radiological flag**, never hardcoded per pane.
* Corner annotation: view name, slice index of the active volume layer, world RAS of the plane.
* A persistent `RAD` / `NEU` badge (`Annotations.conventionBadge` is not optional).
* All three appear in **every** Playwright golden, so a regression that drops them fails CI (§11).

**Info panel** is split into two blocks with identical row structure:
* `Cursor` — last click, persistent.
* `Mouse` — live, updates on pointermove, blank when the pointer leaves a view.
Rows carry per-layer voxel index / value / label name / element id / tag name / field values. Volume values
resolve on the UI thread from the retained typed array (zero latency); mesh element probes go through the `locate`
op as latest-wins on its own key so a hover never queues behind a cut. Targets: **volume hover ≤ 16 ms, mesh hover
≤ 50 ms.**

**Coordinate bar** above the info panel: editable `x y z` with a space selector (`World RAS` | `Voxel (active
layer)` | `MNI`), Enter jumps the cursor, a copy button yields `-42.0 18.0 6.0`, paste accepts comma- or
space-separated triples. The MNI column appears when the dataset has `toTemplate`.

**Colour bars** (Phase 2, required in screenshots): one per visible scalar layer — colormap, numeric ticks at the
scale endpoints and at `mid` for heat, the threshold cut drawn as a notch, the field name, and units from
`Field.units` (NIfTI `xyz_units`/`intent_name`, Gmsh view name). Per-layer `showColorbar`, position right/bottom.

**Histogram widget** in the volume and mesh-field property editors: log-y toggle, draggable window and threshold
handles, the current colormap painted along the x axis, and presets `min–max`, `2–98 %`, `p50–p99.9`,
`symmetric ±p99`.

**Region panel** for label volumes and `.annot` layers: search-as-you-type over the `LabelTable`, per-row eye +
colour swatch + voxel count, `Alt+click` to solo, double-click to jump the cursor to that label's centroid
(`labelCentroids`). The same selection wires into `MeshLayer.isolate.labelVolume.labels`.

**Mesh property editor** is a **tissue table** (name from `$PhysicalNames`, colour swatch, eye, opacity slider) —
not a list of checkboxes — backed by `tagStyle`.

**Open**: menu / ⌘O / drag-and-drop / CLI args (`tetravox file1.nii.gz mesh.msh`). Drag-and-drop uses
`webUtils.getPathForFile` exposed through the preload as `getDroppedFilePath(file)`; when it returns empty the
renderer falls back to handing the worker the `File` object (`LoadSource.kind: 'bytes'`), where the Rust
`1f 8b` sniff does the inflate. Both paths are exercised by a Phase-0 E2E test. File associations are registered
by the installer.

**Screenshot**: `screenshot(opts: ScreenshotOptions)` (§4.7) → PNG with the DPI written into the pHYs chunk.
Phase 3 exposes the same path headlessly: `tetravox --scene s.tetravox.json --screenshot out.png --width 2400
--background white [--headless]`, running the same engine in an offscreen Electron window.

**Scene save/load**: `*.tetravox.json` (`ViewSpec`, §4.6). Paths are stored relative to the scene file with an
absolute fallback; a missing dataset opens a "relocate" dialog.

**Status bar**: `Capabilities.renderer`; **fps** = frames drawn in the last second (0 when idle is correct under
render-on-demand); **frame ms** = median CPU frame time over the last 30 rendered frames; **GPU ms** separately
when `caps.timerQuery` (the app enables `--enable-webgl-developer-extensions`, so this is a live path); the
current `QualityLevel` when below full; **estimated** GPU memory (a sum of our own allocations — WebGL2 has no
memory-query extension, so it can only ever be an estimate); last load time and wasm `heapBytes` per dataset.

**Everything the UI can do must be reachable from the `Engine` API alone.** No logic in React.

---

## 9. Performance & memory budgets (measured, not asserted)

**Reference machines.** Every row states which. `A` = Apple M1 Pro (16-core GPU), 1440p logical, DPR 2, macOS,
ANGLE/Metal. `B` = Intel UHD 620 / Mesa, 1080p, DPR 1 (the low bar). Numbers tagged `[M2Max]` were measured on an
M2 Max — roughly the top of the M-series range and ~4× a base M1/M2 — and are quoted as *headroom evidence*, not
as machine `A` targets.

### 9.1 Throughput

| # | Metric (files by real name and size) | Target | Evidence |
|---|---|---|---|
| 1 | Load `m2m_ernie/T1.nii.gz` (**float32**, 256×256×208, 13.1 MB gz / 54.5 MB raw, range −41.807507 … 65535.0) to first frame | < 400 ms (A) | `[DATA]` |
| 2 | Load `m2m_ernie/label_prep/tissue_labeling_upsampled.nii.gz` (uint16, 512×512×416) and slice it | < 1.2 s to first frame (A) | 218 MB as R16UI, 34.9 ms one-shot upload `[M2Max]` |
| 3 | Parse `m2m_ernie/ernie.msh` (184,207,351 B; 847,165 nodes; 1,177,213 tris; 4,722,625 tets) | < 1.5 s native, < 3 s WASM | numpy structural parse 0.31 s `[M2Max]` |
| 4 | `ernie.msh` → first frame with tag surfaces (indexed, per-tag uniform draws) | < 1 s after parse | `[MODEL]` |
| 5 | Load `Simulations/Thalamus/TI/mesh/Thalamus_TI.msh` (255,005,467 B, one elm field `TI_max`) to first frame with the field coloured | < 5 s (A) | `[DATA]` |
| 6 | Load `m2m_ernie/ernie_seeg.msh` (492,090,201 B; 2,301,899 nodes; 13,033,527 tets) — declared worst case | < 9 s (A), progress visible within 200 ms, cancel honoured within 500 ms | `[DATA]` |
| 7 | `Simulations/flex_*/TI/mesh/*_TI.msh` (396,601,700 B) | same class as #6 | `[DATA]` |
| 8 | `morton_reorder` on ernie, WASM | < 250 ms | 144 ms `[M2Max]` |
| 9 | `build_tet_blocks` on ernie, WASM | < 500 ms | 39 ms, 1.77 MB `[M2Max]` |
| 10 | `plane_cut` on ernie, indexed, mid-axial and oblique, WASM | < 15 ms canonical, < 30 ms oblique | 2.7 / 3.1 ms `[M2Max]`; unindexed full scan was 290.7 ms `[M2Max]` |
| 11 | Cut-plane drag, worker → transfer → VBO → present, 2×DPR | ≥ 30 fps sustained **at interacting quality**, full-quality frame within 250 ms of release, < 40 ms input-to-photon | A **and** B |
| 12 | Orbit ernie tag surfaces, 2×DPR 1440p | 60 fps (≤ 8 ms) at full quality (A); adaptive ladder on B | plain 1.18 M-tri pass 2.32 ms, with wireframe 2.24 ms `[M2Max]` |
| 13 | 6 active clip planes, ernie tag surfaces, 2×DPR 1440p | ≤ 12 ms (A); `scripts/bench.ts` reports **both** clip paths | discard 2.89 ms vs `gl_ClipDistance` 2.07 ms `[M2Max]` |
| 14 | Slice scrub, T1 + 2 overlays + label outlines | 60 fps **at full quality** | 3-layer composite 1.04 ms, 4-tap outline 1.10 ms `[M2Max]` |
| 15 | Slice scrub with T1 + `Thalamus_TI.msh` `fillIn2D` + contours (5.9 M elements) | 30 fps, cut latency < 25 ms | derived from #10 |
| 16 | First `edges.surface` / element-field build on ernie (worker de-index + transfer + upload) | < 250 ms, progress shown | de-index ≈105 ms for 2.23 M faces `[M2Max]` |
| 17 | Isolation recompute (4.7 M tets) | < 300 ms — **and, when a de-indexed variant is live, this must cover re-extraction *plus* de-indexing** | `[MODEL]` |
| 18 | `marching_cubes` 256×256×208 | < 1 s | `[MODEL]` |
| 19 | Boundary extraction from `grey_Thalamus_TI.msh` (1,340,029 tets, 0 tris) | < 1.5 s WASM | `[DATA]` |
| 20 | Pointer-to-photon latency, orbit and slice scrub | ≤ 2 frames at the pinned cadence | measured in `scripts/bench.ts` by timestamping the input event and the following timer-query completion |

`scripts/bench.ts` pins `QualityLevel` to **full** so adaptive fallback cannot silently satisfy a bar it was meant
to be measured against, runs the cut at 20 offsets along the normal (not just the midplane), and reports the
indexed and de-indexed geometry variants' build times and byte counts separately.

### 9.2 Memory

wasm32 linear memory is hard-capped at 65,536 × 64 KiB = 4 GiB, and **4032 MiB is the usable ceiling**
(`maximum: 65537` → "value 65537 is above the upper bound 65536"; repeated `grow(1024)` failed at 64,512 pages)
`[N25]`. **It grows and never shrinks** — there is no shrink instruction and Rust's wasm dlmalloc keeps freed
pages, so `free(handle)` does not return RSS. This is why §5 mandates worker-per-dataset with `terminate()`.
wasm64 is out of scope: `wasm64-unknown-unknown` is Tier 3 and is not offered by `rustup target list` on rustc
1.93.0 (needs nightly + `-Zbuild-std`), and Memory64 also gives up guard-page bounds-check elision.

| Arena | Budget |
|---|---|
| Compute-worker wasm heap, per dataset, on load | **< 2 × file size** |
| — `ernie.msh` (184 MB) | measured peak ≈ **1.0 GB** with eager topology; ≤ 400 MB without it |
| — `Thalamus_TI.msh` (255 MB) | ≤ 620 MB |
| — `flex_*_TI.msh` (397 MB) | ≤ 900 MB |
| — `ernie_seeg.msh` (492 MB) / `ernie-seeg.msh` (497 MB) | ≈ **2.8 GB** with eager topology — **must stay < 1.5 GB**, which is what forces lazy topology, counting-sort face extraction, and dropping the input buffer |
| Renderer JS heap (ernie scene) | ≤ 400 MB; **no single ArrayBuffer > 1 GB** |
| GPU (ernie scene) | ≤ 500 MB |

Component sizes for `ernie.msh` `[MODEL]`: input bytes 184.2 MB · retained `Mesh` 130.3 MB (nodes 10.2, tets
75.6, tet_tags 18.9, tris 14.1, tri_tags 4.7, gmsh numbers 6.8) · `TetTopology` without `tet_faces` 190.2 MB
(9,509,557 unique faces × 12 + face_tets × 8) · counting-sort transient ≈ 227 MB. One 512×512×416 volume costs
208 MB as R16 (416 MB as R32F) in VRAM **and the same again** on the CPU for probes.
`ernie-seeg.msh` has 26,417,255 unique faces.

`wasm_heap_bytes()` is stamped on every `Res`, so this table is measurable rather than asserted; `scripts/bench.ts`
asserts peak `memory.buffer.byteLength` < 1.5 GB for `ernie_seeg.msh`. Files over 2 GiB get a warning at open.

---

## 10. Conventions

* TypeScript strict; ESLint + Prettier; no `any` in public APIs. Rust: `clippy -D warnings`, `rustfmt`, stable
  toolchain pinned in `rust-toolchain.toml`; **nightly is forbidden**.
* Commit messages: conventional commits (`feat(engine): …`). **Do not add `Co-Authored-By` trailers.**
* Every feature lands with tests per §11.
* Keep dependencies minimal; every new one needs a line in `docs/DECISIONS.md` **and** the coordination in §12.3.

---

## 11. Rendering verification

Rule 0: **an agent cannot judge a PNG; it can judge a number.** Every rendering feature ships **two** tests.

**(1) Analytic pixel assertion — the primary test.** The expected RGBA is computed from first principles, never
from a previous run, on a synthetic fixture. Backed by `engine.readPixel(viewId, x, y)`, with no PNG round-trip:

```ts
expectPixel(view: ViewId, x: number, y: number, rgba: [number, number, number, number], tol = 1): void;
```

Examples that must exist:
* a synthetic 4×4×4 volume with `v = i` under colormap `gray`, `scale {kind:'linear', lo:0, hi:3}` ⇒ the pixel at
  the cursor is exactly `rgb(85,85,85)` ± 1;
* a 4-tet mesh with tag colours from a fixture LUT ⇒ the cap pixel is exactly the tag colour;
* **three mandatory orientation tests** on an *asymmetric* synthetic volume (a bright cube in the
  left-anterior-superior octant only): the bright pixel is on screen-**left** in neurological and screen-**right**
  after `setRadiological(true)`, in each of the three 2D views.

**(2) Golden PNG — regression only.**
* Goldens are captured **only** under headless Chromium/SwiftShader, fixed canvas size, `deviceScaleFactor: 1`,
  `EngineOptions.aa = 'off'`, `deterministic: true`, launch args
  `--enable-unsafe-swiftshader --force-device-scale-factor=1 --disable-lcd-text --font-render-hinting=none
  --hide-scrollbars`, with `@playwright/test` pinned to an exact version (it pins the SwiftShader build).
* Stored per renderer class under `packages/engine/test/golden/<swiftshader|angle-metal>/`.
* Compared with `maxDiffPixelRatio: 0.002` and `threshold: 0.15` — never byte equality; SwiftShader's LLVM JIT is
  not bit-identical across arm64 macOS and x86_64 Linux.
* **`ubuntu-24.04` is the golden authority** (§12). The macOS job runs the same tests with a looser ratio.
* Regenerating a golden requires a commit body stating what changed visually.
* Every golden includes the §8 2D chrome (orientation letters, corner info, RAD/NEU badge) and, from Phase 2, the
  colour bars.
* One Phase-0 e2e asserts `Capabilities` is non-null and logs it, so every CI run records which renderer produced
  the goldens.

**Fixture expectations.** `scripts/gen-fixtures.py` writes `testdata/expected.json` (node counts, per-tag element
counts, field min/mean/max, voxel values at listed indices) computed with nibabel and **committed**, so Rust
real-data tests assert numbers without needing Python at test time. Reference values for the *real* dataset come
from `scripts/refvalues/{mesh,nifti}_refvalues.py` and are transcribed into `AGENTS.md`.

**Named tests that must exist (each pins a decision that has already been misread once):**

| Test | Asserts |
|---|---|
| Overlay compositing | `Thalamus_TI_subject_TI_max.nii.gz` over `T1.nii.gz` (genuinely different extents) on an **oblique** plane in the 3D view: the overlay's visible pixel count within its own footprint is **exactly 100 %**. A percentage tolerance would let the coplanar-depth bug ship. |
| Label outline zoom | `labeling.nii.gz` in `outline` mode at 0.05, 1.0 and 5.0 mm/px: measured thickness in **[0.8, 2.9] px** and ≥ 99 % coverage of the fill boundary at each. A voxel-space regression blows the upper bound immediately (12.87 px at 0.05 mm/px). |
| Clip-path equivalence | Every clip golden runs twice — `gl_ClipDistance` and `TETRAVOX_FORCE_DISCARD_CLIP=1` — asserting identical pixels. |
| Cap diagonal | Axial cut of ernie through the centroid: a pixel assertion in a region containing a known 2-2-split tet shows **no diagonal**, plus a whole-image edge-pixel count against a golden. The 17,983 quad caps in that cut make a dropped `edge_mask` trivially visible. |
| Pick | Double-click a fixed pixel on the scalp of ernie tag surfaces: returned `world` within 1 mm of the reference point, cross-checked by `locate` returning a tet with tag 5; all three 2D slice indices changed as expected; a background click returns `null`. |
| Oblique slice | `mode:'oblique'`, `normal = normalize([1,1,1])`, ernie T1 + a mesh contour layer, asserted at named pixels. This is what keeps §3's oblique claim honest through Phases 1–2. |
| Float volume not black | Load the real float32 `T1.nii.gz` and assert a non-black pixel at a known intracranial voxel. Catches the whole `floatLinear`/format-ladder class. |
| Transparency (i) | Scalp tag 1005 at opacity 0.35 over opaque GM tag 1002 coloured by `TI_max`: **no dark rim** from double-blended back faces. |
| Transparency (ii) | GM tag 1002 at opacity 0.5 with an opaque 10 mm sphere at the thalamus target, diffed against a CPU per-fragment-sorted reference render, reporting max per-pixel delta. This is what decides whether `twoPhase` is enough for v1 or depth peeling must move out of Phase 3. |
| Surface invariant | `tag_surfaces(ernie.msh)` equals the exterior ∪ tag-differing-interior face set exactly: 128,614 + 1,048,599 = 1,177,213; and on `ernie-seeg.msh` 202,318 + 2,427,261 = 2,629,579. |
| Cut index equivalence | `plane_cut` output is byte-identical with and without `TetBlocks`, for an axial and an oblique plane on ernie. |
| qfac | The qform rebuilt from `T1.nii.gz`'s quaternion with `qfac = −1` equals the sform to < 1e-4; dropping `qfac` gives max abs error 2.0. |
| Face-key width | A synthetic mesh with ≥ 2²¹ nodes, plus `ernie_seeg.msh`, extract the correct boundary (a u64 packed key silently deletes faces there). |

---

## 12. CI and packaging matrix

### 12.1 Jobs

| Job | Runner | Does | Notes |
|---|---|---|---|
| `test` | `ubuntu-24.04` | `cargo test --workspace`, `cargo clippy -- -D warnings`, `pnpm wasm`, `pnpm test`, `pnpm e2e` | **Golden authority** (§11) |
| `test` | `macos-latest` (macOS 26 arm64) | same | goldens compared with a looser ratio |
| `package` | `macos-latest` | `.dmg` arm64 | |
| `package` | `macos-26-intel` | `.dmg` x64 | `macos-latest` is arm64 only |
| `package` | `ubuntu-24.04` | `.AppImage` + `.deb` x64 | **Linux artefacts are never built on macOS** |
| `package` (optional) | `ubuntu-24.04-arm` | `.AppImage` arm64 | |

`pnpm package` on a developer machine produces that platform's artefacts only. Linux artefacts come from CI or
`docker run electronuserland/builder`.
Every `package` job ends with an **artefact smoke test**: launch the packaged binary with a CLI arg pointing at a
fixture and assert it exits 0 after rendering one frame.

### 12.2 Environment pitfalls encoded in the scaffold

* pnpm 10 does **not** run dependency lifecycle scripts by default, so esbuild installs without its platform
  binary and Vite fails with an error that never mentions pnpm (reproduced with pnpm 10.30.3: `Warning ─ Ignored
  build scripts: esbuild@0.25.0`). Root `package.json` therefore carries
  `"pnpm": { "onlyBuiltDependencies": ["esbuild", "electron"] }`.
* `electron` has **no postinstall**; it downloads its ~100 MB binary on **first launch**. CI caches
  `~/.cache/electron` and `~/.cache/ms-playwright` and runs an explicit `pnpm exec electron --version` warm-up
  step **before** the e2e job, so a download failure is its own red step.
* Gate: **a clean clone with an empty pnpm store reaches `pnpm e2e` green.**
* macOS signing: **unsigned for v1** (recorded in DECISIONS with the Gatekeeper consequence and the
  `xattr -dr com.apple.quarantine` walkthrough in USER_GUIDE.md). Developer ID + notarisation is a documented
  switch; auto-update is out of scope while unsigned. `electron-builder` is pinned to an exact patch version.
* Linux: the AppImage needs `--no-sandbox` or a correctly-owned `chrome-sandbox`; the app detects
  `caps.isSoftware` and surfaces it in the status bar rather than silently running at 2 fps.

### 12.3 Interface and dependency freeze

**Frozen at the end of Phase 0. Changing any of these requires an ARCHITECTURE.md edit in the same commit:**

1. `packages/protocol/src/index.ts` — §6.5 verbatim.
2. `packages/engine/src/scene/types.ts` — §4.1–§4.6 verbatim, zero imports.
3. `packages/engine/src/api.ts` — §4.7 verbatim, plus `MockEngine` satisfying it with no GL.
4. `packages/wasm/src/index.ts` — the client interface; `pkg/tvx_wasm.d.ts` stub committed so `tsc` works before
   the first wasm build.
5. Every Rust signature in §6.0–§6.4 as `unimplemented!()` stubs, so `cargo check --workspace` is green on day 1
   of Phase 1.

**Dependency freeze.** The Phase-0 scaffold adds every dependency Phase 1 needs, with both lockfiles committed and
green. Adding one afterwards is a coordinated change through the integrator, not an incidental one.

| Rust | Purpose |
|---|---|
| `thiserror` | `tvx_core::Error` |
| `flate2` (default-features off, `rust_backend`) | gzip **and** zlib inflate — GIfTI `GZipBase64Binary` is zlib; pulls `miniz_oxide` |
| `quick-xml` | GIfTI |
| `base64` | GIfTI |
| `byteorder` | endian-explicit reads (Gmsh binary, FreeSurfer big-endian) |
| `wasm-bindgen` `=0.2.127`, `js-sys` | `tvx-wasm` |
| `serde`, `serde_json` | meta/criteria JSON across the boundary |
| `criterion` (dev) | benches |

| Node | Purpose |
|---|---|
| `react`, `react-dom`, `zustand`, `gl-matrix`, `tailwindcss`, `postcss`, `autoprefixer` | UI + math |
| `typescript`, `vite`, `electron-vite`, `esbuild` | build |
| `electron` (≥ 38.2, pinned major), `electron-builder` (exact patch) | shell + packaging |
| `vitest`, `@playwright/test` (exact version — pins SwiftShader) | tests |
| `eslint`, `prettier`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` | lint |

**`pnpm-lock.yaml` and `Cargo.lock` are never merged.** On conflict, take `main`'s version and re-run
`pnpm install` / `cargo check --workspace` to regenerate. Worktree branches rebase on `main` before merge.
