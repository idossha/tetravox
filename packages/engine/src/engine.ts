/**
 * The §4.7 `Engine`, implemented over WebGL2 and one dataset worker per dataset (§5 rule 1).
 *
 * The rules this file is the enforcement point for:
 * * **The UI thread never parses and never runs geometry** (§5 rule 7, AGENTS rule 7). Every array
 *   this file uploads arrived from a worker as a transferable; nothing here de-indexes, generates a
 *   normal, or expands a vertex buffer.
 * * **Raw file bytes never touch the UI thread**: a `DatasetSource` becomes a protocol `LoadSource`
 *   and the worker does the reading. The one bulk array that comes *back* is `VolumeDataset.data`,
 *   which §4.3 keeps on the UI thread for probes and never re-sends.
 * * **`requestRender` never renders synchronously** (§7.2). It sets a dirty bit; one `rAF` per
 *   engine drains all of them and renders each dirty view at most once. Worker results mutate scene
 *   state and call `requestRender()`; they never draw.
 * * **Cancellation is `worker.terminate()`** (§5 rule 6) — there is no abort flag to poll, because
 *   the app is not cross-origin isolated and `SharedArrayBuffer` does not exist.
 */

import { ComputeClient } from '@tetravox/wasm';
import type {
  GeoPayloadT,
  GpuCapsT,
  MeshMeta,
  SurfacePayload,
  VolumeMeta,
} from '@tetravox/protocol';
import type {
  CoordSpaceOption,
  CoordSpaceRef,
  DatasetSource,
  FsaverageSpec,
  Engine,
  EngineEvents,
  EngineOptions,
  Iso3dStatus,
  LabelCentroid,
  LoadProgress,
  NewLayer,
  PickResult,
  ProbeResult,
  ProbeRow,
  ScreenshotOptions,
} from './api';
import { applyForcedCaps } from './gl/caps';
import type { Capabilities } from './gl/caps';
import { createContext } from './gl/context';
import { MAX_CLIP_PLANES } from './gl/state';
import { Timer } from './gl/timer';
import { capKey, GpuStore, surfaceKey } from './render/gpu';
import { Renderer } from './render/renderer';
import {
  OPAQUE_BLACK,
  OPAQUE_WHITE,
  composeScreenshot,
  encodeImage,
  frameImage,
  matteOverBlackAndWhite,
  screenshotAnnotations,
  screenshotPlan,
} from './render/screenshot';
import type { Image } from './render/screenshot';
import type { DrawInput } from './render/renderer';
import { CutManager, CUT_KEY_3D_CLIP } from './compute/cut-manager';
import { MeshLayerRuntime } from './layers/mesh';
import type { MeshEmphasis, MeshScaleInfo } from './layers/mesh';
import { createLayerRuntime } from './layers/registry';
import { createIso3dRuntime, derivedIsoLayers } from './layers/iso3d';
import type { Iso3dLayerRuntime } from './layers/iso3d';
import { DerivedStore } from './derived/store';
import { readGlyphInstances } from './derived/glyph-readback';
import type { GlyphInstance } from './derived/glyph-readback';
import { VolumeLayerRuntime, buildLabelPalette } from './layers/volume';

import type { LayerRuntime, LayerRuntimeContext } from './layers/runtime';
import { transformPoint } from './view/m4';
import {
  coordinateSpaceOptions,
  fromSpace as fromCoordSpace,
  probeSpaces,
  toSpace as toCoordSpace,
} from './view/coord-spaces';
import { viewports } from './view/layout';
import type { ViewportRect } from './view/layout';
import {
  camera3dMatrices,
  effectiveSliceView,
  fitCamera,
  fitMmPerPx,
  paneToWorld,
  planeAnchor,
  planeFromPoints,
  presetNormal,
  presetRotation,
  presetUp,
  rotatePlane,
  sliceBasis,
  slicePlane,
  snapAlong,
  stepMm,
} from './view/geometry';
import {
  adaptiveLevel,
  dolly,
  FRAME_WINDOW,
  InteractionState,
  mmPerPx3D,
  opacityAfterDrag,
  orbit,
  pan3D,
  panBy,
  PointerLayer,
  QUALITY_LEVELS,
  windowLevel,
  zoomAbout,
  zoomAboutCentre,
} from './input';
import { DEFAULT_OVERLAY_THEME, gizmoHandleAt, resolveOverlayTheme } from './overlay';
import type { GizmoHandle, GizmoSpec, OverlayTheme } from './overlay';
import type { PaneHit, PointerHost } from './input';
import { applyAffine, meshDatasetFromMeta, volumeDatasetFromMeta } from './scene/fromMeta';
import { defaultLayerFor, seedMeshLayerFromOpt, VIEW3D_ID } from './scene/defaults';
import type { MshOptSeed } from './scene/defaults';
import { SceneStore, isSliceView } from './scene/store';
import {
  applyViewSpec,
  fingerprintFromMeta,
  isRestorableKind,
  migrateViewSpec,
  remapLayer,
  sidecarPathsFor,
  toViewSpec,
} from './scene/serialize';
import type { SidecarPaths } from './scene/serialize';
import { looksLikeVolume, meshFormatFor, sourceName, toLoadSource } from './datasets/source';
import type {
  Annotations,
  Dataset,
  DatasetId,
  DatasetRef,
  Layer,
  LayerId,
  mat4,
  MeshDataset,
  MeshLayer,
  QualityLevel,
  Scale,
  Scene,
  SliceMode,
  SliceView,
  Stats,
  TemplateSpace,
  vec3,
  vec4,
  View,
  View3D,
  ViewId,
  ViewSpec,
  VolumeDataset,
  VolumeLayer,
} from './scene/types';

type Listener = (payload: never) => void;

/**
 * The gizmo's ring radius, as a fraction of the scene's bounding-box diagonal.
 *
 * A fraction rather than a fixed millimetre count because the same gizmo has to be grabbable on a
 * 250 mm head and on an 8 mm fixture; 0.22 of the diagonal is about a third of the way to the edge
 * of a fitted 3D view, which leaves the handles clear of both the geometry and the pane's chrome.
 */
const GIZMO_RADIUS_FRACTION = 0.22;
/** Radians per device pixel of a rotate-handle drag. A 180 degree turn is ~350 px, like the orbit. */
const GIZMO_RAD_PER_PX = 0.009;

interface DatasetRuntime {
  worker: Worker;
  client: ComputeClient;
  heapBytes: number;
  /** The in-flight load's request id, for `cancelDataset`. */
  loadId: number | null;
  cancelled: boolean;
}

export class TetravoxEngine implements Engine, PointerHost {
  readonly caps: Capabilities;

  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  /** GPU resources, keyed by dataset (`render/gpu.ts`). */
  readonly #gpu: GpuStore;
  readonly #renderer: Renderer;
  /**
   * E-DERIVED's half of a frame: the GPU resources drawn from the per-pane cuts (§7.4's 2D
   * `fillIn2D` / `contoursIn2D`), the glyph instances, the isosurfaces and the points.
   *
   * It reads cuts through `#cuts` below — the one `CutManager`, not a second requester. E-DERIVED's
   * branch shipped `PaneCutSource` as a stand-in because its stage lands after E-MESH's; the
   * integrator swapped it here, which is the whole of that swap (`derived/cut-source.ts`).
   */
  readonly #derived: DerivedStore;
  readonly #timer: Timer;
  readonly #opts: EngineOptions;

  /** The §4.5 scene. Every mutation goes through it; every event is emitted from here. */
  readonly #store = new SceneStore();
  /**
   * The §7.2 pass-3 chrome palette (directed task 9, 2026-08-28).
   *
   * On the engine and not in `Scene`: a theme belongs to the window, not to the scene — see
   * `overlay/theme.ts`. It starts at the Phase-1/2 constants, so an embedder that never calls
   * {@link TetravoxEngine.setTheme} gets exactly the frames it always got.
   */
  #theme: OverlayTheme = DEFAULT_OVERLAY_THEME;
  /** One `LayerRuntime` per layer — all per-kind decisions live there (`layers/`). */
  readonly #layers = new Map<LayerId, LayerRuntime>();
  /**
   * §4.4's `VolumeLayer.iso3d`: the surfaces a volume layer **owns**, keyed by that layer's id
   * (directed task 2, 2026-08-28).
   *
   * Not in `this.#layers`, and not in `Scene.layers`: they are derived from the volume layer on
   * every reconcile (`layers/iso3d.ts`), which is what makes them follow its 4D frame, its
   * visibility and its region edits without a single line of synchronisation. The inner map is
   * keyed by the derived `IsosurfaceLayer.id`, so a label volume whose visible set changed keeps
   * the surfaces it already built and drops only the ones that left.
   */
  readonly #iso3d = new Map<LayerId, Map<LayerId, Iso3dLayerRuntime>>();
  /** One worker per dataset (§5 rule 1). */
  readonly #workers = new Map<DatasetId, DatasetRuntime>();
  /**
   * The engine's one owner of the `cut` op (§6.5.2), keyed by `(datasetId, key)` so §7.4's 3D caps
   * and each 2D pane's cross-section never supersede one another (`compute/cut-manager.ts`).
   */
  readonly #cuts = new CutManager(
    (id) => {
      const rt = this.#workers.get(id);
      const ds = this.#store.dataset(id);
      if (rt === undefined || ds === undefined || ds.kind !== 'mesh') return undefined;
      return { client: rt.client, handle: ds.handle };
    },
    // §7.2: `whenSettled()` waits for "all pending worker requests for visible layers". A cut is
    // one — §7.4's caps are geometry the frame draws — so every golden waits for the cross-section
    // instead of photographing the frame before it exists.
    <T>(p: Promise<T>) => this.#track(p)
  );
  readonly #listeners = new Map<string, Set<Listener>>();

  #nextId = 1;
  /**
   * P2-03's per-view dirty bits. `#dirtyAll` is the scene-wide bit — anything that changes what
   * every pane draws (the cursor, a layer, the layout, the canvas size) sets it; a camera gesture
   * sets one view's bit and the pump repaints that pane alone, over a drawing buffer the context
   * was created with `preserveDrawingBuffer: true` precisely so it survives.
   */
  #dirtyAll = true;
  #dirtyViews = new Set<ViewId>();
  #raf = 0;
  #destroyed = false;
  /** §7.2's `interacting` (P2-02): the flag, its 120 ms settle timer, and the one re-render. */
  readonly #interaction: InteractionState;
  /** §7.5's pointer layer (P2-01). Bound to the canvas for the engine's whole life. */
  readonly #pointer: PointerLayer | null;
  /** The level to go back to when `interacting` clears — `reduced` survives a drag. */
  #restQuality: QualityLevel['name'] = 'full';
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #frameTimes: number[] = [];
  #lastQuality: QualityLevel['name'] = 'full';
  /** Canvas size at the last frame; a change invalidates every pane's preserved pixels. */
  #lastCanvas = { width: 0, height: 0 };
  /**
   * The last non-empty probe row per layer **at the cursor**, so §8's `Cursor` block keeps its mesh
   * rows while the pointer is off hovering somewhere else.
   *
   * A mesh row is served by `locate`, latest-wins on one key per layer (§6.3), and hovering re-points
   * that key at the hover position — which is exactly what P2-04's ≤ 50 ms target asks for and which
   * would otherwise blank the persistent block every time the mouse moved. Cleared by `setCursor`,
   * so it can never describe a point the cursor has left.
   */
  readonly #cursorRows = new Map<LayerId, ProbeRow>();
  /**
   * Deformation-field dataset ids a `TemplateSpace` names that have not arrived yet, so §8's space
   * selector can distinguish "still loading" from "this subject has no warp" (directed task 8).
   */
  readonly #pendingFields = new Set<DatasetId>();
  /**
   * Built fsaverage correspondences, keyed by the **subject surface** they are attached to
   * (directed task 8). `map[subjectVertex]` is the fsaverage vertex; `positions` are the fsaverage
   * surface's node coordinates, flat xyz, when one was named.
   */
  readonly #fsaverage = new Map<
    DatasetId,
    { map: Uint32Array; positions?: Float32Array; targetName?: string }
  >();
  /** `sphereMap` results, keyed `subjectSphereId|fsavgSphereId` — the 42 ms is paid once. */
  readonly #sphereMaps = new Map<string, Uint32Array>();
  /** `vertices` results for whole surfaces, keyed by dataset id. The fsaverage sphere is 2.0 MB. */
  readonly #allVertices = new Map<DatasetId, Float32Array>();
  /** The view-projection each pane last rendered with, so a pick reuses it exactly (§7.2.3). */
  readonly #lastViewProj = new Map<ViewId, mat4>();
  readonly #lastRects = new Map<ViewId, ViewportRect>();
  /**
   * §4.6's `DatasetRef.fingerprint`, kept per dataset because `scene/types.ts` is frozen and
   * `Dataset` has nowhere to hold it. Filled from the loader's meta when it carries one — see
   * `scene/serialize.ts`'s `fingerprintFromMeta`, and W-WASM's gap 1.
   */
  readonly #fingerprints = new Map<DatasetId, string>();
  /**
   * The §6.5.1 sidecars each dataset was opened with, for `serialize()` (§4.6).
   *
   * Engine-private for the same reason `#fingerprints` is: `Dataset` has nowhere to hold it, and
   * §12.3 freezes `Dataset`. It is a fact about *how the file was opened*, not about the file, and a
   * spec that loses it reopens the same mesh with `tag 1` … `tag 1099` where the names were and the
   * fallback palette where the `.msh.opt` colours were.
   */
  readonly #sidecars = new Map<DatasetId, SidecarPaths>();
  /** §4.7's `labelCentroids`, cached per `(datasetId, volumeIndex)` — one pass over the volume. */
  readonly #labelCentroids = new Map<string, Promise<LabelCentroid[]>>();
  /** §4.6's "relative to the scene file" — see {@link TetravoxEngine.setSceneDir}. */
  #sceneDir: string | null = null;
  /**
   * §7.5's oblique affordances: which slice view's plane the gizmo manipulates, which handle is hot,
   * and the plane-from-3-points collector.
   *
   * All three are engine-private and none of them is in `Scene`: they are transient interaction
   * state, and a saved `ViewSpec` (§4.6) must not carry "the user was mid-drag on the rotate handle".
   */
  /**
   * The `mmPerPx` each 2D pane was last **fitted** at — R2's corner `×zoom` readout measures against
   * this rather than against a fit recomputed for the pane's current size (`DrawInput.viewFit`).
   */
  readonly #viewFit = new Map<ViewId, number>();
  #gizmoView: ViewId | null = null;
  #gizmoHot: 'none' | GizmoHandle = 'none';
  #planePoints: { viewId: ViewId; points: vec3[] } | null = null;

  /** Read-only view of the scene the store owns. */
  get #scene(): Scene {
    return this.#store.scene;
  }

  /** True when anything at all is waiting to be drawn (P2-03). */
  get #dirty(): boolean {
    return this.#dirtyAll || this.#dirtyViews.size > 0;
  }

  /** The things a `LayerRuntime` is allowed to reach (`layers/runtime.ts`). */
  get #layerContext(): LayerRuntimeContext {
    return {
      gpu: this.#gpu,
      client: (id: DatasetId) => this.#workers.get(id)?.client,
      requestRender: () => this.requestRender(),
      track: <T>(p: Promise<T>) => this.#track(p),
      // Appended for E-SLICE (Phase 2): §7.2 pass 1 draws every `showIn3D` plane in a 3D pane, and
      // `volumeFrame` (§6.5.2) needs the same `GpuCapsT` `loadVolume` was issued with.
      slicePlanes: () => this.#scene.slices,
      gpuCaps: () => this.#gpuCaps(),
      cuts: this.#cuts,
      // §4.4's `IsolateSpec.labelVolume` names another dataset; §5 rule 2 makes it the one
      // cross-dataset op in v1, and the samples are structured-cloned rather than transferred.
      dataset: (id: DatasetId) => this.#store.dataset(id),
      // Directed task 8: an async row landed. Re-emitted as `probe`, never as `cursor`, so a probe
      // arriving cannot clear what the user is typing into the coordinate bar.
      probeLanded: (world: vec3) => this.#onProbeLanded(world),
      // Directed task 8: the fsaverage vertex a subject vertex maps to, when one has been built.
      // Synchronous by construction — `attachFsaverage` did the worker round trips up front, so the
      // probe path stays a lookup and §8's ≤ 50 ms mesh hover is untouched.
      fsaverageFor: (id: DatasetId, vertex: number) => this.#fsaverageFor(id, vertex),
    };
  }

  #onProbeLanded(world: vec3): void {
    const hover = this.#scene.hover;
    const atCursor = dist3(world, this.#scene.cursor) < 1e-6;
    const atHover = hover !== null && dist3(world, hover) < 1e-6;
    if (!atCursor && !atHover) return;
    this.#emit('probe', { world, result: this.probe(world) });
  }

  #fsaverageFor(
    id: DatasetId,
    vertex: number
  ): { fsavgVertex: number; fsavgWorld?: vec3; fsavgSpace?: string } | undefined {
    const corr = this.#fsaverage.get(id);
    if (corr === undefined || vertex < 0 || vertex >= corr.map.length) return undefined;
    const fsavgVertex = corr.map[vertex] as number;
    const named = corr.targetName === undefined ? {} : { fsavgSpace: corr.targetName };
    const p = corr.positions;
    if (p === undefined || (fsavgVertex + 1) * 3 > p.length) return { fsavgVertex, ...named };
    return {
      fsavgVertex,
      ...named,
      fsavgWorld: [
        p[fsavgVertex * 3] as number,
        p[fsavgVertex * 3 + 1] as number,
        p[fsavgVertex * 3 + 2] as number,
      ],
    };
  }

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions = {}) {
    this.#canvas = canvas;
    this.#opts = opts;
    const { gl, caps } = createContext(canvas, {
      // §7.0 item 2: v1 renders passes 1-3 straight to the default framebuffer and relies on canvas
      // MSAA. §7.0 item 8: goldens use `aa: 'off'`, a deterministic mode.
      antialias: opts.aa !== 'off',
      preserveDrawingBuffer: true,
    });
    this.#gl = gl;
    // `forceCaps` may only ever REMOVE a capability (§7.1).
    this.caps = applyForcedCaps(caps, opts.forceCaps);
    this.#gpu = new GpuStore(gl);
    this.#renderer = new Renderer(gl, this.caps);
    this.#derived = new DerivedStore(
      gl,
      this.#cuts,
      (id) => {
        const rt = this.#workers.get(id);
        const ds = this.#store.dataset(id);
        if (rt === undefined || ds === undefined || ds.kind !== 'mesh') return undefined;
        return { client: rt.client, handle: ds.handle };
      },
      () => this.requestRender(),
      (p) => this.#track(p)
    );
    this.#timer = new Timer(gl, this.caps.timerQuery && opts.deterministic !== true);
    // §7.2: entered on input, left `settleMs` after the last one; leaving it triggers **exactly
    // one** full-quality re-render, which is the `#dirtyAll` below and nothing else.
    this.#interaction = new InteractionState({
      onChange: (on) => {
        if (on) {
          this.#restQuality = this.#scene.quality.name;
          this.#applyQuality('interacting');
        } else {
          this.#applyQuality(this.#restQuality);
          this.#dirtyAll = true;
          this.#schedule();
        }
      },
    });
    // §7.5's pointer interaction. `document` is absent under vitest's node environment and in any
    // headless harness that builds an engine over a stub canvas, so the layer is optional — the
    // facade methods it drives are public and work without it.
    this.#pointer =
      typeof globalThis.PointerEvent === 'function' && typeof canvas.addEventListener === 'function'
        ? new PointerLayer(this)
        : null;
    this.#schedule();
  }

  // -----------------------------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------------------------

  on<E extends keyof EngineEvents>(e: E, cb: (p: EngineEvents[E]) => void): () => void {
    let set = this.#listeners.get(e);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(e, set);
    }
    set.add(cb as Listener);
    return () => {
      set?.delete(cb as Listener);
    };
  }

  #emit<E extends keyof EngineEvents>(e: E, payload: EngineEvents[E]): void {
    const set = this.#listeners.get(e);
    if (set === undefined) return;
    for (const cb of [...set]) (cb as (p: EngineEvents[E]) => void)(payload);
  }

  // -----------------------------------------------------------------------------------------
  // Scene accessors
  // -----------------------------------------------------------------------------------------

  get scene(): Readonly<Scene> {
    return this.#store.scene;
  }

  get views(): ReadonlyArray<View> {
    return this.#store.views;
  }

  // -----------------------------------------------------------------------------------------
  // Datasets
  // -----------------------------------------------------------------------------------------

  #gpuCaps(): GpuCapsT {
    return { floatLinear: this.caps.floatLinear, norm16: this.caps.norm16, max3d: this.caps.max3d };
  }

  async addDataset(src: DatasetSource): Promise<Dataset> {
    const id: DatasetId = `ds${this.#nextId++}`;
    const name = sourceName(src);
    const worker = new Worker(new URL('./worker/dataset-worker.ts', import.meta.url), {
      type: 'module',
      name: `tvx-${id}`,
    });
    const runtime: DatasetRuntime = {
      worker,
      client: null as never,
      heapBytes: 0,
      loadId: null,
      cancelled: false,
    };
    const client = new ComputeClient({
      worker,
      onProgress: (_reqId, phase, done, total) => {
        this.#emit('progress', { datasetId: id, phase, done, total } satisfies LoadProgress);
      },
      onHeapBytes: (bytes) => {
        runtime.heapBytes = bytes;
      },
      onPoisoned: (error) => {
        this.#emit('error', { code: error.code, message: error.message, datasetId: id });
      },
    });
    runtime.client = client;
    this.#workers.set(id, runtime);

    const source = toLoadSource(src);
    const path = src.kind === 'path' ? src.path : undefined;
    // Remembered before the load, because it is what the *host* asked for and nothing downstream
    // reports it back: a `.msh.opt` that turned out not to parse is still the sidecar this dataset
    // was opened with, and a spec that names it will find it again next time.
    if (src.kind === 'path' && src.sidecars !== undefined) {
      const cars: SidecarPaths = {};
      if (src.sidecars.lut !== undefined) cars.lut = src.sidecars.lut;
      if (src.sidecars.opt !== undefined) cars.opt = src.sidecars.opt;
      if (Object.keys(cars).length > 0) this.#sidecars.set(id, cars);
    }

    try {
      if (looksLikeVolume(name)) {
        const req = client.start(`load:${id}`, 'loadVolume', {
          source,
          caps: this.#gpuCaps(),
          // §6.1: `want_linear` is false when the layer is a label or `interpolation === 'nearest'`.
          // The layer does not exist yet at load time — but `want_linear` only gates ladder rows 1-2,
          // which are the *label* rows, so `false` is right for both cases: a label volume takes the
          // dense-index R8UI/R16UI path §7.3 needs, and a scalar volume is unaffected (rows 3-10 do
          // not consult it). Asking for `true` here silently turns a 4-value label volume into a
          // filterable R8 grey ramp.
          wantLinear: false,
        });
        runtime.loadId = req.id;
        const res = await this.#track(req.promise);
        runtime.loadId = null;
        if (runtime.cancelled) throw new Error('cancelled');
        return this.#adoptVolume(
          id,
          res.meta,
          res.data,
          res.gpuBytes,
          res.labelIds,
          res.denseIndexOf,
          path
        );
      }
      // `'geo'` rather than `'auto'` for a `.geo`/`.pos`, so a geometry script is rejected by the
      // parsed-view reader (which names the command that gave it away) instead of falling out of
      // `sniff` as "unrecognised mesh format" (`datasets/source.ts`).
      const req = client.start(`load:${id}`, 'loadMesh', {
        source,
        format: meshFormatFor(name),
      });
      runtime.loadId = req.id;
      const res = await this.#track(req.promise);
      runtime.loadId = null;
      if (runtime.cancelled) throw new Error('cancelled');
      return await this.#adoptMesh(id, res.meta, path, res.geo);
    } catch (err) {
      this.#teardown(id);
      throw err;
    }
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inFlight.add(p);
    const done = (): void => {
      this.#inFlight.delete(p);
    };
    p.then(done, done);
    return p;
  }

  #adoptVolume(
    id: DatasetId,
    meta: VolumeMeta,
    data: ArrayBuffer,
    gpuBytes: ArrayBuffer,
    labelIds: Uint32Array | undefined,
    denseIndexOf: Uint32Array | undefined,
    path: string | undefined
  ): VolumeDataset {
    const ds = volumeDatasetFromMeta(
      id,
      meta,
      data,
      { id: this.#nextId },
      path,
      labelIds,
      denseIndexOf
    );
    // §7.3's label path — the dense index remap and its `N x 1 RGBA8` palette (`layers/volume.ts`).
    const palette = buildLabelPalette(ds, labelIds);
    this.#gpu.uploadVolume(`${id}|0`, ds, gpuBytes, meta.gpu, !ds.isLabel, palette);

    this.#fingerprints.set(id, fingerprintFromMeta(meta));
    this.#store.addDataset(ds);
    this.#emit('datasets', [...this.#scene.datasets.values()]);
    this.#onFirstDataset();
    return ds;
  }

  async #adoptMesh(
    id: DatasetId,
    meta: MeshMeta,
    path: string | undefined,
    geo?: GeoPayloadT
  ): Promise<MeshDataset> {
    const ds = meshDatasetFromMeta(id, meta, { id: this.#nextId }, path, geo);
    const rt = this.#workers.get(id);
    if (rt === undefined) throw new Error('dataset worker is gone');

    // §6.3's default 3D representation: the mesh's OWN tagged triangles when it has them, and the
    // derived boundary only when it has none (`grey_Thalamus_TI.msh` — 1,340,029 tets, 0 tris).
    // `tag_surfaces` takes no topology and does no geometry work beyond grouping and normals, which
    // is what keeps this off the `build_topology` path entirely.
    // A parsed view can be points and labels only (every SimNIBS electrode net is): 0 nodes, so
    // there is no surface to extract and nothing to upload. `boundary` on an empty mesh is not a
    // useful question to ask, and the points layer is what will draw this dataset.
    if (ds.nNodes > 0) {
      const payload: SurfacePayload = ds.hasTris
        ? await this.#track(
            rt.client.call(`surface:${id}`, 'surface', { handle: ds.handle, variant: 'indexed' })
          )
        : await this.#track(
            rt.client.call(`surface:${id}`, 'boundary', { handle: ds.handle, variant: 'indexed' })
          );
      this.#gpu.uploadSurface(surfaceKey(id, 'indexed'), payload);
    }
    this.#fingerprints.set(id, fingerprintFromMeta(meta));
    this.#store.addDataset(ds);
    this.#emit('datasets', [...this.#scene.datasets.values()]);
    this.#onFirstDataset();
    return ds;
  }

  /** Centre the cursor and fit the 3D camera the first time there is anything to look at. */
  #onFirstDataset(): void {
    const b = this.#store.bounds();
    const center: vec3 = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    if (this.#scene.datasets.size === 1) {
      this.#store.setView3D({
        ...this.#scene.view3d,
        camera: fitCamera(this.#scene.view3d.camera, b),
      });
      // Fit each 2D pane so the data fills it rather than sitting in a corner.
      const rect = this.#lastRects.get(this.#scene.slices[0]?.id ?? '') ?? null;
      const px = rect !== null ? Math.min(rect.width, rect.height) : 512;
      const mmPerPx = fitMmPerPx(b, px);
      this.#store.setSlices(
        this.#scene.slices.map((s) => ({ ...s, camera: { center: [0, 0], mmPerPx } }))
      );
      for (const s of this.#scene.slices) this.#viewFit.set(s.id, mmPerPx);
      // **Through `setCursor`, not by assignment.** Every pane's crosshair and corner annotation
      // read `scene.cursor` directly, but §8's info panel and coordinate bar are driven by the
      // `cursor` event alone — so a silent move leaves the app describing world (0,0,0) while the
      // crosshairs describe the bbox centre, and the user reads an intensity ~33 mm from the
      // crosshair they are looking at. It also refreshes the mesh probes for the new point.
      this.setCursor(center);
    }
    this.requestRender();
  }

  removeDataset(id: DatasetId): void {
    // The store re-points a dangling `activeLayerId`; leaving it dangling made `[`/`]` and `v`
    // no-ops until the user clicked another row.
    for (const dropped of this.#store.removeDataset(id)) {
      this.#layers.get(dropped.id)?.dispose();
      this.#layers.delete(dropped.id);
      this.#dropIso3d(dropped.id);
    }
    this.#gpu.dropVolume(id);
    this.#gpu.dropSurfaces(id);
    this.#fingerprints.delete(id);
    this.#sidecars.delete(id);
    this.#gpu.dropMeshTables(id);
    this.#derived.dropDataset(id);
    this.#cuts.releaseDataset(id);
    for (const key of [...this.#labelCentroids.keys()]) {
      if (key.startsWith(`${id}|`)) this.#labelCentroids.delete(key);
    }
    // Directed task 8: an fsaverage correspondence names four datasets and any of them may be the
    // one that just went. A stale `map` would keep answering with an index into a file that is no
    // longer open, which is exactly the "plausible but wrong" the whole feature is written against.
    this.#fsaverage.delete(id);
    this.#allVertices.delete(id);
    for (const key of [...this.#sphereMaps.keys()]) {
      if (key.split('|').includes(id)) this.#sphereMaps.delete(key);
    }
    this.#teardown(id);
    this.#emit('datasets', [...this.#scene.datasets.values()]);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  /**
   * §5 rule 6: cancelling a load is terminating its worker.
   *
   * With **no load in flight this is a no-op**, deliberately. Tearing the worker down here would
   * leave the dataset in the scene with nothing behind it: `locate` probes stop answering and
   * `heapBytes` goes `undefined`, while every pane still draws it. §4.7 scopes this method to "an
   * in-flight load"; `removeDataset` is the one that closes a dataset.
   */
  cancelDataset(id: DatasetId): void {
    const rt = this.#workers.get(id);
    if (rt === undefined || rt.loadId === null) return;
    rt.cancelled = true;
    rt.client.cancel(rt.loadId);
  }

  #teardown(id: DatasetId): void {
    const rt = this.#workers.get(id);
    if (rt === undefined) return;
    rt.client.terminate();
    this.#workers.delete(id);
  }

  /** §8's status bar: `wasm_heap_bytes()` from that dataset's last `Res` (§6.5.2). */
  heapBytes(id: DatasetId): number | undefined {
    return this.#workers.get(id)?.heapBytes;
  }

  // -----------------------------------------------------------------------------------------
  // Layers
  // -----------------------------------------------------------------------------------------

  addLayer(spec: NewLayer): Layer {
    const ds = this.#store.dataset(spec.datasetId);
    if (ds === undefined) throw new Error(`no such dataset: ${spec.datasetId}`);
    const id: LayerId = `layer${this.#nextId++}`;
    const base = defaultLayerFor(id, ds as VolumeDataset | MeshDataset, spec.kind);
    const layer = { ...base, ...spec, id, datasetId: ds.id, kind: base.kind } as Layer;
    // §4.6 does not serialise a `LabelTable`, so a `label` that arrives from a scene file carries
    // the user's `mode` / `outlineWidthPx` / `visibleLabels` and **no table**. The table is the one
    // part of it that is re-derived, so it is taken from the layer this dataset seeded — without
    // this, restoring an annotation's settings would replace the table with `undefined` and the
    // layer would render nothing (directed task 13, 2026-08-28).
    if (layer.kind === 'mesh' && layer.label !== undefined && layer.label.table === undefined) {
      const seeded = base.kind === 'mesh' ? base.label : undefined;
      if (seeded === undefined) delete (layer as { label?: unknown }).label;
      else layer.label = { ...layer.label, table: seeded.table };
    }
    this.#store.addLayer(layer);
    // The runtime is what makes the layer's kind mean anything (`layers/registry.ts`).
    this.#layers.set(id, createLayerRuntime(layer, ds, this.#layerContext));
    this.#reconcileIso3d(layer);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
    return layer;
  }

  removeLayer(id: LayerId): void {
    this.#store.removeLayer(id);
    this.#layers.get(id)?.dispose();
    this.#layers.delete(id);
    this.#dropIso3d(id);
    this.#derived.dropLayer(id);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void {
    const next = this.#store.updateLayer(id, patch);
    if (next !== undefined) this.#layers.get(id)?.applyPatch(next);
    if (next !== undefined) this.#reconcileIso3d(next);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  reorderLayers(order: LayerId[]): void {
    this.#store.reorderLayers(order);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  setActiveLayer(id: LayerId | null): void {
    this.#store.setActiveLayer(id);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  /**
   * R5's region selection on a mesh layer: which tissue tags and which `.annot` / `.label.gii`
   * labels are highlighted (§7.4's edges for a tag, a screen-space boundary band for a label).
   *
   * **Engine state, not scene state.** The frozen §4.4 `MeshLayer` has nowhere to put a selection
   * and R5's "selection persists through scene save/load" needs a `ViewSpec` field that does not
   * exist; that is filed with W-WASM. Until it lands a selection is per-session, and this method is
   * the only way to set one.
   */
  setMeshEmphasis(layerId: LayerId, emphasis: MeshEmphasis): void {
    const rt = this.#layers.get(layerId);
    if (rt instanceof MeshLayerRuntime) rt.setEmphasis(emphasis);
  }

  /** What that mesh layer's §8 colour bar is made of, or `null` when it is not scalar-coloured. */
  meshColorbarScale(layerId: LayerId): MeshScaleInfo | null {
    const rt = this.#layers.get(layerId);
    return rt instanceof MeshLayerRuntime ? rt.colorbarScale() : null;
  }

  /**
   * §7.4's three async switches, as the progress state §8 asks for: `true` while the geometry
   * variant or the field/label table this layer needs has been asked for and has not landed.
   */
  meshLayerLoading(layerId: LayerId): boolean {
    const rt = this.#layers.get(layerId);
    return rt instanceof MeshLayerRuntime ? rt.loading : false;
  }

  /**
   * §7.4's clip cut for one mesh layer, **copied** out of the manager's arena.
   *
   * §11's *cap diagonal* test is the reason this exists: it has to name a specific 2-2-split quad —
   * two triangles with `edgeMask` `0b101` and `0b011` sharing the diagonal the mask suppresses — and
   * assert that the pixel on that diagonal is *not* the edge colour. That needs the same
   * `Cut.edge_mask` the shader read, not a re-derivation, or the test is only checking itself.
   *
   * The arrays are copies because a {@link CutSnapshot}'s are views into a per-key arena that the
   * next cut overwrites (`compute/cut-manager.ts`), and a test holds them across further requests.
   */
  meshCut(layerId: LayerId): {
    generation: number;
    vertexCount: number;
    triangleCount: number;
    planes: { normal: vec3; offset: number }[];
    planeRanges: { plane: number; firstVertex: number; vertexCount: number }[];
    positions: Float32Array;
    tag: Int32Array;
    ownerTet: Uint32Array;
    edgeMask: Uint8Array;
    capBytes: number;
  } | null {
    const rt = this.#layers.get(layerId);
    if (!(rt instanceof MeshLayerRuntime)) return null;
    const snap = this.#cuts.getCut(rt.datasetId, CUT_KEY_3D_CLIP);
    if (snap === null) return null;
    return {
      generation: snap.generation,
      vertexCount: snap.vertexCount,
      triangleCount: snap.triangleCount,
      planes: snap.planes.map((p) => ({
        normal: [p.normal[0], p.normal[1], p.normal[2]] as vec3,
        offset: p.offset,
      })),
      planeRanges: snap.planeRanges.map((r) => ({
        plane: r.plane,
        firstVertex: r.firstVertex,
        vertexCount: r.vertexCount,
      })),
      positions: snap.positions.slice(),
      tag: snap.tag.slice(),
      ownerTet: snap.ownerTet.slice(),
      edgeMask: snap.edgeMask.slice(),
      capBytes: this.#gpu.caps(capKey(layerId))?.bytes ?? 0,
    };
  }

  /**
   * The isolation in force on one mesh layer (§6.5.2's `{ maskId, visibleTets, generation }`).
   *
   * `visibleTets` is what §11's real-data isolation test cross-checks against a numpy count, and
   * §8's region panel shows beside the criteria.
   */
  meshIsolation(
    layerId: LayerId
  ): { maskId: number; visibleTets: number; generation: number } | null {
    const rt = this.#layers.get(layerId);
    if (!(rt instanceof MeshLayerRuntime)) return null;
    const state = rt.isolation;
    return state === null
      ? null
      : { maskId: state.maskId, visibleTets: state.visibleTets, generation: state.generation };
  }

  /**
   * §7.4's **active** clip planes of one mesh layer — the gizmo hook.
   *
   * E-SCENE draws the cut-plane gizmo (`overlay/gizmo.ts`, in the overlay pass with every clip
   * distance disabled) and writes a drag back through `updateLayer(id, { clip })`. What it needs
   * from here is which planes are live and **in what order**, because "plane *i*" has to mean one
   * thing in four places: the shader's `uClipPlanes[i]`, the `CLIP_DISTANCE(i)` enable set, §7.4's
   * cap rule, and `CutSnapshot.planeRanges[].plane`. `index` is the position in
   * `MeshLayer.clip.planes` — the array a patch edits — while the row's position in this list is
   * the `i` those four share; a disabled plane occupies the first and not the second.
   *
   * Reading `scene` directly would give the unfiltered array and the two indices would diverge the
   * moment a plane is disabled, which is exactly the bug that exempts the wrong plane from its own
   * cap.
   */
  meshClipPlanes(layerId: LayerId): { index: number; plane: { normal: vec3; offset: number } }[] {
    const layer = this.#scene.layers.find((l) => l.id === layerId);
    if (layer === undefined || layer.kind !== 'mesh') return [];
    const out: { index: number; plane: { normal: vec3; offset: number } }[] = [];
    for (const [index, cp] of layer.clip.planes.entries()) {
      if (!cp.enabled) continue;
      out.push({
        index,
        plane: {
          normal: [cp.plane.normal[0], cp.plane.normal[1], cp.plane.normal[2]] as vec3,
          offset: cp.plane.offset,
        },
      });
      if (out.length === MAX_CLIP_PLANES) break;
    }
    return out;
  }

  /** The runtimes in **layer order** (bottom → top, §4.4), which is the order everything consumes. */
  #runtimesInOrder(): LayerRuntime[] {
    const out: LayerRuntime[] = [];
    for (const layer of this.#scene.layers) {
      const rt = this.#layers.get(layer.id);
      if (rt !== undefined) out.push(rt);
      // A volume layer's own 3D surfaces sit directly above it, so §7.2's passes take them in the
      // same bottom→top order everything else consumes and a surface never sorts under its volume.
      const owned = this.#iso3d.get(layer.id);
      if (owned !== undefined) for (const iso of owned.values()) out.push(iso);
    }
    return out;
  }

  /**
   * Bring one volume layer's derived surfaces in line with what it now says (§4.4's `iso3d`).
   *
   * Called from `addLayer` and from every `updateLayer`, because *every* field the derivation reads
   * is one an editor can patch: `visible`, `volumeIndex`, `visibleLabels`, `selectedLabels`,
   * `labelColors`, and `iso3d` itself. Runtimes are keyed by the derived layer id, so an unchanged
   * surface keeps its runtime — and with it its `GpuStore` entry, which is what stops a region-panel
   * click from rebuilding ten tissues' marching cubes.
   */
  #reconcileIso3d(layer: Layer): void {
    if (layer.kind !== 'volume') return;
    const ds = this.#store.dataset(layer.datasetId);
    if (ds === undefined || ds.kind !== 'volume') {
      this.#dropIso3d(layer.id);
      return;
    }
    const wanted = derivedIsoLayers(layer, ds);
    let owned = this.#iso3d.get(layer.id);
    if (wanted.length === 0) {
      this.#dropIso3d(layer.id);
      return;
    }
    if (owned === undefined) {
      owned = new Map<LayerId, Iso3dLayerRuntime>();
      this.#iso3d.set(layer.id, owned);
    }
    const keep = new Set<LayerId>();
    for (const derived of wanted) {
      keep.add(derived.id);
      const existing = owned.get(derived.id);
      if (existing === undefined) {
        owned.set(
          derived.id,
          createIso3dRuntime(derived, ds, this.#layerContext, this.#iso3dChanged)
        );
      } else {
        existing.applyPatch(derived);
      }
    }
    for (const [id, rt] of [...owned]) {
      if (keep.has(id)) continue;
      rt.dispose();
      owned.delete(id);
    }
  }

  /** §7.2's `DrawInput.ownedRuntimes`: each volume layer's derived 3D surfaces, in derivation order. */
  #ownedRuntimes(): ReadonlyMap<LayerId, readonly LayerRuntime[]> {
    const out = new Map<LayerId, readonly LayerRuntime[]>();
    for (const [id, owned] of this.#iso3d) out.set(id, [...owned.values()]);
    return out;
  }

  /** Drop every surface a volume layer owned — it was removed, or its dataset was. */
  #dropIso3d(layerId: LayerId): void {
    const owned = this.#iso3d.get(layerId);
    if (owned === undefined) return;
    for (const rt of owned.values()) rt.dispose();
    this.#iso3d.delete(layerId);
  }

  /**
   * A derived surface started or finished building.
   *
   * It reaches §8 as a `layers` event because that is the one the app's `syncLayers` already
   * listens to and the one {@link TetravoxEngine.iso3dStatus} is read from — a new event kind for a
   * progress bar would be a frozen-facade change for nothing.
   */
  readonly #iso3dChanged = (): void => {
    this.#emit('layers', [...this.#scene.layers]);
  };

  /**
   * §8's load-card progress for a volume layer's 3D surface: how many of its surfaces are still
   * being built, out of how many it owns.
   *
   * `{ pending: 0, total: 0 }` for a layer with no `iso3d`, so a caller needs no null check to ask.
   */
  iso3dStatus(layerId: LayerId): Iso3dStatus {
    const owned = this.#iso3d.get(layerId);
    if (owned === undefined) return { pending: 0, total: 0 };
    let pending = 0;
    for (const rt of owned.values()) if (rt.loading) pending += 1;
    return { pending, total: owned.size };
  }

  // -----------------------------------------------------------------------------------------
  // Cursor, views
  // -----------------------------------------------------------------------------------------

  setCursor(world: vec3): void {
    this.#store.setCursor(world);
    // The memo describes the point the cursor just left; keeping it would let §8's `Cursor` block
    // report the previous click's tissue at the new coordinates.
    this.#cursorRows.clear();
    this.#emit('cursor', world);
    // Anything asynchronous a probe row needs — §6.3's `locate_point` for a mesh layer — is refreshed
    // here, latest-wins on each runtime's own key (§5 rule 6).
    for (const rt of this.#runtimesInOrder()) rt.refreshProbe(world);
    this.requestRender();
  }

  /**
   * §7.5: `cursor += normal · step · k`, then **snap the along-normal component to the nearest voxel
   * plane** of the stepped layer — otherwise repeated steps drift.
   *
   * "Along-normal component", read literally. Phase 1 rounded **all three** voxel indices, which
   * dragged the cursor to the nearest voxel *centre* sideways as well: after a click at an arbitrary
   * in-plane point, one wheel notch on `vol_asym.nii` moved the cursor 0.5 mm across the plane as
   * well as 1 mm along it, and §7.5's "moves the cursor by `step_mm`" was simply false. The snap now
   * solves for the distance **along the normal** that puts the stepping voxel index on an integer,
   * which leaves the in-plane position untouched and is correct for an oblique plane too.
   */
  stepCursor(viewId: ViewId, steps: number): void {
    const view = this.#store.view(viewId);
    if (view === undefined || !isSliceView(view)) return;
    this.setCursor(this.#alongBy(view.normal, steps, this.#scene.cursor));
  }

  /**
   * §7.5's "**arrows nudge the cursor**" — ±1 step **in the view plane**, along the pane's `right`
   * and `up` (P2-09, and the one `api.ts` carve-out in `docs/PHASE2-OWNERSHIP.md`).
   *
   * §7.5 lists the arrows and PgUp/PgDn as two different bindings and Phase 1 gave both to
   * `stepCursor`, so all four arrows walked the cursor along the plane **normal**: pressing → in the
   * axial pane changed the axial slice instead of moving the crosshair right, and the in-plane nudge
   * §7.5 names existed nowhere. It cannot live in the app — §8 forbids logic in React, and the basis
   * is `sliceBasis(view, radiological)`, engine geometry the app has no business recomputing — so it
   * is an `Engine` member, which is why this is the one frozen-file change E-SCENE owns.
   *
   * The basis is the **radiological-aware** one, the same `paneToWorld` uses: pressing → moves the
   * crosshair toward screen-right in either convention, and a one-step nudge lands exactly where a
   * one-`step_mm` drag to the right lands. Each axis takes its own `step_mm` (§7.5's rule applied to
   * `right` and `up` rather than to the normal), and each is snapped along its own direction, so 100
   * nudges out and 100 back return to the starting point exactly — including on a rotated affine,
   * where the effective step is the voxel-plane spacing along that direction rather than `step_mm`.
   *
   * A diagonal nudge snaps **sequentially**, `right` then `up`. On an axis-aligned volume the two are
   * independent and the order does not matter; on a rotated one the second snap perturbs the first
   * axis's index slightly, which is why the anti-drift property is stated and tested per axis — the
   * form §7.5 and §11 both state it in.
   */
  nudgeCursor(viewId: ViewId, dx: number, dy: number): void {
    const view = this.#store.view(viewId);
    if (view === undefined || !isSliceView(view)) return;
    const { right, up } = sliceBasis(view, this.#scene.radiological);
    let next = this.#scene.cursor;
    if (dx !== 0) next = this.#alongBy(right, dx, next);
    if (dy !== 0) next = this.#alongBy(up, dy, next);
    if (next === this.#scene.cursor) return;
    this.setCursor(next);
  }

  /**
   * `world + dir · step_mm · steps`, snapped back onto the voxel grid along `dir`.
   *
   * §7.5's slice step and P2-09's in-plane nudge are the same operation in two directions, and the
   * anti-drift snap is what makes repeated steps exact — see `view/geometry.ts`'s `snapAlong`. With
   * no volume in the scene `stepMm` falls back to 1 mm (R4) and there is nothing to snap to.
   */
  #alongBy(dir: vec3, steps: number, from: vec3): vec3 {
    const top = this.#store.topVolume();
    const step = stepMm(dir, top?.ds.affine ?? null, top?.ds.spacing ?? null, this.#store.bounds());
    const moved: vec3 = [
      from[0] + dir[0] * step * steps,
      from[1] + dir[1] * step * steps,
      from[2] + dir[2] * step * steps,
    ];
    return top !== undefined ? snapAlong(top.ds, moved, dir) : moved;
  }

  setLayout(layout: { kind: Scene['layout']['kind']; cells: ViewId[] }): void {
    this.#store.setLayout(layout);
    this.requestRender();
  }

  /** P2-03: a view's own camera or plane changes that pane and no other. */
  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void {
    this.#store.setView(id, patch);
    this.requestRender(id);
  }

  setRadiological(on: boolean): void {
    this.#store.setRadiological(on);
    this.requestRender();
  }

  /** §7.5 `r`. Not in the frozen §4.7 facade; the app duck-types it (see `engine/commands.ts`). */
  resetView(viewId: ViewId): void {
    const b = this.#store.bounds();
    if (viewId === VIEW3D_ID) {
      this.#store.setView3D({
        ...this.#scene.view3d,
        camera: fitCamera(this.#scene.view3d.camera, b),
      });
    } else {
      const rect = this.#lastRects.get(viewId);
      const px = rect !== undefined ? Math.min(rect.width, rect.height) : 512;
      const mmPerPx = fitMmPerPx(b, px);
      this.#store.setSlices(
        this.#scene.slices.map((s) =>
          s.id === viewId ? { ...s, camera: { center: [0, 0], mmPerPx } } : s
        )
      );
      this.#viewFit.set(viewId, mmPerPx);
    }
    this.requestRender();
  }

  /** §7.5 `1..6`. */
  cameraPreset(viewId: ViewId, preset: number | string): void {
    const table: Record<string, number> = { A: 1, P: 2, L: 3, R: 4, S: 5, I: 6 };
    const index = typeof preset === 'number' ? preset : (table[preset.toUpperCase()] ?? 1);
    if (viewId !== VIEW3D_ID) return;
    this.#store.setView3D({
      ...this.#scene.view3d,
      camera: { ...this.#scene.view3d.camera, rotation: presetRotation(index) },
    });
    this.requestRender();
  }

  /** §7.5 `c` and the §4.5 `Annotations` block. */
  setAnnotations(patch: Partial<Annotations>): void {
    this.#store.setAnnotations(patch);
    this.requestRender();
  }

  /**
   * §8's theme, as far as the chrome the engine draws is concerned (directed task 9, 2026-08-28).
   *
   * `setAnnotations` says *which* chrome is drawn; this says what colour it is drawn in. Both are
   * needed for a theme switch to be honest: the app can retokenise every panel in CSS and the
   * orientation letters would still be near-white with a black halo over a white pane.
   *
   * A patch, like `setAnnotations`: an embedder that only wants the halo inverted sends the halo.
   * `background` is forwarded to `Scene.background` — the one theme field the scene owns, because
   * §4.6 serialises it — and is simply left out by an embedder whose viewport does not follow the
   * theme. The app leaves it out by default: imaging convention keeps the panes dark in both themes.
   */
  setTheme(patch: Partial<OverlayTheme>): void {
    this.#theme = resolveOverlayTheme(patch, this.#theme);
    if (patch.background !== undefined) this.#store.setBackground(this.#theme.background);
    this.requestRender();
  }

  // -----------------------------------------------------------------------------------------
  // R5 — region select / mute / recolour (E-SLICE, Phase 2)
  //
  // All four of R5's per-region edits are now frozen `VolumeLayer` fields and travel through
  // `updateLayer` like any other patch: `visibleLabels`, `labelOpacity`, and — added by the Phase-2
  // integrator from E-SLICE's, A-PROPS's and E-SCENE's identical filings — `labelColors` and
  // `selectedLabels` (§4.4, `docs/DECISIONS.md` 2026-08-27). That is what makes R5's "edits persist
  // in the scene" true (§4.6 serialises layers and does **not** serialise a `LabelTable`) and what
  // lets §8's panel drive all of it "from the `Engine` API alone".
  //
  // The two convenience members below stay because they are what a spec can call in one line; both
  // are `updateLayer` underneath, and neither is on the frozen `Engine` — an app reaches for
  // `updateLayer`.
  // -----------------------------------------------------------------------------------------

  /**
   * R5's colour swatch: override one label's colour on this layer.
   *
   * `color: null` **clears** the override, which is the per-row Reset — the dataset's `LabelTable`
   * still holds the file's own colour underneath, untouched, so there is something to reset to.
   *
   * Returns `false` when the layer is not a label volume, so a panel can tell "not applicable" from
   * "done". An id the atlas does not name is still accepted: `labelIds` is per 4D frame, and
   * refusing here would make the answer depend on which frame is on screen.
   */
  setLabelColor(layerId: LayerId, labelId: number, color: vec4 | null): boolean {
    const rt = this.#layers.get(layerId);
    if (!(rt instanceof VolumeLayerRuntime)) return false;
    const ds = this.#store.dataset(rt.datasetId);
    if (ds === undefined || ds.kind !== 'volume' || !ds.isLabel) return false;
    const next = { ...(rt.layer.labelColors ?? {}) };
    if (color === null) delete next[labelId];
    else next[labelId] = color;
    this.updateLayer<VolumeLayer>(layerId, {
      labelColors: Object.keys(next).length === 0 ? undefined : next,
    });
    return true;
  }

  /** R5's selection: these labels get the emphasis rim in every pane this layer draws in. */
  setSelectedLabels(layerId: LayerId, labelIds: readonly number[]): void {
    const rt = this.#layers.get(layerId);
    if (!(rt instanceof VolumeLayerRuntime)) return;
    this.updateLayer<VolumeLayer>(layerId, { selectedLabels: [...labelIds] });
  }

  /** What {@link setSelectedLabels} last set, so a panel can round-trip its own state. */
  selectedLabels(layerId: LayerId): Uint32Array {
    const rt = this.#layers.get(layerId);
    return rt instanceof VolumeLayerRuntime ? rt.selectedLabels : new Uint32Array(0);
  }

  /**
   * §4.7's `labelCentroids`: every label of a label-volume layer, with its voxel count and world
   * centroid (§6.5.2's op).
   *
   * Cached per `(datasetId, volumeIndex)` — the op is one pass over the volume and a label map does
   * not change under a layer — and shared by every layer drawing that atlas, which is the point of
   * keying it on the dataset rather than on the layer that asked.
   */
  async labelCentroids(layerId: LayerId): Promise<LabelCentroid[]> {
    const rt = this.#layers.get(layerId);
    if (!(rt instanceof VolumeLayerRuntime)) return [];
    const ds = this.#store.dataset(rt.datasetId);
    if (ds === undefined || ds.kind !== 'volume' || !ds.isLabel) return [];
    const volumeIndex = rt.layer.volumeIndex;
    const cacheKey = `${ds.id}|${volumeIndex}`;
    const cached = this.#labelCentroids.get(cacheKey);
    if (cached !== undefined) return cached;
    const client = this.#workers.get(ds.id)?.client;
    if (client === undefined) return [];
    const pending = this.#track(
      client
        .labelCentroids(`labelCentroids:${cacheKey}`, { handle: ds.handle, volumeIndex })
        .then((res) =>
          // The op answers in **voxel** coordinates; §4.1 converts once, and this is that once.
          res.centroids.map((c) => ({
            id: c.id,
            count: c.count,
            centroid: transformPoint(ds.affine, c.centroid) as vec3,
          }))
        )
    );
    this.#labelCentroids.set(cacheKey, pending);
    try {
      return await pending;
    } catch {
      // A terminated worker (§5 rule 1) is not an error here; the panel keeps showing `—`.
      this.#labelCentroids.delete(cacheKey);
      return [];
    }
  }

  /**
   * The `Stats` of the 4D frame a layer currently displays (§8's colour bar and histogram).
   *
   * `VolumeDataset.stats` is volume 0's by contract (§6.5.1); at index k it is the wrong
   * distribution, and P2-05 is exactly the bug of not having anywhere else to ask.
   */
  /**
   * **Test-only** (§11): the glyph instances the next frame would draw, as numbers.
   *
   * `derived/glyph-readback.ts` explains why this exists — everything a glyph *is* happens in the
   * vertex shader, so a golden PNG can only say that arrows appeared, not that they point where the
   * field does. Returns `null` until {@link Engine.retainGlyphSources} has been on for long enough
   * that the ops behind the draw have landed.
   */
  glyphInstances(layerId: LayerId): GlyphInstance[] | null {
    const layer = this.#scene.layers.find((l) => l.id === layerId);
    if (layer === undefined || layer.kind !== 'mesh') return null;
    const ds = this.#scene.datasets.get(layer.datasetId);
    if (ds === undefined || ds.kind !== 'mesh') return null;
    return readGlyphInstances(this.#derived, layer, ds);
  }

  /** **Test-only**: keep the arrays behind the glyph tables so {@link Engine.glyphInstances} can. */
  retainGlyphSources(on: boolean): void {
    this.#derived.retainGlyphSources(on);
  }

  layerStats(layerId: LayerId): Stats | undefined {
    const rt = this.#layers.get(layerId);
    return rt instanceof VolumeLayerRuntime ? rt.stats : undefined;
  }

  // -----------------------------------------------------------------------------------------
  // Picking and probing
  // -----------------------------------------------------------------------------------------

  pick(viewId: ViewId, px: number, py: number): PickResult | null {
    const view = this.#store.view(viewId);
    const rect = this.#lastRects.get(viewId);
    const viewProj = this.#lastViewProj.get(viewId);
    if (view === undefined || rect === undefined || viewProj === undefined) return null;
    // §7.2.3 wants the *pick* geometry to be de-indexed; the 3D mesh path needs that variant, which
    // is requested lazily and is a no-op if it has not landed yet.
    for (const rt of this.#runtimesInOrder()) rt.ensurePickGeometry(view);
    const dpr = this.#dpr();
    const localX = px * dpr;
    const localY = rect.height - py * dpr;
    // The **rendered** view, so §7.2.3's "reproduces every discard of the main pass" also covers
    // where the pane's geometry actually is (R3's anchor).
    const drawn = this.#rendered(view, planeAnchor(this.#store.bounds()));
    const hit = this.#renderer.pick(drawn, rect, viewProj, this.#drawInput(), localX, localY);
    this.#emit('pick', hit);
    // The pick pass scribbles on the default framebuffer's binding and viewport; the next frame
    // must repaint.
    this.requestRender();
    return hit;
  }

  setCursorFromPick(viewId: ViewId, px: number, py: number): boolean {
    const hit = this.pick(viewId, px, py);
    if (hit === null) return false;
    this.setCursor(hit.world);
    return true;
  }

  /**
   * §4.7's `probe` is **synchronous**, but a mesh probe is a worker round trip (§6.3's
   * `locate_point`). Volume rows are computed here from `VolumeDataset.data`, which §4.3 keeps on
   * the UI thread for exactly this; mesh rows come from the most recent `locate` for that world
   * point, refreshed asynchronously whenever the cursor moves. A mesh row is therefore at most one
   * round trip stale and is omitted entirely until the first result lands.
   */
  probe(world: vec3): ProbeResult {
    const atCursor = dist3(world, this.#scene.cursor) < 1e-6;
    const rows = this.#runtimesInOrder().map((rt) => {
      const row = rt.probeRow(world);
      if (!atCursor) return row;
      // P2-04: hovering re-points each mesh layer's single `locate` key at the pointer, so the
      // cursor's own row would blank the moment the mouse moved. Remember the last row that had
      // content; `setCursor` clears it, so it can only ever describe this cursor.
      if (hasProbeContent(row)) {
        this.#cursorRows.set(row.layerId, row);
        return row;
      }
      return this.#cursorRows.get(row.layerId) ?? row;
    });
    // Directed task 8: tkr-RAS and the nonlinear MNI join the affine column that Phase 2 shipped.
    // `probeSpaces` owns which volume each is relative to (`view/coord-spaces.ts`); `#toTemplate`
    // stays as the affine fallback so a scene whose only template lives on a hidden layer still
    // answers, exactly as it did before.
    const spaces = probeSpaces(this.#scene, world);
    const mni = spaces.mni ?? this.#toTemplate(world) ?? undefined;
    return {
      world,
      rows,
      ...(mni !== undefined ? { mni } : {}),
      ...(spaces.tkr !== undefined ? { tkr: spaces.tkr, tkrVolume: spaces.tkrVolume } : {}),
      ...(spaces.mniNonlinear !== undefined ? { mniNonlinear: spaces.mniNonlinear } : {}),
    };
  }

  /**
   * §8's space selector, §4.7's `coordinateSpaces` / `toSpace` / `fromSpace` / `setTemplateSpace`
   * (directed task 8; `docs/DECISIONS.md` 2026-08-28).
   *
   * All four are thin: the policy is in `view/coord-spaces.ts` over a plain `Scene`, so the app's
   * `NoGlEngine` gives the same answers as this one without a GL context, and the unit tests assert
   * the policy without either.
   */
  coordinateSpaces(): CoordSpaceOption[] {
    return coordinateSpaceOptions(this.#scene, this.#pendingFields);
  }

  toSpace(ref: CoordSpaceRef, world: vec3): vec3 | null {
    return toCoordSpace(this.#scene, ref, world);
  }

  fromSpace(ref: CoordSpaceRef, value: vec3): vec3 | null {
    return fromCoordSpace(this.#scene, ref, value);
  }

  /**
   * §4.7's `attachFsaverage` (directed task 8). Three worker ops, composed once and cached.
   *
   * Everything that can go wrong is a `false`, not a throw: nothing about fsaverage is bundled, the
   * files are somewhere the user pointed at, and "this pair does not correspond" has to be as
   * ordinary an answer as "it does".
   */
  async attachFsaverage(
    spec: FsaverageSpec | { surfaceId: DatasetId; clear: true }
  ): Promise<boolean> {
    if ('clear' in spec) {
      this.#fsaverage.delete(spec.surfaceId);
      return false;
    }
    const surface = this.#store.dataset(spec.surfaceId);
    const subjectSphere = this.#store.dataset(spec.subjectSphereId);
    const fsavgSphere = this.#store.dataset(spec.fsavgSphereId);
    if (
      surface?.kind !== 'mesh' ||
      subjectSphere?.kind !== 'mesh' ||
      fsavgSphere?.kind !== 'mesh'
    ) {
      return false;
    }
    // The map is indexed by the SUBJECT SPHERE's node numbering, and it is read with a vertex index
    // that came off the displayed surface. Equal node counts is what makes that the same numbering;
    // checking it is the difference between "no fsaverage row" and a row pointing at a random gyrus.
    if (surface.nNodes !== subjectSphere.nNodes) return false;

    try {
      const key = `${spec.subjectSphereId}|${spec.fsavgSphereId}`;
      let map = this.#sphereMaps.get(key);
      if (map === undefined) {
        const target = await this.#verticesOf(spec.fsavgSphereId);
        if (target === null) return false;
        const client = this.#workers.get(spec.subjectSphereId)?.client;
        if (client === undefined) return false;
        const res = await this.#track(
          client.call(`spheremap:${key}`, 'sphereMap', {
            handle: subjectSphere.handle,
            target,
          })
        );
        map = res.map;
        this.#sphereMaps.set(key, map);
      }
      if (map.length !== surface.nNodes) return false;

      const positions =
        spec.fsavgSurfaceId === undefined
          ? undefined
          : ((await this.#verticesOf(spec.fsavgSurfaceId)) ?? undefined);
      this.#fsaverage.set(spec.surfaceId, {
        map,
        ...(positions !== undefined ? { positions } : {}),
        ...(spec.targetName !== undefined ? { targetName: spec.targetName } : {}),
      });
      this.requestRender();
      return true;
    } catch {
      return false;
    }
  }

  /** Every node coordinate of a mesh dataset, world mm, cached — `vertices` with no index list. */
  async #verticesOf(id: DatasetId): Promise<Float32Array | null> {
    const cached = this.#allVertices.get(id);
    if (cached !== undefined) return cached;
    const ds = this.#store.dataset(id);
    const client = this.#workers.get(id)?.client;
    if (ds?.kind !== 'mesh' || client === undefined) return null;
    const res = await this.#track(client.call(`vertices:${id}`, 'vertices', { handle: ds.handle }));
    this.#allVertices.set(id, res.positions);
    return res.positions;
  }

  setTemplateSpace(datasetId: DatasetId, space: TemplateSpace | null): void {
    const ds = this.#scene.datasets.get(datasetId);
    if (ds === undefined || ds.kind !== 'volume') return;
    if (space === null) delete ds.toTemplate;
    else ds.toTemplate = space;
    // The field ids may name datasets that are still loading; remember which, so the selector can
    // say "loading" rather than "not available" for the seconds a 97 MB warp takes.
    this.#pendingFields.clear();
    for (const other of this.#scene.datasets.values()) {
      const t = other.kind === 'volume' ? other.toTemplate : undefined;
      if (t === undefined) continue;
      for (const id of [t.forwardFieldId, t.inverseFieldId]) {
        if (id !== undefined && !this.#scene.datasets.has(id)) this.#pendingFields.add(id);
      }
    }
    this.#emit('datasets', [...this.#scene.datasets.values()]);
  }

  /**
   * §4.7's `ProbeResult.mni` (P2-10) — the cursor through the scene's template transform.
   *
   * The topmost **visible** volume layer first, because that is the one every other readout in §8
   * describes (the corner slice index, the window/level target); any other volume that carries a
   * `toTemplate` second, so a hidden atlas still answers when the layer on top is a mesh field. When
   * nothing claims a template the field is absent and §8's MNI column does not appear.
   */
  #toTemplate(world: vec3): vec3 | null {
    // `hasAffine === false` means `matrix` is a placeholder identity (directed task 8): a SimNIBS
    // subject whose only registration is the warp. Applying it would report the cursor **unchanged**
    // as an MNI coordinate — a wrong number that looks exactly like a right one.
    const usable = (ds: { toTemplate?: TemplateSpace }): boolean =>
      ds.toTemplate !== undefined && ds.toTemplate.hasAffine !== false;
    const top = this.#store.topVolume();
    if (top !== undefined && usable(top.ds)) {
      return applyAffine((top.ds.toTemplate as TemplateSpace).matrix, world);
    }
    for (const ds of this.#scene.datasets.values()) {
      if (ds.kind === 'volume' && usable(ds)) {
        return applyAffine((ds.toTemplate as TemplateSpace).matrix, world);
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------------------------
  // Frame pump
  // -----------------------------------------------------------------------------------------

  /**
   * Device pixels per CSS pixel, **derived from the canvas the embedder sized**.
   *
   * The engine does not resize the canvas: §8's view grid already keeps the drawing buffer the size
   * of its host in device pixels, with a `ResizeObserver`, and two owners of one backing store is a
   * bug waiting to happen — with `devicePixelRatio = 2` the engine would have multiplied
   * `clientWidth` by 2 every frame and the buffer would have run away. So the canvas's size is an
   * input here, and the ratio is read back out of it.
   */
  #dpr(): number {
    if (this.#opts.dpr !== undefined) return this.#opts.dpr;
    const cssW = this.#canvas.clientWidth;
    if (cssW > 0 && this.#canvas.width > 0) return this.#canvas.width / cssW;
    return globalThis.devicePixelRatio ?? 1;
  }

  #currentViewports(): ViewportRect[] {
    return viewports(this.#scene.layout, this.#canvas.width, this.#canvas.height);
  }

  /** Everything a frame (or a pick) needs that is not per-pane (§7.2's `DrawInput`). */
  #drawInput(): DrawInput {
    return {
      scene: this.#scene,
      store: this.#gpu,
      runtimes: this.#layers,
      ownedRuntimes: this.#ownedRuntimes(),
      canvasWidth: this.#canvas.width,
      canvasHeight: this.#canvas.height,
      activeViewId: null,
      uiScale: Math.max(1, Math.round(this.#dpr())),
      showChrome: true,
      theme: this.#theme,
      // §7.5's oblique affordances. `null` whenever no gizmo is shown, which is the default.
      gizmo: this.gizmoSpec(),
      viewFit: this.#viewFit,
      // §7.1's capability, after `forceCaps` — which may only ever remove one — and §7.4's
      // fallback axis. A pass never reads `Capabilities` directly, so a forced removal reaches the
      // shader variant and the `CLIP_DISTANCE` enable set by the same route.
      clipDistance: this.caps.clipDistance,
      forceDiscardClip: this.#opts.forceDiscardClip === true,
      derived: { store: this.#derived },
    };
  }

  /**
   * §7.2: sets a dirty bit; **never** renders synchronously.
   *
   * P2-03: with a `viewId` it sets **that pane's** bit and no other's. Phase 1 ignored the argument
   * and kept one global bit, so a 2×2 layout paid four panes for a one-pane change — an orbit in the
   * 3D cell redrew three slice panes that had not moved.
   */
  requestRender(viewId?: ViewId): void {
    if (viewId === undefined) this.#dirtyAll = true;
    else this.#dirtyViews.add(viewId);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#destroyed || this.#raf !== 0) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') return;
    this.#raf = raf(() => {
      this.#raf = 0;
      if (this.#dirty) this.#renderFrame();
    });
  }

  #renderFrame(): void {
    if (this.#destroyed) return;
    const gl = this.#gl;
    const rects = this.#currentViewports();
    // A resized canvas has no previous frame worth preserving: the drawing buffer was reallocated
    // and every pane's pixels went with it. Same for a layout change, which `setLayout` marks
    // scene-wide. Everything else may repaint one pane.
    const resized =
      this.#lastCanvas.width !== this.#canvas.width ||
      this.#lastCanvas.height !== this.#canvas.height;
    const all = this.#dirtyAll || resized;
    const dirty = this.#dirtyViews;
    this.#lastCanvas = { width: this.#canvas.width, height: this.#canvas.height };
    this.#dirtyAll = false;
    this.#dirtyViews = new Set();

    const t0 = performance.now();
    this.#timer.begin();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (all) {
      // The one clear that covers pixels no pane owns. Skipped for a per-pane repaint, or it would
      // erase the three panes this frame is not drawing.
      gl.disable(gl.SCISSOR_TEST);
      const bg = this.#scene.background;
      gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    const input = this.#drawInput();
    const anchor = planeAnchor(this.#store.bounds());
    this.#lastRects.clear();
    for (const rect of rects) {
      const view = this.#store.view(rect.viewId);
      if (view === undefined) continue;
      // Rectangles are geometry, not paint: they are refreshed for every pane so a pick or a
      // pointer event lands correctly in a pane this frame did not redraw.
      this.#lastRects.set(rect.viewId, rect);
      if (!all && !dirty.has(rect.viewId)) continue;
      const viewProj = this.#renderer.renderView(this.#rendered(view, anchor), rect, input);
      this.#lastViewProj.set(rect.viewId, viewProj);
      const cpuMs = performance.now() - t0;
      this.#emit('frame', {
        viewId: rect.viewId,
        cpuMs,
        gpuMs: this.#timer.lastMs,
        quality: this.#lastQuality,
      });
    }
    this.#timer.end();

    // §7.2's automatic degradation watches the median full-quality frame over the last 30 frames.
    this.#frameTimes.push(performance.now() - t0);
    if (this.#frameTimes.length > FRAME_WINDOW) this.#frameTimes.shift();
    if (!this.#interaction.interacting) {
      const next = adaptiveLevel(this.#frameTimes, this.#scene.quality.name);
      // §7.2: "**never degrade silently**" — `#applyQuality` emits `quality`, which §8's status bar
      // is subscribed to.
      if (next !== null) {
        this.#restQuality = next;
        this.#applyQuality(next);
      }
    }
  }

  /**
   * The view a pane is **rendered** with: `SliceView.camera.center` re-expressed relative to the
   * cursor, which is the frame `sliceViewProj`, the slice quad and the crosshair all speak.
   *
   * See `view/geometry.ts`'s {@link effectiveSliceView} for why the in-plane origin moved off the
   * cursor (R3) and why the compensation lives here rather than in three other owners' files.
   */
  #rendered(view: View, anchor: vec3): View {
    if (!isSliceView(view)) return view;
    return effectiveSliceView(view, this.#scene.cursor, anchor, this.#scene.radiological);
  }

  /** Adopt a `QualityLevel` and tell anyone listening (§7.2: never degrade silently). */
  #applyQuality(name: QualityLevel['name']): void {
    if (this.#scene.quality.name === name) return;
    const level = QUALITY_LEVELS[name];
    this.#store.setQuality(level);
    this.#lastQuality = name;
    this.#emit('quality', level);
  }

  /**
   * §7.2: resolves after `interacting` has cleared, all pending worker requests for visible layers
   * have landed, and one full-quality frame has completed. Every golden awaits this — without it
   * the adaptive pump makes every golden racy.
   *
   * **It always draws at least once, even when nothing is dirty.** Some resources are discovered
   * only *by* a draw and requested lazily from inside it — the element-field table `fillIn2D` reads
   * through `ownerTet`, and the surface tables a glyph's origins come from (`derived/store.ts`).
   * Returning without drawing therefore reported "settled" for a frame whose lazy request had not
   * been made yet, and the next frame changed. Measured on `Thalamus_TI.msh` with `TI_max` on the
   * cut: the frame after `whenSettled()` was the **tag** colouring and the one after that was the
   * colormap — so every pixel assertion and every golden of a field-coloured 2D cut photographed
   * the wrong picture, which is exactly what §11 exists to prevent. Drawing first makes the request
   * register in `#inFlight`, and the loop below then waits for it like any other.
   */
  async whenSettled(): Promise<void> {
    let drew = false;
    for (let guard = 0; guard < 100; guard += 1) {
      if (this.#inFlight.size > 0) {
        await Promise.allSettled([...this.#inFlight]);
        continue;
      }
      if (this.#interaction.interacting) {
        await new Promise((r) => setTimeout(r, 16));
        continue;
      }
      if (this.#dirty) {
        // The **first** repaint goes through the pump: waiting one frame lets the rAF-scheduled
        // render this call would otherwise duplicate happen, and lets a result that is about to
        // land do so before the frame is drawn.
        //
        // Every repaint **after** that is synchronous. The loop reaches here again only because a
        // worker result dirtied the frame again, and there is nothing left for a vsync wait to
        // coalesce — while the wait itself is not free: the R4 sweep pays exactly one per landed
        // cut, and two `await rAF`s per step quantised a 12.9 ms cut plus its draw into 33.3 ms,
        // i.e. two 60 Hz frames, which is a measurement of the display and not of the viewer.
        if (!drew) {
          await new Promise<void>((resolve) => {
            const raf = globalThis.requestAnimationFrame;
            if (typeof raf === 'function') raf(() => resolve());
            else setTimeout(resolve, 16);
          });
        }
        if (this.#dirty) this.#renderFrame();
        drew = true;
        continue;
      }
      if (!drew) {
        // Nothing is dirty and nothing has been drawn under this call: draw once, so a lazy
        // request a draw would make is made and waited for rather than deferred to the caller's
        // next frame.
        this.#renderFrame();
        drew = true;
        continue;
      }
      // §7.2, verbatim: "Every golden screenshot and every `screenshot()` call awaits this and
      // renders at full quality **regardless of the current `QualityLevel`**. Without this the
      // adaptive pump makes every golden test racy."
      //
      // Leaving `interacting` already restores the level the gesture interrupted, so the only case
      // left is the *adaptive* one: 30 slow frames put the scene in `reduced`, which now really does
      // drop `edges` (§7.2's fallback set), and a golden captured there would differ from the same
      // golden on a faster machine. Raising it back to full and drawing once is the sentence above;
      // the pump re-derives the level from the next 30 frames if the machine still warrants it.
      if (this.#scene.quality.name !== 'full') {
        this.#restQuality = 'full';
        this.#applyQuality('full');
        this.renderNow();
      }
      return;
    }
  }

  /**
   * Render right now, outside the pump — the one synchronous path, for pixel readback (§11).
   *
   * Always the **whole** canvas: a caller about to read a pixel back has no way to know which panes
   * P2-03 last repainted, and a screenshot of three preserved panes and one fresh one is a bug that
   * only shows up in the picture.
   */
  renderNow(): void {
    this.#dirtyAll = true;
    this.#renderFrame();
  }

  readPixel(viewId: ViewId, px: number, py: number): Uint8Array {
    const rect = this.#lastRects.get(viewId);
    this.renderNow();
    const gl = this.#gl;
    const out = new Uint8Array(4);
    const r = rect ?? this.#lastRects.get(viewId);
    if (r === undefined) return out;
    const dpr = this.#dpr();
    // §11's convention: top-left origin, like a PNG. `readPixels` is bottom-left.
    const x = r.x + Math.round(px * dpr);
    const y = r.y + r.height - 1 - Math.round(py * dpr);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  /**
   * §4.7's `screenshot`, all of `ScreenshotOptions` (P2-06).
   *
   * Three temporary overrides, each restored in a `finally`, and none of them a second code path:
   *
   * * **`background`** — `'white'` clears to opaque white; `'transparent'` draws the frame **twice**,
   *   over black and over white, and solves for the coverage
   *   (`render/screenshot.ts`'s `matteOverBlackAndWhite`). The context is created with `alpha: false`
   *   (`gl/context.ts`), so the drawing buffer has no alpha to read back and clearing to `[0,0,0,0]`
   *   yields an opaque black PNG — which is what Phase 1 shipped. Punching the background colour out
   *   of the pixels instead was rejected for the reason it always is: it cannot tell a background
   *   pixel from a fragment that happens to match it.
   * * **`include`** — the chrome items are drawn *into* the framebuffer (§8, §11), so suppressing one
   *   is an `Annotations` override for the duration of the render, not a post-process.
   * * **`width` / `height` / `scale`** — §7.0.4 forbids a resolve-and-rescale blit, so the frame is
   *   **rendered at the requested size**: the drawing buffer is resized, the frame is drawn, and the
   *   canvas goes back to the size its embedder gave it. All of that happens inside this one task,
   *   so the compositor never sees the intermediate size.
   * * **`target: 'view'`** — the crop rectangle is read from the viewports *at the render size*, so a
   *   pane comes out at exactly the requested pixels rather than upscaled from 384.
   */
  async screenshot(opts: ScreenshotOptions): Promise<Blob> {
    await this.whenSettled();
    const paneRect = opts.viewId !== undefined ? this.paneRect(opts.viewId) : null;
    const plan = screenshotPlan(opts, this.#canvas, paneRect);

    const sceneBackground = this.#store.scene.background;
    const sceneAnnotations = this.#store.scene.annotations;
    const size = { width: this.#canvas.width, height: this.#canvas.height };
    try {
      this.#store.replaceAnnotations(screenshotAnnotations(opts.include));
      if (plan.renderWidth !== size.width || plan.renderHeight !== size.height) {
        this.#canvas.width = plan.renderWidth;
        this.#canvas.height = plan.renderHeight;
      }
      const shoot = (background: vec4 | null): Image => {
        if (background !== null) this.#store.setBackground(background);
        this.renderNow();
        return frameImage(this.#gl, this.#canvas.width, this.#canvas.height);
      };
      let frame: Image;
      if (opts.background === 'transparent') {
        const overBlack = shoot(OPAQUE_BLACK);
        frame = matteOverBlackAndWhite(overBlack, shoot(OPAQUE_WHITE));
      } else {
        frame = shoot(opts.background === 'white' ? OPAQUE_WHITE : null);
      }
      const crop =
        opts.target === 'view' && opts.viewId !== undefined
          ? (this.paneRect(opts.viewId) ?? undefined)
          : undefined;
      return await encodeImage(composeScreenshot(frame, opts, plan, crop), opts);
    } finally {
      this.#store.setBackground(sceneBackground);
      this.#store.replaceAnnotations(sceneAnnotations);
      if (this.#canvas.width !== size.width || this.#canvas.height !== size.height) {
        this.#canvas.width = size.width;
        this.#canvas.height = size.height;
      }
      // The drawing buffer was reallocated twice; nothing that was on screen survived it.
      this.renderNow();
    }
  }

  // -----------------------------------------------------------------------------------------
  // §7.5's interaction surface (P2-01/P2-02, R1/R2/R3)
  //
  // Every gesture the pointer layer performs is a **public method here**, and the pointer layer is
  // the only caller inside the engine. That is not decoration: §8 requires that "everything the UI
  // can do must be reachable from the `Engine` API alone", and a gesture implemented inside an
  // event handler is reachable from nothing — not from the app, not from a test, not from a script.
  // `TetravoxEngine implements PointerHost` is what keeps the two halves honest.
  //
  // They are appended to the concrete engine rather than to the frozen §4.7 `Engine` (§12.3): the
  // ownership map gives E-SCENE exactly one `api.ts` carve-out and it is P2-09's, not this.
  // -----------------------------------------------------------------------------------------

  /** {@link PointerHost}: the element the pointer layer binds to. */
  get canvas(): HTMLCanvasElement {
    return this.#canvas;
  }

  /** {@link PointerHost}: device pixels per CSS pixel, from the canvas the embedder sized. */
  dpr(): number {
    return this.#dpr();
  }

  /**
   * §7.2: an input happened — raise `interacting` and re-arm its settle timer.
   *
   * Public because §7.2 counts **key repeat** as an interaction and the keyboard lives in the app
   * (`keyboard/keymap.ts` resolves it, `store/controller.ts` executes it). The pointer layer calls
   * this for itself.
   */
  noteInput(): void {
    this.#interaction.note();
  }

  /** §7.2's `interacting`, for the app's status bar and for a test that must not guess. */
  get interacting(): boolean {
    return this.#interaction.interacting;
  }

  /**
   * {@link PointerHost}: which pane covers a canvas point, in **device pixels, top-left origin**.
   *
   * `viewports()` works bottom-left, like `gl.viewport`; pointer events work top-left, like every
   * other coordinate a user sees. §7.5's layout module says the engine converts "at the single
   * point that reads them" — this is that point, and the pane-local coordinates it hands out are
   * top-left from here on.
   */
  paneAt(x: number, y: number): PaneHit | null {
    const h = this.#canvas.height;
    const glY = h - y;
    for (const rect of this.#currentViewports()) {
      if (x < rect.x || x >= rect.x + rect.width) continue;
      if (glY < rect.y || glY >= rect.y + rect.height) continue;
      const view = this.#store.view(rect.viewId);
      if (view === undefined) continue;
      return {
        viewId: rect.viewId,
        is3D: !isSliceView(view),
        x: x - rect.x,
        y: y - (h - rect.y - rect.height),
        width: rect.width,
        height: rect.height,
      };
    }
    return null;
  }

  /** {@link PointerHost}: one pane's rectangle, device pixels, **top-left origin**. */
  paneRect(viewId: ViewId): { x: number; y: number; width: number; height: number } | null {
    for (const rect of this.#currentViewports()) {
      if (rect.viewId !== viewId) continue;
      return {
        x: rect.x,
        y: this.#canvas.height - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
    }
    return null;
  }

  /**
   * R1: the world point at a pane pixel, on that pane's derived slice plane.
   *
   * §7.2.3: "2D views use no GPU pick — cursor = pointer ray ∩ that view's derived slice plane, on
   * the CPU." An orthographic 2D pane makes that intersection a basis change rather than a ray cast.
   */
  worldAtScreen(viewId: ViewId, x: number, y: number): vec3 | null {
    const view = this.#store.view(viewId);
    const rect = this.paneRect(viewId);
    if (view === undefined || rect === null || !isSliceView(view)) return null;
    return paneToWorld(
      view,
      this.#scene.cursor,
      planeAnchor(this.#store.bounds()),
      this.#scene.radiological,
      rect,
      x,
      y
    );
  }

  /** R1: left-click / left-drag in a 2D pane sets the cursor to the world point under the pointer. */
  setCursorFromScreen(viewId: ViewId, x: number, y: number): void {
    const world = this.worldAtScreen(viewId, x, y);
    if (world === null) return;
    this.setCursor(world);
  }

  /**
   * P2-04: the `hover` event, and with it §8's live `Mouse` block.
   *
   * Emitted for 2D panes only. A 3D hover would need a pick — a scissored geometry pass plus a
   * synchronous readback — on **every** `pointermove`, which §8's ≤ 16 ms volume budget does not
   * buy; the 3D pane keeps `double-click = pick` (§7.5) for the same information on demand.
   */
  hoverAtScreen(viewId: ViewId | null, x: number, y: number): void {
    const world = viewId === null ? null : this.worldAtScreen(viewId, x, y);
    if (world === null) {
      if (this.#scene.hover === null) return;
      this.#store.setHover(null);
      this.#emit('hover', null);
      return;
    }
    this.#store.setHover(world);
    this.#emit('hover', world);
    // Latest-wins on each runtime's own key (§5 rule 6), which is what keeps a hover off the queue
    // behind a cut and inside §8's ≤ 50 ms mesh budget.
    for (const rt of this.#runtimesInOrder()) rt.refreshProbe(world);
  }

  /** R3: pan a 2D pane — middle-drag, `space`+drag or a two-finger trackpad drag. Never left-drag. */
  panView(viewId: ViewId, dxPx: number, dyPx: number): void {
    const view = this.#store.view(viewId);
    if (view === undefined) return;
    if (!isSliceView(view)) {
      this.pan3DView(viewId, dxPx, dyPx);
      return;
    }
    this.setView(viewId, { camera: panBy(view.camera, dxPx, dyPx) });
  }

  /** R2: zoom a pane about a point in it, keeping the world point under that point fixed. */
  zoomViewAt(viewId: ViewId, x: number, y: number, factor: number): void {
    const view = this.#store.view(viewId);
    const rect = this.paneRect(viewId);
    if (view === undefined || rect === null) return;
    if (!isSliceView(view)) {
      this.dollyView(viewId, (Math.log(factor) / Math.log(1.2)) * 100);
      return;
    }
    const offsetX = x + 0.5 - rect.width / 2;
    const offsetY = rect.height / 2 - y - 0.5;
    this.setView(viewId, { camera: zoomAbout(view.camera, offsetX, offsetY, factor) });
  }

  /** R2: `+` / `-` — the same zoom, about the pane centre. */
  zoomView(viewId: ViewId, factor: number): void {
    const view = this.#store.view(viewId);
    if (view === undefined) return;
    if (!isSliceView(view)) {
      this.dollyView(viewId, (Math.log(factor) / Math.log(1.2)) * 100);
      return;
    }
    this.setView(viewId, { camera: zoomAboutCentre(view.camera, factor) });
  }

  /**
   * §7.5's wheel: slice ±1. R4's E-SCENE half: **this works with no volume loaded** — `stepMm` falls
   * back to 1 mm and the scene bounds come from the meshes, so a wheel notch sweeps `ernie.msh`
   * exactly as it sweeps `T1.nii.gz`.
   */
  stepSlice(viewId: ViewId, steps: number): void {
    this.stepCursor(viewId, steps);
  }

  /**
   * §7.5's right-drag: window/level on the **active** layer, "falling back to the topmost non-label
   * volume layer".
   *
   * A label volume is excluded on purpose and in both roles: its `Scale` addresses a dense index,
   * not a physical value, so windowing it would slide the palette off the regions it names.
   */
  windowLevelDrag(_viewId: ViewId, nx: number, ny: number): void {
    const target = this.#windowLevelTarget();
    if (target === null) return;
    this.updateLayer(target.id, { scale: windowLevel(target.scale, nx, ny) as Scale });
  }

  #windowLevelTarget(): { id: LayerId; scale: Scale } | null {
    const active = this.#scene.layers.find((l) => l.id === this.#scene.activeLayerId);
    if (active !== undefined && (active.kind === 'volume' || active.kind === 'mesh')) {
      const ds = this.#scene.datasets.get(active.datasetId);
      const isLabelVolume = active.kind === 'volume' && ds?.kind === 'volume' && ds.isLabel;
      if (!isLabelVolume)
        return { id: active.id, scale: (active as VolumeLayer | MeshLayer).scale };
    }
    for (let i = this.#scene.layers.length - 1; i >= 0; i -= 1) {
      const l = this.#scene.layers[i];
      if (l === undefined || l.kind !== 'volume' || !l.visible) continue;
      const ds = this.#scene.datasets.get(l.datasetId);
      if (ds === undefined || ds.kind !== 'volume' || ds.isLabel) continue;
      return { id: l.id, scale: l.scale };
    }
    return null;
  }

  /** §7.5's `Shift+drag`: the active layer's opacity. Dragging up makes it more opaque. */
  opacityDrag(ny: number): void {
    const id = this.#scene.activeLayerId;
    if (id === null) return;
    const layer = this.#scene.layers.find((l) => l.id === id);
    if (layer === undefined) return;
    this.updateLayer(id, { opacity: opacityAfterDrag(layer.opacity, ny) });
  }

  /** §7.5's 3D left-drag: arcball orbit. */
  orbitView(viewId: ViewId, dxPx: number, dyPx: number): void {
    const view = this.#store.view(viewId);
    if (view === undefined || isSliceView(view)) return;
    this.setView(viewId, { camera: orbit(view.camera, dxPx, dyPx) });
  }

  /** §7.5's 3D right-drag: slide the camera target. */
  pan3DView(viewId: ViewId, dxPx: number, dyPx: number): void {
    const view = this.#store.view(viewId);
    const rect = this.paneRect(viewId);
    if (view === undefined || isSliceView(view) || rect === null) return;
    this.setView(viewId, { camera: pan3D(view.camera, dxPx, dyPx, rect.height) });
  }

  /** §7.5's 3D wheel: dolly. */
  dollyView(viewId: ViewId, deltaY: number): void {
    const view = this.#store.view(viewId);
    if (view === undefined || isSliceView(view)) return;
    this.setView(viewId, { camera: dolly(view.camera, deltaY) });
  }

  /**
   * §7.5's 3D double-click: `setCursorFromPick`.
   *
   * `pick` takes pane-local **CSS** pixels (it scales by the DPR itself); the pointer layer works in
   * device pixels throughout, so the conversion happens here rather than in four call sites.
   */
  pickToCursor(viewId: ViewId, x: number, y: number): boolean {
    const dpr = this.#dpr();
    return this.setCursorFromPick(viewId, x / dpr, y / dpr);
  }

  // -----------------------------------------------------------------------------------------
  // §7.5's oblique affordances: the gizmo, its rotate handles, plane-from-3-points, and presets.
  //
  // §7.5 closes with "`mode:'oblique'` is fully supported by the model and the shader path from
  // Phase 1 and gets its **affordances** (gizmo, rotate handles, plane-from-3-points) in Phase 2" —
  // which is to say the plane maths already worked and there was no way to *reach* an oblique plane
  // from the viewer. These four methods are that way, and like the rest of P2-01's surface they are
  // public on the concrete engine rather than on the frozen §4.7 facade.
  // -----------------------------------------------------------------------------------------

  /**
   * Show the cut-plane gizmo for one slice view, or hide it (`null`).
   *
   * The gizmo is drawn in the **3D** pane and manipulates the named 2D pane's plane, which is the
   * only arrangement that makes sense for an oblique view: a gizmo drawn inside the pane whose plane
   * it rotates would be looking at that plane edge-on, i.e. at a line.
   */
  showGizmo(viewId: ViewId | null): void {
    this.#gizmoView = viewId;
    this.#gizmoHot = 'none';
    this.requestRender();
  }

  get gizmoView(): ViewId | null {
    return this.#gizmoView;
  }

  /** The live {@link GizmoSpec}, or `null` when no gizmo is shown. */
  gizmoSpec(): GizmoSpec | null {
    if (this.#gizmoView === null) return null;
    const view = this.#store.view(this.#gizmoView);
    if (view === undefined || !isSliceView(view)) return null;
    const bounds = this.#store.bounds();
    const { right, up } = sliceBasis(view, this.#scene.radiological);
    const diag = Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    );
    return {
      // §4.5: the plane is derived from the cursor, never stored — including here.
      plane: slicePlane(view, this.#scene.cursor),
      center: this.#scene.cursor,
      radiusMm: Math.max(1, diag * GIZMO_RADIUS_FRACTION),
      hot: this.#gizmoHot,
      u: right,
      v: up,
    };
  }

  /**
   * Which gizmo handle a point in the 3D pane is over — device pixels, pane-local, top-left origin.
   *
   * Also latches the highlight, so hovering a handle lights it up: the hit test and the picture are
   * the same three points (`overlay/gizmo.ts`), and a handle that highlights is how a user learns
   * there is something to grab.
   */
  gizmoAt(viewId: ViewId, x: number, y: number): GizmoHandle | null {
    const spec = this.gizmoSpec();
    const rect = this.paneRect(viewId);
    const viewProj = this.#lastViewProj.get(viewId);
    const view = this.#store.view(viewId);
    if (spec === null || rect === null || viewProj === undefined) return null;
    if (view === undefined || isSliceView(view)) return null;
    const hit = gizmoHandleAt(viewProj, rect, spec, x, y);
    if (hit !== this.#gizmoHot && (hit ?? 'none') !== this.#gizmoHot) {
      this.#gizmoHot = hit ?? 'none';
      this.requestRender(viewId);
    }
    return hit;
  }

  /**
   * Drag a gizmo handle: `translate` slides the plane along its normal, `rotateU` / `rotateV` rotate
   * it about its own in-plane axes.
   *
   * Translation moves the **cursor**, not a stored offset — §4.5 derives the plane from the cursor
   * and "one source of truth (the cursor) ⇒ cursor sync is identical for canonical and oblique
   * views". Rotation goes through `rotatePlane`, which carries `up` along rigidly so the pane rotates
   * without also rolling.
   */
  gizmoDrag(handle: GizmoHandle, dxPx: number, dyPx: number): void {
    const viewId = this.#gizmoView;
    if (viewId === null) return;
    const view = this.#store.view(viewId);
    if (view === undefined || !isSliceView(view)) return;
    this.#gizmoHot = handle;
    if (handle === 'translate') {
      const camera = this.#store.scene.view3d.camera;
      const rect = this.paneRect(VIEW3D_ID);
      const mmPerPx = mmPerPx3D(camera, rect?.height ?? 512);
      // Screen-down is world-negative along the normal, so a downward drag pushes the plane away.
      const mm = -dyPx * mmPerPx;
      const c = this.#scene.cursor;
      this.setCursor([
        c[0] + view.normal[0] * mm,
        c[1] + view.normal[1] * mm,
        c[2] + view.normal[2] * mm,
      ]);
      return;
    }
    const { right, up } = sliceBasis(view, this.#scene.radiological);
    // Rotating about `up` is what the handle on `right` sweeps, and vice versa.
    const axis = handle === 'rotateU' ? up : right;
    const angle = (handle === 'rotateU' ? dxPx : -dyPx) * GIZMO_RAD_PER_PX;
    const rotated = rotatePlane(view.normal, view.up, axis, angle);
    this.setView(viewId, { mode: 'oblique', normal: rotated.normal, up: rotated.up });
    // The plane moved, so every pane's geometry did: this is not a one-pane repaint.
    this.requestRender();
  }

  /**
   * §7.5's **plane-from-3-points**: set a pane's plane to the one through three world points, and
   * move the cursor onto it.
   *
   * Returns `false` for three collinear points, where no plane exists (`planeFromPoints`) — a third
   * click on the line through the first two has to fail visibly rather than produce a NaN normal that
   * blanks every pane.
   */
  setViewPlaneFromPoints(viewId: ViewId, a: vec3, b: vec3, c: vec3): boolean {
    const view = this.#store.view(viewId);
    if (view === undefined || !isSliceView(view)) return false;
    const plane = planeFromPoints(a, b, c);
    if (plane === null) return false;
    this.setView(viewId, { mode: 'oblique', normal: plane.normal, up: plane.up });
    // The centroid: on the plane by construction, and the point the three clicks were about.
    this.setCursor([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
    return true;
  }

  /**
   * Start (or abandon, with `null`) collecting three clicks for {@link setViewPlaneFromPoints}.
   *
   * The collector is engine-side because the points are **world** points on the panes' current
   * planes, which only the engine can compute (§7.2.3: a 2D cursor is the pointer ray ∩ that view's
   * derived plane). While it is armed, a left-click in any 2D pane contributes a point instead of
   * setting the cursor; the third one sets the plane.
   */
  beginPlaneFromPoints(viewId: ViewId | null): void {
    this.#planePoints = viewId === null ? null : { viewId, points: [] };
  }

  /** How many of the three points have been collected, or `null` when not collecting. */
  get planeFromPointsPending(): number | null {
    return this.#planePoints === null ? null : this.#planePoints.points.length;
  }

  /**
   * Contribute one world point to an armed plane-from-3-points, from a pane pixel.
   *
   * Returns `true` while it is consuming clicks, so the pointer layer knows not to also move the
   * cursor. The collector disarms itself on the third point, whether the plane could be built or not
   * — three collinear clicks end the gesture rather than trapping the user in it.
   */
  addPlanePoint(viewId: ViewId, x: number, y: number): boolean {
    const pending = this.#planePoints;
    if (pending === null) return false;
    const world = this.worldAtScreen(viewId, x, y);
    if (world === null) return true;
    pending.points.push(world);
    if (pending.points.length < 3) {
      this.requestRender();
      return true;
    }
    const [a, b, c] = pending.points as [vec3, vec3, vec3];
    this.#planePoints = null;
    this.setViewPlaneFromPoints(pending.viewId, a, b, c);
    return true;
  }

  /**
   * §7.6's "defaults from X.msh.opt": which layer fields the sidecar seeded, and its name.
   *
   * A-SHELL owns the chip and the one-click Reset; this is the metadata it needs, and it is derived
   * rather than stored — the same `seedMeshLayerFromOpt` that produced the layer, asked again. Reset
   * is `defaultMeshLayer` without the seeding, which the app reaches by patching the layer back to
   * the values the chip names.
   */
  optDefaults(datasetId: DatasetId): MshOptSeed | null {
    const ds = this.#store.dataset(datasetId);
    if (ds === undefined || ds.kind !== 'mesh') return null;
    const layer = this.#scene.layers.find((l) => l.datasetId === datasetId && l.kind === 'mesh') as
      MeshLayer | undefined;
    if (layer === undefined) return null;
    return seedMeshLayerFromOpt(layer, ds).seed;
  }

  /**
   * §7.5's preset normals, on a **2D** pane — the way back from oblique.
   *
   * `cameraPreset` is the 3D camera's `1..6`; this is its slice-view twin, and it is what makes the
   * oblique affordances safe to offer: a user who has rotated a pane into an unrecognisable
   * orientation needs one action that puts it back, and "reload the scene" is not it.
   */
  setSliceMode(viewId: ViewId, mode: SliceMode): void {
    const view = this.#store.view(viewId);
    if (view === undefined || !isSliceView(view)) return;
    this.setView(viewId, { mode, normal: presetNormal(mode), up: presetUp(mode) });
    this.requestRender();
  }

  // -----------------------------------------------------------------------------------------
  // Serialisation — §4.6 / P2-07. The relocate dialog is the app's half (§8).
  // -----------------------------------------------------------------------------------------

  /**
   * Where the scene file lives, for §4.6's "paths **relative to the scene file**".
   *
   * §4.7's `serialize()` takes no argument and is frozen, so the one thing the engine cannot derive —
   * where the host is about to write the file — is told to it instead. Left `null`, `serialize()`
   * measures relative paths from the datasets' own common directory, which is the best guess
   * available and is exactly right for the common case of a scene saved beside its data. `absPath` is
   * written either way, so nothing depends on this being set.
   */
  setSceneDir(dir: string | null): void {
    this.#sceneDir = dir;
  }

  get sceneDir(): string | null {
    return this.#sceneDir;
  }

  serialize(): ViewSpec {
    return toViewSpec(this.#scene, {
      sceneDir: this.#sceneDir,
      fingerprints: this.#fingerprints,
      sidecars: this.#sidecars,
    });
  }

  /**
   * §4.7's `load` — datasets, then **layers**, then views (P2-07).
   *
   * The order is forced. `addDataset` hands back a fresh `DatasetId`, so the spec's ids are stale the
   * moment the first one lands: layers can only be recreated once the old→new map exists, and the
   * views' `layerVisibility` and `activeLayerId` only once the layers have theirs. Phase 1 restored
   * neither and could not have — `scene/serialize.ts` said so.
   *
   * `resolve` is §8's relocate hook: it returns the path to open for a `DatasetRef`, or `null` to
   * skip. A skipped dataset takes its layers with it (`remapLayer` returns `null`), so a partly
   * relocated scene opens as the part that resolved rather than as a scene full of layers pointing at
   * nothing. `scene/serialize.ts`'s `candidatePaths` is the "relative first, absolute fallback"
   * policy a host should try before it asks the user.
   */
  async load(input: ViewSpec, resolve: (r: DatasetRef) => string | null): Promise<void> {
    // One migration point, so a host that read the file itself and a host that did not both get a
    // spec at `SCENE_VERSION` (§4.6, directed task 13).
    const spec = migrateViewSpec(input);
    const idMap = new Map<DatasetId, DatasetId>();
    for (const ref of spec.datasets) {
      const path = resolve(ref);
      if (path === null) continue;
      // §6.5.1's sidecars come back with the dataset, resolved **against the path that resolved** —
      // so a scene whose data moved brings its `.msh.opt` and its LUT along, which is the whole
      // point of anchoring `SidecarRef.path` to the dataset's own directory. A sidecar that is not
      // there any more is a missing table, never a failed load: `loadSource` reads them
      // best-effort (`packages/wasm/src/sources.ts`).
      const sidecars = sidecarPathsFor(ref, path);
      const ds = await this.addDataset(
        Object.keys(sidecars).length > 0 ? { kind: 'path', path, sidecars } : { kind: 'path', path }
      );
      idMap.set(ref.id, ds.id);
    }

    const layerMap = new Map<LayerId, LayerId>();
    for (const serialized of spec.layers) {
      // Only the kinds `scene/defaults.ts` can seed today; `addLayer` derives a layer's kind from its
      // dataset, so an `iso` or `points` layer would come back as a volume or a mesh one. Their
      // defaults are E-DERIVED's, and this restores them unchanged the day they land.
      if (!isRestorableKind(serialized.kind)) continue;
      const patch = remapLayer(serialized, idMap);
      if (patch === null) continue;
      const created = this.addLayer(patch as NewLayer);
      layerMap.set(serialized.id, created.id);
    }

    applyViewSpec(this.#store, spec, layerMap);
    const active = spec.activeLayerId;
    this.#store.setActiveLayer(active !== null ? (layerMap.get(active) ?? null) : null);
    this.#emit('layers', [...this.#scene.layers]);
    this.#emit('cursor', this.#scene.cursor);
    this.requestRender();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#raf !== 0 && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.#raf);
    }
    this.#pointer?.dispose();
    this.#interaction.cancel();
    this.#cuts.dispose();
    for (const id of [...this.#workers.keys()]) this.#teardown(id);
    for (const rt of this.#layers.values()) rt.dispose();
    for (const owned of this.#iso3d.values()) for (const rt of owned.values()) rt.dispose();
    this.#iso3d.clear();
    this.#layers.clear();
    this.#renderer.dispose();
    this.#derived.dispose();
    this.#gpu.dispose();
    this.#timer.dispose();
    this.#listeners.clear();
    // Two maps that describe GL objects which no longer exist.
    this.#lastViewProj.clear();
    this.#lastRects.clear();
  }
}

/** A probe row that actually says something — anything beyond the layer's own name. */
function hasProbeContent(row: ProbeRow): boolean {
  return (
    row.value !== undefined ||
    row.voxel !== undefined ||
    row.elementId !== undefined ||
    row.labelId !== undefined
  );
}

function dist3(a: vec3, b: vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export { camera3dMatrices, sliceBasis };
