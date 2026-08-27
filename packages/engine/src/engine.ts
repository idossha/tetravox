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
  GpuCapsT,
  LoadSource,
  MeshMeta,
  SurfacePayload,
  VolumeMeta,
} from '@tetravox/protocol';
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
import { GpuStore } from './render/gpu';
import { Renderer, surfaceKey, worldToVoxel } from './render/renderer';
import { PickPass } from './render/pick';
import { viewports } from './view/layout';
import type { ViewportRect } from './view/layout';
import { camera3dMatrices, fitCamera, presetRotation, sliceBasis, stepMm } from './view/geometry';
import { meshDatasetFromMeta, volumeDatasetFromMeta } from './scene/fromMeta';
import { defaultLayerFor, defaultScene, VIEW3D_ID } from './scene/defaults';
import type {
  Aabb,
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

/** `.nii` / `.nii.gz` is a volume; everything else goes to the mesh loader (§6.2's `sniff`). */
export function looksLikeVolume(name: string): boolean {
  return /\.nii(\.gz)?$/i.test(name);
}

function sourceName(src: DatasetSource): string {
  if (src.kind === 'path') return src.path.split(/[/\\]/).pop() ?? src.path;
  if (src.kind === 'file') return src.file.name;
  return src.name;
}

/**
 * `tetravox://file/<percent-encoded path>` (§5 directive A2).
 *
 * A `path` that is **already** a URL is passed through unchanged. Two things need that: a scene file
 * (§4.6) may legitimately reference one, and the §11 harness serves the reference dataset over
 * Vite's `/@fs/<abs path>` because `TETRAVOX_TESTDATA` lives outside the repo. Either way the worker
 * sees a `LoadSource.url` it can stream, and no byte reaches the UI thread (§5 rule 3).
 */
export function fileUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('/@fs/')) return path;
  return `tetravox://file/${encodeURIComponent(path)}`;
}

function toLoadSource(src: DatasetSource): LoadSource {
  switch (src.kind) {
    case 'path':
      return {
        kind: 'url',
        url: fileUrl(src.path),
        sidecars: {
          lut: src.sidecars?.lut !== undefined ? fileUrl(src.sidecars.lut) : undefined,
          opt: src.sidecars?.opt !== undefined ? fileUrl(src.sidecars.opt) : undefined,
        },
      };
    case 'file':
      return { kind: 'file', file: src.file, sidecars: src.sidecars };
    case 'bytes':
      return { kind: 'bytes', name: src.name, bytes: src.bytes, sidecars: src.sidecars };
  }
}

export class TetravoxEngine implements Engine {
  readonly caps: Capabilities;

  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #store: GpuStore;
  readonly #renderer: Renderer;
  readonly #pick: PickPass;
  readonly #timer: Timer;
  readonly #opts: EngineOptions;

  #scene: Scene = defaultScene();
  readonly #runtimes = new Map<DatasetId, DatasetRuntime>();
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
  /** Async `locate` results, keyed by layer, so the synchronous `probe()` has mesh rows to show. */
  readonly #locateCache = new Map<LayerId, { world: vec3; row: ProbeRow }>();

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
    this.#store = new GpuStore(gl);
    this.#renderer = new Renderer(gl, this.caps);
    this.#pick = new PickPass(gl);
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
    return this.#scene;
  }

  get views(): ReadonlyArray<View> {
    return [...this.#scene.slices, this.#scene.view3d];
  }

  #view(id: ViewId): View | undefined {
    return this.views.find((v) => v.id === id);
  }

  /** Every dataset's world AABB, for `fit()` and for the slice quad's size. */
  #sceneBounds(): Aabb {
    const min: vec3 = [Infinity, Infinity, Infinity];
    const max: vec3 = [-Infinity, -Infinity, -Infinity];
    for (const ds of this.#scene.datasets.values()) {
      for (let i = 0; i < 3; i += 1) {
        min[i] = Math.min(min[i] ?? 0, ds.bounds.min[i] ?? 0);
        max[i] = Math.max(max[i] ?? 0, ds.bounds.max[i] ?? 0);
      }
    }
    if (!Number.isFinite(min[0])) return { min: [-100, -100, -100], max: [100, 100, 100] };
    return { min, max };
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
    this.#runtimes.set(id, runtime);

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
    // §7.3's label path: a dense index remap in R8UI/R16UI plus an `N x 1 RGBA8` palette.
    //
    // The palette is indexed by the **dense** index, and `labelIds` is the remap in dense order
    // (§6.1's `LabelIndex { ids, dense_of }`), so `palette[k]` is the colour of `ids[k]` — no
    // offset. An off-by-one here paints every region with its neighbour's colour, which looks
    // plausible and is wrong.
    //
    // Background is decided by **alpha**, not by index: SimNIBS and FreeSurfer LUTs give id 0
    // ("Unknown") `A = 0`, and the shader discards a zero-alpha palette entry. Only when there is no
    // table at all does the engine impose the convention that id 0 is background.
    let palette: Uint8Array | null = null;
    if (ds.isLabel && labelIds !== undefined) {
      palette = new Uint8Array(labelIds.length * 4);
      for (let k = 0; k < labelIds.length; k += 1) {
        const labelId = labelIds[k] ?? 0;
        const entry = ds.labelTable?.byId.get(labelId);
        const c = entry?.color ?? (labelId === 0 ? ([0, 0, 0, 0] as const) : fallbackLabelColor(k));
        palette[k * 4] = Math.round(c[0] * 255);
        palette[k * 4 + 1] = Math.round(c[1] * 255);
        palette[k * 4 + 2] = Math.round(c[2] * 255);
        palette[k * 4 + 3] = Math.round(c[3] * 255);
      }
    }
    this.#store.uploadVolume(`${id}|0`, ds, gpuBytes, meta.gpu, !ds.isLabel, palette);

    this.#scene.datasets.set(id, ds);
    this.#emit('datasets', [...this.#scene.datasets.values()]);
    this.#onFirstDataset();
    return ds;
  }

  async #adoptMesh(id: DatasetId, meta: MeshMeta, path: string | undefined): Promise<MeshDataset> {
    const ds = meshDatasetFromMeta(id, meta, { id: this.#nextId }, path);
    const rt = this.#runtimes.get(id);
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
    this.#store.uploadSurface(surfaceKey(id, 'indexed'), payload);
    this.#scene.datasets.set(id, ds);
    this.#emit('datasets', [...this.#scene.datasets.values()]);
    this.#onFirstDataset();
    return ds;
  }

  /** Centre the cursor and fit the 3D camera the first time there is anything to look at. */
  #onFirstDataset(): void {
    const b = this.#sceneBounds();
    const center: vec3 = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    if (this.#scene.datasets.size === 1) {
      this.#scene.cursor = center;
      this.#scene.view3d = {
        ...this.#scene.view3d,
        camera: fitCamera(this.#scene.view3d.camera, b),
      };
      // Fit each 2D pane so the data fills it rather than sitting in a corner.
      const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const rect = this.#lastRects.get(this.#scene.slices[0]?.id ?? '') ?? null;
      const px = rect !== null ? Math.min(rect.width, rect.height) : 512;
      const mmPerPx = Math.max(0.05, (diag * 0.62) / Math.max(1, px));
      this.#scene.slices = this.#scene.slices.map((s) => ({
        ...s,
        camera: { center: [0, 0], mmPerPx },
      }));
    }
    this.requestRender();
  }

  removeDataset(id: DatasetId): void {
    this.#scene.layers = this.#scene.layers.filter((l) => l.datasetId !== id);
    this.#scene.datasets.delete(id);
    this.#store.dropVolume(id);
    this.#store.dropSurfaces(id);
    this.#teardown(id);
    this.#emit('datasets', [...this.#scene.datasets.values()]);
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  /** §5 rule 6: cancelling a load is terminating its worker. */
  cancelDataset(id: DatasetId): void {
    const rt = this.#runtimes.get(id);
    if (rt === undefined) return;
    rt.cancelled = true;
    if (rt.loadId !== null) rt.client.cancel(rt.loadId);
    else this.#teardown(id);
  }

  #teardown(id: DatasetId): void {
    const rt = this.#runtimes.get(id);
    if (rt === undefined) return;
    rt.client.terminate();
    this.#runtimes.delete(id);
  }

  /** §8's status bar: `wasm_heap_bytes()` from that dataset's last `Res` (§6.5.2). */
  heapBytes(id: DatasetId): number | undefined {
    return this.#runtimes.get(id)?.heapBytes;
  }

  // -----------------------------------------------------------------------------------------
  // Layers
  // -----------------------------------------------------------------------------------------

  addLayer(spec: NewLayer): Layer {
    const ds = this.#scene.datasets.get(spec.datasetId);
    if (ds === undefined) throw new Error(`no such dataset: ${spec.datasetId}`);
    const id: LayerId = `layer${this.#nextId++}`;
    const base = defaultLayerFor(id, ds as VolumeDataset | MeshDataset);
    const layer = { ...base, ...spec, id, datasetId: ds.id, kind: base.kind } as Layer;
    this.#scene.layers = [...this.#scene.layers, layer];
    if (this.#scene.activeLayerId === null) this.#scene.activeLayerId = id;
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
    return layer;
  }

  removeLayer(id: LayerId): void {
    this.#scene.layers = this.#scene.layers.filter((l) => l.id !== id);
    if (this.#scene.activeLayerId === id)
      this.#scene.activeLayerId = this.#scene.layers.at(-1)?.id ?? null;
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void {
    this.#scene.layers = this.#scene.layers.map((l) =>
      l.id === id ? ({ ...l, ...patch } as Layer) : l
    );
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  reorderLayers(order: LayerId[]): void {
    const byId = new Map(this.#scene.layers.map((l) => [l.id, l]));
    const next: Layer[] = [];
    for (const id of order) {
      const l = byId.get(id);
      if (l !== undefined) {
        next.push(l);
        byId.delete(id);
      }
    }
    // Anything the caller forgot keeps its relative order at the top rather than vanishing.
    this.#scene.layers = [...next, ...byId.values()];
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  setActiveLayer(id: LayerId | null): void {
    this.#scene.activeLayerId = id;
    this.#emit('layers', [...this.#scene.layers]);
    this.requestRender();
  }

  // -----------------------------------------------------------------------------------------
  // Cursor, views
  // -----------------------------------------------------------------------------------------

  setCursor(world: vec3): void {
    this.#scene.cursor = world;
    this.#emit('cursor', world);
    this.#refreshMeshProbes(world);
    this.requestRender();
  }

  /**
   * §7.5: `cursor += normal · step · k`, then **snap the along-normal component to the nearest voxel
   * plane** of the stepped layer — otherwise repeated steps drift.
   */
  stepCursor(viewId: ViewId, steps: number): void {
    const view = this.#view(viewId);
    if (view === undefined || !isSliceView(view)) return;
    const top = this.#topVolume();
    const step = stepMm(
      view.normal,
      top?.ds.affine ?? null,
      top?.ds.spacing ?? null,
      this.#sceneBounds()
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

  #topVolume(): { layer: Layer; ds: VolumeDataset } | undefined {
    for (let i = this.#scene.layers.length - 1; i >= 0; i -= 1) {
      const l = this.#scene.layers[i];
      if (l === undefined || l.kind !== 'volume' || !l.visible) continue;
      const ds = this.#scene.datasets.get(l.datasetId);
      if (ds !== undefined && ds.kind === 'volume') return { layer: l, ds };
    }
    return undefined;
  }

  setLayout(layout: { kind: Scene['layout']['kind']; cells: ViewId[] }): void {
    this.#scene.layout = layout;
    this.requestRender();
  }

  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void {
    if (id === VIEW3D_ID) {
      this.#scene.view3d = { ...this.#scene.view3d, ...(patch as Partial<View3D>) };
    } else {
      this.#scene.slices = this.#scene.slices.map((s) =>
        s.id === id ? ({ ...s, ...(patch as Partial<SliceView>) } as SliceView) : s
      );
    }
    this.requestRender();
  }

  setRadiological(on: boolean): void {
    this.#scene.radiological = on;
    this.requestRender();
  }

  /** §7.5 `r`. Not in the frozen §4.7 facade; the app duck-types it (see `engine/commands.ts`). */
  resetView(viewId: ViewId): void {
    const b = this.#sceneBounds();
    if (viewId === VIEW3D_ID) {
      this.#scene.view3d = {
        ...this.#scene.view3d,
        camera: fitCamera(this.#scene.view3d.camera, b),
      };
    } else {
      const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const rect = this.#lastRects.get(viewId);
      const px = rect !== undefined ? Math.min(rect.width, rect.height) : 512;
      const mmPerPx = Math.max(0.05, (diag * 0.62) / Math.max(1, px));
      this.#scene.slices = this.#scene.slices.map((s) =>
        s.id === viewId ? { ...s, camera: { center: [0, 0], mmPerPx } } : s
      );
    }
    this.requestRender();
  }

  /** §7.5 `1..6`. */
  cameraPreset(viewId: ViewId, preset: number | string): void {
    const table: Record<string, number> = { A: 1, P: 2, L: 3, R: 4, S: 5, I: 6 };
    const index = typeof preset === 'number' ? preset : (table[preset.toUpperCase()] ?? 1);
    if (viewId !== VIEW3D_ID) return;
    this.#scene.view3d = {
      ...this.#scene.view3d,
      camera: { ...this.#scene.view3d.camera, rotation: presetRotation(index) },
    };
    this.requestRender();
  }

  /** §7.5 `c` and the §4.5 `Annotations` block. */
  setAnnotations(patch: Partial<Annotations>): void {
    this.#scene.annotations = { ...this.#scene.annotations, ...patch, conventionBadge: true };
    this.requestRender();
  }

  // -----------------------------------------------------------------------------------------
  // Picking and probing
  // -----------------------------------------------------------------------------------------

  pick(viewId: ViewId, px: number, py: number): PickResult | null {
    const view = this.#view(viewId);
    const rect = this.#lastRects.get(viewId);
    const viewProj = this.#lastViewProj.get(viewId);
    if (view === undefined || rect === undefined || viewProj === undefined) return null;
    // §7.2.3 wants the *pick* geometry to be de-indexed; the 3D mesh path needs that variant, which
    // is requested lazily and is a no-op if it has not landed yet.
    this.#ensurePickGeometry(view);
    const dpr = this.#dpr();
    const localX = px * dpr;
    const localY = rect.height - py * dpr;
    const half = this.#quadHalfFor(view, rect);
    const hit = this.#pick.pick(
      view,
      rect,
      viewProj,
      this.#scene,
      this.#store,
      this.#renderer.pickPrograms,
      this.#renderer.quad,
      half,
      localX,
      localY
    );
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
    const rows: ProbeRow[] = [];
    for (const layer of this.#scene.layers) {
      const ds = this.#scene.datasets.get(layer.datasetId);
      if (ds === undefined) continue;
      if (layer.kind === 'volume' && ds.kind === 'volume') {
        const v = worldToVoxel(ds, world);
        const i = Math.round(v[0]);
        const j = Math.round(v[1]);
        const k = Math.round(v[2]);
        if (i < 0 || j < 0 || k < 0 || i >= ds.dims[0] || j >= ds.dims[1] || k >= ds.dims[2]) {
          rows.push({ layerId: layer.id, layerName: layer.name, kind: layer.kind });
          continue;
        }
        const idx =
          (k * ds.dims[1] + j) * ds.dims[0] +
          i +
          layer.volumeIndex * ds.dims[0] * ds.dims[1] * ds.dims[2];
        const raw = Number(ds.data[idx] ?? 0);
        const value = raw * ds.sclSlope + ds.sclInter;
        const row: ProbeRow = {
          layerId: layer.id,
          layerName: layer.name,
          kind: layer.kind,
          voxel: [i, j, k],
          value,
        };
        if (ds.isLabel) {
          row.labelId = Math.round(value);
          row.labelName = ds.labelTable?.byId.get(row.labelId)?.name;
        }
        rows.push(row);
      } else if (layer.kind === 'mesh') {
        const cached = this.#locateCache.get(layer.id);
        if (cached !== undefined && dist3(cached.world, world) < 1e-3) rows.push(cached.row);
        else rows.push({ layerId: layer.id, layerName: layer.name, kind: layer.kind });
      }
    }
    return { world, rows };
  }

  #refreshMeshProbes(world: vec3): void {
    for (const layer of this.#scene.layers) {
      if (layer.kind !== 'mesh') continue;
      const ds = this.#scene.datasets.get(layer.datasetId);
      const rt = this.#runtimes.get(layer.datasetId);
      if (ds === undefined || ds.kind !== 'mesh' || rt === undefined || ds.nTets === 0) continue;
      // Latest-wins on the key: a drag issues one `locate` per frame and only the last survives.
      void rt.client
        .call(`locate:${layer.id}`, 'locate', { handle: ds.handle, world })
        .then((res) => {
          if (res.hit === null) {
            this.#locateCache.delete(layer.id);
            return;
          }
          const tag = ds.tags.find((t) => t.id === res.hit?.tag);
          this.#locateCache.set(layer.id, {
            world,
            row: {
              layerId: layer.id,
              layerName: layer.name,
              kind: 'mesh',
              elementId: res.hit.elementId,
              tag: res.hit.tag,
              tagName: tag?.name,
              fields: [
                ...Object.entries(res.hit.nodeValues).map(([name, v]) => ({
                  name,
                  value: v.length === 1 ? (v[0] ?? 0) : v,
                })),
                ...Object.entries(res.hit.elmValues).map(([name, v]) => ({
                  name,
                  value: v.length === 1 ? (v[0] ?? 0) : v,
                })),
              ],
            },
          });
        })
        .catch(() => {
          // A superseded or cancelled locate is normal under latest-wins; it is not an error.
        });
    }
  }

  #ensurePickGeometry(view: View): void {
    if (isSliceView(view)) return;
    for (const layer of this.#scene.layers) {
      if (layer.kind !== 'mesh' || !layer.pickable || !layer.visible) continue;
      if (this.#store.surface(surfaceKey(layer.datasetId, 'deindexed')) !== undefined) continue;
      const ds = this.#scene.datasets.get(layer.datasetId);
      const rt = this.#runtimes.get(layer.datasetId);
      if (ds === undefined || ds.kind !== 'mesh' || rt === undefined) continue;
      const op = ds.hasTris ? 'surface' : 'boundary';
      void this.#track(
        rt.client.call(`pickgeom:${layer.datasetId}`, op, {
          handle: ds.handle,
          variant: 'deindexed',
        })
      )
        .then((payload) => {
          this.#store.uploadSurface(surfaceKey(layer.datasetId, 'deindexed'), payload);
          this.requestRender();
        })
        .catch(() => {
          /* a cancelled or superseded build is not an error */
        });
    }
  }

  // -----------------------------------------------------------------------------------------
  // Frame pump
  // -----------------------------------------------------------------------------------------

  #dpr(): number {
    return this.#opts.dpr ?? globalThis.devicePixelRatio ?? 1;
  }

  #currentViewports(): ViewportRect[] {
    return viewports(this.#scene.layout, this.#canvas.width, this.#canvas.height);
  }

  #quadHalfFor(view: View, rect: ViewportRect): number {
    if (!isSliceView(view)) return 1;
    const paneHalf = 0.5 * Math.hypot(rect.width, rect.height) * view.camera.mmPerPx;
    const b = this.#sceneBounds();
    const sceneHalf =
      0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    return Math.max(paneHalf, sceneHalf) * 1.05;
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

  #resizeCanvas(): void {
    const dpr = this.#dpr();
    const cssW = this.#canvas.clientWidth || this.#canvas.width || 1;
    const cssH = this.#canvas.clientHeight || this.#canvas.height || 1;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.#canvas.width !== w || this.#canvas.height !== h) {
      this.#canvas.width = w;
      this.#canvas.height = h;
    }
  }

  #renderFrame(): void {
    if (this.#destroyed) return;
    this.#dirty = false;
    this.#resizeCanvas();
    const t0 = performance.now();
    this.#timer.begin();

    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    const bg = this.#scene.background;
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const rects = this.#currentViewports();
    this.#lastRects.clear();
    for (const rect of rects) {
      const view = this.#view(rect.viewId);
      if (view === undefined) continue;
      this.#lastRects.set(rect.viewId, rect);
      const viewProj = this.#renderer.renderView(view, rect, {
        scene: this.#scene,
        store: this.#store,
        canvasWidth: this.#canvas.width,
        canvasHeight: this.#canvas.height,
        activeViewId: null,
        uiScale: Math.max(1, Math.round(this.#dpr())),
        showChrome: true,
      });
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
    this.renderNow();
    const gl = this.#gl;
    const w = this.#canvas.width;
    const h = this.#canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Read back rather than `canvas.toBlob`: the drawing buffer may be composited (and cleared)
    // between the render and an async encode, and this path is also what a `target:'view'` crop
    // will use in Phase 2.
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (ctx === null) throw new Error('2d context unavailable for screenshot encoding');
    const img = ctx.createImageData(w, h);
    // GL rows run bottom-up; ImageData runs top-down.
    for (let y = 0; y < h; y += 1) {
      const src = (h - 1 - y) * w * 4;
      img.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    if (opts.background === 'white') {
      for (let i = 0; i < img.data.length; i += 4) {
        const a = (img.data[i + 3] ?? 255) / 255;
        for (let k = 0; k < 3; k += 1) {
          img.data[i + k] = Math.round((img.data[i + k] ?? 0) * a + 255 * (1 - a));
        }
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      c.toBlob(
        (b) => (b !== null ? resolve(b) : reject(new Error('toBlob returned null'))),
        'image/png'
      );
    });
  }

  // -----------------------------------------------------------------------------------------
  // Serialisation — §4.6. Phase 2 owns the relocate dialog; the shape is here from Phase 1.
  // -----------------------------------------------------------------------------------------

  serialize(): ViewSpec {
    const datasets: DatasetRef[] = [...this.#scene.datasets.values()].map((ds) => ({
      id: ds.id,
      kind: ds.kind === 'volume' ? 'volume' : 'mesh',
      name: ds.name,
      path: ds.path ?? '',
      absPath: ds.path,
      // §4.6's fingerprint needs the file bytes, which the UI thread does not keep; Phase 2 computes
      // it in the worker at load time and carries it on the meta.
      fingerprint: '',
    }));
    return {
      version: 1,
      datasets,
      layers: this.#scene.layers.map((l) => ({
        ...l,
        visibleLabels:
          'visibleLabels' in l && l.visibleLabels !== undefined ? [...l.visibleLabels] : undefined,
      })) as ViewSpec['layers'],
      activeLayerId: this.#scene.activeLayerId,
      slices: this.#scene.slices,
      view3d: this.#scene.view3d,
      layout: this.#scene.layout,
      cursor: this.#scene.cursor,
      radiological: this.#scene.radiological,
      background: this.#scene.background,
      lighting: this.#scene.lighting,
      annotations: this.#scene.annotations,
      transparency: this.#scene.transparency,
    };
  }

  async load(spec: ViewSpec, resolve: (r: DatasetRef) => string | null): Promise<void> {
    for (const ref of spec.datasets) {
      const path = resolve(ref);
      if (path === null) continue;
      await this.addDataset({ kind: 'path', path });
    }
    this.#scene.slices = spec.slices;
    this.#scene.view3d = spec.view3d;
    this.#scene.layout = spec.layout;
    this.#scene.cursor = spec.cursor;
    this.#scene.radiological = spec.radiological;
    this.#scene.background = spec.background;
    this.#scene.lighting = spec.lighting;
    this.#scene.annotations = spec.annotations;
    this.#scene.transparency = spec.transparency;
    this.requestRender();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#raf !== 0 && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.#raf);
    }
    if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
    for (const id of [...this.#runtimes.keys()]) this.#teardown(id);
    this.#pick.dispose();
    this.#renderer.dispose();
    this.#store.dispose();
    this.#timer.dispose();
    this.#listeners.clear();
  }
}

function isSliceView(v: View): v is SliceView {
  return (v as SliceView).mode !== undefined;
}

function dist3(a: vec3, b: vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Deterministic fallback colour for a label the LUT does not name (§7.6's glasbey-like palette). */
function fallbackLabelColor(i: number): [number, number, number, number] {
  // Golden-ratio hue rotation: maximally separated hues for any prefix length, no table, no RNG.
  const h = (i * 0.618033988749895) % 1;
  const s = 0.55 + (i % 3) * 0.15;
  const v = 0.75 + (i % 2) * 0.2;
  const k = (n: number): number => (n + h * 6) % 6;
  const f = (n: number): number => v - v * s * Math.max(0, Math.min(Math.min(k(n), 4 - k(n)), 1));
  return [f(5), f(3), f(1), 1];
}

export { camera3dMatrices, sliceBasis };
