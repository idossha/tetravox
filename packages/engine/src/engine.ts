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
import type { GpuCapsT, MeshMeta, SurfacePayload, VolumeMeta } from '@tetravox/protocol';
import type {
  DatasetSource,
  Engine,
  EngineEvents,
  EngineOptions,
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
import { Timer } from './gl/timer';
import { GpuStore, surfaceKey } from './render/gpu';
import { Renderer } from './render/renderer';
import { TRANSPARENT, encodeFrame } from './render/screenshot';
import type { DrawInput } from './render/renderer';
import { createLayerRuntime } from './layers/registry';
import { buildLabelPalette } from './layers/volume';
import type { LayerRuntime, LayerRuntimeContext } from './layers/runtime';
import { viewports } from './view/layout';
import type { ViewportRect } from './view/layout';
import {
  camera3dMatrices,
  effectiveSliceView,
  fitCamera,
  paneToWorld,
  planeAnchor,
  presetRotation,
  sliceBasis,
  stepMm,
  worldToVoxel,
} from './view/geometry';
import {
  adaptiveLevel,
  dolly,
  FRAME_WINDOW,
  InteractionState,
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
import type { PaneHit, PointerHost } from './input';
import { meshDatasetFromMeta, volumeDatasetFromMeta } from './scene/fromMeta';
import { defaultLayerFor, VIEW3D_ID } from './scene/defaults';
import { SceneStore, isSliceView } from './scene/store';
import { applyViewSpec, toViewSpec } from './scene/serialize';
import { looksLikeVolume, sourceName, toLoadSource } from './datasets/source';
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
  SliceView,
  vec3,
  View,
  View3D,
  ViewId,
  ViewSpec,
  VolumeDataset,
  VolumeLayer,
} from './scene/types';

type Listener = (payload: never) => void;

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
  readonly #timer: Timer;
  readonly #opts: EngineOptions;

  /** The §4.5 scene. Every mutation goes through it; every event is emitted from here. */
  readonly #store = new SceneStore();
  /** One `LayerRuntime` per layer — all per-kind decisions live there (`layers/`). */
  readonly #layers = new Map<LayerId, LayerRuntime>();
  /** One worker per dataset (§5 rule 1). */
  readonly #workers = new Map<DatasetId, DatasetRuntime>();
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
  /** The view-projection each pane last rendered with, so a pick reuses it exactly (§7.2.3). */
  readonly #lastViewProj = new Map<ViewId, mat4>();
  readonly #lastRects = new Map<ViewId, ViewportRect>();

  /** Read-only view of the scene the store owns. */
  get #scene(): Scene {
    return this.#store.scene;
  }

  /** True when anything at all is waiting to be drawn (P2-03). */
  get #dirty(): boolean {
    return this.#dirtyAll || this.#dirtyViews.size > 0;
  }

  /** The four things a `LayerRuntime` is allowed to reach (`layers/runtime.ts`). */
  get #layerContext(): LayerRuntimeContext {
    return {
      gpu: this.#gpu,
      client: (id: DatasetId) => this.#workers.get(id)?.client,
      requestRender: () => this.requestRender(),
      track: <T>(p: Promise<T>) => this.#track(p),
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
      const req = client.start(`load:${id}`, 'loadMesh', { source, format: 'auto' });
      runtime.loadId = req.id;
      const res = await this.#track(req.promise);
      runtime.loadId = null;
      if (runtime.cancelled) throw new Error('cancelled');
      return await this.#adoptMesh(id, res.meta, path);
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

    this.#store.addDataset(ds);
    this.#emit('datasets', [...this.#scene.datasets.values()]);
    this.#onFirstDataset();
    return ds;
  }

  async #adoptMesh(id: DatasetId, meta: MeshMeta, path: string | undefined): Promise<MeshDataset> {
    const ds = meshDatasetFromMeta(id, meta, { id: this.#nextId }, path);
    const rt = this.#workers.get(id);
    if (rt === undefined) throw new Error('dataset worker is gone');

    // §6.3's default 3D representation: the mesh's OWN tagged triangles when it has them, and the
    // derived boundary only when it has none (`grey_Thalamus_TI.msh` — 1,340,029 tets, 0 tris).
    // `tag_surfaces` takes no topology and does no geometry work beyond grouping and normals, which
    // is what keeps this off the `build_topology` path entirely.
    const payload: SurfacePayload = ds.hasTris
      ? await this.#track(
          rt.client.call(`surface:${id}`, 'surface', { handle: ds.handle, variant: 'indexed' })
        )
      : await this.#track(
          rt.client.call(`surface:${id}`, 'boundary', { handle: ds.handle, variant: 'indexed' })
        );
    this.#gpu.uploadSurface(surfaceKey(id, 'indexed'), payload);
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
      const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const rect = this.#lastRects.get(this.#scene.slices[0]?.id ?? '') ?? null;
      const px = rect !== null ? Math.min(rect.width, rect.height) : 512;
      const mmPerPx = Math.max(0.05, (diag * 0.62) / Math.max(1, px));
      this.#store.setSlices(
        this.#scene.slices.map((s) => ({ ...s, camera: { center: [0, 0], mmPerPx } }))
      );
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
    }
    this.#gpu.dropVolume(id);
    this.#gpu.dropSurfaces(id);
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
    const base = defaultLayerFor(id, ds as VolumeDataset | MeshDataset);
    const layer = { ...base, ...spec, id, datasetId: ds.id, kind: base.kind } as Layer;
    this.#store.addLayer(layer);
    // The runtime is what makes the layer's kind mean anything (`layers/registry.ts`).
    this.#layers.set(id, createLayerRuntime(layer, ds, this.#layerContext));
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
    return layer;
  }

  removeLayer(id: LayerId): void {
    this.#store.removeLayer(id);
    this.#layers.get(id)?.dispose();
    this.#layers.delete(id);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void {
    const next = this.#store.updateLayer(id, patch);
    if (next !== undefined) this.#layers.get(id)?.applyPatch(next);
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

  /** The runtimes in **layer order** (bottom → top, §4.4), which is the order everything consumes. */
  #runtimesInOrder(): LayerRuntime[] {
    const out: LayerRuntime[] = [];
    for (const layer of this.#scene.layers) {
      const rt = this.#layers.get(layer.id);
      if (rt !== undefined) out.push(rt);
    }
    return out;
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
   */
  stepCursor(viewId: ViewId, steps: number): void {
    const view = this.#store.view(viewId);
    if (view === undefined || !isSliceView(view)) return;
    const top = this.#store.topVolume();
    const step = stepMm(
      view.normal,
      top?.ds.affine ?? null,
      top?.ds.spacing ?? null,
      this.#store.bounds()
    );
    const c = this.#scene.cursor;
    let next: vec3 = [
      c[0] + view.normal[0] * step * steps,
      c[1] + view.normal[1] * step * steps,
      c[2] + view.normal[2] * step * steps,
    ];
    if (top !== undefined) {
      const v = worldToVoxel(top.ds, next);
      const snapped: vec3 = [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];
      const a = top.ds.affine;
      next = [
        (a[0] ?? 0) * snapped[0] +
          (a[4] ?? 0) * snapped[1] +
          (a[8] ?? 0) * snapped[2] +
          (a[12] ?? 0),
        (a[1] ?? 0) * snapped[0] +
          (a[5] ?? 0) * snapped[1] +
          (a[9] ?? 0) * snapped[2] +
          (a[13] ?? 0),
        (a[2] ?? 0) * snapped[0] +
          (a[6] ?? 0) * snapped[1] +
          (a[10] ?? 0) * snapped[2] +
          (a[14] ?? 0),
      ];
    }
    this.setCursor(next);
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
      const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const rect = this.#lastRects.get(viewId);
      const px = rect !== undefined ? Math.min(rect.width, rect.height) : 512;
      const mmPerPx = Math.max(0.05, (diag * 0.62) / Math.max(1, px));
      this.#store.setSlices(
        this.#scene.slices.map((s) =>
          s.id === viewId ? { ...s, camera: { center: [0, 0], mmPerPx } } : s
        )
      );
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
    return { world, rows };
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
      canvasWidth: this.#canvas.width,
      canvasHeight: this.#canvas.height,
      activeViewId: null,
      uiScale: Math.max(1, Math.round(this.#dpr())),
      showChrome: true,
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
   */
  async whenSettled(): Promise<void> {
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
        // Render on the next frame, then loop: a worker result may have dirtied it again.
        await new Promise<void>((resolve) => {
          const raf = globalThis.requestAnimationFrame;
          if (typeof raf === 'function') raf(() => resolve());
          else setTimeout(resolve, 16);
        });
        if (this.#dirty) this.#renderFrame();
        continue;
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

  async screenshot(opts: ScreenshotOptions): Promise<Blob> {
    await this.whenSettled();
    // §4.7's `background: 'transparent'`. The frame is cleared to `scene.background`, whose alpha is
    // 1, so reading it back and calling the result transparent produced an opaque PNG. Clear to zero
    // for this one render and put the scene's colour back afterwards — the alternative, punching the
    // background colour out of the pixels, cannot tell a background pixel from a fragment that
    // happens to match it.
    const sceneBackground = this.#store.scene.background;
    if (opts.background === 'transparent') this.#store.setBackground(TRANSPARENT);
    try {
      this.renderNow();
    } finally {
      this.#store.setBackground(sceneBackground);
    }
    return await encodeFrame(this.#gl, this.#canvas.width, this.#canvas.height, opts);
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
  // Serialisation — §4.6. Phase 2 owns the relocate dialog; the shape is here from Phase 1.
  // -----------------------------------------------------------------------------------------

  serialize(): ViewSpec {
    return toViewSpec(this.#scene);
  }

  async load(spec: ViewSpec, resolve: (r: DatasetRef) => string | null): Promise<void> {
    for (const ref of spec.datasets) {
      const path = resolve(ref);
      if (path === null) continue;
      await this.addDataset({ kind: 'path', path });
    }
    applyViewSpec(this.#store, spec);
    this.requestRender();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#raf !== 0 && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.#raf);
    }
    this.#pointer?.dispose();
    this.#interaction.cancel();
    for (const id of [...this.#workers.keys()]) this.#teardown(id);
    for (const rt of this.#layers.values()) rt.dispose();
    this.#layers.clear();
    this.#renderer.dispose();
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
