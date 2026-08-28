/**
 * The **job file** — the automation surface's only input format (`docs/AUTOMATION.md`,
 * `docs/PLAN-2026-08-28-directed.md` task 4).
 *
 * Everything in this file is pure: argv in, a parsed invocation out; JSON in, a validated `Job` or a
 * list of reasons out. The Electron side (`job-runner.ts`) does the IO and the window; the renderer
 * side (`renderer/src/automation/`) does the engine calls. Splitting it this way is what makes the
 * schema testable under vitest with no Electron and no GPU, which is the unit test the plan's gate
 * asks for.
 *
 * **Why a hand-written validator rather than a JSON-schema library.** §12.3 freezes the dependency
 * list, and `ajv` would be a coordinated change for one file. The trade is paid back: the errors are
 * written for the person who typed the job (`actions[2].step: must be a non-zero number`) rather than
 * for a schema author, and the Python client can reproduce the same messages with no shared runtime.
 * {@link JOB_SCHEMA_VERSION} is bumped when a required field appears or a default changes.
 */

export const JOB_SCHEMA_VERSION = 1;

// ------------------------------------------------------------------------------------------------
// The schema, as types
// ------------------------------------------------------------------------------------------------

/** The four `preset`s the plan names. `plain` is "load the files and leave them alone". */
export type PresetName = 'plain' | 'ti-field-on-t1' | 'mesh-tissues-translucent' | 'atlas-outline';

export const PRESETS: readonly PresetName[] = [
  'plain',
  'ti-field-on-t1',
  'mesh-tissues-translucent',
  'atlas-outline',
];

/** A scene is either a saved `*.tetravox.json` (§4.6) or a list of files plus a preset. */
export type JobScene = { path: string } | { files: string[]; preset: PresetName };

export type ViewName = 'axial' | 'coronal' | 'sagittal' | 'view3d';
export const VIEWS: readonly ViewName[] = ['axial', 'coronal', 'sagittal', 'view3d'];

export type LayoutName = '1x1' | '1x3' | '1x3-horizontal' | '2x2' | '3d-only';
export const LAYOUTS: readonly LayoutName[] = ['1x1', '1x3', '1x3-horizontal', '2x2', '3d-only'];

/** §4.7's `CameraPreset`, as it is spelled in JSON. */
export const CAMERA_PRESETS = ['1', '2', '3', '4', '5', '6', 'A', 'P', 'L', 'R', 'S', 'I'] as const;
export type CameraPresetName = (typeof CAMERA_PRESETS)[number];

export type FrameFormat = 'png' | 'gif' | 'mp4';
export const FRAME_FORMATS: readonly FrameFormat[] = ['png', 'gif', 'mp4'];

export type BackgroundName = 'scene' | 'white' | 'transparent';
export const BACKGROUNDS: readonly BackgroundName[] = ['scene', 'white', 'transparent'];

/**
 * Which layer a `set` action patches.
 *
 * A number is an index into the scene's bottom→top layer list; a string matches a layer **name**
 * (which is the dataset's file name, so `"T1.nii.gz"` is the obvious thing to type) and then, failing
 * that, a dataset path suffix. `"active"` is the active layer. Absent means the whole action is about
 * the scene rather than a layer.
 */
export type LayerSelector = number | string;

export interface IncludeSpec {
  colorbar?: boolean;
  orientationLabels?: boolean;
  crosshair?: boolean;
  cornerInfo?: boolean;
  scaleBar?: boolean;
}

export interface SetAction {
  type: 'set';
  layer?: LayerSelector;
  /** A `Partial<Layer>` (§4.4), passed to `Engine.updateLayer` untouched. */
  patch?: Record<string, unknown>;
  cursor?: [number, number, number];
  layout?: LayoutName;
  /** A 3D camera preset (§7.5's `1..6` / `A P L R S I`). */
  camera?: CameraPresetName;
  /** Which view `camera` / `reset` / `mmPerPx` / `center` apply to. Defaults to the 3D view. */
  view?: ViewName;
  /**
   * 2D zoom for `view`, in millimetres per pixel. Smaller is closer; the scene default is 0.5, which
   * covers 350 mm on a 700 px pane. This is the control a figure needs and `reset` is not: `reset`
   * fits the scene bounds to one axis of the pane and crops the other.
   */
  mmPerPx?: number;
  /** 2D pan for `view`, in millimetres from the scene bounds' centre (§4.5). */
  center?: [number, number];
  /**
   * 3D camera distance from its target, in millimetres. The scene default is 400, which at the
   * default 35° vertical field of view frames roughly 250 mm — a head with room around it. Smaller
   * fills the frame.
   */
  distance?: number;
  radiological?: boolean;
  /** Refit the named view to the scene bounds (§4.7 `resetView`). */
  reset?: boolean;
  annotations?: IncludeSpec;
}

export interface ScreenshotAction {
  type: 'screenshot';
  /** File name, relative to `--out`. `.png` is appended when missing. */
  out: string;
  /** A view id captures that pane; `'grid'` captures the whole view grid. Default: `'grid'`. */
  view?: ViewName | 'grid';
  width?: number;
  height?: number;
  scale?: number;
  dpi?: number;
  background?: BackgroundName;
  include?: IncludeSpec;
  autoTrim?: boolean;
}

export interface SweepAction {
  type: 'sweep';
  /** A 2D view. `view3d` is rejected: a sweep steps a slice. */
  view: Exclude<ViewName, 'view3d'>;
  /** Base name for the outputs, relative to `--out`. */
  out: string;
  /** Millimetres along the view normal, measured in world RAS. Both default to the scene bounds. */
  from?: number;
  to?: number;
  /** Millimetres per frame. Mutually exclusive with `count`. */
  step?: number;
  /** Number of frames, inclusive of both ends. Mutually exclusive with `step`. */
  count?: number;
  fps?: number;
  /** Which artefacts to write. PNG frames and a GIF are always written; see {@link frameFormats}. */
  format?: FrameFormat | FrameFormat[];
  /** GIF palette size, 2..256 (default 256). Fewer colours is a much smaller file. */
  colors?: number;
  width?: number;
  height?: number;
  background?: BackgroundName;
  include?: IncludeSpec;
}

export interface OrbitAction {
  type: 'orbit';
  /** The 3D view. Present for symmetry with `sweep`; only `view3d` is legal. */
  view?: 'view3d';
  out: string;
  /** Total rotation. Default 360. */
  degrees?: number;
  /** Frames over `degrees`. Default 36. */
  frames?: number;
  /** World axis to orbit about. Default `'z'` (superior axis in RAS). */
  axis?: 'x' | 'y' | 'z';
  fps?: number;
  format?: FrameFormat | FrameFormat[];
  /** GIF palette size, 2..256 (default 256). Fewer colours is a much smaller file. */
  colors?: number;
  width?: number;
  height?: number;
  background?: BackgroundName;
  include?: IncludeSpec;
}

export type JobAction = SetAction | ScreenshotAction | SweepAction | OrbitAction;

export interface Job {
  /** Optional; validated against {@link JOB_SCHEMA_VERSION} when present. */
  version?: number;
  scene: JobScene;
  /** The offscreen window's size. Defaults to 1400×900. */
  window?: { width: number; height: number };
  actions: JobAction[];
}

export const DEFAULT_WINDOW = { width: 1400, height: 900 } as const;

// ------------------------------------------------------------------------------------------------
// The result file
// ------------------------------------------------------------------------------------------------

export interface JobOutput {
  /** Index into `job.actions`. */
  action: number;
  type: JobAction['type'];
  /** Paths relative to `--out`, in the order they were written. */
  files: string[];
  ms: number;
}

export interface JobResult {
  ok: boolean;
  schemaVersion: number;
  job: string;
  outDir: string;
  outputs: JobOutput[];
  timings: { totalMs: number; loadMs: number; actionsMs: number };
  warnings: string[];
  errors: string[];
}

// ------------------------------------------------------------------------------------------------
// argv
// ------------------------------------------------------------------------------------------------

export interface JobInvocation {
  jobPath: string;
  outDir: string;
  quiet: boolean;
}

/**
 * `Tetravox --job job.json --out DIR [--quiet]`.
 *
 * Returns `null` when `--job` is absent, which is every normal launch — the caller then takes the
 * interactive path untouched. `--job` without `--out` is an error and not a default: writing a
 * sequence of PNGs into whatever the current directory happened to be is the kind of helpfulness
 * that loses files.
 *
 * Both `--flag value` and `--flag=value` are accepted, because a Python `subprocess` list and a
 * hand-typed shell command reach for different ones.
 */
export function parseJobArgs(
  argv: readonly string[],
  cwd: string,
  resolvePath: (base: string, p: string) => string
): { ok: true; invocation: JobInvocation } | { ok: false; error: string } | null {
  let jobPath: string | null = null;
  let outDir: string | null = null;
  let quiet = false;

  const take = (i: number, name: string): { value: string; next: number } | null => {
    const arg = argv[i] as string;
    const eq = arg.indexOf('=');
    if (arg.startsWith(`--${name}=`) && eq !== -1) return { value: arg.slice(eq + 1), next: i };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    return { value, next: i + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--job' || arg.startsWith('--job=')) {
      const taken = take(i, 'job');
      if (taken === null) return { ok: false, error: '--job needs a path' };
      jobPath = taken.value;
      i = taken.next;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const taken = take(i, 'out');
      if (taken === null) return { ok: false, error: '--out needs a directory' };
      outDir = taken.value;
      i = taken.next;
    }
  }

  if (jobPath === null) return null;
  if (outDir === null) return { ok: false, error: '--job requires --out DIR' };
  return {
    ok: true,
    invocation: {
      jobPath: resolvePath(cwd, jobPath),
      outDir: resolvePath(cwd, outDir),
      quiet,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  job?: Job;
  errors: string[];
}

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Errors {
  readonly list: string[] = [];
  push(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
  /** `undefined` passes; anything else must be a finite number. */
  number(path: string, value: unknown, opts: { positive?: boolean; nonZero?: boolean } = {}): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.push(path, 'must be a finite number');
      return;
    }
    if (opts.positive === true && value <= 0) this.push(path, 'must be greater than 0');
    if (opts.nonZero === true && value === 0) this.push(path, 'must not be 0');
  }
  boolean(path: string, value: unknown): void {
    if (value !== undefined && typeof value !== 'boolean') this.push(path, 'must be true or false');
  }
  enum<T extends string>(path: string, value: unknown, allowed: readonly T[]): void {
    if (value === undefined) return;
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.push(path, `must be one of ${allowed.join(', ')}`);
    }
  }
  include(path: string, value: unknown): void {
    if (value === undefined) return;
    if (!isBag(value)) {
      this.push(path, 'must be an object');
      return;
    }
    const keys = ['colorbar', 'orientationLabels', 'crosshair', 'cornerInfo', 'scaleBar'];
    for (const [key, v] of Object.entries(value)) {
      if (!keys.includes(key))
        this.push(`${path}.${key}`, `unknown key (expected ${keys.join(', ')})`);
      else if (typeof v !== 'boolean') this.push(`${path}.${key}`, 'must be true or false');
    }
  }
  formats(path: string, value: unknown): void {
    if (value === undefined) return;
    const list = Array.isArray(value) ? value : [value];
    for (const [i, entry] of list.entries()) {
      const at = Array.isArray(value) ? `${path}[${i}]` : path;
      this.enum(at, entry, FRAME_FORMATS);
    }
  }
  /** A non-empty output name that cannot climb out of `--out`. */
  outName(path: string, value: unknown): void {
    if (typeof value !== 'string' || value === '') {
      this.push(path, 'must be a non-empty file name');
      return;
    }
    if (value.startsWith('/') || value.includes('..') || value.includes('\0')) {
      this.push(path, 'must be a relative name inside --out (no leading /, no ..)');
    }
  }
}

function validateScene(scene: unknown, errors: Errors): void {
  if (!isBag(scene)) {
    errors.push('scene', 'must be an object with either `path` or `files` + `preset`');
    return;
  }
  const hasPath = scene['path'] !== undefined;
  const hasFiles = scene['files'] !== undefined;
  if (hasPath && hasFiles) {
    errors.push('scene', 'has both `path` and `files`; a scene is one or the other');
    return;
  }
  if (hasPath) {
    if (typeof scene['path'] !== 'string' || scene['path'] === '') {
      errors.push('scene.path', 'must be a path to a *.tetravox.json');
    }
    return;
  }
  if (!hasFiles) {
    errors.push('scene', 'needs `path` (a saved scene) or `files` (a list to load)');
    return;
  }
  const files = scene['files'];
  if (!Array.isArray(files) || files.length === 0) {
    errors.push('scene.files', 'must be a non-empty array of paths');
  } else {
    for (const [i, file] of files.entries()) {
      if (typeof file !== 'string' || file === '') {
        errors.push(`scene.files[${i}]`, 'must be a path');
      }
    }
  }
  errors.enum('scene.preset', scene['preset'], PRESETS);
}

function validateAction(action: unknown, path: string, errors: Errors): void {
  if (!isBag(action)) {
    errors.push(path, 'must be an object');
    return;
  }
  const type = action['type'];
  switch (type) {
    case 'set': {
      const layer = action['layer'];
      if (layer !== undefined && typeof layer !== 'number' && typeof layer !== 'string') {
        errors.push(`${path}.layer`, 'must be a layer index, a layer name, or "active"');
      }
      if (action['patch'] !== undefined && !isBag(action['patch'])) {
        errors.push(`${path}.patch`, 'must be an object of layer properties (§4.4)');
      }
      const cursor = action['cursor'];
      if (cursor !== undefined) {
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 3 ||
          cursor.some((v) => typeof v !== 'number' || !Number.isFinite(v))
        ) {
          errors.push(`${path}.cursor`, 'must be three finite numbers [x, y, z] in world RAS mm');
        }
      }
      errors.enum(`${path}.layout`, action['layout'], LAYOUTS);
      errors.enum(`${path}.camera`, action['camera'], CAMERA_PRESETS);
      errors.enum(`${path}.view`, action['view'], VIEWS);
      errors.number(`${path}.mmPerPx`, action['mmPerPx'], { positive: true });
      errors.number(`${path}.distance`, action['distance'], { positive: true });
      const center = action['center'];
      if (center !== undefined) {
        if (
          !Array.isArray(center) ||
          center.length !== 2 ||
          center.some((v) => typeof v !== 'number' || !Number.isFinite(v))
        ) {
          errors.push(`${path}.center`, 'must be two finite numbers [x, y] in millimetres');
        }
      }
      errors.boolean(`${path}.radiological`, action['radiological']);
      errors.boolean(`${path}.reset`, action['reset']);
      errors.include(`${path}.annotations`, action['annotations']);
      if (
        action['patch'] === undefined &&
        action['cursor'] === undefined &&
        action['layout'] === undefined &&
        action['camera'] === undefined &&
        action['mmPerPx'] === undefined &&
        action['center'] === undefined &&
        action['distance'] === undefined &&
        action['radiological'] === undefined &&
        action['reset'] === undefined &&
        action['annotations'] === undefined
      ) {
        errors.push(path, 'a `set` with nothing to set does nothing');
      }
      return;
    }
    case 'screenshot': {
      errors.outName(`${path}.out`, action['out']);
      errors.enum(`${path}.view`, action['view'], [...VIEWS, 'grid']);
      errors.number(`${path}.width`, action['width'], { positive: true });
      errors.number(`${path}.height`, action['height'], { positive: true });
      errors.number(`${path}.scale`, action['scale'], { positive: true });
      errors.number(`${path}.dpi`, action['dpi'], { positive: true });
      errors.enum(`${path}.background`, action['background'], BACKGROUNDS);
      errors.include(`${path}.include`, action['include']);
      errors.boolean(`${path}.autoTrim`, action['autoTrim']);
      return;
    }
    case 'sweep': {
      errors.outName(`${path}.out`, action['out']);
      const view = action['view'];
      if (view === 'view3d') {
        errors.push(`${path}.view`, 'a sweep steps a slice; use `orbit` for the 3D view');
      } else if (view === undefined) {
        errors.push(`${path}.view`, 'must be axial, coronal or sagittal');
      } else {
        errors.enum(`${path}.view`, view, ['axial', 'coronal', 'sagittal']);
      }
      errors.number(`${path}.from`, action['from']);
      errors.number(`${path}.to`, action['to']);
      errors.number(`${path}.step`, action['step'], { nonZero: true });
      errors.number(`${path}.count`, action['count'], { positive: true });
      if (action['step'] !== undefined && action['count'] !== undefined) {
        errors.push(path, 'has both `step` and `count`; a sweep is paced by one or the other');
      }
      errors.number(`${path}.fps`, action['fps'], { positive: true });
      errors.formats(`${path}.format`, action['format']);
      errors.number(`${path}.colors`, action['colors'], { positive: true });
      errors.number(`${path}.width`, action['width'], { positive: true });
      errors.number(`${path}.height`, action['height'], { positive: true });
      errors.enum(`${path}.background`, action['background'], BACKGROUNDS);
      errors.include(`${path}.include`, action['include']);
      return;
    }
    case 'orbit': {
      errors.outName(`${path}.out`, action['out']);
      errors.enum(`${path}.view`, action['view'], ['view3d']);
      errors.number(`${path}.degrees`, action['degrees'], { nonZero: true });
      errors.number(`${path}.frames`, action['frames'], { positive: true });
      errors.enum(`${path}.axis`, action['axis'], ['x', 'y', 'z']);
      errors.number(`${path}.fps`, action['fps'], { positive: true });
      errors.formats(`${path}.format`, action['format']);
      errors.number(`${path}.colors`, action['colors'], { positive: true });
      errors.number(`${path}.width`, action['width'], { positive: true });
      errors.number(`${path}.height`, action['height'], { positive: true });
      errors.enum(`${path}.background`, action['background'], BACKGROUNDS);
      errors.include(`${path}.include`, action['include']);
      return;
    }
    default:
      errors.push(`${path}.type`, 'must be one of set, screenshot, sweep, orbit');
  }
}

/**
 * Validate a parsed job document.
 *
 * Every problem is reported, not just the first: a job is typed by hand or generated by the Python
 * client, and a validator that stops at the first bad key turns one round of fixing into four.
 */
export function validateJob(input: unknown): ValidationResult {
  const errors = new Errors();
  if (!isBag(input)) {
    return { ok: false, errors: ['job: must be a JSON object'] };
  }
  if (input['version'] !== undefined) {
    if (typeof input['version'] !== 'number' || input['version'] !== JOB_SCHEMA_VERSION) {
      errors.push('version', `must be ${JOB_SCHEMA_VERSION}`);
    }
  }
  validateScene(input['scene'], errors);

  const window = input['window'];
  if (window !== undefined) {
    if (!isBag(window)) errors.push('window', 'must be { width, height }');
    else {
      errors.number('window.width', window['width'], { positive: true });
      errors.number('window.height', window['height'], { positive: true });
    }
  }

  const actions = input['actions'];
  if (!Array.isArray(actions) || actions.length === 0) {
    errors.push('actions', 'must be a non-empty array');
  } else {
    for (const [i, action] of actions.entries()) validateAction(action, `actions[${i}]`, errors);
  }

  if (errors.list.length > 0) return { ok: false, errors: errors.list };
  return { ok: true, job: input as unknown as Job, errors: [] };
}

/**
 * The formats a frame action writes.
 *
 * PNG frames and a GIF are **always** written (the plan: "frames → PNG sequence + GIF always, MP4 via
 * ffmpeg when on PATH"), so `format` can only ever *add* MP4. Asking for `["mp4"]` therefore still
 * leaves the PNGs and the GIF behind: a run whose ffmpeg was missing would otherwise produce nothing
 * at all, which is the one outcome an unattended job must not have.
 */
export function frameFormats(format: FrameFormat | FrameFormat[] | undefined): Set<FrameFormat> {
  const out = new Set<FrameFormat>(['png', 'gif']);
  if (format === undefined) return out;
  for (const entry of Array.isArray(format) ? format : [format]) out.add(entry);
  return out;
}

/** Every input path a job names, so main can allow-list them before the renderer asks (§5 A2). */
export function jobInputPaths(job: Job): string[] {
  return 'path' in job.scene ? [job.scene.path] : [...job.scene.files];
}
