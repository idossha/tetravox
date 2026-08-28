/**
 * **Directed task 8, the surface half**: a pick on `lh.central.gii` reports its own vertex *and* the
 * fsaverage vertex it corresponds to (§3).
 *
 * The chain this exercises exists nowhere else: an app setting main persists, a discovery that finds
 * `lh.sphere.reg.gii` beside the surface and `fsaverage/surf/lh.sphere` under the subjects
 * directory, three helper datasets loaded through the ordinary worker path with **no layer**, and
 * `Engine.attachFsaverage` composing `vertices` → `sphereMap` → `vertices`. The Rust half is
 * unit-tested against a brute-force reference in `crates/tvx-geom`; this is the wiring.
 *
 * **Where the expected numbers come from** — `python3`, nibabel, independent of both:
 *
 * ```py
 * cen = nib.load('m2m_ernie/surfaces/lh.central.gii').agg_data()[0]
 * reg = nib.load('m2m_ernie/surfaces/lh.sphere.reg.gii').agg_data()[0]
 * sph, _ = nib.freesurfer.read_geometry('fsaverage/surf/lh.sphere')
 * pial, _ = nib.freesurfer.read_geometry('fsaverage/surf/lh.pial')
 * sn = sph / np.linalg.norm(sph, axis=1, keepdims=True)
 * j = int(np.argmax(sn @ (reg[v] / np.linalg.norm(reg[v]))))
 * ```
 *
 * The fsaverage coordinate is in fsaverage's own **tkr-RAS**, because that is the space a FreeSurfer
 * binary surface is in and §3 loads one as-is when there is no companion volume. That is also the
 * space a FreeSurfer user expects a vertex coordinate to be quoted in, and the readout labels it
 * with the surface it came from (`fsaverage lh.pial`) rather than calling it "RAS".
 *
 * Offscreen (AGENTS rule 9 — never set `TETRAVOX_E2E_HEADED`). Skips, never fails, when
 * `TETRAVOX_TESTDATA` or the fsaverage subject is missing (AGENTS rule 2): nothing is bundled.
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';
const SURFACE = join(ROOT, 'm2m_ernie', 'surfaces', 'lh.central.gii');
const SPHERE_REG = join(ROOT, 'm2m_ernie', 'surfaces', 'lh.sphere.reg.gii');
/** The fsaverage that ships with MNE's sample data — the one on this machine (AGENTS.md). */
const SUBJECTS = '/Users/idohaber/mne_data/MNE-fsaverage-data';
const FSAVG_SPHERE = join(SUBJECTS, 'fsaverage', 'surf', 'lh.sphere');
const OUT = resolve(APP_ROOT, '..', '..', 'docs', 'screenshots', 'directed-2026-08-28');

/** `[subject vertex, its world mm on lh.central, fsaverage vertex, its mm on fsaverage lh.pial]`. */
const LANDMARKS: [number, [number, number, number], number, [number, number, number]][] = [
  [0, [-28.724436, 22.045265, -26.645943], 40188, [-42.985291, -10.803907, -44.410835]],
  [1000, [3.532048, 42.056614, 21.968828], 152958, [0.56187, 15.409825, 1.983711]],
  [100000, [-40.377102, 63.203453, 10.107379], 68099, [-43.996834, 31.48292, -8.504801]],
  [245761, [-21.677401, 95.890091, 23.733513], 48810, [-21.112469, 64.88681, -2.845896]],
];

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

let app: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, workerInfo) => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.skip(!existsSync(SURFACE), `${SURFACE} is missing`);
  test.skip(!existsSync(SPHERE_REG), `${SPHERE_REG} is missing`);
  test.skip(!existsSync(FSAVG_SPHERE), `no fsaverage at ${SUBJECTS} — nothing is bundled`);
  const target = workerInfo.project.name as LaunchTarget;
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');

  app = await launchApp(target, { search: 'engine=real' });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 700);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
});

/**
 * The probe row for the surface layer at a world point.
 *
 * `setCursor` rather than `probe`: a mesh probe is a worker round trip, so `refreshProbe` is issued
 * by the cursor move and `probe` only reads back what last landed (§4.7 says so in as many words).
 * The point is nudged first because setting the cursor where it already is is a no-op.
 */
async function probeRow(world: [number, number, number]): Promise<{
  vertex?: number;
  vertexWorld?: number[];
  fsavgVertex?: number;
  fsavgWorld?: number[];
  fsavgSpace?: string;
} | null> {
  return page.evaluate(async (w) => {
    const engine = window.__tetravox?.engine;
    if (engine == null) return null;
    engine.setCursor([w[0] + 1, w[1], w[2]] as [number, number, number]);
    engine.setCursor(w as [number, number, number]);
    for (let i = 0; i < 50; i += 1) {
      await engine.whenSettled();
      await new Promise((r) => setTimeout(r, 40));
      const row = engine.probe(w as [number, number, number]).rows.find((r) => r.kind === 'mesh');
      if (row?.vertex !== undefined) return row as never;
    }
    return (engine.probe(w as [number, number, number]).rows.find((r) => r.kind === 'mesh') ??
      null) as never;
  }, world);
}

test('the settings dialog carries the FreeSurfer subjects directory, and it persists', async () => {
  await page.click('[data-testid="settings-button"]');
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible();

  const field = page.locator('[data-testid="settings-fs-subjects"]');
  await expect(field).toHaveValue('');
  await field.click();
  await field.fill(SUBJECTS);
  await field.press('Enter');
  await page.click('[data-testid="settings-close"]');

  // It went to `settings.json`, not just to the store — that is what makes it a preference.
  const persisted = await page.evaluate(async () => await window.tetravox?.settings());
  expect(persisted?.freesurferSubjectsDir).toBe(SUBJECTS);
  // …and setting a second key must not have reset the first (`coercePatch`).
  expect(persisted?.theme).toBe('system');
});

test('opening lh.central.gii loads the two spheres and the fsaverage surface, with no layer', async () => {
  await app.evaluate(
    async ({ dialog }, list) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: list,
      })) as typeof dialog.showOpenDialog;
    },
    [SURFACE]
  );
  await page.click('[data-testid="open-button"]');
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
    undefined,
    { timeout: 600_000 }
  );
  // `lh.sphere.reg.gii`, `fsaverage/surf/lh.sphere` and `fsaverage/surf/lh.pial` — the last two are
  // extensionless FreeSurfer binaries, which the reader sniffs by magic (§6.2).
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().datasets.length ?? 0) >= 4,
    undefined,
    { timeout: 600_000 }
  );
  // None of the three is on screen: a sphere is plumbing, exactly like a `toMNI/` warp.
  expect(await page.evaluate(() => window.__tetravox?.store.getState().layers.length ?? 0)).toBe(1);
});

for (const [vertex, world, fsavgVertex, fsavgWorld] of LANDMARKS) {
  test(`vertex ${vertex} maps to fsaverage vertex ${fsavgVertex}, as nibabel says`, async () => {
    // The correspondence is three worker round trips behind the open; wait for the first row that
    // carries one rather than for a fixed delay.
    await expect
      .poll(async () => (await probeRow([-28.724436, 22.045265, -26.645943]))?.fsavgVertex, {
        timeout: 600_000,
      })
      .toBeDefined();

    const row = await probeRow(world);
    expect(row).not.toBeNull();
    // The vertex index is the file's own node numbering — the probe point IS that node, so the
    // nearest one to it is itself.
    expect(row?.vertex).toBe(vertex);
    for (let i = 0; i < 3; i += 1) {
      expect(row?.vertexWorld?.[i]).toBeCloseTo(world[i] as number, 3);
    }
    // The whole chain: sphere.reg -> unit sphere -> nearest fsaverage vertex.
    expect(row?.fsavgVertex).toBe(fsavgVertex);
    for (let i = 0; i < 3; i += 1) {
      expect(row?.fsavgWorld?.[i]).toBeCloseTo(fsavgWorld[i] as number, 3);
    }
    // Labelled with the surface it is on, not called "RAS": it is fsaverage's own tkr-RAS.
    expect(row?.fsavgSpace).toBe('fsaverage lh.pial');
  });
}

test('the info panel shows the vertex and the fsaverage row, each labelled', async () => {
  const [, world] = LANDMARKS[0] as [number, [number, number, number], number, number[]];
  await page.evaluate((w) => window.__tetravox?.engine?.setCursor([w[0] + 1, w[1], w[2]]), world);
  await page.evaluate((w) => window.__tetravox?.engine?.setCursor(w), world);
  // Formatted, not raw f32: §8's copy format is one decimal (`lib/coords.ts`).
  await expect(page.locator('[data-testid="probe-vertex"]')).toContainText('0 · RAS -28.7 22.0');
  await expect(page.locator('[data-testid="probe-fsavg"]')).toContainText('vertex 40188');
  await expect(page.locator('[data-testid="info-cursor"]')).toContainText('fsaverage lh.pial');
});

test('clearing the setting drops the fsaverage row and leaves the vertex one', async () => {
  await page.evaluate(async () => {
    await window.__tetravox?.controller?.setFreesurferSubjectsDir('');
  });
  const [, world] = LANDMARKS[0] as [number, [number, number, number], number, number[]];
  const row = await probeRow(world);
  // The subject's own vertex is not an fsaverage question and must survive.
  expect(row?.vertex).toBe(0);
  expect(row?.fsavgVertex).toBeUndefined();
});

test('the fsaverage screenshot', async () => {
  test.skip(process.env['TETRAVOX_SHOTS'] !== '1', 'set TETRAVOX_SHOTS=1 to capture');
  mkdirSync(OUT, { recursive: true });
  // The previous test cleared the setting; put it back so the picture shows the feature.
  await page.evaluate(async (dir) => {
    await window.__tetravox?.controller?.setFreesurferSubjectsDir(dir);
  }, SUBJECTS);
  const [, world] = LANDMARKS[0] as [number, [number, number, number], number, number[]];
  await expect
    .poll(async () => (await probeRow(world))?.fsavgVertex, { timeout: 600_000 })
    .toBeDefined();
  await page.evaluate(async () => {
    const engine = window.__tetravox?.engine;
    if (engine == null) return;
    await engine.whenSettled();
    engine.renderNow();
    await engine.whenSettled();
  });
  const file = join(OUT, 'coordinates-fsaverage.png');
  await page.screenshot({ path: file });
  // A number, not a look (AGENTS rule 1), against the same budget the other directed screenshots use.
  const bytes = statSync(file).size;
  expect(bytes).toBeGreaterThan(1024);
  expect(bytes).toBeLessThanOrEqual(400_000);
});
