/**
 * The two screenshots directed task 7 owes (`docs/screenshots/directed-2026-08-28/`), and the app's
 * own coverage of the new glyph controls.
 *
 * Captured from the **real** app over `ernie_TDCS_1_scalar.msh` — the only reference file carrying a
 * vector field — offscreen (AGENTS rule 9: the window is built and never shown, and this spec must
 * never set `TETRAVOX_E2E_HEADED`). Opt-in behind `TETRAVOX_SHOTS=1`, like `iso3d-screenshots`: the
 * mesh is 420 MB.
 *
 * ```
 * TETRAVOX_TESTDATA=/…/sub-ernie TETRAVOX_SHOTS=1 pnpm exec playwright test --project=dev glyph-screenshots
 * ```
 *
 * Everything is driven through the **panel's own controls**, not through `updateLayer`, so the run
 * also asserts that §8's "everything the UI can do must be reachable from the `Engine` API alone"
 * holds for the scaling knobs: the select changes the mode, and the mode changes the picture. What
 * the pixels *mean* is asserted analytically in `packages/engine`'s `glyphs.spec.ts` and
 * `glyphs-real.spec.ts` (§11 rule 0); these are documentation.
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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

const MESH = join(
  ROOT,
  'Simulations',
  'L_Insula',
  'high_Frequency',
  'mesh',
  'ernie_TDCS_1_scalar.msh'
);

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_200_000);

let app: ElectronApplication;
let page: Page;
let layerId = '';

test.beforeAll(async ({}, workerInfo) => {
  // A hook has its own timeout, and this one loads a 420 MB mesh.
  test.setTimeout(1_200_000);
  test.skip(!ENABLED, 'set TETRAVOX_SHOTS=1 to capture the directed-2026-08-28 screenshots');
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  mkdirSync(OUT, { recursive: true });
  app = await launchApp(workerInfo.project.name as LaunchTarget, { search: 'engine=real' });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, WINDOW);
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });

  expect(existsSync(MESH), `${MESH} is missing from TETRAVOX_TESTDATA`).toBe(true);
  await app.evaluate(
    async ({ dialog }, list) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: list,
      })) as typeof dialog.showOpenDialog;
    },
    [MESH]
  );
  await page.click('[data-testid="open-button"]');
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().layers ?? []).some((l) => l.kind === 'mesh'),
    undefined,
    { timeout: 900_000 }
  );
  layerId = await page.evaluate(() => {
    const l = (window.__tetravox?.store.getState().layers ?? []).find((x) => x.kind === 'mesh');
    if (l === undefined) throw new Error('no mesh layer');
    return l.id;
  });
  await settle();
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

/**
 * Frame the head and wait for the arrows to actually be on screen.
 *
 * `meshCentroids` over 1.34 M grey-matter tets is requested by the **first draw**, not by the load,
 * so `whenSettled` returns before the origins exist. Waiting on ink rather than on a duration is
 * what keeps this from photographing an empty pane, which is exactly what it did first.
 */
async function fitAndWait(): Promise<void> {
  await page.evaluate(() => window.__tetravox?.engine?.resetView('view3d'));
  await settle();
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2');
      if (canvas == null || gl == null) return false;
      window.__tetravox?.engine?.renderNow();
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // Only the left 80 % of the pane: the colour bar lives in the right-hand gutter and is
      // hundreds of lit pixels on its own, so counting it would let a pane with **no arrows** pass —
      // which is exactly what it did, twice.
      let lit = 0;
      const limit = Math.floor(canvas.width * 0.8);
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < limit; x += 1) {
          const i = (y * canvas.width + x) * 4;
          // Above the (10, 13, 18) background, not "bright": under **linear** the cortex sits at
          // the bottom of the ramp, so its arrows are dark by construction — a brightness threshold
          // waits forever for a picture that is already correct.
          if ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) > 55) lit += 1;
        }
      }
      // The chrome alone is a few hundred pixels; a pane of arrows is over a thousand. Grey-matter
      // |E| is around 0.1–0.5 V/m against a 3.85 p99, so at the 6 mm linear default each arrow is
      // well under a millimetre on a 200 mm head — which is what the log picture beside it is for.
      return lit > 1_200;
    },
    undefined,
    { timeout: 300_000 }
  );
  await settle();
}

/** A written PNG is real, in budget, and not blank — a number, not a look (AGENTS rule 1). */
function verify(file: string): void {
  const bytes = statSync(join(OUT, file)).size;
  expect(bytes, `${file} is empty`).toBeGreaterThan(1024);
  expect(bytes, `${file} is over the ${MAX_BYTES / 1000} kB budget`).toBeLessThanOrEqual(MAX_BYTES);
  const png = decodePng(readFileSync(join(OUT, file)));
  const counts = new Map<number, number>();
  let total = 0;
  let top = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    const key =
      ((png.pixels[i] ?? 0) << 16) | ((png.pixels[i + 1] ?? 0) << 8) | (png.pixels[i + 2] ?? 0);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > top) top = n;
    total += 1;
  }
  expect(counts.size, `${file} has ${counts.size} distinct colours — blank`).toBeGreaterThan(64);
  expect(top / total, `${file} is mostly one colour — blank`).toBeLessThan(0.98);
}

async function shootPane(file: string): Promise<void> {
  const box = await page.locator('[data-testid="view-cell-view3d"]').boundingBox();
  if (box === null) throw new Error('no 3D pane');
  await page.screenshot({ path: join(OUT, file), scale: 'css', clip: box });
  verify(file);
}

/** The current `GlyphSpec`, straight off the store, so an assertion is about state and not a look. */
async function glyphs(): Promise<Record<string, unknown>> {
  return page.evaluate((id: string) => {
    const l = (window.__tetravox?.store.getState().layers ?? []).find((x) => x.id === id);
    return JSON.parse(JSON.stringify((l as { glyphs?: unknown }).glyphs ?? {})) as Record<
      string,
      unknown
    >;
  }, layerId);
}

test('glyphs-linear.png — linear, and what normalising it takes on real data', async () => {
  await page.click('[data-testid="layout-3d-only"]');
  // Only grey matter, so the arrows are not inside a scalp the eye cannot see through. Tag 2 is
  // grey matter in every SimNIBS head mesh (AGENTS.md's tag census).
  await page.evaluate((id: string) => {
    const engine = window.__tetravox?.engine;
    const ds = window.__tetravox?.store.getState().datasets;
    const tags = (ds ?? []).flatMap((d) => ('tags' in d ? d.tags : []));
    engine?.updateLayer(id, {
      tagStyle: Object.fromEntries(tags.map((t) => [t.id, { visible: t.id === 2, opacity: 1 }])),
    });
  }, layerId);
  await settle();

  await page.click(`[data-testid="mesh-glyphs-enabled-${layerId}"]`);
  await settle();
  // The defaults directed task 7 names, asserted as state before anything is photographed.
  const spec = await glyphs();
  expect(spec['scale']).toMatchObject({ mode: 'linear', normalizeTo: 'p99', lengthMm: 6 });

  // The editor's sections open collapsed (directed task 1); the controls only exist once expanded.
  await page.click(`[data-testid="mesh-glyphs-${layerId}-toggle"]`);
  await page.selectOption(`[data-testid="mesh-glyph-origins-${layerId}"]`, 'volume');
  await page.selectOption(`[data-testid="mesh-glyph-stridemode-${layerId}"]`, 'maxCount');
  await page.fill(`[data-testid="mesh-glyph-stride-${layerId}"]`, '12000');
  await page.press(`[data-testid="mesh-glyph-stride-${layerId}"]`, 'Enter');
  // Normalised to **0.3 V/m** rather than to the p99 default, and this is the finding the pair of
  // figures is here to show. Grey-matter |E| on this mesh is around 0.15 V/m against a p99 of 3.85,
  // so linear-against-p99 draws a 0.2 mm arrow whose shaft is a tenth of a pixel wide: the cortex
  // renders **empty**, at any length setting, because the width scales with the length. Linear is
  // legible only once the reference is brought down to the data's own range — which is what
  // `normalizeTo: <number>` is for — and `log` is what makes the whole range legible at once.
  await page.selectOption(`[data-testid="mesh-glyph-normalize-${layerId}"]`, 'value');
  await page.fill(`[data-testid="mesh-glyph-normalize-value-${layerId}"]`, '0.3');
  await page.press(`[data-testid="mesh-glyph-normalize-value-${layerId}"]`, 'Enter');
  await settle();
  await fitAndWait();
  await shootPane('glyphs-linear.png');
});

test('glyphs-log.png — the same field on a log10 length scale', async () => {
  // Back to p99: `log` spans the whole field without a hand-picked reference, which is the point.
  await page.selectOption(`[data-testid="mesh-glyph-normalize-${layerId}"]`, 'p99');
  await page.selectOption(`[data-testid="mesh-glyph-scale-${layerId}"]`, 'log');
  await settle();
  expect((await glyphs())['scale']).toMatchObject({ mode: 'log' });
  await fitAndWait();
  await shootPane('glyphs-log.png');
});
