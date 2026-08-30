/**
 * The renderer half of `--job`: load the scene, run the actions, report.
 *
 * **Everything goes through the `Engine` facade and the `ShellController`** (§8: "everything the UI
 * can do must be reachable from the `Engine` API alone"). A job is a script of the same calls a user
 * makes with the mouse — `open`, `updateLayer`, `setCursor`, `setView`, `screenshot` — and there is
 * no automation-only code path into the renderer. That is the property that keeps a job honest: a
 * picture a job produces is a picture the product can produce.
 *
 * Main owns the filesystem; this file owns no `fs`, no path arithmetic and no encoders. It hands PNG
 * bytes to `bridge().jobWrite` / `jobFrames` and lets main decide where they land.
 */

import type {
  Aabb,
  Camera3D,
  Capabilities,
  Engine,
  Layer,
  LayerId,
  ScreenshotOptions,
  SliceView,
  ViewId,
  vec3,
} from '@tetravox/engine';
import type { ShellController } from '../store/controller';
import type { UiStore } from '../store/store';
import { bridge } from '../bridge';
import type { JobSpec } from '../bridge';
import { DEFAULT_FIGURE, type FigureOptions } from '../lib/figure';
import { isActive } from '../lib/loads';
import { dirName, serialiseScene } from '../lib/scene';
import { requestFromPath } from '../open/sources';
import type { OpenRequest } from '../open/sources';
import { planPreset } from './presets';
import type { PresetName } from './presets';
import {
  boundsAlongNormal,
  cursorAtOffset,
  mergeOnto,
  normalizeQuat,
  nullsToUndefined,
  orbitRotations,
  pluckShape,
  quatFromAxisAngle,
  quatMultiply,
  sweepOffsets,
  tweenFractions,
  tweenValue,
  MAX_FRAMES,
} from './frames';
import type { Ease } from './frames';

const VIEW3D = 'view3d';

interface Recorded {
  action: number;
  type: string;
  files: string[];
  ms: number;
}

type Bag = Record<string, unknown>;

/** How long a single load may take before the job gives up on it. `ernie_seeg.msh` is 492 MB. */
const LOAD_TIMEOUT_MS = 300_000;

export interface JobEnv {
  controller: ShellController;
  engine: Engine;
  store: UiStore;
  now?: () => number;
}

// ------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fullScreenshotOptions(action: Bag, fallbackView?: ViewId): ScreenshotOptions {
  const requested = (action['view'] as string | undefined) ?? fallbackView ?? 'grid';
  // `window` is not a pane: it is captured by main, and the options below are only ever the
  // fallback path's, so it collapses to the grid rather than naming a view that does not exist.
  // `figure` captures pane by pane (`runFigure`); the options here are each panel's.
  const view = requested === 'window' || requested === 'figure' ? 'grid' : requested;
  const include = (action['include'] ?? {}) as Bag;
  const options: ScreenshotOptions = {
    target: view === 'grid' ? 'grid' : 'view',
    background: (action['background'] as ScreenshotOptions['background']) ?? 'scene',
    include: {
      // The defaults are the §8 chrome a reader needs to trust the picture: the colour bar that gives
      // the overlay a scale, and the orientation letters that make left and right checkable.
      colorbar: (include['colorbar'] as boolean | undefined) ?? true,
      orientationLabels: (include['orientationLabels'] as boolean | undefined) ?? true,
      crosshair: (include['crosshair'] as boolean | undefined) ?? false,
      cornerInfo: (include['cornerInfo'] as boolean | undefined) ?? true,
      scaleBar: (include['scaleBar'] as boolean | undefined) ?? false,
      orientationCube: (include['orientationCube'] as boolean | undefined) ?? false,
    },
    autoTrim: (action['autoTrim'] as boolean | undefined) ?? false,
  };
  if (view !== 'grid') options.viewId = view;
  for (const key of ['width', 'height', 'scale', 'dpi'] as const) {
    const value = action[key];
    if (typeof value === 'number') options[key] = value;
  }
  return options;
}

async function pngBytes(engine: Engine, options: ScreenshotOptions): Promise<Uint8Array> {
  const blob = await engine.screenshot(options);
  return new Uint8Array(await blob.arrayBuffer());
}

/** `view: "window"` — the capture target is the window itself, not the engine. */
function isWindowCapture(action: Bag): boolean {
  return action['view'] === 'window';
}

/**
 * One frame of whatever the action asked to photograph.
 *
 * Everything except `view: "window"` comes off the engine's canvas, which is what keeps a job's
 * output honest: it is the picture the product renders. A window capture is the one exception, and
 * it exists for the one shot the engine cannot take — a tour of the interface — so it goes through
 * main's `capturePage` and contains exactly what a user would see.
 */
async function captureFrame(
  engine: Engine,
  action: Bag,
  options: ScreenshotOptions
): Promise<Uint8Array> {
  if (!isWindowCapture(action)) return pngBytes(engine, options);
  const width = typeof action['width'] === 'number' ? action['width'] : undefined;
  const height = typeof action['height'] === 'number' ? action['height'] : undefined;
  const bytes = await bridge().jobCapture(width, height);
  if (bytes === null)
    throw new Error('view: "window" needs the app\u2019s own window (--job only)');
  return bytes;
}

function withExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

/** Strip a trailing extension from a frame action's `out`, which names a *sequence*, not a file. */
function baseName(name: string): string {
  return name.replace(/\.(png|gif|mp4)$/i, '');
}

// ------------------------------------------------------------------------------------------------
// The runner
// ------------------------------------------------------------------------------------------------

export class JobRunner {
  private readonly warnings: string[] = [];
  private readonly errors: string[] = [];
  private readonly outputs: Recorded[] = [];
  private loadMs = 0;
  /**
   * How many frames each `out` base has already been given, so `sequence: 'continue'` numbers on
   * from there. Keyed by base name: two different bases are two different videos, and a job that
   * interleaves them (a long showcase and a short side clip) still gets two correct sequences.
   */
  private readonly sequenceLengths = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly env: JobEnv,
    private readonly spec: JobSpec
  ) {
    this.now = env.now ?? (() => performance.now());
  }

  private log(message: string): void {
    bridge().jobLog(message);
  }

  async run(): Promise<void> {
    try {
      // Which renderer actually answered, first thing and unconditionally. A `--job` run is the only
      // way to exercise the packaged app with no screen, so its log is the only place a smoke test
      // can learn whether it got the platform driver or SwiftShader (§7.1, `--software-gl`).
      // Optional-chained because the vitest env's fake engine has no `caps`, and a smoke-test log
      // line must never be the thing that fails a job.
      const caps = this.env.engine.caps as Capabilities | undefined;
      if (caps !== undefined) {
        this.log(`gl: ${caps.renderer} (${caps.isSoftware ? 'software' : 'hardware'})`);
      }
      const startedLoad = this.now();
      await this.loadScene();
      // **Nothing is framed for you.** A job's picture is the picture the app would show for the same
      // scene — the §4.5 default pan and zoom, unchanged — because that is what makes a job's output
      // checkable against the product. `resetView` is one `set { reset: true }` away when a caller
      // wants the data refitted to the pane, and it is not applied by default: on a pane that is not
      // square it fits one axis and crops the other, which turns a whole head into a cropped one.
      this.loadMs = Math.round(this.now() - startedLoad);
      await this.env.engine.whenSettled();
      for (const [index, action] of this.spec.job.actions.entries()) {
        await this.runAction(index, action as Bag);
      }
    } catch (error: unknown) {
      this.errors.push(error instanceof Error ? error.message : String(error));
    }
    await bridge().jobDone({
      ok: this.errors.length === 0,
      outputs: this.outputs,
      warnings: this.warnings,
      errors: this.errors,
      loadMs: this.loadMs,
    });
  }

  // ---- scene -----------------------------------------------------------------------------------

  private async loadScene(): Promise<void> {
    const scene = this.spec.job.scene;
    if ('path' in scene) {
      const opened = await this.env.controller.openScenePath(scene.path);
      if (!opened) {
        // The controller has already recorded *why* on the store; carrying it into the result is what
        // turns "the job failed" into something a caller can act on without a screen.
        const reason = this.env.store.getState().sceneError ?? 'unknown reason';
        throw new Error(`could not open scene ${scene.path}: ${reason}`);
      }
      await this.waitForLoads();
      return;
    }

    // The Open… path, not a shortcut around it: `requestFromPath` is what discovers §6.5.1's sidecars
    // (`ernie.msh.opt`, `*_LUT.txt`) and allow-lists them, and a job that skipped it would render the
    // head in the fallback palette with `tag 1005` where "Scalp" belongs.
    const requests: OpenRequest[] = [];
    for (const file of scene.files) {
      const request = await requestFromPath(file);
      if (request === null) this.warnings.push(`could not open ${file}`);
      else requests.push(request);
    }
    if (requests.length === 0) throw new Error('none of the scene files could be opened');
    this.env.controller.open(requests);
    await this.waitForLoads();

    const plan = planPreset((scene.preset ?? 'plain') as PresetName, {
      layers: this.env.engine.scene.layers,
      datasets: this.env.engine.scene.datasets,
    });
    this.warnings.push(...plan.warnings);
    if (plan.order.length > 0) this.env.engine.reorderLayers(plan.order);
    for (const { layerId, patch } of plan.patches) {
      this.env.engine.updateLayer(layerId, patch);
    }
    this.env.engine.requestRender();
    this.log(`preset ${scene.preset ?? 'plain'}: ${plan.patches.length} layer patches`);
  }

  /**
   * Wait for the controller's load queue to drain.
   *
   * The queue is the shell's, not the engine's — `ShellController.open` returns immediately and loads
   * run one at a time — so `whenSettled()` alone would report a settled engine holding no datasets.
   * Polling the store rather than subscribing keeps this readable and costs one array scan per 50 ms
   * of a load that takes seconds.
   */
  private async waitForLoads(): Promise<void> {
    const deadline = this.now() + LOAD_TIMEOUT_MS;
    for (;;) {
      const cards = this.env.store.getState().loads;
      if (cards.length > 0 && !cards.some(isActive)) break;
      if (cards.length === 0 && this.env.engine.scene.datasets.size > 0) break;
      if (this.now() > deadline) throw new Error('timed out waiting for the scene to load');
      await sleep(50);
    }
    for (const card of this.env.store.getState().loads) {
      if (card.state === 'failed')
        this.errors.push(`${card.name}: ${card.message ?? 'load failed'}`);
    }
    await this.env.engine.whenSettled();
  }

  // ---- actions ---------------------------------------------------------------------------------

  private async runAction(index: number, action: Bag): Promise<void> {
    const started = this.now();
    const type = String(action['type']);
    switch (type) {
      case 'set':
        this.applySet(action);
        await this.env.engine.whenSettled();
        this.record(index, type, [], started);
        return;
      case 'screenshot': {
        const name = withExtension(String(action['out']), '.png');
        const bytes =
          action['view'] === 'figure'
            ? await this.captureFigure(action, fullScreenshotOptions(action))
            : await captureFrame(this.env.engine, action, fullScreenshotOptions(action));
        const written = await bridge().jobWrite(name, bytes);
        if (!written.ok) throw new Error(`writing ${name}: ${written.error ?? 'unknown error'}`);
        this.record(index, type, [name], started);
        return;
      }
      case 'sweep':
        await this.runSweep(index, action, started);
        return;
      case 'orbit':
        await this.runOrbit(index, action, started);
        return;
      case 'tween':
        await this.runTween(index, action, started);
        return;
      case 'save-scene': {
        // The scene as File ▸ Save Scene would write it (§4.6): dataset paths relative to the file,
        // which lands under `--out` like every other output. This is how the shipped sample-data
        // scenes are produced — from the real files, through the same presets a job uses — rather
        // than typed by hand.
        const name = withExtension(String(action['out']), '.tetravox.json');
        const path = `${this.spec.outDir}/${name}`;
        this.env.engine.setSceneDir?.(dirName(path));
        const text = serialiseScene(this.env.engine.serialize(), path);
        const written = await bridge().jobWrite(name, new TextEncoder().encode(text));
        if (!written.ok) throw new Error(`writing ${name}: ${written.error ?? 'unknown error'}`);
        this.record(index, type, [name], started);
        return;
      }
      default:
        throw new Error(`actions[${index}]: unknown type ${type}`);
    }
  }

  /**
   * `view: "figure"` — every pane in `figure.panels` (default: all of them) captured separately and
   * assembled with A/B/C labels by `lib/figure.ts`, the same path the screenshot dialog's Figure
   * target takes. The `figure` bag mirrors `FigureOptions`; `dpi` is the action's.
   */
  private async captureFigure(action: Bag, options: ScreenshotOptions): Promise<Uint8Array> {
    const bag = (action['figure'] ?? {}) as Bag;
    const all = this.env.engine.views.map((v) => v.id);
    const wanted = Array.isArray(bag['panels']) ? (bag['panels'] as unknown[]).map(String) : all;
    const panels = wanted.filter((id) => all.includes(id));
    if (panels.length === 0) throw new Error('figure.panels names no pane of the current layout');
    const figure: FigureOptions = {
      ...DEFAULT_FIGURE,
      panels,
      columns: typeof bag['columns'] === 'number' ? bag['columns'] : DEFAULT_FIGURE.columns,
      gutterMm: typeof bag['gutterMm'] === 'number' ? bag['gutterMm'] : DEFAULT_FIGURE.gutterMm,
      labels: (bag['labels'] as FigureOptions['labels'] | undefined) ?? DEFAULT_FIGURE.labels,
      labelPt: typeof bag['labelPt'] === 'number' ? bag['labelPt'] : DEFAULT_FIGURE.labelPt,
      background:
        (bag['background'] as FigureOptions['background'] | undefined) ?? DEFAULT_FIGURE.background,
    };
    const blob = await this.env.controller.captureFigure(options, figure);
    return new Uint8Array(await blob.arrayBuffer());
  }

  private record(index: number, type: string, files: string[], started: number): void {
    this.outputs.push({ action: index, type, files, ms: Math.round(this.now() - started) });
  }

  /**
   * Which layer a `set` names: an index into the bottom→top list, `"active"`, a layer name, or a
   * suffix of the dataset's path — so `"T1.nii.gz"` works and so does the full path a script already
   * has in a variable.
   */
  private resolveLayer(selector: unknown): LayerId | null {
    const layers = this.env.engine.scene.layers;
    if (selector === undefined) return null;
    if (typeof selector === 'number') return layers[selector]?.id ?? null;
    if (selector === 'active') return this.env.engine.scene.activeLayerId;
    const name = String(selector);
    const byName = layers.find((l: Layer) => l.name === name);
    if (byName !== undefined) return byName.id;
    const byPath = layers.find((l: Layer) => {
      const dataset = this.env.engine.scene.datasets.get(l.datasetId);
      return dataset?.path !== undefined && dataset.path.endsWith(name);
    });
    return byPath?.id ?? null;
  }

  private applySet(action: Bag): void {
    const { engine, controller } = this.env;
    const patch = action['patch'] as Bag | undefined;
    if (patch !== undefined) {
      const layerId = this.resolveLayer(action['layer'] ?? 'active');
      if (layerId === null) {
        this.warnings.push(`set: no layer matched ${JSON.stringify(action['layer'] ?? 'active')}`);
      } else {
        engine.updateLayer(layerId, nullsToUndefined(patch) as Partial<Layer>);
      }
    }
    if (action['active'] !== undefined) {
      const activeId = this.resolveLayer(action['active']);
      if (activeId === null) {
        this.warnings.push(`set: no layer matched active ${JSON.stringify(action['active'])}`);
      } else {
        engine.setActiveLayer(activeId);
      }
    }
    const cursor = action['cursor'] as vec3 | undefined;
    if (cursor !== undefined) engine.setCursor(cursor);
    const layout = action['layout'] as Parameters<ShellController['setLayout']>[0] | undefined;
    if (layout !== undefined) controller.setLayout(layout);
    if (typeof action['radiological'] === 'boolean') {
      controller.setRadiological(action['radiological']);
    }
    const view = (action['view'] as ViewId | undefined) ?? VIEW3D;
    const camera = action['camera'];
    if (camera !== undefined) {
      // The facade's `CameraPreset` is `1..6 | A P L R S I`; JSON only has strings, so a digit comes
      // back as `'1'` and has to become the number the union names.
      const preset = /^[1-6]$/.test(String(camera)) ? Number(camera) : String(camera);
      engine.cameraPreset(view, preset as Parameters<Engine['cameraPreset']>[1]);
    }
    if (action['reset'] === true) engine.resetView(view);
    // 2D pan and zoom. Applied after `reset` so a job can refit and then step in from there, and
    // read off the live view rather than the one captured above, which `reset` may have moved.
    const mmPerPx = action['mmPerPx'];
    const center = action['center'];
    if (typeof mmPerPx === 'number' || center !== undefined) {
      const slice = engine.views.find((v) => v.id === view) as SliceView | undefined;
      if (slice === undefined || !('normal' in slice)) {
        this.warnings.push(`set: ${String(view)} is not a 2D view, so mmPerPx/center do not apply`);
      } else {
        engine.setView(view, {
          camera: {
            center: (center as [number, number] | undefined) ?? slice.camera.center,
            mmPerPx: typeof mmPerPx === 'number' ? mmPerPx : slice.camera.mmPerPx,
          },
        });
      }
    }
    const distance = action['distance'];
    if (typeof distance === 'number') {
      const view3d = engine.scene.view3d;
      engine.setView(view3d.id, { camera: { ...view3d.camera, distance } });
    }
    const annotations = action['annotations'] as Bag | undefined;
    if (annotations !== undefined) {
      engine.setAnnotations({
        ...(typeof annotations['colorbar'] === 'boolean'
          ? { colorbars: annotations['colorbar'] }
          : {}),
        ...(typeof annotations['crosshair'] === 'boolean'
          ? { crosshair: annotations['crosshair'] }
          : {}),
        ...(typeof annotations['orientationLabels'] === 'boolean'
          ? { orientationLabels: annotations['orientationLabels'] }
          : {}),
        ...(typeof annotations['cornerInfo'] === 'boolean'
          ? { cornerInfo: annotations['cornerInfo'] }
          : {}),
        ...(typeof annotations['scaleBar'] === 'boolean'
          ? { scaleBar: annotations['scaleBar'] }
          : {}),
        ...(typeof annotations['orientationCube'] === 'boolean'
          ? { orientationCube: annotations['orientationCube'] }
          : {}),
      });
    }
    engine.requestRender();
  }

  /** The scene's bounding box: the union of every loaded dataset's, in world RAS. */
  private sceneBounds(): Aabb {
    const min: vec3 = [Infinity, Infinity, Infinity];
    const max: vec3 = [-Infinity, -Infinity, -Infinity];
    for (const dataset of this.env.engine.scene.datasets.values()) {
      for (let i = 0; i < 3; i += 1) {
        min[i] = Math.min(min[i] as number, dataset.bounds.min[i] as number);
        max[i] = Math.max(max[i] as number, dataset.bounds.max[i] as number);
      }
    }
    if (!Number.isFinite(min[0])) return { min: [-100, -100, -100], max: [100, 100, 100] };
    return { min, max };
  }

  private async runSweep(index: number, action: Bag, started: number): Promise<void> {
    const { engine } = this.env;
    const viewId = String(action['view']) as ViewId;
    const view = engine.views.find((v) => v.id === viewId) as SliceView | undefined;
    if (view === undefined || !('normal' in view)) {
      throw new Error(`sweep: no 2D view ${viewId}`);
    }
    const bounds = boundsAlongNormal(this.sceneBounds(), view.normal);
    const offsets = sweepOffsets(
      {
        ...(typeof action['from'] === 'number' ? { from: action['from'] } : {}),
        ...(typeof action['to'] === 'number' ? { to: action['to'] } : {}),
        ...(typeof action['step'] === 'number' ? { step: action['step'] } : {}),
        ...(typeof action['count'] === 'number' ? { count: action['count'] } : {}),
      },
      bounds
    );
    if (offsets.length >= MAX_FRAMES) {
      this.warnings.push(`sweep ${String(action['out'])}: capped at ${MAX_FRAMES} frames`);
    }
    const options = fullScreenshotOptions(action, viewId);
    const frames: Uint8Array[] = [];
    for (const offset of offsets) {
      engine.setCursor(cursorAtOffset(engine.scene.cursor, view.normal, offset));
      engine.requestRender();
      await engine.whenSettled();
      frames.push(await pngBytes(engine, options));
    }
    this.log(`sweep ${String(action['out'])}: ${frames.length} frames`);
    await this.writeFrames(index, 'sweep', action, frames, started);
  }

  private async runOrbit(index: number, action: Bag, started: number): Promise<void> {
    const { engine } = this.env;
    const view3d = engine.scene.view3d;
    const rotations = orbitRotations(view3d.camera.rotation, {
      ...(typeof action['degrees'] === 'number' ? { degrees: action['degrees'] } : {}),
      ...(typeof action['frames'] === 'number' ? { frames: action['frames'] } : {}),
      ...(action['axis'] !== undefined ? { axis: action['axis'] as 'x' | 'y' | 'z' } : {}),
    });
    const options = fullScreenshotOptions(action, view3d.id);
    const frames: Uint8Array[] = [];
    for (const rotation of rotations) {
      const camera: Camera3D = { ...engine.scene.view3d.camera, rotation };
      engine.setView(view3d.id, { camera });
      engine.requestRender();
      await engine.whenSettled();
      frames.push(await pngBytes(engine, options));
    }
    // Put the camera back: an orbit is a capture, not a scene edit, and a `screenshot` after it must
    // photograph the scene the job set up rather than wherever the last frame stopped.
    engine.setView(view3d.id, { camera: view3d.camera });
    this.log(`orbit ${String(action['out'])}: ${frames.length} frames`);
    await this.writeFrames(index, 'orbit', action, frames, started);
  }

  /**
   * **`tween` — N eased frames between two scene states** (directed task 14).
   *
   * The two things this does that `set` cannot: it interpolates, and it does so over *any* numeric
   * field of the scene or of a layer. Everything else is the shape `sweep` and `orbit` already have
   * — set the frame's state, settle, capture — which is deliberate: the three actions must produce
   * the same kind of frame, or a video assembled out of all three would change character shot to
   * shot.
   *
   * `from` defaults to the live scene, read off the same paths `to` names (`pluckShape`). The end
   * state is **kept**: an orbit is a capture and puts its camera back, a tween is a move and does
   * not.
   */
  private async runTween(index: number, action: Bag, started: number): Promise<void> {
    const { engine } = this.env;
    const to = (action['to'] ?? {}) as Bag;
    const givenFrom = (action['from'] ?? {}) as Bag;
    const ease = (action['ease'] as Ease | undefined) ?? 'inOut';
    const fractions = tweenFractions(
      typeof action['frames'] === 'number' ? action['frames'] : 30,
      ease
    );
    if (fractions.length >= MAX_FRAMES) {
      this.warnings.push(`tween ${String(action['out'])}: capped at ${MAX_FRAMES} frames`);
    }

    // Where each interpolated quantity starts. Read once, before the first frame moves anything:
    // reading it per frame would make every step relative to the previous one, which turns an
    // ease-in-out into an exponential decay that never arrives.
    const view3d = engine.scene.view3d;
    const startCursor = engine.scene.cursor as unknown as number[];
    const fromCursor = (givenFrom['cursor'] as number[] | undefined) ?? startCursor;
    const fromDistance = (givenFrom['distance'] as number | undefined) ?? view3d.camera.distance;
    const fromTarget =
      (givenFrom['target'] as number[] | undefined) ??
      (view3d.camera.target as unknown as number[]);
    const startRotation = view3d.camera.rotation;

    const toViews = (to['views'] ?? {}) as Record<string, Bag>;
    const fromViews = (givenFrom['views'] ?? {}) as Record<string, Bag>;
    const viewStarts = new Map<string, { mmPerPx: number; center: [number, number] }>();
    for (const id of Object.keys(toViews)) {
      const slice = engine.views.find((v) => v.id === id) as SliceView | undefined;
      if (slice === undefined || !('normal' in slice)) {
        this.warnings.push(`tween: ${id} is not a 2D view, so mmPerPx/center do not apply`);
        continue;
      }
      const given = fromViews[id] ?? {};
      viewStarts.set(id, {
        mmPerPx: (given['mmPerPx'] as number | undefined) ?? slice.camera.mmPerPx,
        center: (given['center'] as [number, number] | undefined) ?? slice.camera.center,
      });
    }

    // One entry per layer the tween touches, with its resolved id and its start patch. A selector
    // that matches nothing is a warning and not a failure, exactly as `set`'s is: a shot that names
    // a layer a shorter scene does not have should still render the rest of the video.
    const toLayers = (to['layers'] as { layer?: unknown; patch: Bag }[] | undefined) ?? [];
    const fromLayers = (givenFrom['layers'] as { layer?: unknown; patch: Bag }[] | undefined) ?? [];
    const tracks: { layerId: LayerId; from: Bag; to: Bag }[] = [];
    for (const [i, entry] of toLayers.entries()) {
      const selector = entry.layer ?? 'active';
      const layerId = this.resolveLayer(selector);
      if (layerId === null) {
        this.warnings.push(`tween: no layer matched ${JSON.stringify(selector)}`);
        continue;
      }
      const explicit =
        fromLayers.find((c) => (c.layer ?? 'active') === selector)?.patch ?? fromLayers[i]?.patch;
      const live = engine.scene.layers.find((l: Layer) => l.id === layerId);
      tracks.push({
        layerId,
        from: (explicit ?? (pluckShape(live, entry.patch) as Bag)) as Bag,
        to: entry.patch,
      });
    }

    const orbit = action['orbit'] as { degrees: number; axis?: 'x' | 'y' | 'z' } | undefined;
    const options = fullScreenshotOptions(action);
    const frames: Uint8Array[] = [];
    for (const t of fractions) {
      if (to['cursor'] !== undefined) {
        engine.setCursor(tweenValue(fromCursor, to['cursor'], t) as vec3);
      }
      if (to['distance'] !== undefined || to['target'] !== undefined || orbit !== undefined) {
        const camera: Camera3D = { ...engine.scene.view3d.camera };
        if (to['distance'] !== undefined) {
          camera.distance = tweenValue(fromDistance, to['distance'], t) as number;
        }
        if (to['target'] !== undefined) {
          camera.target = tweenValue(fromTarget, to['target'], t) as vec3;
        }
        if (orbit !== undefined) {
          const radians = (orbit.degrees * t * Math.PI) / 180;
          camera.rotation = normalizeQuat(
            quatMultiply(quatFromAxisAngle(orbit.axis ?? 'z', radians), startRotation)
          );
        }
        engine.setView(view3d.id, { camera });
      }
      for (const [id, start] of viewStarts) {
        const target = toViews[id] ?? {};
        engine.setView(id as ViewId, {
          camera: {
            mmPerPx: tweenValue(start.mmPerPx, target['mmPerPx'] ?? start.mmPerPx, t) as number,
            center: tweenValue(start.center, target['center'] ?? start.center, t) as [
              number,
              number,
            ],
          },
        });
      }
      for (const track of tracks) {
        const live = engine.scene.layers.find((l: Layer) => l.id === track.layerId);
        const moved = tweenValue(track.from, track.to, t) as Record<string, unknown>;
        // Deep-merge each named field onto the layer's current value: a tween names leaves, and
        // `updateLayer` merges only the top level (see `mergeOnto`).
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(moved)) {
          patch[key] = mergeOnto(
            (live as unknown as Record<string, unknown> | undefined)?.[key],
            value
          );
        }
        engine.updateLayer(track.layerId, nullsToUndefined(patch) as Partial<Layer>);
      }
      engine.requestRender();
      await engine.whenSettled();
      frames.push(await captureFrame(engine, action, options));
    }
    this.log(`tween ${String(action['out'])}: ${frames.length} frames`);
    await this.writeFrames(index, 'tween', action, frames, started);
  }

  /**
   * Hand a shot's frames to main, and say whether this is the end of the video.
   *
   * `sequence` is what lets twenty actions write into one `out` (see `job.ts`'s `SequenceRole`).
   * `startIndex` is the whole of the mechanism on this side: main writes `<base>-<n>.png` from
   * wherever we say the sequence has got to, and encodes only when told, off the files rather than
   * off anything held in memory — which is the only version of this that scales to a 1080p video
   * measured in thousands of frames.
   */
  private async writeFrames(
    index: number,
    type: string,
    action: Bag,
    frames: Uint8Array[],
    started: number
  ): Promise<void> {
    const base = baseName(String(action['out']));
    const raw = action['format'];
    const formats = new Set<string>(['png', 'gif']);
    for (const entry of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      formats.add(String(entry));
    }
    if (action['gif'] === false) formats.delete('gif');
    const sequence = action['sequence'] as 'start' | 'continue' | 'end' | undefined;
    const startIndex =
      sequence === 'continue' || sequence === 'end' ? (this.sequenceLengths.get(base) ?? 0) : 0;
    const encode = sequence === undefined || sequence === 'end';
    const fps = typeof action['fps'] === 'number' && action['fps'] > 0 ? action['fps'] : 10;
    const result = await bridge().jobFrames({
      base,
      fps,
      startIndex,
      gif: encode && formats.has('gif'),
      mp4: encode && formats.has('mp4'),
      ...(typeof action['colors'] === 'number' ? { colors: action['colors'] } : {}),
      frames,
    });
    this.sequenceLengths.set(base, startIndex + frames.length);
    this.warnings.push(...(result.warnings ?? []));
    if (!result.ok) throw new Error(`writing ${base}: ${result.error ?? 'unknown error'}`);
    this.record(index, type, result.files ?? [], started);
  }
}

/**
 * Start the job this window was launched for, if any.
 *
 * Returns `false` on every ordinary launch, which is what the shell's effect keys off: there is no
 * job-mode branch in the UI, only an effect that asks and gets `null`.
 */
export async function maybeRunJob(env: JobEnv): Promise<boolean> {
  const spec = await bridge().jobSpec();
  if (spec === null) return false;
  // Give the whole window to the view grid before the first frame is rendered: the §8 panels are
  // 18 rem + 20 rem of chrome that no engine screenshot contains (see `UiState.jobMode`).
  // `window.panels: true` keeps the §8 shell on screen, which is what a `view: "window"` tour
  // photographs; every other job gives the whole window to the view grid.
  env.store.setState({ jobMode: spec.job.window?.panels !== true });
  await env.engine.whenSettled();
  await new JobRunner(env, spec).run();
  return true;
}
