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
import { isActive } from '../lib/loads';
import { requestFromPath } from '../open/sources';
import type { OpenRequest } from '../open/sources';
import { planPreset } from './presets';
import type { PresetName } from './presets';
import {
  boundsAlongNormal,
  cursorAtOffset,
  orbitRotations,
  sweepOffsets,
  MAX_FRAMES,
} from './frames';

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
  const view = (action['view'] as string | undefined) ?? fallbackView ?? 'grid';
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
        const bytes = await pngBytes(this.env.engine, fullScreenshotOptions(action));
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
      default:
        throw new Error(`actions[${index}]: unknown type ${type}`);
    }
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
        engine.updateLayer(layerId, patch as Partial<Layer>);
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
    const fps = typeof action['fps'] === 'number' && action['fps'] > 0 ? action['fps'] : 10;
    const result = await bridge().jobFrames({
      base,
      fps,
      gif: formats.has('gif'),
      mp4: formats.has('mp4'),
      ...(typeof action['colors'] === 'number' ? { colors: action['colors'] } : {}),
      frames,
    });
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
  // 18 rem + 20 rem of chrome that no screenshot contains (see `UiState.jobMode`).
  env.store.setState({ jobMode: true });
  await env.engine.whenSettled();
  await new JobRunner(env, spec).run();
  return true;
}
