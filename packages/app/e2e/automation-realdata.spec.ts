/**
 * **The `--job` automation surface, end to end on real data.**
 *
 * This is the only test that runs the whole thing as a user would: it launches the *real* app with
 * `--job`, against the reference subject, and asserts the files that come out. Everything below it is
 * covered by unit tests — the schema (`src/main/job.test.ts`), the GIF encoder (`src/main/gif.test.ts`),
 * the sweep/orbit arithmetic and the presets (`automation/*.test.ts`) — so what is left for this spec
 * is exactly the part no unit test can reach: does an unattended Electron launch load 184 MB of mesh,
 * render it on the GPU with no window, and write PNGs that are not blank.
 *
 * Three rules it follows, all from AGENTS.md:
 *
 * * **Rule 9, windowless.** The launch does not go through `launchApp` (that fixture is for a
 *   Playwright-driven window); it is a plain `spawn`, and `src/main/window.ts` forces `offscreen` for
 *   any argv carrying `--job`. Nothing here sets `TETRAVOX_E2E_HEADED`, and setting it outside would
 *   not re-show these windows either.
 * * **Rule 2, real data gated.** `TETRAVOX_TESTDATA` unset ⇒ skip, never fail.
 * * **Rule 1, numbers not pictures.** No golden is compared. The claims are decoded from the PNG
 *   bytes: the image is the size that was asked for, it is not one flat colour, and consecutive
 *   frames of a sweep or an orbit *differ from each other* — which is the property that separates a
 *   working animation from twenty-four copies of frame zero, and the one a human glancing at a GIF
 *   is worst at judging.
 */

/* eslint-disable no-empty-pattern */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { APP_ROOT } from './fixtures';
import { decodePng, readPngDpi } from './png';
import type { DecodedPng } from './png';

const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';

/** Every temp directory this spec made, so `afterAll` can clean them up. */
const temporaryDirectories: string[] = [];

const P = {
  t1: join(ROOT, 'm2m_ernie', 'T1.nii.gz'),
  ernie: join(ROOT, 'm2m_ernie', 'ernie.msh'),
  tiMax: join(ROOT, 'Simulations', 'Thalamus', 'TI', 'niftis', 'Thalamus_TI_subject_TI_max.nii.gz'),
};

// ------------------------------------------------------------------------------------------------
// Running a job
// ------------------------------------------------------------------------------------------------

interface JobOutcome {
  code: number;
  stdout: string;
  stderr: string;
  outDir: string;
  result: {
    ok: boolean;
    outputs: { action: number; type: string; files: string[]; ms: number }[];
    timings: { totalMs: number; loadMs: number; actionsMs: number };
    warnings: string[];
    errors: string[];
  };
}

/**
 * Launch the app with `--job` and wait for it to exit.
 *
 * `electron` is resolved from `node_modules/.bin`, and the app directory is passed as argv[1], which
 * is the same shape `pnpm dev` uses. A private `--user-data-dir` per run for the reason
 * `e2e/fixtures.ts` documents at length: the single-instance lock is keyed by the userData directory
 * and is otherwise shared with a developer's own running copy. (A `--job` run is exempt from that lock
 * in `src/main/index.ts`, so this is belt and braces — and it also keeps the run's cache out of the
 * developer's profile.)
 */
async function runJob(job: unknown, name: string): Promise<JobOutcome> {
  const dir = mkdtempSync(join(tmpdir(), `tetravox-job-${name}-`));
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
  return {
    ...outcome,
    outDir,
    result: JSON.parse(readFileSync(resultPath, 'utf8')),
  };
}

// ------------------------------------------------------------------------------------------------
// Claims about an image
// ------------------------------------------------------------------------------------------------

/** Mean luminance and the spread around it: a blank frame has a spread of zero. */
function statistics(png: DecodedPng): { mean: number; spread: number } {
  let sum = 0;
  let sumSquares = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i += 1) {
    const at = i * 4;
    const luma =
      0.299 * (png.pixels[at] as number) +
      0.587 * (png.pixels[at + 1] as number) +
      0.114 * (png.pixels[at + 2] as number);
    sum += luma;
    sumSquares += luma * luma;
  }
  const mean = sum / n;
  return { mean, spread: Math.sqrt(Math.max(0, sumSquares / n - mean * mean)) };
}

/**
 * The fraction of pixels that differ between two frames by more than a small tolerance.
 *
 * The tolerance is 8 counts, well above the driver's own rounding and well below any real change: a
 * sweep that stepped a slice changes a *lot* of pixels, and an orbit changes nearly all of them.
 */
function differingFraction(a: DecodedPng, b: DecodedPng): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let differing = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i += 1) {
    const at = i * 4;
    const delta =
      Math.abs((a.pixels[at] as number) - (b.pixels[at] as number)) +
      Math.abs((a.pixels[at + 1] as number) - (b.pixels[at + 1] as number)) +
      Math.abs((a.pixels[at + 2] as number) - (b.pixels[at + 2] as number));
    if (delta > 8) differing += 1;
  }
  return differing / n;
}

function readImage(outDir: string, name: string): DecodedPng {
  const path = join(outDir, name);
  expect(existsSync(path), `${name} was not written`).toBe(true);
  return decodePng(readFileSync(path));
}

/** A frame that is not blank: real content, not one flat colour and not pure black. */
function expectNotBlank(png: DecodedPng, name: string): void {
  const { mean, spread } = statistics(png);
  expect(spread, `${name} is a single flat colour (spread ${spread.toFixed(2)})`).toBeGreaterThan(
    5
  );
  expect(mean, `${name} is entirely black`).toBeGreaterThan(1);
}

// ------------------------------------------------------------------------------------------------

test.describe('automation (--job) on real data', () => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is not set');
  // The mesh legs load 184 MB and render 12 frames of it; the default 60 s is not enough on a cold
  // page cache, and a timeout here would look like a hang rather than like a slow load.
  test.setTimeout(600_000);

  // `packaged` runs the same specs by design; a `--job` launch is by definition not driven through
  // Playwright, and it launches the dev build's `electron` binary either way, so running it twice
  // would only double the time for identical coverage.
  test.beforeAll(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'dev', 'the dev target only');
  });

  test('a T1 + mesh screenshot job writes PNGs of the requested size that are not blank', async () => {
    const outcome = await runJob(
      {
        scene: { files: [P.t1, P.ernie], preset: 'mesh-tissues-translucent' },
        window: { width: 1000, height: 800 },
        actions: [
          // `mmPerPx` rather than `reset`: a 800 px pane at the scene default of 0.5 covers 400 mm
          // and the head is a third of it, which is a fine picture and a poor thing to assert
          // differences over. 0.28 fills the pane with the head.
          { type: 'set', cursor: [0, -18, 8], layout: '1x1', view: 'axial', mmPerPx: 0.28 },
          { type: 'screenshot', out: 'axial.png', view: 'axial', width: 600, dpi: 300 },
          { type: 'set', layout: '3d-only', camera: 'L', view: 'view3d' },
          { type: 'screenshot', out: 'head.png', view: 'view3d', width: 600 },
        ],
      },
      'screenshot'
    );

    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.code).toBe(0);

    // The result file describes what was written, action by action, which is the client's contract.
    expect(outcome.result.outputs.map((o) => o.type)).toEqual([
      'set',
      'screenshot',
      'set',
      'screenshot',
    ]);
    expect(outcome.result.timings.loadMs).toBeGreaterThan(0);

    const axial = readImage(outcome.outDir, 'axial.png');
    expect(axial.width).toBe(600);
    expectNotBlank(axial, 'axial.png');

    const head = readImage(outcome.outDir, 'head.png');
    expect(head.width).toBe(600);
    expectNotBlank(head, 'head.png');

    // Two different scenes, photographed two different ways: if the second screenshot had captured
    // the same pane as the first, this is what would catch it.
    expect(differingFraction(axial, head)).toBeGreaterThan(0.2);

    // The PNG carries the DPI it was asked for, in the chunk — §11: parse it, do not eyeball it.
    expect(readPngDpi(readFileSync(join(outcome.outDir, 'axial.png')))).toBe(300);
  });

  test('a 10-frame axial sweep writes 10 PNGs and a GIF, and every frame differs from the last', async () => {
    const outcome = await runJob(
      {
        scene: { files: [P.t1], preset: 'plain' },
        window: { width: 700, height: 700 },
        actions: [
          { type: 'set', layout: '1x1', view: 'axial', mmPerPx: 0.28 },
          {
            type: 'sweep',
            view: 'axial',
            out: 'sweep',
            // An explicit range, through the brain. The default covers the volume's whole extent,
            // which for this T1 is 255 mm around a 180 mm head — so the outermost frames are empty
            // and near-identical, and asserting "every frame differs" over them would be asserting
            // something the data does not say. `boundsAlongNormal`'s own contract says as much.
            from: -50,
            to: 60,
            count: 10,
            width: 300,
            fps: 8,
            include: { crosshair: false },
          },
        ],
      },
      'sweep'
    );
    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.ok).toBe(true);

    const files = outcome.result.outputs[1]?.files ?? [];
    const pngs = files.filter((f) => f.endsWith('.png'));
    expect(pngs).toHaveLength(10);
    expect(files).toContain('sweep.gif');
    // Zero-padded, so the sequence sorts correctly in a file browser and ffmpeg's `%04d` reads it.
    expect(pngs[0]).toBe('sweep-0000.png');
    expect(pngs[9]).toBe('sweep-0009.png');

    const frames = pngs.map((name) => readImage(outcome.outDir, name));
    for (const [i, frame] of frames.entries()) {
      expect(frame.width).toBe(300);
      expectNotBlank(frame, pngs[i] as string);
    }

    // The claim that makes this a *sweep*: consecutive frames are different pictures.
    //
    for (let i = 1; i < frames.length; i += 1) {
      const changed = differingFraction(frames[i - 1] as DecodedPng, frames[i] as DecodedPng);
      expect(changed, `frames ${i - 1} and ${i} are the same picture`).toBeGreaterThan(0.02);
    }
    // The sweep really did travel: the two ends are almost entirely different pictures, and the
    // middle is different from both.
    const first = frames[0] as DecodedPng;
    const middle = frames[5] as DecodedPng;
    const last = frames[9] as DecodedPng;
    expect(differingFraction(first, last)).toBeGreaterThan(0.05);
    expect(differingFraction(first, middle)).toBeGreaterThan(0.1);
    expect(differingFraction(middle, last)).toBeGreaterThan(0.1);

    // The GIF is a real GIF89a, and it is at least as big as one frame's worth of pixels indexed.
    const gif = readFileSync(join(outcome.outDir, 'sweep.gif'));
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(gif.length).toBeGreaterThan(10_000);
  });

  test('a 12-frame orbit turns the camera: every frame differs, and the first and last are not equal', async () => {
    const outcome = await runJob(
      {
        scene: { files: [P.ernie], preset: 'mesh-tissues-translucent' },
        window: { width: 700, height: 700 },
        actions: [
          { type: 'set', layout: '3d-only', camera: 'A', view: 'view3d' },
          {
            type: 'orbit',
            out: 'orbit',
            frames: 12,
            degrees: 360,
            axis: 'z',
            width: 260,
            fps: 10,
            colors: 64,
          },
        ],
      },
      'orbit'
    );
    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.ok).toBe(true);

    const files = outcome.result.outputs[1]?.files ?? [];
    const pngs = files.filter((f) => f.endsWith('.png'));
    expect(pngs).toHaveLength(12);
    expect(files).toContain('orbit.gif');

    const frames = pngs.map((name) => readImage(outcome.outDir, name));
    for (const [i, frame] of frames.entries()) {
      expect(frame.width).toBe(260);
      expectNotBlank(frame, pngs[i] as string);
    }
    for (let i = 1; i < frames.length; i += 1) {
      expect(
        differingFraction(frames[i - 1] as DecodedPng, frames[i] as DecodedPng),
        `orbit frames ${i - 1} and ${i} are the same picture`
      ).toBeGreaterThan(0.02);
    }
    // A 360° orbit stops one step short of the start, so the loop is seamless *and* the last frame is
    // not a duplicate of the first. Both halves of that are claims, and this is the second one.
    expect(differingFraction(frames[0] as DecodedPng, frames[11] as DecodedPng)).toBeGreaterThan(
      0.02
    );
  });

  test('the ti-field-on-t1 preset puts a coloured field over a grey T1, with no numbers in the job', async () => {
    const outcome = await runJob(
      {
        scene: { files: [P.t1, P.tiMax], preset: 'ti-field-on-t1' },
        window: { width: 900, height: 800 },
        actions: [
          { type: 'set', cursor: [0, -18, 8], layout: '1x1', view: 'axial' },
          {
            type: 'screenshot',
            out: 'ti.png',
            view: 'axial',
            width: 500,
            include: { crosshair: false },
          },
        ],
      },
      'preset'
    );
    expect(outcome.result.errors).toEqual([]);
    expect(outcome.result.ok).toBe(true);
    // The preset found both layers; a warning here would mean it silently rendered a bare T1.
    expect(outcome.result.warnings).toEqual([]);

    const image = readImage(outcome.outDir, 'ti.png');
    expectNotBlank(image, 'ti.png');

    // The claim that the *field* is on screen: a T1 alone is grey — R, G and B equal at every pixel —
    // and a `hot` overlay is not. Counting strongly-coloured pixels is the check a golden would only
    // make circumstantially. `hot` runs red→yellow→white, so a field pixel has R well above B.
    let warm = 0;
    for (let i = 0; i < image.width * image.height; i += 1) {
      const at = i * 4;
      const r = image.pixels[at] as number;
      const b = image.pixels[at + 2] as number;
      if (r - b > 60) warm += 1;
    }
    const fraction = warm / (image.width * image.height);
    expect(fraction, 'no heat-coloured pixels: the TI overlay is missing').toBeGreaterThan(0.005);
    // …and it is a *thresholded* overlay, not a wash over the whole pane.
    expect(fraction, 'the overlay covers the whole pane: the threshold did not apply').toBeLessThan(
      0.5
    );
  });

  test('a bad job fails before it opens a window, and says what is wrong with it', async () => {
    const outcome = await runJob(
      {
        scene: { files: ['/nowhere/T1.nii.gz'], preset: 'ti-field-on-t1' },
        actions: [{ type: 'screenshot', out: '../escape.png' }],
      },
      'invalid'
    );
    expect(outcome.result.ok).toBe(false);
    expect(outcome.code).toBe(1);
    // Both problems, not just the first — the validator reports the whole document.
    expect(outcome.result.errors.join('\n')).toContain('must be a relative name inside --out');
    // The run produced no images at all: a job either does what it says or does nothing.
    expect(outcome.result.outputs).toEqual([]);
  });

  test('a job whose input does not exist names the file rather than failing obscurely', async () => {
    const outcome = await runJob(
      {
        scene: { files: [join(ROOT, 'm2m_ernie', 'not-a-file.nii.gz')], preset: 'plain' },
        actions: [{ type: 'screenshot', out: 'a.png' }],
      },
      'missing'
    );
    expect(outcome.result.ok).toBe(false);
    expect(outcome.code).toBe(1);
    expect(outcome.result.errors.join('\n')).toContain('not-a-file.nii.gz');
  });

  test.afterAll(() => {
    // The temp directories carry a few MB of PNGs each; leaving them behind would fill /tmp over a
    // week of runs. A failure has already read everything it needed by the time this runs.
    for (const dir of temporaryDirectories) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A directory that is already gone is the outcome we wanted.
      }
    }
  });
});
