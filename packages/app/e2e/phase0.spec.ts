/**
 * The Phase-0 gate, end to end (ROADMAP Phase-0 gate items 2, 3 and 9).
 *
 * Runs twice: `--project=dev` against the electron-vite build, `--project=packaged` against the
 * electron-builder artefact. Gate item 2 is specifically about the **packaged** artefact.
 *
 * Every number asserted here is recomputed in `expected.ts` from the algorithm in
 * `crates/tvx-wasm/src/lib.rs`, never read back from a previous run (§11 rule 0).
 */

// Playwright parses the first parameter of a test/hook body to decide which fixtures to build, and
// rejects anything that is not an object pattern with "First argument must use the object
// destructuring pattern". `({}, testInfo)` is therefore mandatory, not stylistic.
/* eslint-disable no-empty-pattern */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DropRecord, Phase0Report } from '../src/renderer/src/phase0';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { FIXTURE_BYTES, tvxPing, tvxPingBytes } from './expected';
import { decodePng, pixelAt } from './png';

const PING_SEED = 0x54565830;
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const BACKGROUND = [11, 11, 15, 255];

const EXPECTED_PING = tvxPing(PING_SEED);
const EXPECTED_COLOR: [number, number, number] = [
  (EXPECTED_PING >>> 16) & 0xff,
  (EXPECTED_PING >>> 8) & 0xff,
  EXPECTED_PING & 0xff,
];
const EXPECTED_DIGEST = tvxPingBytes(FIXTURE_BYTES);

/** Wait for the renderer to finish the worker round-trip and the first frame. */
async function readReport(page: Page): Promise<Phase0Report> {
  await page.waitForFunction(() => window.__tetravox_phase0 !== undefined, undefined, {
    timeout: 30_000,
  });
  const report = await page.evaluate(() => window.__tetravox_phase0);
  if (report === undefined) throw new Error('__tetravox_phase0 never appeared');
  if (!report.ok) throw new Error(`phase 0 failed in the renderer: ${report.error}`);
  return report;
}

test.describe('Phase-0 walking skeleton', () => {
  let app: ElectronApplication;
  let page: Page;
  let report: Phase0Report;

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target);
    page = await app.firstWindow();
    report = await readReport(page);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the renderer is served from the privileged tetravox:// origin, not file://', () => {
    // §5, directive A2: `win.loadURL('tetravox://app/index.html')`, NEVER `loadFile()`.
    expect(report.locationProtocol).toBe('tetravox:');
    expect(report.origin).toBe('tetravox://app');
  });

  test('a module Worker under that origin streams the wasm module as application/wasm', () => {
    expect(report.wasm).not.toBeNull();
    expect(report.wasm?.origin).toBe('tetravox://app');
    expect(report.wasm?.wasmContentType).toBe('application/wasm');
    // The wasm-pack glue falls back to `arrayBuffer()` on a wrong MIME type *without failing*, so the
    // fallback is exactly what a broken `protocol.handle` would look like. Assert the streaming path.
    expect(report.wasm?.streamed).toBe(true);
    // §1: deliberately NOT cross-origin isolated, so `SharedArrayBuffer` does not exist and
    // cancellation can only ever be `worker.terminate()` (§5 rule 6).
    expect(report.wasm?.crossOriginIsolated).toBe(false);
    expect(report.wasm?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('the worker fetches a file over tetravox://file/ and hands the bytes to WASM', () => {
    expect(report.wasm?.fileBytes).toBe(FIXTURE_BYTES.length);
    expect(report.wasm?.fileDigest).toBe(EXPECTED_DIGEST);
  });

  test('tetravox://file/ refuses a path the user never named', async () => {
    const status = await page.evaluate(async () => {
      const response = await fetch(`tetravox://file/${encodeURIComponent('/etc/hosts')}`);
      return response.status;
    });
    expect(status).toBe(403);
  });

  test('the triangle colour is exactly tvx_ping(seed), read back from the drawing buffer', () => {
    expect(report.wasm?.ping).toBe(EXPECTED_PING);
    expect(report.color).toEqual(EXPECTED_COLOR);
    expect(report.drawingBuffer).toEqual({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    // Analytic, exact, no tolerance: flat shading into a plain RGBA8 buffer with no MSAA, no blending
    // and no sRGB encode, so the uniform's bytes are the framebuffer's bytes.
    expect(report.centerPixel).toEqual([...EXPECTED_COLOR, 255]);
    // …and the corner is still the clear colour, so "the triangle drew" is its own assertion.
    expect(report.cornerPixel).toEqual(BACKGROUND);
  });

  test('the screenshot contains that same colour', async ({}, testInfo) => {
    // Where the canvas actually sits, measured in the page, so the sample point survives any device
    // scale factor rather than assuming one.
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="phase0-canvas"]');
      if (el === null) throw new Error('canvas missing');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, viewport: window.innerWidth };
    });

    mkdirSync(join(APP_ROOT, 'test-results'), { recursive: true });
    const file = join(APP_ROOT, 'test-results', `phase0-${testInfo.project.name}.png`);
    const buffer = await page.screenshot({ path: file });
    await testInfo.attach(`phase0-${testInfo.project.name}`, {
      path: file,
      contentType: 'image/png',
    });

    const png = decodePng(buffer);
    const scale = png.width / box.viewport;
    const at = (fx: number, fy: number): [number, number, number, number] =>
      pixelAt(
        png,
        Math.round((box.x + fx * box.w) * scale),
        Math.round((box.y + fy * box.h) * scale)
      );

    // The triangle's apex points up and its base is wide, so the middle of the canvas is inside it and
    // the top-left corner is not. Both are asserted, so a blank canvas fails as loudly as a wrong one.
    expect(at(0.5, 0.5).slice(0, 3)).toEqual(EXPECTED_COLOR);
    expect(at(0.01, 0.01).slice(0, 3)).toEqual(BACKGROUND.slice(0, 3));
  });

  test('the capabilities of the renderer that drew it are recorded', () => {
    // ROADMAP Phase-0 gate 9: every CI run records which renderer produced the frame.
    expect(report.renderer).toBeTruthy();
    expect(report.vendor).toBeTruthy();
    console.log(
      `[phase0] renderer=${report.renderer} vendor=${report.vendor} software=${report.isSoftware}`
    );
  });
});

/**
 * ROADMAP Phase-0 gate 8: drop a `.nii.gz` **and** a `.msh` onto the window, exercising both §8
 * branches. `testdata/` is the fixtures stage's output — a real gzip NIfTI and a real Gmsh v2.2 ASCII
 * mesh, not two blobs of the same shape.
 */
const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const DROPPED = ['vol_u8.nii.gz', 'mesh_v2_ascii.msh'] as const;

/** The bytes on disk, and the digest WASM must arrive at, computed here from the algorithm. */
const DROPPED_EXPECTED = DROPPED.map((name) => {
  const bytes = new Uint8Array(readFileSync(join(TESTDATA, name)));
  return { name, path: join(TESTDATA, name), bytes: bytes.byteLength, digest: tvxPingBytes(bytes) };
});

/** Wait until the renderer has published `count` drop records, then return them. */
async function readDrops(page: Page, count: number): Promise<DropRecord[]> {
  await page.waitForFunction((n) => (window.__tetravox_phase0?.drops.length ?? 0) >= n, count, {
    timeout: 30_000,
  });
  return page.evaluate(() => window.__tetravox_phase0?.drops ?? []);
}

test.describe('drag and drop (§8)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target);
    page = await app.firstWindow();
    await readReport(page);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('a dropped .nii.gz and .msh reach WASM by path, via webUtils.getPathForFile', async () => {
    // A `File` only carries a path when Chromium made it from the filesystem. `setInputFiles` does
    // exactly that (it is CDP `DOM.setFileInputFiles` over real paths), and moving those `File`s into
    // a `DataTransfer` preserves the binding — which is what makes `webUtils.getPathForFile` answer,
    // and is the closest a test can get to a native drop without an OS-level drag.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.id = 'tvx-drop-probe';
      document.body.appendChild(input);
    });
    await page.setInputFiles(
      '#tvx-drop-probe',
      DROPPED_EXPECTED.map((f) => f.path)
    );
    await page.evaluate(() => {
      const input = document.getElementById('tvx-drop-probe') as HTMLInputElement;
      const transfer = new DataTransfer();
      for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
      document
        .querySelector('[data-testid="drop-target"]')
        ?.dispatchEvent(
          new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
        );
      input.remove();
    });

    const drops = await readDrops(page, 2);
    expect(drops).toHaveLength(2);
    for (const [i, expected] of DROPPED_EXPECTED.entries()) {
      const record = drops[i];
      expect(record, `drop ${i}`).toBeDefined();
      expect(record?.error).toBeNull();
      expect(record?.name).toBe(expected.name);
      // The path branch: a path came back, it was allow-listed, and the worker fetched it over the
      // privileged scheme rather than being handed bytes by the UI thread.
      expect(record?.branch).toBe('path');
      expect(record?.path).toBe(expected.path);
      expect(record?.url).toBe(`tetravox://file/${encodeURIComponent(expected.path)}`);
      expect(record?.bytes).toBe(expected.bytes);
      expect(record?.digest).toBe(expected.digest);
    }

    // A dropped path is a path the user named, so it joins the §5 rule 9 allow-list.
    const opened = await page.evaluate(() => window.__tetravox_phase0?.openedPaths ?? []);
    for (const expected of DROPPED_EXPECTED) expect(opened).toContain(expected.path);
  });

  test('the same two files reach WASM as File bytes when there is no path (§8 fallback)', async () => {
    // A `File` built in the page has no filesystem binding, so `getPathForFile` returns '' — the
    // fallback branch, which posts the `File` itself to the worker. Same bytes as the path branch,
    // so the digests must match the ones above exactly: one file, two routes, one answer.
    const payload = DROPPED_EXPECTED.map((f) => ({
      name: f.name,
      bytes: [...new Uint8Array(readFileSync(f.path))],
    }));
    await page.evaluate((files) => {
      const transfer = new DataTransfer();
      for (const file of files) {
        transfer.items.add(new File([new Uint8Array(file.bytes)], file.name));
      }
      document
        .querySelector('[data-testid="drop-target"]')
        ?.dispatchEvent(
          new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
        );
    }, payload);

    const drops = await readDrops(page, 4);
    expect(drops).toHaveLength(4);
    for (const [i, expected] of DROPPED_EXPECTED.entries()) {
      const record = drops[i + 2];
      expect(record, `fallback drop ${i}`).toBeDefined();
      expect(record?.error).toBeNull();
      expect(record?.name).toBe(expected.name);
      expect(record?.branch).toBe('file');
      expect(record?.path).toBeNull();
      expect(record?.url).toBeNull();
      expect(record?.bytes).toBe(expected.bytes);
      expect(record?.digest).toBe(expected.digest);
    }
  });
});

test.describe('path capture', () => {
  test('a CLI argument reaches the renderer as a path, never as bytes', async ({}, testInfo) => {
    const target = testInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const fixture = join(APP_ROOT, 'resources', 'phase0-fixture.bin');
    const app = await launchApp(target, { args: [fixture] });
    try {
      const page = await app.firstWindow();
      await readReport(page);
      await expect(page.locator('[data-testid="status-opened"]')).toContainText(
        'phase0-fixture.bin'
      );
      const paths = await page.evaluate(() => window.__tetravox_phase0?.openedPaths ?? []);
      expect(paths.some((p) => p.endsWith('phase0-fixture.bin'))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
