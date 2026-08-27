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
  QualityLevel,
  Scene,
  SliceView,
  View,
  View3D,
  ViewId,
  ViewSpec,
  vec3,
} from './scene/types';
import type { Capabilities } from './gl/caps';
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
}

export interface ProbeResult {
  world: vec3;
  mni?: vec3;
  rows: ProbeRow[];
}

export interface ScreenshotOptions {
  target: 'view' | 'grid';
  viewId?: ViewId;
  width?: number;
  height?: number;
  scale?: number;
  /** Written to the PNG `pHYs` chunk. */
  dpi?: number;
  background: 'scene' | 'white' | 'transparent';
  include: {
    colorbar: boolean;
    orientationLabels: boolean;
    crosshair: boolean;
    cornerInfo: boolean;
    scaleBar: boolean;
  };
  autoTrim: boolean;
}

export interface LoadProgress {
  datasetId: DatasetId;
  phase: LoadPhase;
  done: number;
  total: number;
}

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
  setCursorFromPick(viewId: ViewId, px: number, py: number): boolean;
  probe(world: vec3): ProbeResult;

  /** §7.5 `r`: refit a view to the scene bounds. Engine maths, not the embedder's (§8). */
  resetView(viewId: ViewId): void;
  /** §7.5 `1..6`: the A/P/L/R/S/I camera presets on the 3D view. */
  cameraPreset(viewId: ViewId, preset: CameraPreset): void;
  /** §7.5 `c` and the rest of the §4.5 `Annotations` block; `conventionBadge` stays true (§8). */
  setAnnotations(patch: Partial<Annotations>): void;
  /** §8 status bar: wasm `heapBytes` from that dataset's last `Res` (§6.5.2). */
  heapBytes(id: DatasetId): number | undefined;

  requestRender(viewId?: ViewId): void;
  /** Draw now, synchronously, instead of at the next rAF — §11's readback and the screenshot path. */
  renderNow(): void;
  /** §7.2 — every golden test awaits this. */
  whenSettled(): Promise<void>;
  screenshot(opts: ScreenshotOptions): Promise<Blob>;
  /** RGBA8, backs `expectPixel` (§11). */
  readPixel(viewId: ViewId, px: number, py: number): Uint8Array;

  serialize(): ViewSpec;
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
