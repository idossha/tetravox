/**
 * `NoGlEngine` — an app-local `Engine` (§4.7) with no WebGL and no workers.
 *
 * Why not `MockEngine` from `packages/engine`? Because that class is inside a **frozen** file
 * (§12.3 item 3) owned by the engine agent, and every member of it throws `'phase 1'`. Filling those
 * bodies in would be editing a frozen file from another package's worktree. This implements the same
 * frozen `Engine` **interface**, imported from `@tetravox/engine`, so the compiler proves the shell
 * only ever uses contract members — `engine/factory.ts` is the one seam that chooses between this and
 * the real `create()`.
 *
 * What it models faithfully, because the shell's behaviour depends on it:
 *  * a load walks the six §6.5 `Phase`s, emitting `progress` with a `datasetId` from the first phase —
 *    which is what lets a load card bind its id long before `addDataset` resolves;
 *  * `cancelDataset(id)` terminates that dataset's worker (§5 rule 6) and the pending `addDataset`
 *    rejects with `code: 'cancelled'`. `terminations` records it, so the E2E can assert the cause and
 *    not merely the symptom;
 *  * an unknown extension fails with `code: 'unsupported'` and `?mockParseFail=<substr>` fails with
 *    `code: 'parse'`, so the §8 error toasts have real paths to travel.
 *
 * It also implements the three optional `engine/commands.ts` members, which is what makes `r`, `1..6`
 * and `c` live in the shell before the real engine has a camera.
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** This class implements the
 * frozen `Engine` interface, so **every** `Engine` member added in Phase 2 must be appended here in
 * the same commit or the app stops compiling. Append the member; never change what an existing one
 * models, because the shell E2E asserts against this behaviour.
 */

import type {
  Iso3dStatus,
  Annotations,
  Camera3D,
  Capabilities,
  Dataset,
  DatasetId,
  DatasetRef,
  DatasetSource,
  Engine,
  EngineEvents,
  LabelCentroid,
  Layer,
  LayerId,
  Layout,
  NewLayer,
  PickResult,
  ProbeResult,
  ProbeRow,
  QualityLevel,
  Scene,
  ScreenshotOptions,
  SliceView,
  View,
  View3D,
  ViewId,
  ViewSpec,
  vec3,
  OverlayTheme,
} from '@tetravox/engine';
import { DEFAULT_OVERLAY_THEME, iso3dLabels } from '@tetravox/engine';
import type { CameraPreset } from '../keyboard/keymap';
import { PHASES } from '../lib/loads';
import { encodePng } from '../lib/png';
import { defaultLayer, guessKind, makeMesh, makeVolume } from './mockData';
import { applyMat4 } from '../lib/coords';

/** An `Error` carrying a protocol `ErrorCode` (§6.5), so the shell can toast it by code. */
export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export interface NoGlEngineOptions {
  /** Milliseconds per load phase. Six phases, so a load takes `6 * stepMs`. */
  stepMs?: number;
  /** Fail with `code: 'parse'` when the dataset name contains this substring. */
  parseFailSubstring?: string | null;
  /** Deterministic clock for tests. */
  now?: () => number;
  /**
   * **Phase 2, appended.** Give loaded volumes a `toTemplate` (§4.3), so the §8 coordinate bar's
   * MNI column is reachable in an E2E. Off by default, because absent is the honest default on
   * subject data — a SimNIBS `m2m` T1 is `sform_code = 2` — and both states must be testable.
   */
  toTemplate?: boolean;
}

const CANONICAL_SLICES: readonly { id: ViewId; mode: SliceView['mode']; normal: vec3; up: vec3 }[] =
  [
    // §3's preset normals: coronal is −Y and sagittal −X, so every pane agrees with the NEU badge.
    { id: 'sagittal', mode: 'sagittal', normal: [-1, 0, 0], up: [0, 0, 1] },
    { id: 'coronal', mode: 'coronal', normal: [0, -1, 0], up: [0, 0, 1] },
    { id: 'axial', mode: 'axial', normal: [0, 0, 1], up: [0, 1, 0] },
  ];

const PRESET_ROTATION: Record<CameraPreset, [number, number, number, number]> = {
  A: [0, 0, 0, 1],
  P: [0, 1, 0, 0],
  L: [0, 0.7071068, 0, 0.7071068],
  R: [0, -0.7071068, 0, 0.7071068],
  S: [-0.7071068, 0, 0, 0.7071068],
  I: [0.7071068, 0, 0, 0.7071068],
};

const FULL_QUALITY: QualityLevel = {
  name: 'full',
  dprScale: 1,
  msaa: 4,
  capDecimation: 1,
  oit: false,
};

// One `Set` per event name. The value type is erased to `unknown` deliberately: a mapped type keyed
// by the *union* `E` collapses to an intersection of every payload's callback, which no single
// listener can satisfy. The two casts below are the whole cost, and `on`/`emit` stay typed.
type Listeners = { [E in keyof EngineEvents]?: Set<(p: never) => void> };

export class NoGlEngine implements Engine {
  private readonly listeners: Listeners = {};
  private readonly stepMs: number;
  private readonly parseFailSubstring: string | null;
  private readonly clock: () => number;
  private readonly withTemplate: boolean;
  private readonly heap = new Map<DatasetId, number>();
  private readonly cancelled = new Set<DatasetId>();
  private seq = 0;
  private destroyed = false;

  /** Datasets whose worker was terminated, in order (§5 rule 6). The E2E asserts against this. */
  readonly terminations: DatasetId[] = [];

  private readonly state: Scene;

  /**
   * The last theme `setTheme` was handed (directed task 9, 2026-08-28). Readable, and read: the
   * shell's E2E asserts on it to prove the toolbar's switch reaches §4.7 and not only the CSS.
   */
  theme: OverlayTheme = DEFAULT_OVERLAY_THEME;

  constructor(options: NoGlEngineOptions = {}) {
    this.stepMs = options.stepMs ?? 60;
    this.parseFailSubstring = options.parseFailSubstring ?? null;
    this.clock = options.now ?? (() => performance.now());
    this.withTemplate = options.toTemplate === true;

    const slices: SliceView[] = CANONICAL_SLICES.map((s) => ({
      id: s.id,
      mode: s.mode,
      normal: s.normal,
      up: s.up,
      camera: { center: [0, 0], mmPerPx: 0.5 },
    }));
    const camera: Camera3D = {
      target: [0, 0, 0],
      distance: 400,
      rotation: [0, 0, 0, 1],
      fovYDeg: 35,
      orthographic: false,
      near: 1,
      far: 2000,
    };
    const view3d: View3D = { id: 'view3d', camera, showSlicePlanes: true };
    this.state = {
      version: 1,
      datasets: new Map(),
      layers: [],
      activeLayerId: null,
      slices,
      view3d,
      layout: { kind: '2x2', cells: ['sagittal', 'coronal', 'axial', 'view3d'] },
      cursor: [0, 0, 0],
      hover: null,
      radiological: false,
      background: [0.043, 0.043, 0.059, 1],
      lighting: { ambient: 0.25, headlight: true },
      annotations: {
        orientationLabels: true,
        cornerInfo: true,
        conventionBadge: true,
        scaleBar: false,
        colorbars: true,
        crosshair: true,
      },
      transparency: { mode: 'twoPhase' },
      quality: FULL_QUALITY,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------------------------

  on<E extends keyof EngineEvents>(e: E, cb: (p: EngineEvents[E]) => void): () => void {
    const set = (this.listeners[e] ??= new Set()) as unknown as Set<(p: EngineEvents[E]) => void>;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** Public on the stand-in on purpose: the E2E drives `cursor` / `hover` through it (§11 rule 0). */
  emit<E extends keyof EngineEvents>(e: E, payload: EngineEvents[E]): void {
    const set = this.listeners[e] as unknown as Set<(p: EngineEvents[E]) => void> | undefined;
    if (set === undefined) return;
    for (const cb of [...set]) cb(payload);
  }

  // ------------------------------------------------------------------------------------------
  // Read-only surface
  // ------------------------------------------------------------------------------------------

  get caps(): Capabilities {
    return {
      renderer: 'Tetravox stand-in engine (no GL)',
      vendor: 'Tetravox',
      isSoftware: true,
      floatLinear: true,
      norm16: false,
      clipDistance: true,
      maxClipDistances: 8,
      colorBufferFloat: true,
      colorBufferHalfFloat: true,
      floatBlend: true,
      drawBuffersIndexed: true,
      timerQuery: false,
      max3d: 2048,
      maxSamples: 4,
      maxDrawBuffers: 6,
      maxTextureImageUnits: 32,
      maxVaryingVectors: 31,
    };
  }

  get scene(): Readonly<Scene> {
    return this.state;
  }

  get views(): ReadonlyArray<View> {
    return [...this.state.slices, this.state.view3d];
  }

  heapBytes(id: DatasetId): number | undefined {
    return this.heap.get(id);
  }

  /**
   * §4.4's `iso3d` builds nothing without a worker, so nothing is ever pending — but the *count* is
   * still honest: it is what the layer's own `iso3d` says it owns, so a UI test can assert that the
   * switch reaches the model without a GPU (directed task 2, 2026-08-28).
   */
  iso3dStatus(layerId: LayerId): Iso3dStatus {
    const layer = this.state.layers.find((l) => l.id === layerId);
    if (layer === undefined || layer.kind !== 'volume') return { pending: 0, total: 0 };
    const spec = layer.iso3d;
    if (spec === undefined || !spec.enabled) return { pending: 0, total: 0 };
    const ds = this.state.datasets.get(layer.datasetId);
    const total =
      ds !== undefined && ds.kind === 'volume' ? Math.max(1, iso3dLabels(layer, ds).length) : 1;
    return { pending: 0, total };
  }

  // ------------------------------------------------------------------------------------------
  // Datasets
  // ------------------------------------------------------------------------------------------

  private sourceName(src: DatasetSource): { name: string; path?: string } {
    if (src.kind === 'path') {
      const slash = Math.max(src.path.lastIndexOf('/'), src.path.lastIndexOf('\\'));
      return { name: slash === -1 ? src.path : src.path.slice(slash + 1), path: src.path };
    }
    if (src.kind === 'file') return { name: src.file.name };
    return { name: src.name };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async addDataset(src: DatasetSource): Promise<Dataset> {
    const { name, path } = this.sourceName(src);
    const id: DatasetId = `ds${++this.seq}`;
    const kind = guessKind(name);

    if (kind === 'unsupported') {
      const error = new EngineError('unsupported', `${name}: not a volume or mesh Tetravox reads`);
      this.emit('error', { code: error.code, message: error.message, datasetId: id });
      throw error;
    }

    for (const [index, phase] of PHASES.entries()) {
      // Phase 'inflate' only happens for gzip input, exactly as the worker would skip it (§5 rule 4).
      if (phase === 'inflate' && !/\.gz$/i.test(name)) continue;
      this.emit('progress', { datasetId: id, phase, done: 0, total: 2 });
      await this.sleep(this.stepMs / 2);
      if (this.cancelled.has(id)) return this.rejectCancelled(id);
      this.emit('progress', { datasetId: id, phase, done: 1, total: 2 });
      await this.sleep(this.stepMs / 2);
      if (this.cancelled.has(id)) return this.rejectCancelled(id);
      this.heap.set(id, (index + 1) * 96 * 1024 * 1024);
    }

    if (this.parseFailSubstring !== null && name.includes(this.parseFailSubstring)) {
      this.heap.delete(id);
      const error = new EngineError('parse', `${name}: unexpected end of file at byte 4096`);
      this.emit('error', { code: error.code, message: error.message, datasetId: id });
      throw error;
    }

    // A mesh gets a `.msh.opt` exactly when one was admitted beside it (§7.6, §5 rule 9's sidecar
    // rule) — the same condition the real loader uses, so the "defaults from X.msh.opt" chip
    // appears here for the same reason it appears there.
    const hasOpt = src.kind === 'path' && src.sidecars?.opt !== undefined;
    const dataset =
      kind === 'volume'
        ? makeVolume(id, name, path, this.seq, this.seq, { toTemplate: this.withTemplate })
        : makeMesh(id, name, path, this.seq, this.seq, { opt: hasOpt });
    this.state.datasets.set(id, dataset);
    this.emit('progress', { datasetId: id, phase: 'upload', done: 1, total: 1 });
    this.emit('datasets', [...this.state.datasets.values()]);
    return dataset;
  }

  private rejectCancelled(id: DatasetId): never {
    this.cancelled.delete(id);
    this.heap.delete(id);
    throw new EngineError('cancelled', 'load cancelled');
  }

  removeDataset(id: DatasetId): void {
    // §5 rule 1: closing a dataset IS `worker.terminate()` — the only way wasm linear memory comes
    // back. The stand-in has no worker, so it records the call the real engine would make.
    this.terminations.push(id);
    this.heap.delete(id);
    this.state.datasets.delete(id);
    const kept = this.state.layers.filter((l) => l.datasetId !== id);
    if (kept.length !== this.state.layers.length) {
      this.state.layers = kept;
      if (
        this.state.activeLayerId !== null &&
        !kept.some((l) => l.id === this.state.activeLayerId)
      ) {
        this.state.activeLayerId = kept.length > 0 ? (kept[kept.length - 1] as Layer).id : null;
      }
      this.emit('layers', [...this.state.layers]);
    }
    this.emit('datasets', [...this.state.datasets.values()]);
  }

  cancelDataset(id: DatasetId): void {
    // §5 rule 6: an in-flight WASM call cannot be polled out of, so cancelling a load is a terminate.
    this.cancelled.add(id);
    this.terminations.push(id);
  }

  // ------------------------------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------------------------------

  addLayer(spec: NewLayer): Layer {
    const dataset = this.state.datasets.get(spec.datasetId);
    if (dataset === undefined) throw new EngineError('parse', `no such dataset: ${spec.datasetId}`);
    const id: LayerId = `ly${++this.seq}`;
    const layer = { ...defaultLayer(dataset, id), ...spec, id, datasetId: dataset.id } as Layer;
    this.state.layers = [...this.state.layers, layer];
    this.state.activeLayerId = id;
    this.emit('layers', [...this.state.layers]);
    return layer;
  }

  removeLayer(id: LayerId): void {
    this.state.layers = this.state.layers.filter((l) => l.id !== id);
    if (this.state.activeLayerId === id) {
      const last = this.state.layers[this.state.layers.length - 1];
      this.state.activeLayerId = last === undefined ? null : last.id;
    }
    this.emit('layers', [...this.state.layers]);
  }

  updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void {
    this.state.layers = this.state.layers.map((l) =>
      l.id === id ? ({ ...l, ...patch } as Layer) : l
    );
    this.emit('layers', [...this.state.layers]);
  }

  reorderLayers(order: LayerId[]): void {
    const byId = new Map(this.state.layers.map((l) => [l.id, l]));
    const next: Layer[] = [];
    for (const id of order) {
      const layer = byId.get(id);
      if (layer !== undefined) {
        next.push(layer);
        byId.delete(id);
      }
    }
    // Anything the caller forgot keeps its relative order at the top, rather than vanishing.
    this.state.layers = [...next, ...byId.values()];
    this.emit('layers', [...this.state.layers]);
  }

  setActiveLayer(id: LayerId | null): void {
    this.state.activeLayerId = id;
    this.emit('layers', [...this.state.layers]);
  }

  // ------------------------------------------------------------------------------------------
  // Views and cursor
  // ------------------------------------------------------------------------------------------

  setCursor(world: vec3): void {
    this.state.cursor = world;
    this.emit('cursor', world);
    this.requestRender();
  }

  stepCursor(viewId: ViewId, steps: number): void {
    const view = this.state.slices.find((s) => s.id === viewId);
    // §7.5: `cursor += normal · step · k`. `step_mm` is the topmost visible volume layer's spacing
    // along the normal, falling back to 1 mm when there is no volume in the scene.
    const normal = view?.normal ?? [0, 0, 1];
    const step = this.stepMm(normal);
    this.setCursor([
      this.state.cursor[0] + normal[0] * step * steps,
      this.state.cursor[1] + normal[1] * step * steps,
      this.state.cursor[2] + normal[2] * step * steps,
    ]);
  }

  /**
   * §7.5's in-plane nudge (P2-09) — the arrows, as opposed to PgUp/PgDn's {@link stepCursor}.
   *
   * The real engine derives `right` / `up` from `sliceBasis(view, radiological)` and snaps each axis
   * onto the voxel grid; this stand-in reproduces the **basis**, which is what the app's tests are
   * about (that pressing → moves the cursor along the pane's right, not along its normal), and skips
   * the snap, which needs an affine there is no dataset for here.
   */
  nudgeCursor(viewId: ViewId, dx: number, dy: number): void {
    const view = this.state.slices.find((s) => s.id === viewId);
    if (view === undefined) return;
    const n = normalize(view.normal);
    let u = normalize(reject(view.up, n));
    if (u === null) u = [0, 0, 1];
    let right = cross(u, n);
    if (this.state.radiological) right = [-right[0], -right[1], -right[2]];
    const step = this.stepMm(n);
    this.setCursor([
      this.state.cursor[0] + (right[0] * dx + u[0] * dy) * step,
      this.state.cursor[1] + (right[1] * dx + u[1] * dy) * step,
      this.state.cursor[2] + (right[2] * dx + u[2] * dy) * step,
    ]);
  }

  private stepMm(normal: vec3): number {
    for (let i = this.state.layers.length - 1; i >= 0; i--) {
      const layer = this.state.layers[i] as Layer;
      if (layer.kind !== 'volume' || !layer.visible) continue;
      const dataset = this.state.datasets.get(layer.datasetId);
      if (dataset?.kind !== 'volume') continue;
      return Math.max(
        Math.abs(normal[0]) * dataset.spacing[0],
        Math.abs(normal[1]) * dataset.spacing[1],
        Math.abs(normal[2]) * dataset.spacing[2]
      );
    }
    return 1;
  }

  setLayout(layout: Layout): void {
    this.state.layout = layout;
    this.requestRender();
  }

  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void {
    if (id === this.state.view3d.id) {
      this.state.view3d = { ...this.state.view3d, ...(patch as Partial<View3D>) };
    } else {
      this.state.slices = this.state.slices.map((s) =>
        s.id === id ? { ...s, ...(patch as Partial<SliceView>) } : s
      );
    }
    this.requestRender(id);
  }

  setRadiological(on: boolean): void {
    this.state.radiological = on;
    this.requestRender();
  }

  // §7.5 `r` / `1..6` / `c` — the optional `engine/commands.ts` members.

  resetView(viewId: ViewId): void {
    if (viewId === this.state.view3d.id) {
      this.state.view3d = {
        ...this.state.view3d,
        camera: { ...this.state.view3d.camera, distance: 400, rotation: [0, 0, 0, 1] },
      };
    } else {
      this.state.slices = this.state.slices.map((s) =>
        s.id === viewId ? { ...s, camera: { center: [0, 0], mmPerPx: 0.5 } } : s
      );
    }
    this.requestRender(viewId);
  }

  cameraPreset(viewId: ViewId, preset: CameraPreset): void {
    if (viewId !== this.state.view3d.id) return;
    this.state.view3d = {
      ...this.state.view3d,
      camera: { ...this.state.view3d.camera, rotation: PRESET_ROTATION[preset] },
    };
    this.requestRender(viewId);
  }

  setAnnotations(patch: Partial<Annotations>): void {
    this.state.annotations = { ...this.state.annotations, ...patch, conventionBadge: true };
    this.requestRender();
  }

  /**
   * §4.7's `setTheme` (directed task 9, 2026-08-28). There is no GL here and therefore no chrome to
   * colour, but the theme is **kept** rather than discarded: `theme` is what the shell's E2E reads
   * back to prove the switch reached the engine and not only the CSS, and a stand-in that threw
   * would make the theme switch crash every `?engine=mock` window.
   *
   * `background` is forwarded to the scene like the real engine does, so `serialize()` round-trips
   * a themed background the same way.
   */
  setTheme(patch: Partial<OverlayTheme>): void {
    this.theme = { ...this.theme, ...patch };
    if (patch.background !== undefined) this.state.background = patch.background;
    this.requestRender();
  }

  // ------------------------------------------------------------------------------------------
  // Picking and probing
  // ------------------------------------------------------------------------------------------

  pick(viewId: ViewId, px: number, py: number): PickResult | null {
    void viewId;
    const layer = this.state.layers[this.state.layers.length - 1];
    if (layer === undefined) return null;
    return {
      layerId: layer.id,
      datasetId: layer.datasetId,
      elementId: 1 + ((px * 7919 + py * 104_729) % 5_900_498),
      elementKind: layer.kind === 'mesh' ? 'tet' : 'slice',
      world: this.state.cursor,
      depth: 0.5,
    };
  }

  setCursorFromPick(viewId: ViewId, px: number, py: number): boolean {
    const hit = this.pick(viewId, px, py);
    if (hit === null) return false;
    this.setCursor(hit.world);
    return true;
  }

  probe(world: vec3): ProbeResult {
    const rows: ProbeRow[] = [];
    for (const layer of [...this.state.layers].reverse()) {
      const dataset = this.state.datasets.get(layer.datasetId);
      if (dataset === undefined) continue;
      if (dataset.kind === 'volume' && layer.kind === 'volume') {
        const v = applyMat4(dataset.inverseAffine, world).map(Math.round) as vec3;
        const inside = v.every((c, i) => c >= 0 && c < (dataset.dims[i] as number));
        const raw = inside ? Math.abs((v[0] * 3 + v[1] * 5 + v[2] * 7) % 997) : Number.NaN;
        const value = inside ? raw * dataset.sclSlope + dataset.sclInter : Number.NaN;
        const labelId = dataset.isLabel ? Math.round(raw) % 11 : undefined;
        rows.push({
          layerId: layer.id,
          layerName: layer.name,
          kind: layer.kind,
          voxel: v,
          value,
          ...(labelId === undefined
            ? {}
            : {
                labelId,
                labelName: dataset.labelTable?.byId.get(labelId)?.name ?? `label ${labelId}`,
              }),
        });
      } else if (dataset.kind === 'mesh') {
        const elementId = 1 + Math.abs(Math.round(world[0] * 13 + world[1] * 17 + world[2] * 19));
        const tag = dataset.tags[elementId % dataset.tags.length];
        rows.push({
          layerId: layer.id,
          layerName: layer.name,
          kind: layer.kind,
          elementId,
          tag: tag?.id ?? 0,
          tagName: tag?.name ?? '',
          fields: dataset.fields.map((f) => ({
            name: f.name,
            value:
              f.ncomp === 1
                ? f.stats.mean
                : [f.stats.mean, f.stats.mean / 2, f.stats.mean / 3].slice(0, f.ncomp),
          })),
        });
      }
    }
    return { world, rows };
  }

  /**
   * §8's region panel, on the stand-in: the same `{ id, centroid, count }` shape the real engine's
   * `labelCentroids` op returns, derived from the fake volume so a count is a number the test can
   * predict rather than a recording.
   *
   * Label `k` gets `count = k + 1` voxels and a centroid on the diagonal of the dataset's bounds, so
   * a row's count is distinguishable from its id and a double-click has somewhere to jump to.
   */
  labelCentroids(layerId: LayerId): Promise<LabelCentroid[]> {
    const layer = this.state.layers.find((l) => l.id === layerId);
    if (layer === undefined || layer.kind !== 'volume') return Promise.resolve([]);
    const dataset = this.state.datasets.get(layer.datasetId);
    if (dataset === undefined || dataset.kind !== 'volume' || !dataset.isLabel) {
      return Promise.resolve([]);
    }
    const ids = dataset.labelTable?.entries.map((e) => e.id) ?? [];
    return Promise.resolve(
      ids.map((id, k) => ({
        id,
        count: k + 1,
        centroid: applyMat4(dataset.affine, [
          ((k + 1) / (ids.length + 1)) * ((dataset.dims[0] as number) - 1),
          ((k + 1) / (ids.length + 1)) * ((dataset.dims[1] as number) - 1),
          ((k + 1) / (ids.length + 1)) * ((dataset.dims[2] as number) - 1),
        ]),
      }))
    );
  }

  // ------------------------------------------------------------------------------------------
  // Frame pump, screenshot, pixels
  // ------------------------------------------------------------------------------------------

  private lastFrameAt = 0;

  requestRender(viewId?: ViewId): void {
    if (this.destroyed) return;
    const now = this.clock();
    const cpuMs = this.lastFrameAt === 0 ? 4 : Math.min(16, Math.max(1, now - this.lastFrameAt));
    this.lastFrameAt = now;
    this.emit('frame', {
      viewId: viewId ?? this.state.layout.cells[0] ?? this.state.view3d.id,
      cpuMs,
      quality: this.state.quality.name,
    });
  }

  /** There is no drawing buffer here, so "now" and "at the next frame" are the same thing. */
  renderNow(): void {
    this.requestRender();
  }

  whenSettled(): Promise<void> {
    return Promise.resolve();
  }

  async screenshot(opts: ScreenshotOptions): Promise<Blob> {
    const width = Math.max(1, Math.round(opts.width ?? 320));
    const height = Math.max(1, Math.round(opts.height ?? 240));
    const pixels = new Uint8Array(width * height * 4);
    const bg =
      opts.background === 'white'
        ? [255, 255, 255, 255]
        : opts.background === 'transparent'
          ? [0, 0, 0, 0]
          : this.state.background.map((c) => Math.round(c * 255));
    for (let i = 0; i < width * height; i++) pixels.set(bg, i * 4);
    const png = encodePng({
      width,
      height,
      pixels,
      ...(opts.dpi === undefined ? {} : { dpi: opts.dpi }),
    });
    // A fresh ArrayBuffer, because a Blob over a view into a larger buffer is a silent truncation.
    return new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' });
  }

  readPixel(viewId: ViewId, px: number, py: number): Uint8Array {
    void viewId;
    void px;
    void py;
    return Uint8Array.from(this.state.background.map((c) => Math.round(c * 255)));
  }

  // ------------------------------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------------------------------

  /**
   * §4.6's `ViewSpec`. Two Phase-2 details the Phase-1 version left out, both of which the shell's
   * persistence path depends on and neither of which changes what an existing field means:
   *
   *  * `absPath` beside `path`, so `lib/scene.ts` can rewrite the pair into §4.6's
   *    "relative to the scene file, with an absolute fallback";
   *  * `visibleLabels` as a plain `number[]`, because a `Uint32Array` does not survive
   *    `JSON.stringify` — it serialises as `{"0":1,"1":2}` and comes back as an object. The real
   *    engine's `toViewSpec` already does this; the stand-in has to agree or the round trip differs
   *    between the two implementations for a reason that has nothing to do with the shell.
   */
  serialize(): ViewSpec {
    return {
      version: 1,
      datasets: [...this.state.datasets.values()].map((d) => ({
        id: d.id,
        kind: d.kind,
        name: d.name,
        path: d.path ?? d.name,
        ...(d.path === undefined ? {} : { absPath: d.path }),
        // §4.6 wants a real digest; it has no producer yet (W-WASM Gap 1, §5 rule 3 forbids
        // computing it here), so the stand-in emits the same placeholder the real engine does.
        fingerprint: '',
      })),
      layers: this.state.layers.map((l) => ({
        ...l,
        visibleLabels:
          'visibleLabels' in l && l.visibleLabels !== undefined ? [...l.visibleLabels] : undefined,
      })) as ViewSpec['layers'],
      activeLayerId: this.state.activeLayerId,
      slices: this.state.slices,
      view3d: this.state.view3d,
      layout: this.state.layout,
      cursor: this.state.cursor,
      radiological: this.state.radiological,
      background: this.state.background,
      lighting: this.state.lighting,
      annotations: this.state.annotations,
      transparency: this.state.transparency,
    };
  }

  /**
   * Restore the **presentation** half of a spec, and nothing more.
   *
   * This mirrors `packages/engine`'s `applyViewSpec` deliberately, including what it does *not* do:
   * `spec.layers` and `spec.activeLayerId` are not restored, because the datasets a load re-adds get
   * fresh ids and the remap is audit **P2-07**, which is E-SCENE's. The shell reconciles on top
   * (`lib/scene.ts`'s `layersToRestore`), and it must be exercised against a stand-in that behaves
   * like the engine it stands in for — a stand-in that restored layers would hide the very gap the
   * reconcile exists for.
   */
  async load(spec: ViewSpec, resolve: (r: DatasetRef) => string | null): Promise<void> {
    for (const ref of spec.datasets) {
      const path = resolve(ref);
      if (path === null) continue;
      await this.addDataset({ kind: 'path', path });
    }
    this.state.slices = spec.slices;
    this.state.view3d = spec.view3d;
    this.state.layout = spec.layout;
    this.state.cursor = spec.cursor;
    this.state.radiological = spec.radiological;
    this.state.background = spec.background;
    this.state.lighting = spec.lighting;
    this.state.annotations = spec.annotations;
    this.state.transparency = spec.transparency;
    this.emit('cursor', this.state.cursor);
    this.requestRender();
  }

  destroy(): void {
    this.destroyed = true;
    for (const id of this.state.datasets.keys()) this.terminations.push(id);
    this.state.datasets.clear();
    this.state.layers = [];
  }
}

// ------------------------------------------------------------------------------------------------
// §3's slice basis, the three lines of it `nudgeCursor` needs.
//
// Duplicated rather than imported from `@tetravox/engine`'s `view/geometry.ts`, which is not part of
// the package's public entry point (§4.7: the barrel exports the scene model, the facade and the
// capability probe, and nothing else). Three vector helpers are a smaller price than widening a
// frozen interface for a stand-in.
// ------------------------------------------------------------------------------------------------

function normalize(v: vec3): vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

/** `v` with its component along the unit vector `n` removed. */
function reject(v: vec3, n: vec3): vec3 {
  const d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]];
}

function cross(a: vec3, b: vec3): vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
