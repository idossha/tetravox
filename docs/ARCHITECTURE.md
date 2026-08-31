---
layout: page
title: Architecture
permalink: /ARCHITECTURE.html
nav_order: 7
---

# Tetravox — Architecture Contract

> Desktop viewer for **voxel volumes** (NIfTI, FreeSurfer MGH/MGZ, NRRD, MetaImage) and **finite-element /
> surface meshes** (Gmsh `.msh`, GIfTI, FreeSurfer, STL/PLY/OBJ) with a linked **3D view + sagittal/axial/coronal 2D slices**. macOS + Linux.

This file is the **contract**. Deviating from it requires editing this file in the same commit and appending
an entry to `docs/DECISIONS.md`. Section numbers are cited from code comments and tests — do not renumber.

Measured figures live in `docs/BENCHMARKS.md`; this file states the *rules*, and quotes a number only where
the number is the reason for a rule.

---

## 1. Stack decisions (settled)

| Concern | Decision | Why |
|---|---|---|
| Shell / packaging | **Electron ≥ 42** (electron-vite, electron-builder → `.dmg`, `.AppImage`, `.deb`) | One Chromium build ⇒ identical WebGL2/ESSL **semantics** on macOS and Linux. *Not* identical GPU availability: Chromium M137 removed the automatic SwiftShader WebGL fallback, so a blocklisted driver yields `getContext('webgl2') === null`. The floor is 42 because Electron supports only the latest three majors, and because 42 is where the `electron` package stops shipping a `postinstall` (§12.2). Tauri's WebKitGTK WebGL2 is inconsistent — rejected. |
| Rendering | **Custom WebGL2 engine in TypeScript** (`packages/engine`), no three.js, no NiiVue | Small specialised primitive set (3D-texture slices with N composited layers, tet clip + exact caps, ID picking). One context / one depth buffer for volumes *and* meshes. WebGPU is a later backend behind the `GpuBackend` boundary. |
| Heavy compute | **Rust → WASM** (`crates/`), **one worker + one wasm instance per dataset** | Parsing 184–497 MB `.msh`, face extraction over 4.7–13.2 M tets, plane cuts, marching cubes, isolation masks. The pure-Rust crates carry no wasm-specific code, so the same code builds native/CLI. |
| WASM threading | **Single-threaded, permanently** | wasm threads need `SharedArrayBuffer` ⇒ `crossOriginIsolated` ⇒ COOP/COEP, plus `-Zbuild-std` on nightly, and nightly is forbidden (§10). Parallelism is worker-per-dataset. `rayon` is not a dependency and must not become one. |
| Cross-origin isolation | **Not enabled.** `tetravox://` is served **without** COOP/COEP | Follows from single-threaded WASM. The consequence is load-bearing and stated once here: **`SharedArrayBuffer` is `undefined` in the workers.** A synchronous wasm call therefore cannot be signalled from another thread, so cancelling an in-flight call is `worker.terminate()`, never a polled abort flag (§5 rule 6). |
| UI | **React 19 + TypeScript + Tailwind**; small Zustand store | UI is chrome only — all rendering is imperative in the engine. |
| Math | `gl-matrix` | Column-major `mat4` as `Float32Array(16)`. |
| Tests | `cargo test` · `vitest` · Playwright (Chromium headless **and** Electron) with **analytic pixel assertions + goldens** (§11) | An agent cannot judge a PNG; it can judge a number. |

**Non-goals:** WebGPU, Windows, DICOM, 4D playback (loading a 4D NIfTI and picking a volume index *is* in
scope), remote/URL loading, **third-party runtime-loaded plugins** (first-party extensions, downloaded
through File ▸ Extensions…, are §13), tractography, wasm64, wasm threads, two-file `.hdr`/`.img`. (Auto-update left
this list on 2026-08-31 — narrowed, not simply withdrawn: §12.4's updates are opt-in per click,
and *unattended* download-and-install stays a non-goal.)

---

## 2. Repository layout (pnpm + cargo workspaces)

```
tetravox/
├── Cargo.toml / Cargo.lock       # cargo workspace; lockfile committed and FROZEN (§12.3)
├── package.json / pnpm-lock.yaml # pnpm workspace root; lockfile committed and FROZEN
├── rust-toolchain.toml           # pinned stable; nightly is forbidden
├── crates/
│   ├── tvx-core/                 # shared types: Plane, BitMask, Field, LabelTable, Aabb, Error, ProgressSink
│   ├── tvx-nifti/                # NIfTI-1/2, MGH/MGZ, NRRD, MetaImage readers (+gzip), stats, GPU payload selection
│   ├── tvx-mesh-io/              # Gmsh .msh v2/v4.1, .msh.opt, .geo/.pos views, GIfTI, FreeSurfer, STL/PLY/OBJ, VTK, OFF, MEDIT
│   ├── tvx-geom/                 # surfaces, boundary extraction, Morton order, tet blocks, plane cut, isolation,
│   │                             #   marching cubes/tets, elm↔node, contours, point location, orientation
│   └── tvx-wasm/                 # wasm-bindgen bindings (handle-based) → packages/wasm/pkg (git-ignored)
├── packages/
│   ├── protocol/                 # @tetravox/protocol — worker envelope + every op args/result type (§6.5). FROZEN.
│   ├── wasm/                     # @tetravox/wasm — HAND-WRITTEN package.json; imports ./pkg/tvx_wasm.js
│   ├── engine/                   # @tetravox/engine — WebGL2 renderer, scene model, views, interaction, colormaps
│   └── app/                      # @tetravox/app — Electron main/preload/renderer (React UI), packaging config
├── python/                       # the automation client (docs/AUTOMATION.md)
├── testdata/                     # synthetic fixtures from scripts/gen-fixtures.py + manifest.json (committed)
├── scripts/                      # build-wasm.sh, gen-fixtures.py, bench.ts, refvalues/, reference/
├── docs/                         # ARCHITECTURE.md (this), DECISIONS.md, ROADMAP.md, TESTING.md,
│                                 #   BENCHMARKS.md, USER_GUIDE.md, AUTOMATION.md
└── .github/workflows/ci.yml      # the matrix in §12
```

Rules:
* `packages/wasm/pkg` is **never** a pnpm workspace member. wasm-pack writes a `pkg/package.json` named after
  the crate and a `pkg/.gitignore` containing `*`; the hand-written `@tetravox/wasm` wraps it. `pnpm wasm` is
  a prerequisite of `pnpm build` / `pnpm test` / `pnpm typecheck`.
* `wasm-bindgen` is pinned exactly in `Cargo.toml` and wasm-pack's version in `scripts/build-wasm.sh`.
* Real-data tests are gated by `TETRAVOX_TESTDATA`. Skipped, not failed, when unset.

---

## 3. Coordinate conventions

* **World space = scanner RAS millimetres.** Everything renders in world space.
* Volume `affine: mat4` maps voxel index `(i,j,k,1)` → world. Voxel centres are at integer indices. Source
  order: `sform` when `sform_code > 0`; else the **qform** rebuilt from `(quatern_b, quatern_c, quatern_d)`
  with `a = sqrt(max(0, 1 − b² − c² − d²))`,
  ```
  R = [[a²+b²−c²−d², 2(bc−ad),     2(bd+ac)    ],
       [2(bc+ad),     a²+c²−b²−d², 2(cd−ab)    ],
       [2(bd−ac),     2(cd+ab),    a²+d²−b²−c²]]
  M[:3,0] = R[:,0]·pixdim[1];  M[:3,1] = R[:,1]·pixdim[2];
  M[:3,2] = R[:,2]·pixdim[3]·qfac        where qfac = (pixdim[0] < 0 ? −1 : +1)
  M[:3,3] = (qoffset_x, qoffset_y, qoffset_z)
  ```
  else `diag(pixdim[1..3], 1)`. **`qfac` applies to the third column only.** Every volume in the reference
  dataset has `pixdim[0] = −1`; dropping `qfac` costs 2.0 mm/voxel of affine error and an A↔P flip.
* **Matrix layout, once, for the whole contract.** A Rust `[[f64; 4]; 4]` is **row-major** (`m[row][col]`, so
  `m[i][3]` is the translation). A wire `Mat4x4` (§6.5.1) is **flat, length 16, column-major**, so
  `w[12..15]` is the translation: `w[col * 4 + row] = m[row][col]`. Every crossing of that boundary
  transposes. Nothing deserialised straight off the wire may be typed `[[f64; 4]; 4]` — §6.3's
  `LabelVolumeCriteria.world_to_voxel` is `[f64; 16]` for that reason.
* `scl_slope`/`scl_inter` are **not** folded into the samples (§6.1); they are carried and applied in the
  shader and in the CPU probe path.
* Gmsh/SimNIBS meshes are already in the subject's world mm; loaded as-is. GIfTI applies
  `CoordinateSystemTransformMatrix` when `TransformedSpace == NIFTI_XFORM_SCANNER_ANAT`. FreeSurfer binary
  surfaces are in *tkr-RAS*; with a companion volume apply `vox2ras · inv(vox2ras-tkr)`, else load as-is.
  **Node coordinates handed to the engine are always world mm with the file's transform already applied**,
  reported in `MeshMeta.appliedTransform`; `MeshDataset.transform` is a separate, user-editable *additional*
  transform starting at identity (§4.3).
* 2D views: the plane is **derived from the cursor and the view basis**, never stored (§4.5). Presets: axial
  `normal = +Z`, coronal `−Y`, sagittal `−X`; screen-up is `+Y` for axial and `+Z` for the other two. A plane
  and its opposite normal are the same plane — the sign picks which side the camera sits on — and
  `(+Z, −Y, −X)` is the only preset triple satisfying §11's three mandatory orientation tests.
* Handedness: `right = cross(up, normal)` in **neurological** (subject left on screen left, the default).
  `radiological` negates `right` only — a mirror about the vertical screen axis, never touching `up`. This is
  the only definition, and it is what makes the flag well-defined for oblique planes.
* Cursor = one world point shared by all views. `hover` is a second, transient world point (§8).

**The four coordinate spaces the read-out offers** (§8's selector is `Engine.coordinateSpaces()`):

* **World RAS** — always available.
* **Voxel `ijk`, per volume** — `inverseAffine · world`.
* **FreeSurfer `tkr-RAS`, per volume** — derived from dims and spacing alone: `vox2ras-tkr` discards the
  file's affine and rebuilds one with the volume centre at the origin and FreeSurfer's fixed direction
  cosines,
  ```
  vox2ras_tkr = [[-dx,  0,  0,  dx*Nx/2],
                 [  0,  0, dz, -dz*Nz/2],
                 [  0,-dy,  0,  dy*Ny/2],
                 [  0,  0,  0,        1]]
  ```
  and `worldToTkr = vox2ras_tkr · inv(affine)`. It is defined for **every** volume, which is also its trap:
  a 1 mm and a 0.5 mm volume of one subject are *different* tkr spaces, so a tkr triple is always reported
  with the volume it belongs to and never for "the scene".
* **MNI**, from a SimNIBS `m2m_*/toMNI/` folder, **affine and nonlinear reported separately, never merged**.
  `charm` writes no `MNI2conform_*DOF.txt` at all on the reference subject, so the affine space is commonly
  absent while the warps are present.
  * *Affine*: `MNI2conform_*DOF.txt` is a whitespace-separated, row-major 4×4 mapping **MNI → subject**, so
    world → MNI is the **inverse of the file**. 12-DOF is preferred over 6-DOF.
  * *Nonlinear*: a deformation field's voxel values *are* the target space's coordinates. Subject → MNI is
    subject mm → the field's voxel index through `inv(field.affine)`, then **trilinear** interpolation
    clamped at the edge. MNI → subject is not an inversion: it is the same forward sample of the *other*
    file, `MNI2Conform_nonl.nii.gz`, so typed entry is exact rather than a fixed-point iteration. Verified
    against SimNIBS to 1e-3 mm.

**Surfaces add two more read-outs.** A surface's **vertex index** is the row in the file's own pointset, and
it is shared by every surface of one hemisphere from one subject — which is what makes a `sphere.reg` →
fsaverage `sphere` lookup a property of the *hemisphere* rather than of the displayed surface.
**fsaverage is a lookup, not a transform**: with a subject `sphere.reg` and an fsaverage `sphere` both on
disk, the correspondence is the nearest fsaverage vertex to each subject vertex **on the unit sphere** —
both files normalised first, because their radii are 1 and ~100 and the radius spread swamps the chord
between true neighbours (§6.3). Nothing is bundled; the fsaverage subject comes from
`AppSettings.freesurferSubjectsDir` (§8), the **hemisphere comes from the file name** (`lh.` / `rh.`) because
a SimNIBS GIfTI pointset carries no `AnatomicalStructurePrimary`, and the read-out omits the row when it is
not there. An fsaverage coordinate is quoted in **fsaverage's own tkr-RAS** and labelled with the surface it
came from (`fsaverage lh.pial`) rather than called "RAS".

---

## 4. Data model (engine, TypeScript)

`packages/engine/src/scene/types.ts` is exactly §4.1–§4.6, with **zero imports**. Frozen (§12.3).

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

**Colour range — one rule, one conversion point.** Every `vec4` used as a colour anywhere in §4 is **RGBA in
0..1 floats**. Everything Rust-side (§6.0 `LabelEntry.color: [u8;4]`, `MshOptions.tag_color`) and everything
on the §6.5 wire is **0..255**. The **only** place that divides by 255 is
`packages/engine/src/scene/fromMeta.ts`; nothing else in the engine and nothing in the app may convert.
`expectPixel` (§11) asserts 0..255 bytes, so the expected value for a tag-coloured pixel is the **wire**
`[u8;4]` — `round(engineColor·255)` and the wire value must agree exactly.

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
  softEdge: number;                   // width of the alpha ramp as a fraction of `hi - lo`; 0 = hard discard
}

export type PercentileKey = '0.1' | '1' | '2' | '5' | '50' | '95' | '98' | '99' | '99.9';

export interface Stats {                            // always in PHYSICAL units (post scl_slope/scl_inter)
  min: number; max: number; mean: number;
  percentiles: Record<PercentileKey, number>;
  histogram: Uint32Array;                           // 256 bins over [histogramLo, histogramHi]
  histogramLo: number; histogramHi: number;
}

export interface LabelEntry { id: number; name: string; color: vec4 }   // 0..1
export interface LabelTable { entries: LabelEntry[]; byId: Map<number, LabelEntry> }
```

`LabelTable` is keyed by id, never indexed by id — SimNIBS/FreeSurfer ids are sparse and reach 530.

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
                                      // for probes AND BOUNDED LOCAL READS; never re-sent to a worker.
  sclSlope: number; sclInter: number;  // identity (1, 0) when the header says no scaling
  isLabel: boolean;
  labelIds?: Uint32Array;             // sorted unique ids, present iff isLabel
  denseIndexOf?: Uint32Array;         // id -> dense index, present iff isLabel
  labelTable?: LabelTable;
  stats: Stats;
  units?: string;
  gpu: GpuFormatInfo;                 // GPU *description*; the WebGLTexture lives in engine-private GpuResources
  headerJson: string;                 // every raw header field, for the UI header panel
  toTemplate?: TemplateSpace;
  worker: WorkerRef; handle: Handle;
}

export interface TemplateSpace {
  name: 'MNI152' | 'MNI305';
  kind: 'affine' | 'simnibs';       // 'affine' = derived from sform/qform_code 4; 'simnibs' = a toMNI/ folder
  matrix: mat4;                     // WORLD -> TEMPLATE. Identity when hasAffine is false.
  hasAffine?: boolean;              // false => `matrix` is a placeholder and the affine space is disabled
  affineFile?: string;              // e.g. 'MNI2conform_12DOF.txt', for the read-out's label
  nonlinearAvailable?: boolean;     // a warp exists ON DISK — the space is offered before it loads
  forwardFieldId?: DatasetId;       // Conform2MNI_nonl.nii.gz as a dataset: subject -> template
  inverseFieldId?: DatasetId;       // MNI2Conform_nonl.nii.gz as a dataset: template -> subject
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
  transform: mat4;                    // USER-EDITABLE ADDITIONAL transform; ALWAYS identity on load
  appliedTransform: mat4;             // what the loader baked into the node coordinates (§3)
  dataSpace?: string;                 // GIfTI CoordinateSystem strings, verbatim, when the file carried them
  transformedSpace?: string;
  bounds: Aabb;                       // of the delivered (world-mm) node coordinates, before `transform`
  nNodes: number; nTris: number; nTets: number; hasTris: boolean;
  identityElementNumbers: boolean;    // §6.2's identity rule holds ⇒ `gmsh - 1` is a valid element row
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

**`MeshDataset.transform` is never already in the vertices.** The loader bakes the file's own transform into
the node coordinates and reports it in `appliedTransform`; `transform` is an *additional* one the user may
edit, applied on top by the engine's model matrix and serialised in `ViewSpec`.

**Mesh bulk arrays never reach the UI thread.** Nodes/tets/tris/fields stay in the dataset's worker; the UI
thread sees only draw-ready buffers (uploaded to GL, then dropped) and probe results.

**`VolumeDataset.data` is for probes and bounded local reads — a whole-volume scan is still not a probe**
(2026-08-30). A probe is one voxel; a point tool that snaps a contact to the local intensity peak needs the
*neighbourhood*, which on a 0.5 mm CT at a 1.5 mm radius is a few hundred voxels and well under a millisecond.
`derived/voxel-box.ts` is the whole of that permission and it carries the bound with it:
`sampleVoxelBox(ds, world, radiusMm)` returns the physical values (`raw * sclSlope + sclInter`, applied once)
in a box whose half-extent is `max(trunc(radiusMm / spacing), 1)` voxels **per axis**, clipped to the volume
and capped at `MAX_BOX_VOXELS` = 32 voxels on an axis; it returns `null` for `rgb24`/`rgba32`, whose samples
are interleaved components with no single value, and for a point outside the volume — never a clamp, because
a snap that silently pulled a click back inside the head would be worse than one that refused. `peakCentroid`
is the one consumer the engine ships: the intensity-weighted centroid of that box above the **midpoint of its
own range** (`clip(v − (max − ½(max − min)), 0)`), computed in voxel indices and mapped through the affine, so
it is sub-voxel and needs no absolute threshold. It is `null` on a flat box, where there is no peak to report.

**That half-extent is a parity rule, not a numerical preference** (2026-08-30): it is
`SEEGContactEditor.snapToMetal`'s `rad_vox = np.maximum((radius_mm / spacing).astype(int), 1)`, character for
character — truncation, floor of one voxel. §13's sEEG extension tells users it reproduces the 3D Slicer editor's
workflow "so the two can be used on the same subject interchangeably", and a snap is interchangeable only if
it searches the same neighbourhood. `ceil` differs on every non-integer `radius / spacing`: at the extension's
default 1.5 mm it is 5×5×5 on a 1 mm CT where Slicer is 3×3×3. Two things here are deliberately **not**
Slicer's, and both are argued in `DECISIONS.md`: the query's voxel index is rounded HALF-UP (`Math.round`)
where Python's `round` is half-to-even, and a **flat** box answers `null` where Slicer's `+ 1e-6` in the
threshold makes it return the box centroid.
Both are pure and exported from `@tetravox/engine`, so the app's no-GL engine gives the same answers. The cap
is what makes this an exception rather than a hole: without it "read `data` on the UI thread" is a door to a
512³ loop inside a `pointermove`, and §5's worker-per-dataset arrangement leaks through it. A caller who wants
more than a box asks a worker (§6.5).

### 4.4 Layers

```ts
export interface LayerBase {
  id: LayerId; datasetId: DatasetId; name: string;
  visible: boolean; opacity: number; pickable: boolean; showColorbar: boolean;
  module?: string;                    // §13: the module that owns this layer's edits. A TAG the engine
                                      // never interprets; absent = core-owned
}

export interface VolumeLayer extends LayerBase {
  kind: 'volume';
  volumeIndex: number;                                  // 0 unless nvols > 1. Changing it is a `volumeFrame` op
  colormap: ColormapName | string;                      // string = user .json colormap id (§7.6)
  colormapNegative?: ColormapName | string;
  scale: Scale; threshold: Threshold;
  interpolation: 'linear' | 'nearest';                  // forced to 'nearest' when dataset.isLabel
  labelMode: 'fill' | 'outline' | 'both';
  outlineWidthPx: number;                               // render-target px (§7.0.5)
  visibleLabels?: Uint32Array;                          // undefined = all
  labelOpacity?: Record<number, number>;
  labelColors?: Record<number, vec4>;                   // per-label override, beating the LabelTable
  selectedLabels?: number[];                            // the outline-emphasis set
  showIn3D: boolean;
  precision: 'auto' | 'f32';                            // 'f32' forces R32F, guarded by caps.floatLinear
  iso3d?: VolumeIso3d;                                  // the volume's 3D SURFACE — additive, optional
}

export interface VolumeIso3d {
  enabled: boolean;                                     // the "3D surface" switch
  iso: number;                                          // scalar volumes only; default = the volume's p95
  color: vec4;                                          // scalar volumes only
  opacity: number;                                      // the surfaces', not the slice's
  smooth: boolean;
  faceMode: 'cull' | 'both';
}

export interface ClipPlane { plane: Plane; enabled: boolean; followCursor?: boolean }

export interface IsolateSpec {
  tags?: number[];
  field?: { source: 'node' | 'elm'; name: string; component: 'mag' | 0 | 1 | 2; lo: number; hi: number };
  sphere?: { center: vec3; radius: number };
  box?: Aabb;
  labelVolume?: { datasetId: DatasetId; volumeIndex: number; labels: number[] };
  combine: 'all' | 'any';
}

/** How a magnitude becomes a length (§7.4). Maths: `derived/glyph-scale.ts`. */
export interface GlyphScaling {
  mode: 'fixed' | 'linear' | 'sqrt' | 'log';   // 'log' is log10 of |E| above logFloor
  lengthMm: number;                            // the length AT the reference magnitude
  normalizeTo: 'p99' | 'max' | number | null;  // the reference; null = lengthMm per unit of |E|
  logFloor: number;                            // field units; at or below it the arrow is dropped
}

export interface GlyphSpec {
  field: { source: 'node' | 'elm'; name: string };
  shape: 'arrow' | 'line';
  subsample: { everyNth: number } | { maxCount: number };
  /** The strings are legacy: 'fixed', and 'byMagnitude' = linear normalised to the field max. */
  scale: 'fixed' | 'byMagnitude' | GlyphScaling;
  lengthMm: number;                            // superseded by scale.lengthMm in the object form
  colorBy: 'magnitude' | 'solid'; color: vec4;
  clipToCutPlane: boolean;                     // @deprecated spelling of onCutPlaneOnly
  onCutPlaneOnly?: boolean;                    // density: origins within cutSlabMm of the cut plane
  cutSlabMm?: number;                          // half-thickness of that slab, mm. Default 1
  headProportion?: number;                     // 0..0.9 of the length. Default 0.3
  origins?: 'surface' | 'volume';              // absent = 'surface' (§7.4)
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
  contourColor?: vec4;                                  // undefined = edgeColor; seeded per surface (§7.4)
}

export interface IsosurfaceLayer extends LayerBase {
  kind: 'iso';
  source: { datasetId: DatasetId; volumeIndex?: number;
            field?: { source: 'node' | 'elm'; name: string; component: 'mag' | 0 | 1 | 2 } };
  iso: number; color: vec4; smooth: boolean; faceMode: 'cull' | 'both';
}

export interface PointsLayer extends LayerBase {
  kind: 'points';
  points: { name?: string; position: vec3; color?: vec4; radiusMm?: number; value?: number;
            // §13 (2026-08-30). All optional; the array index stays the ENGINE's key (ProbeRow.labelId,
            // nearestPoint) and a tool's selection is by `id`, which survives array replacement.
            id?: string;              // stable identity, unique within the layer
            group?: string;           // the set it belongs to — an sEEG electrode, a montage
            ordinal?: number }[];     // 1-based position within `group`; 1 = deepest contact
  shape: 'sphere' | 'dot'; radiusMm: number; color: vec4; showLabels: boolean;

  // A Gmsh parsed view's extras (§6.2). EVERY field below is optional and absent reproduces the
  // behaviour of a plain points layer exactly, so an existing scene loads unchanged.
  labels?: { position: vec3; text: string }[];   // free-standing 3D text, drawn in §7.2's overlay
  labelScale?: number; labelColor?: vec4;        // default 1; default `color`
  lineSegments?: Float32Array;                   // 6/segment — `SL`, drawn like a §7.0.6 contour
  lineWidthPx?: number; lineColor?: vec4;        // default 2 render-target px; default `color`
  // `valueMode`, NOT `colorMode`: `MeshLayer.colorMode` is a different union on the same `Layer`
  // union, and a spread of `Partial<Layer>` widens to both. Resolved on the CPU in `packPoints`.
  valueMode?: 'solid' | 'value';
  colormap?: ColormapName | string;
  valueRange?: { lo: number; hi: number };       // absent = the layer's own min..max

  // §13 (2026-08-30). Both optional; both default to the Phase-2 behaviour, so no golden moves.
  offPlaneOpacity?: number;                      // 0/absent = today's 2D cull; > 0 draws the off-slice
                                                 // points as full-radius discs at this alpha
  labelSource?: 'labels' | 'names';              // 'labels' (default) = the `labels` array;
                                                 // 'names' = points[].name at each point's position

  // §13's sEEG UX wave (2026-08-30, second pass). Three more, same rule: absent is today.
  lineColors?: Float32Array;                     // 4/segment RGBA, parallel to `lineSegments`;
                                                 // absent = the single `lineColor`. Short = ignored
  labelColorSource?: 'layer' | 'points';         // 'layer' (default) = `labelColor ?? color`;
                                                 // 'points' = each name in its point's own `color`
  dotRadiusPx?: number;                          // `shape:'dot'` screen radius, CSS px; absent = 4
}

export type Layer = VolumeLayer | MeshLayer | IsosurfaceLayer | PointsLayer;
```

Layers are ordered bottom→top and appear in every view unless a view's `layerVisibility` says otherwise.

**`VolumeLayer.iso3d` — the volume layer *owns* its isosurfaces, and they are derived, never stored.**
`layers/iso3d.ts`'s `derivedIsoLayers(layer, ds)` is a pure function from the volume layer to the
`IsosurfaceLayer`s it implies; the engine reconciles one runtime per returned layer, keyed by the owning
layer's id, and hands them to §7.2 through `DrawInput.ownedRuntimes`. They are **not** rows in
`Scene.layers`, carry no row in §8's layer panel, and `collectPickItems` never reaches them. Re-running the
derivation is what makes the surfaces follow `volumeIndex`, `visible`, `visibleLabels`, `selectedLabels` and
`labelColors`, and drop with the layer. Only the `iso3d` block is persisted.

* **Scalar volumes**: one surface at `iso`, in `color`. The default level is the volume's **p95** — a
  `[min, max]` midpoint is an empty surface on a head volume, which is mostly background. The editor's
  slider spans `Stats.histogramLo/Hi`.
* **Label volumes**: one surface **per visible-or-selected region** at `label − 0.5`, in that region's colour
  (`labelColors` first, then the dataset's `LabelTable`). Background id 0 never gets one; `iso` and `color`
  are unread. An empty `selectedLabels` is "no narrowing", not "nothing".
* The surfaces draw in **3D panes only**: a slice pane already draws the volume, and a second,
  differently-thresholded cross-section over it is what §7.4's `contoursIn2D` is for.
* **Not yet**: an isosurface has no clip plane — §7.2's iso draw disables clip distances.

**R5's four per-region edits are layer state, and that is what makes them persist.** §4.6 does not serialise
a `LabelTable` — it is re-derived from the dataset and its LUT on load — so an edited colour written into the
table would be lost on the next open. `labelColors` is therefore an *override*: the file's own colours stay
readable underneath it, a per-row Reset is deleting a key, and "Save LUT…" writes the override merged over
the table. `selectedLabels` is a plain `number[]`, unlike `visibleLabels`' `Uint32Array`: a selection is a
handful of ids a panel edits click by click, not a filter over up to 65535 of them.

**A points layer's eight §13 fields, and what "additive" guarantees here** (2026-08-30).
`LayerBase.module`, `points[].id` / `.group` / `.ordinal`, `PointsLayer.offPlaneOpacity`, `.labelSource`,
`.lineColors`, `.labelColorSource` and `.dotRadiusPx` are every one of them optional, and **absent
reproduces the previous behaviour exactly** — that is the whole of §12.3's additive rule, and for these
fields it is checkable: `module`, `group` and `ordinal` are read by nobody in the engine, `id` is read only
by a tool's selection, and the five rendering fields all default to the branch the shader and the overlay
took before they existed. No existing scene changes and no §11 golden moves.

**One layer is a whole implant, so the line and the name need the electrode's colour.** `points[].group` is
what lets twelve electrodes share one layer (see the identity paragraph below), and the price of that was a
single `lineColor` across every shaft and a single `labelColor` across every name — a picture whose discs
say which electrode a contact belongs to and whose lines and names, six pixels away, do not.
**`lineColors`** is four floats per segment, parallel to `lineSegments`'s six; per *segment* rather than per
group because the engine has no group concept — a flat array of endpoints admits no other statement — and an
array shorter than `4 · segments` is **ignored** rather than half-applied, because a shaft coloured for three
segments and grey for the rest lies about which electrode the rest belongs to. It is a `Float32Array`, so
§4.6 drops it exactly as it drops `lineSegments`, and whoever rebuilds the segments rebuilds it beside them.
**`labelColorSource: 'points'`** draws each name in its own point's `color` — the colour `packPoints` already
gives that point's disc, so a marker and its name cannot disagree — and only `labelSource: 'names'` can
honour it, since a `labels` entry is free-standing `T3` text with no point behind it.

**`dotRadiusPx` is the `dot` branch's size, and there is one of it.** CSS pixels, because that is the unit
the constant it replaces (`DOT_RADIUS_PX` = 4) is authored in; clamped to 0.5…64 px, because a scene file is
editable text and `NaN` deletes the quad rather than resizing it. `overlay/point-ring.ts#dotRadiusPxOf` is
the single function the shader uniform (`uDotPx = dotRadiusPxOf(layer) · uiScale`), the selection ring and
`pointAtPane`'s grab radius all read, so a bigger marker is a bigger target: a 12 px disc with an 8 px grab
would put the hit boundary a third of the way inside the thing the user is aiming at. `shape: 'sphere'` does
not read it — a sphere's size is `radiusMm`, which is also its cross-section, its billboard, its label slab
and its probe radius, and a second size for one of those five would disagree with the other four.

**The 2D cull and the ghost.** §7.2's 2D rule for a points layer is the sphere ∩ plane disc, and a point
further than its own radius from the plane is dropped entirely — which is what makes a points layer sweep
with the cursor. `offPlaneOpacity > 0` adds the other case: the off-slice points are also drawn, as the
**full-radius** disc projected onto the plane at that alpha (`shape: 'dot'` at its constant pixel radius,
which is the size it draws at on-slice). A depth electrode is twelve contacts on a line no single slice
contains, so under the cull alone the shaft is never visible as a shaft. **The labels do not follow the
discs**: they stay slab-culled at `max(radiusMm, 1 mm)` even when the discs are ghosted, because a whole net's
names projected onto one slice is exactly the smear the slab rule exists to prevent. §7.2 states that
divergence beside the rule it diverges from.

**Identity: the index is the engine's, the id is the tool's.** `points[]` is an array and the index is what
the engine keys on — `ProbeRow.labelId`, `nearestPoint`, the instance row. It cannot also be an identity:
deleting the second of twelve contacts renumbers ten of them, so a selection or an undo step holding an index
afterwards names the wrong electrode. `id` is the identity a tool selects by and survives an insertion, a
deletion, and a wholesale `points` replacement.

### 4.5 Views, layout, scene

```ts
export type SliceMode = 'axial' | 'coronal' | 'sagittal' | 'oblique';

export interface SliceView {
  id: ViewId; mode: SliceMode;
  normal: vec3;                                  // unit, world RAS. Presets lock it (§3).
  up: vec3;                                      // unit, in-plane, screen up. Re-orthogonalised on load:
                                                 //   up ← normalize(up − (up·n)n); rejected if |up × n| < 1e-4
  camera: { center: vec2; mmPerPx: number };     // in-plane pan/zoom, relative to the SCENE BOUNDS centre
  layerVisibility?: Record<LayerId, boolean>;
}
// The plane is DERIVED, never stored: plane = { normal, offset: -dot(normal, scene.cursor) }.
// One source of truth (the cursor) ⇒ cursor sync is identical for canonical and oblique views.

export interface Camera3D {
  target: vec3; distance: number; rotation: quat;
  fovYDeg: number; orthographic: boolean;
  near: number; far: number;                     // near = max(1 mm, fitRadius/1000), far = fitRadius * 8
}
export interface View3D { id: ViewId; camera: Camera3D; showSlicePlanes: boolean;
                          layerVisibility?: Record<LayerId, boolean> }
export type View = SliceView | View3D;

export type LayoutKind = '1x1' | '1x3' | '1x3-horizontal' | '2x2' | '3d-only'
                      | '1+3'          // 3D large on the left, the three slices stacked at 2/3 : 1/3
                      | '3d+1';        // the 3D pane and one slice, side by side
export interface Layout { kind: LayoutKind; cells: ViewId[] }

export interface Annotations {
  orientationLabels: boolean; cornerInfo: boolean; conventionBadge: true;   // badge is not optional
  scaleBar: boolean; colorbars: boolean; crosshair: boolean;
  orientationCube: boolean;      // the 3D pane's clickable A/P/L/R/S/I cube
}

export interface QualityLevel {
  name: 'full' | 'interacting' | 'reduced';
  dprScale: number;                 // 1 = one device pixel per CSS px
  msaa: 0 | 2 | 4;
  capDecimation: number;            // 1 = exact
  oit: boolean;
}

/** A distance or an angle the user placed. World RAS millimetres — never pane pixels, so it is the
 *  same length at every zoom, in either convention, and read off the 3D pane. `points` is 2 for
 *  `'distance'` and 3 for `'angle'`, whose vertex is `points[1]`. */
export interface Measurement {
  id: MeasurementId;
  kind: 'distance' | 'angle';
  name: string;                                     // `M1`, `M2`, … unless renamed
  points: vec3[];
  color?: vec4;                                     // absent = OverlayTheme.measure
  viewId?: ViewId;                                  // the pane the points were placed in
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
  measurements: Measurement[];                      // §7.5's measure tool
}
```

**A measurement is scene state.** Not a layer: it has no dataset, nothing colours it, and nothing about it
belongs in the layer panel's stacking order. Not host chrome either — it is exactly the kind of edit that
must persist through save/load. So it is a field on `Scene`, serialised by §4.6, drawn by §7.2's pass 3 in
**every pane that contains its points**, and listed in §8's measurement panel. The points are **world RAS
millimetres**: a 2D click becomes one through `paneToWorld` (the pointer ray ∩ that pane's derived plane), a
3D click through §7.2.3's `pick`. A screen-space measurement scaled by `mmPerPx` would be right only for a
point that happens to lie on the plane it was clicked in, and silently wrong for every 3D pick.

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
                                cacheKey: string /* `${datasetId}|${maskId ?? ''}|${generation}|${clipStateHash}` */ }
```

**`SliceView.camera.center` is measured from the scene bounding-box centre, not from the cursor.** With the
cursor as the in-plane origin, setting the cursor moves the **image** under a crosshair pinned to the pane
centre — the behaviour R3 forbids, and what made left-click-to-set-cursor impossible to write, because the
point the user clicked slid away from the pointer as the click landed. With a cursor-independent anchor,
`center` is a pure pan, the crosshair is drawn where the cursor projects, and a left-drag leaves every
non-crosshair pixel byte-identical. The anchor is **derived, never stored** — the centre of `Scene`'s dataset
bounds — so it changes only when a dataset is added or removed. `resetView` sets `center = [0, 0]`, framing
the **data**. The along-normal component of the plane is still the cursor's alone.

### 4.6 ViewSpec — the persisted form (`*.tetravox.json`)

```ts
export interface SidecarRef {
  path: string;                     // relative to the DATASET's directory, not to the scene file
  absPath?: string;                 // fallback when the relative path misses
}
export interface DatasetRef {
  id: DatasetId; kind: 'volume' | 'mesh'; name: string;
  path: string;                     // relative to the scene file
  absPath?: string;
  fingerprint: string;              // `tvxfp1-<len:16hex>-<hash:16hex>` — see below
  sidecars?: { lut?: SidecarRef; opt?: SidecarRef };
}
export type SerializableLayer =
  Omit<Layer, 'visibleLabels'> & { visibleLabels?: number[]; label?: { name: string; mode: string;
                                   outlineWidthPx: number; visibleLabels?: number[] } };

export interface ViewSpec {
  version: 1 | 2;                   // `migrateViewSpec` upgrades a 1; a version ABOVE the current one is refused
  datasets: DatasetRef[];
  layers: SerializableLayer[];
  activeLayerId: LayerId | null;
  slices: SliceView[]; view3d: View3D; layout: Layout;
  cursor: vec3; radiological: boolean; background: vec4;
  lighting: Scene['lighting']; annotations: Annotations;
  transparency: Scene['transparency'];
  theme?: 'system' | 'light' | 'dark';   // v2, optional — the app's, not the engine's
  measurements?: Measurement[];          // v2, optional: absent = NONE, never "keep what the live scene had"
  extensions?: Record<string, { module: string; version: number;   // §13 module blocks, optional, absent = NONE.
                                moduleVersion: string; data: unknown }>;  // written by the APP, like `theme`
}
```

**JSON has no infinity.** `Threshold.lo`/`.hi` default to `∓Infinity`, and `JSON.stringify` turns those into
`null` without a word. They are written as `null` deliberately and read back as the bound the null stands for.

**What is not serialised, and why.** `LabelTable`s are re-derived from the dataset and its LUT on load. A
points layer's `labels` and `lineSegments` are re-derived from the parsed `.geo` views (§6.2) — and
`lineSegments` is a `Float32Array`, which `JSON.stringify` turns into `{"0":…}`, so persisting it would write
megabytes that restore garbage. Everything the *user* chose about a points layer is persisted. `measurements`
is the opposite case: it is plain JSON, there is nothing to re-derive it from, and it is written as-is.

**Per-layer fields ride the spread, and that is a guarantee, not an accident** (2026-08-30). `serializableLayer`
is `{ ...layer }` minus the two derived points fields and plus the JSON forms of `threshold` /
`visibleLabels` / `label`; `remapLayer` is the same spread with the dataset ids remapped. So **every**
kind-specific field — including one this build has never heard of — survives save → load → `addLayer`. It was
already true, it was undocumented, and §13 depends on it: a scene re-saved by an older build must keep an
extension's points with their `id`, `group` and `ordinal` even though that build drops the `extensions` block it
cannot describe. It is stated here so that a future `SerializableLayer` narrowed to an explicit field list is
recognised as the breaking change it would be, and it is pinned by `roundtrip.test.ts`, which asserts deep
equality over every key of a fully-populated layer of each kind.

**`extensions` — §13's per-module blocks, written by the app.** Typed on `ViewSpec` exactly like `theme`, and
for the same reason: it belongs to the file, but `Engine.serialize()` cannot produce it. `toViewSpec`
enumerates `Scene` fields, and there is no extension state in `Scene` — `LayerBase.module` is a tag the engine
never interprets — so the **app** writes this field on save and hands each block back to its extension on load,
carrying an unknown extension's block forward verbatim. §13.2 owns the rules: ≤ 256 KiB of JSON per block, and
never a `LayerId` or `DatasetId` inside one, because both are reassigned on load. An extension finds its layer
again through `LayerBase.module`.

**`sidecars` — because "re-derived from the dataset and its LUT" needs the LUT.** `ernie.msh` carries no
`$PhysicalNames`, so `ernie.msh.opt` is the only source of the tissue names and colours the head is drawn in,
and a label volume's names and colours come from its `_LUT.txt`. None of that lives in `Layer`, so a
`DatasetRef` recording only `path` reopened the same file as a different-looking dataset. `SidecarRef.path`
is relative to **the dataset**, not the scene file, because a sidecar travels with the file it describes.
`Engine.load` derives the paths from wherever each dataset resolved to (`sidecarPathsFor`, exported so a host
that owns the filesystem can admit exactly the same paths). **Reading a sidecar is best-effort**: one that is
not beside this copy of the file is a missing table, never a failed load.

**`fingerprint` — `tvxfp1`, normative.** The producer is `tvx_core::fingerprint` (§6.0), called by
`load_volume` / `load_mesh` over the bytes the loader was handed and **before** the parser frees them (§5
rule 5). §5 rule 3 forbids the UI thread from ever seeing those bytes, so it cannot be computed anywhere else.

```text
fingerprint(bytes) = "tvxfp1-" ++ hex16(len) ++ "-" ++ hex16(h)
```

* `len` is `bytes.len()` as a u64, 16 lower-case hex digits.
* `h` is **FNV-1a-64** (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`) over a canonical stream,
  finished with MurmurHash3's `fmix64` avalanche, formatted the same way.
* The canonical stream is the 8 bytes of `len` **little-endian**, then the sampled chunks in ascending offset
  order.
* The chunks are the whole slice when `len ≤ 8 MiB`; otherwise exactly three 1 MiB windows — at `0`, at
  `len/2 − 512 KiB`, and at `len − 1 MiB`. Above 8 MiB those never overlap, so any file is digested over 3 MiB
  (8.9 ms on the 184 MB `ernie.msh`).

This **identifies** a file; it does not authenticate one. The algorithm is written out rather than delegated
to a hasher's default because the string is persisted and has to mean the same thing on every platform and in
every future build; it uses only `^`, `*` and shifts on u64, so it is identical on wasm32 and native. Two
files of different length always differ. An edit to a file larger than 8 MiB that touches none of the three
windows is **not** detected — the accepted price of not reading 180 MB twice for a dialog. The digest is of
the bytes the loader was handed, i.e. **after** `.gz` inflation, so a `.nii` and a `.nii.gz` of one volume
share a fingerprint. Sidecars are **not** digested: recolouring a tissue must not make the file look
different.

### 4.7 Engine facade

`packages/engine/src/api.ts` is exactly this interface. Frozen (§12.3). It imports the §4.1–§4.6 types from
`./scene/types`, `Capabilities` from `./gl/caps` (§7.1), and the concrete `TetravoxEngine` from `./engine` —
the single **value** import, so `create()` can return a working engine synchronously. `./engine` imports back
with `import type` only, so there is no runtime cycle.

**Everything the UI can do must be reachable from the `Engine` API alone** (§8). That is why `resetView`,
`cameraPreset`, `setAnnotations`, `heapBytes` and `renderNow` are part of the interface rather than optional
extras the app duck-types, and why `nudgeCursor`, `labelCentroids`, `contourAtScreen`, the measure members and
the coordinate-space members live here: each is engine geometry the app is forbidden to re-derive.
`MockEngine` implements the interface with no GL — a *compile-time* proof that it is implementable without a
context; the behavioural no-GL engine the app is developed against is `packages/app`'s `NoGlEngine`.

```ts
export type DatasetSource =                     // maps 1:1 onto protocol `LoadSource` (§6.5.1)
  | { kind: 'path'; path: string; sidecars?: { lut?: string; opt?: string } }
  | { kind: 'file'; file: File; sidecars?: { lut?: File; opt?: File } }
  | { kind: 'bytes'; name: string; bytes: ArrayBuffer;
      sidecars?: { lut?: ArrayBuffer; opt?: ArrayBuffer } };

export type NewLayer = { datasetId: DatasetId; kind: Layer['kind'] } & Partial<Layer>;
export type CameraPreset = 1 | 2 | 3 | 4 | 5 | 6 | 'A' | 'P' | 'L' | 'R' | 'S' | 'I';   // §7.5

export type CoordSpaceRef =
  | { space: 'world' }
  | { space: 'voxel'; datasetId: DatasetId }
  | { space: 'tkr'; datasetId: DatasetId }
  | { space: 'mni-affine'; datasetId: DatasetId }
  | { space: 'mni-nonlinear'; datasetId: DatasetId };
export interface CoordSpaceOption {
  ref: CoordSpaceRef; label: string; decimals: number;
  enabled: boolean; reason?: string; loading?: boolean;
}
export interface FsaverageSpec {
  surfaceId: DatasetId;         // the subject surface being looked at
  subjectSphereId: DatasetId;   // that hemisphere's sphere.reg
  fsavgSphereId: DatasetId;     // fsaverage/surf/<hemi>.sphere
  fsavgSurfaceId?: DatasetId;   // fsaverage/surf/<hemi>.pial — the coordinate that is quoted
  targetName?: string;
}

export interface PickResult {
  layerId: LayerId; datasetId: DatasetId;
  elementId: number;                            // Gmsh element number (§6.2), or plane index for slice quads
  elementKind: 'tri' | 'tet' | 'slice';         // 'slice' from the layer kind; 'tri' vs 'tet' from payload bit 24
  world: vec3; depth: number;
}
export interface ProbeRow {
  layerId: LayerId; layerName: string; kind: Layer['kind'];
  voxel?: vec3; value?: number | vec3;
  labelId?: number; labelName?: string;
  elementId?: number; tag?: number; tagName?: string;
  fields?: { name: string; value: number | number[] }[];
  vertex?: number; vertexWorld?: vec3;                          // surfaces (§3)
  fsavgVertex?: number; fsavgWorld?: vec3; fsavgSpace?: string;
}
export interface ProbeResult { world: vec3; mni?: vec3; tkr?: vec3; tkrVolume?: string;
                               mniNonlinear?: vec3; rows: ProbeRow[] }
export interface LabelCentroid { id: number; centroid: vec3; count: number }   // world RAS

// §13's point tool (2026-08-30). Additive; absent, nothing here is armed.
export interface PointToolSpec {
  layerId: LayerId;
  mode: 'select' | 'place';                     // 'place': EVERY left click appends, with no hit test
  template?: { color?: vec4; radiusMm?: number; group?: string };
}
export interface PointSelection { layerId: LayerId; pointId: string; index: number }   // id is the identity
export interface PointToolEvent {
  layerId: LayerId;
  kind: 'placed' | 'selected' | 'dragEnd' | 'cleared';
  pointId: string | null;                       // null with index −1 for 'cleared'
  index: number;
  world?: vec3; viewId?: ViewId;
}

export interface ScreenshotOptions {
  target: 'view' | 'grid'; viewId?: ViewId;
  width?: number; height?: number; scale?: number; dpi?: number;   // dpi written to the PNG pHYs chunk
  background: 'scene' | 'white' | 'transparent';
  include: { colorbar: boolean; orientationLabels: boolean; crosshair: boolean;
             cornerInfo: boolean; scaleBar: boolean; orientationCube: boolean };
  autoTrim: boolean;
}
export interface LoadProgress { datasetId: DatasetId; phase: LoadPhase; done: number; total: number }

export interface EngineEvents {
  cursor: vec3;
  hover: vec3 | null;
  pick: PickResult | null;
  probe: { world: vec3; result: ProbeResult };   // an ASYNC row landed for a point that is still current
  layers: Layer[];
  datasets: Dataset[];
  measurements: Measurement[];
  pointTool: PointToolEvent;                     // §13's point tool did something (2026-08-30)
  progress: LoadProgress;
  frame: { viewId: ViewId; cpuMs: number; gpuMs?: number; quality: QualityLevel['name'] };
  quality: QualityLevel;
  error: { code: string; message: string; datasetId?: DatasetId };
}

export interface EngineOptions {
  dpr?: number; deterministic?: boolean;        // deterministic: fixed clock, no timer query, sync render (§11)
  forceDiscardClip?: boolean;                   // §7.4 fallback-path test axis
  forceCaps?: Partial<Pick<Capabilities, 'norm16' | 'floatLinear' | 'clipDistance' | 'timerQuery'>>;
                                                // §7.1 test axis; may only REMOVE a capability, never add one
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
  stepCursor(viewId: ViewId, steps: number): void;            // ±1 voxel along the view normal (§7.5)
  nudgeCursor(viewId: ViewId, dx: number, dy: number): void;  // ±1 step IN THE PLANE (§7.5 arrows)
  setLayout(layout: Layout): void;
  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void;
  setRadiological(on: boolean): void;

  pick(viewId: ViewId, px: number, py: number): PickResult | null;
  setCursorFromPick(viewId: ViewId, px: number, py: number): boolean;
  contourAtScreen(viewId: ViewId, px: number, py: number): LayerId | null;   // §7.4
  probe(world: vec3): ProbeResult;

  coordinateSpaces(): CoordSpaceOption[];                     // §3, §8's selector
  toSpace(ref: CoordSpaceRef, world: vec3): vec3 | null;      // null, never a fallback, when unresolvable
  fromSpace(ref: CoordSpaceRef, value: vec3): vec3 | null;
  setTemplateSpace(datasetId: DatasetId, space: TemplateSpace | null): void;
  attachFsaverage(spec: FsaverageSpec | { surfaceId: DatasetId; clear: true }): Promise<boolean>;

  setMeasureMode(on: boolean): void;            // while on, a left-click PLACES A POINT in any pane
  measureMode(): boolean;
  addMeasurement(spec: NewMeasurement): Measurement;   // the engine assigns the id and the `M<n>` name
  removeMeasurement(id: MeasurementId): void;
  cancelMeasurement(): void;                    // Esc — drops the gesture, keeps what is placed

  setPointTool(spec: PointToolSpec | null): void;   // §13; arming disarms measure mode and vice versa,
                                                //   materialises `p<index>` ids, and null clears + emits 'cleared'
  pointTool(): PointToolSpec | null;
  pointAtScreen(viewId: ViewId, px: number, py: number): PointSelection | null;   // CSS px, like pick()
  setPointSelection(sel: { layerId: LayerId; pointId: string } | null): void;     // by ID, never by index
  pointSelection(): PointSelection | null;      // re-resolved against the current points[]

  labelCentroids(layerId: LayerId): Promise<LabelCentroid[]>;      // §6.5.2's op
  resetView(viewId: ViewId): void;              // §7.5 `r`: refit to the scene bounds
  cameraPreset(viewId: ViewId, preset: CameraPreset): void;
  setAnnotations(patch: Partial<Annotations>): void;
  setTheme(patch: Partial<OverlayTheme>): void; // the colours §7.2 pass 3 draws its chrome in. NOT part of
                                                //   Scene: a theme belongs to the window, so §4.6 never
                                                //   serialises one. Defaults are DEFAULT_OVERLAY_THEME.
  heapBytes(id: DatasetId): number | undefined; // from that dataset's last Res (§6.5.2)
  iso3dStatus(layerId: LayerId): { pending: number; total: number };   // {0,0} when the layer owns none

  requestRender(viewId?: ViewId): void;
  renderNow(): void;                            // draw synchronously — §11 readback, screenshot path
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

**The `probe` event closes the hole in "a mesh probe is at most one round trip stale".** `probe()` is
synchronous while `locate` and `nearestVertex` are worker calls, so the row the `cursor` event's probe
returns is the one from *before* the click. A runtime calls `probeLanded(world)` when an async row lands and
the engine re-emits it as `probe` if that point is still the cursor or the hover. It is its own event and not
a second `cursor` because the app's `cursor` handler also clears the coordinate bar's draft, and a probe
landing must not delete what a user is typing.

**The point tool's five members are the same shape as measure mode's, and for the same reason.** Only the
engine can turn a pane pixel into a world point, and §8 forbids the app deriving one — so the *mode* is engine
state, the app (or a §13 extension) owns the button that arms it, and `input/pointer.ts` is where a click becomes
a placement or a grab (§7.5 has the grammar). Three things are decided here rather than in a host:
**selection is by `points[].id`**, so it survives the `points` replacement every edit is — the engine re-finds
it after each `updateLayer` and emits `cleared` when the id has gone, rather than leaving a ring on whatever
took that index; **arming materialises ids**, giving a layer whose points carry none a `p<index>` each, so the
tool, the selection and the saved scene name the same contact by the same string; and **a ghost is never
hit**, because a ghost is the projection of a point on another slice and dragging one would move a contact in
a plane it is not in. `pointAtScreen` is the hit rule on its own, for a host that wants to ask without
selecting. The rings the tool shows are `DrawInput.pointSelection`/`pointHot` (§7.2), which are *not* on this
facade: a ring is not something the UI does.

`attachFsaverage` composes three §6.5 ops — `vertices` on the fsaverage sphere, `sphereMap` on the subject's,
`vertices` on the fsaverage surface — and caches all three, so a second surface of the same hemisphere costs
nothing. It resolves `false` rather than throwing on every miss, including a node-count mismatch: nothing
about fsaverage is bundled, so "there is none here" is the ordinary answer. `setTemplateSpace` exists because
the engine **cannot** find a registration itself — §5 keeps the filesystem in Electron's main process, and a
`toMNI/` folder is *beside* the volume — so the host discovers it, loads the warps through the ordinary
`addDataset`, and hands the result back.

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
└───────────────────────────┬────────────────────────────┘
                            │ contextBridge (preload)
┌───────────────────────────▼────────────────────────────┐
│ Renderer (UI thread)                                   │        postMessage (transferables)
│  React chrome · @tetravox/engine (WebGL2)              │◄──────────────────────────────────────┐
│  holds: GPU textures/VBOs, VolumeDataset.data (probes) │                                       │
│  holds: NO mesh bulk arrays, NO raw file bytes         │                                       │
└────────────────────────────────────────────────────────┘                                       │
        ▲ spawns one worker per dataset                                                          │
┌───────┴─────────────────────────────────────────────────────────────────────────────────────┴──┐
│ dataset worker  (module Worker under the tetravox:// origin, one wasm instance)                 │
│   fetch('tetravox://file/…')  →  DecompressionStream('gzip') when .gz  →  Uint8Array  →  WASM   │
│   owns exactly one parsed dataset by handle. Closing the dataset = worker.terminate().          │
│   ops: §6.5.  progress + cancel are part of the protocol.                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rules:

1. **Worker-per-dataset.** Each volume or mesh gets its own Web Worker and its own WASM instance.
   `removeDataset(id)` ⇒ `worker.terminate()`. That is the only way to give wasm linear memory back:
   `WebAssembly.Memory` has `grow` and no shrink, and Rust's wasm dlmalloc keeps freed pages, so a worker's
   high-water mark is permanent for its lifetime.
2. **No utility worker.** The only cross-dataset op is `isolate` with a `labelVolume` criterion, evaluated in
   the *mesh* worker from a copy of the label volume the UI thread already holds for probes (27 MB) — cheaper
   than shipping 4.7 M tet centroids (56 MB) the other way. A second cross-dataset op gets the utility
   worker, and that is an ARCHITECTURE.md edit.
   **That copy is structured-cloned, never transferred.** `VolumeDataset.data` is retained on the UI thread
   for probes; putting it in a transfer list detaches it and every subsequent probe throws or reads garbage.
   **General rule: `Req.args` buffers are never added to a transfer list unless the §6.5.2 op table marks the
   argument as donated.** No op currently does.
3. **Bytes never cross IPC and never touch the UI thread.** Electron IPC *copies* ArrayBuffers; only
   `MessagePort` transfers across processes. IPC carries dialogs, menus, paths and CLI args. The worker
   fetches `tetravox://file/…` itself.
4. **Gzip in the worker.** `.gz` is inflated with a streaming `DecompressionStream('gzip')` piped from the
   fetch body. The Rust readers *also* sniff `1f 8b` and inflate with `flate2`, so the crates stay usable
   natively and in plain-browser mode.
5. **Input bytes are copied into WASM once** and the input buffer is dropped before the parser returns; the
   inflate output is dropped too.
6. **Latest-wins and cancellation.** Latest-wins is keyed on the caller-supplied opaque `key`
   (`"${layerId}:cut"`) and drops *queued* requests. An in-flight WASM call **runs to completion** — WASM is
   not preemptible, and without `SharedArrayBuffer` (§1) there is no buffer a second thread can write that the
   running call could poll; while a synchronous wasm call runs, the worker's event loop cannot process a
   `Cancel` anyway.
   **Therefore: the only cancellation mechanism is `worker.terminate()`.** `Engine.cancelDataset(id)`
   terminates that dataset's worker and the compute client synthesises
   `{ ok: false, error: { code: 'cancelled' } }`. A load has nothing worth keeping, so this is free. The other
   long ops — `buildTopology`, `marchingCubes`, `marchingTets` — are **not** cancellable: terminating would
   throw away a parsed 492 MB mesh to save under two seconds. `ProgressSink::aborted()` survives in
   `tvx-core` for the native/CLI build; the wasm implementation always returns `false`, and no §6.4 export
   takes an abort argument.
7. **Results are owned buffers, never views** (§6.4).
8. A wasm `panic!` or `Error::OutOfMemory` poisons the module: the client tears down the worker, marks the
   dataset failed, and emits `error`. It never retries into the same instance.
9. **`tetravox://file/` reads only user-named paths.** A privileged scheme with `supportFetchAPI` is reachable
   from every module Worker under the origin, so an unrestricted `tetravox://file/<path>` is an
   arbitrary-file-read primitive. Main keeps an allow-list of resolved, symlink-flattened absolute paths and
   admits one only from a user gesture — the Open dialog, a drop, macOS `open-file`, CLI argv — then answers
   anything else with 403. Preload exposes `allowPath(path)`, never a read. Requests are checked against the
   *resolved* form of what they asked for, so neither `..` nor a symlink walks out of the set.
   The worker also fetches sidecars, which are derived sibling paths and not user-named, so `allowPath` on a
   dataset must admit that dataset's sidecars at the same time. The document's CSP carries
   `connect-src 'self' tetravox:` because `tetravox://file` is a *different host* from `tetravox://app`.
10. **Writing is a second, narrower allow-list, and only main puts anything on it.** Scene writes go
    to `scene-io.ts`'s `writable` set, which the Save sheet fills. The single carve-out from "being able to
    read `T1.nii.gz` must never imply being able to overwrite it" is the app's own scene format: **main
    handing the renderer a `*.tetravox.json` to open** admits that path for writing
    (`scene-io.ts#allowOpenedScene`), because opening a scene *is* naming the file ⌘S will save over. It is
    one compound extension, matched on the whole suffix (`isScenePath`), so §7.6's `_LUT.json` is not a scene
    and gains nothing. Nothing else widens that list.

    **It is minted at the five delivery points, never by a read.** `showOpenSceneDialog`'s result;
    `menu.ts#sendOpenScene`, which is the scene half of the `tetravox:opened` routing (argv, `open-file`, a
    second instance, File ▸ Open Recent, Sample Data); the `tetravox:startup-scene` drain; and
    `tetravox:dropped-path`, which **preload** sends from `getDroppedFilePath` — `webUtils.getPathForFile`
    answers only for a `File` the user really dragged, so that path is a gesture main can trust and renderer
    script cannot manufacture one. `readSceneFile` admits **nothing** (2026-08-30): `tetravox:allow-path`
    takes any existing absolute path with no gesture, so a write derived from a read was a write the renderer
    could mint for any scene file on the disk — read it, then overwrite it, with no dialog anywhere.
11. **Extension file IO is four channels, and a module-scoped write list** (`main/module-io.ts`, registered from
    main like `registerJobIpc()`; §13). Small text only, paths in both directions, and each one narrower than
    a door that is already open:

    | Channel | What it does |
    |---|---|
    | `tetravox:module-read-text` | UTF-8 text of a path **already on the read allow-list**, ≤ 1 MiB, extensions `.tsv .csv .json .txt .fcsv`. It admits nothing and has no write twin — a policy restatement of what `readSceneFile` (8 MiB, any allow-listed path, no content check) and `tetravox:subject-spaces` already return. |
    | `tetravox:module-open-dialog` | An Open sheet with the reader's title and filters; the result is allow-listed exactly like File ▸ Open's. |
    | `tetravox:module-save-dialog` | A Save sheet whose result admits the chosen path **and** the writer's declared same-directory siblings for writing. |
    | `tetravox:module-write-text` | UTF-8 text, ≤ 8 MiB, to a path on **that extension's** list, `.part` + rename, with an optional main-side `.bak` copy first. |

    The write list is `Map<moduleId, …>`, separate from `scene-io.ts`'s `writable`: an extension cannot write over
    a scene, the scene channel cannot write an extension's files, and one extension's Save sheet admits nothing for
    another. A **sibling template** (`{name}.{stamp}.bak`, `{stem}_editlog.json`) must match
    `^[A-Za-z0-9_.{}-]{1,96}$` before substitution, and after substituting `{name}` (the basename), `{stem}`
    (it without its extension chain) and `{stamp}` (`YYYYMMDD-HHMMSS`) must still be a plain name — no
    separator, no `..`, no brace left over — so a sibling is always in the chosen file's own directory. A
    stamped template is admitted as a *shape*, because the backup a later save mints carries its own moment.
    The `.bak` is copied **in main**, from the file about to be replaced, so backup bytes never cross IPC; the
    write goes to `<path>.part` and is renamed, the `sample-data.ts` precedent, so an interrupted save leaves
    the previous table rather than half the new one; and the written path is allow-listed for reading, as
    `writeSceneFile` does. A writer that declared no `{name}.{stamp}.bak` gets no backup and still saves.

    **Sibling discovery stays in the renderer.** `modules/hostFiles.ts` instantiates the manifest's patterns
    for an anchor path and probes each candidate with `bridge().allowPath` — the `open/sources.ts#firstAllowed`
    precedent, where `allowPath` returning null *is* the existence check. A main-side resolver would add no
    admission-policy gain over that status quo, and no listing or glob IPC exists or is wanted.

    **An admission belongs to the editing session that earned it, not to the process** (2026-08-30). A fifth
    channel, `tetravox:module-clear-writes`, drops one extension's whole list; the renderer sends it from
    `deactivateModule`, which is also where the extension's own `savePath` dies, so the next save shows a sheet
    anyway. Main drops **every** extension's list where it replaces the document itself — `sendOpenScene` and
    `sendSceneCommand('new'|'open')`. Without this, saving subject A's `electrodes.tsv` left A's table and
    the `<anchor>.<stamp>.bak` *shape* beside it writable for the rest of the session, including after the
    user moved to subject B. It is inert for a `--job` run, whose `out` admissions come from the envelope
    before there is a window and whose actions activate extensions in whatever order they are listed. This
    scopes **accidents**: a compromised renderer simply never sends it, and the durable answer is a narrower
    `allowPath` (`docs/ROADMAP.md`).
12. **Unsaved extension edits interrupt a window close.** The renderer pushes `tetravox:set-document-edited`
    (from an extension's `ui.setDirty`, never from `sceneDirty`, which any cursor click sets); main calls
    `win.setDocumentEdited` with it and keeps the flag per window. A `BrowserWindow 'close'` on a window
    holding that flag is `preventDefault`ed and answered with a two-button `dialog.showMessageBox`
    **{Discard, Cancel}** — and no Save: saving is the extension's own Save sheet and `module-write-text`, and a
    Save button here would be a second write path driven from main. Discard clears the flag and destroys the
    window; Cancel leaves it open. The handler is **not installed on a `--job` window** — a batch render has
    nobody to answer a box and would hang to the watchdog — and it is inert under `TETRAVOX_E2E_DISCARD=1`,
    which is how a windowless e2e tears down a window it deliberately made dirty (AGENTS rule 8). That seam
    is honoured **only when `app.isPackaged` is false** (2026-08-30): it is ambient environment, and a
    dotfile or a launcher exporting it must not be able to switch off a shipped build's only guard on
    unsaved edits. `installCloseGuard` takes `packaged` from main, so `shouldPromptOnClose` stays pure.
13. **Installing an extension is nine channels and a third `tetravox://` host** (`main/module-store.ts`,
    `main/protocol.ts`; §13.8, 2026-08-30). `tetravox:module-{catalog,statuses,manifests,install,cancel,
    enable,disable,remove,reveal-dir}` plus a `tetravox:module-progress` push, mirroring §8's Sample Data
    block one door further in. **No path crosses this bridge in either direction.** The renderer sends an id
    and a version and receives card states, progress numbers and manifests — which are data, no DOM type and
    nothing to execute. An extension's *code* is reachable only as `tetravox://module/<id>/<version>/<file>`, off
    a `Map<string, string>` that only `enableModule()` fills, and only after re-hashing every file against
    the install receipt. So the renderer cannot name an extension file, cannot read one, and cannot make one
    reachable; the one thing it can do is ask, and the sheet the user answers is what the ask is for.
    `script-src` therefore gains the **host source** `tetravox://module` and nothing else — the scheme form
    `tetravox:` would also admit `tetravox://file/…`, which is every path the user has ever opened.
    `enableModule`/`disableModule`/`removeModule` are also where rule 11's write list is revoked, in main,
    rather than over the renderer-cooperative channel.

14. **Updating the app is five invoke channels, one status push, and a menu push** (`main/updater.ts`,
    §12.4, 2026-08-31). `tetravox:update-{state,check,download,install,skip}` in; `tetravox:update-status`
    (one small `UpdateStatus` object — phase, two version strings, progress numbers, plain-text notes) and
    `tetravox:open-updates` (the File ▸ Check for Updates… click, carrying nothing) out. The feed, the
    download and the installer live entirely in main; the renderer can *ask* but the only bytes that move
    are main's own. What the ask can reach is phase-gated in main — no download before a check announced,
    no install before a download landed, and unsaved extension edits raise rule 12's Discard/Cancel *before*
    `quitAndInstall` (on Windows and the AppImage the installer runs before `app.quit()`, so the ordinary
    close guard would ask too late). The channels do not prove a human click — a hostile renderer could
    invoke them — but the worst it can reach is a restart into the sha512-verified artefact of a release
    the pinned `idossha/tetravox` feed published, which is the app the user would have gotten anyway. The
    boot status is **pulled** (`updateStatus`), like `startupPaths` and for the same race.

---

## 6. Rust crates — public API contract

Crate dependency direction (no cycles): `tvx-core` ← `tvx-nifti` ← `tvx-geom`; `tvx-core` ← `tvx-mesh-io` ←
`tvx-geom`; `tvx-wasm` depends on all four.

### 6.0 `tvx-core` — shared types

```rust
pub struct Plane { pub normal: [f32; 3], pub offset: f32 }          // keep side: normal·x + offset >= 0

pub struct BitMask { bits: Vec<u8>, len: usize }   // u8, not u64: `as_bytes` cannot borrow a
                                                   // Vec<u64> as &[u8] without `unsafe` (forbidden)
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

/// §4.6's `tvxfp1-…`. Lives here, not in a loader, so every loader produces the same string by
/// construction. `fingerprint::{TAG, FULL_LIMIT, CHUNK, sample_ranges}` expose its constants for tests.
pub fn fingerprint(bytes: &[u8]) -> String;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("parse: {0}")]        Parse(String),
    #[error("unsupported: {0}")]  Unsupported(String),
    #[error("io: {0}")]           Io(String),
    #[error("out of memory: {0}")] OutOfMemory(String),
    #[error("cancelled")]         Cancelled,
}
pub type Result<T> = std::result::Result<T, Error>;

/// `tvx-wasm` implements this over a `js_sys::Function`, with `aborted()` returning `false`
/// unconditionally — there is no SharedArrayBuffer to poll (§1, §5 rule 6).
pub trait ProgressSink {
    fn report(&mut self, phase: Phase, done: u64, total: u64);
    fn aborted(&self) -> bool;
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase { Read, Inflate, Parse, Topology, Index, Upload }
pub struct NoProgress;
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
    pub xyz_units: Units, pub is_label: bool,
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
pub fn read_mgh(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume>;        // .mgh / .mgz
pub fn read_nrrd(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume>;       // .nrrd (attached)
pub fn read_metaimage(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume>;  // .mha (attached)

pub enum VolumeFormat { Nifti, Mgh, Nrrd, MetaImage }
/// Content first (NIfTI `sizeof_hdr`, MGH big-endian `version = 1`, `NRRD000x`, a MetaImage `Key = Value`
/// line), `hint_ext` only for bytes the content cannot place. A gzip member is peeked, not inflated.
pub fn sniff_volume(bytes: &[u8], hint_ext: Option<&str>) -> Result<VolumeFormat>;
/// `None` = sniff. Every format yields the same `Volume`; a gzip member is inflated exactly once.
pub fn read_volume(bytes: Vec<u8>, format: Option<VolumeFormat>, p: &mut dyn ProgressSink) -> Result<Volume>;

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
  RGB24, RGBA32. `Error::Unsupported` **by name** for complex64/128, int64, uint64. Two-file `ni1` ⇒
  `Error::Unsupported("two-file NIfTI")`.
* **One `Volume` from every reader.** `read_mgh`, `read_nrrd` and `read_metaimage` share `read_nifti`'s
  datatype decode, slope/inter rule, `is_label` test and stats (`common::finish`); each carries
  `scl_slope/inter = (1, 0)`, `cal_min/max = 0`, `intent_code = 0`, a short `descrip` (`"MGH"`, the NRRD
  `content:`, `"MetaImage"`), `xyz_units = Millimeter` (NRRD: `space units` when given), and **every parsed
  header field in `header_json`** with an `affineSource` string saying what the affine was built from.
  * **MGH/MGZ** — big-endian throughout; `version` must be 1; the fixed header is padded to **284 bytes** and
    the samples start there; `nvols = nframes`; types `UCHAR 0`, `INT 1`, `FLOAT 3`, `SHORT 4`, `USHRT 10`
    (`LONG`, `BITMAP`, `TENSOR` are `Unsupported` by name). The affine is nibabel's `MGHHeader.get_affine`:
    `M = [x_ras y_ras z_ras]·diag(delta)`, `t = Pxyz_c − M·(dims/2)` (float division), and when
    `goodRASFlag == 0` nibabel's default geometry (`delta = 1`, LIA cosines `[[-1,0,0],[0,0,1],[0,-1,0]]`,
    `Pxyz_c = 0`). The optional footer (`TR`, `flip_angle`, `TE`, `TI`, `FoV`) is parsed into `header_json`.
  * **NRRD** — **attached header only**: a `data file:` field (`.nhdr`) is `Unsupported` naming the sibling
    file. `dimension` 3 or 4; every spelling of the eight scalar types; encodings `raw`, `gzip`/`gz`,
    `ascii`/`txt`/`text` (`bzip2`, `hex` `Unsupported` by name); `endian`, `byte skip`, `line skip`.
    Spatial axes are the `kinds` `domain`/`space` axes (else the non-`none` `space directions`, else the first
    three); a non-spatial **last** axis is `nvols`; a non-spatial **first** axis is read only as
    `3-color`/`4-color` over `uint8` → RGB24/RGBA32, anything else channel-first is `Unsupported`. Affine =
    `space directions` columns + `space origin`, `spacing = |column|`, converted to RAS by negating the rows
    whose `space` letter is L, P or I (`left-posterior-superior` → flip x, y); **no `space` reads as LPS**, as
    ITK does; a non-anatomical space is taken as-is. `measurement frame`, `centerings` and comments are ignored.
  * **MetaImage** — **`.mha` only**: `ElementDataFile` other than `LOCAL` (`.mhd`) is `Unsupported` naming
    the sibling file. `NDims` 3 or 4 (4th = `nvols`), `MET_UCHAR/CHAR/USHORT/SHORT/UINT/INT/FLOAT/DOUBLE`,
    `ElementNumberOfChannels` 1, or 3/4 over `MET_UCHAR` → RGB24/RGBA32; `BinaryData`,
    `BinaryDataByteOrderMSB`, `CompressedData` (one **zlib** stream of `CompressedDataSize` bytes),
    `HeaderSize` (`-1` = the last N bytes). `TransformMatrix` holds the per-axis direction vectors
    consecutively (the direction matrix column-major, as ITK writes it); the affine is
    `[TransformMatrix·diag(ElementSpacing) | Offset]` with the **x and y rows negated** (LPS → RAS), i.e.
    exactly `sitk` direction/origin/spacing converted the way a SimpleITK→nibabel bridge does.
* **Scaling is never folded.** Apply slope/inter only when
  `slope.is_finite() && slope != 0.0 && inter.is_finite() && (slope != 1.0 || inter != 0.0)`; otherwise
  normalise to `(1.0, 0.0)`. The affine is carried in `GpuPayload{scale, offset}` and applied as
  `v = raw*scale + offset` in the fragment shader and in the probe path. Widening to f32 happens only for
  float64 input and RGB24 → RGBA8. The NaN guard stays — NaN slopes occur in the wild — but no reference file
  exercises it, so the fixture must. (Reading `nib.load(p).header` reports NaN for files whose on-disk value
  is 1.0: `Nifti1Image.from_file_map` calls `set_slope_inter(None, None)` after handing scaling to the array
  proxy. Read the raw 348-byte header.)
* **`is_label`** = all sample values integral ∧ min ≥ 0 ∧ (`intent_code == 1002` ∨ (unique count ≤ 4096 ∧
  (unique count ≤ 255 ∨ piecewise constant))). *Piecewise constant*: at least 50 % of adjacent same-row
  sample pairs, excluding background–background pairs, are equal — an atlas repeats its value voxel to
  voxel, a non-negative integer MRI with hundreds of grey levels does not.
  **The dtype must not be part of the test**: `segmentation/labeling.nii.gz` is float32 with 57 integral
  unique values spanning 0…530 and is a genuine atlas.
* **Stats** are exact: one O(n) pass into a 65536-bin histogram over `[min, max]` gives the percentiles
  (exact for integer dtypes, ≤ 1/65536 relative error for float); the 256-bin display histogram is derived
  from it. No sampling — sampling is not deterministic.
* **`gpu_payload` selection ladder, first match wins:**

  | # | Input | Format | Filter | Note |
  |---|---|---|---|---|
  | 1 | `is_label`, `max_dense_index ≤ 255` | `R8UI` | NEAREST | dense index remap, not raw id |
  | 2 | `is_label`, `≤ 65535` | `R16UI` | NEAREST | `> 65535` ⇒ `Error::Unsupported` |
  | 3 | u8 / i8 | `R8` | LINEAR | normalised, scale/offset to physical |
  | 4 | u16 / i16, `caps.norm16` | `R16` | LINEAR | `scale=(max−min)/65535`, `offset=min`; exact for any 16-bit input |
  | 5 | u16 / i16, `caps.float_linear` | `R32F` | LINEAR | |
  | 6 | u16 / i16, neither | `R8` | LINEAR | "reduced precision" in the status bar. **Never `R16UI`** for a non-label layer — that is the silent black-slice case |
  | 7 | u32 / i32, `caps.norm16` | `R16` | LINEAR | display only; probes read the CPU array |
  | 8 | f32 / f64, finite range, `caps.norm16` | `R16` | LINEAR | normalised over exact `[min,max]`, no clamping |
  | 9 | f32 / f64 with NaN/Inf, or `precision:'f32'`, `caps.float_linear` | `R32F` | LINEAR | |
  | 10 | RGB24 / RGBA32 | `RGBA8` | LINEAR | |

  `R16F` stays in the enum only as a fallback for float data whose range **and** precision have both been
  checked. It is **not** the default, and the reason is precision: half-float has an 11-bit mantissa, so even
  normalised into [0,1] it delivers ~2048 distinct levels in the top binade against R16's 65536 uniform ones.
  `want_linear` is false when the layer is a label or `interpolation === 'nearest'`.
* Volumes whose `max(dims) > caps.max_3d` fail loudly at load with a downsample offer — never a silently
  incomplete texture at draw time.
* Every reader (`read_nifti`, `read_mgh`, `read_nrrd`, `read_metaimage`, `read_volume`) **takes ownership of
  the byte vector and frees it before returning**, so §4.6's `fingerprint` is taken by the caller over
  `&bytes` on the line above the call. Each reports `Read` → `Inflate` → `Parse` → `Index` like `read_nifti`.

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
    pub gmsh_elm_numbers: Option<Vec<u64>>,    // per element, in (tris then tets) order.
                                               //   `None` == the identity numbering; see the rule below.
    pub tet_perm: Vec<u32>,                    // Morton order -> original file row (§6.3)
    pub skipped: Vec<(u32, u64)>,              // (gmsh element type, count) for types we drop
    pub bounds: Aabb,
    pub label_table: Option<LabelTable>,       // a `.label.gii`'s <LabelTable>; None elsewhere
}

pub struct MshOptions {
    pub tag_color: Vec<(i32, [u8; 4])>,
    pub tag_visible: Vec<(i32, bool)>,
    pub views: Vec<MshView>,
    pub tag_name: Vec<(i32, String)>,          // `Physical Volume(" GM",2)`, verbatim, in file order
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
pub fn read_vtk(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Mesh>;      // legacy `.vtk`
pub fn read_vtk_xml(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Mesh>;  // `.vtu` / `.vtp`
pub fn read_off(bytes: Vec<u8>) -> Result<Mesh>;
pub fn read_medit(bytes: Vec<u8>) -> Result<Mesh>;                              // MEDIT `.mesh`
pub fn read_geo_view(bytes: Vec<u8>) -> Result<Vec<GeoView>>;   // Gmsh parsed views: `.geo` / `.pos`
pub fn sniff(bytes: &[u8], hint_ext: Option<&str>) -> Result<Format>;
pub enum Format { Msh, Gifti, FsSurface, Stl, Ply, Obj, Geo, Vtk, VtkXml, Off, Medit }

/// One `View "name" { … };` block. De-indexed: a parsed view has no node table.
pub struct GeoView {
    pub name: String,
    pub points: Vec<[f32; 3]>,   pub point_values: Vec<f32>,       // 1 per point
    pub labels: Vec<([f32; 3], String)>,                            // T2/T3 anchors + strings
    pub lines: Vec<[[f32; 3]; 2]>, pub line_values: Vec<f32>,       // 2 per segment
    pub tris: Vec<[[f32; 3]; 3]>,  pub tri_values: Vec<f32>,        // 3 per triangle
    pub skipped: Vec<(String, u64)>,
    pub time_steps: usize,
    pub bounds: Aabb,
}

// Exact FieldStats over field values (§6.0's "no sampling" rule). Named here because tvx-geom's
// elm_to_node / node_to_elm build a Field / ElmField and every such struct carries `stats`.
pub fn field_stats(values: &[f32], ncomp: usize) -> FieldStats;
pub fn field_stats_parts(parts: &[&[f32]], ncomp: usize) -> FieldStats;
```

**Gmsh v2 binary layout (the SimNIBS default, header `2.2 1 8`) — normative:**

* `$Nodes` records are `i32 id + 3×f64`. `$Elements` blocks are `[elm_type: i32, count: i32, n_tags: i32]`
  followed by `count` records of `i32 id + n_tags×i32 + nodes_per_type×i32`. The skip for an unsupported type
  is `count × (1 + n_tags + nodes_per_type) × 4` bytes. (SimNIBS's own reader hard-codes 2 tags into a 3 — do
  not copy it.)
* `$NodeData`/`$ElementData` records are `i32 id + ncomp×f64`. Header tag counts are variable: read
  `n_string_tags` / `n_real_tags` / `n_integer_tags` and skip the extras. `ncomp = integer_tags[1]`,
  `nr = integer_tags[2]`; `integer_tags[0]` is the time-step index and `> 1` step ⇒ `Error::Unsupported`.
* Values are read as f64 and narrowed to f32 **streaming, per block** — never "read all f64 then map".
* Ids are 1-based and may be non-contiguous. **Scatter by id** through an `elm_number → index` map (fast path
  when ids are exactly `1..N`, the SimNIBS case); positional order is not guaranteed by the format and is
  wrong for cropped meshes. Gaps ⇒ `f32::NAN` and `partial = true`.
* **Gmsh element numbers — normative, because `owner_elm` / `owner_tet` / `PickResult.elementId` all key on
  them.** `gmsh_elm_numbers` is `Some` only when the file's numbering is *not* the identity. It is `None` —
  the fast path — when the file numbers elements exactly `1..N` in (tris then tets) order, and then
  ```
  gmsh number of tri i = i + 1
  gmsh number of tet j = n_tris + tet_perm[j] + 1        // j is the Morton index (§6.3)
  ```
  which is why the Morton permutation must be kept, and why `None` costs nothing instead of 47.2 MB on ernie.
  This is the case for **every** reference `.msh`. The same synthesised `1..N` applies to formats with no
  element numbering at all (STL/PLY/OBJ/GIfTI/FreeSurfer), again with `None`.
  `owner_elm` is `u32`; a file whose largest element number exceeds `u32::MAX` is
  `Error::Unsupported("element numbers exceed u32")`, checked at parse time, never truncated.
* Only element types 2 (tri3) and 4 (tet4) are kept; everything else is counted into `skipped`, not an error.
* `read_msh` **takes ownership of the byte vector and frees it (and any inflate output) before returning.**
  §4.6's `fingerprint` is taken by the caller before the call, over the mesh bytes alone.
* Tag names and colours, in order: `$PhysicalNames` → sibling `<mesh>_LUT.txt` → sibling `<mesh>.msh.opt`
  (`Physical Volume(" GM",2)` + `Mesh.Color.<Ordinal>`) → deterministic glasbey-like palette. Rule:
  **surface tag `1xxx` inherits the colour of volume tag `1xxx − 1000`**.
* Gmsh 4.1 ascii+binary is supported; SimNIBS refuses v4, so its fixtures must be generated with Gmsh itself.

**Gmsh parsed post-processing views (`.geo` / `.pos`) — normative.** This is *not* the Gmsh scripting
language. A parsed view is a literal dump of primitives, which is how SimNIBS writes
`m2m_*/eeg_positions/*.geo` (`View""{ SP(x,y,z){v}; T3(x,y,z,style){"E001"}; … };` — an empty, unspaced view
name).

* **Coordinates are component-major, not interleaved.** A primitive with `n` vertices lists
  `x1..xn, y1..yn, z1..zn`, and only then, inside the braces, one value per vertex per time step. This is
  silent for `n = 1`, so an `SP`-only fixture cannot catch it; `testdata/view_electrodes.geo` carries an `ST`
  whose three corners are distinguishable.
* Primitives read: `SP`/`VP` (points), `SL`/`VL` (segments), `ST`/`VT` (triangles), `SQ`/`VQ` (quads, fanned
  `(0,1,2)+(0,2,3)`), `T2`/`T3` (text, style int read and discarded). Everything else is **counted into
  `skipped`, not an error**.
* **Vector primitives reduce to their magnitude** — the display path is a scalar colormap.
* **Only time step 0 is read**, and `time_steps` reports how many the file had.
* Gmsh **option statements** trailing a view (`View[myView].PointSize=6;`) are display hints, not data, and
  are skipped to their `;`.
* A `.geo` carrying **geometry commands** (`Point(`, `Line(`, …) is `Error::Unsupported` **naming the
  command**. It is CAD input, not data; an empty view would look like a corrupt file. `sniff` recognises a
  parsed view by its leading `View` token, but the loader routes `.geo`/`.pos` by extension anyway, so that
  this message is the one the user sees.

**GIfTI:** XML via `quick-xml`. `Encoding` ∈ {`ASCII`, `Base64Binary`, `GZipBase64Binary`};
`ExternalFileBinary` ⇒ `Error::Unsupported`. **`GZipBase64Binary` is a zlib stream, not gzip — use
`ZlibDecoder`, not `GzDecoder`.** Honour `Endian` and `ArrayIndexingOrder`; apply
`CoordinateSystemTransformMatrix` when `TransformedSpace == NIFTI_XFORM_SCANNER_ANAT`, and record
`DataSpace`/`TransformedSpace` in the dataset. `.func/.shape/.label.gii` become node `Field`s keyed by
`Intent`; `<LabelTable>` becomes a `LabelTable`, and a `NIFTI_INTENT_LABEL` array is **remapped to dense
0..N−1 through that table at parse time** — the renderer's label palette is an `N × 2` texture indexed by
position in `LabelTable.entries`, and a `<LabelTable>` key is an arbitrary sparse integer. The original key
stays in `LabelEntry.id`; a value the table does not name maps to dense 0. A `.func`/`.shape` array is a
continuous scalar and is never remapped.

**FreeSurfer:** triangle-file magic is `0xFFFFFE` **big-endian**, coordinates big-endian f32; the quad file
is also read. `read_fs_curv` reads the new format (magic `0xFFFFFF`). `read_fs_annot` remaps packed-RGB
annotation values to **dense 0..N−1** through the embedded colortable at parse time and returns that
colortable, with the original id preserved in `LabelEntry.id`. Unassigned vertices (`-1`) map to dense index
0 with a transparent entry.

Loaders that triangulate n-gons (`read_fs_surface` quad file, `read_ply`, `read_obj`, `read_vtk`,
`read_vtk_xml`, `read_off`) must emit a matching `tri_edge_mask`, and only when an n-gon really occurred.
`read_msh`, `read_stl` and `read_medit` emit `None`, which the engine maps to the constant-attribute fast
path.

**General-purpose mesh formats (VTK legacy, VTK XML, OFF, MEDIT) — normative.** All four produce nodes in
f32 mm, 0-based ids validated against the node count at parse time, `label_table: None`, no
`physical_names`, identity `tet_perm`, `gmsh_*_numbers: None` (the synthesised `1..N` rule above).

* **VTK legacy `.vtk`** (`# vtk DataFile Version x.y`): `DATASET POLYDATA` (`POINTS` + `POLYGONS`; `VERTICES`
  / `LINES` / `TRIANGLE_STRIPS` are counted into `skipped` as VTK types 2 / 4 / 6 and keep their cell-data
  rows) and `DATASET UNSTRUCTURED_GRID` (`POINTS` + `CELLS` + `CELL_TYPES`, both the classic
  `count, i…` stream and the VTK 9 `OFFSETS` / `CONNECTIVITY` sub-arrays). Any other `DATASET` is
  `Error::Unsupported`. **BINARY payloads are big-endian regardless of host.** Cell types kept: 5 triangle,
  7 polygon, 9 quad, 8 pixel (reordered `0,1,3,2`) → `tris`, fanned with a mask when not a triangle;
  10 tetra → `tets`. Every other type is counted into `skipped` under its **VTK** cell-type code (the `.msh`
  and MEDIT readers use Gmsh codes there). `POINT_DATA` / `CELL_DATA` attributes `SCALARS name type [ncomp]`
  (+ `LOOKUP_TABLE default`), `VECTORS`, `NORMALS` (kept as a 3-component field), `TENSORS` and
  `FIELD FieldData n` arrays become `node_fields` / `elm_fields`; `TEXTURE_COORDINATES`, `COLOR_SCALARS`
  and `LOOKUP_TABLE` tables are read and dropped; VTK ≥ 8 `METADATA` blocks are skipped.
* **VTK XML `.vtu` / `.vtp`** (`<VTKFile type="UnstructuredGrid"|"PolyData">`): `format="ascii"`,
  `"binary"` (base64 inline) and `"appended"` (raw or base64 after the `_` of `<AppendedData>`);
  `byte_order` honoured, little-endian by default; `header_type` `UInt32` (default) or `UInt64`. An
  uncompressed array is `[nbytes][data]`. With `compressor="vtkZLibDataCompressor"` the header is
  `[nblocks, blocksize, last_size, csize_0 … csize_{nblocks−1}]` followed by that many zlib streams, and
  **inline base64 encodes the header and the block data as two separate runs** (padding may sit between
  them), so the header is decoded first and the data run starts at the next 4-character boundary. Same
  cell-type mapping as legacy; a PolyData's cells are in `Verts, Lines, Polys, Strips` order. Several
  `<Piece>`s concatenate with node-index offsets; an array missing from some piece is NaN-padded with
  `partial = true`.
* **Cell-data tag rule (VTK legacy and XML).** A cell array named, case-insensitively, `material`, `tag`,
  `tags`, `region`, `label`, `labels`, `gmsh:physical`, `ElementTag`, `elem_tags`, `medit:ref` or `ref`, with
  one component, becomes `tri_tags` / `tet_tags` (values rounded to `i32`) **and** stays an `ElmField`. The
  first such array wins; a file with none has tag 0 throughout.
* **OFF** (`[ST][C][N][4][n]OFF`, counts on the header line or the next, `#` comments): vertices take the
  first three coordinates (divided by `w` for `4OFF`), extra colour / normal / texture columns are ignored,
  n-gon faces are fanned with a mask. Tag 0 throughout.
* **MEDIT `.mesh`** (ASCII, `MeshVersionFormatted`): `Vertices`, `Triangles`, `Tetrahedra`; **each record's
  trailing reference integer is its `tri_tags` / `tet_tags` entry.** `Edges`, `Quadrilaterals`, `Hexahedra`,
  `Prisms`, `Pyramids` are counted into `skipped` under Gmsh element types 1 / 3 / 5 / 6 / 7; any other block
  is skipped silently. Binary `.meshb` (leading native-i32 keyword code 1) is `Error::Unsupported`.
* `sniff` recognises each by content — `# vtk DataFile`, `<VTKFile`, a leading `…OFF` word,
  `MeshVersionFormatted` (or the `.meshb` magic) — and by extension hint `vtk`, `vtu`, `vtp`, `off`,
  `mesh` / `meshb`.

### 6.3 `tvx-geom`

```rust
pub enum SurfaceVariant { Indexed, Deindexed }
pub struct TagRange { pub tag: i32, pub first: u32, pub count: u32 }

pub struct SurfaceBuffers {
    pub variant: SurfaceVariant,
    pub positions: Vec<f32>,            // 3 per vertex
    pub normals: Vec<f32>,              // 3 per vertex (smooth for Indexed, face for Deindexed)
    pub indices: Option<Vec<u32>>,      // Some iff Indexed
    pub node_index: Option<Vec<u32>>,   // Some iff Indexed: vertex -> INTERNAL 0-based node index (the row in
                                        //   `Mesh.nodes`). NOT a Gmsh node number.
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

// Isolation criteria. This struct crosses the wasm boundary as JSON (§6.4 `mesh_isolate`), so every serde
// attribute below is part of the frozen contract and pins it to §6.5.1 `IsolateCriteriaT` name for name.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolateCriteria {
    pub tags: Option<Vec<i32>>,
    pub field: Option<FieldRange>,
    pub sphere: Option<Sphere>,
    #[serde(rename = "box")]
    pub bbox: Option<Aabb>,
    pub label_volume: Option<LabelVolumeCriteria>,
    pub combine: Combine,
}
// FieldRange { source, name, component, lo, hi }; Sphere { center, radius };
// FieldSource = "node" | "elm"; Component = "mag" | 0 | 1 | 2 (untagged); Combine = "all" | "any".

/// The sample array is NOT part of this struct: it arrives as `mesh_isolate`'s separate
/// `label_volume: Option<Vec<u8>>` argument, because neither an ArrayBuffer nor a Uint32Array
/// survives `JSON.stringify`. `world_to_voxel` is a §6.5.1 `Mat4x4` — FLAT, length 16, column-major —
/// and is deliberately NOT `[[f64; 4]; 4]`: serde accepts that only from a nested array-of-arrays.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelVolumeCriteria { pub dims: [usize; 3], pub world_to_voxel: [f64; 16],
                                 pub dtype: String, pub volume_index: usize, pub labels: Vec<u32> }

pub struct ProbeHit {
    pub gmsh_elm: u32,                  // what the UI shows; ALWAYS the Gmsh element number (§6.2)
    pub tet_index: u32,                 // internal Morton-ordered tet index; never leaves the worker
    pub tag: i32,
    pub node_values: Vec<(String, Vec<f32>)>,   // every node field, barycentrically interpolated at `p`
    pub elm_values: Vec<(String, Vec<f32>)>,    // every element field, at the containing tet
}

pub struct LabelCentroid { pub id: u32, pub centroid: [f32; 3], pub count: u64 }

/// Glyph origins for a VOLUMETRIC `GlyphSpec` (§7.4). Points, not geometry.
pub struct Centroids { pub positions: Vec<f32>,   // 3 per origin
                       pub owner_tet: Vec<u32> }  // 1 per origin: Gmsh element number

// --- load-time (called inside loadMesh, not exported individually — see §6.4)
pub fn morton_reorder(mesh: &mut Mesh) -> Vec<u32>;                   // returns tet_perm
pub fn build_tet_blocks(mesh: &Mesh, blk: usize /* default 64 */) -> TetBlocks;
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
pub fn isolate(mesh: &Mesh, crit: &IsolateCriteria, label_volume: Option<&VolumeData>,
               p: &mut dyn ProgressSink) -> Result<BitMask>;
pub fn elm_to_node(mesh: &Mesh, field: &ElmField) -> Result<Field>;    // volume-weighted mean of adjacent tets
pub fn node_to_elm(mesh: &Mesh, field: &Field) -> Result<ElmField>;
pub fn marching_cubes(vol: &Volume, vol_index: usize, iso: f32, smooth: bool,
                      p: &mut dyn ProgressSink) -> Result<SurfaceBuffers>;
/// ONE REGION of a label volume, isolated at the sample: reads the volume through
/// `value == label ? 1 : 0` (physical units, half-unit tolerance) and marches at 0.5. Separate from
/// `marching_cubes`, and not an `iso` a caller could pass, because a label volume's samples are ids:
/// `value >= k - 0.5` is the union of every id at or above `k`, and SimNIBS ids do not nest.
pub fn marching_cubes_label(vol: &Volume, vol_index: usize, label: f32, smooth: bool,
                            p: &mut dyn ProgressSink) -> Result<SurfaceBuffers>;
pub fn marching_tets(mesh: &Mesh, node_field: &[f32], iso: f32, mask: Option<&BitMask>,
                     p: &mut dyn ProgressSink) -> Result<SurfaceBuffers>;
pub fn surface_contours(mesh: &Mesh, plane: &Plane, mask: Option<&BitMask>) -> Result<Vec<f32>>;
pub fn locate_point(mesh: &Mesh, grid: &PointLocator, p: [f32; 3]) -> Option<ProbeHit>;
pub fn nearest_vertex(nodes: &[[f32; 3]], p: [f32; 3]) -> Option<(u32, [f32; 3])>;
pub fn sphere_map(source: &[[f32; 3]], target: &[[f32; 3]]) -> Vec<u32>;
pub fn label_centroids(vol: &Volume, vol_index: usize) -> Result<Vec<LabelCentroid>>;
pub fn tet_centroids(mesh: &Mesh, mask: Option<&BitMask>, stride: usize,
                     tags: Option<&[i32]>) -> Result<Centroids>;
```

Rules:

* **Default 3D representation of a mesh that has surface elements is its own tagged triangles.** SimNIBS
  invariant: the stored tris are exactly the exterior ∪ inter-tissue-interface face set — verified 0 missing
  / 0 extra on `ernie.msh` (128,614 + 1,048,599 = 1,177,213) and `ernie-seeg.msh` (202,318 + 2,427,261 =
  2,629,579). This is a **real-data test**, so a mesh violating it fails loudly instead of rendering a hole.
  Deriving the same surfaces from tets yields 2,225,812 faces — every interface twice. `tag_surfaces`
  therefore takes **no topology** and does no geometry work beyond grouping and normals.
* `extract_boundary` serves (a) tri-less tet meshes — `grey_Thalamus_TI.msh` has 1,340,029 tets and **0
  tris**, and renders empty without it — and (b) post-isolation / post-clip boundaries. With `topo = None` it
  does a one-shot sort of the 4·N canonical face keys, keeps singletons and tag-differing pairs, and **drops
  the key buffer before returning**.
* **Unique faces without a packed key.** Counting sort on the face's *minimum vertex* into an `n_nodes + 1`
  count array, then sort within buckets on the remaining `(v1, v2)` pair. A 3×21-bit u64 key aliases distinct
  faces on both SEEG meshes (> 2²¹ nodes), silently merging them as interior and deleting real boundary
  faces. `TetTopology` carries no `tet_faces` — nothing consumes it, and it is 75.6 MB on ernie.
* **`build_topology` is explicit, awaitable and progress-reporting.** It is called eagerly *after the first
  frame*, and only when isolation or clipping needs it — never lazily from inside a drag.
* **Spatial locality at load.** After parsing, tets are reordered by the 30-bit Morton code of their centroid
  (3 × 10-bit radix passes); `tet_tags` and every tet-side `elm_fields` entry are permuted with them.
  `tet_perm` and `gmsh_elm_numbers` preserve the mapping back. **The UI always reports Gmsh element numbers,
  never internal indices.** This is load-bearing: SimNIBS writes elements grouped by physical tag, so with
  file order a per-64-block AABB reject at the mid-axial plane visits 4,722,624 of 4,722,625 tets.
* `plane_cut` visits a block iff `|n·c + offset| <= ex·|nx| + ey·|ny| + ez·|nz|`, then runs the per-tet
  kernel on survivors: 4 node signs → 1 triangle (1-3 split) or 2 triangles (2-2 split). It takes no
  topology; `boundary_segments` adjacency is built locally over the cut tets only. With multiple planes, each
  `Cut` is clipped by the *other* planes. Output must be **bit-identical with and without the block index**.
* **`Cut.edge_mask` emission rule (normative).** Bit *i* means "the edge opposite vertex *i* is a real
  element edge". A 1-3 split emits one triangle, mask `0b111`. A 2-2 split emits quad `(a,b,c,d)` in
  cut-polygon order as `(a,b,c)` and `(a,c,d)`; the diagonal is `a–c`, opposite `b` in the first ⇒ `0b101`,
  and opposite `d` in the second ⇒ `0b011`.
* `tag_surfaces` / `extract_boundary` output on a tet mesh is always fully unmasked (`edge_mask = None`).
* **De-indexing, normal generation and any vertex-buffer expansion are geometry**: they happen here, in the
  worker, and arrive as transferables. The engine never builds a vertex buffer element-by-element.
* `isolate` evaluates `label_volume` by sampling the cloned label volume (§5 rule 2) at tet centroids through
  `world_to_voxel` (nearest); a `dtype`/`dims`/byte-length mismatch is `Error::Parse`.
* **`tet_centroids` is the origin source for a volumetric `GlyphSpec`** (§7.4). Surface glyphs read
  `SurfaceBuffers.positions` + `owner_elm` and cut-plane glyphs read `Cut.positions` + `owner_tet`; interior
  glyphs with no cut plane had neither, and §7.4 forbids new geometry from WASM, so this returns one **point**
  per tet and nothing else. The centroid is the arithmetic mean of the four node positions (`+` and `÷` only,
  so it is portable); output is in **Morton order**, which is what makes a strided subsample spatially spread
  rather than clustered by physical tag. `mask` and `tags` filter **first** and `stride` then keeps every
  `stride`-th survivor, so a rare tag still gets glyphs; `stride = 0` is `Error::Parse` and an unused tag is
  an empty result, not an error.
* **`locate_point` rejects a candidate by its AABB before evaluating barycentric coordinates.** The locator's
  cells must be at least as large as the largest tet, so a candidate can be ~60 mm from the probe point — and
  an f32 barycentric test on a **sliver** tet (6·V ≈ 1e-8 mm³, of which ernie has many) is pure cancellation
  at that distance: it returned four positive weights for 2 of 48 sampled tet centroids. The AABB test is
  exact, so it can only remove wrong answers.
* **`locate_point` returns the whole probe, not an index.** The one round trip §8 budgets at ≤ 50 ms gathers
  the tag and every node/element field value at the point; splitting the gather would double the latency.
* **`nearest_vertex` is a linear scan, and `sphere_map` is not.** One is a single query per pick (0.31 ms
  over 245,762 vertices, against a permanent index nothing else would read); the other is 245,762 queries
  against 163,842 targets — 4.0e10 evaluations brute force, ~50 s. `sphere_map` buckets the target directions
  into a uniform 64³ grid over `[-1, 1]³` and scans rings outward, stopping when the best distance found is
  no larger than the distance to the boundary of the scanned box. That stop is **exact**, so the output is
  bit-identical to brute force (42 ms measured). Both tie-break to the lowest index.
* **`sphere_map` normalises both sides, and that is a correctness requirement.** `lh.sphere.reg.gii` has
  radius 1.0 ± 8.2e-8; `fsaverage/surf/lh.sphere` has radius 99.99…100.01. On exactly concentric spheres the
  Euclidean argmin would equal the angular argmin, but that 0.0157 radius spread perturbs `|a − b|²` by ~3.1
  while the angular term at the ~0.003 chord separating true neighbours is ~9e-4 — three orders of magnitude
  of noise over the signal. Raw and normalised disagree on **every** sampled ernie vertex. The real-data test
  asserts both, so a regression that drops the normalisation lands on the values it names as wrong.
* **Determinism.** Geometry outputs are byte-identical across native and wasm builds; they use only
  `+ − × ÷ sqrt` and integer ops. Any function using a transcendental is marked `#[doc(hidden)] //
  non-portable` and excluded from cross-build golden tests. No `HashMap` iteration order appears in any
  output.

### 6.4 `tvx-wasm` — worker-side exports

**No export takes an abort argument.** Cancellation is `worker.terminate()` (§1, §5 rule 6); `on_progress`
is present wherever an op can exceed one frame, and is called at section boundaries (every ~1 M records).

```rust
// `load_volume` and `volume_frame` take `GpuCaps` flattened into scalars: the caps come from
// `probeCapabilities()` on the UI thread and travel in the op args (§6.5.2). Both loaders call
// `tvx_core::fingerprint(&bytes)` BEFORE handing the vector to the parser — it is the only field of
// either meta that cannot be recovered from the parsed dataset, because the bytes are gone by then.
// `load_volume` takes no format argument: the bytes are NIfTI-1/2, MGH/MGZ, NRRD or MetaImage and
// `tvx_nifti::read_volume(bytes, None, …)` sniffs them by content (§6.1), so NIfTI bytes behave
// exactly as before the other formats existed.
#[wasm_bindgen] pub fn load_volume(bytes: Vec<u8>, lut_bytes: Option<Vec<u8>>,
                                   float_linear: bool, norm16: bool, max_3d: u32, want_linear: bool,
                                   on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
// `format` is §6.5's `MeshFormatSel`: `auto|msh|gii|fs|stl|ply|obj|geo|vtk|vtu|vtp|off|medit`
// (`vtu` and `vtp` both dispatch to `read_vtk_xml`). `"geo"` is the Gmsh parsed-view path: `read_geo_view`, then the
// views' triangles folded into ONE de-indexed `Mesh` (a `tri_tag` per view, per-corner values on a node
// field named `value`), and the points / labels / `SL` segments returned as the additive `geo` half of
// the result (§6.5.1 `GeoPayloadT`). No new op and no new export — a parsed view's triangles are a
// surface, so `surface` / `field` / `contours` / `cut` / `locate` work unchanged. An electrode net
// legitimately yields 0 nodes and 0 triangles.
#[wasm_bindgen] pub fn load_mesh(bytes: Vec<u8>, format: &str, opt_bytes: Option<Vec<u8>>,
                                 lut_bytes: Option<Vec<u8>>,
                                 on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn volume_frame(handle: u32, vol_index: u32, float_linear: bool, norm16: bool,
                                    max_3d: u32, want_linear: bool) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_surface(handle: u32, mask_id: Option<u32>, variant: &str,
                                    on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_boundary(handle: u32, mask_id: Option<u32>, variant: &str,
                                     on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_build_topology(handle: u32,
                                           on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_cut(handle: u32, planes: &[f32] /* 4 per plane, ≤ 6 planes */,
                                mask_id: Option<u32>, out: Option<CutOut>) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_isolate(handle: u32, criteria_json: &str, label_volume: Option<Vec<u8>>,
                                    on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_field(handle: u32, source: &str, name: &str,
                                  component: &str) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_convert_field(handle: u32, direction: &str, source_name: &str)
                                         -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_locate(handle: u32, x: f32, y: f32, z: f32) -> Result<JsValue, JsValue>;
// §3's surface coordinate spaces. `mesh_nearest_vertex` returns `{ vertex, coord }` or
// `{ vertex: null }`; `vertex` is the INTERNAL 0-based node index. `mesh_vertices` with
// `indices = undefined` returns every node in file order. `surface_sphere_map` takes the fsaverage
// sphere's coordinates as a flat `&[f32]` rather than a second handle: §5 rule 1 gives one worker one
// dataset, so no wasm instance holds both surfaces.
#[wasm_bindgen] pub fn mesh_nearest_vertex(handle: u32, x: f32, y: f32, z: f32) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_vertices(handle: u32, indices: Option<Vec<u32>>) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn surface_sphere_map(handle: u32, target: &[f32]) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn volume_marching_cubes(handle: u32, vol_index: u32, iso: f32, smooth: bool,
                                             on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn volume_marching_cubes_label(handle: u32, vol_index: u32, label: f32, smooth: bool,
                                                   on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_marching_tets(handle: u32, source: &str, name: &str, component: &str,
                                          iso: f32, mask_id: Option<u32>,
                                          on_progress: &js_sys::Function) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_contours(handle: u32, plane: &[f32], mask_id: Option<u32>)
                                    -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn volume_label_centroids(handle: u32, vol_index: u32) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn mesh_centroids(handle: u32, mask_id: Option<u32>, stride: u32,
                                      tags: Option<Vec<i32>>) -> Result<JsValue, JsValue>;
#[wasm_bindgen] pub fn free(handle: u32);
#[wasm_bindgen] pub fn free_mask(handle: u32, mask_id: u32);
#[wasm_bindgen] pub fn wasm_heap_bytes() -> u32;      // stamped onto every Res (§6.5), backs the §9 memory bar

// Liveness. No op maps to these; `tvx_version` is the cheapest possible check that the module the
// worker instantiated is the crate the build produced.
#[wasm_bindgen] pub fn tvx_version() -> String;                // env!("CARGO_PKG_VERSION")
#[wasm_bindgen] pub fn tvx_ping(x: u32) -> u32;                // 32-bit avalanche; predictable in JS
#[wasm_bindgen] pub fn tvx_ping_bytes(bytes: Vec<u8>) -> u32;

/// Recycled cut arena. ONE instance covers ALL planes of a `mesh_cut` call: each array is packed
/// plane-major, and `plane_offsets` (4 u32 per plane, plus one terminating quad) gives, per plane, the
/// start offsets into (vertices, triangles, edge segments, boundary segments). A JS constructor is
/// mandatory — the worker allocates and owns these arrays; wasm only `copy_from`s into them.
#[wasm_bindgen]
pub struct CutOut {
    pub positions: js_sys::Float32Array,        // 3/vertex
    pub interp_n: js_sys::Uint32Array,          // 2/vertex
    pub interp_t: js_sys::Float32Array,         // 1/vertex
    pub owner_tet: js_sys::Uint32Array,         // 1/triangle
    pub tag: js_sys::Int32Array,                // 1/triangle
    pub edge_mask: js_sys::Uint8Array,          // 1/triangle
    pub edge_segments: js_sys::Float32Array,    // 6/segment
    pub boundary_segments: js_sys::Float32Array,// 6/segment
    pub plane_offsets: js_sys::Uint32Array,     // 4*(nplanes+1)
}
```

**Rust functions with no wasm export, and why:**

| Rust fn | Reason |
|---|---|
| `morton_reorder`, `build_tet_blocks`, `build_point_locator`, `orient_surface`, `vertex_normals`, `face_normals` | Run inside `load_mesh` / `mesh_surface`; load-time invariants, not client-callable state |
| `read_msh_opt` | Run inside `load_mesh` from the optional sibling bytes; result appears as `MeshMeta.opt` |
| `read_msh` / `read_gifti` / `read_fs_*` / `read_stl` / `read_ply` / `read_obj` / `read_vtk` / `read_vtk_xml` / `read_off` / `read_medit` / `sniff` | Dispatched by `load_mesh(format)` |
| `read_volume` (→ `read_nifti` / `read_mgh` / `read_nrrd` / `read_metaimage`, `sniff_volume`) | Run inside `load_volume`, sniffed by content |
| `Volume::sample_nearest` | Probes are served from the UI thread's retained `data` array (§4.3); native/CLI only |
| `Volume::stats` / `label_index` / `gpu_payload` | `load_volume` runs them for index 0, `volume_frame` for any other |
| `LabelTable::parse_*` | Sidecar LUT text is parsed in the worker as part of `load_volume` / `load_mesh`. The **worker** fetches the sidecar; the crates never touch the filesystem |
| `elm_to_node` / `node_to_elm` | Both reachable through `mesh_convert_field(direction)` |
| `BitMask::*`, `Field`, `Plane`, `Aabb`, `Error`, `ProgressSink` | Types and helpers, not operations |

**Memory rules for results (never violated):**

> Bulk results are returned either as `Vec<T>` — wasm-bindgen already `.slice()`s into a fresh transferable
> ArrayBuffer, so the worker transfers `result.buffer` **as-is** — or, for hot-path recycled buffers, by
> passing `js_sys::*Array`s the worker owns and writing with `copy_from` (one memcpy, no wasm-side output
> allocation). **Never** hand a `js_sys::*Array::view()` onto `wasm.memory.buffer` across a call boundary:
> `memory.grow` detaches every outstanding view. Never use `&mut [MaybeUninit<T>]` for outputs — two copies.

**The two `mesh_cut` paths, normatively.**

* `out: None` — **buffers path.** Returns `{ mode: 'buffers', cuts: CutPayload[] }`, one entry per plane,
  every array a freshly allocated transferable. This is the correctness reference and the only path a golden
  test uses.
* `out: Some(pool)` — **recycled path**, for a cut-plane drag at ≥ 30 fps. wasm `copy_from`s every plane's
  data into the caller-owned arrays back to back, fills `plane_offsets`, and returns
  `{ mode: 'recycled', truncated: false, counts: […] }`. If any array is too small, **nothing is written**:
  the call returns `truncated: true` with `counts` holding the *required* capacities, and the worker grows
  the pool (doubling) and re-calls. This is the only overflow protocol; a partially-filled pool is never
  returned.
* Both paths produce the same `edge_segments` / `boundary_segments`. There is no 3D-caps-only path.

## 6.5 Worker protocol

`packages/protocol/src/index.ts` is exactly this. Zero imports, and its only runtime code is the type guards
plus **two frozen lookup tables that mirror declarations in this section**: `OP_NAMES` (the `OpName` union as
an array, in declaration order) and `OP_TO_EXPORT` (the op → §6.4 export map). The op→export mapping is the
one seam TypeScript cannot check on its own — a renamed export is a runtime `undefined` otherwise — so it is
data here and `packages/wasm/src/index.test.ts` asserts it against the real module. Nothing else runtime.
**FROZEN (§12.3).**

```ts
export type Phase = 'read' | 'inflate' | 'parse' | 'topology' | 'index' | 'upload';
export type ErrorCode = 'parse' | 'unsupported' | 'io' | 'oom' | 'cancelled' | 'panic';
export interface WorkerError { code: ErrorCode; message: string }

export type OpName =
  | 'loadVolume' | 'loadMesh' | 'volumeFrame' | 'surface' | 'boundary' | 'buildTopology' | 'cut' | 'isolate'
  | 'field' | 'elmToNode' | 'locate' | 'marchingCubes' | 'marchingCubesLabel' | 'marchingTets' | 'contours'
  | 'labelCentroids' | 'meshCentroids' | 'nearestVertex' | 'vertices' | 'sphereMap'
  | 'free' | 'freeMask';                                           // 22 ops

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

Every type below mirrors a §4 or §6 struct; the differences from §4 are the ones that matter:

* **Colours are 0..255** on the wire, 0..1 in §4 (§4.1).
* **`Mat4x4 = number[]`, length 16, column-major** (§3).
* `VolumeMeta.stats` and `.gpu` describe **volume 0 only**; other 4D indices come from `volumeFrame`.
* `SurfacePayload.nodeIndex` and `CutPayload.interpNodes` carry **internal** 0-based node indices;
  `ownerElm` / `ownerTet` carry **Gmsh element numbers** (§6.2).
* Typed arrays travel as transferables. `IsolateCriteriaT` is `JSON.stringify`d into `mesh_isolate`, so it
  contains **no** typed arrays and **no** ArrayBuffers — a `Uint32Array` stringifies to `{"0":…}` and an
  ArrayBuffer to `{}`. The label volume's samples travel as the separate `labelVolume` op argument. Its field
  names and enum encodings are pinned to §6.3's serde attributes: camelCase members, `box` kept as `box`,
  lowercase enum strings.
* Sidecars are keyed **by role**, never positional, so the worker can tell a `_LUT.txt` from a `.msh.opt`
  without sniffing: `lut` → `load_volume`/`load_mesh`'s `lut_bytes`, `opt` → `load_mesh`'s `opt_bytes`.
* `GeoPayloadT` is the additive `geo` half of a `loadMesh` result, present **only** for `format: 'geo'`. Its
  ST/SQ triangles are *not* in it — they are the `Mesh` the same call loaded, with the per-corner values on
  the node field named `value`. Every array in it is de-indexed, world mm.

```ts
export type PlaneT = { normal: [number, number, number]; offset: number };
export type Mat4x4 = number[];                       // length 16, column-major
export type SurfaceVariant = 'indexed' | 'deindexed';
export type FieldSource = 'node' | 'elm';
export type ComponentSel = 'mag' | 0 | 1 | 2;

export interface StatsT { min; max; mean: number;
  percentiles: [number × 9];                         // 0.1, 1, 2, 5, 50, 95, 98, 99, 99.9
  histogram: Uint32Array; histogramLo; histogramHi: number }
export interface LabelEntryT { id: number; name: string; color: [number × 4] }   // RGBA 0..255
export interface ProbeHitT { elementId: number; tag: number;      // mirrors §6.3 `ProbeHit`
  nodeValues: Record<string, number[]>; elmValues: Record<string, number[]> }

export interface VolumeMeta { handle; name; fingerprint; dims; nvols; affine: Mat4x4; spacing;
  dtype; sclSlope; sclInter; isLabel; intentCode; units?; stats: StatsT; headerJson;
  gpu: { format; scale; offset; filterable; chunked }; labelTable?: LabelEntryT[] }
export interface VolumeFrameT { volumeIndex: number; gpuBytes: ArrayBuffer; gpu: VolumeMeta['gpu'];
  stats: StatsT; labelIds?: Uint32Array; denseIndexOf?: Uint32Array }   // present iff isLabel
export interface MeshMeta { handle; name; fingerprint; nNodes; nTris; nTets; hasTris;
  appliedTransform: Mat4x4; dataSpace?; transformedSpace?; bounds; tags; fields: MeshFieldMeta[];
  skipped; orient; opt?; labelTables?: Record<string, LabelEntryT[]> }   // labelTables keyed by node-field name

export interface SurfacePayload { variant: SurfaceVariant;
  positions: Float32Array; normals: Float32Array;    // 3/vertex
  indices?: Uint32Array; nodeIndex?: Uint32Array;    // indexed only
  corner?: Uint8Array;                               // deindexed only: 0|1|2
  ownerElm: Uint32Array; faceTag: Int32Array; edgeMask?: Uint8Array;   // 1/triangle
  perTag: { tag; first; count: number }[]; orient; bounds }

export type CutResult =
  | { mode: 'buffers';  cuts: CutPayload[] }
  | { mode: 'recycled'; truncated: boolean; counts: CutCounts[] };   // truncated ⇒ counts are REQUIRED sizes
export interface CutPayload { plane: number;
  positions: Float32Array; interpNodes: Uint32Array; interpT: Float32Array;   // per vertex
  ownerTet: Uint32Array; tag: Int32Array; edgeMask: Uint8Array;               // per triangle
  edgeSegments: Float32Array; boundarySegments: Float32Array }                // 6/segment, 2D overlay only

export interface GeoPayloadT { points; pointValues; pointView;   // 3/point, 1/point, 1/point (view index)
  labelPositions: Float32Array; labelTexts: string[];
  lineSegments: Float32Array; lineValues: Float32Array;           // 6/segment, 2/segment
  viewNames: string[]; views: { name; points; labels; lines; tris; timeSteps; skipped }[]; bounds }

export type LoadSource =
  | { kind: 'url';   url: string;   sidecars?: { lut?: string; opt?: string } }      // tetravox://file/…
  | { kind: 'file';  file: File;    sidecars?: { lut?: File; opt?: File } }
  | { kind: 'bytes'; name: string; bytes: ArrayBuffer;
      sidecars?: { lut?: ArrayBuffer; opt?: ArrayBuffer } };
```

**Worked isolation example — the exact bytes on the wire.** Isolate ernie's grey matter (tet tag 2) to the
tets whose `TI_max` is in [0.2, 0.6] *and* which fall inside `final_tissues.nii.gz` labels {2, 3}:

```jsonc
// Req.args of op "isolate":
{
  "handle": 7,
  "criteria": {
    "tags": [2],
    "field": { "source": "elm", "name": "TI_max", "component": "mag", "lo": 0.2, "hi": 0.6 },
    "labelVolume": {
      "dims": [256, 256, 208],
      "worldToVoxel": [0,-1,0,0, 0,0,1,0, 1,0,0,0, 99.737457,-154.1875,143.642273,1],
      "dtype": "u16", "volumeIndex": 0, "labels": [2, 3]
    },
    "combine": "all"
  },
  "labelVolume": /* ArrayBuffer, 256*256*208*2 = 27,262,976 bytes, structured-CLONED (§5 rule 2) */
}
```

The worker calls `mesh_isolate(7, JSON.stringify(args.criteria), new Uint8Array(args.labelVolume), onProgress)`.
Rust deserialises that string straight into §6.3's `IsolateCriteria` and reinterprets the byte argument as
`u16` per `dtype`. `worldToVoxel` is flat, length 16, column-major, and §6.3 types it `[f64; 16]` so serde
reads the 16 numbers literally — a `[[f64; 4]; 4]` there would fail with `invalid type: integer 0, expected
an array of length 4` on this exact payload (§3).

### 6.5.2 Op table

Every op runs on its dataset's worker. `handle` is that worker's single dataset unless stated.

| op | args | result | notes |
|---|---|---|---|
| `loadVolume` | `{ source: LoadSource; caps; wantLinear }` | `{ meta: VolumeMeta; data; gpuBytes: ArrayBuffer; labelIds?; denseIndexOf? }` | `data` = raw samples for probes; `gpuBytes` = the `gpu_payload` texture bytes |
| `loadMesh` | `{ source: LoadSource; format: 'auto'\|'msh'\|'gii'\|'fs'\|'stl'\|'ply'\|'obj'\|'geo'\|'vtk'\|'vtu'\|'vtp'\|'off'\|'medit' }` | `{ meta: MeshMeta; geo?: GeoPayloadT }` | no bulk arrays; Morton reorder + `TetBlocks` + `PointLocator` built here. `geo` present **only** for `'geo'` |
| `volumeFrame` | `{ handle; volumeIndex; caps; wantLinear }` | `VolumeFrameT` | the **only** way to display a 4D index ≠ 0 |
| `surface` | `{ handle; variant; maskId? }` | `SurfacePayload` | `tag_surfaces` when `hasTris`, else `extract_boundary` |
| `boundary` | `{ handle; maskId?; variant }` | `SurfacePayload` | always `extract_boundary`; used after isolation/clip |
| `buildTopology` | `{ handle }` | `{ faces; boundaryFaces }` | explicit, awaitable, progress-reporting |
| `cut` | `{ handle; planes: PlaneT[] /* ≤6 */; maskId?; recycle? }` | `CutResult` | one `Cut` per plane, each clipped by the others. `recycle: true` ⇒ the `'recycled'` variant (§6.4) |
| `isolate` | `{ handle; criteria: IsolateCriteriaT; labelVolume?: ArrayBuffer }` | `{ maskId; visibleTets; generation }` | client owns `maskId` and must `freeMask`. `labelVolume` is **cloned not transferred** (§5 rule 2), and is the only bulk argument any op takes |
| `field` | `{ handle; source; name; component }` | `{ values: Float32Array; stats; n; partial }` | **ordering is part of the contract.** `node` ⇒ one value per INTERNAL node index. `elm` ⇒ `[tris…, tets…]` in the **file's element order**, so row `i` is the file's `i`-th element and, when `identityElementNumbers`, its Gmsh number is `i + 1` — which is what makes `ownerElm`/`ownerTet` a usable key. The tet block is **un-permuted** on the way out |
| `elmToNode` | `{ handle; direction: 'elmToNode' \| 'nodeToElm'; name }` | `{ name; values; stats }` | `nodeToElm` uses `field`'s element order |
| `locate` | `{ handle; world }` | `{ hit: ProbeHitT \| null }` | one round trip; `elementId` is always a Gmsh element number. Latest-wins on its own key |
| `marchingCubes` | `{ handle; volumeIndex; iso; smooth }` | `SurfacePayload` | |
| `marchingCubesLabel` | `{ handle; volumeIndex; label; smooth }` | `SurfacePayload` | §4.4's `VolumeLayer.iso3d` on a label volume |
| `marchingTets` | `{ handle; source; name; component; iso; maskId? }` | `SurfacePayload` | |
| `contours` | `{ handle; plane: PlaneT; maskId? }` | `{ segments: Float32Array }` | 6 floats per segment. **Stored triangles only.** A tri-less tet mesh answers with **zero** segments, legitimately — its `contoursIn2D` tissue boundaries are `cut` → `boundarySegments`, which arrive with `fillIn2D`'s polygons on the same latest-wins key. Two producers, not interchangeable |
| `labelCentroids` | `{ handle; volumeIndex }` | `{ centroids: { id; centroid; count }[] }` | |
| `meshCentroids` | `{ handle; maskId?; stride; tags? }` | `{ positions: Float32Array; ownerTet: Uint32Array }` | glyph origins for a **volumetric** `GlyphSpec` (§7.4), Morton order, no geometry. `maskId`/`tags` filter first, then every `stride`-th survivor; `stride: 0` is `Error::Parse`. Also serves the region panel's jump-to-centroid for a mesh tissue tag |
| `nearestVertex` | `{ handle; world }` | `{ vertex: number \| null; coord? }` | the mesh **node** nearest a world point. Not `locate`: that finds the containing tet, and a surface has none |
| `vertices` | `{ handle; indices?: Uint32Array }` | `{ positions: Float32Array }` | `indices` omitted = **every** node in file order, which is how one surface's coordinates reach another dataset's worker. An index past the end is `Error::Parse`, never a zeroed coordinate |
| `sphereMap` | `{ handle; target: Float32Array }` | `{ map: Uint32Array }` | subject `sphere.reg` vertex → nearest fsaverage `sphere` vertex. `handle` is the **subject's** sphere; `target` is the fsaverage sphere's flat xyz triples, read from its own worker with `vertices` — not two handles, because §5 rule 1 gives one worker one dataset. **Cloned, not transferred**: the caller keeps the directions for the other hemisphere |
| `free` | `{ handle }` | `{}` | the client then calls `worker.terminate()` |
| `freeMask` | `{ handle; maskId }` | `{}` | masks are also dropped when the mesh handle is freed |

`OpArgs` and `OpResult` are written out in full — one member per `OpName`, exhaustive, no index signature —
so `Req<'cut'>` and `Res<'cut'>` are fully typed. `OP_TO_EXPORT` maps each op to its §6.4 export one-to-one
(`loadVolume`→`load_volume`, `elmToNode`→`mesh_convert_field`, `sphereMap`→`surface_sphere_map`, and so on);
`wasm_heap_bytes()` is the only export without an op.

Lifecycle rules:
* Progress messages carry the same `id` as their `Req`. A `Cancel` with that `id` drops the request if it is
  still **queued**. If it is in flight there is no abort flag to set (§5 rule 6): for `loadVolume`/`loadMesh`
  the client terminates the worker and synthesises a `cancelled` error; every other op runs to completion and
  its result is discarded.
* **`generation`** is a `u32` counter per mesh handle, incremented by the worker on every successful
  `isolate` and stamped into `MeshGeometry.cacheKey` (§4.5), so a re-isolation to a numerically identical
  mask still invalidates cached geometry. A `surface`/`boundary`/`cut`/`marchingTets` naming a `maskId` from
  an older generation is `Error::Parse`, never a silent stale draw.
* Masks: the client frees eagerly on every isolation change; the worker drops all masks when its handle is
  freed. A stale `maskId` is `Error::Parse`, never silent.
* Every successful `Res` carries `heapBytes` from `wasm_heap_bytes()`.

---

## 7. Engine (WebGL2) — rendering contract

### 7.0 Antialiasing & target chain

1. **AA is per-view and 3D-only.** 2D slice views draw one screen-filling quad with no interior geometric
   edges; they render single-sample. Every visible edge in a 2D view is shader-derived, and MSAA cannot touch
   it (item 5).
2. **The canvas is created with `antialias: true` and passes 1–3 render directly to the default
   framebuffer** — `SAMPLES = 4`, `SAMPLE_BUFFERS = 1` with no FBO chain. Do not build an MSAA FBO chain.
3. `Framebuffer` (§7.1) carries `samples: number` even while unused, and allocates via
   `renderbufferStorageMultisample` when `samples > 0`. OIT forces the main render offscreen and the free
   canvas MSAA disappears there; without the field that is a breaking rewrite.
4. **Hard GL constraints:**
   * `MAX_SAMPLES = 4` on ANGLE/Metal; `samples = 8` ⇒ `INVALID_OPERATION`. Choose the count from
     `getInternalformatParameter(RENDERBUFFER, fmt, SAMPLES)` per format, take the first entry, expose it as
     a quality setting clamped to that list.
   * **Integer formats support zero sample counts**: that query returns `[]` for `RGBA32UI`/`RGBA8UI`/`R32UI`
     and `renderbufferStorageMultisample` on them is `INVALID_OPERATION` (so is `samples = 1`). The pick
     target is allocated with `texStorage2D` / `renderbufferStorage`, never the multisample entry point.
   * `blitFramebuffer` cannot resolve **and** rescale in one call: MS→SS with a size change ⇒
     `INVALID_OPERATION`. Resolve and SSAA downsample are two steps.
   * MS→SS blit of `DEPTH_BUFFER_BIT` is `NO_ERROR`, so the overlay pass may run after the resolve and still
     depth-test.
5. **MSAA is coverage-only and does not antialias this design's dominant edges.** WebGL2 is GLSL ES 3.00 with
   no per-sample shading: `sample in` fails to compile and `gl_SampleID` is undeclared. `fwidth` compiles
   fine. Each of these needs its own analytic AA, in the shader:
   * §7.4 barycentric wireframe: `smoothstep(0, fwidth(bary)·w, min3(bary))`.
   * §7.3 label outlines: derive a distance-to-boundary from the neighbour-label test and `fwidth`-scale the
     smoothstep, not a binary "different label ⇒ outline colour".
   * §7.3 threshold edges: `discard` kills all samples, so thresholded boundaries stay hard at any sample
     count. Ramp alpha over `Threshold.softEdge`, §4.2's definition verbatim.
   * `outlineWidthPx`, `contourWidthPx`, `edgeWidthPx` are in **render-target** pixels and must be scaled by
     the DPR/SSAA factor.
6. **`gl.lineWidth()` is a no-op** — `ALIASED_LINE_WIDTH_RANGE` is `[1,1]`. Every `*WidthPx` knob on
   line-drawn geometry (`contourWidthPx`, crosshair, gizmo, annotation lines) is implemented as instanced
   screen-space quad expansion, never `LINES` + `lineWidth`. `outlineWidthPx` and `edgeWidthPx` are
   fragment-shader based and unaffected.
7. **Progressive refinement (later, but the API shape is settled).** Because per-sample shading is
   unavailable and MSAA caps at 4, jittered-projection accumulation is the only thing that fixes shading
   aliasing together with wireframe/outline/threshold edges: accumulate 8–16 jittered frames into an RGBA16F
   target while the camera is still. `requestRender()` is therefore a **converging state machine**, not
   single-shot, and `whenSettled()` resolves only after convergence.
8. **Goldens use `aa: 'off'`.** MSAA resolve is driver-dependent and §12's golden authority is SwiftShader
   while release rendering is ANGLE/Metal.

### 7.1 GL kit and capabilities (`packages/engine/src/gl/`)

Thin wrappers: `Program` (compile/link, uniform cache, `#include`-style chunks, **variant cache keyed on
`(colorMode, flatShading, isLabel, activeClipPlaneCount)`**), `Buffer`, `VertexArray`, `Texture2D` /
`Texture3D`, `Framebuffer`, `Timer`. Single shared context per engine; **no per-frame allocations**.

```ts
export interface Capabilities {
  renderer: string; vendor: string;             // WEBGL_debug_renderer_info
  isSoftware: boolean;                          // /SwiftShader|llvmpipe|softpipe/i
  floatLinear: boolean;                         // OES_texture_float_linear
  norm16: boolean;                              // EXT_texture_norm16
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
* `probeCapabilities` runs **once, at context creation, before any texture exists**, and is cached.
  `getExtension` is a *request*, not a query — it must be **called**, or the feature is unavailable even
  where the driver has it.
* **Invariant:** never leave `TEXTURE_MIN/MAG_FILTER = LINEAR` on a format `caps` says is not filterable.
  The texture becomes incomplete and samples 0 **with no GL error**.
* Binding an integer texture to a `sampler3D` uniform is `INVALID_OPERATION`, so the slice shader has two
  compiled variants keyed off `isLabel`, not a uniform switch.
* **REQUIRED = WebGL2 core only.** Each optional extension has a named fallback: no `OES_texture_float_linear`
  ⇒ force `interpolation:'nearest'` on R32F layers and flag it in the layer panel; no `EXT_texture_norm16` ⇒
  the §6.1 ladder steps to R32F or R8; no `WEBGL_clip_cull_distance` ⇒ the `discard` clip path (§7.4); no
  timer query ⇒ wall-clock frame time only.
* **Never use `gl_CullDistance`; a lint forbids the identifier.** `MAX_CULL_DISTANCES_WEBGL` is 0 on
  ANGLE/Metal but **8 under headless SwiftShader** — CI goldens would pass while every real Mac fails.
* **The two renderer classes differ, and the golden authority is the weaker one:**

  | Capability | ANGLE/Metal | SwiftShader |
  |---|---|---|
  | `EXT_texture_norm16` | **true** | **false** |
  | `MAX_CULL_DISTANCES_WEBGL` | 0 | 8 |
  | `MAX_VARYING_VECTORS` | 30 | 31 |

  The `norm16` row is the consequential one: under SwiftShader every `caps.norm16` row of the §6.1 ladder
  falls through, so a float32 T1 is **R32F in every golden and R16 in the shipping renderer**. §11 states
  what follows.
* **`EngineOptions.forceCaps`** exists so the branch the golden authority never takes is still tested:
  `create(canvas, { forceCaps: { norm16: false } })` overrides the probe result after it runs. The
  macOS/ANGLE leg runs an analytic `expectPixel` test with `forceCaps` unset (R16 path) and one with
  `norm16: false` (R32F path). `forceCaps` may only ever *remove* a capability, never add one.
* `Capabilities` is surfaced verbatim in the §8 status bar, in scene JSON dumps and in bench output.
* `getContext('webgl2') === null` ⇒ a real error screen naming `chrome://gpu`, never a white window.

### 7.2 Passes per frame, frame pump, transparency, picking

**Pass order (per view):**

1. **Opaque** — volume base slices (2D: the slice; 3D: the plane of each `SliceView` whose owning volume
   layer has `showIn3D`), opaque meshes, opaque isosurfaces, points, a points layer's `SL` segments, and the
   cut caps of opaque layers. The segments draw through §7.4's contour program; §4.4's `lineColors`
   (2026-08-30) adds a fourth per-instance attribute and the program's one variant, `CONTOUR_COLORS` — at 0,
   which is every mesh contour and every layer without the array, the fragment is `uColor` verbatim and the
   compiled shader is the one every golden was captured with; at 1 the uniform becomes a
   `vec4(1, 1, 1, opacity)` tint, so the layer's opacity still reaches a per-segment colour.
   * **Points in a 2D pane are the sphere ∩ plane disc**, radius `sqrt(r² − d²)` for a signed plane distance
     `d`, drawn *on* the plane; a point with `|d| ≥ r` is not on this slice and the vertex shader drops it
     off screen. `shape: 'dot'` is culled by the same world rule and then drawn at a constant screen
     radius — **4 CSS px** unless §4.4's `dotRadiusPx` says otherwise (2026-08-30), through
     `uDotPx = dotRadiusPxOf(layer) · uiScale`, which is the same expression the selection ring and the
     CPU hit test read so the three cannot answer different sizes. §4.4's **`offPlaneOpacity > 0` adds the second case**: the dropped points are drawn as
     well, at the **full** radius `r` (a `dot` at its same 4 px) and at that alpha, through a `uGhostAlpha`
     uniform on the existing `POINTS_2D` program rather than a third variant — `derived.ts` already writes
     per-layer uniforms there, and the value is clamped to 0…1 because a scene file is editable text. At 0,
     which is what absent means, the shader takes the cull branch verbatim and the pixels are the ones every
     §11 golden was captured with.
2. **Transparent, scene-wide, two phases:**
   * **2a — back faces:** `cullFace(FRONT)`, depth test on, depth write off; objects sorted back-to-front by
     the depth of their **far** extent.
   * **2b — front faces:** `cullFace(BACK)`, depth test on, depth write off; objects sorted back-to-front by
     the depth of their **near** extent.
   * Translucent **isosurfaces** (`passes/derived.ts`, which runs after the mesh pass) take 2a then 2b as
     well, unsorted among themselves — a `SurfacePayload` carries no bounds, and the per-region surfaces of
     one label volume share a box anyway. A `cull` surface has no back sheet and joins 2b only.

   Unified rule: *in each phase, objects are sorted back-to-front by the depth of the sheet that phase
   draws.* Exact for nested, individually near-convex shells (scalp, skull, CSF, blood — median 2 crossings);
   a partial improvement for GM/WM (median 4–6). Layers with `faceMode:'both'` are excluded from the split
   and drawn last in 2b. Per-tag sub-draws mean per-tag opacity sorts naturally.
   Cut caps are drawn **in the same pass as their owning layer, with that layer's opacity**; in the
   transparent pass a cap is a single sheet — `CULL_FACE` disabled, sorted by the clip plane's depth at the
   object centre. *Invariant:* a cap must exist wherever the clip discards geometry, or the phase split shows
   the shell interior through the cut.
3. **Overlay** — crosshair, cut-plane gizmo, contours on slices, glyph labels, a points layer's 3D text
   labels, measurements, annotations, orientation letters, corner info, RAD/NEU badge, colour bars, scale
   bar, orientation cube. **All clip distances disabled** in this pass, or the gizmo gets clipped by the
   plane it manipulates. Every colour in this pass comes from `DrawInput.theme` (an `OverlayTheme`), not from
   a constant; the **halo inverts** with the theme rather than shifting, because its job is contrast against
   anatomy. The field is optional and absent means `DEFAULT_OVERLAY_THEME`, so §11's goldens do not move.
   * **Measurements** are drawn in **every pane that contains their points**, and "contains" differs by pane
     kind: a 3D pane contains any point in front of its eye, a 2D pane only points within `MEASURE_SLAB_MM`
     (0.5 mm) of its plane — a segment whose far end is 40 mm away would put a line across an image it has
     nothing to do with. Both kinds project through the pane's **own** view-projection. The segment is
     screen-space quad expansion at a constant width (§7.0.6), every endpoint carries a marker, and the label
     is the mm/degree value in the pass-3 bitmap font — hence `MM` and `DEG`, the only spellings its
     `A-Z 0-9 .,:-+/()` alphabet has. A segment's label is lifted off its midpoint; an **angle's** is pushed
     out along the **bisector**, the direction furthest from both arms, because a label lifted straight up
     from a vertex whose arm also goes straight up is drawn over that arm.
   * **`PointsLayer.labels`** are *text at a world position* — a Gmsh `T3`, `E001` above the electrode it
     names. There is no 3D-text geometry: the anchor is projected through the pane's own view-projection and
     the string is drawn as flat overlay glyphs with the standard halo. **They are NOT occlusion-tested** —
     §7.2.3's pick target carries element ids, not depth, and is rendered *after* this pass, so hiding one
     would need a `readPixels` stall per pane per frame. What is dropped is what is free: an anchor behind
     the eye or outside the pane, and — in a 2D pane — every anchor further than one point radius from the
     slice, because a 187-electrode net projected whole onto one axial slice is a smear of names belonging to
     slices 80 mm away.
   * **`PointsLayer.labelSource`** (2026-08-30) picks which array that text comes from: `'labels'` —
     absent, and every layer written before the field — is the `labels` array above; `'names'` draws
     `points[].name` at each point's **own** position, dropping the points that have no name. One
     resolver, `pointLabelAnchors`, so the pass has no branch inside its loop and §11 can assert
     which strings a layer emits with no GL context. **The slab rule does not follow the ghost**: a
     layer with `offPlaneOpacity > 0` draws its off-slice discs and still drops every label further
     than `max(radiusMm, 1 mm)` from the plane. The two 2D rules diverge deliberately — a disc at
     0.6 alpha is a legible hint of where the shaft goes, and a whole shaft's worth of names on one
     slice is the smear this bullet's slab exists to prevent.
   * **`PointsLayer.labelColorSource`** (2026-08-30) picks *whose* colour that text is drawn in:
     `'layer'` — absent, and every layer written before the field — is `labelColor ?? color` for
     every label; `'points'` draws each name in its own point's `color`, which is the colour
     `packPoints` gives that point's disc, so a marker and its name cannot end up different colours.
     It applies to `labelSource: 'names'` alone: a `labels` entry is free-standing `T3` text with no
     point behind it. The layer's `opacity` fades whichever colour won, applied once in
     `drawPointLabels` rather than pre-multiplied into one of the two by the caller.
   * **Point selection and hover rings** (§13's point editing, 2026-08-30). `DrawInput.pointSelection`
     and `pointHot` name a points layer and an **array index**; the pass draws a ring around that
     point in `OverlayTheme.select` — a new theme field, engine default only, so no app token work
     and no golden moves — at the **drawn disc's radius plus 2 px**, the selection's 2 px wide and
     the hover's 1. The radius comes from `discRadiusPx`, which restates the vertex shader's rule on
     the CPU (cross-section, `dot` pixels, ghost's full radius) and returns `null` for a point the
     pane culls: **a ring is only ever drawn where the disc is**, because a ring around something
     invisible claims the tool has selected something the user cannot see. A stale index or a hidden
     layer draws nothing rather than being clamped — a ring around the *wrong* contact is worse than
     no ring, and after a delete the two are one array replacement apart. A hover ring that names the
     selected point is dropped, so the user never sees two concentric circles a pixel apart. In a 3D
     pane the radius is measured the way the billboard is built: the projected distance from the
     centre to a point `radiusMm` along the camera's right, off `viewProj`'s rows.
   * The **scale bar** (2D panes) and the **orientation cube** (3D panes) both take the pane's
     **bottom-right** corner, which they can never contend for. The bar's length is snapped to
     `1 / 2 / 5 / 10 / 20 / 50 / 100 mm` so it lands in 60…160 px, and the **drawn length is exactly
     `mm / mmPerPx`**, which §11 asserts off the framebuffer at two zooms: a bar is a promise about a
     distance, so it is measured, never eyeballed. The cube is drawn with its **own orthographic
     projection** of a unit cube — never the pane's view-projection, or it would change size with the dolly
     and be clipped by the near plane — at `half/√3` per unit, so no rotation can push a corner out of its
     box. `cubeFaces` produces the picture *and* the hit test; a click goes through `Engine.cameraPreset`, so
     the cube and §7.5's `1..6` keys cannot diverge.
4. **Pick (on demand)** — §7.2.3.

**Frame pump:**

* `requestRender(viewId?)` sets a dirty bit; it **never** renders synchronously. One `requestAnimationFrame`
  callback per engine drains all dirty bits and renders each dirty view **at most once**. Chromium coalesces
  `pointermove`/`wheel` to one dispatch per frame, but discrete events and — the real hazard — **worker
  `message` and IPC callbacks are ordinary tasks and never frame-aligned**, so latest-wins results would
  otherwise each drive an off-vsync render mid-gesture. Worker results mutate scene state and call
  `requestRender()`; they never draw.
* **Budget is stated per cadence:** ≤ 8 ms at 60 Hz, ≤ 5 ms at 120 Hz. On a ProMotion display Chrome drives
  rAF at 120 Hz; the pump skips alternate vsyncs when the last full-quality frame exceeded ~6 ms.
* **`interacting` state** lives on the engine (not in React): entered on pointerdown / wheel / key-repeat /
  gizmo drag, left `settleMs` (default 120 ms) after the last input. Leaving it triggers exactly one
  full-quality re-render.
  **Forbidden in the fallback set: any knob that changes displayed *values* rather than displayed
  *resolution*.** `interpolation` is a reading, not a rendering setting. **Nor is a display feature the user
  switched on** — element edges are the worked example, and `QualityLevel` has no `edges` field for exactly
  the reason it has no `interpolation` one. A level may never change `MeshLayer.label` emphasis, nor the
  *geometry variant* a layer requested — a drag that swapped the de-indexed surface for the indexed one
  would re-upload mid-gesture and re-shade every fragment, which is a different picture rather than a
  cheaper one.
  **Which knobs are live** — because a level nothing reads is a status bar announcing a degradation that
  never happened:

  | Knob | State |
  |---|---|
  | `dprScale` | live, and 1 at **every** level, so it never changes anything: the host owns `canvas.width/height` (§8) |
  | `msaa` | not yet — `antialias` is a *context* attribute; changing it per frame needs §7.0.7's accumulation target |
  | `capDecimation` | not yet — needs `plane_cut` to emit fewer cap triangles |

  No knob is live today, so `interacting` is currently a *gesture in flight* and not a degradation, and §8's
  status bar says so in those words.
* **Automatic degradation:** when the median full-quality frame over the last 30 frames exceeds the budget,
  drop one `QualityLevel` and **surface it in the status bar**. Never degrade silently.
* **Main-thread budget rule:** no single main-thread call may exceed `frameBudget / 2` while interacting.
  This is what forces the chunked texture upload in §7.3 and the async cap path in §6.3.
* **`whenSettled()`** resolves after `interacting` has cleared, all pending worker requests for visible
  layers have landed, any accumulation has converged, and one full-quality frame has completed. Every golden
  screenshot and every `screenshot()` call awaits it and renders at full quality regardless of the current
  `QualityLevel`. Without this the adaptive pump makes every golden test racy.

**Depth:**

* Standard OpenGL NDC (−1..1). **`EXT_clip_control` is not used and reverse-Z is not used.** Measured on
  ANGLE/Metal with a 24-bit buffer at near = 1 / far = 2000: 0.02 mm of separation resolves 100 % of pixels —
  three orders finer than any geometry here — while reverse-Z + `ZERO_TO_ONE` turns the coplanar
  slice-layer case from 4.4 % dropout into 98.9 %.
* The 3D camera fits `near = max(1 mm, fitRadius/1000)` and `far = fitRadius × 8`; never a fixed
  sub-millimetre near plane (0.01 mm breaks ordering even at 0.1 mm separation).

### 7.2.3 Pick pass

* Target: **two single-sample `R32UI` colour attachments** (`COLOR_ATTACHMENT0` = id, `COLOR_ATTACHMENT1` =
  depth-as-uint) + a `DEPTH_COMPONENT24` renderbuffer, sized to the *same* device-pixel dimensions as the
  colour target so ids are 1:1 with displayed pixels. `clearBufferuiv([0,0,0,0])`;
  `readPixels(RED_INTEGER, UNSIGNED_INT)` returns the exact value; 1×1 sync readback is 0.031 ms — no PBO
  needed. `RED_INTEGER`/`UNSIGNED_INT` is the *implementation-defined* read format
  (`IMPLEMENTATION_COLOR_READ_FORMAT`) — read the enum, do not hardcode. Two R32UI attachments are 37.3 MB at
  2880×1620 against 74.6 MB for the rejected single `RGBA32UI`.
* Payload: `id = (layerIndex + 1) << 25 | kindBit << 24 | (gmshElementNumber & 0x00FFFFFF)`.
  **0 means miss** — hence the zero clear. `kindBit` is 0 for a triangle and 1 for a tet (cut caps), which is
  what sources `PickResult.elementKind`; `'slice'` comes from the layer's kind. Layer index gets 7 bits.
  The element field is a **Gmsh element number**, not an internal index, and Gmsh numbers a mesh's tris
  **and** tets in one sequence, so the budget is the combined count — `ernie-seeg.msh` reaches 15,787,627,
  i.e. 94 % of the 16,777,215 cap. A mesh whose largest element number exceeds the cap falls back to per-tag
  pick ids and reports the tag only; that is the trigger, never a tet count.
* **Depth is read from a second colour attachment, never from the depth attachment.** WebGL2 restricts
  `readPixels` to RGBA / RGBA_INTEGER and the implementation-defined format; `DEPTH_COMPONENT` is not a legal
  read format. `COLOR_ATTACHMENT1` is written as `floatBitsToUint(gl_FragCoord.z)`. The engine keeps the
  `viewProj` used by the pick draw and unprojects with it:
  `world = inverse(viewProj) · (2(px+0.5)/w − 1, 2(py+0.5)/h − 1, 2z − 1, 1)`. At near = 1 mm, far = 1000 mm,
  z_eye = 500 mm the float32 window-z quantum reconstructs to ~0.008 mm — three orders below the 1 mm voxel,
  so no world-position attachment is needed.
* **Element ids come from a per-vertex `uint` attribute.** WebGL2 has no `gl_PrimitiveID`. Cut caps and
  flat-shaded field geometry are already de-indexed and carry `ownerElm`; indexed tag-surface draws use a
  de-indexed pick-only VAO with `gl_VertexID / 3`.
* The pick pass reproduces **every** discard of the main pass: the up-to-6 clip planes (same enable set),
  §7.3 threshold/label discards, the isolation `BitMask`, and face culling. Otherwise double-click lands on
  geometry the user cannot see.
* Pick only layers with `visible && pickable && opacity >= pickOpacityMin` (default 0.25), depth-tested,
  nearest wins. Volume slice quads participate (`elementKind: 'slice'`, `elementId` = plane index) —
  double-clicking a slice plane in the 3D view is the primary Freeview gesture.
* **2D views use no GPU pick**: cursor = pointer ray ∩ that view's derived slice plane, on the CPU.
* Cost: `gl.scissor` a 9×9 rect around the pointer with the *unmodified* projection, then a 9×9 `readPixels`;
  resolve by taking the nearest non-zero id within a 3–5 px radius. The sync stall is on demand and outside
  the §9 frame budget. The pick target is cached and invalidated on camera/scene change.

### 7.3 Volume slice shader

**Slice geometry is owned by the plane, not by any volume.** For each slice plane the engine builds exactly
one quad in the `(right, up)` basis, centred on the cursor's projection and sized to the **scene**
bounding-sphere radius; every volume layer on that plane is drawn from that same VAO through the same vertex
shader, with per-volume extent handled in the fragment shader. Two coplanar quads with different vertex data
do **not** produce identical interpolated depth — measured 1.6 %–11.8 % overlay-pixel dropout on ANGLE/Metal
at scene scale — so identical geometry is the correctness mechanism, not an optimisation. All slice vertex
shaders declare `invariant gl_Position;`.

* **2D views:** `DEPTH_TEST` disabled for the whole slice-layer pass; compositing order is layer order
  (bottom→top) with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` — **across kinds**: a mesh layer's 2D fill is one
  more sheet in that order, interleaved with the volume slices by `render/renderer.ts`, so the layer the
  panel shows on top is on top of the picture. Contours and points sit above every sheet (§7.4).
* **3D views (`showIn3D`):** `DEPTH_TEST` on, `depthFunc(LEQUAL)`, `depthMask(true)` for every slice layer of
  that plane. Shared geometry + shared vertex shader ⇒ bit-identical depth ⇒ LEQUAL passes for all layers.
  **Do not use a separate full-plane depth prepass** — it would occlude meshes behind the plane where no
  volume layer draws. Additionally discard fragments outside the owning layer's world AABB so `showIn3D`
  planes terminate at the data.
* **One draw per (layer, plane).** There is no single-pass N-layer shader: ESSL 3.00 forbids indexing a
  sampler array with anything but a constant expression; layers need heterogeneous sampler types (`sampler3D`
  scalars vs `usampler3D` labels) and per-layer filtering; `MAX_TEXTURE_IMAGE_UNITS = 16` caps single-pass at
  ~14 layers; and perf is a wash (3 layers: 1.10 ms single-pass vs 1.04 ms three draws).
* Fragment: `voxel = inverseAffine · world`, `texcoord = (voxel + 0.5)/dims`; `sampler3D` (trilinear) for
  scalars, `usampler3D` (nearest) for labels; `v = raw·scale + offset`; window/threshold/colormap through a
  256×1 RGBA8 LUT (512×1 signed when `scale.negative === 'separate'`); `discard` outside `[0,1]³`, outside
  `visibleLabels`, and below threshold; symmetric thresholds compare `|v|`. The threshold ramp uses
  `Threshold.softEdge`, §4.2's definition verbatim, so
  `alpha = smoothstep(lo, lo + softEdge*(hi-lo), v)` on the low edge and its mirror on the high edge — a
  fraction of the scalar range, not a count of histogram bins.
* **Label outlines — normative formula.** Let `duv = (inverseAffine · dFdx(worldPos)) / dims` and
  `dvv = (inverseAffine · dFdy(worldPos)) / dims` (the texture-space extent of one screen pixel). Sample the
  label at `texcoord ± 0.5 · outlineWidthPx · duv` and `± 0.5 · outlineWidthPx · dvv`, clamped to `[0,1]³`;
  a fragment whose centre label differs from any tap is outline. The drawn band is then `outlineWidthPx`
  wide — the `0.5` is because both sides of the boundary are flagged. **4 taps. Do not re-derive the step
  from voxel size.**
  The step is screen-relative on purpose: it keeps the outline a constant screen width at any zoom and stays
  correct on `showIn3D` planes under perspective. Simulated across 0.05 → 10 mm/px, **0 of 12,663 / 38,744 /
  46,602 / 19,332 / 7,099 / 1,706 / 554 fill-boundary pixels were uncovered**. The voxel-space step yields a
  **12.87 px** band at 0.05 mm/px — a 13× regression — and cannot recover a distance from 4 binary taps
  anyway. 8 taps buy nothing: 2.00 px axis-aligned / 2.69 px at 45° with 4 taps vs 2.00 / 2.76 with 8, at
  12 % more slice-composite cost.
* **Label texture path:** labels upload as a **dense index remap** (cap 65535) in R8UI/R16UI with an
  `N×1 RGBA8` palette, `usampler3D`, NEAREST forced. Outline detection compares dense indices; the info panel
  maps back to the original id.
* **Upload:** `texStorage3D` + per-z-slab `texSubImage3D` (slabs ≤ 32 MB, yielding between slabs) for any
  texture over ~64 MB, which also renders progressively. This is a load-time hitch, not an interactive one,
  so **do not build a per-frame upload budget scheduler**. The justification for the format ladder is
  filterability and VRAM, not upload milliseconds.

### 7.4 Mesh shaders

* **Two geometry variants per mesh layer, both built in the worker:**
  * **indexed (default, always built):** one shared vertex buffer — `position`, smooth `normal`, optional
    per-node `scalar` — plus one index buffer, drawn as one sub-range per tag with the tag colour as a
    **uniform**. Covers `colorMode: 'tag' | 'solid'` and `field.source === 'node'`. `tagStyle[tag].visible`
    becomes skipping a sub-draw (free).
    **There is no per-vertex `tag` attribute**: 1,048,599 of ernie's 1,177,213 interface faces are shared
    between two tissue tags, so a per-vertex tag is ill-defined on shared nodes.
  * **de-indexed (lazy, cached):** built in the worker on first use of `field.source === 'elm'`,
    `edges.surface`, or `colorMode: 'label'`. Attributes are **`position` + `normal` + `corner` (1 byte)**
    only, drawn with `drawArrays`; barycentric comes from `corner`, the per-face scalar from
    `texelFetch(elmFieldTex, …)` at `gl_VertexID / 3`, and the label id likewise. Switching which field or
    component is displayed is a **texture swap**, always free.
    Rejected shortcuts, so nobody re-litigates: duplicating only the provoking vertex (ES flat shading is
    last-vertex with no `glProvokingVertex`, and ANGLE has shipped provoking-vertex bugs), and a separate
    `GL_LINES` wireframe (line width is clamped to 1 px, §7.0.6).
  * Cache key `(dataset, maskId, generation, clip state)`. Isolation or clip changes invalidate both variants.
  * **UX consequence (§8):** the first toggle of `edges.surface`, the first switch to an element field, and
    the first `colorMode:'label'` on a given mask are **async loads with a progress state**, not instant
    checkboxes. They are free thereafter.
* **Clipping:** up to 6 world-space planes. Primary path is hardware `gl_ClipDistance` via
  `WEBGL_clip_cull_distance`; the `vec4`-uniform + `discard` shader is a **compile-time-selected fallback**.
  Both paths must be pixel-identical under the same goldens (`EngineOptions.forceDiscardClip` / env
  `TETRAVOX_FORCE_DISCARD_CLIP=1` is a Playwright axis, §11).
  * Sign convention is byte-for-byte §6.0's `Plane`: `gl_ClipDistance[i] = dot(plane.normal, worldPos) +
    plane.offset`, keep `>= 0`. No negation, no separate GPU convention.
  * `Program` emits **N variants keyed on the active plane count** N ∈ 0..6. At N = 0: no `#extension`, no
    redeclaration. At N > 0: `#extension GL_ANGLE_clip_cull_distance : require` (`require`, not `enable`, so
    a driver lacking it fails at compile time and trips the fallback rather than rendering unclipped) +
    `out highp float gl_ClipDistance[N];` + N **unrolled constant-index** assignments. Why specialise: on
    ANGLE/Metal each clip distance consumes one **full varying vector** out of `MAX_VARYING_VECTORS = 30`,
    so a blanket `[6]` costs 20 % of the varying budget on every mesh program forever.
  * The GL kit tracks `CLIP_DISTANCE0_WEBGL + i` as render state — it is global and survives `useProgram`.
    Reset **per pass**: opaque and transparent mesh draws enable exactly that layer's active planes; the pick
    pass enables the same set; the overlay pass disables all.
  * **Cap rule (this is the one that breaks the product):** when drawing the cap geometry generated by plane
    *i*, **disable `CLIP_DISTANCE(i)` for that draw** while leaving the others enabled. Cap vertices lie
    exactly on plane *i*; measured on ANGLE/Metal, `gl_ClipDistance == 0.0` keeps the primitive (16384/16384
    px) and `gl_ClipDistance == −1e-7` deletes it entirely (0/16384 px). CPU f32 interpolation vs
    vertex-shader recomputation straddles zero per vertex and drops cap triangles wholesale. The same applies
    to `fillIn2D` cut polygons.
* **Element edges — one mechanism, masked barycentric, for surfaces and caps alike (no extra draw call).**
  Every triangle carries a 3-bit `edgeMask`; bit *i* means "the edge opposite vertex *i* is a real element
  edge". The shader computes `d = bary / fwidth(bary)`, sets `d[i] = 1e9` for cleared bits, and shades
  `1 − smoothstep(w − 0.5, w + 0.5, min(d))` with `w = edgeWidthPx`. Cleared bits are excluded from the
  `min`, so a suppressed edge never contributes and slivers do not flood. Default mask `0b111`; when a whole
  draw is unmasked the attribute array is **disabled** and a constant vertex attribute supplied, so the
  common case costs zero memory. Corner ordinal comes from the 1-byte `corner` attribute expanded in the
  vertex shader — never three floats per vertex. **Cap edges use the same shader.** `Cut.edge_segments` is
  **not** used in the 3D passes — it exists for the 2D overlay.
* **Caps** come from `plane_cut` (exact per-element polygons), drawn with the same material
  (`capColorMode`). A cap vertex's scalar for `colorMode:'field'`: node fields live in a 2D R32F texture, and
  the vertex shader does `texelFetch` + `mix` from the `ivec2` `interpNodes` attribute plus the float
  `interpT`, so changing the displayed field costs zero re-cut. **Cap normals are the (negated) clip-plane
  normal, generated engine-side; `Cut` carries no normal buffer.**
* **Cap upload:** a pre-sized, double-buffered VBO set, written with `bufferSubData` after an orphaning
  `bufferData(null)` — never a fresh sized `bufferData` per frame. Buffers grow by doubling and never shrink
  during a drag. `plane_cut` stays **exact, always**: at ~13 ms there is no coarse-while-held proxy (it would
  add a visible pop on release and a second code path to the feature the product is judged on). Latest-wins
  (§5) is the only drag mechanism.
* **Lighting:** headlight Blinn-Phong with configurable ambient; flat shading optional; two-sided lighting.
* **Surfaces on 2D slices:** `contours` line segments drawn in the overlay pass as instanced screen-space
  quads; tet cut polygons drawn in the opaque pass with tag/field colour when `fillIn2D`.
  A **surface** layer — a triangle-only mesh, `nTets === 0`: GIfTI, FreeSurfer, STL/PLY/OBJ, OFF, `.vtp`, `.geo`
  triangles — opens with `contoursIn2D: true`, `fillIn2D: false` and `contourWidthPx: 1.5`, and takes its own
  `contourColor` from `SURFACE_CONTOUR_PALETTE` (`scene/defaults.ts`) in load order, first entry Freeview
  yellow. A tet mesh's defaults do not move: `fillIn2D: true`, width 1, no `contourColor`. Clicking within
  `CONTOUR_PICK_PX` of a drawn contour in a 2D pane makes that layer active (`Engine.contourAtScreen`, a CPU
  nearest-segment test over the same segments the frame drew — the pick pass draws no lines).
* **Winding:** any triangle set rendered with `faceMode:'cull'` or in the transparency phase split passes
  through `orient_surface` first. The engine sets `faceMode:'both'` automatically when
  `orient.openComponents > 0` — which is every tag of ernie, four of whose ten tags `orient_surface` flips.
* **Glyphs** (`GlyphSpec`): one instanced draw of a shared cone+shaft VAO with per-instance
  origin/direction/magnitude, in the opaque pass. No new geometry from WASM. Origins restricted to visible
  tags and, when a cut plane is active and `onCutPlaneOnly`, to origins within `cutSlabMm` of the layer's
  **first enabled clip plane** — the only cut plane a 3D pane has. One template per
  `(shape, headProportion)`, built on first use; `shape: 'line'` is the same template with no head.
  **Length is `GlyphScaling`** (§4.4), and the shader carries the model term for term: `fixed` → `lengthMm`;
  `linear` → `lengthMm·m/R`; `sqrt` → `lengthMm·sqrt(m/R)`; `log` → `lengthMm·log10(m/f)/log10(R/f)` and 0 at
  or below the floor `f`, where `R` is `normalizeTo`'s magnitude. Every mode sends `R` to exactly `lengthMm`,
  which is what makes the overlay **legend line** and the **glyph colour bar** (titled with the scaling) true
  statements rather than labels. `derived/glyph-scale.ts` is the single implementation; the app editor states
  the same sentence from it. **`normalizeTo` defaults to `p99`, not `max`**: on `ernie_TDCS_1_scalar.msh` the
  maximum is 57.79 V/m against a p99 of 3.846, so an electrode-gel outlier normalising the whole brain drew
  every cortical arrow at under 2 % of `lengthMm`.
  **`GlyphSpec.origins` names which of the two origin tables the instance reads, and it is a compile-time
  variant (`TVX_GLYPH_VOLUME`), never a uniform** — the two tables are indexed differently, so a runtime
  branch would cost a texture fetch per instance to decide something constant for the draw.
  * `'surface'` (the default, and what an absent field means) reads the layer's de-indexed
    `SurfacePayload`: instance *g* takes triangle `first + g·stride`, averages its three vertices, and reads
    `ownerElm` for the field row. The **restriction to visible tags is per-instance**, off the same tag-LUT
    alpha R5's hide edits, so a hidden tissue's arrows vanish with its surface.
  * `'volume'` reads §6.5.2's `meshCentroids`: one origin per **tet**, so the interior of a mesh gets glyphs
    at all. Points, not geometry, so "no new geometry from WASM" holds. Here the **restriction to visible
    tags is per-request**: the op's `tags` argument carries the visible **tet** tags (tri tags are excluded —
    `tags` is an allow-list over tet tags, so a tri tag is dead weight at best and, where a mesh numbers a
    tri tag the same as a tet tag, re-admits a tissue the user hid), and `subsample` becomes the op's own
    `stride`. Every tet tag hidden is an **empty request the engine does not make**: an absent `tags` means
    "no filter" to the op, so the draw is skipped instead.

### 7.5 Views & interaction

Layouts: `1x1`, `1x3`, `1x3-horizontal`, `2x2`, `3d-only`, `1+3`, `3d+1`; `mosaic` is out of scope.

**The app's catalogue is a subset: every layout it offers contains the 3D pane.** The toolbar and the `x`
cycle offer `2x2`, `1+3`, `3d+1` and `3d-only`, in that order, and a scene naming a removed layout is
**migrated on load**: `1x1 → 3d+1`, `1x3` / `1x3-horizontal` → `1+3`. The cells are recomputed, never
carried, and the 3D pane leads in both new layouts. The kinds themselves stay in `LayoutKind` deliberately:
§11's single-pane pixel harnesses set `{kind:'1x1', cells:['axial']}` in some thirty specs, and an analytic
assertion on one pane is not something a viewer catalogue has any business breaking. This is a **catalogue**
change, not a view-model one — which is why a saved scene meets `migrateLayoutKind` rather than a parse error.

Every view has its own camera. 2D cameras are orthographic, pan/zoom only — **orientation comes from the
view's `{normal, up}`**, and in-plane rotation is `up` rotated about `normal` (there is no separate roll:
that would be a second source of truth). 3D camera: orbit (arcball) / pan / dolly, `fit()` to scene bounds,
presets (A/P/L/R/S/I), orthographic toggle.

**Slice stepping, defined once so it needs no rewrite for oblique:**
`step_mm = max over voxel axes a of |dot(normal, A[:,a])|`, where `A` is the 3×3 of the topmost visible
volume layer's affine (this reduces to voxel spacing for canonical views on an axis-aligned volume). Fall
back to `min(spacing)` of any volume, else **1 mm (configurable)** for mesh-only scenes — never
`bboxDiagonal / 256`, which made one wheel notch mean a different distance per file (1.32 mm on `ernie.msh`,
0.53 mm on `lh.central.gii`) for a gesture whose whole purpose is to sweep at a predictable rate. Wheel /
PgUp / PgDn do `cursor += normal · step · k`, then **snap the cursor's along-normal component to the nearest
voxel plane** of that layer to stop drift over repeated steps. Stepping never requires a volume: with a mesh
alone the scene bounds come from the meshes and the wheel sweeps the mesh's cross-section (R4).

**The arrows and PgUp/PgDn are two different steps, and the snap is per direction.** PgUp/PgDn and the wheel
step along the plane **normal**. The **arrows nudge the cursor in the plane**:
`cursor += right · step_right · dx + up · step_up · dy`, where `right`/`up` are
`sliceBasis(view, radiological)` — so pressing → moves the crosshair toward screen-right in either
convention, and one press lands exactly where a one-`step_mm` drag to the right lands. Each axis takes
`step_mm` computed for its own direction and is snapped onto the voxel grid **along that direction alone**,
never by rounding all three voxel indices: rounding drags the cursor sideways to the nearest voxel centre,
which is a movement the user did not ask for. This is `Engine.nudgeCursor` (§4.7).

Input (Freeview-like):
* **2D** — left-click/drag sets the cursor, and a click that lands on a surface **contour** also makes that
  surface the active layer (`contourAtScreen`, §7.4); wheel = slice ±1 (⌘/Ctrl+wheel = zoom); right-drag =
  window/level on the **active** layer, falling back to the topmost non-label volume layer; middle/space-drag
  = pan; arrows nudge the cursor; PgUp/PgDn slice.
* **3D** — left orbit, right pan, wheel dolly, double-click = `setCursorFromPick`.
* **`Shift`+drag is the active layer's opacity in every pane** — it is a layer gesture, not a camera one.
* **Left-drag never pans** (R3). Pan is middle-drag, `space`+left-drag, or a two-finger trackpad drag —
  which arrives as a `wheel` event with a non-zero `deltaX`, the one honest discriminator against a mouse
  wheel.
* **Zoom is per pane, about the pointer** (R2): `⌘/Ctrl+wheel` — and a trackpad pinch, which Chromium
  delivers as a `wheel` with `ctrlKey: true` — hold the world point under the pointer fixed; `+` / `-` do the
  same about the pane centre; `r`, and `Alt`+double-click on a 2D pane, reset to fit. `mmPerPx` is clamped to
  **[0.05, 20]**, one notch is a factor of 1.2, and the keys act on the pane **under the pointer**.
* The pane a drag belongs to is **latched at `pointerdown`** and held by a pointer capture, so a drag that
  leaves the pane — or the window — keeps driving the pane it started in.
* **Measure mode** (`m`, and §8's toolbar button). While it is on, a left-click **places a measurement
  point** instead of setting the cursor — in a 2D pane the pointer ray ∩ that pane's derived plane, in the 3D
  pane the §7.2.3 `pick`, so a click on nothing in 3D places nothing rather than inventing a point on the
  near plane. The grammar is three clicks: the first starts the gesture and draws a lone marker, the second
  completes a `'distance'`, and the third **extends that same measurement into an `'angle'`** whose vertex is
  the shared endpoint the second click placed. It stays one measurement throughout, so §8's row changes from
  millimetres to degrees rather than a stray segment being left behind; a fourth click starts a new gesture.
  `Esc` — and leaving the mode — drops whatever is pending and touches nothing already placed. The mode is
  engine state and the half-placed gesture rides on `DrawInput`, never on `Scene`: a `*.tetravox.json` must
  not carry one.
* **The point tool** (§13, `Engine.setPointTool`; an extension arms it, and no core toolbar button does).
  While it is armed a left click is the tool's, in the `#onDown` precedence slot **after measure mode and
  before the gizmo** — the same argument that put measure mode ahead of the gizmo, so a contact in the 3D pane
  is not eaten by a handle the pointer happens to be over. **At most one click-consuming mode is armed**:
  arming the point tool disarms measure mode and `setMeasureMode(true)` disarms the point tool, because a user
  cannot be told which mode a click went to.
  * **The tool is only offered the presses §7.5 does not already bind** (`input/gestures.ts`'s
    `pointToolTakesPress`, 2026-08-30). A left press carrying `Shift`, `space` or a platform modifier
    (`⌘`/`Ctrl`), and **any** press that lands while a gesture is already in flight, never reaches the tool at
    all — in either mode. `Shift`+drag is still the active layer's opacity, `space`+drag is still the pan, a
    `⌘`+click is still not a drag, and a second finger landing mid-drag still ends the drag it interrupted
    rather than grabbing whatever it touched. Gating the *press* and not only the *gesture* is the point: the
    tool's press already selected a contact, moved the crosshair and re-cut three panes before
    `resolveGesture` was ever asked. `Alt` is not reserved by §7.5 and is not gated. **Measure mode is
    deliberately not gated this way**: it is stated above as "while it is on, a left-click places a
    measurement point", without qualification, and narrowing it would be a behaviour change rather than a
    repair.
  * **`place`: every unmodified left click places**, with no hit test first — 2D on the pointer ray ∩ the
    pane's derived plane, 3D on the §7.2.3 `pick`, where a click on nothing places nothing and is still
    swallowed. Contacts
    sit about five pixels apart at a default zoom, and the click that matters most is the one filling the gap
    *between* two that were found; a hit-first rule would answer it by selecting a neighbour. The point is
    `{ ...template, id: 'p<n>', position }`, it becomes the selection, and one `placed` event says so.
  * **`select`: a press hits, and an *on-slice* hit starts a drag.** The rule is within
    `max(disc px, 8 px)` of the disc the pane actually drew, nearest wins; in the 3D
    pane the nearest projected centre within 14 px, and **no drag** in v1. The disc radius is
    `overlay/point-ring.ts`'s `discRadiusPx` — the same function §7.2 sizes the selection ring with, so the
    hit rule cannot drift away from the picture, exactly as `gizmoHandleAt` shares `handlePoints` with the
    gizmo it draws. **Every one of those pixel numbers is a device pixel**, and `Camera2D.mmPerPx` is
    millimetres per device pixel, so a world radius reaches the screen as `radiusMm / mmPerPx` and is
    **not** scaled by `uiScale` again — only the `dot` branch's radius is, because
    `uDotPx = dotRadiusPxOf(layer) · uiScale` is the one authored in CSS pixels (2026-08-30). That radius is
    §4.4's `dotRadiusPx` (absent = 4) and the hit test takes the **layer's** value, so a marker the user made
    bigger is a bigger target: one function, `dotRadiusPxOf`, feeds the shader uniform, the ring and this
    rule. The `8 px` and `14 px` floors stay device pixels deliberately, the same convention as the gizmo's
    `HANDLE_HIT_PX`: the frame's grabbable things use one unit.
  * **A ghost the layer *draws* is hit, and the hit SELECTS without grabbing** (2026-08-30). Until then the
    rule was on-slice only — the disc test was asked with `offPlaneOpacity: 0`, so a point the slice does not
    cut was not hittable at all. Measured on a fifteen-shaft implant with `offPlaneOpacity: 0.6`, that is
    **eighty-two contacts drawn on a slice and about two of them clickable**: every other press fell through
    to R1's cursor-set, which never hit-tests, and reads as "the selection does not update". So `pointAtPane`
    now asks `discRadiusPx` **twice** — once with the ghost off, and, for the points that answers `null` for,
    once with the layer's own `offPlaneOpacity` — and reports which branch answered. The rules that decide it:
    * **only when the layer draws them.** The second branch is entered for `offPlaneOpacity > 0` and nothing
      else, so with ghosting off this test answers exactly what it answered before the branch existed.
      Nothing invisible is grabbable.
    * **the ghost's clickable disc is its FULL drawn radius** `r` — the same number `discRadiusPx` gives the
      shader and the selection ring — under the same `max(disc, 8 px)` floor. One rule, one function, one
      picture.
    * **an on-slice hit beats any ghost at the same pixel**, before distance is compared and across layers as
      well as within one; among ghosts, nearest projected centre wins. A contact the pane really cuts is the
      one the user is looking at.
    * **no drag, ever.** `Engine.pointToolDown` answers `'consumed'` for a ghost hit: the press is the tool's,
      the point becomes the selection, and **no `'point'` gesture starts and no `pointDrag` is taken**. This
      is the surviving half of the old rule and the reason it existed — an off-slice contact has no honest
      plane to be dragged in, and dragging one would move a contact the user cannot see. A host that jumps the
      cursor onto its selection (§13.3's contact extensions do) brings the slice to the contact, and the next
      press on it is an ordinary on-slice grab.
    * **and therefore no `dragEnd`.** A `select`-mode click emits `selected` + `dragEnd` when it grabbed, and
      `selected` **alone** when it hit a ghost. `dragEnd` means "a drag ended", and emitting a zero-length one
      for a gesture that never began would have made it mean "a press landed" — after which every host that
      compares positions at `dragEnd` would be doing so for presses that cannot have moved anything. The
      asymmetry is stated in `api.ts`'s `PointToolEvent` as well as here, because a contract's surprises
      belong in the contract.
  * **The drag is `GestureKind 'point'`**, resolved in `resolveGesture`'s **2D** branch after the ctrl/meta
    and `Shift` tests and before the `space` one, so `Shift`+drag over a contact is still the layer's opacity
    and `space`+drag is still the pan. Each move writes `paneToWorld` into a **replaced** `points` array.
    The gesture's `end` is forwarded to the tool from **all three exits** — `#onUp`, `#onCancel`
    (`pointercancel`, and the window `blur` bound to it) and the second-pointer branch of `down()` — and
    becomes exactly one `dragEnd`, which is what makes one drag one undo step and one dirty mark for the host.
    **A plain click on an on-slice point is a zero-length drag and emits one too**: such a click grabs the
    point under it, so clicking through contacts produces `selected`, `dragEnd`, `selected`, `dragEnd`, …
    (a click on a ghost grabs nothing and emits `selected` alone, above.) "One drag is
    one undo step" is therefore not "every `dragEnd` is an undo step" — a host compares positions against
    the snapshot it took at `selected` and commits only what moved. The engine does not suppress the event:
    the grab really did happen, a host may want it, and a silent exception in a frozen contract is worse
    than a stated one (2026-08-30).
  * **`Esc` is `place` → `select` → off**, in the engine's own keydown beside `cancelMeasurement`'s and before
    the "is the pointer over a pane" test, because the app's `keymap.ts` answers `Escape` unconditionally and
    "core first, extension on null" could never deliver it here. **A disarm that lands mid-drag commits the drag
    first** (2026-08-30): `setPointTool(null)` — whether it came from `Esc` with the button still down or from
    an extension — emits that drag's `dragEnd`, at the position the drag reached, *before* `cleared`. `Esc`
    cannot be gated on "is a gesture running" without ceasing to be the mode key, so the only two honest
    exits are commit and revert; commit is chosen because it makes `Esc` mean what `pointerup` means and keeps
    "one drag is one undo step" true however the drag ended. The scene has already moved by then — every
    intermediate position was written into the layer — so dropping the drag left an edit with no commit
    point: no undo entry, no dirty mark, nothing for the discard guard to ask about.
  * **A `cleared` event says why** (`PointToolEvent.reason`, 2026-08-30): `'esc'`, `'measure'`, `'load'`,
    `'layer'`, `'host'` (an explicit `setPointTool(null)`, and what absent means) or `'selection'` — the last
    of which is not a disarm at all, only `setPointSelection(null)` or a `points` replacement that lost the
    selected id. Six causes shared one event, and a host that re-arms has to tell them apart: re-arming after
    `'measure'` would turn measure mode straight back off, because arming the point tool disarms it, so `m`
    would do nothing at all while such an extension was active. The reason is which of the engine's own routes
    ran and not something a caller supplies, which is why `setPointTool(null)` stays a one-argument member.
  * **Hover** runs the same hit test per 2D move, **only while `select` is armed**, and sets
    `DrawInput.pointHot` and the canvas cursor (`grab` over a point, `crosshair` in `place` mode). The *same*
    test, so a drawn ghost is hot and shows `grab` too: the picture must not say "not clickable" about a
    press that selects. A user who
    is not editing points pays one property read per move, so §8's 16 ms hover budget is untouched.
* Keys: `r` reset view, `1..6` presets, `c` toggle crosshair, `x` cycle layout, `o` orthographic, `m`
  measure, `Esc` cancel a measurement, `[`/`]` cycle the active layer, `v` toggle its visibility,
  `Shift+drag` its opacity, `Ctrl+↑/↓` reorder it, `,`/`.` step the active volume layer's 4D index (each step
  is a `volumeFrame` op, so the read-out, the colour bar and the histogram all follow the new `Stats`).
* Cut plane: sliders (normal preset + free normal + offset) and a draggable gizmo.

### 7.6 Colormaps and LUTs

* Continuous colormaps are a **256×1 RGBA8** texture baked on the CPU from `Scale`. `kind:'heat'`
  (min/mid/max, `truncate`, `inverse`) costs nothing extra in the shader — it is a different bake.
  `negative:'separate'` bakes a **512×1** signed LUT with a dead band around zero; `negative:'mirror'`
  mirrors the positive branch; `negative:'hide'` discards. `bwr`/`coolwarm` centre at 0 when
  `threshold.symmetric`.
* User colormaps: a `.json` array of RGB stops, registered by id.
* **Label LUTs are a separate path** — a 256×1 texture cannot address FreeSurfer/`.annot` ids. See §7.3's
  dense index remap + `N×1 RGBA8` palette.
* LUT parsers: FreeSurfer `FreeSurferColorLUT.txt`, SimNIBS `*_LUT.txt`, ITK-SNAP label description, and a
  generic `id r g b [a] [name]` fallback. Auto-associate `<volume>_LUT.txt` or `<volume>.txt` next to the
  volume; otherwise a deterministic glasbey-like palette.
* **The default mesh tag palette must cover the electrode/gel ranges.** A SimNIBS TDCS mesh carries tri tags
  1101/1102/1501/1502/2101/2102 and tet tags 101/102/501/502 on top of the ten tissue tags, and the SEEG
  meshes add tri 1013–1016 / tet 13–16. A viewer colouring only 1–10 / 1001–1010 renders every electrode and
  gel layer as untagged grey. Tags are **not** contiguous — tag 4 is absent from ernie.
* `<mesh>.msh.opt` seeds tag colours/visibility, field range, colormap and colorbar on open, with a
  "defaults from X.msh.opt" chip and a one-click Reset.

---

## 8. App (Electron) — UX contract

**Everything the UI can do must be reachable from the `Engine` API alone. No logic in React.**

**Regions.** **Left**: layer panel (ordered list, per-row disclosure, eye, opacity slider, per-kind property
editor, 1 px accent border on the active layer, per-dataset **load card** with phase + percent + elapsed +
Cancel). **Centre**: view grid (coloured border on the active view pane). **Right**, top to bottom in this
order: coordinate bar, the `.msh.opt` defaults chip (§7.6), measurements panel, **extension panel — one active
extension at a time (§13)** — and the info panel. **Top**: toolbar — the `Tetravox` menu (Open…, Sample data…,
New, Open scene…, Save, Save as…) and the scene's name in the left column; layout, radiological toggle,
Reset, crosshair, colour bars, measure mode, scale bar, orientation cube and screenshot in the centre; the
**extension switcher**, the keyboard sheet (`?`) and settings (`⚙`) in the right column. **Status bar** along
the bottom, with each active extension's cell **before** the per-dataset cells.

The theme is **not** a toolbar control: `system`/`light`/`dark` live in the settings dialog's Appearance tab
(directed task: toolbar consolidation, 2026-08-28), so `⚙` is the single home for every standing preference
and stays the right-most control on the rail however many toggles are added to its left.

**2D view chrome — a laterality-safety requirement, not decoration:**
* Orientation letters `L/R/A/P/S/I` on all four edges of every 2D view, **derived from the affine and the
  radiological flag**, never hardcoded per pane.
* Corner annotation: view name, slice index of the active volume layer, world RAS of the plane.
* A persistent `RAD` / `NEU` badge (`Annotations.conventionBadge` is not optional).
* A **scale bar**, bottom-right, snapped to `1 / 2 / 5 / 10 / 20 / 50 / 100 mm` and labelled in millimetres.
  Same argument as the letters: `ZOOM 1.42X` is a ratio to a fit the reader of a saved PNG never saw, so
  without the bar a lesion measured off a screenshot is measured in pixels.
* All of these appear in **every** Playwright golden, so a regression that drops them fails CI (§11).

**3D view chrome:** the same edge letters and corner info, plus an **orientation cube** in the bottom-right —
six shaded faces labelled `A/P/L/R/S/I`, turning with the camera; clicking one snaps to that preset. The edge
letters say which way is up at the edges; the cube says which way the head is *facing* once the camera has
left a preset. `scene/defaults.ts` keeps the bar and the cube **off** — an engine default may not move §11's
goldens — and the app turns both on for its own scene at attach, exactly as it does the colour bars.

**Info panel** is split into two blocks with identical row structure: `Cursor` (last click, persistent) and
`Mouse` (live, blank when the pointer leaves a view). Rows carry per-layer voxel index / value / label name /
element id / tag name / field values. Volume values resolve on the UI thread from the retained typed array
(zero latency); mesh element probes go through the `locate` op as latest-wins on its own key so a hover never
queues behind a cut. Targets: **volume hover ≤ 16 ms, mesh hover ≤ 50 ms.**
**Every value carries its space.** The world triple beside each block heading is labelled `RAS`;
`tkr-RAS · <volume>`, `MNI (affine)` and `MNI (nonlinear)` get their own labelled lines. A mesh row adds
`vertex <index> · RAS <x y z>` — the nearest node's index and **its own** coordinate, not the probe point —
and a row labelled with the fsaverage surface when a correspondence has been built.

**Coordinate bar** above the info panel: editable `x y z` with a space selector, Enter jumps the cursor, a
copy button yields `-42.0 18.0 6.0`, paste accepts comma- or space-separated triples. The selector is
`Engine.coordinateSpaces()` (§3), not a fixed list: `World RAS`, then `Voxel · <name>` and
`tkr-RAS · <name>` **per loaded volume**, then `MNI152 (affine)` and `MNI152 (nonlinear)` as **two separate
entries** — they are two different numbers and a reader has to be able to say which one they wrote down.
A space that cannot be used is **listed, disabled, with the reason on it** — never hidden ("this subject has
no `MNI2conform_*DOF` affine — SimNIBS 4 writes only the warp", "loading `Conform2MNI_nonl.nii.gz`…"). The
warps are loaded **on demand**, the first time the nonlinear space is selected. Copy yields the triple **in
the selected space**, and Enter converts back through `Engine.fromSpace`. Under the field, every *derived*
space is shown at once, each labelled, so none of them needs a click.

**Measurements panel** (above the info panel): one row per `Scene.measurement` — name, value, a **jump-to**
and a **delete**. A strip rather than an editor, because a measurement is a note, not a layer. Jump-to puts
the cursor on the segment's midpoint (an angle's **vertex**), which is all it takes for every 2D pane to
arrive at it together. The value is formatted by the **engine**'s `formatMeasurementHtml`, the same
arithmetic the overlay label comes from: two answers to "how long is it" is the one failure a measurement
tool cannot have. The panel renders nothing while the mode is off and nothing has been placed.

**Colour bars** (required in screenshots): one per visible scalar layer — colormap, numeric ticks at the
scale endpoints and at `mid` for heat, the threshold cut drawn as a notch, the field name, and units from
`Field.units`. Per-layer `showColorbar`, position right/bottom.

**Histogram widget** in the volume and mesh-field property editors: log-y toggle, draggable window and
threshold handles, the current colormap painted along the x axis, and presets `min–max`, `2–98 %`,
`p50–p99.9`, `symmetric ±p99`.

**Region panel** for label volumes, mesh tissue tags and `.annot` layers: search-as-you-type over the
`LabelTable`, per-row eye + colour swatch + count, `Alt+click` to solo, double-click to jump the cursor to
that region's centroid (`labelCentroids` / `meshCentroids`). The same selection wires into
`MeshLayer.isolate.labelVolume.labels`. A mesh's editor is a **tissue table** — name from `$PhysicalNames`,
colour swatch, eye, opacity slider — not a list of checkboxes, backed by `tagStyle`.

**Themes.** `system` / `light` / `dark`, persisted by main in `settings.json` under `userData` (**not**
`localStorage`: every E2E launch gets a fresh `--user-data-dir`, so a preference kept in the profile could
never be tested across a relaunch). `system` follows `prefers-color-scheme` live, and only while it is the
choice. `applyTheme()` stamps `data-theme` and `color-scheme` on `<html>`; every override in `index.css`
keys off that attribute, so the whole window re-themes with no reload and no remount. Main reads the same
file to pick `BrowserWindow.backgroundColor`, so a light-theme launch does not open on a black rectangle.
The engine's chrome is themed separately through `Engine.setTheme` (§4.7), called in the same tick as the DOM
flip. **The view panes stay dark in both themes** — imaging convention: a light viewport changes what a
greyscale T1 and a heat overlay look like — so the overlay palette is keyed off **the pane**, never off the
theme name. One source of truth for the tokens: `renderer/src/theme/tokens.ts`, with
`theme/tokens.test.ts` parsing `index.css` and `main/index.ts` and failing if a hex was edited in only one
place.

**Settings dialog** (`⚙`): preferences for the *machine*, not for the scene, persisted by `main/settings.ts`.
The **FreeSurfer subjects directory** (typed or browsed) is what turns the fsaverage row on; setting it
re-attaches every surface already open, and clearing it drops every correspondence. `coercePatch` exists
because a patch is not a settings object: filling a patch's absent fields with defaults before merging would
silently reset the user's theme every time they set the directory. *Scenes ▸ reopen last scene on launch*
lives here too, off by default.

**Open**: menu / ⌘O / drag-and-drop / CLI args. Drag-and-drop uses `webUtils.getPathForFile` exposed through
the preload as `getDroppedFilePath(file)`; when it returns empty the renderer posts the `File` object itself
to the worker as **`LoadSource.kind: 'file'`** — a `File` is structured-cloneable, so `postMessage` costs
nothing and the renderer never allocates the bytes. **The renderer must never call `file.arrayBuffer()`**:
that is a 492 MB allocation on the thread §5 rule 3 forbids from seeing raw file bytes. The *worker* calls
`file.stream()` / `file.arrayBuffer()`. (`kind: 'bytes'` exists for tests and for a caller that already holds
bytes; it is not the drop path.) File associations are registered by the installer.

**Scene save/load**: `*.tetravox.json` (`ViewSpec`, §4.6). **⌘S** saves — a sheet the first time, defaulting
to `<the first dataset's directory>/<name>.tetravox.json`, in place afterwards; **⇧⌘S** is Save As; the title
bar carries the scene's name and a `•` while it is dirty; **File ▸ Open Recent** lists the last ten. A scene
reaches the app by **every** door a dataset does — a drop, ⌘O, argv, `open-file` from a double-click, a
second instance. `main/menu.ts` splits scenes from datasets on the way in, so the renderer never sniffs a
filename. `docs/USER_GUIDE.md` is the user-facing half.

**Asking before losing work.** `DialogKind` carries a `confirm` case: a promise-resolving question with two
or three buttons, raised by the extension host (`host.ui.confirm`, §13.1) and by the shell's own discard guard.
The **last** button is always the cancelling one, so Escape and a backdrop click — which `DialogFrame` already
routes to `onCancel` — are the same answer as pressing it. The guard runs at every place where work would
otherwise be thrown away without a word: **New**, opening a scene (which is also File ▸ Open Recent and the
drop route, since all three arrive at `openScenePath`), a layer row's **✕**, which closes the dataset an
extension's layers hang off, and **opening another file an extension claims** — an extension's `openPath` replaces what
it is editing and clears its own history, so the reader route (§13.1's `onReader`) is as destructive as New
and asks the same question; cancelling there reports the path as *claimed*, because falling through to the
ordinary dataset load would try an electrodes table as a mesh. An extension's own Open sheet asks for itself,
through `host.ui.confirm`, since the shell never sees that gesture. It is keyed on `UiState.moduleDirty`,
**never** on `sceneDirty`: `sceneDirty` is set
by any cursor click and is deliberately conservative, so it cannot mean "this work is unsaved". The window
title's `•` is the OR of the two. `⌘S` saves the *scene*; while an extension has unsaved work it also says so,
because an extension writes its own files from its own panel.

**Screenshot**: `screenshot(opts: ScreenshotOptions)` (§4.7) → PNG with the DPI written into the pHYs chunk.
The same path is exposed headlessly by the **automation surface** (`docs/AUTOMATION.md`):
`Tetravox --job job.json --out DIR [--quiet]`, running this engine in an offscreen Electron window. It is a
job *file* rather than a flag-per-option CLI — a scene plus an ordered list of `set` / `screenshot` /
`sweep` / `orbit` / `tween` actions — because the ask includes videos and slice sweeps, and because six
figures from six invocations would parse a 184 MB mesh six times. The single-shot case is the one-action job.

**Status bar**: `Capabilities.renderer`; **fps** = frames drawn in the last second (0 when idle is correct
under render-on-demand); **frame ms** = median CPU frame time over the last 30 rendered frames; **GPU ms**
separately when `caps.timerQuery`; the current `QualityLevel` when below full; **estimated** GPU memory (a
sum of our own allocations — WebGL2 has no memory-query extension); last load time and wasm `heapBytes` per
dataset.

---

## 9. Performance & memory budgets

Measured figures live in `docs/BENCHMARKS.md`. This section is the **bars** those figures are read against.
Reference machines: `A` = Apple M1 Pro (16-core GPU), 1440p logical, DPR 2, ANGLE/Metal. `B` = Intel UHD 620
/ Mesa, 1080p, DPR 1 (the low bar). Figures quoted from an M2 Max are *headroom evidence*, not machine-`A`
targets.

### 9.1 Throughput

| # | Metric | Target |
|---|---|---|
| 1 | Load `T1.nii.gz` (float32, 256×256×208) to first frame | < 400 ms (A) |
| 2 | Load `tissue_labeling_upsampled.nii.gz` (uint16, 512×512×416) and slice it | < 1.2 s to first frame (A) |
| 3 | Parse `ernie.msh` (184 MB; 847,165 nodes; 1,177,213 tris; 4,722,625 tets) | < 1.5 s native, < 3 s WASM |
| 4 | `ernie.msh` → first frame with tag surfaces | < 1 s after parse |
| 5 | `Thalamus_TI.msh` (255 MB, one elm field) to first frame with the field coloured | < 5 s (A) |
| 6 | `ernie_seeg.msh` (492 MB; 13,033,527 tets) — declared worst case | < 9 s (A), progress visible within 200 ms, cancel (= `worker.terminate()`) honoured within 500 ms |
| 7 | `flex_*_TI.msh` (397 MB) and `ernie_TDCS_1_scalar.msh` (420 MB, `E` vec3 + `magnE` over 5,900,498 elements) | same class as #6; the TDCS file is the only reference file that exercises vector glyphs and `component: 0\|1\|2` |
| 8 | `morton_reorder` on ernie, WASM | < 250 ms |
| 9 | `build_tet_blocks` on ernie, WASM | < 500 ms |
| 10 | `plane_cut` on ernie, indexed, mid-axial and oblique, WASM | < 15 ms canonical, < 30 ms oblique |
| 11 | Cut-plane drag, worker → transfer → VBO → present, 2×DPR | ≥ 30 fps sustained, full-quality frame within 250 ms of release, < 40 ms input-to-photon, on **A and B** |
| 12 | Orbit ernie tag surfaces, 2×DPR 1440p | 60 fps (≤ 8 ms) at full quality (A); adaptive ladder on B |
| 13 | 6 active clip planes, ernie tag surfaces, 2×DPR 1440p | ≤ 12 ms (A); `scripts/bench.ts` reports **both** clip paths |
| 14 | Slice scrub, T1 + 2 overlays + label outlines | 60 fps at full quality |
| 15 | Slice scrub with T1 + a 5.9 M-element mesh `fillIn2D` + contours | 30 fps, cut latency < 25 ms |
| 16 | First `edges.surface` / element-field build on ernie | < 250 ms, progress shown |
| 17 | `isolate` mask evaluation alone on ernie (4.7 M tets → `BitMask`) | < 100 ms |
| 17b | **Everything the UI waits for after an isolation change**: `isolate` + `extract_boundary` over the survivors + de-index when a de-indexed variant is live | scaled from #19 plus #16. Isolating ernie's GM leaves 1,340,029 tets — row 19's workload — so **< 1.5 s + 250 ms**. Rows 17 and 17b must never be conflated: 17 is the predicate, 17b is the rebuild |
| 18 | `marching_cubes` 256×256×208 | < 1 s |
| 19 | Boundary extraction from `grey_Thalamus_TI.msh` (1,340,029 tets, 0 tris) | < 1.5 s WASM |
| 20 | Pointer-to-photon latency, orbit and slice scrub | ≤ 2 frames at the pinned cadence |

`scripts/bench.ts` pins `QualityLevel` to **full** so adaptive fallback cannot silently satisfy a bar it was
meant to be measured against, runs the cut at 20 offsets along the normal, and reports the indexed and
de-indexed variants' build times and byte counts separately.

### 9.2 Memory

wasm32 linear memory is hard-capped at 4 GiB, and **4032 MiB is the usable ceiling**. **It grows and never
shrinks** — there is no shrink instruction and Rust's wasm dlmalloc keeps freed pages, so `free(handle)` does
not return RSS. This is why §5 mandates worker-per-dataset with `terminate()`. wasm64 is out of scope:
`wasm64-unknown-unknown` is Tier 3 and needs nightly, and Memory64 also gives up guard-page bounds-check
elision.

**Two rules, because a mesh has two peaks.** The load path (input bytes + retained `Mesh`, input dropped
before `read_msh` returns) and the `buildTopology` path (retained `Mesh` + counting-sort transient +
`TetTopology`) are budgeted separately. They are not the same multiple of the file size.

| Arena | Budget |
|---|---|
| **Load path**, per dataset worker | **< 2 × file size** — ≤ 380 MB for `ernie.msh`, ≤ 480 MB for `Thalamus_TI.msh`, ≤ 800 MB for `ernie_TDCS_1_scalar.msh`, ≤ 1.0 GB for either SEEG mesh |
| **`buildTopology` path**, per dataset worker | **< 3.2 × file size** *live* — ≤ 600 MB live / ≤ 960 MB resident for `ernie.msh`, ≤ 1.6 GB live / ≤ 2.1 GB resident for either SEEG mesh |
| Renderer JS heap (ernie scene) | ≤ 400 MB; **no single ArrayBuffer > 1 GB** |
| GPU (ernie scene) | ≤ 500 MB |

**Live bytes and resident bytes are two different numbers, and `wasm_heap_bytes()` reports the second.**
Because linear memory never shrinks, when the topology path allocates, the load path's freed input block is
still mapped and dlmalloc reuses only part of it — so the observable peak is the load path's resident total
*plus* the topology arena, not the larger of the two. `buildTopology` is not refused on any reference file.
What keeps the SEEG worst case at 1.56 GB live rather than 2.8 GB is exactly three choices: lazy topology,
counting-sort face extraction, and `TetTopology` without `tet_faces`.

**Component sizes for `ernie.msh`** (847,165 nodes; 1,177,213 tris; 4,722,625 tets; 9,509,557 unique faces):
retained `Mesh` **149.1 MB** (nodes 10.2 + tets 75.6 + tet_tags 18.9 + tris 14.1 + tri_tags 4.7 +
gmsh_node_numbers 6.8 + tet_perm 18.9 + **gmsh_elm_numbers 0**), `TetTopology` 190.2 MB, counting-sort
transient 226.7 MB, plus the 184.2 MB input dropped before `read_msh` returns. `gmsh_elm_numbers` is 0
because §6.2's identity rule applies to every reference `.msh`; a file that *does* need explicit numbers adds
47.2 MB here and 126.3 MB on `ernie-seeg`, and both still fit.

One 512×512×416 volume costs 208 MB as R16 (416 MB as R32F) in VRAM **and the same again** on the CPU for
probes. Files over 2 GiB get a warning at open.

---

## 10. Conventions

* TypeScript strict; ESLint + Prettier; no `any` in public APIs. Rust: `clippy -D warnings`, `rustfmt`,
  stable toolchain pinned in `rust-toolchain.toml`; **nightly is forbidden**.
* Commit messages: conventional commits (`feat(engine): …`). **Do not add `Co-Authored-By` trailers.**
* Every feature lands with tests per §11.
* Keep dependencies minimal; every new one needs a line in `docs/DECISIONS.md` **and** the coordination in
  §12.3.

---

## 11. Rendering verification

Rule 0: **an agent cannot judge a PNG; it can judge a number.** Every rendering feature ships **two** tests.
`docs/TESTING.md` is the operator's manual for both.

**(1) Analytic pixel assertion — the primary test.** The expected RGBA is computed from first principles,
never from a previous run, on a synthetic fixture. Backed by `engine.readPixel(viewId, x, y)`, with no PNG
round-trip:

```ts
expectPixel(view: ViewId, x: number, y: number, rgba: [number, number, number, number], tol = 1): void;
```

Examples that must exist:
* a synthetic 4×4×4 volume with `v = i` under colormap `gray`, `scale {kind:'linear', lo:0, hi:3}` ⇒ the
  pixel at the cursor is exactly `rgb(85,85,85)` ± 1;
* a 4-tet mesh with tag colours from a fixture LUT ⇒ the cap pixel is exactly the tag colour — the **0..255
  wire value**, which §4.1 requires to round-trip exactly through the engine's 0..1 representation;
* **three mandatory orientation tests** on an *asymmetric* synthetic volume (a bright cube in the
  left-anterior-superior octant only): the bright pixel is on screen-**left** in neurological and
  screen-**right** after `setRadiological(true)`, in each of the three 2D views.

**(2) Golden PNG — regression only.**
* Captured **only** under headless Chromium/SwiftShader, fixed canvas size, `deviceScaleFactor: 1`,
  `aa: 'off'`, `deterministic: true`, with `@playwright/test` pinned to an exact version (it pins the
  SwiftShader build).
* Stored per renderer class under `packages/engine/test/golden/<swiftshader|angle-metal>/`, the class taken
  from the live context (`isSoftware`), never from `process.platform` and never from `headless`.
* Compared with `maxDiffPixelRatio: 0.002` and `threshold: 0.15` — never byte equality; SwiftShader's LLVM
  JIT is not bit-identical across arm64 macOS and x86_64 Linux.
* **`ubuntu-24.04` is the golden authority** (§12). The macOS job runs the same tests at a looser ratio; a
  golden that passes on macOS and fails on ubuntu must be **regenerated on ubuntu**.
* **The golden authority does not have `EXT_texture_norm16`** (§7.1), so every golden pins the R32F/R8 branch
  of the §6.1 ladder — a float32 T1 is R32F in every captured PNG and R16 in the shipping renderer, a
  different quantisation in the very test named "Float volume not black". Goldens therefore cannot cover the
  primary format path; that coverage comes from analytic `expectPixel` tests run **twice** on the
  macOS/ANGLE leg, once with `forceCaps` unset and once with `forceCaps: { norm16: false }`, asserting the
  same physical value within each format's own tolerance. Same pattern as `forceDiscardClip`.
* Regenerating a golden requires a commit body stating **what changed visually**. "Regenerate goldens" is not
  a commit message. Two locks make this deliberate: `updateSnapshots: 'none'` unless
  `TETRAVOX_UPDATE_GOLDENS` is set (so a *missing* golden is a failure, not a silent capture), and
  `expectGolden()` refuses to run in any update mode without that variable.
* Every golden includes the §8 2D chrome (orientation letters, corner info, RAD/NEU badge) and the colour
  bars.
* **A golden captured on a developer's machine is a proposal; ubuntu decides.** `docs/TESTING.md` §3 has the
  loop: CI's failure artefact carries the `*-actual.png` the authority rendered, and that file — not a local
  capture, and never a `-u` re-run — is what gets committed.

**(3) A pane-scale reference renderer.** `expectPixel` proves one pixel; nobody hand-computes 147,456 of
them, and a golden only says "the same as last time". `scripts/reference/` is a second **rendering path** for
§7.3's slice compositing, in pure Python (numpy + nibabel + scipy, no imports from `packages/`), which a test
can point at the **same scene** the engine drew and diff against. It is an independent *path* over a
**shared display model**: the affine, sampling, the anchor and the compositing loop are re-derived from the
prose; the value gate and the colour tables are ported from — and in the tables' case parsed out of — the
TypeScript, so a logic error inside `bakeScale` would be reproduced rather than caught. What guards those is
(1). Tolerances: mean `|Δ| ≤ 2/255` over the footprint mask, ≤ 1 % of footprint pixels above 8/255 on any
channel, and outlines by dilation-tolerant IoU ≥ 0.9.

**Fixture expectations.** `scripts/gen-fixtures.py` writes `testdata/manifest.json` and **commits** it, so
Rust tests assert numbers without needing Python at test time. **Every number in it comes from an
independent reader, never from the writer beside it**: nibabel for NIfTI / MGH / GIfTI / FreeSurfer,
SimpleITK for NRRD / MetaImage (it loads LPS; the manifest stores the RAS affine after the x/y flip),
`simnibs.mesh_io.read_msh` for Gmsh v2.2, the Gmsh Python API for Gmsh v4.1, STL/PLY/OBJ and the ascii
legacy `.vtk` / `.off` / MEDIT `.mesh`, and meshio for VTK legacy + XML and MEDIT (Gmsh 4.14 reads no VTK XML
and no binary legacy VTK; each such gap is a `readerNote` in the manifest). The
handful of expectations no third-party reader produces are marked `"groundTruth": "authored"`. Reference
values for the *real* dataset come from `scripts/refvalues/` and are transcribed into `AGENTS.md`.

**Named tests that must exist (each pins a decision that has already been misread once):**

| Test | Asserts |
|---|---|
| Overlay compositing, 2D | A continuous-scalar overlay over `T1.nii.gz` on an **oblique 2D view**: the overlay's visible pixel count within its own footprint is **exactly 100 %**, asserted as independence over every pixel of the pane (the composite must not change when the layer underneath is hidden or re-windowed). A percentage tolerance would let the coplanar-depth bug ship. The file must be a **continuous scalar** — a label volume takes §7.3's `R8UI` + palette branch instead, where opacity is decided per label |
| Overlay compositing, 3D | The same pair on an oblique plane **in the 3D view** (`showIn3D`), same exact-100 % count under `depthFunc(LEQUAL)`. This is what pins §7.3's shared-plane-geometry rule |
| Label outline zoom | A label volume in `outline` mode at 0.05, 1.0 and 5.0 mm/px: measured perpendicular thickness in **[0.8, 2.9] px** and ≥ 99 % coverage of the fill boundary at each. A voxel-space regression blows the upper bound immediately (12.87 px at 0.05 mm/px). Thickness is twice the median Euclidean distance transform on the band's **ridge**, which has no preferred direction — a run length along a screen axis reads the band's oblique crossing instead |
| Clip-path equivalence | Every clip golden runs twice — `gl_ClipDistance` and `TETRAVOX_FORCE_DISCARD_CLIP=1` — asserting identical pixels |
| Cap diagonal | Axial cut of ernie through the centroid: a pixel assertion in a region containing a known 2-2-split tet shows **no diagonal**, plus a whole-image edge-pixel count against a golden |
| Pick | Double-click a fixed pixel on the scalp of ernie tag surfaces: returned `world` within 1 mm of the reference point, cross-checked by `locate` returning a tet with tag 5; all three 2D slice indices changed as expected; a background click returns `null` |
| Oblique slice | `mode:'oblique'`, `normal = normalize([1,1,1])`, `T1.nii.gz` alone, asserted at named pixels — the derived-plane maths and the slice shader with nothing else in the frame; then the same view with a `MeshLayer` at `contoursIn2D: true` over it |
| Float volume not black | Load the real float32 `T1.nii.gz` and assert a non-black pixel at a known intracranial voxel. Catches the whole `floatLinear`/format-ladder class |
| Transparency (i) | Scalp tag 1005 at opacity 0.35 over opaque GM tag 1002 coloured by a field: **no dark rim** from double-blended back faces |
| Transparency (ii) | GM tag 1002 at opacity 0.5 with an opaque 10 mm sphere at a deep target, diffed against a CPU per-fragment-sorted reference render, reporting max per-pixel delta. This is what decides whether `twoPhase` is enough or depth peeling must land |
| Surface invariant | `tag_surfaces(ernie.msh)` equals the exterior ∪ tag-differing-interior face set exactly: 128,614 + 1,048,599 = 1,177,213; and on `ernie-seeg.msh` 202,318 + 2,427,261 = 2,629,579 |
| Cut index equivalence | `plane_cut` output is byte-identical with and without `TetBlocks`, for an axial and an oblique plane on ernie |
| qfac | The qform rebuilt from `T1.nii.gz`'s quaternion with `qfac = −1` equals the sform to < 1e-4; dropping `qfac` gives max abs error 2.0 |
| Face-key width | A synthetic mesh with ≥ 2²¹ nodes, plus `ernie_seeg.msh`, extract the correct boundary (a u64 packed key silently deletes faces there) |
| Scale bar | The drawn bar is exactly `mm / mmPerPx` pixels long, read off the framebuffer at two zooms |
| Glyphs | Against a numpy reference over `ernie_TDCS_1_scalar.msh`: set equality on the sampled element numbers, origins within 0.01 mm, directions within 1°, lengths equal to the scaling model's |
| Surface contours | `lh.pial.gii`'s three axis-plane contours against a nibabel + numpy reference: segment counts and total contour lengths |
| Points ghost | A points layer at `offPlaneOpacity: 0.6` over a **known** slice pixel: the off-slice point's pixel is `src·0.6 + dst·0.4` of the layer colour over the tag colour, computed from first principles, and the SAME source over the background where the fixture hides its other tag — so a "ghost" implemented as a fixed dimmed colour passes the first and fails the second. Absent, the same point draws nothing at all. `shape: 'dot'` ghosts at its constant 4 px radius at two zooms an order apart |
| Point selection ring | The ring's **radius is measured off the framebuffer**, the way the scale bar's length is: every pixel of `OverlayTheme.select` around the point is `disc + 2 px` from its centre, for an on-slice disc and for a ghosted one (which has no cross-section, so only its full radius can produce a ring). A culled point and a stale index draw **no** ring, and a hover ring that names the selected point is dropped |
| Names as labels | `labelSource: 'names'` drawn and **decoded back out of the framebuffer** with §11's glyph matcher; with `labelSource` absent the same layer decodes its `labels` array instead. A ghosted point's disc is drawn and its name is not, which is the 2D-rule divergence §4.4 and §7.2 state |
| Point tool | The drag is asserted as an identity derived from §3 rather than from the engine: a 40 px drag moves the contact `40 · mmPerPx ± 0.05 mm`, the same claim §11 makes of the measurement tool from the other side. Around it, the grammar: in `place` mode **every** click appends (three clicks, three points, none of them a hit test); in `select` mode a press at 0.9 r grabs and one at 1.1 r + the 8 px floor does not; exactly **one** `dragEnd` per drag from each of the three gesture exits, `pointercancel` included; the selection survives an `updateLayer` that replaces `points` and is `cleared` when its id is not in the new array; `Esc` walks `place` → `select` → off; and arming the point tool turns measure mode off |
| Bounded local reads | `sampleVoxelBox` / `peakCentroid` against **numpy twice**: on `testdata/ct_shafts.nii.gz` (three depth electrodes, 3.5 mm pitch, anisotropic spacing so the per-axis half-extent differs, `HU + 1024` on disk so a forgotten `scl_inter` is off by exactly 1024) through `testdata/manifest.json`, and on `m2m_ernie/T1.nii.gz` through `scripts/refvalues/voxelbox_refvalues.json`. Box `ijk0`/`dims`/min/max/sum plus five spot values a transposed window cannot reproduce; the centroid to 1e-4 mm; and the property numpy cannot check — a click 0.8 mm off a contact lands within 0.15 mm of it. Two cases exist for the **parity** rule alone: `off-toward-neighbour`, a mislocalised click where Slicer's `rad_vox` and `ceil` answer 0.86 mm apart, and `default-radius`, the one T1 query with a non-integer radius (on 1 mm spacing every integer radius makes the two rules agree) |

---

## 12. CI and packaging matrix

### 12.1 Jobs

| Job | Runner | Does | Notes |
|---|---|---|---|
| `test` | `ubuntu-24.04` | `cargo test --workspace`, `cargo clippy -- -D warnings`, `pnpm wasm`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm e2e` | **Golden authority** (§11) |
| `test` | `macos-latest` | same | goldens compared at a looser ratio; **push to `main` and `workflow_dispatch` only** |
| `package` | `macos-latest` | `.dmg` + `.zip` **arm64 and x64** | one runner: the config builds both slices, and the smoke test runs the x64 one under Rosetta. macOS has no working software-GL fallback, so a GPU-less Intel runner could build the slice but never render it (docs/RELEASING.md §7) |
| `package` | `ubuntu-24.04` | `.AppImage` + `.deb` + `.tar.gz` x64 | **Linux artefacts are never built on macOS** |
| `package` | `windows-latest` | `.exe` (nsis) x64 | electron-builder makes this from macOS/Linux too — only *signing* needs wine — but this is the only runner that can launch it |
| `package` (optional) | `ubuntu-24.04-arm` | `.AppImage` arm64 | not built today |
| `docs-guard` | `ubuntu-24.04` | `scripts/check-frozen-docs.mjs` on the merge-base diff, plus its own `node --test` fixtures | **`fetch-depth: 0`**; its own job, so it reports before `test` finishes |

**macOS and Linux are the priority platforms; Windows is optional.** The Windows leg is carried
because it costs nothing — a stock `windows-latest` builds an unsigned NSIS installer with no extra
tooling — and both workflows mark it `continue-on-error`, so a Windows failure never blocks a
macOS/Linux release.

The `package` matrix lives in **two** workflows over one definition of the work. `ci.yml`'s `package`
job runs on every push to `main` (and on `workflow_dispatch`) and uploads workflow artefacts, so
`main` always has downloadable builds. `release.yml` runs on a `v*` tag in three stages —
`create-release` makes a **draft** Release first, four `build` jobs attach their own artefacts to it
as each finishes, and `verify` fails if a required asset is not actually attached. Creating the
Release up front is what lets a fast platform publish without waiting for a slow one; `verify` is what
catches a leg that went green and uploaded nothing.

Artefact names are `Tetravox-<version>-<os>-<arch>.<ext>` on every platform and target, where the arch
token is each ecosystem's own spelling of x64 (`x86_64` for the AppImage, `amd64` for the deb).
`docs/RELEASING.md` is the operator's manual: cutting a version with `scripts/release.sh`, the
notarisation switch, the Docker path for Linux artefacts, and what the smoke test does and does not
claim.

**When each `test` leg runs.** The macOS leg is gated by the **matrix itself** —
{% raw %}`os: ${{ github.event_name == 'workflow_dispatch' && fromJSON('[…, "macos-latest"]') || fromJSON('["ubuntu-24.04"]') }}`{% endraw %}
— and **not** by a job-level `if:`: the `matrix` context does not exist in `jobs.<id>.if`, so an `if:`
reading `matrix.os` is an **invalid workflow**, not a false condition, and the run fails in 0 s with no jobs
at all. GitHub bills macOS at **10×** the Linux rate on a private repo, and the golden authority is ubuntu,
so a pull request is already gated on the runner whose pixels decide. macOS remains a hard gate on `main` —
including the packaged `.dmg` e2e, which exists nowhere else — so a PR green on ubuntu can still turn `main`
red; that is the accepted cost.

The `test` job carries **`timeout-minutes: 45`**, and it is part of the same policy. A green leg is ~8 min on
ubuntu and ~5 min on macOS, so the cap never touches a working build; it exists because this suite's
characteristic failure is not a hang but a **slow-motion pile of timeouts** — an engine page that never
publishes `window.__tvxEngine` fails ~120 Playwright tests at 30 s each, on each project, and bills every
second. One such run spent 3 h 14 m of macOS runner time for a defect visible in its first minute.

Every `package` job ends with an **artefact smoke test**: launch the packaged binary with a CLI arg pointing
at a fixture and assert it exits 0 after rendering one frame. That is `scripts/smoke-artefact.mjs` — `--job`
on two committed synthetic fixtures, then `job-result.json` must be `ok` with a real PNG on disk. `--job` is
what makes it CI-safe: it is forced offscreen and is exempt from the single-instance lock, so it needs no
display manager and takes no developer's focus.

**The Windows leg claims less, on purpose.** A hosted `windows-latest` runner has no GPU and no compositor,
so rather than go green on a vacuous render it runs `--version-only`: launch, print a version, exit 0.
Windows is therefore *built and launch-verified* every release, and *rendering on Windows is not covered by
CI* — a real gap, recorded rather than papered over.

**The `docs-guard` job** enforces two rules this file has always stated and could never check.
First, **§12.3**: a frozen interface path in the merge-base diff without **both** `ARCHITECTURE.md`
and `DECISIONS.md` in the same diff fails the job. Both, because one says what the interface now is
and the other says why it changed, and a repository with one and not the other has lost the half
nobody wrote. Item 5 of §12.3 — the Rust signatures — is deliberately *not* enforced by path: it is
a rule about signatures spread over many files, and a `crates/**` trigger would fire on every
implementation change and teach everyone to ignore the job. Item 6 — `modules/host.ts` — **is**
enforced by path from the day it was frozen (2026-08-30), for the reason the four before it are: for
a file that *is* the interface, "the file changed" and "the interface changed" are the same event.
Second, **§13.1**: every extension
manifest's `docs` heading must exist as a `## ` section in `docs/USER_GUIDE.md`, in
`website/scripts/sync.mjs`'s `GUIDE_PAGES`, **and** as a `/guide/<slug>` entry in
`website/.vitepress/config.ts`'s sidebar. The first two because the website's splitter throws on a
section it has no page for — a late, confusing failure this turns into an early, specific one. The
third because nothing else can check it: the sidebar is hand-written, `sync.mjs` neither generates
nor validates it, and `ignoreDeadLinks: false` only catches a sidebar entry with no page, never a
page with no sidebar entry — which builds cleanly and ships linked from nothing. §13.7 item 3 has
always required all three; since 2026-08-30 the job enforces all three.

It is a **separate job** rather than a step of `test` because `actions/checkout@v5` fetches one
commit by default and a merge-base diff needs the history, and because "you changed a frozen
interface and not its documentation" is something a reviewer should read before the test legs
finish. It costs about twenty seconds — node, a diff, two file reads — and no toolchain. With no base
to compare against (a `workflow_dispatch`, a local run) it says so and checks only the rule that
needs no diff; a guard that failed when it could not do half its job would be switched off within a
week. Its own fixtures run first, in the same job (`scripts/check-frozen-docs.test.mjs`, `node --test`).

`pnpm package` on a developer machine produces that platform's artefacts only; Linux artefacts come from CI
or from `scripts/package-linux.sh`, which runs electron-builder inside `electronuserland/builder` with the
wasm pre-built on the host.

### 12.2 Environment pitfalls encoded in the scaffold

* pnpm 10 does **not** run dependency lifecycle scripts by default, so esbuild installs without its platform
  binary and Vite fails with an error that never mentions pnpm. Root `package.json` therefore carries
  `"pnpm": { "onlyBuiltDependencies": ["esbuild", "electron"] }`.
* **`electron`'s binary arrives differently on either side of major 42, and the floor is 42 for that reason
  too.** `npm view electron@<v> scripts` returns `{ postinstall: 'node install.js' }` for 38–41 and
  **nothing** from 42 onward. So on 38–41 the ~100 MB binary is fetched by a `postinstall` that pnpm 10 skips
  — leaving `pnpm exec electron --version` **failing** rather than downloading — while from 42 it is fetched
  on first launch. `onlyBuiltDependencies` covers the first case and is a harmless no-op in the second. CI
  caches `~/.cache/electron` and `~/.cache/ms-playwright` and runs an explicit `pnpm exec electron --version`
  warm-up step **before** the e2e job either way, so a download failure is its own red step. **On Linux it is
  `electron --no-sandbox --version`**: the `chrome-sandbox` helper in the npm tarball is not root-owned
  setuid, and Chromium aborts rather than run unsandboxed — even for `--version`.
* An **Xvfb** is started on the Linux runner and exported as `DISPLAY`; the step waits on `xdpyinfo` first,
  so a display that never came up is a red Xvfb step rather than an unexplained Electron crash three steps
  later.
* **`TETRAVOX_TESTDATA` is unset in CI**, and a step asserts it — real-data tests skip by design.
* Gate: **a clean clone with an empty pnpm store reaches `pnpm e2e` green.**
* macOS signing: Developer ID + notarisation are **live in `release.yml`** (the four secrets are set;
  `docs/RELEASING.md` §4) and a documented fallback keeps unsigned local/fork builds working
  (`scripts/electron-builder.sh`). §12.4's in-app updates ride on the signature — a dev tree's updater
  mode is `'off'`, and a packaged-but-unsigned local build checks but cannot complete a macOS
  install (Squirrel refuses the swap, surfaced as an error). `electron-builder` is pinned to an exact patch version.
* Linux: the AppImage needs `--no-sandbox` or a correctly-owned `chrome-sandbox`; the app detects
  `caps.isSoftware` and surfaces it in the status bar rather than silently running at 2 fps.

### 12.3 Interface and dependency freeze

**Frozen. Changing any of these requires an ARCHITECTURE.md edit in the same commit:**

1. `packages/protocol/src/index.ts` — §6.5.
2. `packages/engine/src/scene/types.ts` — §4.1–§4.6, zero imports.
3. `packages/engine/src/api.ts` — §4.7, plus `MockEngine` satisfying it with no GL.
4. `packages/wasm/src/index.ts` — the client interface; `pkg/tvx_wasm.d.ts` stub committed so `tsc` works
   before the first wasm build.
5. Every Rust signature in §6.0–§6.4.
6. `packages/app/src/renderer/src/modules/host.ts` — §13.1's `ModuleHost` / `ModuleInstance`, frozen from
   2026-08-30 at `MODULE_HOST_VERSION = 1`, when the wiring commit made `tool`, `files` and
   `scene.peakCentroid` real. It is the surface every extension is written against and the one a
   worker-hosted stage 2 (§13.8) would have to honour, so it changes the way `api.ts` does. The
   **manifests** it is paired with (`packages/app/src/modules/**`) are not frozen but are typechecked by
   all three tsconfigs — `tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.e2e.json` — because main
   validates a job action against them before a window exists, and a manifest that only the renderer
   compiled would fail in the process that has no way to report it.

Additive changes are the normal case and are still edits: a new optional field, a new appended op, a new
facade member. **Absent must always reproduce the previous behaviour**, so a scene file or a build that
predates the addition still works — that is what makes "additive" a real guarantee rather than a label.

**Dependency freeze.** Adding a dependency is a coordinated change with both lockfiles regenerated, not an
incidental one, and it needs a line in `docs/DECISIONS.md`.

| Rust | Purpose |
|---|---|
| `thiserror` | `tvx_core::Error` |
| `flate2` (default-features off, `rust_backend`) | gzip **and** zlib inflate — GIfTI `GZipBase64Binary` is zlib |
| `quick-xml`, `base64` | GIfTI |
| `byteorder` | endian-explicit reads (Gmsh binary, FreeSurfer big-endian) |
| `wasm-bindgen` (exact), `js-sys` | `tvx-wasm` |
| `serde`, `serde_json` | meta/criteria JSON across the boundary |
| `criterion` (dev) | benches |

| Node | Purpose |
|---|---|
| `react` (19), `react-dom`, `zustand`, `gl-matrix`, `tailwindcss` (4), `postcss`, `autoprefixer` | UI + math |
| `typescript` (~5.9, **not 7**), `vite` (^7), `electron-vite`, `esbuild` | build. TS 7 is the Go-based compiler and `typescript-eslint` peers `<6.1.0`; `electron-vite` peers `vite ^5 \|\| ^6 \|\| ^7` |
| `electron` (≥ 42, pinned major), `electron-builder` (exact patch) | shell + packaging |
| `electron-updater` (^6) | §12.4's in-app updates: reads the release feed, downloads, sha512-verifies and installs. electron-builder's sibling, so the feed files that CI attaches are the ones it expects. Bundled into `out/main` (`electron.vite.config.ts` excludes it from dependency externalization) because the packaged app ships no `node_modules` |
| `vitest`, `@playwright/test` (exact version — pins SwiftShader) | tests |
| `eslint`, `prettier`, `typescript-eslint` | lint |

**`pnpm-lock.yaml` and `Cargo.lock` are never merged.** On conflict, take `main`'s version and re-run
`pnpm install` / `cargo check --workspace` to regenerate. Worktree branches rebase on `main` before merge.

### 12.4 In-app updates

**Opt-in, never unattended** (2026-08-31; the DECISIONS.md entry of the same date narrows §1's former
"auto-update" non-goal). The app notices a published GitHub Release, says so — an info toast once, a
status-bar pill for as long as it stays true — and does nothing further until the user clicks.

* **Feed.** electron-updater's GitHub provider (`idossha/tetravox`), stated in `electron-builder.yml`'s
  `publish:` block. That block does **not** publish — `--publish never` stays hard-coded in
  `scripts/electron-builder.sh`, and `release.yml`'s own steps remain the only uploader — it embeds
  `app-update.yml` in every packaged app and has electron-builder write `latest-mac.yml` / `latest.yml` /
  `latest-linux.yml` into `release/`, which the release legs attach beside the installers and `verify`
  requires (mac and linux; `latest.yml` is optional exactly as the Windows leg is). A **draft** Release is
  invisible to the feed, so §12.1's human gate is also the update gate: nothing is offered until Publish.
* **Modes** (`main/updater.ts#updateMode`, from facts at launch, never from preference): `'inplace'` —
  macOS (the signed zip beside each dmg is the update artefact; Squirrel.Mac also checks the code
  signature), Windows NSIS, Linux AppImage (`APPIMAGE` set); `'notify'` — a `.deb`/`.tar.gz` install,
  which only reads `latest-linux.yml` over `net.fetch`, compares, and offers the Releases page;
  `'off'` — a dev tree (`!app.isPackaged`) and every `--job` run. (A *packaged* unsigned build —
  a contributor's own `pnpm package` — is `'inplace'` and checks; on macOS Squirrel then refuses
  the unsigned swap at install time, surfaced honestly as an 'error' status.)
* **Flow.** A launch check (a few seconds after ready, gated by the `checkForUpdates` setting, silent
  about `skippedUpdateVersion`) pushes one status. Download happens on click (`autoDownload: false`),
  with progress statuses; install happens on click (`quitAndInstall`) — and a downloaded update also
  lands on the next ordinary quit (`autoInstallOnAppQuit: true`), so "Later" is a real answer. A manual
  check (File ▸ Check for Updates…) ignores and clears the skip: asking again is un-skipping. Artefact
  integrity is the feed's sha512 per file, verified by electron-updater before install.
* **IPC** is §5 rule 14. **Settings** are two ordinary `settings.json` keys (`checkForUpdates`,
  `skippedUpdateVersion`), both renderer-writable — a skip is a preference, not a capability.
* **Tests.** `updater.test.ts` injects the `UpdaterImpl`/`fetchImpl` seams and asserts the refusals
  above; electron-updater itself is loaded only in a packaged `'inplace'` build, by dynamic import.

---

## 13. Extensions

An **extension** is a first-party tool: bigger than a toolbar toggle, smaller than a second application,
owning one kind of data end to end — its own panel, its own keys, its own files, its own undo. It is a
versioned `manifest.json` plus `index.js`, **installed at runtime** through File ▸ Extensions… (§13.8);
nothing ships inside the application (the bundled tier was removed 2026-08-31), and the one compiled-in
entry is the test fixture `tetravox.hello`, reachable only behind the `?modules=` launch query. The sEEG
contact editor is the first product extension; DBS leads, ECoG grids and an ROI tool are the shape of the
next ones. §1's "plugins" non-goal is **narrowed, not withdrawn**: third-party code is still out of scope,
and §13.9 says what admitting untrusted code would cost.

*A note on names (2026-08-31):* the product word is **extension**, everywhere a user or a document reads.
The word `module` survives in the machine surfaces that predate the rename and are frozen against published
extensions and user state — the manifest's keys, the `ModuleHost` API, `tetravox://module`,
`~/.tetravox/modules/`, `@tetravox/module-sdk`, the job-file action `"type": "module"`, the Python
`Job.module()` — and in internal identifiers and file names that mirror them. Those are wire and disk
formats, not vocabulary.

The rule this section exists to hold: **an extension is a directory and one line in a registry.** Nothing
extension-specific may appear in `Shell.tsx`, `Toolbar.tsx`, `keymap.ts`, `StatusBar.tsx` or `controller.ts` —
the shell reads every extension-specific fact out of a manifest. `modules.test.ts` is what keeps that true.

### 13.1 What an extension is, and where it lives

```
packages/app/src/modules/manifest-types.ts        # ModuleManifest, ArgShape — no DOM, no node:
packages/app/src/modules/<id>/manifest.ts         # data only; read by main, the renderer AND scripts
packages/app/src/modules/manifests.ts             # MANIFESTS — the main-safe barrel
packages/app/src/renderer/src/modules/host.ts     # ModuleHost / ModuleInstance — FROZEN, §12.3 item 6
packages/app/src/renderer/src/modules/registry.ts # [{ manifest, load: () => import('./<id>') }]
packages/app/src/renderer/src/modules/hostImpl.ts # createModuleHost — the ONLY file that sees both sides
packages/app/src/renderer/src/modules/<id>/…      # index.ts, Panel.tsx, kernels, tests
```

**A manifest is data, and that is load-bearing.** `main/job.ts` validates a `type: "module"` job action
against `MANIFESTS` **before a window exists** (§13.6), which is what lets a job file report every problem at
once. So manifests carry type annotations and object literals only — erasable syntax, no enums, no namespaces
— and are typechecked by **all three** tsconfigs: `tsconfig.node.json` (no `DOM` in `lib`, so naming a DOM
type is a compile error), `tsconfig.web.json` and `tsconfig.e2e.json`. A vitest reads the sources back and
fails a manifest that imports anything outside its own directory.

**Ids.** An extension id is `<vendor>.<name>` (`tetravox.seeg`). Command, reader, writer and operation ids are
**unprefixed inside a manifest**; the host namespaces them as `<moduleId>/<id>` wherever they leave the
extension, so a manifest never repeats its own id and two extensions may both declare `save`.

**`ModuleHost` is the whole surface.** Scene reads and writes are **synchronous** — they are calls into the
engine through the controller, exactly as every §8 panel's are — and only files, dialogs and confirmations are
promises, because those cross §5's process boundary or wait for a person. An extension receives this object and
imports nothing else: an ESLint wall on `modules/<id>/**` allows `../host`, the shared control kit and
`@tetravox/engine` **types**, and forbids the store, the engine's runtime, `bridge()` and `automation/*`. A
lint rule can be switched off inline, so `modules.test.ts` re-proves the same property by reading the sources.
That wall is the precondition for §13.8, and it means the blast radius of a worker-hosted extension tier is
`hostImpl.ts` and nothing else.

**Frozen (§12.3 item 6), at `MODULE_HOST_VERSION = 1`.** It was pre-freeze for exactly as long as the
reason was dated rather than vague: `scene.peakCentroid` needed the engine's bounded local read, `tool` the
engine's point tool, `files` the main-process channels, and a surface frozen before those existed would have
been frozen around stubs. All three were wired on 2026-08-30 and the surface was declared frozen in that
commit — one governance round, not four. From here it changes additively, with the `ARCHITECTURE.md` edit and
the `DECISIONS.md` entry in the same commit, and absent must reproduce the previous behaviour.

**`scene.activePlane()` is the one view fact an extension is given** (appended 2026-08-30). It answers
`{ normal, point }` for the active 2-D pane — the view's normal through the cursor, which is §7.5's own
rule for what a slice pane shows — and `null` for the 3-D pane. It is here rather than derived by an
extension for the reason §8 forbids the app deriving a world point from a pane pixel: `{normal, up}` is
engine state, and an extension reconstructing it from `SliceMode` would be wrong on an oblique view and
would not follow a rotation. Nothing else about a view is offered — not its camera, its zoom or its
per-view layer visibility — because the one thing a panel *beside* the panes has to be able to say is
how far the thing in its list is from the slice the user is looking at.

A member a build does not wire **throws `ModuleHostError`** rather than returning a plausible `null`: "this
build has no point tool" and "nothing is selected" must not be the same answer. Every member is wired in the
shipping build — `ShellController.activateModule` passes the engine's tool, `createHostFiles(manifest,
bridge().allowPath)` and the engine's `peakCentroid` — and the optional dependencies stay because the
distinction is what a harness, and a host version that outruns a build, are built on.

**Versioning.** `MODULE_HOST_VERSION` is an integer and `manifest.hostApi` names the version an extension was
written against. Host changes are additive under §12.3 exactly like `api.ts`; a breaking change bumps the
integer with a `DECISIONS.md` line, and the registry test then refuses every stale manifest.

**Lifecycle.** Registration is build time; activation is lazy — the switcher, a reader hit, a sibling hit
after a dataset lands, or a scene carrying the extension's block. One extension is in the slot at a time
(`UiState.activeModule`, set only once `activate` resolved). `dispose()` runs on deactivate, on `newScene` and
on `ShellController.detach`. An `activate` that throws becomes a toast and leaves the slot empty; it may never
leave a half-built view grid behind. **Deactivating is not destructive**: an extension's edits live in the scene's
layers and its own state in `moduleBlocks`, so re-activating restores through `restoreBlock` — the same code
path opening a scene takes.

**Distribution.** One route: **downloaded**, from its own repository through File ▸ Extensions… — the
extension is verified, consented to per version and loaded over `tetravox://module` (§13.8). (The in-tree,
compiled-in route survives only for the `tetravox.hello` fixture — `CONTRIBUTING.md`, "Adding an
extension" — which is test scaffolding, not a shipped extension.) Everything below this line is the same
either way: the same `ModuleManifest`, the same frozen `ModuleHost`, the same key pool, the same scene
block, the same job envelope.

### 13.2 Persistence

Two halves, and neither is a new scene concept.

**Core-typed layers.** An extension's geometry is ordinary `Scene.layers` — a `PointsLayer` of contacts, not a new
layer kind. So a build without the extension still *draws* the scene, `serialize` still round-trips it, and no
pass, registry or property editor grew a case for it. `LayerBase.module` records the owner.

**One opaque block per extension**, at `ViewSpec.extensions[<moduleId>]`:
`{ module, version, moduleVersion, data }`. It is written by the **app**'s `serialiseScene`, exactly like
`theme` and for the same reason: `Engine.serialize()` enumerates engine fields and an extension's record is not
one of them. Three rules make it portable:

* **A block never contains a `LayerId` or a `DatasetId`.** Both are reassigned on load, so a block holding one
  would point at someone else's layer the second time a scene was opened. An extension finds its own layer by
  `LayerBase.module`.
* **≤ 256 KiB of JSON**, enforced by the host. A block is a *record* — provenance, per-point status, the
  extension's own settings — not a second copy of the data.
* **A block for an extension this build does not have is carried through verbatim.** Opening a colleague's scene
  and re-saving it must not delete their work. A build that *does* have the extension but is older reads the
  block's `version` and decides for itself. Verbatim is the **whole envelope**, not the four fields a given
  build knows about: `sceneExtensions` validates `module` / `version` / `moduleVersion` and re-states them
  over the block it was handed, so a fifth field a later host adds under §12.3's additive rule survives an
  open and a re-save by the build that predates it rather than being stripped from every block in the file.

The read side is strict about the envelope and tolerant about `data`: a block whose key and `module` field
disagree, or whose `version` is not a number, is **dropped**, because handing a malformed block to
`restoreBlock` is an extension crash on file open; `data` is not inspected at all, because it is not ours to
validate.

**Degradation, stated.** A scene re-saved by a build without the extension keeps the layer and every per-point
field — they ride the `{ ...layer }` spread §4.6 promises — and drops `extensions`. An extension reopening such a
scene rebuilds what it can from the layer, marks its provenance unknown, and says so.

### 13.3 The user interface

**One docked slot in the right column, above the info panel.** Not a floating palette: the shell has no
floating, draggable or popover primitive, pane overlays are `pointer-events: none` by contract so a palette
over the canvas would fight the WebGL grid for pointer capture, and at 1512 px the sidebars already take
608 px — a floating editor would cover the pane it asks the user to click in. Not a tab either: the feedback
most extension actions are judged by is the info panel's Cursor block, and a tab hides it at the moment it
matters.

The slot renders **nothing at all** while idle, so the DOM is unchanged with no extension active, and it sits
**outside** the info panel's scrolling container, which is what makes `max-h-[55%]` plus its own scroller a
hard cap rather than a suggestion — inside it, a tall extension would squeeze the info panel to zero. The column
is 320 px and stays 320 px; a resizable right aside is on the ROADMAP, not in v1.

**Four bounded secondary surfaces, and no fifth:**

1. **One switcher**, in the toolbar's right column, directly above the slot it opens — never a button per
   extension. `Toolbar.tsx` is `flex-wrap`, so a second extension's button in the centre cluster wraps the row at
   1440 px, grows the header and shrinks the view grid: the same canvas-resize class the status bar was pinned
   against. A Playwright assertion pins the toolbar's height unchanged after an activation at 1440×900.
2. **One status-bar cell per active extension, ≤ 40 characters, before the dataset cells.** Two BIDS-named
   datasets already overflow the strip, which does not scroll, and `ml-auto` cannot pull a cell back inside a
   container that has overflowed — after them it would simply not be on screen.
3. **Pool keys**, live only while the extension is active (§13.5), listed in the `?` sheet's Extensions tab.
4. **One `confirm` dialog** with two or three buttons (§8).

**While a contact extension is active, `select` is the resting state of its tool** (2026-08-30). §7.5's R1 is
that a left click in a 2D pane sets the cursor; the point tool only hit-tests while it is armed. So a panel
whose whole job is "click contacts" has to keep its tool armed, or the electrode dropdown, the selection ring
and the crosshair silently stop following the pointer — which is exactly what the owner reported after `Esc`.
The extension therefore re-arms `select` on a `cleared` it did not ask for, reading §7.5's `reason` to tell the
cases apart: after `'esc'` and `'host'` at once, after `'load'` and `'layer'` when the `layers` event says
the new layer exists, never after `'measure'` (the user picked the other click-consuming mode), and not at
all for `'selection'`, which is not a disarm. `Esc` keeps the step that matters — `place` → `select` — and a
click that hits nothing still falls through to R1's cursor-set, because a `select`-mode miss changes nothing.
Leaving the extension is how a user turns the tool off.

**A click on a ghosted contact jumps the slice onto it** (2026-08-30). §7.5 now lets a press select a contact
the layer draws off-slice, and selecting it is all the engine does — the cursor stays where it was, because
moving it is an application decision. The extension's answer to `selected` has always been `setCursor(contact)`,
so the jump is already written: the press selects the ghost, the crosshair lands on the contact, all three
panes re-cut through it, and the marker the user aimed at is now the on-slice one they can drag. That is what
makes the amendment usable rather than merely permitted — without the jump a user would select a contact they
still could not move, and with it "click the thing you can see" is true of every contact on the shaft rather
than of the one or two the current slice happens to cut.

**Extension-owned layers get a read-only summary instead of the core property editor**, and each half prevents a
concrete defect: the core points editor's per-point ↺ deletes the electrode's colour, its 0.5–20 mm radius
slider is also the probe radius and the 2D slab, and every edit reaches `controller.patchLayer` directly,
bypassing the extension's history and its dirty flag so its own Undo would not undo it. Visibility, opacity and
stacking stay on the row: they are the panel's, they cost the extension nothing, and hiding a layer you can see
in a list is the one thing a reader always expects to work.

**Narrow mode (< 1000 px):** the right aside normally becomes a temporary overlay whose backdrop closes on any
click — including the click in a pane an extension just asked for — so **while an extension is active it stays in
flow**. Pinned by an e2e at 960 px.

**Not offered:** floating or detached panels, popovers, extension-drawn canvas overlays, native menu items, left-
column slots, per-extension toolbar buttons.

**An extension's second extension is a library, not a fork** (2026-08-30). `tetravox.seeg` is the first of a
family — DBS leads and ECoG grids are the shape of the next ones — and what those share is not their
geometry but their *data*: a list of named 3-D positions grouped into electrodes, read from a table
and written back to one. So the model, the tolerant reader, the canonical BIDS writer, the editlog
schema, the PCA line primitives, the group palette, the `ContactSet` ⇄ `PointsLayer` bridge and the
snap scoping live in `renderer/src/modules/shared/contacts/**` and **stay in core** — the SDK exposes
them as `sdk.contacts` (§13.8), so an extension gets the host's one instance rather than a fork. The
sEEG editor, an extension in its own repository now, supplies only what is true of a **depth
electrode**: which end is contact 1, what re-fitting a shaft means, and where `seegprep` puts a
subject's files. `shared/contacts/README.md` draws that line and says what a second contact extension
has to bring. Everything under `shared/` is inside §13.1's import wall — the ESLint rule and
`modules.test.ts` both scan it exactly as they scan a compiled-in extension's directory — so a shared
library that reached the store would fail for its own file; a compiled-in extension reaches it as
`../shared/**` beside `../host` and the control kit, and an extension reaches the same code through
`sdk.contacts`.

### 13.4 Test obligations

An extension ships with all of these or it does not ship:

* **`modules.test.ts` covers it for free** — manifest shape, unique ids, semver, `hostApi`, key-pool
  membership, collision with `resolveKey` and with the engine's own keys, the `docs` heading, and the import
  wall — because that test iterates `MANIFESTS` rather than naming an extension.
* **Every kernel is a pure function with a vitest**, and where an algorithm has a numeric reference the
  expectations come from a fixture produced by an independent implementation (§11's rule, applied to extensions).
* **Panel behaviour is a Playwright spec.** vitest runs under `environment: 'node'`, so a claim about layout
  or about a rendered control can only be made against a window.
* **Real data is gated on an environment variable and skips, never fails, when it is unset.**
* **The fixture extension `tetravox.hello`** is compiled into every build and listed only behind
  `?modules=hello` — the `?engine=mock` seam — because `pnpm e2e` drives the production bundle, so a fixture
  excluded from it would prove nothing about the bundle users get. It exercises every part of the host that is
  wired, which is what keeps the surface from rotting between real extensions.

### 13.5 Keys

**The pool** is `a s d f g n p t z Delete Backspace`, unmodified or with Shift, and nothing else. Every one of
them is a key `resolveKey` returns `null` for, and none is Space, `Esc`, `+`, `=`, `-`, `_` or `r` — the keys
the **engine** binds on the canvas, which no resolver probe would reveal. `modules.test.ts` proves both halves
against the live resolver rather than against this paragraph.

**Resolution order** is: the engine's own canvas bindings; then `keymap.ts`; then, only if that returned
`null` and an extension is active and the target is not editable, the extension resolver. So an extension can never
shadow a documented binding, and adding an extension can never change what any key already does. `Esc` is never an
extension key: `keymap.ts` returns `cancelMeasurement` for it unconditionally and `Shell.tsx` preventDefaults it,
so "core first, extension on null" could not deliver it even if the pool allowed it.

**The one exception to "a plain key stays harmless"** (`keymap.ts`'s rule that an unmodified key never
destroys anything) is `when`: an extension command may be bound with `when: 'selection'` or `when: 'toolArmed'`,
and is then live **only** with an explicit selection or an armed tool. With neither, the key resolves to
nothing at all — not to a command that does nothing. That distinction is the whole of the exception's safety,
and it is unit-tested from both sides.

**Chords are per extension and listed in the `?` sheet's Extensions tab**, generated from the active manifest. Those
rows carry no `Command['kind']`, exactly as the pointer gestures do not, so `bindings.test.ts`'s coverage
assertion keeps meaning what it meant.

### 13.6 Automation

One action type, forever — an envelope, so the job validator and the job runner are each edited once:

```json
{ "type": "module", "module": "tetravox.seeg", "op": "snap", "args": { "scope": "all", "radiusMm": 1.5 } }
```

`module` must be in `MANIFESTS`, `op` a declared operation, and `args` is checked against its `ArgShape` with
unknown keys rejected — all in **main**, before a window exists. `path`-typed arguments join `jobInputPaths`
so they are allow-listed like every other job input. `job-result.json` gains `modules: [{ id, version }]`;
`JOB_SCHEMA_VERSION` does not move, because an unknown action type was already rejected and a job file that
does not use one is unaffected.

**The manifest is the schema, and two of its types are about files rather than values.** `number`, `string`
and `boolean` (each with an optional `?` form) and `vec3?` are checked exactly as the same shapes are checked
anywhere else in the document. A **`path`** (or `path?`) is an *input*: `${VAR}` is expanded, a relative one
resolves against the job file's directory, main allow-lists it before the window opens, and the extension is
handed the resolved path — the treatment `scene.files` have had since the first job ran, for the reason §5
directive A2 gives, which is that the job file naming a path *is* the user naming it. An **`out`** is a name
under `--out`, held to the same rule every other output name is, and admitted — with that extension's declared
writer siblings (§5 rule 11) — to its module-scoped write list, because a batch run has no Save sheet to open
one with; the extension is handed the resolved path there too, so an operation that saves is written once and
does the same thing from a panel and from a job. An `out` can therefore never name the file the job read: it
is under `--out` and nowhere else, so a first save there mints no `.bak` because there is nothing to back up.

`runOperation`'s return value — a plain JSON object, the extension's own report — is recorded as that action's
`result` in `job-result.json`. Without it a `stats` operation could not exist: a job that can only write files
cannot answer a question.

**Every panel action is also an operation.** That is what keeps §8's "there is no automation-only code path"
literally true for extensions: `ModuleInstance.runCommand` is what a button and a key call, `runOperation` is
what a job calls, and an extension that let them diverge would be shipping two products.

Said precisely, because it is a rule a test enforces rather than an aspiration: **a command that changes the
scene and needs neither a live pointer nor a dialog is an operation of the same id**, and its command and its
operation call the same function. Four kinds of command are exempt, and only these four — one that arms a
pointer mode (`add`), one that opens a file sheet (`save-as`), one that moves the session's own undo stack
(`undo`, `redo`), and one that only moves the selection (`next`, `prev`) — plus a command that *is* another
operation's argument (`snap-all` is `snap` with `scope: "all"`). `modules.test.ts` compares each manifest's
commands-without-an-operation against a written list of exemptions **for equality**, so a scene-mutating
command added without one fails the build until somebody writes the operation or writes down why there
cannot be one. That is what closed the gap `tetravox.seeg` shipped with: `flip-tip`, `revert` and `delete`
were panel-only, and a headless renumber of a shaft whose `tip: 'auto'` heuristic guessed wrong therefore had
no remedy at all (DECISIONS, 2026-08-30).

### 13.7 The checklist for adding one

1. A directory under `packages/app/src/modules/<name>/` with `manifest.ts`, and one under
   `renderer/src/modules/<name>/` with `index.ts` and its panel.
2. One line in `MANIFESTS` and one in `MODULES`.
3. A `## ` section in `docs/USER_GUIDE.md` named by the manifest's `docs`, plus its entry in
   `website/scripts/sync.mjs`'s `GUIDE_PAGES` and the site sidebar. The `docs-guard` CI job fails without them.
4. Keys from §13.5's pool, or none.
5. Tests per §13.4.
6. A `docs/DECISIONS.md` entry for anything the extension decides that a reader would otherwise have to infer.
7. Nothing added to `Shell.tsx`, `Toolbar.tsx`, `keymap.ts`, `StatusBar.tsx` or `controller.ts`. If an extension
   seems to need something there, the host is missing a member — add it to `host.ts` under §12.3's rules.

`tetravox.hello` is the worked example; read it before writing a manifest. An extension that ships **separately**
follows the same list with two substitutions — `@tetravox/module-sdk` in place of the relative imports, and a
URL in place of item 3's guide heading (§13.8, settled decision O3).

### 13.8 Downloadable extensions — the shipped design

**One tier, one mechanism** (the *bundled* tier was removed 2026-08-31 — nothing ships inside the
application): an extension is downloaded, verified and consented to at runtime. It is `manifest.json`
plus `index.js` in a versioned directory, re-hashed before it is allowed to run, reaching the switcher
through the registry.

```
~/.tetravox/modules/<id>/<version>/{manifest.json,index.js,tetravox-module.json}   # installed (TETRAVOX_MODULE_DIR)
packages/app/src/modules/manifest-schema.ts        # the JSON carrier's `tsc`
packages/app/src/main/module-store.ts              # catalogue, install, verify, consent, enable, remove
packages/app/src/renderer/src/modules/installed.ts # the loader
packages/app/src/renderer/src/modules/sdk-runtime.ts  # globalThis.__tetravoxModuleSdk
packages/app/src/renderer/src/dialogs/ExtensionsDialog.tsx  # File ▸ Extensions…
scripts/emit-module-sdk.mjs                        # the SDK an extension repository compiles against
```

**Nothing is reachable until it is consented to.** A downloaded extension sits inert: the renderer cannot name a
path, and `tetravox://module/<id>/<version>/<file>` is served out of a map only `module-store.ts#enableModule()`
fills, after re-hashing every file against the install receipt. So an installed-but-unconsented extension 404s
from the scheme — **consent gates execution, not merely the switcher row** — and `disableModule` is a delete
from that map, effective on the next request. §5 rule 13 and the `script-src` grant are recorded in
`docs/DECISIONS.md`; the grant is a **host source**, because the scheme form would also admit
`tetravox://file/…`.

**The consent sheet is derived, never declared.** `manifest-schema.ts#derivePermissions` reads the manifest
the user is about to run — `readers[].extensions`, the writers' filters and sibling templates,
`commands[].key`, `operations[].id`, `sceneBlock` — so the card, the sheet and what the extension can actually do
cannot disagree. Consent is recorded per **version** in `AppSettings.extensions`; an update is new bytes with
a new list, so it asks again. **Nothing is ever pre-consented**: the bundled tier's "installing the app
was the consent" shortcut left with the tier, and the only writer of a consent record is `enableModule`,
behind the sheet the user answered.

**The loader is one variable dynamic import, and it is fragile on purpose.**
`renderer/src/modules/installed.ts` hoists the URL into a `const` and imports the identifier with
`/* @vite-ignore */`. An inline template is rewritten by Vite into a glob helper; the identifier form *without*
the comment is silently rewritten into `__variableDynamicImportRuntimeHelper` over an **empty** glob, which
rejects every URL with no build warning. `scripts/check-module-loader.mjs` therefore asserts the built chunk
still carries the URL literal, carries a variable `import(x)`, and carries no glob helper. The loaded namespace
is shape-checked before it is registered — a downloaded chunk is not typechecked by our build — and a failure
is a toast plus a failed card, never a broken switcher.

**An extension gets the host's own React through one global.** `renderer/src/modules/sdk-runtime.ts` sets
`globalThis.__tetravoxModuleSdk = { hostVersion, react, ModuleHostError, stemOf, contacts }` at boot, before
anything can activate; `@tetravox/module-sdk`'s runtime shim — **inlined** by the extension's own build, so an
extension bundle has no imports at all — reads it. An extension's `Panel` renders inside the app's React tree, so a
second copy would be an "invalid hook call"; `ModuleHostError` must be the same class or `instanceof` is false
across the boundary; `stemOf` must be the same function or an extension computes a `{stem}` main did not admit.
The alternatives (an inline import map, a served second entry) are compared in `docs/DECISIONS.md`.

**Versioning is a gate, not a hope.** A manifest whose `hostApi` is not `MODULE_HOST_VERSION` is listed,
greyed, and says which host it needs; no registration is built for it, so it cannot reach the switcher or a
job. `InstalledManifest.hostApi` is a `number` precisely so a stale value can be *held* in order to be refused.

**The honest posture.** An enabled extension is **trusted renderer code**: it has the DOM and the whole preload
bridge, and a narrower `allowPath` would not contain a malicious one. The trust boundary is the consent sheet
and the registry's pull-request review — the CSP only stops *unconsented* script. §13.9 is what would move
that boundary.

**The catalogue is refreshed, not frozen** (`main/registry.ts`, 2026-08-31). Until then the only
catalogue was the copy the build shipped, so an extension release was invisible until a *core* release
carried a refreshed copy — publishing a one-line extension fix meant cutting a Tetravox. A launch
refresh (gated by the same `checkForUpdates` preference §12.4 uses) and an Extensions…-open refresh
fetch the curated index and cache it under `userData`; `catalogue()` then prefers dev seam → cache →
shipped copy, and any failure leaves the previous answer standing, so the dialog is still correct with
no network. The fetched copy is trusted less than the shipped one and bounded accordingly:
`registry.ts#validateIndex` shape-checks every id, version, byte count and hash and requires each
`url` to be **https on a GitHub host**, so an index that arrived over the wire cannot point the
downloader at another server; the body is capped and timed out; the cache is re-validated on every
read. Nothing downstream relaxes — `hostApi` still gates, the sheet still shows the *installed*
manifest's derived permissions, and every file is still re-hashed before it is served.

Distribution: the catalogue — `src/shared/extensions-index.json` shipped, the
`idossha/tetravox-extensions` registry live, `TETRAVOX_EXT_INDEX` as the test seam — is the one route
into the app; `scripts/emit-module-sdk.mjs` emits the SDK an extension repository compiles against.

### 13.9 Stage 3, and what it would cost

A **sandboxed tier** — an extension in a Worker with no DOM and a JSON-only host bridge — is described here as
the path and is not built. It needs: the Worker and the bridge (a mechanical `await` pass over the extensions that
exist by then, not a redesign, which is exactly what the sync-plus-lint-wall design buys); a permission model
with *enforcement* rather than only disclosure; a Restricted Mode for a scene that arrives with an unknown
extension; a §5 rule 9 rewrite that makes `allowPath` the last line rather than the first; and a security review
of the whole path. It is 8–9 engineer-days and a different threat model, and nothing in §13.8 prevents it — the
wall on `modules/<id>/**` exists precisely so that day is a port and not a rewrite. It is the tier that would
let an extension be *untrusted*; until it exists, §13.8's posture is stated plainly rather than implied.
