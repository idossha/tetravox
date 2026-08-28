/**
 * Regression for the sidebar-collapse-blanks-the-panes bug (fix/panel-resize-render).
 *
 * Collapsing or expanding the left (Layers) or right (Info) sidebar changes `view-grid`'s width,
 * which drives `ViewGrid`'s `ResizeObserver` and reallocates the canvas's WebGL drawing buffer —
 * cleared to opaque black per spec (the context is `alpha: false`, `gl/context.ts`). Before the fix,
 * `ViewGrid` never told the engine to repaint after that clear, so every pane stayed black on screen
 * until an unrelated command happened to call `requestRender()`.
 *
 * `Engine.readPixel` is **not** usable to catch this: it always calls `renderNow()` before reading
 * (`engine.ts`, "a caller about to read a pixel back has no way to know which panes were last
 * repainted"), so it self-heals the very bug this test is for — sampling through it made an earlier
 * draft of this test pass even with the fix reverted. What is asserted here instead is what the user
 * actually sees: a `page.screenshot()` of each pane, decoded with `./png.ts`, with **no** call into
 * the engine in between. This is also why the mock engine (`panels.spec.ts`) cannot cover this bug —
 * it has no drawing buffer to lose.
 *
 * Against `testdata/vol_u8.nii.gz` (small, always present — no `TETRAVOX_TESTDATA` gate needed):
 *
 *  * a pixel sampled in the middle of each 2×2 pane is non-black before a toggle;
 *  * after collapsing the left panel, expanding it, collapsing the right panel and expanding it
 *    again (each awaited to settle, no manual re-render), the same pixel is still non-black in every
 *    pane;
 *  * each slice pane's `camera.center` / `mmPerPx` — the world centre and zoom §4.5 promises a
 *    resize must never disturb — read back byte-identical across the whole sequence (read through
 *    `readPixel`'s sibling, `engine.scene`, which is pure state and forces nothing).
 */

/* eslint-disable no-empty-pattern */

import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = join(TESTDATA, 'vol_u8.nii.gz');

interface CameraSnapshot {
  slices: { id: string; center: [number, number]; mmPerPx: number }[];
}

/** Screenshots the centre pixel of every pane in the 2×2 layout — the compositor's own view, no
 *  engine call in between. */
async function samplePaneCentres(page: Page): Promise<{ viewId: string; rgb: number[] }[]> {
  const cells: string[] = await page.evaluate(
    () => window.__tetravox?.engine?.scene.layout.cells ?? []
  );
  const samples: { viewId: string; rgb: number[] }[] = [];
  for (const viewId of cells) {
    const locator = page.locator(`[data-testid="view-cell-${viewId}"]`);
    const png = decodePng(await locator.screenshot());
    const x = Math.floor(png.width / 2);
    const y = Math.floor(png.height / 2);
    const o = (y * png.width + x) * 4;
    samples.push({
      viewId,
      rgb: [png.pixels[o] ?? 0, png.pixels[o + 1] ?? 0, png.pixels[o + 2] ?? 0],
    });
  }
  return samples;
}

async function cameraSnapshot(page: Page): Promise<CameraSnapshot> {
  return page.evaluate(() => {
    const engine = window.__tetravox?.engine;
    if (engine == null) throw new Error('no engine');
    return {
      slices: engine.scene.slices.map((s) => ({
        id: s.id,
        center: [...s.camera.center] as [number, number],
        mmPerPx: s.camera.mmPerPx,
      })),
    };
  });
}

test.describe('a sidebar toggle keeps every pane rendering (real engine)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(120_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real', args: [VOLUME] });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
    await page.waitForFunction(
      () => (window.__tetravox?.store.getState().layers ?? []).some((l) => l.kind === 'volume'),
      undefined,
      { timeout: 60_000 }
    );
    await page.evaluate(() => window.__tetravox?.controller?.setLayout('2x2'));
    await page.evaluate(async () => {
      const engine = window.__tetravox?.engine;
      await engine?.whenSettled();
      engine?.renderNow();
    });
    // The initial layout's own resize settles before any panel is touched.
    await page.waitForTimeout(300);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  function expectNonBlack(samples: { viewId: string; rgb: number[] }[]): void {
    for (const { viewId, rgb } of samples) {
      const [r, g, b] = rgb;
      expect(
        r !== 0 || g !== 0 || (b ?? 0) !== 0,
        `pane ${viewId} is black on screen: rgb(${rgb.join(',')})`
      ).toBe(true);
    }
  }

  test('every pane renders before any toggle', async () => {
    const samples = await samplePaneCentres(page);
    expect(samples.length).toBeGreaterThan(0);
    expectNonBlack(samples);
  });

  test('collapsing then expanding the left panel leaves every pane rendering, camera unchanged', async () => {
    const before = await cameraSnapshot(page);

    await page.click('[data-testid="left-panel-collapse"]');
    await expect(page.locator('[data-testid="left-panel-rail"]')).toBeVisible();
    // The resize is observed asynchronously (`ResizeObserver`), so give the reflow + repaint a beat
    // before reading the compositor's own picture back.
    await page.waitForTimeout(300);
    expectNonBlack(await samplePaneCentres(page));
    expect(await cameraSnapshot(page)).toEqual(before);

    await page.click('[data-testid="left-panel-expand"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();
    await page.waitForTimeout(300);
    expectNonBlack(await samplePaneCentres(page));
    expect(await cameraSnapshot(page)).toEqual(before);
  });

  test('collapsing then expanding the right panel leaves every pane rendering, camera unchanged', async () => {
    const before = await cameraSnapshot(page);

    await page.click('[data-testid="right-panel-collapse"]');
    await expect(page.locator('[data-testid="right-panel-rail"]')).toBeVisible();
    await page.waitForTimeout(300);
    expectNonBlack(await samplePaneCentres(page));
    expect(await cameraSnapshot(page)).toEqual(before);

    await page.click('[data-testid="right-panel-expand"]');
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
    await page.waitForTimeout(300);
    expectNonBlack(await samplePaneCentres(page));
    expect(await cameraSnapshot(page)).toEqual(before);
  });

  test('collapsing both panels at once, then expanding both, still leaves every pane rendering', async () => {
    const before = await cameraSnapshot(page);

    await page.click('[data-testid="left-panel-collapse"]');
    await page.click('[data-testid="right-panel-collapse"]');
    await page.waitForTimeout(300);
    expectNonBlack(await samplePaneCentres(page));
    expect(await cameraSnapshot(page)).toEqual(before);

    await page.click('[data-testid="left-panel-expand"]');
    await page.click('[data-testid="right-panel-expand"]');
    await page.waitForTimeout(300);
    expectNonBlack(await samplePaneCentres(page));
    expect(await cameraSnapshot(page)).toEqual(before);
  });
});
