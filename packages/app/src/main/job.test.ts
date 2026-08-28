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
  frameFormats,
  jobInputPaths,
  parseJobArgs,
  validateJob,
} from './job';

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
});

describe('validateJob — what a bad job is told', () => {
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
      'actions[0].type: must be one of set, screenshot, sweep, orbit',
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
