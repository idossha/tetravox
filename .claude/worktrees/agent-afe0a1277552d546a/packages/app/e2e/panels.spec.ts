/**
 * §8's collapsible sidebars, end to end (directed task: collapsible panels).
 *
 * Against the stand-in engine (`?engine=mock`), like `layer-collapse.spec.ts` — this is chrome, not
 * a pixel, so nothing here needs the real renderer. Three things are asserted:
 *
 *  * the toolbar/panel chevrons and the `Ctrl+[` / `Ctrl+]` chords both collapse and expand a
 *    sidebar, and `view-grid` really gets wider when one does — `ViewGrid`'s own `ResizeObserver`
 *    is what makes that true, so this is also a regression test for the reflow;
 *  * the preference survives a relaunch (it is kept in `localStorage`, not the scene);
 *  * a narrow window auto-collapses both sidebars to a rail, and the rail's chevron opens the panel
 *    as an overlay rather than pushing `view-grid` — asserted by `view-grid`'s width **not**
 *    changing while the overlay is open, the whole point of it being an overlay.
 */

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = join(TESTDATA, 'vol_u8.nii.gz');

async function gridWidth(page: Page): Promise<number> {
  const box = await page.locator('[data-testid="view-grid"]').boundingBox();
  if (box === null) throw new Error('view-grid has no box');
  return box.width;
}

test.describe('collapsible sidebars (stand-in engine)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=mock&mockStepMs=0', args: [VOLUME] });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('both panels start expanded, and the toggle collapses/expands the left one', async () => {
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();

    const before = await gridWidth(page);
    await page.click('[data-testid="left-panel-collapse"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="left-panel-rail"]')).toBeVisible();
    const afterCollapse = await gridWidth(page);
    expect(afterCollapse).toBeGreaterThan(before);

    await page.click('[data-testid="left-panel-expand"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();
    const afterExpand = await gridWidth(page);
    expect(afterExpand).toBeCloseTo(before, 0);
  });

  test('the right panel toggle does the same, and the grid widens further with both shut', async () => {
    const bothOpen = await gridWidth(page);
    await page.click('[data-testid="right-panel-collapse"]');
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="right-panel-rail"]')).toBeVisible();

    await page.click('[data-testid="left-panel-collapse"]');
    const bothShut = await gridWidth(page);
    expect(bothShut).toBeGreaterThan(bothOpen);

    // Put both back for the tests below.
    await page.click('[data-testid="left-panel-expand"]');
    await page.click('[data-testid="right-panel-expand"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
  });

  test('Ctrl+[ / Ctrl+] toggle the same state as the buttons', async () => {
    await page.locator('[data-testid="view-grid"]').click();
    await page.keyboard.press('Control+[');
    await expect(page.locator('[data-testid="layer-panel"]')).toHaveCount(0);
    await page.keyboard.press('Control+[');
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();

    await page.keyboard.press('Control+]');
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0);
    await page.keyboard.press('Control+]');
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();

    // The plain `[` / `]` binding (cycle the active layer) is unharmed by the new chord.
    const before = await page.evaluate(() => window.__tetravox?.store.getState().activeLayerId);
    await page.keyboard.press(']');
    const after = await page.evaluate(() => window.__tetravox?.store.getState().activeLayerId);
    expect(after).toBe(before); // one layer loaded: cycling it is a no-op, but it must not throw
  });

  test('the keyboard help sheet lists the panel chords', async () => {
    await page.keyboard.press('?');
    await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
    await expect(page.getByText('⌃[')).toBeVisible();
    await expect(page.getByText('⌃]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="keyboard-help"]')).toHaveCount(0);
  });

  test('the preference survives a relaunch — it lives in localStorage, not the scene', async () => {
    await page.click('[data-testid="left-panel-collapse"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toHaveCount(0);
    await app.close();

    app = await launchApp('dev', { search: 'engine=mock&mockStepMs=0', args: [VOLUME] });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="layer-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="left-panel-rail"]')).toBeVisible();

    // Leave it expanded again for a clean slate, in case another spec runs after this one in the
    // same profile.
    await page.click('[data-testid="left-panel-expand"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();
  });
});

test.describe('collapsible sidebars — narrow window (stand-in engine)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=mock&mockStepMs=0', args: [VOLUME] });
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('a narrow window auto-collapses both sidebars to a rail', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(700, 860);
    });
    await expect(page.locator('[data-testid="left-panel-rail"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel-rail"]')).toBeVisible();
    await expect(page.locator('[data-testid="layer-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0);
  });

  test('the rail opens the panel as an overlay, without moving view-grid', async () => {
    const before = await gridWidth(page);
    await page.click('[data-testid="left-panel-expand"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="left-panel-backdrop"]')).toBeVisible();
    const during = await gridWidth(page);
    // The overlay sits on top of the grid rather than pushing it — the whole point of "overlaid
    // rather than pushing the view grid".
    expect(during).toBeCloseTo(before, 0);

    await page.click('[data-testid="left-panel-backdrop"]');
    await expect(page.locator('[data-testid="layer-panel"]')).toHaveCount(0);
  });

  test('widening the window back out drops the overlay and restores the pushed layout', async () => {
    await page.click('[data-testid="right-panel-expand"]');
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860);
    });
    await expect(page.locator('[data-testid="left-panel-rail"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="right-panel-rail"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="layer-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
  });
});
