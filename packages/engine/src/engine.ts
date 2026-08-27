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
import { CutManager } from './compute/cut-manager';
import { createLayerRuntime } from './layers/registry';
import { buildLabelPalette } from './layers/volume';
import type { LayerRuntime, LayerRuntimeContext } from './layers/runtime';
import { viewports } from './view/layout';
import type { ViewportRect } from './view/layout';
import {
  camera3dMatrices,
  fitCamera,
  presetRotation,
  sliceBasis,
  stepMm,
  worldToVoxel,
} from './view/geometry';
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
  QualityLevel,
  Scene,
  SliceView,
  vec3,
  View,
  View3D,
  ViewId,
  ViewSpec,
  VolumeDataset,
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

export class TetravoxEngine implements Engine {
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
  /**
   * The engine's one owner of the `cut` op (§6.5.2), keyed by `(datasetId, key)` so §7.4's 3D caps
   * and each 2D pane's cross-section never supersede one another (`compute/cut-manager.ts`).
   */
  readonly #cuts = new CutManager((id) => {
    const rt = this.#workers.get(id);
    const ds = this.#store.dataset(id);
    if (rt === undefined || ds === undefined || ds.kind !== 'mesh') return undefined;
    return { client: rt.client, handle: ds.handle };
  });
  readonly #listeners = new Map<string, Set<Listener>>();

  #nextId = 1;
  #dirty = true;
  #raf = 0;
  #destroyed = false;
  #interacting = false;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #frameTimes: number[] = [];
  #lastQuality: QualityLevel['name'] = 'full';
  /** The view-projection each pane last rendered with, so a pick reuses it exactly (§7.2.3). */
  readonly #lastViewProj = new Map<ViewId, mat4>();
  readonly #lastRects = new Map<ViewId, ViewportRect>();

  /** Read-only view of the scene the store owns. */
  get #scene(): Scene {
    return this.#store.scene;
  }

  /** The four things a `LayerRuntime` is allowed to reach (`layers/runtime.ts`). */
  get #layerContext(): LayerRuntimeContext {
    return {
      gpu: this.#gpu,
      client: (id: DatasetId) => this.#workers.get(id)?.client,
      requestRender: () => this.requestRender(),
      track: <T>(p: Promise<T>) => this.#track(p),
      cuts: this.#cuts,
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
    this.#cuts.releaseDataset(id);
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

  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void {
    this.#store.setView(id, patch);
    this.requestRender();
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
    const hit = this.#renderer.pick(view, rect, viewProj, this.#drawInput(), localX, localY);
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
    return { world, rows: this.#runtimesInOrder().map((rt) => rt.probeRow(world)) };
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

  /** §7.2: sets a dirty bit; **never** renders synchronously. */
  requestRender(_viewId?: ViewId): void {
    this.#dirty = true;
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
    this.#dirty = false;
    const t0 = performance.now();
    this.#timer.begin();

    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    const bg = this.#scene.background;
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const rects = this.#currentViewports();
    const input = this.#drawInput();
    this.#lastRects.clear();
    for (const rect of rects) {
      const view = this.#store.view(rect.viewId);
      if (view === undefined) continue;
      this.#lastRects.set(rect.viewId, rect);
      const viewProj = this.#renderer.renderView(view, rect, input);
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
    if (this.#frameTimes.length > 30) this.#frameTimes.shift();
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
      if (this.#interacting) {
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

  /** Render right now, outside the pump — the one synchronous path, for pixel readback (§11). */
  renderNow(): void {
    this.#dirty = true;
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
    if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
    this.#cuts.dispose();
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

export { camera3dMatrices, sliceBasis };
