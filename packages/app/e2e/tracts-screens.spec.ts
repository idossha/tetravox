/**
 * Offscreen real-app captures of tractograms, opt-in behind `TETRAVOX_TRACT_SCREENS=<dir>` because the
 * data is gigabytes. `TETRAVOX_TRACT_DATA` is the `tract_network_dev` root, read-only. What the pixels
 * mean is asserted in `packages/engine/test/e2e/tracts.spec.ts`; here the numbers are the timings, and
 * the panels are the point of the picture.
 */

/* eslint-disable no-empty-pattern */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { clickAppMenu, launchApp } from './fixtures';
import type { LaunchTarget } from './fixtures';

const OUT = process.env['TETRAVOX_TRACT_SCREENS'] ?? '';
const ROOT = process.env['TETRAVOX_TRACT_DATA'] ?? '';
const WINDOW = { width: 1500, height: 950 };
const MR = join(ROOT, 'validation/mrtrix_ref');
const CHN = join(ROOT, 'project/derivatives/SimNIBS/sub-CHN');

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_800_000);
test.skip(OUT === '' || ROOT === '', 'set TETRAVOX_TRACT_SCREENS and TETRAVOX_TRACT_DATA');

let app: ElectronApplication;
let page: Page;
const timings: Record<string, number> = {};

async function launch(target: LaunchTarget): Promise<void> {
  app = await launchApp(target, { search: 'engine=real' });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, WINDOW);
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(async () => {
      const engine = window.__tetravox?.engine;
      if (engine == null) return;
      await engine.whenSettled();
      engine.renderNow();
      await engine.whenSettled();
    });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    );
  }
}

async function open(files: string[], count: number): Promise<number> {
  const started = Date.now();
  await app.evaluate(async ({ dialog }, list) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: list,
    })) as typeof dialog.showOpenDialog;
  }, files);
  await clickAppMenu(page, 'open');
  await page.waitForFunction(
    (n) => (window.__tetravox?.store.getState().layers ?? []).length >= n,
    count,
    { timeout: 1_200_000 }
  );
  await settle();
  return Date.now() - started;
}

async function shot(name: string): Promise<void> {
  await settle();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), await page.screenshot());
}

/** Select a layer's row so its editor is the one on screen. */
async function select(kind: string): Promise<string> {
  const id = await page.evaluate((k) => {
    const state = window.__tetravox?.store.getState();
    const layer = state?.layers.find((l) => l.kind === k);
    if (layer === undefined) throw new Error(`no ${k} layer`);
    window.__tetravox?.engine?.setActiveLayer(layer.id);
    return layer.id;
  }, kind);
  await settle();
  return id;
}

/** Nearest tract under a coarse grid of the 3D pane, as a real click would find it. */
async function pickSomething(): Promise<boolean> {
  return page.evaluate(() => {
    const engine = window.__tetravox?.engine;
    const canvas = document.querySelector('canvas');
    if (engine == null || canvas == null) return false;
    const r = canvas.getBoundingClientRect();
    for (let radius = 0; radius < 300; radius += 12) {
      for (let a = 0; a < 12; a += 1) {
        const x = r.width / 2 + radius * Math.cos((a * Math.PI) / 6);
        const y = r.height / 2 + radius * Math.sin((a * Math.PI) / 6);
        const hit = engine.pick('view3d', x, y);
        if (hit?.elementKind === 'streamline' && engine.setCursorFromPick('view3d', x, y))
          return true;
      }
    }
    return false;
  });
}

test('MRtrix TCK with FA: direction, then sampled FA, with the budget labelled', async ({}, info) => {
  await launch(info.project.name as LaunchTarget);
  timings['tck+fa open ms'] = await open(
    [join(MR, 'fa.nii.gz'), join(MR, 'tracks_ifod2_200k.tck')],
    2
  );
  const tract = await select('tracts');
  await page.evaluate(() => {
    const engine = window.__tetravox?.engine;
    engine?.resetView('view3d');
  });
  await settle();
  const displayed = await page.locator('[data-testid^="tracts-displayed-"]').first().textContent();
  expect(displayed).toContain('displaying');
  expect(displayed).toContain('of 200,000');
  await shot('1_mrtrix_tck_fa_direction.png');
  await page
    .locator('[data-testid^="tracts-displayed-"]')
    .first()
    .screenshot({
      path: join(OUT, '5_displaying_N_of_M.png'),
    });

  const started = Date.now();
  await page.getByTestId(`tracts-sample-${tract}`).locator('button, summary').first().click();
  await page.getByTestId(`tracts-sample-run-${tract}`).click();
  await page.waitForFunction(
    (id) =>
      window.__tetravox?.store.getState().layers.find((l) => l.id === id && 'field' in l)?.[
        'field' as never
      ] === 'fa:vol0:value',
    tract,
    { timeout: 1_200_000 }
  );
  timings['sample fa ms'] = Date.now() - started;
  await shot('2_mrtrix_tck_sampled_fa.png');
  writeFileSync(join(OUT, 'timings-mrtrix.json'), JSON.stringify(timings, null, 1));
  await app.close();
});

test('throughput against §9', async ({}, info) => {
  await launch(info.project.name as LaunchTarget);
  await open([join(MR, 'fa.nii.gz'), join(MR, 'tracks_ifod2_200k.tck')], 2);
  const measured = await page.evaluate(async () => {
    const engine = window.__tetravox!.engine!;
    const canvas = document.querySelector('canvas')!;
    const gl = canvas.getContext('webgl2')!;
    const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
    const orbit = async (): Promise<number> => {
      const cam = engine.scene.view3d.camera;
      const frames: number[] = [];
      const px = new Uint8Array(4);
      for (let i = 0; i < 40; i += 1) {
        const a = (i / 40) * Math.PI;
        engine.setView('view3d', {
          camera: { ...cam, rotation: [0, Math.sin(a / 2), 0, Math.cos(a / 2)] },
        });
        const t = performance.now();
        engine.renderNow();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        frames.push(performance.now() - t);
      }
      engine.setView('view3d', { camera: cam });
      return median(frames);
    };
    const tract = [...engine.scene.datasets.values()].find((d) => d.kind === 'tractogram');
    const fa = [...engine.scene.datasets.values()].find((d) => d.kind === 'volume');
    if (tract?.kind !== 'tractogram' || fa === undefined) throw new Error('not loaded');
    const out: Record<string, number> = {
      'default points': tract.nPoints,
      'default orbit ms (2x2, all panes)': await orbit(),
    };
    let t = performance.now();
    await engine.sampleTracts({ tractogramId: tract.id, sourceId: fa.id, op: 'value' });
    out['sample FA default ms'] = performance.now() - t;
    const layerId = engine.scene.layers.find((l) => l.kind === 'tracts')!.id;
    engine.updateLayer(layerId, {
      colorMode: 'vertex',
      field: 'fa:vol0:value',
      scale: { kind: 'linear', lo: 0, hi: 1 },
    } as never);
    await engine.whenSettled();
    out['scalar orbit ms (2x2, all panes)'] = await orbit();
    engine.updateLayer(layerId, {
      threshold: { lo: 0.3, hi: Infinity, symmetric: false, mode: 'hide', softEdge: 0 },
    } as never);
    await engine.whenSettled();
    out['thresholded orbit ms (2x2, all panes)'] = await orbit();
    engine.updateLayer(layerId, { colorMode: 'direction' } as never);
    await engine.whenSettled();
    t = performance.now();
    await engine.setTractBudget(tract.id, null);
    await engine.whenSettled();
    out['load full + replay ms'] = performance.now() - t;
    out['full points'] = tract.nPoints;
    out['full streamlines'] = tract.nStreamlines;
    out['full orbit ms (2x2, all panes)'] = await orbit();
    out['worker heap MB'] = (engine.heapBytes(tract.id) ?? 0) / 1048576;
    return out;
  });
  writeFileSync(join(OUT, 'timings-perf.json'), JSON.stringify(measured, null, 1));
  await app.close();
});

test('TI scenario: TRX coloured by a dpv over T1 and a mesh, and the probe panel', async ({}, info) => {
  await launch(info.project.name as LaunchTarget);
  const sim = join(CHN, 'Simulations/thalamus');
  timings['chn open ms'] = await open(
    [
      join(CHN, 'm2m_CHN/T1.nii.gz'),
      join(sim, 'TI/mesh/thalamus_TI.msh'),
      join(sim, 'tract/thalamocortical_lh.trx'),
    ],
    3
  );
  const tract = await select('tracts');
  // The grey-matter shell only, so the tracts inside it can be seen, and no fill over the T1.
  await page.evaluate(() => {
    const engine = window.__tetravox?.engine;
    const state = window.__tetravox?.store.getState();
    const mesh = state?.layers.find((l) => l.kind === 'mesh');
    const ds = state?.datasets.find((d) => d.id === mesh?.datasetId);
    if (mesh === undefined || ds?.kind !== 'mesh') return;
    const tagStyle: Record<number, { visible: boolean; opacity: number }> = {};
    for (const t of ds.tags) tagStyle[t.id] = { visible: t.id === 1002 || t.id === 2, opacity: 1 };
    engine?.updateLayer(mesh.id, { opacity: 0.1, tagStyle, fillIn2D: false } as never);
  });
  await page.getByTestId(`tracts-mode-${tract}`).selectOption('vertex');
  await page.getByTestId(`tracts-field-${tract}`).selectOption('ti_along');
  await page.getByTestId(`tracts-width-${tract}`).fill('2');
  await page.getByTestId(`tracts-slab-${tract}`).fill('3');
  await settle();
  expect(await pickSomething()).toBe(true);
  await settle();
  await shot('3_chn_trx_ti_along_t1_mesh.png');
  const row = page.getByTestId('probe-streamline').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await shot('4_probe_panel.png');
  writeFileSync(join(OUT, 'timings-chn.json'), JSON.stringify(timings, null, 1));
  await app.close();
});
