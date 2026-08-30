/**
 * `@tetravox/engine` — the engine facade.
 *
 * This file is `docs/ARCHITECTURE.md` §4.7 verbatim. FROZEN at the end of Phase 0 (§12.3 item 3):
 * changing anything here requires editing `docs/ARCHITECTURE.md` in the same commit and appending a
 * line to `docs/DECISIONS.md`.
 *
 * It imports exactly two things — the §4.1–§4.6 types from `./scene/types` and `Capabilities` from
 * `./gl/caps` (§7.1) — and nothing else.
 *
 * `MockEngine` implements `Engine` with no GL so the app agent can build the entire UI in Phase 1.
 *
 * §4.7 originally required this file to import "exactly two things" — the §4.1-§4.6 types and
 * `Capabilities`. Phase 1 adds a third: `create()` must return a *working* engine synchronously, and
 * the working engine is `./engine`. The alternative was inlining the whole WebGL2 renderer into this
 * frozen file. ARCHITECTURE.md §4.7 was amended in the same commit (§12.3's rule for a frozen file).
 */

import type {
  Annotations,
  Dataset,
  DatasetId,
  DatasetRef,
  Layer,
  LayerId,
  Layout,
  LoadPhase,
  Measurement,
  MeasurementId,
  QualityLevel,
  Scene,
  SliceView,
  TemplateSpace,
  View,
  View3D,
  ViewId,
  ViewSpec,
  vec3,
  // §13's point tool (2026-08-30): a placement template carries a colour.
  vec4,
} from './scene/types';
import type { Capabilities } from './gl/caps';
// Directed task 9 (2026-08-28): the pass-3 chrome palette `setTheme` carries.
import type { OverlayTheme } from './overlay/theme';
import { TetravoxEngine } from './engine';

/** Maps 1:1 onto protocol `LoadSource` (§6.5.1). */
export type DatasetSource =
  | { kind: 'path'; path: string; sidecars?: { lut?: string; opt?: string } }
  | { kind: 'file'; file: File; sidecars?: { lut?: File; opt?: File } }
  | {
      kind: 'bytes';
      name: string;
      bytes: ArrayBuffer;
      sidecars?: { lut?: ArrayBuffer; opt?: ArrayBuffer };
    };

export type NewLayer = { datasetId: DatasetId; kind: Layer['kind'] } & Partial<Layer>;

/** §7.5's `1..6` camera presets: anterior, posterior, left, right, superior, inferior. */
export type CameraPreset = 1 | 2 | 3 | 4 | 5 | 6 | 'A' | 'P' | 'L' | 'R' | 'S' | 'I';

export interface PickResult {
  layerId: LayerId;
  datasetId: DatasetId;
  /** Gmsh element number (§6.2), or plane index for slice quads. */
  elementId: number;
  /**
   * `'slice'` from the layer kind; `'tri'` vs `'tet'` from payload bit 24, written by the shader
   * (§7.2.3).
   */
  elementKind: 'tri' | 'tet' | 'slice';
  world: vec3;
  depth: number;
}

export interface ProbeRow {
  layerId: LayerId;
  layerName: string;
  kind: Layer['kind'];
  voxel?: vec3;
  value?: number | vec3;
  labelId?: number;
  labelName?: string;
  elementId?: number;
  tag?: number;
  tagName?: string;
  fields?: { name: string; value: number | number[] }[];

  // -- surfaces: vertex identity (directed task 8; §3, `docs/DECISIONS.md` 2026-08-28) ----------
  /**
   * The **0-based node index** of the vertex nearest the probe — the row in the file's own pointset,
   * which is what a GIfTI or FreeSurfer vertex id means. Not a Gmsh element number.
   *
   * Present for any mesh layer, and it is the only probe answer a *surface* has: `locate` is a
   * point-in-tetrahedron search, so a 0-tet `.gii` produced no row at all before this.
   */
  vertex?: number;
  /**
   * That vertex's **own** coordinate in world mm — deliberately not the probe point. The two differ
   * by up to half an edge length, and a user quoting "vertex 40188" needs the vertex's coordinate,
   * not where their mouse was.
   */
  vertexWorld?: vec3;
  /**
   * The fsaverage vertex {@link ProbeRow.vertex} corresponds to, and that vertex's coordinate on the
   * fsaverage surface — present only when a subject `sphere.reg` and an fsaverage `sphere` both
   * resolved. The correspondence is nearest-neighbour on the **unit** sphere (§6.3's `sphere_map`).
   */
  fsavgVertex?: number;
  fsavgWorld?: vec3;
  /** Which fsaverage surface {@link ProbeRow.fsavgWorld} is on, e.g. `fsaverage lh.pial`. */
  fsavgSpace?: string;
}

export interface ProbeResult {
  world: vec3;
  /**
   * The **affine** template coordinate, unchanged since Phase 2: `toTemplate.matrix · world`.
   * Present only when some volume carries an affine `toTemplate` ({@link TemplateSpace.hasAffine}).
   */
  mni?: vec3;
  rows: ProbeRow[];

  // -- directed task 8, appended (§3 / §4.7; `docs/DECISIONS.md` 2026-08-28) --------------------
  /**
   * FreeSurfer **tkr-RAS** of the cursor, in the space of {@link ProbeResult.tkrVolume}.
   *
   * Named alongside its volume because `vox2ras-tkr` is built from dims and spacing alone: the same
   * subject's 1 mm `T1.nii.gz` and 0.5 mm `T1_upsampled.nii.gz` are *different* tkr spaces, so a
   * tkr triple with no volume attached is not a coordinate, it is a guess.
   */
  tkr?: vec3;
  /** The volume whose tkr space {@link ProbeResult.tkr} is in — the active layer's, else the top one. */
  tkrVolume?: string;
  /**
   * MNI through the **nonlinear** SimNIBS field (`toMNI/Conform2MNI_nonl.nii.gz`), when one is
   * loaded. Distinct from {@link ProbeResult.mni}, which is the affine answer: the two disagree by
   * centimetres in the temporal lobes and a readout that merged them would be lying about which one
   * the user is quoting.
   */
  mniNonlinear?: vec3;
}

/**
 * A coordinate space the cursor can be **read in and typed in** (§8's space selector, directed
 * task 8).
 *
 * Every space except `'world'` is relative to something: a voxel index and a tkr-RAS triple belong
 * to one *volume*, and an MNI triple belongs to one *subject's* registration. That is why the ids
 * are part of the reference rather than implied by "the active layer" — the app renders a menu of
 * these, and a menu entry has to survive the active layer changing under it.
 */
export type CoordSpaceRef =
  | { space: 'world' }
  | { space: 'voxel'; datasetId: DatasetId }
  | { space: 'tkr'; datasetId: DatasetId }
  /** `toTemplate.matrix · world` — the affine registration. */
  | { space: 'mni-affine'; datasetId: DatasetId }
  /** A trilinear sample of the SimNIBS deformation field. */
  | { space: 'mni-nonlinear'; datasetId: DatasetId };

/** One entry of the space selector: what to call it, whether it can be used, and why not. */
export interface CoordSpaceOption {
  ref: CoordSpaceRef;
  /** Menu label, e.g. `World RAS`, `Voxel · T1`, `tkr-RAS · T1`, `MNI (nonlinear)`. */
  label: string;
  /** How many decimals the readout uses — 0 for a voxel index, 1 for millimetres (§8's format). */
  decimals: number;
  /**
   * False when the space is offered but not usable yet — its deformation field is still loading, or
   * the subject has no affine at all. `reason` says which, and §8's selector shows the option greyed
   * with the reason on it rather than hiding it: a column that silently disappears reads as a bug.
   */
  enabled: boolean;
  reason?: string;
  /** True while the space's deformation field is being loaded, so the app can show a spinner. */
  loading?: boolean;
}

/**
 * What {@link Engine.attachFsaverage} needs (directed task 8).
 *
 * Every id is an ordinary loaded dataset. The subject's `sphere.reg` and the displayed surface must
 * share a node numbering — they do, for every surface of one hemisphere of one subject
 * (`lh.central.gii`, `lh.pial.gii` and `lh.sphere.reg.gii` all carry 245,762 nodes `[DATA]`) — and
 * the engine checks it rather than trusting it.
 */
export interface FsaverageSpec {
  /** The subject surface being looked at, e.g. `lh.central.gii`. */
  surfaceId: DatasetId;
  /** That hemisphere's registered sphere, e.g. `lh.sphere.reg.gii`. */
  subjectSphereId: DatasetId;
  /** The fsaverage sphere, e.g. `fsaverage/surf/lh.sphere`. */
  fsavgSphereId: DatasetId;
  /** The fsaverage surface whose coordinate is quoted, e.g. `fsaverage/surf/lh.pial`. */
  fsavgSurfaceId?: DatasetId;
  /** What to call the target in the readout, e.g. `fsaverage lh.pial`. */
  targetName?: string;
}

/**
 * One row of the `labelCentroids` op (§6.5.2), as §8's region panel reads it.
 *
 * `count` is the region's voxel count and `centroid` its centre of mass in world RAS — R5's row
 * count and its double-click target. Both are computed in the dataset's worker: §4.3 keeps
 * `VolumeDataset.data` on the UI thread "for probes only", and a scan of 256×256×208 voxels is not
 * a probe.
 */
export interface LabelCentroid {
  id: number;
  centroid: vec3;
  count: number;
}

export interface ScreenshotOptions {
  target: 'view' | 'grid';
  viewId?: ViewId;
  width?: number;
  height?: number;
  scale?: number;
  /** Written to the PNG `pHYs` chunk. */
  dpi?: number;
  background: 'scene' | 'white' | 'black' | 'transparent';
  include: {
    colorbar: boolean;
    orientationLabels: boolean;
    crosshair: boolean;
    cornerInfo: boolean;
    scaleBar: boolean;
    /**
     * The 3D pane's orientation cube (§4.5's `Annotations.orientationCube`, directed task 10).
     *
     * Additive, like every other member of this block: a caller written before the cube existed
     * omits it, and TypeScript makes that a compile error rather than a silently different picture —
     * which is what an `include` map is for. `automation/run.ts` defaults it to the annotation's own
     * default (off).
     */
    orientationCube: boolean;
  };
  autoTrim: boolean;
}

/**
 * §8's progress for a volume layer's **3D surface** (§4.4's `VolumeLayer.iso3d`, directed task 2).
 *
 * `total` is how many surfaces the layer owns — one for a scalar volume, one per visible region for
 * a label volume — and `pending` how many of those are still in marching cubes. `{0, 0}` for a layer
 * that owns none, so a caller needs no null check.
 */
export interface Iso3dStatus {
  pending: number;
  total: number;
}

/**
 * A measurement to place — {@link Engine.addMeasurement}'s argument (directed task 11).
 *
 * `id` and `name` are the engine's to assign (`M1`, `M2`, … — the first name not taken), so a host
 * that adds one programmatically writes exactly the two things a measurement *is*: what kind it is
 * and where its points are.
 */
export interface NewMeasurement {
  kind: Measurement['kind'];
  points: vec3[];
  name?: string;
  color?: Measurement['color'];
  viewId?: ViewId;
}

export interface LoadProgress {
  datasetId: DatasetId;
  phase: LoadPhase;
  done: number;
  total: number;
}

// -----------------------------------------------------------------------------------------------
// §13's point tool (2026-08-30 — see `docs/DECISIONS.md`). Appended, additive: absent, every member
// below is unarmed and the engine behaves exactly as it did.
// -----------------------------------------------------------------------------------------------

/**
 * What {@link Engine.setPointTool} arms — one layer, one mode, and what a placed point starts as.
 *
 * One **layer**, not one kind: §4.4's answer to twelve electrodes is one `PointsLayer` holding
 * twelve `group`s, so a tool that edits "the contacts" edits one layer, and a scene may hold a
 * second points layer (a net, a set of ROI centres) that the tool must not touch.
 */
export interface PointToolSpec {
  layerId: LayerId;
  /**
   * `'place'` — **every** left click appends a point, with no hit test first. `'select'` — a click
   * grabs the point under it and drags it; a click on nothing does nothing.
   *
   * Place mode does not hit-test on purpose. Contacts sit at a 3.5 mm pitch, about five pixels
   * apart at a default zoom, and the click that matters most is the one filling the gap *between*
   * two contacts that were found — which a hit-first rule would answer by selecting a neighbour.
   */
  mode: 'select' | 'place';
  /** Fields a placed point starts with; `position` and `id` are the engine's. */
  template?: { color?: vec4; radiusMm?: number; group?: string };
}

/**
 * Which point is selected — by **id**, with the array index alongside it as a convenience.
 *
 * The id is the identity (§4.4) and the index is the frame's key: deleting the second of twelve
 * contacts renumbers ten of them, so a selection held as an index would silently move to the
 * neighbour. Everything that outlives one call — the selection itself, an undo step, a module's
 * table row — is addressed by `pointId`; `index` is what the same call's `points[]` lookup is.
 */
export interface PointSelection {
  layerId: LayerId;
  pointId: string;
  index: number;
}

/**
 * What the tool did — {@link EngineEvents.pointTool}.
 *
 * * `placed` — a click in `place` mode appended a point; it is also now the selection. `world` is
 *   where it landed and `viewId` which pane the click was in.
 * * `selected` — a point became the selection, from a click or from {@link Engine.setPointSelection}.
 * * `dragEnd` — a `select`-mode drag finished, **once**, however it ended (pointer up, cancel, a
 *   second finger). The scene has already moved: the drag wrote every intermediate position, so
 *   this is the commit point, not the change.
 * * `cleared` — there is no selection any more: `Esc`, an explicit `null`, or the selected id
 *   disappearing from a replaced `points` array. `pointId` is `null` and `index` is `-1`.
 */
export interface PointToolEvent {
  layerId: LayerId;
  kind: 'placed' | 'selected' | 'dragEnd' | 'cleared';
  pointId: string | null;
  index: number;
  world?: vec3;
  viewId?: ViewId;
}

export interface EngineEvents {
  cursor: vec3;
  hover: vec3 | null;
  pick: PickResult | null;
  /**
   * An **asynchronous** probe row landed for a point that is still the cursor or the hover
   * (directed task 8).
   *
   * §4.7 has always said a mesh probe is "at most one round trip stale": `probe` is synchronous,
   * `locate` and `nearestVertex` are worker calls, so the row the `cursor` event's `probe` returned
   * is the one from *before* the click. Until now nothing told the app when the real one arrived, so
   * §8's info panel showed a mesh row only after a second interaction — and for a surface, whose
   * only row is the vertex, it showed nothing at all.
   *
   * Deliberately its own event rather than a second `cursor`: the app's `cursor` handler also
   * clears the coordinate bar's draft, and a probe landing must not delete what a user is typing.
   */
  probe: { world: vec3; result: ProbeResult };
  layers: Layer[];
  datasets: Dataset[];
  /**
   * `Scene.measurements` changed (directed task 11) — one was placed, deleted, promoted to an
   * angle, or replaced wholesale by a scene load.
   *
   * Its own event rather than a flag on `layers`, for the reason `probe` is its own event: §8's
   * measurement panel is the only thing that re-renders on it, and folding it into `layers` would
   * rebuild the layer panel every time a click lands in measure mode.
   */
  measurements: Measurement[];
  /**
   * §13's point tool did something (2026-08-30).
   *
   * Its own event and not a flag on `layers`, for the reason `measurements` is its own event: a
   * points edit fires `layers` too — the tool moves a point by replacing the array through
   * `updateLayer` — and an editor that rebuilt its table on `layers` would rebuild it sixty times a
   * second during a drag. This says what happened, once, and `dragEnd` says when it is over.
   */
  pointTool: PointToolEvent;
  progress: LoadProgress;
  frame: { viewId: ViewId; cpuMs: number; gpuMs?: number; quality: QualityLevel['name'] };
  quality: QualityLevel;
  error: { code: string; message: string; datasetId?: DatasetId };
}

export interface EngineOptions {
  dpr?: number;
  /** Fixed clock, no timer query, sync render (§11). */
  deterministic?: boolean;
  /** §7.4 fallback-path test axis. */
  forceDiscardClip?: boolean;
  /** §7.1 test axis; may only REMOVE a capability, never add one. */
  forceCaps?: Partial<Pick<Capabilities, 'norm16' | 'floatLinear' | 'clipDistance' | 'timerQuery'>>;
  aa?: 'auto' | 'off';
}

export interface Engine {
  /** §7.1 */
  readonly caps: Capabilities;
  readonly scene: Readonly<Scene>;
  readonly views: ReadonlyArray<View>;

  addDataset(src: DatasetSource): Promise<Dataset>;
  /** Terminates that dataset's worker (§5). */
  removeDataset(id: DatasetId): void;
  /** Cancels an in-flight load. */
  cancelDataset(id: DatasetId): void;

  addLayer(spec: NewLayer): Layer;
  removeLayer(id: LayerId): void;
  updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void;
  reorderLayers(order: LayerId[]): void;
  setActiveLayer(id: LayerId | null): void;

  setCursor(world: vec3): void;
  /** ±1 voxel along the view normal (§7.5). */
  stepCursor(viewId: ViewId, steps: number): void;
  /**
   * §7.5's "arrows nudge the cursor": ±1 step **in the view plane**, along that pane's `right` and
   * `up`, radiological flag included (§4.7 / §7.5, added 2026-08-27 — see `docs/DECISIONS.md`).
   *
   * Distinct from {@link Engine.stepCursor}, which steps along the plane **normal** (PgUp / PgDn and
   * the wheel). §7.5 lists the two bindings separately; giving both to `stepCursor` made all four
   * arrows change the slice. The app may not compute the basis itself (§8: no logic in React), so
   * the in-plane step has to be an engine member.
   */
  nudgeCursor(viewId: ViewId, dx: number, dy: number): void;
  setLayout(layout: Layout): void;
  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void;
  setRadiological(on: boolean): void;

  pick(viewId: ViewId, px: number, py: number): PickResult | null;
  /**
   * §7.4's contour pick: the surface layer whose 2D contour is under this pane pixel, or `null`.
   *
   * Not part of `pick` because it is not the pick pass — a contour is a screen-space quad in the
   * derived pass, and this is a CPU nearest-segment test over the segments the last frame drew.
   * `setCursorFromScreen` calls it, so a plain left-click on an outline selects its layer.
   */
  contourAtScreen(viewId: ViewId, px: number, py: number): LayerId | null;
  setCursorFromPick(viewId: ViewId, px: number, py: number): boolean;
  probe(world: vec3): ProbeResult;

  // -- measurements (directed task 11; §4.5, §7.5, §8; `docs/DECISIONS.md` 2026-08-28) ----------
  /**
   * §7.5's measure mode: while it is on, a left-click in any pane places a measurement point
   * instead of setting the cursor.
   *
   * The mode is the engine's, not the app's, and that is forced by where the click has to be turned
   * into a **world** point: in a 2D pane it is the pointer ray ∩ that view's derived plane, in a 3D
   * pane it is `pick`. §8's "no logic in React" and §5's worker rules both put that here — the app
   * owns the toolbar button and nothing else. Turning it off abandons any half-placed measurement,
   * so a mode toggle can never leave a dangling point behind.
   */
  setMeasureMode(on: boolean): void;
  /** Whether measure mode is on, for §8's `aria-pressed`. */
  measureMode(): boolean;
  /**
   * Place a measurement from world points — the programmatic twin of the clicks, and what §11's
   * analytic test asserts the click path against.
   *
   * Returns the measurement as stored, with the id and the name the engine assigned.
   */
  addMeasurement(spec: NewMeasurement): Measurement;
  /** Delete one — §8's panel row delete button. A no-op for an id nothing answers to. */
  removeMeasurement(id: MeasurementId): void;
  /** `Esc`: abandon the measurement being placed. Nothing already placed is touched. */
  cancelMeasurement(): void;

  // -- §13's point tool (2026-08-30; §4.4, §7.5, §13; `docs/DECISIONS.md`) ----------------------
  /**
   * Arm — or disarm, with `null` — the point tool on one points layer (§7.5).
   *
   * **At most one click-consuming mode is armed.** Arming this disarms measure mode and
   * {@link Engine.setMeasureMode} disarms this, because both of them take the left click away from
   * the cursor and a user cannot be told which one a click went to.
   *
   * Arming also **materialises point ids**: a layer whose `points[]` carry none gets `p<index>` on
   * every one of them, so that from here on the tool, the selection and the scene file all name the
   * same contact by the same string (§4.4).
   *
   * Disarming clears the selection and the hover, and emits `cleared`.
   */
  setPointTool(spec: PointToolSpec | null): void;
  /** What is armed, or `null` — §8's `aria-pressed`, and a module reading its own mode back. */
  pointTool(): PointToolSpec | null;
  /**
   * Which point a pane pixel would grab, without grabbing it — `px`/`py` in **CSS pixels**, like
   * {@link Engine.pick}.
   *
   * The `select`-mode hit rule exactly: on-slice only (**a ghost is never hit** — it is a
   * projection of a point on another slice), within `max(disc, 8 px)` of the disc the pane actually
   * drew, nearest wins; in the 3D pane the nearest projected centre within 14 px. Restricted to the
   * armed layer while a tool is armed, and over every visible points layer otherwise.
   */
  pointAtScreen(viewId: ViewId, px: number, py: number): PointSelection | null;
  /**
   * Select a point by **id**, or clear the selection with `null`. Emits `selected` / `cleared`.
   *
   * By id and not by index because the selection has to survive the edit that follows it: a module
   * that deletes a contact and replaces `points` finds its selection re-resolved, or cleared with a
   * `cleared` event — never silently pointing at the neighbour.
   */
  setPointSelection(sel: { layerId: LayerId; pointId: string } | null): void;
  /** The selection, resolved against the current `points[]`, or `null`. */
  pointSelection(): PointSelection | null;

  // -- coordinate spaces (directed task 8; §3, §8; `docs/DECISIONS.md` 2026-08-28) --------------
  /**
   * Every space the cursor can currently be read in, in menu order (§8's space selector).
   *
   * On the facade rather than in the app because every entry is engine geometry: which volume is
   * active, what its `vox2ras-tkr` is, and whether a subject's deformation field has finished
   * loading. §8's "everything the UI can do must be reachable from the `Engine` API alone. No logic
   * in React" is the rule this exists to keep.
   */
  coordinateSpaces(): CoordSpaceOption[];
  /**
   * World RAS mm → `ref`'s space. `null` when the reference no longer resolves (the dataset was
   * closed, the field is still loading) — never a silently wrong triple.
   */
  toSpace(ref: CoordSpaceRef, world: vec3): vec3 | null;
  /** `ref`'s space → world RAS mm, for typed entry and paste. `null` on the same terms. */
  fromSpace(ref: CoordSpaceRef, value: vec3): vec3 | null;
  /**
   * Attach (or clear, with `null`) a template registration to a volume — a SimNIBS `toMNI/` folder
   * the host discovered on disk, with its deformation fields already loaded as datasets.
   *
   * The engine cannot find these itself: §5 keeps the filesystem in the Electron main process, and
   * a `toMNI/` folder is *beside* the volume rather than inside it, so nothing on the load path ever
   * sees it. The host discovers, loads the fields through the ordinary `addDataset`, and hands the
   * result back here.
   */
  setTemplateSpace(datasetId: DatasetId, space: TemplateSpace | null): void;
  /**
   * Build the **fsaverage correspondence** for a subject surface, so a pick on it reports an
   * fsaverage vertex as well as its own (§3, directed task 8).
   *
   * Four datasets, all already loaded through the ordinary `addDataset`: the surface being looked
   * at, the subject hemisphere's registered sphere, the fsaverage sphere, and (optionally) the
   * fsaverage surface whose coordinates are quoted. Resolves `true` when a correspondence was
   * built, `false` when it could not be — a node-count mismatch between the sphere and the surface,
   * a dataset that is not a mesh, a worker that has gone. **Never throws**: nothing is bundled, so
   * "there is no fsaverage here" is the ordinary case and must not be an error.
   *
   * It is an engine member rather than app code because the three ops it composes (`vertices`,
   * `sphereMap`, `vertices`) are §6.5 worker calls, and §5 rule 3 keeps the app off that path
   * entirely. The fsaverage sphere's directions and the resulting map are cached per dataset pair,
   * so a second surface of the same hemisphere costs nothing.
   *
   * `{ surfaceId, clear: true }` drops the correspondence attached to that surface.
   */
  attachFsaverage(spec: FsaverageSpec | { surfaceId: DatasetId; clear: true }): Promise<boolean>;

  /**
   * §8's region panel: every label of a label-volume layer, with its voxel count and world centroid
   * (§4.7 / §6.5.2's `labelCentroids`, added 2026-08-27 — see `docs/DECISIONS.md`).
   *
   * R5 asks each row for a count and makes a double-click jump to the region's centroid. The op has
   * existed since Phase 1 and had no producer on this facade, so the panel could only render `—`.
   * It is a member rather than something the app computes because §4.3 forbids the app from
   * scanning `VolumeDataset.data` and §8 forbids the logic being in React either way.
   *
   * Resolves to `[]` for a layer that is not a label volume, or whose dataset is gone. The result is
   * cached per `(dataset, volumeIndex)`: the op costs one pass over the volume and a label map does
   * not change under a layer.
   */
  labelCentroids(layerId: LayerId): Promise<LabelCentroid[]>;

  /** §7.5 `r`: refit a view to the scene bounds. Engine maths, not the embedder's (§8). */
  resetView(viewId: ViewId): void;
  /** §7.5 `1..6`: the A/P/L/R/S/I camera presets on the 3D view. */
  cameraPreset(viewId: ViewId, preset: CameraPreset): void;
  /** §7.5 `c` and the rest of the §4.5 `Annotations` block; `conventionBadge` stays true (§8). */
  setAnnotations(patch: Partial<Annotations>): void;
  /**
   * The colours §7.2's pass-3 chrome is drawn in — orientation letters, corner info, the RAD/NEU
   * badge, the crosshair, the colour bar's text/ticks/frame, the label halo and the cut-plane gizmo
   * (§4.7 / §7.2, added 2026-08-28 — see `docs/DECISIONS.md`).
   *
   * The neighbour of {@link Engine.setAnnotations}, which says *which* chrome is drawn: this says
   * what colour it is. §8's theme switch needs both, or the panels flip to a light theme and the
   * letters stay near-white with a black halo over a white pane — the halo has to **invert**, and
   * nothing outside the engine can reach it.
   *
   * A patch over the current theme. `background` is forwarded to `Scene.background`; leave it out
   * and the viewport keeps whatever it had, which is what an embedder following imaging convention
   * (dark panes in every theme) wants. Defaults are `DEFAULT_OVERLAY_THEME` — the constants §11's
   * goldens were captured with.
   */
  setTheme(patch: Partial<OverlayTheme>): void;
  /** §8 status bar: wasm `heapBytes` from that dataset's last `Res` (§6.5.2). */
  heapBytes(id: DatasetId): number | undefined;
  /**
   * §8's load-card progress for a volume layer's 3D surface (§4.7, added 2026-08-28 — see
   * `docs/DECISIONS.md`).
   *
   * Marching cubes over 256×256×208 is not instant, and a label volume asks for one op per visible
   * region, so the **3D surface** switch needs the progress state §8 already gives a mesh layer's
   * async switches. It is a facade member for the same reason `meshLayerLoading` is engine-side: the
   * app cannot see the worker, and §8 forbids it deriving the answer.
   */
  iso3dStatus(layerId: LayerId): Iso3dStatus;

  requestRender(viewId?: ViewId): void;
  /** Draw now, synchronously, instead of at the next rAF — §11's readback and the screenshot path. */
  renderNow(): void;
  /** §7.2 — every golden test awaits this. */
  whenSettled(): Promise<void>;
  screenshot(opts: ScreenshotOptions): Promise<Blob>;
  /** RGBA8, backs `expectPixel` (§11). */
  readPixel(viewId: ViewId, px: number, py: number): Uint8Array;

  serialize(): ViewSpec;
  /**
   * Where the scene file is about to be written, for §4.6's "paths **relative to the scene file**".
   *
   * **Optional on the facade** (appended by directed task 13, 2026-08-28; `docs/DECISIONS.md`).
   * `serialize()` takes no argument and is frozen, so the one thing the engine cannot derive is told
   * to it instead — and a host that never calls this still gets a spec whose relative paths are
   * measured from the datasets' own common directory, plus an `absPath` on every ref. Optional
   * rather than required because the §11 `MockEngine` has no dataset paths to be relative to and
   * nothing to do with the answer.
   */
  setSceneDir?(dir: string | null): void;
  load(spec: ViewSpec, resolve: (r: DatasetRef) => string | null): Promise<void>;

  on<E extends keyof EngineEvents>(e: E, cb: (p: EngineEvents[E]) => void): () => void;
  destroy(): void;
}

export function create(canvas: HTMLCanvasElement, opts?: EngineOptions): Engine {
  // The implementation lives in `./engine`. This file stays the facade plus `MockEngine`; the one
  // value import at the top is what §4.7 was amended for (see docs/DECISIONS.md, 2026-08-27).
  return new TetravoxEngine(canvas, opts);
}

/**
 * A no-GL `Engine` (§4.7, §12.3 item 3).
 *
 * It is deliberately a `class` and not an object literal: `class MockEngine implements Engine` is a
 * **compile-time proof that the facade is implementable without GL**, and it is what fails the build
 * the moment `Engine` grows a member nothing can satisfy. That is its whole job — every member
 * throws, and the *behavioural* no-GL engine the app is developed against is
 * `packages/app/src/renderer/src/engine/mockEngine.ts`'s `NoGlEngine`, which implements the same
 * interface for real.
 */
export class MockEngine implements Engine {
  get caps(): Capabilities {
    throw new Error('phase 1');
  }
  get scene(): Readonly<Scene> {
    throw new Error('phase 1');
  }
  get views(): ReadonlyArray<View> {
    throw new Error('phase 1');
  }

  addDataset(src: DatasetSource): Promise<Dataset> {
    void src;
    throw new Error('phase 1');
  }
  removeDataset(id: DatasetId): void {
    void id;
    throw new Error('phase 1');
  }
  cancelDataset(id: DatasetId): void {
    void id;
    throw new Error('phase 1');
  }

  addLayer(spec: NewLayer): Layer {
    void spec;
    throw new Error('phase 1');
  }
  removeLayer(id: LayerId): void {
    void id;
    throw new Error('phase 1');
  }
  updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void {
    void id;
    void patch;
    throw new Error('phase 1');
  }
  reorderLayers(order: LayerId[]): void {
    void order;
    throw new Error('phase 1');
  }
  setActiveLayer(id: LayerId | null): void {
    void id;
    throw new Error('phase 1');
  }

  setCursor(world: vec3): void {
    void world;
    throw new Error('phase 1');
  }
  stepCursor(viewId: ViewId, steps: number): void {
    void viewId;
    void steps;
    throw new Error('phase 1');
  }
  nudgeCursor(viewId: ViewId, dx: number, dy: number): void {
    void viewId;
    void dx;
    void dy;
    throw new Error('phase 1');
  }
  setLayout(layout: Layout): void {
    void layout;
    throw new Error('phase 1');
  }
  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void {
    void id;
    void patch;
    throw new Error('phase 1');
  }
  setRadiological(on: boolean): void {
    void on;
    throw new Error('phase 1');
  }

  pick(viewId: ViewId, px: number, py: number): PickResult | null {
    void viewId;
    void px;
    void py;
    throw new Error('phase 1');
  }
  contourAtScreen(viewId: ViewId, px: number, py: number): LayerId | null {
    void viewId;
    void px;
    void py;
    throw new Error('phase 1');
  }
  setCursorFromPick(viewId: ViewId, px: number, py: number): boolean {
    void viewId;
    void px;
    void py;
    throw new Error('phase 1');
  }
  probe(world: vec3): ProbeResult {
    void world;
    throw new Error('phase 1');
  }
  setMeasureMode(on: boolean): void {
    void on;
    throw new Error('phase 1');
  }
  measureMode(): boolean {
    throw new Error('phase 1');
  }
  addMeasurement(spec: NewMeasurement): Measurement {
    void spec;
    throw new Error('phase 1');
  }
  removeMeasurement(id: MeasurementId): void {
    void id;
    throw new Error('phase 1');
  }
  cancelMeasurement(): void {
    throw new Error('phase 1');
  }
  // §13's point tool (2026-08-30). Every member throws, like the rest of this class: its job is to
  // be a compile-time proof that the facade is implementable without GL. The *behavioural* no-GL
  // point tool is `packages/app`'s `NoGlEngine`, which the app's e2e drives for real.
  setPointTool(spec: PointToolSpec | null): void {
    void spec;
    throw new Error('phase 1');
  }
  pointTool(): PointToolSpec | null {
    throw new Error('phase 1');
  }
  pointAtScreen(viewId: ViewId, px: number, py: number): PointSelection | null {
    void viewId;
    void px;
    void py;
    throw new Error('phase 1');
  }
  setPointSelection(sel: { layerId: LayerId; pointId: string } | null): void {
    void sel;
    throw new Error('phase 1');
  }
  pointSelection(): PointSelection | null {
    throw new Error('phase 1');
  }
  coordinateSpaces(): CoordSpaceOption[] {
    throw new Error('phase 1');
  }
  toSpace(ref: CoordSpaceRef, world: vec3): vec3 | null {
    void ref;
    void world;
    throw new Error('phase 1');
  }
  fromSpace(ref: CoordSpaceRef, value: vec3): vec3 | null {
    void ref;
    void value;
    throw new Error('phase 1');
  }
  setTemplateSpace(datasetId: DatasetId, space: TemplateSpace | null): void {
    void datasetId;
    void space;
    throw new Error('phase 1');
  }
  attachFsaverage(spec: FsaverageSpec | { surfaceId: DatasetId; clear: true }): Promise<boolean> {
    void spec;
    throw new Error('phase 1');
  }
  labelCentroids(layerId: LayerId): Promise<LabelCentroid[]> {
    void layerId;
    throw new Error('phase 1');
  }

  resetView(viewId: ViewId): void {
    void viewId;
    throw new Error('phase 1');
  }
  cameraPreset(viewId: ViewId, preset: CameraPreset): void {
    void viewId;
    void preset;
    throw new Error('phase 1');
  }
  setAnnotations(patch: Partial<Annotations>): void {
    void patch;
    throw new Error('phase 1');
  }
  setTheme(patch: Partial<OverlayTheme>): void {
    void patch;
    throw new Error('phase 1');
  }
  iso3dStatus(layerId: LayerId): Iso3dStatus {
    void layerId;
    throw new Error('phase 1');
  }
  heapBytes(id: DatasetId): number | undefined {
    void id;
    throw new Error('phase 1');
  }

  requestRender(viewId?: ViewId): void {
    void viewId;
    throw new Error('phase 1');
  }
  renderNow(): void {
    throw new Error('phase 1');
  }
  whenSettled(): Promise<void> {
    throw new Error('phase 1');
  }
  screenshot(opts: ScreenshotOptions): Promise<Blob> {
    void opts;
    throw new Error('phase 1');
  }
  readPixel(viewId: ViewId, px: number, py: number): Uint8Array {
    void viewId;
    void px;
    void py;
    throw new Error('phase 1');
  }

  serialize(): ViewSpec {
    throw new Error('phase 1');
  }
  load(spec: ViewSpec, resolve: (r: DatasetRef) => string | null): Promise<void> {
    void spec;
    void resolve;
    throw new Error('phase 1');
  }

  on<E extends keyof EngineEvents>(e: E, cb: (p: EngineEvents[E]) => void): () => void {
    void e;
    void cb;
    throw new Error('phase 1');
  }
  destroy(): void {
    throw new Error('phase 1');
  }
}
