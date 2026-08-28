/**
 * The screenshot directed task 12 owes: `docs/screenshots/directed-2026-08-28/surface-contours-2x2.png`.
 *
 * The maintainer's reference is a Freeview window — `T1.nii.gz` under the pial surface, the
 * surface's intersection with each plane drawn as a thin yellow outline on the axial, sagittal and
 * coronal panes, and the surface itself in 3D. This reproduces that arrangement from the **real**
 * app over the reference dataset, offscreen (AGENTS rule 9 — the window is built and never shown,
 * and this spec must never set `TETRAVOX_E2E_HEADED`).
 *
 * ```
 * TETRAVOX_TESTDATA=/…/sub-ernie TETRAVOX_SHOTS=1 \
 *   pnpm exec playwright test --project=dev surface-contours-screenshot
 * ```
 *
 * Opt-in behind `TETRAVOX_SHOTS=1`, like `iso3d-screenshots.spec.ts`: it opens a 256×256×208 volume
 * and a 245,762-vertex surface. And like that file, this is **documentation, not verification** —
 * the assertion here is only that a real, non-trivial, in-budget PNG landed. What the pixels mean
 * is asserted analytically in `packages/engine`'s `surface-contours.spec.ts`, and the geometry
 * behind them against numpy in `crates/tvx-geom/tests/real_data.rs` (§11 rule 0).
 */

/* eslint-disable no-empty-pattern */

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';

const ENABLED = process.env['TETRAVOX_SHOTS'] === '1';
const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';

const OUT = resolve(APP_ROOT, '..', '..', 'docs', 'screenshots', 'directed-2026-08-28');
const WINDOW = { width: 1100, height: 700 };
const MAX_BYTES = 400_000;

const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const PIAL = join(ROOT, 'm2m_ernie', 'surfaces', 'lh.pial.gii');

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

let app: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, workerInfo) => {
  test.skip(!ENABLED, 'set TETRAVOX_SHOTS=1 to capture the directed-2026-08-28 screenshots');
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
  await page.click('[data-testid="open-button"]');
  await page.waitForFunction(
    (want: number) => (window.__tetravox?.store.getState().layers.length ?? 0) >= want,
    before + 1,
    { timeout: 600_000 }
  );
  await settle();
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
  const counts = new Map<number, number>();
  let total = 0;
  let top = 0;
  /** The contour's palette yellow, ±24 per channel — JPEG-free PNG, so this is only compression-free rounding. */
  let yellow = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    const r = png.pixels[i] ?? 0;
    const g = png.pixels[i + 1] ?? 0;
    const b = png.pixels[i + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > top) top = n;
    total += 1;
    if (r > 200 && g > 180 && b < 110) yellow += 1;
  }
  expect(counts.size, `${file} has ${counts.size} distinct colours — blank`).toBeGreaterThan(64);
  expect(top / total, `${file} is mostly one colour — blank`).toBeLessThan(0.98);
  // The one thing this picture exists to show: there is a yellow outline in it. Without this the
  // spec would happily publish a T1 with the surface silently missing.
  expect(yellow, `${file} has no contour-coloured pixels`).toBeGreaterThan(200);
}

test('surface-contours-2x2.png — T1 + lh.pial.gii, the Freeview arrangement', async () => {
  await openFile(T1);
  await openFile(PIAL);

  // A cursor inside the left hemisphere, so all three panes cut the pial surface rather than
  // clipping past it. `lh.pial.gii`'s bbox is (−65.5, −80.8, −30.1) … (3.6, 101.5, 82.2) (AGENTS.md).
  await page.evaluate(() => {
    window.__tetravox?.engine?.setCursor([-30, 10, 26]);
  });
  await page.click('[data-testid="layout-2x2"]');
  await settle();

  await page.screenshot({ path: join(OUT, 'surface-contours-2x2.png'), scale: 'css' });
  verify('surface-contours-2x2.png');
});
