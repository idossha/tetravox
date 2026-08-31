/**
 * The **job file** — the automation surface's only input format (`docs/AUTOMATION.md`).
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

// §13.1's data-only manifest barrel — main-safe by construction (no DOM type, no `node:` import, no
// engine), which is exactly what lets a `type: "module"` action be validated **before a window
// exists** (§13.6) and reported alongside every other problem in the document.
import { MANIFESTS } from '../modules/manifests';
import type { ArgShape, ArgType, InstalledManifest } from '../modules/manifest-types';

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

export type LayoutName = '1x1' | '1x3' | '1x3-horizontal' | '2x2' | '3d-only' | '1+3' | '3d+1';
export const LAYOUTS: readonly LayoutName[] = [
  '1x1',
  '1x3',
  '1x3-horizontal',
  '2x2',
  '3d-only',
  // The two layouts directed task 3 added, so a job can ask for the ones the toolbar actually offers.
  '1+3',
  '3d+1',
];

/** §4.7's `CameraPreset`, as it is spelled in JSON. */
export const CAMERA_PRESETS = ['1', '2', '3', '4', '5', '6', 'A', 'P', 'L', 'R', 'S', 'I'] as const;
export type CameraPresetName = (typeof CAMERA_PRESETS)[number];

export type FrameFormat = 'png' | 'gif' | 'mp4';
export const FRAME_FORMATS: readonly FrameFormat[] = ['png', 'gif', 'mp4'];

export type EaseName = 'linear' | 'in' | 'out' | 'inOut';
export const EASES: readonly EaseName[] = ['linear', 'in', 'out', 'inOut'];

/**
 * Where a frame action sits in a longer sequence (directed task 14, 2026-08-28).
 *
 * Absent — the default, and everything written before this existed — means "a sequence of one
 * action": frames are numbered from `0000` and the GIF/MP4 are encoded when the action finishes.
 * The other three let several actions write into **one** `out`, which is what a minute-long video
 * made of twenty different shots needs and what a per-action encode cannot express:
 *
 * | value | numbering | encodes |
 * |---|---|---|
 * | absent | from 0 | yes |
 * | `start` | from 0 | no |
 * | `continue` | after the frames already written under this `out` | no |
 * | `end` | ditto | yes — over the whole sequence |
 *
 * The encode reads the PNG frames back off disk (`<out>-%04d.png` is already what ffmpeg's image2
 * demuxer wants), so a 2,700-frame 1080p sequence never has to be held in memory at once.
 */
export type SequenceRole = 'start' | 'continue' | 'end';
export const SEQUENCE_ROLES: readonly SequenceRole[] = ['start', 'continue', 'end'];

export type BackgroundName = 'scene' | 'white' | 'black' | 'transparent';
export const BACKGROUNDS: readonly BackgroundName[] = ['scene', 'white', 'black', 'transparent'];

/** `figure.labels` — the panel letters, as `lib/figure.ts`'s `FigureLabelStyle` spells them. */
export type FigureLabelStyle = 'upper' | 'lower' | 'none';
export const FIGURE_LABELS: readonly FigureLabelStyle[] = ['upper', 'lower', 'none'];

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
  /** The 3D pane's orientation cube (§4.5, directed task 10, 2026-08-28). */
  orientationCube?: boolean;
}

export interface SetAction {
  type: 'set';
  layer?: LayerSelector;
  /** A `Partial<Layer>` (§4.4), passed to `Engine.updateLayer` untouched. */
  patch?: Record<string, unknown>;
  /**
   * Make a layer the **active** one — the layer the §8 panels are showing (`Engine.setActiveLayer`).
   *
   * Invisible to an engine screenshot, and the whole point of a `window.panels` job: which controls
   * a UI tour has on screen is which layer is selected, and clicking a row in the layer panel is how
   * a user says it. Same selector as `layer`.
   */
  active?: LayerSelector;
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

/**
 * `view: "figure"` — several panes captured separately and laid out on one labelled page
 * (`lib/figure.ts`, `docs/AUTOMATION.md` §2.3). Every field is optional; the defaults are
 * `DEFAULT_FIGURE`'s.
 */
export interface FigureSpec {
  /** View ids, in reading order. Default: every pane of the current layout. */
  panels?: ViewName[];
  /** Panels per row; `0` (the default) is automatic — 4 → 2×2, 3 → 2 + 1. */
  columns?: number;
  /** Gutter between panels and around the page, in millimetres at `dpi`. Default 2. */
  gutterMm?: number;
  /** Panel letters. Default `'upper'`. */
  labels?: FigureLabelStyle;
  /** Label size in points at `dpi`. Default 10. */
  labelPt?: number;
  /** The page behind the panels. Default `'white'`. */
  background?: 'white' | 'transparent';
}

export interface ScreenshotAction {
  type: 'screenshot';
  /** File name, relative to `--out`. `.png` is appended when missing. */
  out: string;
  /**
   * A view id captures that pane; `'grid'` captures the whole view grid; `'window'` captures the
   * whole window, panels and toolbar included (`window.panels: true` is what puts them there);
   * `'figure'` captures each pane of {@link ScreenshotAction.figure} separately and assembles them
   * on one labelled page. Default: `'grid'`.
   */
  view?: ViewName | 'grid' | 'window' | 'figure';
  width?: number;
  height?: number;
  scale?: number;
  dpi?: number;
  background?: BackgroundName;
  include?: IncludeSpec;
  autoTrim?: boolean;
  /** Only with `view: 'figure'`. */
  figure?: FigureSpec;
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
  /** {@link SequenceRole}. Absent = this action is a sequence of its own. */
  sequence?: SequenceRole;
  /**
   * `false` skips the GIF.
   *
   * The GIF is otherwise unconditional, and the reason is worth keeping: without ffmpeg a run would
   * produce no animation at all. The PNG frames are written either way, so that reason survives the
   * opt-out — and at 1920×1080 over hundreds of frames a GIF is neither small nor watchable, which
   * is the case this exists for.
   */
  gif?: boolean;
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
  /** {@link SequenceRole}. Absent = this action is a sequence of its own. */
  sequence?: SequenceRole;
  /** `false` skips the GIF. See {@link SweepAction.gif}. */
  gif?: boolean;
  width?: number;
  height?: number;
  background?: BackgroundName;
  include?: IncludeSpec;
}

/**
 * One end of a {@link TweenAction} — the same scene vocabulary a `set` speaks, minus everything that
 * has no halfway.
 *
 * `layout`, `camera` and `radiological` are deliberately **not** here: there is no frame that is 40 %
 * of the way from a 2×2 layout to a 1×1 one, and pretending otherwise would give a tween a jump cut
 * with a ramp in front of it. Change those with a `set` before or after.
 */
export interface TweenState {
  /** World RAS mm. Every 2D pane's slice follows it (§4.5). */
  cursor?: [number, number, number];
  /** 3D camera distance from its target, mm. */
  distance?: number;
  /** 3D camera target, world RAS mm — a dolly that also moves what the camera looks at. */
  target?: [number, number, number];
  /** Per-2D-view pan and zoom, keyed by view id. */
  views?: Record<string, { mmPerPx?: number; center?: [number, number] }>;
  /**
   * Layer patches, each in the same `Partial<Layer>` vocabulary a `set` uses (§4.4). Numbers in the
   * patch are interpolated; everything else is applied from the first frame.
   */
  layers?: { layer?: LayerSelector; patch: Record<string, unknown> }[];
}

/**
 * **`tween` — N frames of eased interpolation between two scene states** (directed task 14).
 *
 * `sweep` steps a slice and `orbit` turns a camera; a tween moves *anything a number can describe*
 * — the cursor, the camera's distance and target, a pane's zoom, and any numeric field of any layer:
 * an opacity, a clip-plane offset, a threshold, an iso level, a glyph length. That is what a
 * narrated shot needs and what neither of the other two can do, because both of them own the one
 * parameter they vary.
 *
 * `from` is optional and defaults to **the live scene**, read path by path off the same shape `to`
 * names, so a shot says where it is going and not also where it already is.
 *
 * Unlike `orbit`, a tween **leaves the scene where it ended**. A tween is a move in the story, not a
 * capture of a scene that is put back afterwards; the next action starts where this one stopped.
 */
export interface TweenAction {
  type: 'tween';
  out: string;
  /** Frames, inclusive of both ends. Default 30. `1` is a legal one-frame hold on `to`. */
  frames?: number;
  /** Default `inOut`. */
  ease?: EaseName;
  from?: TweenState;
  to?: TweenState;
  /**
   * An eased camera orbit run across the same frames, in degrees about a **world** axis — composed
   * with whatever `to.distance` / `to.target` do, so one shot can dolly in while it turns.
   */
  orbit?: { degrees: number; axis?: 'x' | 'y' | 'z' };
  /** The capture target, as `screenshot`: a view id, `'grid'` (the default), or `'window'`. */
  view?: ViewName | 'grid' | 'window';
  fps?: number;
  format?: FrameFormat | FrameFormat[];
  colors?: number;
  /** {@link SequenceRole}. Absent = this action is a sequence of its own. */
  sequence?: SequenceRole;
  /** `false` skips the GIF. See {@link SweepAction.gif}. */
  gif?: boolean;
  width?: number;
  height?: number;
  background?: BackgroundName;
  include?: IncludeSpec;
}

/**
 * Write the scene as File ▸ Save Scene would (§4.6), under `--out`. Dataset paths come out
 * relative to the file, so a job that runs beside its data produces a scene of bare file names —
 * which is how the sample-data scenes (`scripts/sample-data/scenes/make-scenes.py`) are made.
 */
export interface SaveSceneAction {
  type: 'save-scene';
  /** File name under `--out`; `.tetravox.json` is appended when missing. */
  out: string;
}

/**
 * **The module envelope — one action type, forever** (§13.6).
 *
 * ```json
 * { "type": "module", "module": "tetravox.seeg", "op": "snap", "args": { "scope": "all" } }
 * ```
 *
 * A second module must not be a second `case` here and a second branch in `automation/run.ts`: the
 * two closed switches are the whole cost of the automation surface, and a module that wanted its own
 * action type would be paying it again for every module after it. So `module` and `op` are looked up
 * in {@link MANIFESTS} and `args` is checked against the operation's own {@link ArgShape} — the
 * manifest is the schema, and the validator is written once.
 *
 * **Unknown `args` keys are rejected**, unlike a `set`'s `patch` (which is a `Partial<Layer>` the
 * engine merges and cannot enumerate). An operation declares every argument it takes, so a key it
 * did not declare is a typo, and a typo that is silently dropped is a job that appears to have run.
 */
export interface ModuleAction {
  type: 'module';
  /** A module id in `MANIFESTS`, `<vendor>.<name>`. */
  module: string;
  /** One of that module's declared `operations`. */
  op: string;
  /** Checked against the operation's `ArgShape`; absent is the same as `{}`. */
  args?: Record<string, unknown>;
}

export type JobAction =
  | SetAction
  | ScreenshotAction
  | SweepAction
  | OrbitAction
  | TweenAction
  | SaveSceneAction
  | ModuleAction;

export interface Job {
  /** Optional; validated against {@link JOB_SCHEMA_VERSION} when present. */
  version?: number;
  scene: JobScene;
  /**
   * The offscreen window's size, and whether the §8 panels are drawn in it.
   *
   * `panels` defaults to **false**: a job's window is all view grid, because a screenshot comes off
   * the engine's canvas and never contains the panels anyway. Set it to `true` when the job is
   * *about* the interface — a UI tour — and capture with `view: "window"`, which photographs the
   * whole window, chrome included, rather than the engine.
   */
  window?: { width: number; height: number; panels?: boolean };
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
  /** `type: "module"` only: which module ran, and which operation (§13.6). */
  module?: string;
  op?: string;
  /**
   * `type: "module"` only: whatever `ModuleInstance.runOperation` returned — a plain JSON object,
   * the module's own report (`{ moved, meanShiftMm }`). It is the reason a `stats` operation is
   * worth running at all: a job that could only write files could not answer a question.
   */
  result?: Record<string, unknown> | null;
}

export interface JobResult {
  ok: boolean;
  schemaVersion: number;
  job: string;
  outDir: string;
  outputs: JobOutput[];
  /**
   * The modules this job ran an operation on, with the version that ran it (§13.6) — **present only
   * when it ran one**, so a job that uses no module produces exactly the result file it produced
   * before the envelope existed.
   *
   * It is main's answer rather than the renderer's: main validated the actions against `MANIFESTS`
   * before the window was created, so it already knows every module the run depends on, and a
   * result file naming the version that produced it is what makes a figure re-derivable a year
   * later.
   */
  modules?: { id: string; version: string }[];
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

/**
 * How each {@link ArgType} is named to the person who typed the job.
 *
 * "is required (a finite number)" says what to write; "is required (number)" restates the schema at
 * someone who does not have it open.
 */
const ARG_PHRASES: Record<ArgType, string> = {
  number: 'a finite number',
  'number?': 'a finite number',
  string: 'a string',
  'string?': 'a string',
  boolean: 'true or false',
  'boolean?': 'true or false',
  'vec3?': 'three finite numbers [x, y, z] in world RAS mm',
  path: 'a path',
  'path?': 'a path',
  out: 'a file name under --out',
};

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
    const keys = [
      'colorbar',
      'orientationLabels',
      'crosshair',
      'cornerInfo',
      'scaleBar',
      'orientationCube',
    ];
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
  /**
   * A `screenshot`'s `figure` bag (`view: "figure"`).
   *
   * It was documented in `docs/AUTOMATION.md` §2.3 and dispatched by `automation/run.ts` from the
   * day the figure target landed, but `view` was checked against a list that did not contain
   * `figure` — so the one action the feature exists for was refused by the validator and the bag
   * itself was never checked at all. Both halves are here now: a `figure` beside any other `view`
   * is a mistake worth naming, because it is silently ignored rather than obeyed.
   */
  figure(path: string, value: unknown, view: unknown): void {
    if (value === undefined) return;
    if (!isBag(value)) {
      this.push(path, 'must be an object of figure options (panels, columns, gutterMm, labels)');
      return;
    }
    if (view !== 'figure') {
      this.push(path, 'only applies to `view: "figure"`, and is ignored otherwise');
    }
    const known = ['panels', 'columns', 'gutterMm', 'labels', 'labelPt', 'background'];
    for (const key of Object.keys(value)) {
      if (!known.includes(key))
        this.push(`${path}.${key}`, `unknown key (expected ${known.join(', ')})`);
    }
    const panels = value['panels'];
    if (panels !== undefined) {
      if (!Array.isArray(panels) || panels.length === 0) {
        this.push(`${path}.panels`, 'must be a non-empty array of view ids');
      } else {
        for (const [i, id] of panels.entries()) this.enum(`${path}.panels[${i}]`, id, VIEWS);
      }
    }
    this.number(`${path}.columns`, value['columns']);
    if (typeof value['columns'] === 'number' && value['columns'] < 0) {
      this.push(`${path}.columns`, 'must be 0 (automatic) or more');
    }
    this.number(`${path}.gutterMm`, value['gutterMm']);
    if (typeof value['gutterMm'] === 'number' && value['gutterMm'] < 0) {
      this.push(`${path}.gutterMm`, 'must be 0 or more');
    }
    this.enum(`${path}.labels`, value['labels'], FIGURE_LABELS);
    this.number(`${path}.labelPt`, value['labelPt'], { positive: true });
    this.enum(`${path}.background`, value['background'], ['white', 'transparent']);
  }
  /** `n` finite numbers, or nothing. */
  numbers(path: string, value: unknown, n: number, what: string): void {
    if (value === undefined) return;
    if (
      !Array.isArray(value) ||
      value.length !== n ||
      value.some((v) => typeof v !== 'number' || !Number.isFinite(v))
    ) {
      this.push(path, `must be ${what}`);
    }
  }
  /** One end of a `tween` (§`TweenState`). */
  tweenState(path: string, value: unknown): void {
    if (value === undefined) return;
    if (!isBag(value)) {
      this.push(path, 'must be an object of scene properties to interpolate');
      return;
    }
    const known = ['cursor', 'distance', 'target', 'views', 'layers'];
    for (const key of Object.keys(value)) {
      if (!known.includes(key))
        this.push(`${path}.${key}`, `unknown key (expected ${known.join(', ')})`);
    }
    this.numbers(
      `${path}.cursor`,
      value['cursor'],
      3,
      'three finite numbers [x, y, z] in world RAS mm'
    );
    this.numbers(
      `${path}.target`,
      value['target'],
      3,
      'three finite numbers [x, y, z] in world RAS mm'
    );
    this.number(`${path}.distance`, value['distance'], { positive: true });
    const views = value['views'];
    if (views !== undefined) {
      if (!isBag(views)) this.push(`${path}.views`, 'must be an object keyed by view id');
      else {
        for (const [id, entry] of Object.entries(views)) {
          this.enum(`${path}.views.${id}`, id, VIEWS);
          if (!isBag(entry)) {
            this.push(`${path}.views.${id}`, 'must be { mmPerPx, center }');
            continue;
          }
          this.number(`${path}.views.${id}.mmPerPx`, entry['mmPerPx'], { positive: true });
          this.numbers(
            `${path}.views.${id}.center`,
            entry['center'],
            2,
            'two finite numbers [x, y] in millimetres'
          );
        }
      }
    }
    const layers = value['layers'];
    if (layers !== undefined) {
      if (!Array.isArray(layers)) {
        this.push(`${path}.layers`, 'must be an array of { layer, patch }');
        return;
      }
      for (const [i, entry] of layers.entries()) {
        const at = `${path}.layers[${i}]`;
        if (!isBag(entry)) {
          this.push(at, 'must be { layer, patch }');
          continue;
        }
        const layer = entry['layer'];
        if (layer !== undefined && typeof layer !== 'number' && typeof layer !== 'string') {
          this.push(`${at}.layer`, 'must be a layer index, a layer name, or "active"');
        }
        if (!isBag(entry['patch'])) {
          this.push(`${at}.patch`, 'must be an object of layer properties (§4.4)');
        }
      }
    }
  }
  /**
   * A module operation's `args`, against the {@link ArgShape} its manifest declares (§13.6).
   *
   * Every argument is checked with the same helpers the rest of the schema uses, so a module's
   * arguments are told what a `set`'s are told, in the same words. Two rules are specific to this
   * type and both are deliberate: an **unknown key is an error** (an operation declares everything
   * it takes, so an undeclared key is a typo, and a silently dropped typo is a job that appears to
   * have run), and a **missing required argument is named with what it should have been**.
   */
  args(path: string, value: Bag, shape: ArgShape): void {
    const declared = Object.keys(shape);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) {
        this.push(
          `${path}.${key}`,
          `unknown argument (this operation takes ${declared.length === 0 ? 'none' : declared.join(', ')})`
        );
      }
    }
    for (const [key, type] of Object.entries(shape)) {
      const at = `${path}.${key}`;
      const given = value[key];
      if (given === undefined) {
        if (!type.endsWith('?')) this.push(at, `is required (${ARG_PHRASES[type]})`);
        continue;
      }
      switch (type) {
        case 'number':
        case 'number?':
          this.number(at, given);
          break;
        case 'string':
        case 'string?':
          if (typeof given !== 'string') this.push(at, 'must be a string');
          break;
        case 'boolean':
        case 'boolean?':
          this.boolean(at, given);
          break;
        case 'vec3?':
          this.numbers(at, given, 3, 'three finite numbers [x, y, z] in world RAS mm');
          break;
        case 'path':
        case 'path?':
          // The same shape a `scene.files` entry has, and admitted the same way: `jobInputPaths`
          // collects it, `${VAR}` is expanded, and main allow-lists it before the window opens.
          if (typeof given !== 'string' || given === '') {
            this.push(at, 'must be a path (absolute, relative to the job file, or ${VAR})');
          }
          break;
        case 'out':
          this.outName(at, given);
          break;
      }
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

/**
 * "May this launch run this module?" — `() => true` for everything by default (2026-08-30).
 *
 * A compiled-in module is always runnable; an **installed** one is runnable only while the user's
 * consent is on record (settled decision O4). The predicate rather than a pre-filtered manifest list
 * is what lets the error say *which* of the two problems this is: a module nobody has heard of and a
 * module sitting on disk waiting for one click are the same message otherwise, and only one of them
 * has a fix the user can act on.
 */
export type ModuleConsented = (id: string) => boolean;

function validateAction(
  action: unknown,
  path: string,
  errors: Errors,
  manifests: readonly InstalledManifest[],
  consented: ModuleConsented
): void {
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
      const active = action['active'];
      if (active !== undefined && typeof active !== 'number' && typeof active !== 'string') {
        errors.push(`${path}.active`, 'must be a layer index, a layer name, or "active"');
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
        action['active'] === undefined &&
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
      errors.enum(`${path}.view`, action['view'], [...VIEWS, 'grid', 'window', 'figure']);
      errors.figure(`${path}.figure`, action['figure'], action['view']);
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
      errors.enum(`${path}.sequence`, action['sequence'], SEQUENCE_ROLES);
      errors.boolean(`${path}.gif`, action['gif']);
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
      errors.enum(`${path}.sequence`, action['sequence'], SEQUENCE_ROLES);
      errors.boolean(`${path}.gif`, action['gif']);
      errors.number(`${path}.width`, action['width'], { positive: true });
      errors.number(`${path}.height`, action['height'], { positive: true });
      errors.enum(`${path}.background`, action['background'], BACKGROUNDS);
      errors.include(`${path}.include`, action['include']);
      return;
    }
    case 'tween': {
      errors.outName(`${path}.out`, action['out']);
      errors.number(`${path}.frames`, action['frames'], { positive: true });
      errors.enum(`${path}.ease`, action['ease'], EASES);
      errors.enum(`${path}.view`, action['view'], [...VIEWS, 'grid', 'window']);
      errors.tweenState(`${path}.from`, action['from']);
      errors.tweenState(`${path}.to`, action['to']);
      const orbit = action['orbit'];
      if (orbit !== undefined) {
        if (!isBag(orbit)) {
          errors.push(`${path}.orbit`, 'must be { degrees, axis }');
        } else {
          if (orbit['degrees'] === undefined) {
            errors.push(
              `${path}.orbit.degrees`,
              'is required — an orbit with no angle does nothing'
            );
          }
          errors.number(`${path}.orbit.degrees`, orbit['degrees'], { nonZero: true });
          errors.enum(`${path}.orbit.axis`, orbit['axis'], ['x', 'y', 'z']);
        }
      }
      if (action['to'] === undefined && orbit === undefined) {
        errors.push(path, 'a `tween` with no `to` and no `orbit` has nowhere to go');
      }
      errors.number(`${path}.fps`, action['fps'], { positive: true });
      errors.formats(`${path}.format`, action['format']);
      errors.number(`${path}.colors`, action['colors'], { positive: true });
      errors.enum(`${path}.sequence`, action['sequence'], SEQUENCE_ROLES);
      errors.boolean(`${path}.gif`, action['gif']);
      errors.number(`${path}.width`, action['width'], { positive: true });
      errors.number(`${path}.height`, action['height'], { positive: true });
      errors.enum(`${path}.background`, action['background'], BACKGROUNDS);
      errors.include(`${path}.include`, action['include']);
      return;
    }
    case 'save-scene': {
      errors.outName(`${path}.out`, action['out']);
      return;
    }
    case 'module': {
      // The envelope's own keys first: `args` is the only bag whose contents a manifest describes,
      // so a stray key at *this* level (`arguments`, `params`) has to be caught here or it would be
      // read as an argument no operation declares.
      const known = ['type', 'module', 'op', 'args'];
      for (const key of Object.keys(action)) {
        if (!known.includes(key)) {
          errors.push(`${path}.${key}`, `unknown key (expected ${known.join(', ')})`);
        }
      }
      const id = action['module'];
      const manifest = manifests.find((m) => m.id === id) ?? null;
      if (manifest === null) {
        errors.push(
          `${path}.module`,
          `must be a module this build carries: ${manifests.map((m) => m.id).join(', ')}`
        );
        return;
      }
      if (!consented(manifest.id)) {
        errors.push(
          `${path}.module`,
          `${manifest.id} is installed but not enabled — open File ▸ Extensions…, enable it, and run this job again`
        );
        return;
      }
      const operations = manifest.operations ?? [];
      const operation = operations.find((o) => o.id === action['op']);
      if (operation === undefined) {
        errors.push(
          `${path}.op`,
          operations.length === 0
            ? `${manifest.id} declares no operations`
            : `must be one of ${manifest.id}'s operations: ${operations.map((o) => o.id).join(', ')}`
        );
        return;
      }
      const args = action['args'] ?? {};
      if (!isBag(args)) {
        errors.push(
          `${path}.args`,
          `must be an object of ${manifest.id}/${operation.id} arguments`
        );
        return;
      }
      errors.args(`${path}.args`, args, operation.args);
      return;
    }
    default:
      errors.push(
        `${path}.type`,
        'must be one of set, screenshot, sweep, orbit, tween, save-scene, module'
      );
  }
}

/**
 * Validate a parsed job document.
 *
 * Every problem is reported, not just the first: a job is typed by hand or generated by the Python
 * client, and a validator that stops at the first bad key turns one round of fixing into four.
 */
export function validateJob(
  input: unknown,
  manifests: readonly InstalledManifest[] = MANIFESTS,
  consented: ModuleConsented = () => true
): ValidationResult {
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
      errors.boolean('window.panels', window['panels']);
    }
  }

  const actions = input['actions'];
  if (!Array.isArray(actions) || actions.length === 0) {
    errors.push('actions', 'must be a non-empty array');
  } else {
    for (const [i, action] of actions.entries()) {
      validateAction(action, `actions[${i}]`, errors, manifests, consented);
    }
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

/**
 * Expand `${VAR}` references in a path against `env`.
 *
 * A committed job has to name files that live outside the repository, and neither available answer
 * is good on its own: an absolute path is reproducible on exactly one machine, and a relative one
 * (`../../../../datasets/…`) encodes a guess about where the checkout sits next to the data. The
 * repository already has a name for "the SimNIBS subject to test against" — `TETRAVOX_TESTDATA`,
 * which `docs/TESTING.md` makes every real-data test read — so a job can use the same one.
 *
 * Only `${NAME}` is expanded, not bare `$NAME`: a `$` in a file name is legal and must not become a
 * variable lookup. An unset variable is an **error**, never an empty string, because expanding it
 * away would turn `${TETRAVOX_TESTDATA}/m2m_ernie/T1.nii.gz` into an absolute path at the filesystem
 * root and report "file not found" for a mistake that is really "you did not set the variable".
 */
export function expandEnv(
  path: string,
  env: Record<string, string | undefined>
): { ok: true; path: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const expanded = path.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });
  return missing.length > 0 ? { ok: false, missing } : { ok: true, path: expanded };
}

// ------------------------------------------------------------------------------------------------
// Module actions, as the runner needs to see them (§13.6)
// ------------------------------------------------------------------------------------------------

/** The operation one module action names, or null — for a document that has been validated, never null. */
function operationOf(
  action: JobAction,
  manifests: readonly InstalledManifest[]
): { manifest: InstalledManifest; args: ArgShape } | null {
  if (action.type !== 'module') return null;
  const manifest = manifests.find((m) => m.id === action.module);
  const operation = manifest?.operations?.find((o) => o.id === action.op);
  if (manifest === undefined || operation === undefined) return null;
  return { manifest, args: operation.args };
}

/**
 * The `path`-typed argument keys an action actually carries a string for, in the order its manifest
 * declares them.
 *
 * One function for both directions, which is the whole reason it exists: {@link jobInputPaths}
 * collects the values and {@link withInputPaths} puts the resolved ones back, and the two agree
 * because they walk the same list rather than each deriving one.
 */
function modulePathKeys(action: JobAction, manifests: readonly InstalledManifest[]): string[] {
  const operation = operationOf(action, manifests);
  if (operation === null) return [];
  const args = (action as ModuleAction).args ?? {};
  return Object.entries(operation.args)
    .filter(([key, type]) => (type === 'path' || type === 'path?') && typeof args[key] === 'string')
    .map(([key]) => key);
}

/**
 * Every input path a job names, so main can allow-list them before the renderer asks (§5 A2).
 *
 * A module's `path` arguments are in here for exactly the reason the scene's files are: the job file
 * naming a path *is* the user naming it, and a module reading a table it was told to read must not
 * need a second gesture that a batch run has nobody to make.
 */
export function jobInputPaths(
  job: Job,
  manifests: readonly InstalledManifest[] = MANIFESTS
): string[] {
  const paths = 'path' in job.scene ? [job.scene.path] : [...job.scene.files];
  for (const action of job.actions) {
    const args = (action as ModuleAction).args ?? {};
    for (const key of modulePathKeys(action, manifests)) paths.push(String(args[key]));
  }
  return paths;
}

/**
 * The same job with every {@link jobInputPaths} entry replaced, in that order.
 *
 * The renderer is handed **resolved** paths so a job behaves the same run from its own directory or
 * from anywhere else, and `${VAR}` has already been expanded by the time it gets there. That was
 * true of `scene` from the first version of this file; a module's `path` argument is the same kind
 * of thing, so it is resolved by the same pass rather than by a second rule the module would have
 * to know about.
 */
export function withInputPaths(
  job: Job,
  resolved: readonly string[],
  manifests: readonly InstalledManifest[] = MANIFESTS
): Job {
  let next = 0;
  const take = (fallback: string): string => resolved[next++] ?? fallback;
  const scene: JobScene =
    'path' in job.scene
      ? { path: take(job.scene.path) }
      : { files: job.scene.files.map((file) => take(file)), preset: job.scene.preset };
  const actions = job.actions.map((action) => {
    const keys = modulePathKeys(action, manifests);
    if (keys.length === 0) return action;
    const args = { ...(action as ModuleAction).args };
    for (const key of keys) args[key] = take(String(args[key]));
    return { ...(action as ModuleAction), args };
  });
  return { ...job, scene, actions };
}

/** One `out`-typed argument: a name under `--out`, and the sibling templates it may be saved with. */
export interface ModuleOutTarget {
  module: string;
  /** The relative name the action asked for, exactly as `outName` validated it. */
  name: string;
  /** Every sibling template the module's writers declare, deduplicated (§5 rule 11). */
  siblings: string[];
}

/**
 * The `out` arguments a job's module actions name.
 *
 * `job-runner.ts` resolves each one under `--out` and admits it — with the templates — to that
 * module's write list, which is how a module's own `writeText` can produce a file in a batch run
 * that has no Save sheet to open. The **union** of the module's writers' templates is admitted
 * because an `out` argument names a file and not a writer: a job saying "write the table here" has
 * no vocabulary for "…using the electrodes writer", and every template is still validated and
 * substituted by `module-io.ts` before anything is admitted.
 */
export function moduleOutTargets(
  job: Job,
  manifests: readonly InstalledManifest[] = MANIFESTS
): ModuleOutTarget[] {
  const targets: ModuleOutTarget[] = [];
  for (const action of job.actions) {
    const operation = operationOf(action, manifests);
    if (operation === null) continue;
    const args = (action as ModuleAction).args ?? {};
    const siblings = [
      ...new Set((operation.manifest.writers ?? []).flatMap((writer) => writer.siblings)),
    ];
    for (const [key, type] of Object.entries(operation.args)) {
      if (type !== 'out' || typeof args[key] !== 'string') continue;
      targets.push({ module: operation.manifest.id, name: args[key], siblings });
    }
  }
  return targets;
}

/** The modules a job runs an operation on, with their versions, in first-use order (§13.6). */
export function jobModules(
  job: Job,
  manifests: readonly InstalledManifest[] = MANIFESTS
): { id: string; version: string }[] {
  const seen = new Map<string, string>();
  for (const action of job.actions) {
    const operation = operationOf(action, manifests);
    if (operation === null) continue;
    if (!seen.has(operation.manifest.id)) {
      seen.set(operation.manifest.id, operation.manifest.version);
    }
  }
  return [...seen].map(([id, version]) => ({ id, version }));
}
