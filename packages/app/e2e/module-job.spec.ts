/**
 * **A module operation, end to end through a real `--job` launch** (ARCHITECTURE.md §13.6).
 *
 * `job.test.ts` asserts the envelope as a document and `run.test.ts` the two decisions around it,
 * but neither can answer the question this spec exists for: does a packaged-style launch, with no
 * window and no query string, actually put a module in the slot and run its operation — and does
 * what the operation did reach `job-result.json` and the saved scene.
 *
 * The subject is `tetravox.hello` (§13.4), the fixture that ships in every build, driven **without**
 * `?modules=hello`: a `--job` window has no URL to put it in, and offering the modules the job names
 * is the whole of `moduleSearchFor`. The sEEG module is not on this branch and must not be needed
 * here — a module test that could only run once a *particular* module existed would not be a test
 * of the surface.
 *
 * Three AGENTS rules shape it, as they shape `automation-realdata.spec.ts`: the launch is a plain
 * `spawn` and the window is never shown (rule 9); the data is `testdata/`, so it runs everywhere
 * rather than skipping (rule 2 does not apply — nothing here needs a subject); and every claim is a
 * value read back out of a file, never a picture (rule 1).
 */

/* eslint-disable no-empty-pattern */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { APP_ROOT } from './fixtures';

const VOLUME = resolve(APP_ROOT, '..', '..', 'testdata', 'vol_u8.nii.gz');

const temporaryDirectories: string[] = [];

interface JobOutcome {
  code: number;
  stdout: string;
  stderr: string;
  outDir: string;
  result: {
    ok: boolean;
    modules?: { id: string; version: string }[];
    outputs: {
      action: number;
      type: string;
      files: string[];
      ms: number;
      module?: string;
      op?: string;
      result?: Record<string, unknown> | null;
    }[];
    warnings: string[];
    errors: string[];
  };
}

/**
 * Launch the app with `--job` and wait for it to exit — `automation-realdata.spec.ts`'s `runJob`,
 * kept to what this spec needs. A private `--user-data-dir` per run because the single-instance
 * lock is keyed by it and is otherwise shared with a developer's own running copy.
 */
async function runJob(job: unknown, name: string): Promise<JobOutcome> {
  const dir = mkdtempSync(join(tmpdir(), `tetravox-modjob-${name}-`));
  temporaryDirectories.push(dir);
  const jobPath = join(dir, 'job.json');
  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(jobPath, JSON.stringify(job, null, 2));

  const electron = resolve(APP_ROOT, '..', '..', 'node_modules', '.bin', 'electron');
  const args = [
    APP_ROOT,
    `--user-data-dir=${join(dir, 'profile')}`,
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
    '--job',
    jobPath,
    '--out',
    outDir,
  ];

  const outcome = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = spawn(electron, args, { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });

  const resultPath = join(outDir, 'job-result.json');
  expect(existsSync(resultPath), `no job-result.json\n${outcome.stdout}\n${outcome.stderr}`).toBe(
    true
  );
  return { ...outcome, outDir, result: JSON.parse(readFileSync(resultPath, 'utf8')) };
}

test.describe('a module operation from a job', () => {
  // A `--job` run is not driven through Playwright and launches the dev build's `electron` either
  // way, so running it again under `packaged` would double the time for identical coverage.
  test.beforeAll(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'dev', 'the dev target only');
  });

  test.afterAll(() => {
    for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test.setTimeout(180_000);

  test('activates the module, runs its operation twice, and reports what it returned', async () => {
    const outcome = await runJob(
      {
        scene: { files: [VOLUME], preset: 'plain' },
        window: { width: 600, height: 400 },
        actions: [
          { type: 'module', module: 'tetravox.hello', op: 'echo', args: { text: 'from a job' } },
          { type: 'module', module: 'tetravox.hello', op: 'echo', args: { text: 'again' } },
          { type: 'screenshot', out: 'after.png', view: 'axial', width: 200 },
          { type: 'save-scene', out: 'scene' },
        ],
      },
      'hello-echo'
    );

    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.code).toBe(0);

    // Every claim §13.6 makes about a module action's record, in one object.
    expect(outcome.result.outputs[0]).toMatchObject({
      action: 0,
      type: 'module',
      module: 'tetravox.hello',
      op: 'echo',
      files: [],
      result: { text: 'from a job', count: 1 },
    });

    // `count: 2` is the load-bearing number: the module was activated **once** and the second
    // action reached the same instance. A dispatch that re-activated per action would answer 1
    // twice, and a module holding an unsaved edit would lose it between two actions of one job.
    expect(outcome.result.outputs[1]).toMatchObject({
      op: 'echo',
      result: { text: 'again', count: 2 },
    });

    // The run's provenance, main's answer: which module, and the version that ran it.
    expect(outcome.result.modules).toEqual([{ id: 'tetravox.hello', version: '1.0.0' }]);

    // The other actions still ran, in order, after the module's.
    expect(outcome.result.outputs.map((o) => o.type)).toEqual([
      'module',
      'module',
      'screenshot',
      'save-scene',
    ]);
    expect(existsSync(join(outcome.outDir, 'after.png'))).toBe(true);

    // §13.2: what the module did is in the scene the job saved — the block, its two versions, and
    // the state the operation produced. This is the end of the whole path: an action in a JSON
    // file, through main's validator, into a module's own state, out to a file on disk.
    const scene = JSON.parse(readFileSync(join(outcome.outDir, 'scene.tetravox.json'), 'utf8')) as {
      extensions?: Record<
        string,
        { module: string; version: number; moduleVersion: string; data: { count: number } }
      >;
    };
    expect(scene.extensions?.['tetravox.hello']).toEqual({
      module: 'tetravox.hello',
      version: 1,
      moduleVersion: '1.0.0',
      data: { count: 2, note: 'ping 2' },
    });
  });

  test('refuses an operation the manifest does not declare, before a window exists', async () => {
    const outcome = await runJob(
      {
        scene: { files: [VOLUME], preset: 'plain' },
        actions: [
          { type: 'module', module: 'tetravox.hello', op: 'snap', args: {} },
          { type: 'screenshot', out: 'never.png' },
        ],
      },
      'unknown-op'
    );

    expect(outcome.result.ok).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.result.errors).toEqual([
      "actions[0].op: must be one of tetravox.hello's operations: echo",
    ]);
    // "Before a window exists" is the claim, and this is what makes it checkable: the *later*
    // action never ran, so nothing was loaded, rendered or written.
    expect(outcome.result.outputs).toEqual([]);
    expect(existsSync(join(outcome.outDir, 'never.png'))).toBe(false);
    expect(outcome.stderr + outcome.stdout).toContain('actions[0].op');
  });

  test('refuses an argument the operation did not declare', async () => {
    const outcome = await runJob(
      {
        scene: { files: [VOLUME], preset: 'plain' },
        actions: [{ type: 'module', module: 'tetravox.hello', op: 'echo', args: { txt: 'typo' } }],
      },
      'unknown-arg'
    );

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.errors).toEqual([
      'actions[0].args.txt: unknown argument (this operation takes text)',
      'actions[0].args.text: is required (a string)',
    ]);
  });
});
