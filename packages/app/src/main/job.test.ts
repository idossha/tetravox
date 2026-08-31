/**
 * The job schema (`main/job.ts`).
 *
 * This is the automation surface's contract with everything that is not this repository — the Python
 * client, a shell script, a CI step — so the tests are written as claims about the *document*, not
 * about the implementation: what a valid job looks like, and what a caller is told about an invalid
 * one. Every rejection asserts the message, because a validator that says "invalid" and nothing else
 * is a validator the user cannot act on.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW,
  JOB_SCHEMA_VERSION,
  expandEnv,
  frameFormats,
  jobInputPaths,
  jobModules,
  moduleOutTargets,
  parseJobArgs,
  validateJob,
  withInputPaths,
} from './job';
import type { Job } from './job';
import type { ArgShape, ModuleManifest } from '../modules/manifest-types';

const resolvePath = (base: string, p: string): string => (p.startsWith('/') ? p : `${base}/${p}`);

const minimal = {
  scene: { files: ['/data/T1.nii.gz'], preset: 'plain' },
  actions: [{ type: 'screenshot', out: 'shot.png' }],
};

function errorsFor(job: unknown): string[] {
  const result = validateJob(job);
  expect(result.ok).toBe(false);
  return result.errors;
}

describe('parseJobArgs', () => {
  it('returns null when there is no --job, so an ordinary launch is untouched', () => {
    expect(parseJobArgs(['electron', '.', '/data/T1.nii.gz'], '/cwd', resolvePath)).toBeNull();
  });

  it('accepts both `--job path` and `--job=path`', () => {
    const spaced = parseJobArgs(['x', '--job', 'j.json', '--out', 'out'], '/cwd', resolvePath);
    const equals = parseJobArgs(['x', '--job=j.json', '--out=out'], '/cwd', resolvePath);
    expect(spaced).toEqual(equals);
    expect(spaced).toEqual({
      ok: true,
      invocation: { jobPath: '/cwd/j.json', outDir: '/cwd/out', quiet: false },
    });
  });

  it('keeps absolute paths absolute and resolves relative ones against the cwd', () => {
    const parsed = parseJobArgs(['x', '--job', '/abs/j.json', '--out', 'rel'], '/cwd', resolvePath);
    expect(parsed).toEqual({
      ok: true,
      invocation: { jobPath: '/abs/j.json', outDir: '/cwd/rel', quiet: false },
    });
  });

  it('reads --quiet', () => {
    const parsed = parseJobArgs(['x', '--job', 'j', '--out', 'o', '--quiet'], '/c', resolvePath);
    expect(parsed).toMatchObject({ ok: true, invocation: { quiet: true } });
  });

  it('refuses --job without --out rather than guessing a directory', () => {
    expect(parseJobArgs(['x', '--job', 'j.json'], '/cwd', resolvePath)).toEqual({
      ok: false,
      error: '--job requires --out DIR',
    });
  });

  it('refuses a --job whose value is the next switch', () => {
    expect(parseJobArgs(['x', '--job', '--out', 'o'], '/cwd', resolvePath)).toEqual({
      ok: false,
      error: '--job needs a path',
    });
  });
});

describe('validateJob — the shape of a valid job', () => {
  it('accepts the minimal job', () => {
    const result = validateJob(minimal);
    expect(result).toEqual({ ok: true, job: minimal, errors: [] });
  });

  it('accepts a saved scene instead of files + preset', () => {
    expect(validateJob({ ...minimal, scene: { path: '/data/s.tetravox.json' } }).ok).toBe(true);
  });

  it('accepts every action type with its full option set', () => {
    const result = validateJob({
      version: JOB_SCHEMA_VERSION,
      scene: { files: ['/a.nii.gz', '/b.msh'], preset: 'ti-field-on-t1' },
      window: { width: 1400, height: 900 },
      actions: [
        {
          type: 'set',
          layer: 'T1.nii.gz',
          patch: { opacity: 0.5 },
          cursor: [1, 2, 3],
          layout: '2x2',
          camera: 'L',
          view: 'view3d',
          radiological: true,
          reset: true,
          annotations: { colorbar: true, crosshair: false },
        },
        {
          type: 'screenshot',
          out: 'a.png',
          view: 'axial',
          width: 1200,
          height: 800,
          scale: 2,
          dpi: 300,
          background: 'white',
          include: { colorbar: true },
          autoTrim: true,
        },
        {
          type: 'sweep',
          view: 'axial',
          out: 'sweep',
          from: -40,
          to: 40,
          count: 10,
          fps: 12,
          format: ['gif', 'mp4'],
        },
        { type: 'orbit', out: 'orbit', degrees: 360, frames: 36, axis: 'z', format: 'mp4' },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the window and the schema version are optional', () => {
    expect(validateJob(minimal).ok).toBe(true);
    expect(DEFAULT_WINDOW).toEqual({ width: 1400, height: 900 });
  });

  it('`set` can select the layer the panels show', () => {
    const result = validateJob({
      ...minimal,
      actions: [{ type: 'set', active: 'ernie.msh' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(errorsFor({ ...minimal, actions: [{ type: 'set', active: {} }] })).toEqual([
      'actions[0].active: must be a layer index, a layer name, or "active"',
    ]);
  });

  it('a UI tour asks for panels and captures the window', () => {
    // `window.panels` keeps the §8 shell on screen and `view: "window"` photographs it — the pair
    // that lets a job show the interface rather than only what the engine draws.
    const result = validateJob({
      ...minimal,
      window: { width: 1920, height: 1080, panels: true },
      actions: [
        { type: 'screenshot', out: 'ui.png', view: 'window' },
        { type: 'tween', out: 'tour', view: 'window', frames: 30, to: { distance: 300 } },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * `view: "figure"` was documented (§2.3) and dispatched (`automation/run.ts`) before it was ever
 * accepted here, so the one action the feature exists for was refused by the validator. These are
 * the claims that keep the three ends together.
 */
describe('validateJob — view: "figure"', () => {
  const figureJob = (figure: unknown, view: unknown = 'figure'): unknown => ({
    ...minimal,
    actions: [{ type: 'screenshot', out: 'figure-1.png', view, dpi: 300, figure }],
  });

  it('accepts the publication figure `docs/AUTOMATION.md` prints', () => {
    const result = validateJob(
      figureJob({ columns: 2, gutterMm: 3, labels: 'upper', labelPt: 10, background: 'white' })
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts `view: "figure"` with no options at all — every field has a default', () => {
    expect(validateJob(figureJob(undefined)).ok).toBe(true);
  });

  it('names the panes it does not recognise', () => {
    expect(errorsFor(figureJob({ panels: ['axial', 'oblique'] }))).toEqual([
      'actions[0].figure.panels[1]: must be one of axial, coronal, sagittal, view3d',
    ]);
    expect(errorsFor(figureJob({ panels: [] }))).toEqual([
      'actions[0].figure.panels: must be a non-empty array of view ids',
    ]);
  });

  it('names an unknown figure key, a bad label style and a negative gutter', () => {
    expect(errorsFor(figureJob({ gutter: 3 }))).toEqual([
      'actions[0].figure.gutter: unknown key (expected panels, columns, gutterMm, labels, labelPt, background)',
    ]);
    expect(errorsFor(figureJob({ labels: 'roman' }))).toEqual([
      'actions[0].figure.labels: must be one of upper, lower, none',
    ]);
    expect(errorsFor(figureJob({ background: 'black' }))).toEqual([
      'actions[0].figure.background: must be one of white, transparent',
    ]);
    expect(errorsFor(figureJob({ columns: -1, gutterMm: -2, labelPt: 0 }))).toEqual([
      'actions[0].figure.columns: must be 0 (automatic) or more',
      'actions[0].figure.gutterMm: must be 0 or more',
      'actions[0].figure.labelPt: must be greater than 0',
    ]);
  });

  it('says so when `figure` sits beside a view that ignores it', () => {
    // Silence would be worse than an error here: the bag is read only by the figure path, so a
    // `figure` under `view: "grid"` is a picture that is not the one the job asked for.
    expect(errorsFor(figureJob({ columns: 2 }, 'grid'))).toEqual([
      'actions[0].figure: only applies to `view: "figure"`, and is ignored otherwise',
    ]);
  });
});

describe('validateJob — what a bad job is told', () => {
  it('rejects a non-boolean window.panels', () => {
    expect(errorsFor({ ...minimal, window: { width: 10, height: 10, panels: 'yes' } })).toEqual([
      'window.panels: must be true or false',
    ]);
  });

  it('a sweep and an orbit cannot capture the window: they own a pane, not the chrome', () => {
    expect(
      errorsFor({ ...minimal, actions: [{ type: 'sweep', out: 's', view: 'window' }] })
    ).toEqual(['actions[0].view: must be one of axial, coronal, sagittal']);
  });

  it('rejects a non-object', () => {
    expect(errorsFor('a job')).toEqual(['job: must be a JSON object']);
    expect(errorsFor([])).toEqual(['job: must be a JSON object']);
  });

  it('rejects a version it does not implement', () => {
    expect(errorsFor({ ...minimal, version: 99 })).toContain(
      `version: must be ${JOB_SCHEMA_VERSION}`
    );
  });

  it('rejects a scene that is both a saved file and a file list', () => {
    const errors = errorsFor({ ...minimal, scene: { path: '/s.json', files: ['/a.nii'] } });
    expect(errors).toEqual(['scene: has both `path` and `files`; a scene is one or the other']);
  });

  it('rejects a scene with neither', () => {
    expect(errorsFor({ ...minimal, scene: {} })).toEqual([
      'scene: needs `path` (a saved scene) or `files` (a list to load)',
    ]);
  });

  it('rejects an unknown preset by listing the ones that exist', () => {
    const errors = errorsFor({ ...minimal, scene: { files: ['/a.nii'], preset: 'pretty' } });
    expect(errors).toEqual([
      'scene.preset: must be one of plain, ti-field-on-t1, mesh-tissues-translucent, atlas-outline',
    ]);
  });

  it('rejects an empty action list — a job that renders nothing is a mistake', () => {
    expect(errorsFor({ ...minimal, actions: [] })).toEqual(['actions: must be a non-empty array']);
  });

  it('rejects an unknown action type', () => {
    expect(errorsFor({ ...minimal, actions: [{ type: 'render' }] })).toEqual([
      'actions[0].type: must be one of set, screenshot, sweep, orbit, tween, save-scene, module',
    ]);
  });

  it('reports every problem at once, not just the first', () => {
    const errors = errorsFor({
      scene: { files: [], preset: 'nope' },
      actions: [{ type: 'screenshot' }, { type: 'orbit', out: 'o', frames: -1 }],
    });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('scene.files');
    expect(errors[1]).toContain('scene.preset');
    expect(errors[2]).toContain('actions[0].out');
    expect(errors[3]).toBe('actions[1].frames: must be greater than 0');
  });

  it('refuses an output name that escapes --out', () => {
    for (const out of ['/etc/passwd', '../up.png', 'a/../../b.png']) {
      expect(errorsFor({ ...minimal, actions: [{ type: 'screenshot', out }] })).toEqual([
        'actions[0].out: must be a relative name inside --out (no leading /, no ..)',
      ]);
    }
  });

  it('refuses a sweep of the 3D view and points at `orbit`', () => {
    const errors = errorsFor({
      ...minimal,
      actions: [{ type: 'sweep', view: 'view3d', out: 's' }],
    });
    expect(errors).toEqual(['actions[0].view: a sweep steps a slice; use `orbit` for the 3D view']);
  });

  it('refuses a sweep paced by both `step` and `count`', () => {
    const errors = errorsFor({
      ...minimal,
      actions: [{ type: 'sweep', view: 'axial', out: 's', step: 2, count: 10 }],
    });
    expect(errors).toEqual([
      'actions[0]: has both `step` and `count`; a sweep is paced by one or the other',
    ]);
  });

  it('refuses a zero step and a zero-degree orbit, which would never terminate or never move', () => {
    expect(
      errorsFor({ ...minimal, actions: [{ type: 'sweep', view: 'axial', out: 's', step: 0 }] })
    ).toEqual(['actions[0].step: must not be 0']);
    expect(errorsFor({ ...minimal, actions: [{ type: 'orbit', out: 'o', degrees: 0 }] })).toEqual([
      'actions[0].degrees: must not be 0',
    ]);
  });

  it('refuses a `set` that sets nothing', () => {
    expect(errorsFor({ ...minimal, actions: [{ type: 'set', layer: 0 }] })).toEqual([
      'actions[0]: a `set` with nothing to set does nothing',
    ]);
  });

  it('refuses a cursor that is not three finite numbers', () => {
    for (const cursor of [
      [1, 2],
      [1, 2, 3, 4],
      ['a', 'b', 'c'],
      [1, 2, null],
    ]) {
      expect(errorsFor({ ...minimal, actions: [{ type: 'set', cursor }] })).toEqual([
        'actions[0].cursor: must be three finite numbers [x, y, z] in world RAS mm',
      ]);
    }
  });

  it('names an unknown `include` key rather than ignoring it', () => {
    const errors = errorsFor({
      ...minimal,
      actions: [{ type: 'screenshot', out: 'a.png', include: { colourbar: true } }],
    });
    expect(errors[0]).toBe(
      'actions[0].include.colourbar: unknown key (expected colorbar, orientationLabels, crosshair, cornerInfo, scaleBar, orientationCube)'
    );
  });
});

describe('frameFormats', () => {
  it('always writes PNG frames and a GIF, whatever was asked for', () => {
    expect([...frameFormats(undefined)].sort()).toEqual(['gif', 'png']);
    // The point of the rule: an `["mp4"]` job on a machine with no ffmpeg still produces something.
    expect([...frameFormats(['mp4'])].sort()).toEqual(['gif', 'mp4', 'png']);
    expect([...frameFormats('mp4')].sort()).toEqual(['gif', 'mp4', 'png']);
  });
});

describe('jobInputPaths', () => {
  it('lists the file list, or the saved scene, for the allow-list', () => {
    expect(jobInputPaths(validateJob(minimal).job as never)).toEqual(['/data/T1.nii.gz']);
    const saved = validateJob({ ...minimal, scene: { path: '/s.tetravox.json' } }).job as never;
    expect(jobInputPaths(saved)).toEqual(['/s.tetravox.json']);
  });
});

// ------------------------------------------------------------------------------------------------
// tween, sequences and the two layouts task 3 added (directed task 14)
// ------------------------------------------------------------------------------------------------

/** A minimal valid job carrying one action, so a case only has to state the action. */
function jobWith(action: Record<string, unknown>): Record<string, unknown> {
  return { scene: { files: ['T1.nii.gz'], preset: 'plain' }, actions: [action] };
}

describe('tween', () => {
  it('accepts a shot that moves the cursor, dollies in and fades a layer up', () => {
    const result = validateJob(
      jobWith({
        type: 'tween',
        out: 'showcase',
        frames: 45,
        ease: 'inOut',
        to: {
          cursor: [-33.4, 31.2, 16.3],
          distance: 260,
          target: [0, 20, 10],
          views: { axial: { mmPerPx: 0.32, center: [10, -4] } },
          layers: [{ layer: 'labeling.nii.gz', patch: { opacity: 0.55 } }],
        },
        orbit: { degrees: -35, axis: 'z' },
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('refuses a tween with nowhere to go, rather than writing N identical frames', () => {
    const result = validateJob(jobWith({ type: 'tween', out: 'a', frames: 10 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'actions[0]: a `tween` with no `to` and no `orbit` has nowhere to go'
    );
  });

  it('names the bad key inside a state rather than rejecting the state as a whole', () => {
    const result = validateJob(
      jobWith({ type: 'tween', out: 'a', to: { cursor: [1, 2], layout: '2x2' } })
    );
    expect(result.errors).toContain(
      'actions[0].to.cursor: must be three finite numbers [x, y, z] in world RAS mm'
    );
    expect(result.errors).toContain(
      'actions[0].to.layout: unknown key (expected cursor, distance, target, views, layers)'
    );
  });

  it('rejects a 2D pan/zoom aimed at a view that does not exist', () => {
    const result = validateJob(
      jobWith({ type: 'tween', out: 'a', to: { views: { oblique: { mmPerPx: 0.4 } } } })
    );
    expect(result.errors).toContain(
      'actions[0].to.views.oblique: must be one of axial, coronal, sagittal, view3d'
    );
  });

  it('rejects an orbit with no angle and one with a zero angle for the same reason', () => {
    expect(validateJob(jobWith({ type: 'tween', out: 'a', orbit: {} })).errors).toContain(
      'actions[0].orbit.degrees: is required — an orbit with no angle does nothing'
    );
    expect(
      validateJob(jobWith({ type: 'tween', out: 'a', orbit: { degrees: 0 } })).errors
    ).toContain('actions[0].orbit.degrees: must not be 0');
  });

  it('is listed among the action types an unknown `type` is told about', () => {
    const result = validateJob(jobWith({ type: 'zoom', out: 'a' }));
    expect(result.errors).toContain(
      'actions[0].type: must be one of set, screenshot, sweep, orbit, tween, save-scene, module'
    );
  });
});

describe('sequence', () => {
  it('accepts start / continue / end on every frame action', () => {
    for (const [action, role] of [
      [{ type: 'sweep', view: 'axial', out: 'v', count: 4 }, 'start'],
      [{ type: 'orbit', out: 'v', frames: 4 }, 'continue'],
      [{ type: 'tween', out: 'v', frames: 4, to: { distance: 300 } }, 'end'],
    ] as const) {
      const result = validateJob(jobWith({ ...action, sequence: role }));
      expect(result.errors).toEqual([]);
    }
  });

  it('rejects a role that is not one of the three', () => {
    const result = validateJob(jobWith({ type: 'orbit', out: 'v', sequence: 'append' }));
    expect(result.errors).toContain('actions[0].sequence: must be one of start, continue, end');
  });

  it('takes `gif: false`, the opt-out a 1080p sequence needs', () => {
    expect(validateJob(jobWith({ type: 'orbit', out: 'v', gif: false })).errors).toEqual([]);
    expect(validateJob(jobWith({ type: 'orbit', out: 'v', gif: 'no' })).errors).toContain(
      'actions[0].gif: must be true or false'
    );
  });
});

describe('layouts', () => {
  it('offers the two layouts that contain the 3D pane (directed task 3)', () => {
    for (const layout of ['1+3', '3d+1']) {
      expect(validateJob(jobWith({ type: 'set', layout })).errors).toEqual([]);
    }
  });
});

describe('expandEnv', () => {
  it('expands ${VAR} so a committed job can name data outside the checkout', () => {
    expect(expandEnv('${DATA}/m2m_ernie/T1.nii.gz', { DATA: '/subjects/ernie' })).toEqual({
      ok: true,
      path: '/subjects/ernie/m2m_ernie/T1.nii.gz',
    });
  });

  it('reports every unset variable rather than expanding it to nothing', () => {
    expect(expandEnv('${A}/x/${B}', { A: undefined, B: '' })).toEqual({
      ok: false,
      missing: ['A', 'B'],
    });
  });

  it('leaves a bare $NAME alone — a dollar in a file name is not a variable', () => {
    expect(expandEnv('/data/$HOME/a$b.nii.gz', { HOME: '/root' })).toEqual({
      ok: true,
      path: '/data/$HOME/a$b.nii.gz',
    });
  });

  it('passes a path with no reference through untouched', () => {
    expect(expandEnv('T1.nii.gz', {})).toEqual({ ok: true, path: 'T1.nii.gz' });
  });
});

// ------------------------------------------------------------------------------------------------
// The module envelope (ARCHITECTURE.md §13.6)
// ------------------------------------------------------------------------------------------------

/**
 * A manifest set written for this test, and the reason it exists rather than a shipped one: no
 * module declares every `ArgType`, and a validator that is only ever driven with `string` is a
 * validator whose other eight branches are untested. `validateJob` and the four helpers all take
 * the manifest list as their last argument for exactly this — the same seam `shouldPromptOnClose`
 * takes `env` for (`main/module-io.ts`).
 *
 * The cases below then *also* run against the real `MANIFESTS`, through `tetravox.hello`'s `echo`,
 * so the default binding is proven live rather than assumed.
 */
const EVERY_TYPE: ArgShape = {
  n: 'number',
  n2: 'number?',
  s: 'string',
  s2: 'string?',
  b: 'boolean',
  b2: 'boolean?',
  v: 'vec3?',
  p: 'path',
  p2: 'path?',
  o: 'out',
};

const FIXTURES: readonly ModuleManifest[] = [
  {
    id: 'test.every',
    title: 'Every argument type',
    version: '2.5.0',
    hostApi: 1,
    docs: 'Modules',
    activation: ['onToggle'],
    commands: [],
    writers: [
      {
        id: 'table',
        title: 'Save the table',
        filters: [{ name: 'Table', extensions: ['tsv'] }],
        siblings: ['{name}.{stamp}.bak', '{stem}_editlog.json'],
        backup: 'timestamped',
      },
    ],
    operations: [
      { id: 'every', args: EVERY_TYPE },
      { id: 'none', args: {} },
      { id: 'two-paths', args: { ct: 'path', tsv: 'path', t1: 'path?' } },
    ],
  },
  {
    id: 'test.quiet',
    title: 'No operations at all',
    version: '0.1.0',
    hostApi: 1,
    docs: 'Modules',
    activation: ['onToggle'],
    commands: [],
  },
];

/** Every argument of `test.every/every`, all valid — the baseline each rejection perturbs. */
const everyArg = (): Record<string, unknown> => ({
  n: 1,
  n2: 2,
  s: 'a',
  s2: 'b',
  b: true,
  b2: false,
  v: [1, 2, 3],
  p: '/data/in.tsv',
  p2: '${TETRAVOX_TESTDATA}/T1.nii.gz',
  o: 'out.tsv',
});

const moduleJob = (action: Record<string, unknown>): Record<string, unknown> => ({
  scene: { files: ['/data/T1.nii.gz'], preset: 'plain' },
  actions: [{ type: 'module', ...action }],
});

function moduleErrors(action: Record<string, unknown>): string[] {
  const result = validateJob(moduleJob(action), FIXTURES);
  expect(result.ok).toBe(false);
  return result.errors;
}

describe('the module envelope', () => {
  it('accepts an operation with every argument type filled in', () => {
    const result = validateJob(
      moduleJob({ module: 'test.every', op: 'every', args: everyArg() }),
      FIXTURES
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts an operation whose optional arguments are simply absent', () => {
    const { n, s, b, p, o } = everyArg();
    const result = validateJob(
      moduleJob({ module: 'test.every', op: 'every', args: { n, s, b, p, o } }),
      FIXTURES
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts an operation that takes nothing, with `args` absent entirely', () => {
    expect(validateJob(moduleJob({ module: 'test.every', op: 'none' }), FIXTURES).ok).toBe(true);
  });

  it('runs against the shipped manifests by default — the fixture module`s `echo`', () => {
    // The default argument is `MANIFESTS`, so this is the envelope as a job file really meets it.
    const result = validateJob(
      moduleJob({ module: 'tetravox.hello', op: 'echo', args: { text: 'hello' } })
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('validates a shipped module operation against its manifest, arguments and all', () => {
    // The default argument is `MANIFESTS`, so this is the operation as a real job file meets it —
    // §13.6's promise that a manifest entry is the schema, with no second declaration anywhere. The
    // sEEG editor is a bundled extension now (§13.8), validated the same way once its manifest is
    // registered (`module-store.test.ts`, `allManifests()` + consent); the compiled-in fixture is
    // the shipped example here.
    expect(
      validateJob(moduleJob({ module: 'tetravox.hello', op: 'echo', args: { text: 'hi' } })).errors
    ).toEqual([]);
    // `text` is required and is a string: the two ways a job file gets it wrong.
    expect(
      validateJob(moduleJob({ module: 'tetravox.hello', op: 'echo', args: {} })).errors
    ).toEqual(['actions[0].args.text: is required (a string)']);
    expect(
      validateJob(moduleJob({ module: 'tetravox.hello', op: 'echo', args: { text: 7 } })).errors
    ).toEqual(['actions[0].args.text: must be a string']);
  });

  it('names the modules this build carries when the id is unknown', () => {
    expect(moduleErrors({ module: 'tetravox.nope', op: 'echo' })).toEqual([
      'actions[0].module: must be a module this build carries: test.every, test.quiet',
    ]);
    // A missing or non-string `module` is the same failure, and gets the same list.
    expect(moduleErrors({ op: 'echo' })[0]).toContain('actions[0].module: must be a module');
    expect(moduleErrors({ module: 7, op: 'echo' })[0]).toContain('actions[0].module');
  });

  it('lists the module`s operations when the op is unknown', () => {
    expect(moduleErrors({ module: 'test.every', op: 'snap' })).toEqual([
      "actions[0].op: must be one of test.every's operations: every, none, two-paths",
    ]);
    expect(moduleErrors({ module: 'test.quiet', op: 'anything' })).toEqual([
      'actions[0].op: test.quiet declares no operations',
    ]);
  });

  it('rejects an unknown key on the envelope itself', () => {
    expect(moduleErrors({ module: 'test.every', op: 'none', arguments: {} })).toEqual([
      'actions[0].arguments: unknown key (expected type, module, op, args)',
    ]);
  });

  it('rejects an unknown argument, because an undeclared key is a typo', () => {
    // Unlike a `set`'s `patch`, which is a `Partial<Layer>` nothing here can enumerate: an
    // operation declares everything it takes, so a silently dropped key is a job that only looks
    // like it ran.
    expect(moduleErrors({ module: 'test.every', op: 'none', args: { radius: 2 } })).toEqual([
      'actions[0].args.radius: unknown argument (this operation takes none)',
    ]);
    const errors = moduleErrors({
      module: 'test.every',
      op: 'two-paths',
      args: { ct: '/a.nii', tsv: '/b.tsv', T1: '/c.nii' },
    });
    expect(errors).toEqual([
      'actions[0].args.T1: unknown argument (this operation takes ct, tsv, t1)',
    ]);
  });

  it('names every missing required argument, with what it should have been', () => {
    expect(moduleErrors({ module: 'test.every', op: 'every', args: {} })).toEqual([
      'actions[0].args.n: is required (a finite number)',
      'actions[0].args.s: is required (a string)',
      'actions[0].args.b: is required (true or false)',
      'actions[0].args.p: is required (a path)',
      'actions[0].args.o: is required (a file name under --out)',
    ]);
  });

  it('checks each type the way the rest of the schema checks it', () => {
    const bad = (patch: Record<string, unknown>): string[] =>
      moduleErrors({ module: 'test.every', op: 'every', args: { ...everyArg(), ...patch } });
    expect(bad({ n: 'one' })).toEqual(['actions[0].args.n: must be a finite number']);
    expect(bad({ n2: Number.POSITIVE_INFINITY })).toEqual([
      'actions[0].args.n2: must be a finite number',
    ]);
    expect(bad({ s: 3 })).toEqual(['actions[0].args.s: must be a string']);
    expect(bad({ b: 'yes' })).toEqual(['actions[0].args.b: must be true or false']);
    expect(bad({ v: [1, 2] })).toEqual([
      'actions[0].args.v: must be three finite numbers [x, y, z] in world RAS mm',
    ]);
    expect(bad({ v: [1, 2, 'z'] })[0]).toContain('actions[0].args.v');
    expect(bad({ p: '' })).toEqual([
      'actions[0].args.p: must be a path (absolute, relative to the job file, or ${VAR})',
    ]);
    expect(bad({ p2: 42 })[0]).toContain('actions[0].args.p2: must be a path');
  });

  it('holds an `out` argument to the same rule every other output name is held to', () => {
    for (const o of ['/etc/passwd', '../up.tsv', 'a/../../b.tsv']) {
      expect(
        moduleErrors({ module: 'test.every', op: 'every', args: { ...everyArg(), o } })
      ).toEqual(['actions[0].args.o: must be a relative name inside --out (no leading /, no ..)']);
    }
    expect(
      moduleErrors({ module: 'test.every', op: 'every', args: { ...everyArg(), o: '' } })
    ).toEqual(['actions[0].args.o: must be a non-empty file name']);
  });

  it('reports a module action`s problems alongside every other action`s', () => {
    const result = validateJob(
      {
        scene: { files: ['/a.nii'], preset: 'plain' },
        actions: [
          { type: 'module', module: 'test.every', op: 'none', args: { x: 1 } },
          { type: 'screenshot', out: '/absolute.png' },
        ],
      },
      FIXTURES
    );
    expect(result.errors).toEqual([
      'actions[0].args.x: unknown argument (this operation takes none)',
      'actions[1].out: must be a relative name inside --out (no leading /, no ..)',
    ]);
  });

  it('refuses an `args` that is not an object', () => {
    expect(moduleErrors({ module: 'test.every', op: 'none', args: [1, 2] })).toEqual([
      'actions[0].args: must be an object of test.every/none arguments',
    ]);
  });
});

describe('module paths, out names and versions', () => {
  const job = (actions: Record<string, unknown>[]): Job => {
    const result = validateJob(
      { scene: { files: ['/data/T1.nii.gz'], preset: 'plain' }, actions },
      FIXTURES
    );
    expect(result.errors).toEqual([]);
    return result.job as Job;
  };

  const twoPaths = {
    type: 'module',
    module: 'test.every',
    op: 'two-paths',
    args: { ct: '/data/ct.nii.gz', tsv: 'contacts.tsv', t1: '${DATA}/T1.nii.gz' },
  };

  it('collects a module`s `path` arguments for the allow-list, after the scene`s files', () => {
    expect(jobInputPaths(job([twoPaths]), FIXTURES)).toEqual([
      '/data/T1.nii.gz',
      '/data/ct.nii.gz',
      'contacts.tsv',
      '${DATA}/T1.nii.gz',
    ]);
  });

  it('skips an absent optional path rather than leaving a hole in the list', () => {
    const one = { ...twoPaths, args: { ct: '/data/ct.nii.gz', tsv: '/data/c.tsv' } };
    expect(jobInputPaths(job([one]), FIXTURES)).toEqual([
      '/data/T1.nii.gz',
      '/data/ct.nii.gz',
      '/data/c.tsv',
    ]);
  });

  it('collects nothing from an `out` argument — it is an output, not an input', () => {
    const save = {
      type: 'module',
      module: 'test.every',
      op: 'every',
      args: everyArg(),
    };
    expect(jobInputPaths(job([save]), FIXTURES)).toEqual([
      '/data/T1.nii.gz',
      '/data/in.tsv',
      '${TETRAVOX_TESTDATA}/T1.nii.gz',
    ]);
  });

  it('puts the resolved paths back in the same order it took them', () => {
    const original = job([twoPaths, { type: 'screenshot', out: 'a.png' }]);
    const resolved = withInputPaths(
      original,
      ['/real/T1.nii.gz', '/real/ct.nii.gz', '/real/contacts.tsv', '/real/anat.nii.gz'],
      FIXTURES
    );
    expect(resolved.scene).toEqual({ files: ['/real/T1.nii.gz'], preset: 'plain' });
    expect((resolved.actions[0] as { args: Record<string, unknown> }).args).toEqual({
      ct: '/real/ct.nii.gz',
      tsv: '/real/contacts.tsv',
      t1: '/real/anat.nii.gz',
    });
    // Every other action is passed through by identity: a rewrite that copied them would be a
    // rewrite that could quietly drop a key.
    expect(resolved.actions[1]).toBe(original.actions[1]);
    // And the original document is untouched, which is what makes this safe to call once per run.
    expect((original.actions[0] as { args: Record<string, unknown> }).args['ct']).toBe(
      '/data/ct.nii.gz'
    );
  });

  it('leaves a job with no module action exactly as it was', () => {
    const plain = job([{ type: 'screenshot', out: 'a.png' }]);
    expect(withInputPaths(plain, ['/real/T1.nii.gz'], FIXTURES).actions).toEqual(plain.actions);
  });

  it('lists each `out` name with the sibling templates its module`s writers declare', () => {
    const save = { type: 'module', module: 'test.every', op: 'every', args: everyArg() };
    expect(moduleOutTargets(job([save]), FIXTURES)).toEqual([
      {
        module: 'test.every',
        name: 'out.tsv',
        siblings: ['{name}.{stamp}.bak', '{stem}_editlog.json'],
      },
    ]);
    expect(moduleOutTargets(job([twoPaths]), FIXTURES)).toEqual([]);
  });

  it('lists the modules a job ran, once each, with the version that ran them', () => {
    const save = { type: 'module', module: 'test.every', op: 'every', args: everyArg() };
    expect(jobModules(job([twoPaths, save]), FIXTURES)).toEqual([
      { id: 'test.every', version: '2.5.0' },
    ]);
    expect(jobModules(job([{ type: 'screenshot', out: 'a.png' }]), FIXTURES)).toEqual([]);
  });
});
