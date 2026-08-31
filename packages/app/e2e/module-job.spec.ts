/**
 * **A module operation, end to end through a real `--job` launch** (ARCHITECTURE.md §13.6).
 *
 * `job.test.ts` asserts the envelope as a document and `run.test.ts` the two decisions around it,
 * but neither can answer the question this spec exists for: does a packaged-style launch, with no
 * window and no query string, actually put a module in the slot and run its operation — and does
 * what the operation did reach `job-result.json` and the saved scene.
 *
 * The subject of the first three tests is `tetravox.hello` (§13.4), the fixture that ships in every
 * build, driven **without** `?modules=hello`: a `--job` window has no URL to put it in, and offering
 * the modules the job names is the whole of `moduleSearchFor`. Nothing there needs a *particular*
 * product module, which is the point — it is a test of the surface.
 *
 * The last test is the other half, and it needs a product module precisely because the fixture
 * cannot provide it: `tetravox.hello` declares no `path` and no `out` argument (contracts §7 pins
 * its declaration to `echo`), so the round trip an `out` argument exists for — main resolves it
 * under `--out` and admits it with the module's writers' sibling templates, the module writes
 * through `host.files.writeText` with no Save sheet anywhere — had unit tests on both halves and
 * nothing joining them. `tetravox.seeg` is the module that declares both, so it is the one that
 * proves the seam.
 *
 * Three AGENTS rules shape it, as they shape `automation-realdata.spec.ts`: the launch is a plain
 * `spawn` and the window is never shown (rule 9); the data is `testdata/`, so it runs everywhere
 * rather than skipping (rule 2 does not apply — nothing here needs a subject); and every claim is a
 * value read back out of a file, never a picture (rule 1).
 */

/* eslint-disable no-empty-pattern */

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { APP_ROOT, bundledSeegVersion } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = join(TESTDATA, 'vol_u8.nii.gz');
// The second describe drives a real `tetravox.seeg` job. sEEG ships as the bundled extension
// (§13.8), placed under `resources/modules/` by `scripts/fetch-locked-modules.mjs`; when it is
// not on disk the build carries no such module and every action is refused. Skip there, exactly
// as `module-seeg.spec.ts` does — the cheap `test` CI leg runs `fetch-locked-modules
// --verify-only` (no download); the packaged leg and the local P077 gate cover the fetched case.
const SEEG_BUNDLE = resolve(
  APP_ROOT,
  'resources',
  'modules',
  'tetravox.seeg',
  bundledSeegVersion(),
  'index.js'
);

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

/**
 * **The `out` argument's whole round trip**, which is the half no unit test can reach: main
 * resolves the name under `--out` and admits it — with `{name}.{stamp}.bak` and
 * `{stem}_editlog.json`, the templates `tetravox.seeg`'s writer declares — to that module's write
 * list *before* `runOperation` is awaited (`job-runner.ts`), and the module then writes through
 * `host.files.writeText` exactly as it does from its panel, in a window that has no Save sheet and
 * no user to answer one.
 *
 * The three actions are the module's own loop with the person taken out: `load` binds the table to
 * the CT the scene opened, `snap` moves every contact onto the metal, `save` writes the table and
 * its editlog. `ct`, `tsv` (and `t1`, when a job names one) are `path` arguments, so all of them are
 * `${VAR}`-expanded, resolved and allow-listed by main before the window exists; `out` is the only
 * argument the renderer rewrites, because it alone names a directory a module has no business
 * knowing.
 *
 * Everything asserted is a value read back off disk (rule 1) from the committed fixtures (rule 2
 * needs no subject here): `ct_shafts.nii.gz` under the BIDS CT name, `seeg_contacts.tsv` beside it.
 */
test.describe('a module that writes, from a job', () => {
  test.beforeAll(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'dev', 'the dev target only');
    test.skip(
      !existsSync(SEEG_BUNDLE),
      'the bundled tetravox.seeg is not in resources/modules — run `node scripts/fetch-locked-modules.mjs`'
    );
  });

  test.afterAll(() => {
    for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test.setTimeout(180_000);

  /** A `seegprep` derivative tree with the committed fixtures in it — `module-seeg.spec.ts`'s. */
  function subjectTree(): { ct: string; tsv: string } {
    const root = mkdtempSync(join(tmpdir(), 'tetravox-seegjob-'));
    temporaryDirectories.push(root);
    const subject = join(root, 'derivatives', 'seegprep', 'sub-P076');
    mkdirSync(join(subject, 'ct'), { recursive: true });
    mkdirSync(join(subject, 'ieeg'), { recursive: true });
    const ct = join(subject, 'ct', 'sub-P076_acq-bone_space-T1w_ct.nii.gz');
    const tsv = join(subject, 'ieeg', 'sub-P076_space-T1w_electrodes.tsv');
    copyFileSync(join(TESTDATA, 'ct_shafts.nii.gz'), ct);
    copyFileSync(join(TESTDATA, 'seeg_contacts.tsv'), tsv);
    return { ct, tsv };
  }

  test('loads a table, snaps it to the CT, and saves both files under --out', async () => {
    const tree = subjectTree();
    const before = readFileSync(tree.tsv, 'utf8');
    const out = 'sub-P076_space-T1w_electrodes.tsv';

    const outcome = await runJob(
      {
        scene: { files: [tree.ct], preset: 'plain' },
        window: { width: 400, height: 300 },
        actions: [
          {
            type: 'module',
            module: 'tetravox.seeg',
            op: 'load',
            args: { ct: tree.ct, tsv: tree.tsv },
          },
          {
            type: 'module',
            module: 'tetravox.seeg',
            op: 'snap',
            args: { scope: 'all', radiusMm: 1.5 },
          },
          { type: 'module', module: 'tetravox.seeg', op: 'save', args: { out } },
        ],
      },
      'seeg-round-trip'
    );

    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.code).toBe(0);
    expect(outcome.result.modules).toEqual([
      { id: 'tetravox.seeg', version: bundledSeegVersion() },
    ]);

    // `load` found the CT the scene opened by its resolved path, and bound the table to it. `bound`
    // is the load-bearing field: false would mean the contacts were held and never placed, and
    // every number below would then be the file's own, unchanged.
    expect(outcome.result.outputs[0]).toMatchObject({
      type: 'module',
      module: 'tetravox.seeg',
      op: 'load',
      files: [],
      result: { contacts: 15, electrodes: 3, bound: true },
    });

    // Every contact really moved: the fixture puts each one about half a millimetre off the metal
    // (`gen-fixtures.py`'s `seeg` block computes both ends with numpy), so a snap that reported 0
    // would mean `peakCentroid` never saw the volume.
    const snapped = outcome.result.outputs[1]?.result as { moved: number; meanShiftMm: number };
    expect(snapped.moved).toBe(15);
    expect(snapped.meanShiftMm).toBeGreaterThan(0.1);
    expect(snapped.meanShiftMm).toBeLessThan(1.5);

    // The two files land in `--out`, under the names main admitted, and the operation says where.
    const tsvPath = join(outcome.outDir, out);
    const editlogPath = join(outcome.outDir, 'sub-P076_space-T1w_electrodes_editlog.json');
    expect(outcome.result.outputs[2]).toMatchObject({
      op: 'save',
      files: [out],
      result: { path: tsvPath, editlog: editlogPath },
    });
    expect(existsSync(tsvPath)).toBe(true);
    expect(existsSync(editlogPath)).toBe(true);

    // A job never writes over the table it read — an `out` is a name under `--out`, which is also
    // why no `.bak` is minted: there was nothing at the target to back up.
    expect(readFileSync(tree.tsv, 'utf8')).toBe(before);
    expect(readdirSync(outcome.outDir).filter((f) => f.endsWith('.bak'))).toEqual([]);
    expect(readdirSync(outcome.outDir).sort()).toEqual([
      'job-result.json',
      'sub-P076_space-T1w_electrodes.tsv',
      'sub-P076_space-T1w_electrodes_editlog.json',
    ]);

    // The table is the module's own writer's: the file's original columns, LF, and a `status` of
    // `edited` on every row the snap moved.
    const written = readFileSync(tsvPath, 'utf8');
    expect(written).not.toContain('\r');
    const rows = written.trimEnd().split('\n');
    expect(rows).toHaveLength(16);
    expect(rows[0]).toBe('name\telectrode\tcontact\tcsc\tx\ty\tz\tstatus');
    expect(rows.slice(1).every((row) => row.endsWith('\tedited'))).toBe(true);
    // The positions are not the ones that were read: this is the save half of the snap above.
    expect(written).not.toBe(before);

    // `seegprep`'s `--force` guard globs for this file by name; its counts are what a reader checks.
    const editlog = JSON.parse(readFileSync(editlogPath, 'utf8')) as {
      schema: string;
      output_tsv: string;
      backup: string | null;
      n_contacts: number;
      n_electrodes: number;
      edited: number;
      added: number;
      snap_radius_mm: number;
      electrodes: { name: string; snapped: boolean }[];
      contacts: { name: string; change: string; shift_mm: number }[];
    };
    expect(editlog.schema).toBe('tetravox.contacts/editlog@1');
    expect(editlog.output_tsv).toBe(tsvPath);
    expect(editlog.backup).toBeNull();
    expect(editlog).toMatchObject({ n_contacts: 15, n_electrodes: 3, edited: 15, added: 0 });
    expect(editlog.snap_radius_mm).toBe(1.5);
    expect(editlog.electrodes.map((e) => e.name)).toEqual(['A', 'B', 'C']);
    expect(editlog.electrodes.every((e) => e.snapped)).toBe(true);
    expect(editlog.contacts).toHaveLength(15);
    expect(editlog.contacts.every((c) => c.change === 'edited' && c.shift_mm > 0)).toBe(true);
  });

  /**
   * The same round trip with an `out` that names a **subdirectory**, which `outName` has always
   * admitted — no leading `/`, no `..`, so it is a name inside `--out` like any other. Main resolved
   * it and admitted it to the write list, and then the write failed with ENOENT, because nothing
   * created `<out>/tables`: the admission and the write disagreed about whose job the directory was.
   * `module-io.test.ts` pins the unit; this is the launch that produced the failure.
   */
  test('makes the subdirectory an `out` names, and writes the table and editlog into it', async () => {
    const tree = subjectTree();
    const out = 'tables/sub-P076_space-T1w_electrodes.tsv';

    const outcome = await runJob(
      {
        scene: { files: [tree.ct], preset: 'plain' },
        window: { width: 400, height: 300 },
        actions: [
          {
            type: 'module',
            module: 'tetravox.seeg',
            op: 'load',
            args: { ct: tree.ct, tsv: tree.tsv },
          },
          { type: 'module', module: 'tetravox.seeg', op: 'save', args: { out } },
        ],
      },
      'seeg-nested-out'
    );

    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.code).toBe(0);

    const tsvPath = join(outcome.outDir, 'tables', 'sub-P076_space-T1w_electrodes.tsv');
    const editlogPath = join(
      outcome.outDir,
      'tables',
      'sub-P076_space-T1w_electrodes_editlog.json'
    );
    expect(outcome.result.outputs[1]).toMatchObject({
      op: 'save',
      files: [out],
      result: { path: tsvPath, editlog: editlogPath },
    });
    // Both files are in the directory the job named and the run created, and `--out` itself holds
    // nothing but the result file and that directory.
    expect(readFileSync(tsvPath, 'utf8').split('\n')[0]).toBe(
      'name\telectrode\tcontact\tcsc\tx\ty\tz\tstatus'
    );
    expect(existsSync(editlogPath)).toBe(true);
    expect(readdirSync(outcome.outDir).sort()).toEqual(['job-result.json', 'tables']);
  });

  test('refuses an `out` that would climb out of --out, before a window exists', async () => {
    const tree = subjectTree();
    const outcome = await runJob(
      {
        scene: { files: [tree.ct], preset: 'plain' },
        actions: [
          {
            type: 'module',
            module: 'tetravox.seeg',
            op: 'save',
            args: { out: '../escaped.tsv' },
          },
        ],
      },
      'seeg-escaping-out'
    );

    expect(outcome.result.ok).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.result.errors).toEqual([
      'actions[0].args.out: must be a relative name inside --out (no leading /, no ..)',
    ]);
    expect(outcome.result.outputs).toEqual([]);
  });
});
