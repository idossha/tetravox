/**
 * Three engine captures — the T1 isosurface, one surface per tissue, and the `1+3` layout — written
 * to the shared evidence directory `packages/app/test-results/shots/` (`SHOTS_DIR`, git-ignored).
 * The committed documentation set is `docs/screenshots/2026-08-29/`; these are not part of it.
 *
 * Captured from the **real** app over the real reference dataset, offscreen (AGENTS rule 9 — the
 * window is built and never shown, and this spec must never set `TETRAVOX_E2E_HEADED`). Opt-in
 * behind `TETRAVOX_SHOTS=1` for the same reason `catalogue.spec.ts` is: it opens 256 × 256 × 208
 * volumes and runs marching cubes over them, which is minutes rather than seconds.
 *
 * ```
 * TETRAVOX_TESTDATA=/…/sub-ernie TETRAVOX_SHOTS=1 pnpm exec playwright test --project=dev iso3d-screenshots
 * ```
 *
 * These are documentation, not verification: the assertions here are only that a real, non-trivial,
 * in-budget PNG landed. What the pixels *mean* is asserted analytically in `packages/engine`'s
 * `volume-iso3d.spec.ts` and `volume-iso3d-realdata.spec.ts` (§11 rule 0).
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { SHOTS_DIR, clickAppMenu, launchApp } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';

const ENABLED = process.env['TETRAVOX_SHOTS'] === '1';
const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';

const OUT = SHOTS_DIR;

/**
 * The window every capture is taken at, and the per-PNG budget the brief set.
 *
 * 1100 × 700 rather than 1440: the whole-window  capture is three anatomical panes plus a
 * shaded surface, which is close to incompressible, and at 1280 × 800 it came to 439 kB — over.
 * A slightly smaller picture is a better answer than a missing one.
 */
const WINDOW = { width: 1100, height: 700 };
const MAX_BYTES = 400_000;

const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const TISSUES = join(ROOT, 'm2m_ernie', 'final_tissues.nii.gz');

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

let app: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, workerInfo) => {
  test.skip(!ENABLED, 'set TETRAVOX_SHOTS=1 to capture these screenshots');
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  mkdirSync(OUT, { recursive: true });
  const target = workerInfo.project.name as LaunchTarget;
  app = await launchApp(target, { search: 'engine=real' });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, WINDOW);
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
});

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

async function openFile(path: string): Promise<void> {
  expect(existsSync(path), `${path} is missing from TETRAVOX_TESTDATA`).toBe(true);
  const before = await page.evaluate(() => window.__tetravox?.store.getState().layers.length ?? 0);
  await app.evaluate(
    async ({ dialog }, list) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: list,
      })) as typeof dialog.showOpenDialog;
    },
    [path]
  );
  await clickAppMenu(page, 'open');
  await page.waitForFunction(
    (want: number) => (window.__tetravox?.store.getState().layers.length ?? 0) >= want,
    before + 1,
    { timeout: 600_000 }
  );
  await settle();
}

async function newScene(): Promise<void> {
  await page.evaluate(() => window.__tetravox?.controller?.newScene());
  await settle();
}

async function volumeLayerId(): Promise<string> {
  return page.evaluate(() => {
    const layer = (window.__tetravox?.store.getState().layers ?? []).find(
      (l) => l.kind === 'volume'
    );
    if (layer === undefined) throw new Error('no volume layer');
    return layer.id;
  });
}

/** A written PNG is real, in budget, and **not blank** — a number, not a look (AGENTS rule 1). */
function verify(file: string): void {
  const path = join(OUT, file);
  const bytes = statSync(path).size;
  expect(bytes, `${file} is empty`).toBeGreaterThan(1024);
  expect(
    bytes,
    `${file} is ${(bytes / 1000).toFixed(0)} kB, over the ${MAX_BYTES / 1000} kB budget`
  ).toBeLessThanOrEqual(MAX_BYTES);
  const png = decodePng(readFileSync(path));
  const colours = new Set<number>();
  let total = 0;
  let top = 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < png.pixels.length; i += 4) {
    const key =
      ((png.pixels[i] ?? 0) << 16) | ((png.pixels[i + 1] ?? 0) << 8) | (png.pixels[i + 2] ?? 0);
    colours.add(key);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > top) top = n;
    total += 1;
  }
  expect(colours.size, `${file} has ${colours.size} distinct colours — blank`).toBeGreaterThan(64);
  expect(top / total, `${file} is mostly one colour — blank`).toBeLessThan(0.98);
}

async function shootPane(viewId: string, file: string): Promise<void> {
  const box = await page.locator(`[data-testid="view-cell-${viewId}"]`).boundingBox();
  if (box === null) throw new Error(`no pane ${viewId}`);
  await page.screenshot({ path: join(OUT, file), scale: 'css', clip: box });
  verify(file);
}

async function shootWindow(file: string): Promise<void> {
  await page.screenshot({ path: join(OUT, file), scale: 'css' });
  verify(file);
}

test('iso-t1-3d.png — the T1 3D surface at its default level', async () => {
  await openFile(T1);
  const id = await volumeLayerId();
  await page.click(`[data-testid="volume-iso3d-toggle-${id}"]`);
  await page.click('[data-testid="layout-3d-only"]');
  await settle();
  await page.waitForFunction(
    (layerId: string) => {
      const s = window.__tetravox?.store.getState().iso3dPending[layerId];
      return s !== undefined && s.pending === 0;
    },
    id,
    { timeout: 600_000 }
  );
  await settle();
  await shootPane('view3d', 'iso-t1-3d.png');
});

test('iso-labels-3d.png — one surface per tissue of final_tissues', async () => {
  await newScene();
  await openFile(TISSUES);
  const id = await volumeLayerId();
  await page.click(`[data-testid="volume-iso3d-toggle-${id}"]`);
  // Hide the outer tissues. Every region gets a surface, so with skin and bone on, the picture is
  // the scalp and nothing else — the nesting only reads once the outer shells are off. SimNIBS
  // tissue numbering `[DATA]`: 2 grey matter, 7 compact bone, 9 blood.
  await page.evaluate((layerId: string) => {
    window.__tetravox?.engine?.updateLayer(layerId, {
      visibleLabels: Uint32Array.from([2, 7, 9]),
    });
  }, id);
  await page.click('[data-testid="layout-3d-only"]');
  await settle();
  await page.waitForFunction(
    (layerId: string) => {
      const s = window.__tetravox?.store.getState().iso3dPending[layerId];
      return s !== undefined && s.total === 3 && s.pending === 0;
    },
    id,
    { timeout: 900_000 }
  );
  await settle();
  await shootPane('view3d', 'iso-labels-3d.png');
});

test('layout-1plus3.png — the 3D pane is in every layout', async () => {
  await newScene();
  await openFile(T1);
  const id = await volumeLayerId();
  await page.click(`[data-testid="volume-iso3d-toggle-${id}"]`);
  await page.click('[data-testid="layout-1+3"]');
  await settle();
  await page.waitForFunction(
    (layerId: string) => {
      const s = window.__tetravox?.store.getState().iso3dPending[layerId];
      return s !== undefined && s.pending === 0;
    },
    id,
    { timeout: 600_000 }
  );
  await settle();
  await shootWindow('layout-1plus3.png');
});
