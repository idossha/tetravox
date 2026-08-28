/**
 * **The visualisation-scenario catalogue** — a screenshot tour of what Tetravox can draw, for a
 * user-facing report rather than for a gate.
 *
 * It is a Playwright-Electron spec and not a script that drives the app by hand, for the same reason
 * `walkthrough.spec.ts` is: a catalogue of the *product* has to be produced by the product. Every
 * picture below is the real Electron window, at 1440×900, running the real WebGL2 engine over the
 * real reference dataset (`TETRAVOX_TESTDATA`), captured **offscreen** (AGENTS rule 9 — the window
 * is built and never shown, and this spec must never set `TETRAVOX_E2E_HEADED`).
 *
 * **Opt-in.** `TETRAVOX_CATALOGUE=1` only, so `pnpm e2e` does not spend twenty minutes and forty
 * megabytes on it. Run it with:
 *
 * ```
 * TETRAVOX_TESTDATA=/…/sub-ernie TETRAVOX_CATALOGUE=1 \
 *   pnpm --filter @tetravox/app exec playwright test catalogue --project=dev
 * ```
 *
 * **Where the scene comes from.** Where a scenario is reachable through the shipped UI it is driven
 * through the shipped UI — the Open… dialog (so §6.5.1's sidecars are discovered), the toolbar, the
 * tissue table, the Region panel, the clip-plane / isolation / glyph sections. Where §4.4 supports a
 * layer the app has no producer for — `IsosurfaceLayer`, `PointsLayer`, and `mode:'oblique'` with
 * its gizmo — the E2E handle (`window.__tetravox.engine`) stands in, exactly as `props-mesh.spec.ts`
 * does, and `scenarios.json` records that as a limitation rather than passing it off as a feature.
 *
 * **Nothing here is faked.** A scenario that cannot be produced with what is on `main` is recorded
 * with what it is missing, in `notes`, and is not staged with a lookalike.
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';
import type { DecodedPng } from './png';

const ENABLED = process.env['TETRAVOX_CATALOGUE'] === '1';
const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';

const OUT =
  process.env['TETRAVOX_CATALOGUE_OUT'] ??
  resolve(APP_ROOT, '..', '..', 'docs', 'reports', '2026-08-28-visualization-scenarios');

/** The window every capture is taken at. 1440 wide is also the report's maximum image width. */
const WINDOW = { width: 1440, height: 900 };
/** Report budget per PNG, in bytes. */
const MAX_BYTES = 600_000;

const P = {
  t1: join(ROOT, 'm2m_ernie', 'T1.nii.gz'),
  tiMaxNifti: join(
    ROOT,
    'Simulations',
    'Thalamus',
    'TI',
    'niftis',
    'Thalamus_TI_subject_TI_max.nii.gz'
  ),
  labeling: join(ROOT, 'm2m_ernie', 'segmentation', 'labeling.nii.gz'),
  finalTissues: join(ROOT, 'm2m_ernie', 'final_tissues.nii.gz'),
  ernie: join(ROOT, 'm2m_ernie', 'ernie.msh'),
  thalamusTi: join(ROOT, 'Simulations', 'Thalamus', 'TI', 'mesh', 'Thalamus_TI.msh'),
  greyThalamusTi: join(ROOT, 'Simulations', 'Thalamus', 'TI', 'mesh', 'grey_Thalamus_TI.msh'),
  tdcs: join(ROOT, 'Simulations', 'L_Insula', 'high_Frequency', 'mesh', 'ernie_TDCS_1_scalar.msh'),
  pial: join(ROOT, 'm2m_ernie', 'surfaces', 'lh.pial.gii'),
  annot: join(ROOT, 'm2m_ernie', 'segmentation', 'lh.ernie_DK40.annot'),
  eeg: join(ROOT, 'm2m_ernie', 'eeg_positions', 'GSN-HydroCel-185.csv'),
};

// ------------------------------------------------------------------------------------------------
// The catalogue record
// ------------------------------------------------------------------------------------------------

interface LayerRecord {
  kind: 'volume' | 'mesh' | 'iso' | 'points';
  name: string;
  settings: Record<string, unknown>;
}

interface Scenario {
  file: string;
  closeup?: string;
  closeups?: string[];
  title: string;
  what_it_shows: string;
  data_files: string[];
  layers: LayerRecord[];
  controls_used: string[];
  notes: string[];
}

const scenarios: Scenario[] = [];

/** Record one scenario and rewrite `scenarios.json`, so a later failure keeps what already ran. */
function record(scenario: Scenario): void {
  const at = scenarios.findIndex((s) => s.file === scenario.file);
  if (at === -1) scenarios.push(scenario);
  else scenarios[at] = scenario;
  scenarios.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(
    join(OUT, 'scenarios.json'),
    `${JSON.stringify({ capturedAt: CAPTURED_AT, window: WINDOW, dataset: ROOT, scenarios }, null, 2)}\n`
  );
}

const CAPTURED_AT = new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------
// Capture helpers
// ------------------------------------------------------------------------------------------------

/**
 * A whole-window PNG: panels, view grid, status bar.
 *
 * Any horizontal scroll a `scrollIntoViewIfNeeded` left behind is undone first — a panel scrolled
 * sideways is a picture of the E2E's own bookkeeping, not of the product.
 */
async function shoot(page: Page, file: string): Promise<string> {
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
    });
  });
  const path = join(OUT, file);
  await page.screenshot({ path, scale: 'css' });
  verify(path);
  return file;
}

/** One pane of the view grid, clipped to its cell. */
async function shootPane(page: Page, viewId: string, file: string): Promise<string> {
  const box = await page.locator(`[data-testid="view-cell-${viewId}"]`).boundingBox();
  if (box === null) throw new Error(`no pane ${viewId}`);
  const path = join(OUT, file);
  await page.screenshot({ path, scale: 'css', clip: box });
  verify(path);
  return file;
}

/**
 * Re-encode a screenshot as an opaque RGB PNG, deflated hard.
 *
 * Written here rather than reached for from a library because §12.3's dependency list has no image
 * encoder and adding one is a coordinated change (`e2e/png.ts` hand-writes the *reader* for the
 * same reason). It is only ever a fallback: a capture that already fits its budget is left exactly
 * as Chromium wrote it.
 *
 * Two savings, both lossless: the alpha channel goes (a window screenshot is opaque everywhere),
 * and every scanline picks the filter with the smallest sum of absolute differences before one
 * level-9 deflate over the lot. On this catalogue that is 3–4 %, which is enough for most of the
 * captures that overshoot.
 *
 * For the handful it is not enough for — a full window whose three panes are anatomical noise
 * under a coloured contour overlay is close to incompressible — the picture then loses 10 % of its
 * resolution per pass until it fits. 1440 px is the report's maximum width, not its minimum, and a
 * slightly smaller picture is a better answer than a missing one.
 */
function shrinkPng(path: string): void {
  let png = decodePng(readFileSync(path));
  writeFileSync(path, encodeRgbPng(png));
  // Still over? Give up a little resolution, in 10 % steps, rather than the whole capture. Dense
  // anatomical noise under a full-window screenshot is close to incompressible, and 1440 px is the
  // report's maximum width, not its minimum.
  for (let step = 0; step < 5 && statSync(path).size > MAX_BYTES; step += 1) {
    png = downscale(png, 0.9);
    writeFileSync(path, encodeRgbPng(png));
  }
}

/** Area-average downscale — the filter that keeps small text legible at these ratios. */
function downscale(png: DecodedPng, factor: number): DecodedPng {
  const width = Math.max(1, Math.round(png.width * factor));
  const height = Math.max(1, Math.round(png.height * factor));
  const pixels = new Uint8Array(width * height * 4);
  const sx = png.width / width;
  const sy = png.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(png.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(png.width, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let j = y0; j < y1; j += 1) {
        for (let i = x0; i < x1; i += 1) {
          const src = (j * png.width + i) * 4;
          r += png.pixels[src] ?? 0;
          g += png.pixels[src + 1] ?? 0;
          b += png.pixels[src + 2] ?? 0;
          n += 1;
        }
      }
      const dst = (y * width + x) * 4;
      pixels[dst] = Math.round(r / n);
      pixels[dst + 1] = Math.round(g / n);
      pixels[dst + 2] = Math.round(b / n);
      pixels[dst + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function encodeRgbPng(png: DecodedPng): Buffer {
  const { width, height, pixels } = png;
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  const current = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);
  const candidate = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const dst = x * channels;
      current[dst] = pixels[src] ?? 0;
      current[dst + 1] = pixels[src + 1] ?? 0;
      current[dst + 2] = pixels[src + 2] ?? 0;
    }
    let bestFilter = 0;
    let bestSum = Infinity;
    let best: Buffer = Buffer.alloc(stride);
    for (let filter = 0; filter < 5; filter += 1) {
      let sum = 0;
      for (let x = 0; x < stride; x += 1) {
        const a = x >= channels ? (current[x - channels] ?? 0) : 0;
        const b = previous[x] ?? 0;
        const c = x >= channels ? (previous[x - channels] ?? 0) : 0;
        const v = current[x] ?? 0;
        let out: number;
        switch (filter) {
          case 0:
            out = v;
            break;
          case 1:
            out = v - a;
            break;
          case 2:
            out = v - b;
            break;
          case 3:
            out = v - ((a + b) >> 1);
            break;
          default: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            out = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          }
        }
        const byte = out & 0xff;
        candidate[x] = byte;
        sum += byte < 128 ? byte : 256 - byte;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestFilter = filter;
        best = Buffer.from(candidate);
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    best.copy(raw, y * (stride + 1) + 1);
    previous.set(current);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 — RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * The central `fraction` of one pane — a crop, for detail that only reads magnified.
 *
 * Dense line art (element edges over a cut through 4.7 M tetrahedra) is the one thing in this
 * catalogue that a whole pane cannot hold inside the size budget: it is close to incompressible, so
 * fewer pixels is the only lever that does not throw the detail away.
 */
async function shootPaneCrop(
  page: Page,
  viewId: string,
  file: string,
  fraction: number
): Promise<string> {
  const box = await page.locator(`[data-testid="view-cell-${viewId}"]`).boundingBox();
  if (box === null) throw new Error(`no pane ${viewId}`);
  const width = Math.round(box.width * fraction);
  const height = Math.round(box.height * fraction);
  const path = join(OUT, file);
  await page.screenshot({
    path,
    scale: 'css',
    clip: {
      x: box.x + (box.width - width) / 2,
      y: box.y + (box.height - height) / 2,
      width,
      height,
    },
  });
  verify(path);
  return file;
}

/**
 * A written PNG is real, within budget and **not blank**.
 *
 * "Not blank" is a number, not a look (AGENTS rule 1): a capture is rejected when one colour owns
 * more than 98 % of it, or when fewer than 64 distinct colours appear. A cleared pane with a
 * crosshair drawn over it would pass a "has some non-background pixel" test and fail this one.
 */
function verify(path: string): void {
  if (statSync(path).size > MAX_BYTES) shrinkPng(path);
  const bytes = statSync(path).size;
  expect(bytes, `${path} is empty`).toBeGreaterThan(1024);
  expect(
    bytes,
    `${path} is ${(bytes / 1000).toFixed(0)} kB, over the ${MAX_BYTES / 1000} kB budget`
  ).toBeLessThanOrEqual(MAX_BYTES);

  const png = decodePng(readFileSync(path));
  expect(png.width, `${path} has no width`).toBeGreaterThan(0);
  const counts = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    const key =
      ((png.pixels[i] ?? 0) << 16) | ((png.pixels[i + 1] ?? 0) << 8) | (png.pixels[i + 2] ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  let top = 0;
  for (const n of counts.values()) if (n > top) top = n;
  expect(counts.size, `${path} has ${counts.size} distinct colours — blank`).toBeGreaterThan(64);
  expect(
    top / total,
    `${path} is ${((100 * top) / total).toFixed(1)} % one colour — blank`
  ).toBeLessThan(0.98);
}

// ------------------------------------------------------------------------------------------------
// Driving helpers
// ------------------------------------------------------------------------------------------------

async function boot(target: LaunchTarget): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, { search: 'engine=real' });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, WINDOW);
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  return { app, page };
}

/**
 * Open files **through the Open… button**, with the OS dialog stubbed in main.
 *
 * The same path `walkthrough.spec.ts` takes and for the same reason: `open/sources.ts` derives the
 * §6.5.1 sidecars beside each file, so `ernie.msh.opt` names the ten tissues and
 * `labeling_LUT.txt` names the 57 regions. Building the requests by hand skips all of that.
 */
async function openFiles(
  app: ElectronApplication,
  page: Page,
  paths: readonly string[]
): Promise<void> {
  for (const path of paths) {
    expect(existsSync(path), `${path} is missing from TETRAVOX_TESTDATA`).toBe(true);
  }
  const before = await layerCount(page);
  await app.evaluate(
    async ({ dialog }, list) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: list,
      })) as typeof dialog.showOpenDialog;
    },
    [...paths]
  );
  await page.click('[data-testid="open-button"]');
  await page.waitForFunction(
    (want: number) => (window.__tetravox?.store.getState().layers.length ?? 0) >= want,
    before + paths.length,
    { timeout: 600_000 }
  );
  await settle(page);
}

async function layerCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__tetravox?.store.getState().layers.length ?? 0);
}

/**
 * §7.2's `whenSettled`, a synchronous frame, and a rAF — twice.
 *
 * Twice because a layout change is three-sided: React commits the new cell grid, `ViewGrid`'s
 * `ResizeObserver` resizes the drawing buffer, and only then does the engine lay the panes out
 * again. One pass through settles the engine against the *old* pane rects and photographs a frame
 * with the previous layout's borders still in it.
 */
async function settle(page: Page): Promise<void> {
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

/** The id of the nth layer of a kind, in scene (bottom→top) order. */
async function layerIdOf(page: Page, kind: string, nth = 0): Promise<string> {
  return page.evaluate(
    ([k, n]: [string, number]) => {
      const layers = (window.__tetravox?.store.getState().layers ?? []).filter((l) => l.kind === k);
      const layer = layers[n];
      if (layer === undefined) throw new Error(`no ${k} layer #${n}`);
      return layer.id;
    },
    [kind, nth] as [string, number]
  );
}

/** Set a range / select / number the way a user's drag does: native setter, then input + change. */
async function setControl(page: Page, testId: string, value: string): Promise<void> {
  await page.evaluate(
    ([id, v]) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el === null) throw new Error(`no control [data-testid="${id}"]`);
      const proto =
        el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter === undefined) throw new Error('no value setter');
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [testId, value] as const
  );
}

/** Open one collapsed §8 property section. */
async function openSection(page: Page, testId: string): Promise<void> {
  const section = page.locator(`[data-testid="${testId}"]`);
  await section.scrollIntoViewIfNeeded();
  if ((await section.getAttribute('data-open')) !== 'true') {
    await page.click(`[data-testid="${testId}-toggle"]`);
    await expect(section).toHaveAttribute('data-open', 'true');
  }
}

/**
 * Wait for a mesh layer to be showing `field`, and for the §7.4 de-indexed build behind it.
 *
 * Switching to an **element** field is an async load, not an instant checkbox: the worker builds a
 * de-indexed copy of the geometry the first time one is asked for, and the panel shows a pending
 * badge until the engine has settled. A capture taken before that lands photographs the old
 * colouring.
 */
async function waitForField(page: Page, layerId: string, field: string): Promise<void> {
  await page.waitForFunction(
    ([id, name]: [string, string]) => {
      const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
      return layer?.kind === 'mesh' && layer.field?.name === name;
    },
    [layerId, field] as [string, string],
    { timeout: 600_000 }
  );
  await page.waitForFunction(
    (id: string) => (window.__tetravox?.store.getState().meshPending[id] ?? []).length === 0,
    layerId,
    { timeout: 600_000 }
  );
  await settle(page);
}

/** Scroll a panel element into view without changing the scene. */
async function reveal(page: Page, testId: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).scrollIntoViewIfNeeded();
}

/** Make one layer the active one, the way a click on its name does. */
async function activate(page: Page, layerId: string): Promise<void> {
  await page.click(`[data-testid="layer-name-${layerId}"]`);
}

/**
 * Frame the 3D pane: a §7.5 camera preset from the keyboard, then a real orbit drag.
 *
 * The default 3D camera looks straight down (`5`, superior), which photographs the top of a head
 * and nothing else. `3` is the left preset and the drag turns it into a three-quarter view — both
 * gestures the product ships, performed the way a user performs them.
 */
async function frame3d(page: Page, preset = '3', dx = 70, dy = -35): Promise<void> {
  const grid = page.locator('[data-testid="view-grid"]');
  // `r` refits the active view first, so a framing is the same picture however the last one ended.
  await grid.press('r');
  await grid.press(preset);
  await settle(page);
  const box = await page.locator('[data-testid="view-cell-view3d"]').boundingBox();
  if (box === null) throw new Error('no 3D pane');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx, at.y + dy, { steps: 10 });
  await page.mouse.up();
  await settle(page);
}

/** Dolly the 3D camera with the wheel, the §7.5 gesture. Negative pulls in. */
async function dolly3d(page: Page, delta: number): Promise<void> {
  const box = await page.locator('[data-testid="view-cell-view3d"]').boundingBox();
  if (box === null) throw new Error('no 3D pane');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
  await settle(page);
}

/** Put the cursor on a world point, through the coordinate bar (§8). */
async function jumpTo(page: Page, world: readonly [number, number, number]): Promise<void> {
  const input = page.locator('[data-testid="coord-input"]');
  await input.click();
  await input.fill(world.map((c) => c.toFixed(1)).join(' '));
  await input.press('Enter');
  // Take the keyboard back out of the text field (§7.5), as a user's next pane click would.
  await page.locator('[data-testid="view-grid"]').press('Escape');
  await settle(page);
}

/**
 * The world point of the loudest voxel of a scalar volume layer.
 *
 * §4.3 keeps `VolumeDataset.data` on the UI thread "for probes only", and this is E2E arithmetic
 * over an already-loaded array rather than anything the product does — it exists so the catalogue's
 * overlay pictures are taken where the overlay actually is, instead of at an arbitrary slice.
 */
async function argmaxWorld(
  page: Page,
  layerId: string,
  /**
   * Search only the central fraction of the voxel grid on each axis.
   *
   * A TI field is loudest at the scalp, under the electrodes — true, and not what a picture of the
   * *target* should be centred on. `0.5` keeps the middle half of each axis, which on a 256³ head
   * volume is the brain and excludes skin and skull.
   */
  centralFraction = 1
): Promise<[number, number, number]> {
  return page.evaluate(
    ([id, fraction]: [string, number]) => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (ds === undefined || ds.kind !== 'volume') throw new Error('no volume dataset');
      const [nx, ny, nz] = ds.dims;
      const span = (n: number): [number, number] => [
        Math.floor((n * (1 - fraction)) / 2),
        Math.ceil(n - (n * (1 - fraction)) / 2),
      ];
      const [i0, i1] = span(nx);
      const [j0, j1] = span(ny);
      const [k0, k1] = span(nz);
      let best = -Infinity;
      let at: [number, number, number] = [i0, j0, k0];
      for (let k = k0; k < k1; k += 1) {
        for (let j = j0; j < j1; j += 1) {
          const row = k * nx * ny + j * nx;
          for (let i = i0; i < i1; i += 1) {
            const v = (ds.data[row + i] as number) * ds.sclSlope + ds.sclInter;
            if (v > best) {
              best = v;
              at = [i, j, k];
            }
          }
        }
      }
      const m = ds.affine;
      // Column-major mat4 (§4.1): world = A · (i, j, k, 1).
      const w = (r: number): number =>
        (m[r] ?? 0) * at[0] + (m[r + 4] ?? 0) * at[1] + (m[r + 8] ?? 0) * at[2] + (m[r + 12] ?? 0);
      return [w(0), w(1), w(2)] as [number, number, number];
    },
    [layerId, centralFraction] as [string, number]
  );
}

/** The centre of a dataset's bounding box, in world mm. */
async function boundsCentre(page: Page, layerId: string): Promise<[number, number, number]> {
  return page.evaluate((id: string) => {
    const state = window.__tetravox?.store.getState();
    const layer = state?.layers.find((l) => l.id === id);
    const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
    if (ds === undefined) throw new Error('no dataset');
    const b = ds.bounds;
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] as [
      number,
      number,
      number,
    ];
  }, layerId);
}

/**
 * The world centre of mass of one label, computed **in the test**.
 *
 * `Engine.labelCentroids` is the product's own producer for this and is wrong: `tvx-geom`'s
 * `label_centroids` already multiplies the voxel mean by the volume's affine, and
 * `engine.ts`'s `labelCentroids` multiplies it by that affine again. On `labeling.nii.gz` the left
 * thalamus comes back as (-81.9, 162.8, -136.1) where the correct answer is (-8.6, 7.5, 17.8) —
 * outside the volume, so R5's double-click-to-centroid lands on an empty slice. Recorded as a
 * finding; this catalogue must not photograph it as if it were the feature working.
 */
async function labelCentroidWorld(
  page: Page,
  layerId: string,
  labelId: number
): Promise<[number, number, number] | null> {
  return page.evaluate(
    ([id, label]: [string, number]) => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (ds === undefined || ds.kind !== 'volume') throw new Error('no volume dataset');
      const [nx, ny] = ds.dims;
      let n = 0;
      let si = 0;
      let sj = 0;
      let sk = 0;
      for (let at = 0; at < ds.data.length; at += 1) {
        if (Math.round(ds.data[at] as number) !== label) continue;
        si += at % nx;
        sj += Math.floor(at / nx) % ny;
        sk += Math.floor(at / (nx * ny));
        n += 1;
      }
      if (n === 0) return null;
      const c = [si / n, sj / n, sk / n];
      const m = ds.affine;
      const w = (r: number): number =>
        (m[r] ?? 0) * (c[0] as number) +
        (m[r + 4] ?? 0) * (c[1] as number) +
        (m[r + 8] ?? 0) * (c[2] as number) +
        (m[r + 12] ?? 0);
      return [w(0), w(1), w(2)] as [number, number, number];
    },
    [layerId, labelId] as [string, number]
  );
}

/**
 * One tag by **id** and element kind, with the name the dataset gives it.
 *
 * Needed beside {@link tagId} because a *simulation* mesh's `.msh.opt` is not the head mesh's:
 * `Thalamus_TI.msh.opt` carries the Gmsh view block and the tag colours but **no**
 * `Physical Volume` lines, so its tissue table reads `tag 1` … `tag 1099` and there is no "GM" to
 * look up. The SimNIBS numbering is the stable thing there: tet tag 2 is grey matter.
 */
async function tagById(
  page: Page,
  layerId: string,
  id: number,
  kind: 'tri' | 'tet'
): Promise<{ id: number; name: string; count: number }> {
  const found = await page.evaluate(
    ([layer, tag, want]: [string, number, string]) => {
      const state = window.__tetravox?.store.getState();
      const l = state?.layers.find((x) => x.id === layer);
      const ds = state?.datasets.find((d) => d.id === l?.datasetId);
      if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh dataset');
      const t = ds.tags.find((x) => x.id === tag && x.kind === want);
      return t === undefined ? null : { id: t.id, name: t.name ?? `tag ${t.id}`, count: t.count };
    },
    [layerId, id, kind] as [string, number, string]
  );
  expect(found, `no ${kind} tag ${id}`).not.toBeNull();
  return found as { id: number; name: string; count: number };
}

/** A tag id by name and element kind, off the loaded dataset (`ernie.msh.opt` named them). */
async function tagId(
  page: Page,
  layerId: string,
  name: RegExp | string,
  kind: 'tri' | 'tet'
): Promise<number> {
  const found = await page.evaluate(
    ([id, pattern, want]: [string, string, string]) => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh dataset');
      const re = new RegExp(pattern, 'i');
      return ds.tags.find((t) => t.kind === want && re.test(t.name ?? ''))?.id ?? null;
    },
    [layerId, typeof name === 'string' ? name : name.source, kind] as [string, string, string]
  );
  expect(found, `no ${kind} tag matching ${String(name)}`).not.toBeNull();
  return found as number;
}

// ------------------------------------------------------------------------------------------------

test.describe('visualisation scenario catalogue', () => {
  test.skip(!ENABLED, 'set TETRAVOX_CATALOGUE=1 to capture the catalogue');
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset — the catalogue is a real-data tour');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
  });

  // ----------------------------------------------------------------------------------------------
  // Group A — the empty window, T1 alone, the key sheet, an oblique plane, the screenshot dialog
  // and a saved scene.
  // ----------------------------------------------------------------------------------------------

  test('A — first run, T1 alone, key sheet, oblique, screenshot and scene', async ({}, info) => {
    test.setTimeout(900_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target);
    try {
      // ---- 16 · the empty state ------------------------------------------------------------
      await shoot(page, '16-empty-state.png');
      record({
        file: '16-empty-state.png',
        title: 'First run — the empty window',
        what_it_shows:
          'The shell before anything is open: the toolbar (Open, scene New/Open/Save, the four ' +
          'layouts, RAD/NEU, Crosshair, Bars, Screenshot, ?), an empty layer panel on the left, ' +
          'the 2×2 view grid with its four named cells, the coordinate/info/header panel on the ' +
          'right, and the status bar reporting the renderer, the WASM build and the origin.',
        data_files: [],
        layers: [],
        controls_used: ['Launch the app. Nothing is clicked.'],
        notes: [
          'The four view cells are labelled axial / coronal / sagittal / view3d; the active one ' +
            'carries the accent border.',
        ],
      });

      // ---- 1 · T1 alone --------------------------------------------------------------------
      await openFiles(app, page, [P.t1]);
      const t1 = await layerIdOf(page, 'volume');
      const centre = await boundsCentre(page, t1);
      await jumpTo(page, centre);
      await shoot(page, '01-t1-orthogonal-2x2.png');
      await shootPane(page, 'axial', '01-t1-orthogonal-2x2-closeup.png');
      record({
        file: '01-t1-orthogonal-2x2.png',
        closeup: '01-t1-orthogonal-2x2-closeup.png',
        title: 'A T1 in the three canonical planes',
        what_it_shows:
          'One NIfTI in the 2×2 layout: axial, coronal and sagittal panes plus the 3D pane. Each ' +
          '2D pane carries the §8 chrome — orientation letters on the four edges, the crosshair at ' +
          'the cursor, the corner block with the world RAS coordinate, the voxel index and the ' +
          'slice number, and the NEU badge that says the convention is neurological (left is left). ' +
          'The window is the file’s own 2nd–98th percentile, which is what a T1 whose physical ' +
          'maximum is exactly 65535 needs to look like anything at all.',
        data_files: ['m2m_ernie/T1.nii.gz'],
        layers: [
          {
            kind: 'volume',
            name: 'T1.nii.gz',
            settings: {
              colormap: 'gray',
              'scale.kind': 'linear',
              'scale.lo/hi': 'stats.percentiles["2"] … ["98"] (the default window)',
              interpolation: 'linear',
              threshold: 'none',
            },
          },
        ],
        controls_used: [
          'Open… → pick T1.nii.gz (or drop it on the window, or pass it on the command line).',
          'The 2×2 layout button in the toolbar (it is the default).',
          'Type a coordinate in the coordinate bar and press Enter to move the crosshair; a ' +
            'left-click or drag in any pane does the same thing.',
          'Crosshair toggles the crosshair; c does the same from the keyboard.',
        ],
        notes: [
          'The 2nd–98th percentile window is the default for every scalar volume — no control was ' +
            'touched to get it.',
          'The 3D pane is empty here: a volume only appears in 3D when its “show in 3D” slice ' +
            'planes are switched on (scenario 05).',
        ],
      });

      // ---- 17 · the keyboard sheet ---------------------------------------------------------
      // `jumpTo` already moved the keyboard focus onto the view grid, so `?` reaches the shell.
      // A *click* on the grid would too — and would also set the cursor to the point clicked,
      // which at the grid's centre is a pane corner 150 mm outside the head.
      await page.keyboard.press('?');
      await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
      await shoot(page, '17-keyboard-help.png');
      await page.keyboard.press('Escape');
      record({
        file: '17-keyboard-help.png',
        title: 'The keyboard and pointer sheet',
        what_it_shows:
          'Every shortcut the viewer has, generated from the key map itself so it cannot go stale: ' +
          'the keyboard commands (layer cycling, visibility, reorder, layout, crosshair, reset, the ' +
          '1–6 camera presets, orthographic, the 4D index, in-plane nudge and slice stepping), the ' +
          'pointer gestures for 2D and 3D panes, and the oblique affordances.',
        data_files: [],
        layers: [],
        controls_used: [
          'Press ? (or F1) with focus outside a text field, or click the ? button in the toolbar.',
          'Escape closes it.',
        ],
        notes: [],
      });

      // ---- 14 · an oblique plane -----------------------------------------------------------
      // The T1's slice planes in 3D, so the gizmo has the plane it manipulates behind it.
      await activate(page, t1);
      await reveal(page, `volume-properties-${t1}`);
      await page.click(`[data-testid="volume-show-in-3d-${t1}"]`);
      const obliqueSet = await page.evaluate(async () => {
        const tv = window.__tetravox;
        if (tv?.engine == null || tv.controller == null) throw new Error('no engine');
        const engine = tv.engine as typeof tv.engine & {
          showGizmo?: (viewId: string | null) => void;
        };
        const n = 1 / Math.sqrt(3);
        engine.setView('axial', { mode: 'oblique', normal: [n, n, n], up: [0, 0, 1] });
        const hasGizmo = typeof engine.showGizmo === 'function';
        if (hasGizmo) engine.showGizmo?.('axial');
        // 1×1 shows the **active** view, so name it rather than trusting whatever was clicked last.
        tv.controller.setActiveView('axial');
        engine.requestRender();
        await engine.whenSettled();
        return hasGizmo;
      });
      await page.click('[data-testid="layout-1x1"]');
      await expect(page.locator('[data-testid="view-grid"]')).toHaveAttribute('data-layout', '1x1');
      await settle(page);
      await shoot(page, '14-oblique-slice.png');
      // The gizmo is drawn in the **3D** pane and manipulates the named 2D pane's plane, so the
      // 1×1 oblique pane cannot show it. The 2×2 does.
      await page.click('[data-testid="layout-2x2"]');
      await settle(page);
      await shootPane(page, 'view3d', '14-oblique-slice-closeup.png');
      record({
        file: '14-oblique-slice.png',
        closeup: '14-oblique-slice-closeup.png',
        title: 'An oblique slice, and its gizmo',
        what_it_shows:
          'The axial pane re-pointed onto an oblique plane with normal ≈ (1,1,1)/√3, filling the ' +
          '1×1 layout. The plane is derived from the cursor, so it sweeps with the crosshair ' +
          'exactly as a canonical plane does, and the corner block and orientation letters follow ' +
          'the new basis. The close-up is the 3D pane in the 2×2 layout, where the cut-plane gizmo ' +
          'is drawn: a ring with rotate handles and a stem along the normal.',
        data_files: ['m2m_ernie/T1.nii.gz'],
        layers: [{ kind: 'volume', name: 'T1.nii.gz', settings: { colormap: 'gray' } }],
        controls_used: [
          'Engine call: setView("axial", { mode: "oblique", normal, up }) and showGizmo("axial").',
          'Once the gizmo is up, the shipped pointer gestures apply: drag its ring handles to ' +
            'rotate the plane, drag the stem to slide it along the normal, and a camera preset ' +
            'puts the pane back on axial / coronal / sagittal.',
          '1×1 layout button; 2×2 to see the gizmo beside the slice.',
        ],
        notes: [
          'LIMITATION — no shipped UI reaches an oblique plane. The model, the shader path, the ' +
            'gizmo, its drag handles and plane-from-3-points are all implemented in the engine ' +
            '(§7.5), but nothing in the toolbar, the panels or the key map calls setView with ' +
            'mode:"oblique" or showGizmo. This capture drove those two engine methods directly.',
          'The gizmo is deliberately drawn in the 3D pane, not in the oblique pane — a gizmo inside ' +
            'the plane it rotates would be seen edge-on. So the 1×1 oblique capture has no gizmo ' +
            'in it by design, and the close-up is the 3D pane.',
          obliqueSet
            ? 'showGizmo is present on the concrete engine and was called.'
            : 'showGizmo was not found on the engine build under test; the plane is oblique but no ' +
              'gizmo is drawn.',
        ],
      });
      // Back to a canonical axial for the rest of the group.
      await page.evaluate(async () => {
        const tv = window.__tetravox;
        if (tv?.engine == null) return;
        const engine = tv.engine as typeof tv.engine & {
          showGizmo?: (v: string | null) => void;
        };
        engine.showGizmo?.(null);
        engine.setView('axial', { mode: 'axial', normal: [0, 0, 1], up: [0, 1, 0] });
        await engine.whenSettled();
      });
      // The cells were ordered while `axial` was oblique; re-apply the layout so the 2×2 comes
      // back in axial / coronal / sagittal / 3D order.
      await page.click('[data-testid="layout-2x2"]');
      await settle(page);

      // ---- 15 · the screenshot dialog, and a saved scene -----------------------------------
      await page.click('[data-testid="screenshot-options"]');
      await expect(page.locator('[data-testid="screenshot-preview-pane"]')).toBeVisible();
      await setControl(page, 'screenshot-width', '1200');
      await setControl(page, 'screenshot-dpi', '300');
      await page.click('[data-testid="screenshot-preview"]');
      await expect(page.locator('[data-testid="screenshot-preview-image"]')).toBeVisible({
        timeout: 120_000,
      });
      await shoot(page, '15-screenshot-dialog.png');
      await page.click('[data-testid="screenshot-cancel"]');

      const scenePath = join(OUT, 'scene-example.tetravox.json');
      await app.evaluate(async ({ dialog }, path) => {
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: path,
        })) as typeof dialog.showSaveDialog;
      }, scenePath);
      await page.click('[data-testid="scene-save-as"]');
      await expect(page.locator('[data-testid="scene-file"]')).toBeVisible({ timeout: 60_000 });
      await shoot(page, '15-scene-saved.png');
      expect(existsSync(scenePath), 'the scene file was written').toBe(true);
      const spec = JSON.parse(await readFile(scenePath, 'utf8')) as {
        version: number;
        datasets: { path: string; fingerprint: string }[];
      };
      expect(spec.version).toBe(1);
      expect(spec.datasets.length).toBeGreaterThan(0);
      record({
        file: '15-screenshot-dialog.png',
        closeup: '15-scene-saved.png',
        title: 'Publication screenshots, and a scene that travels',
        what_it_shows:
          'The screenshot dialog with a live preview: target (one pane or the whole grid), pixel ' +
          'size, scale, DPI written into the PNG’s pHYs chunk, background (scene / white / ' +
          'transparent), which chrome to include (colour bar, orientation letters, crosshair, ' +
          'corner info, scale bar) and auto-trim. The second capture is the toolbar after Save ' +
          'as…: the scene’s name is shown beside the buttons, and scene-example.tetravox.json — ' +
          'written beside these images — holds the whole ViewSpec: every dataset with its ' +
          'relative path, absolute fallback, content fingerprint and the sidecars it was opened ' +
          'with, plus every layer, view, the cursor, the convention and the annotations.',
        data_files: [
          'm2m_ernie/T1.nii.gz',
          'scene-example.tetravox.json (written by this capture)',
        ],
        layers: [{ kind: 'volume', name: 'T1.nii.gz', settings: { colormap: 'gray' } }],
        controls_used: [
          'Toolbar → ⚙ beside Screenshot opens the dialog; the Screenshot button beside it shoots ' +
            'straight away with whatever the dialog last left.',
          'Set Width 1200 and DPI 300, then Preview.',
          'Toolbar → Save as… writes a *.tetravox.json; Open scene… reads one back, with a ' +
            'relocate dialog keyed on the fingerprint when a file has moved.',
        ],
        notes: [
          'The DPI is written into the PNG itself (pHYs), so a journal’s figure-resolution check ' +
            'reads it off the file.',
          'Dataset paths in the scene file are relative to the scene file, with an absolute ' +
            'fallback, so a scene copied beside its data opens elsewhere.',
        ],
      });
    } finally {
      await app.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  // Group B — a statistical map over the T1.
  // ----------------------------------------------------------------------------------------------

  test('B — TI_max heat overlay on the T1', async ({}, info) => {
    test.setTimeout(900_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target);
    try {
      await openFiles(app, page, [P.t1, P.tiMaxNifti]);
      const ti = await layerIdOf(page, 'volume', 1);
      const hot = await argmaxWorld(page, ti, 0.3);
      const mid = await boundsCentre(page, ti);
      await jumpTo(page, [mid[0], mid[1], hot[2] + 30]);

      await activate(page, ti);
      await reveal(page, `volume-properties-${ti}`);
      await setControl(page, `volume-colormap-${ti}`, 'hot');
      await setControl(page, `volume-scale-kind-${ti}`, 'heat');
      await setControl(page, `volume-heat-min-${ti}`, '0.1');
      await setControl(page, `volume-heat-mid-${ti}`, '0.6');
      await setControl(page, `volume-heat-max-${ti}`, '1.6');
      await setControl(page, `volume-threshold-lo-${ti}`, '0.1');
      await setControl(page, `volume-threshold-mode-${ti}`, 'hide');
      await settle(page);
      await shoot(page, '02-ti-max-heat-overlay.png');
      await shootPane(page, 'axial', '02-ti-max-heat-overlay-closeup.png');

      await page.click('[data-testid="radiological-toggle"]');
      await settle(page);
      await shootPane(page, 'axial', '02-ti-max-heat-overlay-closeup-radiological.png');
      await page.click('[data-testid="radiological-toggle"]');
      await settle(page);

      record({
        file: '02-ti-max-heat-overlay.png',
        closeup: '02-ti-max-heat-overlay-closeup.png',
        closeups: [
          '02-ti-max-heat-overlay-closeup.png',
          '02-ti-max-heat-overlay-closeup-radiological.png',
        ],
        title: 'A TI field as a thresholded heat overlay',
        what_it_shows:
          'The simulated TI_max field composited over the anatomy: the T1 underneath in grey, the ' +
          'field above it on a heat scale with min/mid/max, and everything below 0.1 V/m hidden ' +
          'rather than painted, so the anatomy shows through where there is no field. The colour ' +
          'bar down the side of the pane carries the ticks, the units and the threshold notch. ' +
          'The two close-ups are the same axial slice in neurological (NEU) and radiological (RAD) ' +
          'convention — the badge changes, the left/right letters swap, and the data does not move.',
        data_files: [
          'm2m_ernie/T1.nii.gz',
          'Simulations/Thalamus/TI/niftis/Thalamus_TI_subject_TI_max.nii.gz',
        ],
        layers: [
          { kind: 'volume', name: 'T1.nii.gz', settings: { colormap: 'gray', order: 'bottom' } },
          {
            kind: 'volume',
            name: 'Thalamus_TI_subject_TI_max.nii.gz',
            settings: {
              colormap: 'hot',
              'scale.kind': 'heat',
              'scale.min/mid/max': '0.1 / 0.6 / 1.6',
              'threshold.lo': 0.1,
              'threshold.mode': 'hide',
              showColorbar: true,
              order: 'top',
            },
          },
        ],
        controls_used: [
          'Open… → select the T1 and the TI NIfTI together; layers stack bottom→top in open order, ' +
            'and the layer panel’s ▲▼ (or Ctrl+↑/↓) reorders them.',
          'Click the overlay’s name in the layer panel to make it active and open its editor.',
          'Colormap → hot. Scale → heat, then type min / mid / max.',
          'Threshold low → 0.1 with mode “hide”; the histogram above it has draggable window and ' +
            'threshold handles for the same two numbers.',
          'Toolbar → Bars keeps the colour bars on (they are on by default).',
          'Toolbar → RAD/NEU flips the convention.',
          'The layer row’s own opacity slider blends the overlay into the anatomy.',
        ],
        notes: [
          'The crosshair sits on a mid-brain axial slice. The field’s own maximum in this ' +
            'simulation is at the anterior skull base, not at the thalamic target — which is ' +
            'what a thresholded overlay is for: the bright rim at the scalp and the weaker ' +
            'distribution through the brain are the same number on the same scale.',
          'RAD mirrors the in-plane right axis only — never the data, and never the 3D view.',
        ],
      });
    } finally {
      await app.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  // Group C — an atlas, and the Region panel.
  // ----------------------------------------------------------------------------------------------

  test('C — atlas labels, fill and outline, and the Region panel', async ({}, info) => {
    test.setTimeout(900_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target);
    try {
      await openFiles(app, page, [P.t1, P.labeling]);
      const atlas = await layerIdOf(page, 'volume', 1);
      await activate(page, atlas);

      // The two thalamus rows, by name, off the LUT the sidecar supplied.
      const rows = await page.evaluate((id: string) => {
        const state = window.__tetravox?.store.getState();
        const layer = state?.layers.find((l) => l.id === id);
        const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
        if (ds === undefined || ds.kind !== 'volume') throw new Error('no volume');
        return (ds.labelTable?.entries ?? []).map((e) => ({ id: e.id, name: e.name }));
      }, atlas);
      const left = rows.find((r) => /left.*thalamus/i.test(r.name));
      const right = rows.find((r) => /right.*thalamus/i.test(r.name));
      expect(left, 'labeling_LUT.txt names a left thalamus').toBeDefined();
      expect(right, 'labeling_LUT.txt names a right thalamus').toBeDefined();

      // The panel's own row counts come from `Engine.labelCentroids`; ask for them so the rows
      // read a count rather than an em dash.
      await page.evaluate(async (id: string) => {
        const tv = window.__tetravox;
        if (tv?.controller == null) throw new Error('no controller');
        await tv.controller.loadRegionStats(id);
      }, atlas);
      // Jump to the left thalamus. Computed here, not read off `labelCentroids` — see
      // `labelCentroidWorld` for why, and the scenario's notes for the finding.
      const centroid = await labelCentroidWorld(page, atlas, (left as { id: number }).id);
      const engineCentroid = await page.evaluate(
        ([id, label]: [string, number]) =>
          window.__tetravox?.store.getState().regionStats[id]?.find((r) => r.id === label)
            ?.centroid ?? null,
        [atlas, (left as { id: number }).id] as [string, number]
      );
      expect(centroid, 'the left thalamus has voxels').not.toBeNull();
      console.log(
        `[catalogue] left thalamus centroid: computed ${JSON.stringify(centroid)}, ` +
          `Engine.labelCentroids ${JSON.stringify(engineCentroid)}`
      );
      await jumpTo(page, centroid as [number, number, number]);

      await reveal(page, `region-panel-${atlas}`);
      await setControl(page, `volume-label-mode-${atlas}`, 'fill');
      await setControl(page, `layer-opacity-${atlas}`, '0.5');
      await settle(page);
      await shootPane(page, 'axial', '03-atlas-labels-closeup-fill.png');

      await setControl(page, `volume-label-mode-${atlas}`, 'outline');
      await setControl(page, `volume-outline-width-${atlas}`, '2');
      await setControl(page, `layer-opacity-${atlas}`, '1');
      await settle(page);
      await shootPane(page, 'coronal', '03-atlas-labels-closeup-outline.png');

      // Back to fill for the panel picture, then hide the left thalamus and recolour the right.
      await setControl(page, `volume-label-mode-${atlas}`, 'both');
      await setControl(page, `layer-opacity-${atlas}`, '0.6');
      await page.click(`[data-testid="region-eye-${atlas}-${(left as { id: number }).id}"]`);
      await setControl(page, `region-color-${atlas}-${(right as { id: number }).id}`, '#00e5ff');
      await page.locator(`[data-testid="region-search-${atlas}"]`).fill('thalamus');
      await reveal(page, `region-list-${atlas}`);
      await settle(page);
      await shoot(page, '03-atlas-labels.png');

      // Alt-click one row = solo: everything else is muted.
      await page.click(`[data-testid="region-name-${atlas}-${(right as { id: number }).id}"]`, {
        modifiers: ['Alt'],
      });
      await settle(page);
      await shootPane(page, 'axial', '03-atlas-labels-closeup-solo.png');

      record({
        file: '03-atlas-labels.png',
        closeup: '03-atlas-labels-closeup-fill.png',
        closeups: [
          '03-atlas-labels-closeup-fill.png',
          '03-atlas-labels-closeup-outline.png',
          '03-atlas-labels-closeup-solo.png',
        ],
        title: 'An atlas over the anatomy, and the Region panel',
        what_it_shows:
          'The SimNIBS labelling over the T1, with its LUT sidecar found automatically so every ' +
          'region has its own name and colour. The three close-ups are the same atlas drawn three ' +
          'ways: filled at half opacity, as outlines two pixels wide over the anatomy, and with ' +
          'one region soloed so every other region is muted. The window capture has the Region ' +
          'panel open and filtered to “thalamus”: rows with an eye, a colour swatch, an opacity ' +
          'slider, the name, the id and the voxel count — the left thalamus hidden, the right one ' +
          'recoloured cyan.',
        data_files: [
          'm2m_ernie/T1.nii.gz',
          'm2m_ernie/segmentation/labeling.nii.gz',
          'm2m_ernie/segmentation/labeling_LUT.txt (found beside it)',
        ],
        layers: [
          { kind: 'volume', name: 'T1.nii.gz', settings: { colormap: 'gray', order: 'bottom' } },
          {
            kind: 'volume',
            name: 'labeling.nii.gz',
            settings: {
              isLabel: true,
              interpolation: 'nearest (forced for a label volume)',
              labelMode: 'fill → outline → both',
              outlineWidthPx: 2,
              opacity: '0.5 / 1.0 / 0.6',
              visibleLabels: 'left thalamus removed',
              labelColors: 'right thalamus → #00e5ff',
              selectedLabels: 'right thalamus (Alt-click solo)',
            },
          },
        ],
        controls_used: [
          'Open… → the T1 and labeling.nii.gz together. The LUT beside the volume is picked up ' +
            'without being named.',
          'Labels → fill / outline / both in the volume editor; the Outline slider sets its width ' +
            'in pixels.',
          'The layer row’s opacity slider blends the atlas into the anatomy.',
          'Region panel: type in the search box to narrow the rows; click the eye to hide a ' +
            'region; click its swatch to recolour it; drag its opacity slider; Show all / Hide ' +
            'all / Invert act on every row at once.',
          'Click a row to select it, ⇧/⌘-click to multi-select, Alt-click to solo it, double-click ' +
            'to jump the cursor to its centroid. Clicking a labelled voxel in a pane selects the ' +
            'row it belongs to.',
        ],
        notes: [
          'labeling.nii.gz is a float32 volume with 57 integral values and is still recognised as ' +
            'a label volume, which is what makes the whole panel work on it.',
          'A recolour and a hide live on the layer, not on the file’s table, so they survive a ' +
            'scene save/load and a per-row Reset puts the file’s own colour back.',
          'BUG — double-click-to-centroid jumps to the wrong place. The centroid a row carries ' +
            'is transformed by the volume’s affine twice: once in the Rust op that computes it and ' +
            'again in the engine method that returns it. On this atlas the left thalamus comes ' +
            'back as (-81.9, 162.8, -136.1) instead of (-8.6, 7.5, 17.8), which is outside the ' +
            'volume, so the double-click lands on an empty slice. The row counts beside it are ' +
            'correct. The crosshair in this capture was placed by computing the centroid ' +
            'independently, so the picture is of the panel and not of the bug.',
        ],
      });
    } finally {
      await app.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  // Group D — the head mesh: tissue surfaces, cross-sections, transparency, cutting, points,
  // and a cortical surface.
  // ----------------------------------------------------------------------------------------------

  test('D — head mesh, transparency, cut planes, electrodes and a cortical surface', async ({}, info) => {
    test.setTimeout(1_800_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target);
    try {
      // ---- 4 · mesh alone ------------------------------------------------------------------
      await openFiles(app, page, [P.ernie]);
      const mesh = await layerIdOf(page, 'mesh');
      const centre = await boundsCentre(page, mesh);
      await jumpTo(page, centre);
      await activate(page, mesh);
      await reveal(page, `mesh-tissue-list-${mesh}`);
      await frame3d(page);
      await shoot(page, '04-mesh-tissue-surfaces.png');
      await shootPane(page, 'coronal', '04-mesh-tissue-surfaces-closeup.png');
      record({
        file: '04-mesh-tissue-surfaces.png',
        closeup: '04-mesh-tissue-surfaces-closeup.png',
        title: 'A head mesh alone — 3D tissue surfaces and 2D cross-sections',
        what_it_shows:
          'The SimNIBS head mesh with no NIfTI in the scene at all. The 3D pane draws its tagged ' +
          'tissue surfaces in the colours the .msh.opt sidecar gives them; the three 2D panes draw ' +
          'the mesh’s own cross-section at the cursor — filled per-element polygons with tissue ' +
          'contours on top — and those sweep with the crosshair exactly as a volume’s slices do. ' +
          'The left panel shows the tissue table: every tag with its name from the sidecar, a ' +
          'colour swatch, an eye and an opacity slider.',
        data_files: ['m2m_ernie/ernie.msh', 'm2m_ernie/ernie.msh.opt (found beside it)'],
        layers: [
          {
            kind: 'mesh',
            name: 'ernie.msh',
            settings: {
              colorMode: 'tag',
              'tagStyle colours': 'seeded from ernie.msh.opt',
              fillIn2D: true,
              contoursIn2D: true,
              contourWidthPx: 1,
              'clip.caps': true,
            },
          },
        ],
        controls_used: [
          'Open… → ernie.msh. The .msh.opt beside it is picked up without being named, which is ' +
            'the only source of the tissue names — the mesh itself has no $PhysicalNames.',
          'Tissue table: the eye hides a tissue, the swatch recolours it, the slider fades it; ' +
            'Show all / Hide all / Invert and a search box act on the whole table.',
          '2D cross-section section: the fill and contours toggles, the contour width slider, and ' +
            'a “cut colour” selector (tissue tag, a solid colour, or any field the mesh carries).',
          'Move the crosshair and the cross-section follows it.',
        ],
        notes: [
          'Cross-sections in the 2D panes are on by default when a mesh is opened; no volume is ' +
            'needed for them.',
        ],
      });

      // ---- 6 · transparency ----------------------------------------------------------------
      const scalpTri = await tagId(page, mesh, /scalp/, 'tri');
      const compactTri = await tagId(page, mesh, /compact_bone/, 'tri');
      const spongyTri = await tagId(page, mesh, /spongy_bone/, 'tri');
      await setControl(page, `mesh-tag-opacity-${mesh}-${scalpTri}`, '0.3');
      await setControl(page, `mesh-tag-opacity-${mesh}-${compactTri}`, '0.5');
      await setControl(page, `mesh-tag-opacity-${mesh}-${spongyTri}`, '0.5');
      await page.click('[data-testid="layout-3d-only"]');
      await frame3d(page, '1', 55, -25);
      await shoot(page, '06-transparency.png');
      await shootPane(page, 'view3d', '06-transparency-closeup.png');
      record({
        file: '06-transparency.png',
        closeup: '06-transparency-closeup.png',
        title: 'Seeing through the head — per-tissue transparency',
        what_it_shows:
          'Scalp at 30 % and both bone layers at 50 %, drawn over opaque grey and white matter. ' +
          'Transparency is per tissue tag, not per layer, so one mesh can be part solid and part ' +
          'glass. The renderer draws the opaque tissues first and then the transparent ones, so ' +
          'each transparent sheet is blended exactly once and the brain underneath keeps its ' +
          'colour instead of being tinted twice by the skin in front of it.',
        data_files: ['m2m_ernie/ernie.msh', 'm2m_ernie/ernie.msh.opt'],
        layers: [
          {
            kind: 'mesh',
            name: 'ernie.msh',
            settings: {
              colorMode: 'tag',
              'tagStyle[Scalp].opacity': 0.3,
              'tagStyle[Compact_bone].opacity': 0.5,
              'tagStyle[Spongy_bone].opacity': 0.5,
              'transparency.mode': 'twoPhase',
            },
          },
        ],
        controls_used: [
          'Tissue table → the opacity slider on the Scalp row, then on Compact_bone and ' +
            'Spongy_bone.',
          'Toolbar → the 3D-only layout, to give the head the whole window.',
          'In the 3D pane: left-drag orbits, right-drag pans, the wheel dollies, r refits, and ' +
            '1–6 are the anterior / posterior / left / right / superior / inferior presets.',
        ],
        notes: [],
      });
      // Back to opaque for the cut.
      for (const tag of [scalpTri, compactTri, spongyTri]) {
        await setControl(page, `mesh-tag-opacity-${mesh}-${tag}`, '1');
      }

      // ---- 7 · cutting -----------------------------------------------------------------------
      await openSection(page, `mesh-clip-${mesh}`);
      await page.click(`[data-testid="mesh-clip-add-${mesh}"]`);
      await page.click(`[data-testid="mesh-clip-preset-${mesh}-0-axial"]`);
      await page.click(`[data-testid="mesh-clip-tocursor-${mesh}-0"]`);
      await setControl(page, `mesh-clip-capcolor-${mesh}`, 'tag');
      // Look up into the kept half: the axial plane keeps everything above it, so the cut face
      // points down and an anterior camera sees only scalp.
      await frame3d(page, '6', 70, 35);
      const onePlane = await page.evaluate((id: string) => {
        const l = window.__tetravox?.store.getState().layers.find((x) => x.id === id);
        return l?.kind === 'mesh' ? l.clip.planes.map((p) => p.plane) : null;
      }, mesh);
      expect(onePlane).toHaveLength(1);
      await shoot(page, '07-clip-caps.png');
      await shootPane(page, 'view3d', '07-clip-caps-closeup.png');

      // The element edges on the cap, looked at straight up the plane normal and dollied in far
      // enough to see them. At the framing above, a cut through 4.7 M tetrahedra puts several cap
      // polygons inside one pixel and a 1 px edge paints the whole disc black — true, and a
      // picture of nothing. `6` is the inferior preset, which is where the kept upper half's cap
      // faces.
      await openSection(page, `mesh-field-${mesh}`);
      await page.click(`[data-testid="mesh-edges-caps-${mesh}"]`);
      await frame3d(page, '6', 0, 0);
      await dolly3d(page, -520);
      await shootPaneCrop(page, 'view3d', '07-clip-caps-closeup-edges.png', 0.55);
      await page.click(`[data-testid="mesh-edges-caps-${mesh}"]`);
      await frame3d(page, '1', 55, -25);

      await openSection(page, `mesh-clip-${mesh}`);
      await page.click(`[data-testid="mesh-clip-add-${mesh}"]`);
      await page.click(`[data-testid="mesh-clip-preset-${mesh}-1-sagittal"]`);
      await page.click(`[data-testid="mesh-clip-tocursor-${mesh}-1"]`);
      // Look up into the kept octant, where the two caps meet.
      await frame3d(page, '6', 80, 40);
      await shootPane(page, 'view3d', '07-clip-caps-closeup-two-planes.png');
      record({
        file: '07-clip-caps.png',
        closeup: '07-clip-caps-closeup.png',
        closeups: [
          '07-clip-caps-closeup.png',
          '07-clip-caps-closeup-edges.png',
          '07-clip-caps-closeup-two-planes.png',
        ],
        title: 'Cutting the head open — clip planes with exact caps',
        what_it_shows:
          'An axial clip plane through the cursor. The cut is not a hole: every clipped element ' +
          'contributes an exact cap polygon, so the plane is closed and coloured by the tissue it ' +
          'passes through. The second close-up is dollied in with element edges on, so the ' +
          'tetrahedra the cap is made of are visible one by one. The third adds a sagittal plane — up to six are allowed, and each one clips the ' +
          'others’ caps, so the corner where they meet is a real corner.',
        data_files: ['m2m_ernie/ernie.msh', 'm2m_ernie/ernie.msh.opt'],
        layers: [
          {
            kind: 'mesh',
            name: 'ernie.msh',
            settings: {
              'clip.planes[0]': 'normal (0,0,1) through the cursor',
              'clip.planes[1]': 'normal (1,0,0) through the cursor (second close-up)',
              'clip.caps': true,
              'clip.capColorMode': 'tag',
              'edges.caps': true,
              edgeWidthPx: 1,
            },
          },
        ],
        controls_used: [
          'Clip planes section → “+ plane” adds one through the cursor; per plane there is an ' +
            'enable toggle, axial / coronal / sagittal preset buttons, three free normal fields, ' +
            'an offset slider that scrubs across the scene, flip (keep the other side), “to ' +
            'cursor” and a “follow cursor” toggle that keeps the plane on the crosshair as it ' +
            'moves.',
          'Caps row → “exact caps” on/off and the cap colour source (inherit or by tag).',
          'Field & appearance → the “caps” edge toggle and the edge width slider.',
        ],
        notes: [
          'Six planes is the ceiling; the section title carries the count.',
          'A clip plane belongs to the mesh layer. Isosurface and points layers are not clipped ' +
            'by it (see scenario 10).',
          'Element edges on the cap are only legible zoomed in: this mesh has 4.7 million ' +
            'tetrahedra, so at a whole-head framing several cap polygons share a pixel and a 1 px ' +
            'edge fills the disc solid. The dollied close-up is the one with edges on; the wide ' +
            'shots have them off.',
        ],
      });
      // Drop both planes again.
      await page.click(`[data-testid="mesh-clip-remove-${mesh}-1"]`);
      await page.click(`[data-testid="mesh-clip-remove-${mesh}-0"]`);
      await page.click('[data-testid="layout-2x2"]');
      await settle(page);

      // ---- 5 · mesh + T1 ---------------------------------------------------------------------
      await openFiles(app, page, [P.t1]);
      const t1 = await layerIdOf(page, 'volume');
      await activate(page, t1);
      await reveal(page, `volume-properties-${t1}`);
      await page.click(`[data-testid="volume-show-in-3d-${t1}"]`);
      await activate(page, mesh);
      // Hide the scalp so the slice planes inside the head are visible in 3D, and take the mesh
      // down to 45 % so the anatomy shows through its 2D fill instead of being painted over.
      await page.click(`[data-testid="mesh-tag-eye-${mesh}-${scalpTri}"]`);
      // Contours only for the window shot: an opaque tissue fill hides the anatomy it is being
      // compared against, which is the whole point of putting the two in one pane.
      await openSection(page, `mesh-cut2d-${mesh}`);
      await page.click(`[data-testid="mesh-fill2d-${mesh}"]`);
      await setControl(page, `mesh-contour-width-${mesh}`, '1.5');
      await frame3d(page, '3');
      await shoot(page, '05-mesh-over-t1.png');
      // …and the fill at 45 % in the close-up, which is the other way to read the same overlay.
      await page.click(`[data-testid="mesh-fill2d-${mesh}"]`);
      await setControl(page, `layer-opacity-${mesh}`, '0.45');
      await settle(page);
      await shootPane(page, 'sagittal', '05-mesh-over-t1-closeup.png');
      record({
        file: '05-mesh-over-t1.png',
        closeup: '05-mesh-over-t1-closeup.png',
        title: 'Mesh and volume in one scene',
        what_it_shows:
          'The head mesh and the T1 together, one depth buffer, no compositing tricks. The 2D ' +
          'panes show the T1 with the mesh’s tissue contours over it — and, in the close-up, with ' +
          'the tissue fill at 45 % as well — so a segmentation can be checked against the ' +
          'anatomy it came from. The 3D pane shows the tissue surfaces ' +
          'with the T1’s three slice planes drawn inside them — the volume layer’s “show in 3D”. ' +
          'The scalp is hidden so the planes inside the head can be seen.',
        data_files: ['m2m_ernie/ernie.msh', 'm2m_ernie/T1.nii.gz'],
        layers: [
          {
            kind: 'mesh',
            name: 'ernie.msh',
            settings: {
              colorMode: 'tag',
              contoursIn2D: true,
              contourWidthPx: 1.5,
              fillIn2D: 'off in the window shot, on at 45 % opacity in the close-up',
              'tagStyle[Scalp].visible': false,
            },
          },
          {
            kind: 'volume',
            name: 'T1.nii.gz',
            settings: { colormap: 'gray', showIn3D: true },
          },
        ],
        controls_used: [
          'Open… → add the T1 to the scene the mesh is already in.',
          'Volume editor → “show in 3D” draws that volume’s three slice planes in the 3D pane.',
          'Tissue table → the eye on the Scalp row.',
          '2D cross-section section → the fill toggle off (contours only) and the contour width; ' +
            'the layer row’s opacity slider → 45 % for the translucent fill in the close-up.',
        ],
        notes: [
          'Layer order decides what is on top in the 2D panes; the ▲▼ buttons on a layer row (or ' +
            'Ctrl+↑/↓) change it.',
        ],
      });
      await page.click(`[data-testid="mesh-tag-eye-${mesh}-${scalpTri}"]`);
      await setControl(page, `layer-opacity-${mesh}`, '1');

      // ---- 12 · electrodes -------------------------------------------------------------------
      const eegText = await readFile(P.eeg, 'utf8');
      const electrodes = await page.evaluate(
        async ([meshLayerId, text]: [string, string]) => {
          const tv = window.__tetravox;
          const engine = tv?.engine;
          if (engine == null || tv == null) throw new Error('no engine');
          const layer = tv.store.getState().layers.find((l) => l.id === meshLayerId);
          if (layer === undefined) throw new Error('no mesh layer');
          // The SimNIBS eeg_positions shape: `type,x,y,z,name`, world mm, no header. The engine
          // ships this parser (`derived/points-source.ts`); nothing in the app calls it, so the
          // E2E does the same parse here and hands the points to `addLayer`.
          const points: { name: string; position: [number, number, number] }[] = [];
          for (const raw of text.split(/\r?\n/)) {
            const cols = raw.trim().split(',');
            if (cols.length < 4) continue;
            if (!/^(electrode|referenceelectrode)$/i.test((cols[0] ?? '').trim())) continue;
            const xyz = [Number(cols[1]), Number(cols[2]), Number(cols[3])];
            if (!xyz.every((v) => Number.isFinite(v))) continue;
            points.push({
              name: (cols[4] ?? '').trim(),
              position: xyz as [number, number, number],
            });
          }
          const added = engine.addLayer({
            datasetId: layer.datasetId,
            kind: 'points',
            name: 'GSN-HydroCel-185.csv',
            points,
            shape: 'sphere',
            radiusMm: 4,
            color: [1, 0.85, 0.2, 1],
            showLabels: false,
          });
          engine.requestRender();
          await engine.whenSettled();
          return { id: added.id, count: points.length };
        },
        [mesh, eegText] as [string, string]
      );
      expect(electrodes.count).toBeGreaterThan(100);
      await page.click('[data-testid="layout-3d-only"]');
      // The T1 out of the way: its `showIn3D` planes were the point of scenario 5 and are
      // clutter in front of an electrode net.
      await activate(page, t1);
      await reveal(page, `volume-properties-${t1}`);
      await page.click(`[data-testid="volume-show-in-3d-${t1}"]`);
      await page.click(`[data-testid="layer-eye-${t1}"]`);
      await activate(page, electrodes.id);
      await reveal(page, `points-properties-${electrodes.id}`);
      await frame3d(page, '3', 40, -60);
      await shoot(page, '12-electrodes.png');
      await shootPane(page, 'view3d', '12-electrodes-closeup.png');
      record({
        file: '12-electrodes.png',
        closeup: '12-electrodes-closeup.png',
        title: 'An EEG net on the scalp',
        what_it_shows:
          `All ${electrodes.count} electrodes of a SimNIBS EEG net as spheres on the head surface, ` +
          'over the tissue mesh in 3D. The points editor on the left lists every electrode with a ' +
          'colour swatch, its world coordinate, a per-point radius and a → button that jumps the ' +
          'crosshair to it, with a search box for finding one by name in a 185-row net.',
        data_files: ['m2m_ernie/ernie.msh', 'm2m_ernie/eeg_positions/GSN-HydroCel-185.csv'],
        layers: [
          { kind: 'mesh', name: 'ernie.msh', settings: { colorMode: 'tag' } },
          {
            kind: 'points',
            name: 'GSN-HydroCel-185.csv',
            settings: {
              points: electrodes.count,
              shape: 'sphere',
              radiusMm: 4,
              color: 'amber (the default for things drawn over anatomy)',
              showLabels: false,
            },
          },
        ],
        controls_used: [
          'Points editor: shape (sphere or dot), a labels toggle, the radius slider, the layer ' +
            'colour and opacity, a search box, and per row a swatch, a radius and a → that moves ' +
            'the cursor to that electrode.',
        ],
        notes: [
          'LIMITATION — no shipped UI opens an electrode file. The engine parses SimNIBS ' +
            'eeg_positions CSV, generic x,y,z[,name] CSV and JSON point lists, but the Open path ' +
            'only ever builds a volume or a mesh layer, so nothing calls that parser. This capture ' +
            'parsed the CSV in the test and created the layer through the engine facade.',
          'Points are billboarded spheres and are not clipped by a mesh layer’s clip planes.',
        ],
      });

      // ---- 13 · a cortical surface ------------------------------------------------------------
      await activate(page, t1);
      await page.click(`[data-testid="layer-eye-${t1}"]`);
      await page.click('[data-testid="layout-2x2"]');
      await openFiles(app, page, [P.pial]);
      const pial = await layerIdOf(page, 'mesh', 1);
      const labelModes = await page.evaluate((id: string) => {
        const state = window.__tetravox?.store.getState();
        const layer = state?.layers.find((l) => l.id === id);
        const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
        if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh');
        return {
          hasLabelTable: Object.keys(ds.labelTables ?? {}).length > 0,
          fields: ds.fields.map((f) => f.name),
        };
      }, pial);
      // Hide the head mesh and the electrode net, so the pial surface is what the 3D pane shows.
      await activate(page, mesh);
      await page.click(`[data-testid="layer-eye-${mesh}"]`);
      await activate(page, electrodes.id);
      await page.click(`[data-testid="layer-eye-${electrodes.id}"]`);
      await activate(page, pial);
      await reveal(page, `mesh-properties-${pial}`);
      await frame3d(page);
      await shoot(page, '13-cortical-surface.png');
      await dolly3d(page, -260);
      await shootPane(page, 'view3d', '13-cortical-surface-closeup.png');
      await dolly3d(page, 260);
      await shootPane(page, 'axial', '13-cortical-surface-closeup-contour.png');
      record({
        file: '13-cortical-surface.png',
        closeup: '13-cortical-surface-closeup.png',
        closeups: ['13-cortical-surface-closeup.png', '13-cortical-surface-closeup-contour.png'],
        title: 'A cortical surface, and its outline on the slices',
        what_it_shows:
          'The left pial surface from a GIfTI file in the 3D pane, and its intersection with each ' +
          '2D plane drawn as a contour over the T1 — the same cross-section machinery the head ' +
          'mesh uses, on a surface with no volume elements at all.',
        data_files: [
          'm2m_ernie/surfaces/lh.pial.gii',
          'm2m_ernie/T1.nii.gz',
          'm2m_ernie/segmentation/lh.ernie_DK40.annot (NOT loaded — see notes)',
        ],
        layers: [
          {
            kind: 'mesh',
            name: 'lh.pial.gii',
            settings: {
              colorMode: 'tag',
              contoursIn2D: true,
              fillIn2D: true,
              'label.table': labelModes.hasLabelTable ? 'present' : 'absent',
            },
          },
          { kind: 'volume', name: 'T1.nii.gz', settings: { colormap: 'gray' } },
        ],
        controls_used: [
          'Open… → lh.pial.gii.',
          'The layer row’s eye hides the head mesh and the electrode net, so the surface is what ' +
            'the 3D pane shows.',
          '2D cross-section section → fill and contours are both on by default; a surface has no ' +
            'volume elements to fill, so what a 2D pane gets from it is the contour.',
        ],
        notes: [
          'LIMITATION — the DK40 annotation could not be attached. A .annot carries a colortable ' +
            'and one label per vertex, and the mesh reader in the Rust crate parses that format; ' +
            'but the loader entry point the app calls takes only a mesh file, a .msh.opt and a ' +
            'LUT, and it fills a surface’s label table from a .label.gii’s own <LabelTable> only. ' +
            'There is no path — dialog, sidecar or engine call — that hands lh.ernie_DK40.annot ' +
            'to lh.pial.gii, so “colour by label” has no table to use here and the surface is ' +
            'drawn in its tag colour instead. The colour-by-label mode itself works: it is proved ' +
            'on a .label.gii in the engine’s own golden tests.',
          'Consequently there is no outline-mode close-up for the annotation either; outline mode ' +
            'is a label-colouring option and needs the table.',
        ],
      });
    } finally {
      await app.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  // Group E — a field on a mesh: isolation, field colouring, isosurfaces.
  // ----------------------------------------------------------------------------------------------

  test('E — element isolation, field colouring and isosurfaces', async ({}, info) => {
    test.setTimeout(1_800_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target);
    try {
      // The grey-matter mesh first, and not only because scenario 09b needs it: the isolation
      // threshold below has to be a percentile of TI_max **over grey matter**, and the only place
      // that distribution exists is this file. The 95th percentile of the field over the whole
      // head is 0.474 V/m — above almost every grey-matter element, because the loud end of the
      // field is at the electrodes — so isolating on it leaves an empty pane.
      await openFiles(app, page, [P.greyThalamusTi]);
      const grey = await layerIdOf(page, 'mesh', 0);
      const gmField = await page.evaluate((id: string) => {
        const state = window.__tetravox?.store.getState();
        const layer = state?.layers.find((l) => l.id === id);
        const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
        if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh');
        const f = ds.fields.find((x) => x.name === 'TI_max');
        if (f === undefined) throw new Error('no TI_max');
        return { p95: f.stats.percentiles['95'], max: f.stats.max, min: f.stats.min };
      }, grey);
      await activate(page, grey);
      await page.click(`[data-testid="layer-eye-${grey}"]`);

      await openFiles(app, page, [P.thalamusTi]);
      const full = await layerIdOf(page, 'mesh', 1);
      const centre = await boundsCentre(page, full);
      await jumpTo(page, centre);
      await activate(page, full);

      // ---- 9 · field colouring ---------------------------------------------------------------
      await openSection(page, `mesh-field-${full}`);
      await setControl(page, `mesh-fieldname-${full}`, 'elm:TI_max');
      await waitForField(page, full, 'TI_max');
      await setControl(page, `mesh-colormode-${full}`, 'field');
      await setControl(page, `mesh-colormap-${full}`, 'jet');
      await page.click(`[data-testid="mesh-flat-${full}"]`);
      await setControl(page, `mesh-cut-color-${full}`, 'elm:TI_max');
      // The field's own min…max is 1.09e-12 … 10.29 and its 99th percentile is two orders of
      // magnitude below the top, so the default range paints the whole head the bottom colour of
      // the ramp. Re-ranged onto 0 … p99, which is where the field actually lives.
      const fullField = await page.evaluate((id: string) => {
        const state = window.__tetravox?.store.getState();
        const layer = state?.layers.find((l) => l.id === id);
        const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
        if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh');
        const f = ds.fields.find((x) => x.name === 'TI_max');
        if (f === undefined) throw new Error('no TI_max');
        return { p99: f.stats.percentiles['99'], max: f.stats.max };
      }, full);
      await setControl(page, `mesh-scale-lo-${full}`, '0');
      await setControl(page, `mesh-scale-hi-${full}`, String(fullField.p99));
      // A clip plane so the field is visible on the caps too.
      await openSection(page, `mesh-clip-${full}`);
      await page.click(`[data-testid="mesh-clip-add-${full}"]`);
      await page.click(`[data-testid="mesh-clip-preset-${full}-0-coronal"]`);
      await page.click(`[data-testid="mesh-clip-tocursor-${full}-0"]`);
      await frame3d(page, '1');
      await shoot(page, '09-field-colouring.png');
      await shootPane(page, 'view3d', '09-field-colouring-closeup.png');
      await shootPane(page, 'axial', '09-field-colouring-closeup-2d.png');

      // ---- 8 · element isolation --------------------------------------------------------------
      const gm = await tagById(page, full, 2, 'tet');
      const gmTet = gm.id;
      // The coronal plane belongs to scenario 09; the isolated blob gets an axial one of its own.
      await openSection(page, `mesh-clip-${full}`);
      await page.click(`[data-testid="mesh-clip-remove-${full}-0"]`);
      await openSection(page, `mesh-isolate-${full}`);
      await page.click(`[data-testid="mesh-isolate-tag-${full}-${gmTet}"]`);
      await setControl(page, `mesh-isolate-field-${full}`, 'elm:TI_max');
      await setControl(page, `mesh-isolate-field-lo-${full}`, String(gmField.p95));
      await setControl(page, `mesh-isolate-field-hi-${full}`, String(gmField.max));
      await setControl(page, `mesh-isolate-combine-${full}`, 'all');
      // Re-range the colour map over what is left. The layer's scale is still the whole field's
      // 1.09e-12 … 10.29, so every isolated element would land in the bottom pixel of the ramp.
      await openSection(page, `mesh-field-${full}`);
      await setControl(page, `mesh-scale-lo-${full}`, String(gmField.p95));
      await setControl(page, `mesh-scale-hi-${full}`, String(gmField.max));
      await settle(page);
      await openSection(page, `mesh-clip-${full}`);
      await page.click(`[data-testid="mesh-clip-add-${full}"]`);
      await page.click(`[data-testid="mesh-clip-preset-${full}-0-axial"]`);
      await page.click(`[data-testid="mesh-clip-tocursor-${full}-0"]`);
      await settle(page);
      await page.click('[data-testid="layout-3d-only"]');
      await frame3d(page, '1');
      await dolly3d(page, -300);
      await shoot(page, '08-element-isolation.png');
      await shootPane(page, 'view3d', '08-element-isolation-closeup.png');
      record({
        file: '08-element-isolation.png',
        closeup: '08-element-isolation-closeup.png',
        title: 'Isolating the elements that matter',
        what_it_shows:
          `Only the grey-matter tetrahedra whose TI_max is in the top 5 % of the grey-matter ` +
          `distribution (${gmField.p95.toFixed(3)} … ${gmField.max.toFixed(3)} V/m), extracted ` +
          'from a 4.7-million-element head mesh and drawn on its own in 3D with an axial clip ' +
          'plane through it — 5 % of 1.34 million grey-matter tetrahedra, which is a diffuse ' +
          'cloud rather than a tidy focus, because that is what a TI field in grey matter is. ' +
          'The isolation ' +
          'is a mask over the elements, not a new file: everything else about the layer — the ' +
          'field colouring, the caps, the cross-sections — keeps working on what is left.',
        data_files: ['Simulations/Thalamus/TI/mesh/Thalamus_TI.msh'],
        layers: [
          {
            kind: 'mesh',
            name: 'Thalamus_TI.msh',
            settings: {
              colorMode: 'field',
              field: 'TI_max (element field)',
              colormap: 'jet',
              flatShading: true,
              'isolate.tags': [`${gmTet} (${gm.name}) — ${gm.count.toLocaleString()} tets`],
              'isolate.field': `TI_max ${gmField.p95.toFixed(4)} … ${gmField.max.toFixed(4)}`,
              'isolate.combine': 'all (both clauses must hold)',
              scale:
                `linear ${gmField.p95.toFixed(4)} … ${gmField.max.toFixed(4)} — the ` +
                'range of what is left, not of the whole field',
              'clip.planes[0]': 'axial, through the cursor',
              'clip.caps': true,
            },
          },
        ],
        controls_used: [
          'Isolation section: one button per tissue tag; a field selector with a low/high pair; ' +
            '“at cursor” builds a sphere of a given radius around the crosshair; “set” builds a ' +
            'box around it and “bbox” takes the whole mesh; a label-volume clause picks regions ' +
            'from any atlas open in the scene. “Combine” is all (∩) or any (∪), and “clear” drops ' +
            'the lot.',
          'Clip planes section → “+ plane”, the axial preset, “to cursor”.',
          'Field & appearance → the scale’s lo / hi, re-ranged over what the isolation left, so ' +
            'the colour map spends its whole ramp on it.',
        ],
        notes: [
          'The threshold is the 95th percentile of TI_max **over grey matter**, read off ' +
            'grey_Thalamus_TI.msh, which is the same field restricted to the same elements. The ' +
            '95th percentile of the field over the whole head is 0.474 V/m — the loud end of a TI ' +
            'field is at the electrodes — and isolating grey matter on that number leaves an ' +
            'empty pane. 95 rather than 90 because 95 is a percentile the statistics block ' +
            'carries; the low/high fields take any number typed into them.',
          'This mesh’s tissue tags have no names: a SimNIBS *simulation* mesh’s .msh.opt carries ' +
            'the Gmsh view block and the tag colours but no Physical Volume lines, so the ' +
            'isolation panel and the tissue table label them “tag 1” … “tag 1099”. Tag 2 is grey ' +
            'matter in the SimNIBS numbering. The head mesh (m2m_ernie/ernie.msh.opt) does carry ' +
            'the names — scenario 04.',
        ],
      });
      record({
        file: '09-field-colouring.png',
        closeup: '09-field-colouring-closeup.png',
        closeups: ['09-field-colouring-closeup.png', '09-field-colouring-closeup-2d.png'],
        title: 'Colouring a mesh by a simulated field',
        what_it_shows:
          'The same head mesh coloured by its TI_max element field instead of by tissue: the ' +
          'surface, the exact cap polygons of a coronal clip plane, and the 2D cross-sections in ' +
          'all three panes, all reading the same field through the same colour map and the same ' +
          'range, with one colour bar for the layer. Flat shading is on, so each element is a flat ' +
          'facet of its own value rather than a smoothed interpolation of its neighbours.',
        data_files: [
          'Simulations/Thalamus/TI/mesh/Thalamus_TI.msh',
          'Simulations/Thalamus/TI/mesh/Thalamus_TI.msh.opt (found beside it)',
        ],
        layers: [
          {
            kind: 'mesh',
            name: 'Thalamus_TI.msh',
            settings: {
              colorMode: 'field',
              field: 'TI_max (element field, magnitude)',
              colormap: 'jet',
              scale:
                `linear 0 … ${fullField.p99.toFixed(4)} (the field's 99th percentile; its own ` +
                `min…max is 1.09e-12 … ${fullField.max.toFixed(2)})`,
              flatShading: true,
              'cut colour': 'TI_max',
              'clip.capColorMode': 'inherit (so the caps carry the field)',
              showColorbar: true,
            },
          },
        ],
        controls_used: [
          'Field & appearance section: “colour by” (tissue tag / field / solid / label), the field ' +
            'selector, the component selector for a vector field, the colour map, a linear or ' +
            'heat scale with its bounds, a min–max button, the threshold pair with a |v| toggle ' +
            'and a soft-edge slider, flat/smooth shading, two-sided or back-face culling, and the ' +
            'surface/caps edge toggles with a width and colour.',
          '2D cross-section section → “cut colour” set to the same field, so the slices are ' +
            'coloured by it too.',
          'Toolbar → Bars shows the colour bar; it carries the units and the threshold notch.',
        ],
        notes: [
          'Switching to an element field is a one-off load, not an instant toggle: the worker ' +
            'builds a de-indexed copy of the geometry the first time, with a pending badge beside ' +
            'the selector, and every later switch is free.',
        ],
      });

      // ---- 9b · the GM-only mesh --------------------------------------------------------------
      await page.click('[data-testid="layout-2x2"]');
      await activate(page, full);
      await page.click(`[data-testid="mesh-isolate-clear-${full}"]`);
      await page.click(`[data-testid="layer-eye-${full}"]`);
      await activate(page, grey);
      await page.click(`[data-testid="layer-eye-${grey}"]`);
      await openSection(page, `mesh-field-${grey}`);
      await setControl(page, `mesh-fieldname-${grey}`, 'elm:TI_max');
      await waitForField(page, grey, 'TI_max');
      await setControl(page, `mesh-colormode-${grey}`, 'field');
      await setControl(page, `mesh-colormap-${grey}`, 'jet');
      await frame3d(page, '1');
      await shoot(page, '09-field-colouring-grey-only.png');
      record({
        file: '09-field-colouring-grey-only.png',
        title: 'The same field on a grey-matter-only mesh',
        what_it_shows:
          'grey_Thalamus_TI.msh carries 1.34 million tetrahedra and **no triangles at all** — it ' +
          'ships no surface of its own. The viewer extracts the boundary of the tet block and ' +
          'draws that, so the same TI_max field appears on a mesh that a renderer expecting a ' +
          'surface would show as an empty view.',
        data_files: ['Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh'],
        layers: [
          {
            kind: 'mesh',
            name: 'grey_Thalamus_TI.msh',
            settings: {
              colorMode: 'field',
              field: 'TI_max (element field)',
              colormap: 'jet',
              'nTris in the file': 0,
              surface: 'extracted from the tet boundary at load',
            },
          },
        ],
        controls_used: [
          'Open… → grey_Thalamus_TI.msh. Nothing else: the boundary extraction is automatic.',
          'Field & appearance → colour by field, TI_max, jet.',
        ],
        notes: [],
      });

      // ---- 10 · isosurfaces --------------------------------------------------------------------
      await openFiles(app, page, [P.finalTissues]);
      const tissuesVol = await layerIdOf(page, 'volume', 0);
      const isoIds = await page.evaluate(
        async ([meshLayerId, volLayerId]: [string, string]) => {
          const tv = window.__tetravox;
          const engine = tv?.engine;
          if (engine == null || tv == null) throw new Error('no engine');
          const state = tv.store.getState();
          const meshLayer = state.layers.find((l) => l.id === meshLayerId);
          const volLayer = state.layers.find((l) => l.id === volLayerId);
          const meshDs = state.datasets.find((d) => d.id === meshLayer?.datasetId);
          if (meshLayer === undefined || volLayer === undefined) throw new Error('no layers');
          if (meshDs?.kind !== 'mesh') throw new Error('no mesh dataset');
          const f = meshDs.fields.find((x) => x.name === 'TI_max');
          const iso = f?.stats.percentiles['95'] ?? 0.2;
          const fieldIso = engine.addLayer({
            datasetId: meshLayer.datasetId,
            kind: 'iso',
            name: `TI_max = ${iso.toFixed(3)}`,
            source: {
              datasetId: meshLayer.datasetId,
              field: { source: 'elm', name: 'TI_max', component: 'mag' },
            },
            iso,
            color: [1, 0.35, 0.15, 1],
            smooth: true,
            faceMode: 'cull',
          });
          // final_tissues is a label volume: 7 is compact bone in the SimNIBS numbering, so an
          // isovalue of 6.5 encloses bone and everything above it.
          const boneIso = engine.addLayer({
            datasetId: volLayer.datasetId,
            kind: 'iso',
            name: 'final_tissues ≥ 6.5',
            source: { datasetId: volLayer.datasetId, volumeIndex: 0 },
            iso: 6.5,
            color: [0.9, 0.88, 0.82, 1],
            smooth: false,
            faceMode: 'cull',
          });
          // The skull encloses everything else in the scene, so the two isosurfaces are
          // photographed one at a time — `opacity` cannot help here: an isosurface is drawn in the
          // opaque pass, so the value is stored and never reaches a blend.
          engine.updateLayer(boneIso.id, { visible: false });
          engine.updateLayer(volLayerId, { visible: false });
          engine.requestRender();
          await engine.whenSettled();
          return { field: fieldIso.id, bone: boneIso.id, iso };
        },
        [grey, tissuesVol] as [string, string]
      );
      // A clip plane on the mesh layer, to show that the isosurfaces are NOT clipped by it.
      await activate(page, grey);
      await openSection(page, `mesh-clip-${grey}`);
      await page.click(`[data-testid="mesh-clip-add-${grey}"]`);
      await page.click(`[data-testid="mesh-clip-preset-${grey}-0-sagittal"]`);
      await page.click(`[data-testid="mesh-clip-tocursor-${grey}-0"]`);
      await page.click('[data-testid="layout-3d-only"]');
      await frame3d(page, '1');
      await shoot(page, '10-isosurfaces.png');
      // The marching-tets surface on its own, with the mesh it came out of hidden.
      await activate(page, grey);
      await page.click(`[data-testid="layer-eye-${grey}"]`);
      await settle(page);
      await shootPane(page, 'view3d', '10-isosurfaces-closeup-field.png');

      // The other extractor, on its own: marching cubes over a label volume.
      await activate(page, isoIds.field);
      await page.click(`[data-testid="layer-eye-${isoIds.field}"]`);
      await activate(page, isoIds.bone);
      await page.click(`[data-testid="layer-eye-${isoIds.bone}"]`);
      await settle(page);
      await shootPane(page, 'view3d', '10-isosurfaces-closeup-bone.png');
      record({
        file: '10-isosurfaces.png',
        closeup: '10-isosurfaces-closeup-field.png',
        closeups: ['10-isosurfaces-closeup-field.png', '10-isosurfaces-closeup-bone.png'],
        title: 'Isosurfaces — from a mesh field and from a volume',
        what_it_shows:
          `Two isosurfaces, one per extractor. The window and the first close-up are the ` +
          `TI_max = ${isoIds.iso.toFixed(3)} V/m surface pulled out of the grey-matter mesh's ` +
          'element field by **marching tetrahedra**, sitting inside the grey-matter mesh with a ' +
          'sagittal clip plane through it: the mesh is cut and the isosurface is not, because a ' +
          'clip plane belongs to a mesh layer. The second close-up is the bone surface pulled out ' +
          'of final_tissues.nii.gz by **marching cubes**. Both are real geometry in the same ' +
          'depth buffer as the mesh, so they occlude and are occluded correctly — which is also ' +
          'why they are photographed one at a time: the skull encloses everything else.',
        data_files: [
          'Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh',
          'm2m_ernie/final_tissues.nii.gz',
        ],
        layers: [
          {
            kind: 'iso',
            name: `TI_max = ${isoIds.iso.toFixed(3)}`,
            settings: {
              source: 'grey_Thalamus_TI.msh, elm field TI_max (marching tets)',
              iso: isoIds.iso,
              smooth: true,
              faceMode: 'cull',
            },
          },
          {
            kind: 'iso',
            name: 'final_tissues ≥ 6.5',
            settings: {
              source: 'final_tissues.nii.gz, volume 0 (marching cubes)',
              iso: 6.5,
              smooth: false,
              faceMode: 'cull',
              visible: 'off for the window shot and the first close-up, on for the second',
            },
          },
          {
            kind: 'mesh',
            name: 'grey_Thalamus_TI.msh',
            settings: { colorMode: 'field', 'clip.planes[0]': 'sagittal, through the cursor' },
          },
        ],
        controls_used: [
          'Isosurface editor: the isovalue field with the source field’s range beside it, the ' +
            'colour swatch, a smooth/flat toggle and the face-culling toggle, plus the layer row’s ' +
            'own eye and opacity.',
        ],
        notes: [
          'LIMITATION — no shipped UI creates an isosurface layer. The editor for one exists and ' +
            'so do both extractors, but nothing in the toolbar or the layer panel adds an “iso” ' +
            'layer, so these two were created through the engine facade. The isovalue seeds from ' +
            'the source’s own 98th percentile (0.5 for a label volume) when one is created.',
          'LIMITATION — an isosurface is not clipped. Clip planes belong to a mesh layer; the ' +
            'sagittal plane in this capture cuts the grey-matter mesh and leaves the isosurface ' +
            'whole. That is visible in the picture and is not a rendering error.',
          'LIMITATION — an isosurface layer’s opacity does nothing. Isosurfaces are drawn in the ' +
            'opaque 3D pass with blending off, so the layer row’s opacity slider is stored and ' +
            'never reaches the frame. Setting the skull to 30 % to show the field surface inside ' +
            'it changes nothing, which is why the two are captured separately.',
        ],
      });
    } finally {
      await app.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  // Group F — the vector field.
  // ----------------------------------------------------------------------------------------------

  test('F — E-field glyphs on the cut plane', async ({}, info) => {
    test.setTimeout(1_800_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target);
    try {
      await openFiles(app, page, [P.tdcs]);
      const layer = await layerIdOf(page, 'mesh');
      const centre = await boundsCentre(page, layer);
      await jumpTo(page, centre);
      await activate(page, layer);

      // Every tissue back on: this file's own `.msh.opt` hides all but grey matter (SimNIBS
      // writes it so Gmsh opens on the GM surface with the field painted on it), and §7.6 honours
      // that on open. A head with a cut through it is the picture this scenario is about.
      await reveal(page, `mesh-tissue-list-${layer}`);
      await page.click(`[data-testid="mesh-tissue-showall-${layer}"]`);

      // A cut plane first, so the glyphs have one to be restricted to. Flipped, so the kept half
      // is the lower one and the cut face is what the superior camera looks down at — arrows on a
      // cut plane are inside the head, and an opaque half in front of them shows nothing.
      await openSection(page, `mesh-clip-${layer}`);
      await page.click(`[data-testid="mesh-clip-add-${layer}"]`);
      await page.click(`[data-testid="mesh-clip-preset-${layer}-0-axial"]`);
      await page.click(`[data-testid="mesh-clip-tocursor-${layer}-0"]`);
      await page.click(`[data-testid="mesh-clip-flip-${layer}-0"]`);
      await setControl(page, `mesh-clip-capcolor-${layer}`, 'tag');

      await openSection(page, `mesh-glyphs-${layer}`);
      await page.click(`[data-testid="mesh-glyphs-enabled-${layer}"]`);
      await setControl(page, `mesh-glyph-shape-${layer}`, 'arrow');
      await setControl(page, `mesh-glyph-origins-${layer}`, 'volume');
      await setControl(page, `mesh-glyph-stridemode-${layer}`, 'everyNth');
      await setControl(page, `mesh-glyph-stride-${layer}`, '600');
      // **Fixed** length, not scaled by magnitude. `byMagnitude` scales against the field's own
      // maximum, and this field's maximum is 57.8 V/m under an electrode against ~0.05 V/m in the
      // brain — so every interior arrow comes out a thousandth of a millimetre long and the whole
      // interior renders empty. Magnitude goes into the colour instead, where the dynamic range
      // is the colour map's problem rather than the rasteriser's.
      await setControl(page, `mesh-glyph-scale-${layer}`, 'fixed');
      await setControl(page, `mesh-glyph-length-${layer}`, '6');
      await setControl(page, `mesh-glyph-colorby-${layer}`, 'magnitude');
      await page.click(`[data-testid="mesh-glyph-cliptocut-${layer}"]`);
      // A colour map whose *low* end is bright. Glyph colouring is baked over `0 … field max`
      // and takes no range of its own, so on a field that reaches 57.8 V/m under an electrode
      // every arrow in the brain sits in the bottom percent of the ramp; `cool` starts at cyan,
      // where `viridis` starts at near-black.
      await openSection(page, `mesh-field-${layer}`);
      await setControl(page, `mesh-colormap-${layer}`, 'cool');
      await settle(page);
      const summary = await page.locator(`[data-testid="mesh-glyph-summary-${layer}"]`).innerText();
      await page.click('[data-testid="layout-3d-only"]');
      await frame3d(page, '5', 30, -15);
      await dolly3d(page, -260);
      // The cut face first, with every tissue on: this is the context the arrows live in, and the
      // caps are opaque, so it is also the picture in which no arrow can be seen.
      await shootPaneCrop(page, 'view3d', '11-vector-glyphs-closeup-caps.png', 0.7);

      // Now the arrows. Hiding the **surface** tags (1001…) empties the pane of geometry while
      // leaving the **volume** tags (1…) visible, and the volume tags are what the glyph origins
      // are filtered by — "Hide all" would take those too and the glyphs with them. The caps go
      // off for the same reason: they are drawn at the plane, in front of everything near it.
      const triTags = await page.evaluate((id: string) => {
        const state = window.__tetravox?.store.getState();
        const l = state?.layers.find((x) => x.id === id);
        const ds = state?.datasets.find((d) => d.id === l?.datasetId);
        if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh');
        return ds.tags.filter((t) => t.kind === 'tri').map((t) => t.id);
      }, layer);
      expect(triTags.length).toBeGreaterThan(0);
      await reveal(page, `mesh-tissue-list-${layer}`);
      for (const tag of triTags) {
        await page.click(`[data-testid="mesh-tag-eye-${layer}-${tag}"]`);
      }
      await openSection(page, `mesh-clip-${layer}`);
      await page.click(`[data-testid="mesh-clip-caps-${layer}"]`);
      await dolly3d(page, -260);
      await shootPaneCrop(page, 'view3d', '11-vector-glyphs-closeup.png', 0.7);
      await dolly3d(page, 520);
      await shoot(page, '11-vector-glyphs.png');
      record({
        file: '11-vector-glyphs.png',
        closeup: '11-vector-glyphs-closeup.png',
        closeups: ['11-vector-glyphs-closeup.png', '11-vector-glyphs-closeup-caps.png'],
        title: 'The electric field as arrows',
        what_it_shows:
          'The E vector field of a tDCS simulation drawn as arrows: one arrow per tetrahedron, ' +
          'subsampled to every 600th, 6 mm long, coloured by magnitude. The first close-up is ' +
          'the axial cut with every tissue on — the exact caps coloured by tissue, which is the ' +
          'context the arrows sit in and also the reason no arrow can be seen in it. The second ' +
          'is the same scene with the tissue **surfaces** hidden and the caps off, which is what ' +
          `it takes to see inside. The panel reports the stride as “${summary.trim()}”.`,
        data_files: [
          'Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh (E, 3 components, ' +
            'over all 5,900,498 elements)',
        ],
        layers: [
          {
            kind: 'mesh',
            name: 'ernie_TDCS_1_scalar.msh',
            settings: {
              colorMode: 'tag',
              'clip.planes[0]': 'axial, through the cursor',
              'clip.capColorMode': 'tag',
              'glyphs.field': 'E (element field, 3 components)',
              'glyphs.shape': 'arrow',
              'glyphs.origins': 'volume — one per tet',
              'glyphs.subsample': 'every 600th',
              'glyphs.scale': 'fixed',
              'glyphs.lengthMm': 6,
              'glyphs.colorBy': 'magnitude (over 0 … the field’s own max, 57.79 V/m)',
              colormap: 'cool — its low end is bright, which is where this field lives',
              'glyphs.clipToCutPlane': true,
            },
          },
        ],
        controls_used: [
          'Clip planes section → “+ plane”, the axial preset, “to cursor”.',
          'Glyphs section → the on/off toggle in its header (greyed out on a mesh with no vector ' +
            'field), then the field, shape (arrow or line), origins (one per surface triangle or ' +
            'one per tetrahedron), the stride mode with its number, fixed or magnitude scaling, ' +
            'the length in millimetres, colouring by magnitude or a solid colour, and “to cut ' +
            'plane”.',
          'Tissue table → “Show all”, then the eye on each surface tag, so the arrows inside the ' +
            'head are not behind it.',
        ],
        notes: [
          'Only vector fields appear in the glyph selector — a scalar has no direction, and the ' +
            'section says so instead of offering a control that would draw nothing.',
          'Volume origins are one per tetrahedron: the only way the interior of a 4.7-million-tet ' +
            'mesh gets arrows at all. The stride is what keeps that from shipping millions of ' +
            'origins.',
          'This file’s own .msh.opt hides every tissue but grey matter (SimNIBS writes it so Gmsh ' +
            'opens on the GM surface), and the viewer honours it on open. “Show all” in the ' +
            'tissue table is what puts the head back.',
          'The glyph origins are filtered by the **volume** tags, so “Hide all” in the tissue ' +
            'table takes the arrows with it. Hiding only the surface tags (1001…) empties the ' +
            'pane of geometry and leaves the arrows — which is what the second close-up does.',
          'BUG — “Restrict to cut plane” does nothing. `GlyphSpec.clipToCutPlane` is on the ' +
            'layer, the toggle writes it and the shader’s own documentation quotes the ' +
            'requirement, but no code path reads it: the arrows in these captures fill the whole ' +
            'volume rather than the elements the plane intersects.',
          'Glyph colouring takes no range of its own: it is baked over 0 … the field’s maximum, ' +
            'so the layer’s own scale lo/hi does not move it. On a field whose maximum is 1000× ' +
            'its typical interior value, that puts every interior arrow in the bottom of the ' +
            'ramp — hence the colour map chosen for its bright low end.',
          'A magnitude-scaled arrow is invisible here. `scale: "byMagnitude"` measures against the ' +
            'field’s maximum — 57.8 V/m under an electrode — so a 0.05 V/m arrow in the brain is ' +
            '0.007 mm long. The scenario uses fixed length and puts the magnitude in the colour.',
        ],
      });
    } finally {
      await app.close();
    }
  });
});
