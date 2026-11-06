/**
 * The right panel's tab row and the Inspect toggle (§13.3), in the running app.
 *
 * Subjects: `tetravox.hello` declares no tabs and `tetravox.tabs` declares three.
 */

/* eslint-disable no-empty-pattern */

import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const VOLUME = join(resolve(APP_ROOT, '..', '..', 'testdata'), 'vol_u8.nii.gz');
const TABS = 'tetravox.tabs';
const HELLO = 'tetravox.hello';

async function setSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height }
  );
}

async function openModule(page: Page, id: string): Promise<void> {
  await page.click('[data-testid="module-switcher"]');
  await page.click(`[data-testid="module-switcher-${id}"]`);
  await expect(page.locator('[data-testid="module-slot"]')).toHaveAttribute('data-module', id);
}

async function rowLabels(page: Page): Promise<string[]> {
  return page.locator('[data-testid="panel-tabs"] [role="tab"]').allInnerTexts();
}

test.describe('the tab row (stand-in engine)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, {
      search: 'engine=mock&mockStepMs=0&modules=hello,tabs',
      args: [VOLUME],
    });
    page = await app.firstWindow();
    await setSize(app, 1800, 900);
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
    await page.waitForFunction(() => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('no module: no row, Inspect fills the panel, and the chevron stays', async () => {
    await expect(page.locator('[data-testid="panel-tabs"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="right-panel-collapse"]')).toBeVisible();
    await expect(page.locator('[data-testid="coord-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="info-panel"]')).toBeVisible();
    const panel = (await page.locator('[data-testid="right-panel"]').boundingBox())!;
    const inspect = (await page.locator('[data-testid="panel-inspect"]').boundingBox())!;
    expect(inspect.y + inspect.height).toBeCloseTo(panel.y + panel.height, 0);
    expect(panel.width).toBe(320);
  });

  test('the header is behind a disclosure, closed, and opening it is remembered', async () => {
    await expect(page.locator('[data-testid="header-search"]')).toHaveCount(0);
    await page.click('[data-testid="header-toggle"]');
    await expect(page.locator('[data-testid="header-search"]')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('tetravox.panels.v1')))
      .toContain('"headerBlockCollapsed":false');
    await page.click('[data-testid="header-toggle"]');
    await expect(page.locator('[data-testid="header-search"]')).toHaveCount(0);
  });

  test('a module with no tabs: its title alone, at 400 px with the full height', async () => {
    await expect(page.locator('[data-testid="inspect-toggle"]')).toHaveCount(0);
    await openModule(page, HELLO);
    expect(await rowLabels(page)).toEqual(['Hello']);
    await expect(page.locator('[data-testid="inspect-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="hello-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="module-slot-fold"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="panel-inspect"]')).toBeHidden();

    const panel = (await page.locator('[data-testid="right-panel"]').boundingBox())!;
    const row = (await page.locator('[data-testid="panel-tabs"]').boundingBox())!;
    const slot = (await page.locator('[data-testid="module-slot"]').boundingBox())!;
    expect(panel.width).toBe(400);
    // No 55 % cap: all of the panel under the row.
    expect(slot.y + slot.height).toBeCloseTo(panel.y + panel.height, 0);
    expect(slot.height).toBeGreaterThan(panel.height - row.height - 2);
    // Row, chrome and chevron on one line, inside the panel.
    for (const id of ['module-slot-popout', 'module-slot-close', 'right-panel-collapse']) {
      const box = (await page.locator(`[data-testid="${id}"]`).boundingBox())!;
      expect(box.y).toBeLessThan(row.y + row.height);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
    }
  });

  test('Inspect is a toolbar toggle: no row while on, the module mounted, and a crosshair move does not steal it', async () => {
    await page.click('[data-testid="hello-ping"]');
    const count = await page.locator('[data-testid="hello-count"]').textContent();
    await page.click('[data-testid="inspect-toggle"]');
    await expect(page.locator('[data-testid="module-slot"]')).toBeHidden();
    await expect(page.locator('[data-testid="panel-tabs"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="right-panel-collapse"]')).toBeVisible();
    await expect(page.locator('[data-testid="hello-panel"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="coord-input"]')).toBeVisible();

    // The cursor reaches Inspect's data while it shows, and the row stays where it is.
    await page.evaluate(() => window.__tetravox?.engine?.setCursor([1, 2, 3]));
    await expect(page.locator('[data-testid="coord-input"]')).toHaveValue(/1.* 2.* 3/);
    await expect(page.locator('[data-testid="inspect-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await page.click('[data-testid="inspect-toggle"]');
    await expect(page.locator('[data-testid="hello-count"]')).toHaveText(count ?? '');
    await expect(page.locator('[data-testid="module-slot-close"]')).toBeVisible();
    await page.click('[data-testid="hello-save"]');
  });

  test('choosing the module in the switcher from Inspect shows it, and a second choice closes it', async () => {
    await page.click('[data-testid="inspect-toggle"]');
    await page.click('[data-testid="module-switcher"]');
    await page.click(`[data-testid="module-switcher-${HELLO}"]`);
    await expect(page.locator('[data-testid="hello-panel"]')).toBeVisible();
    await page.click('[data-testid="module-switcher"]');
    await page.click(`[data-testid="module-switcher-${HELLO}"]`);
    await expect(page.locator('[data-testid="panel-tabs"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="inspect-toggle"]')).toHaveCount(0);
    expect((await page.locator('[data-testid="right-panel"]').boundingBox())!.width).toBe(320);
  });

  test('declared tabs: the module’s and nothing else, and React state survives a switch', async () => {
    await openModule(page, TABS);
    expect(await rowLabels(page)).toEqual(['Filter', 'Network', 'Export']);
    const panel = page.locator('[data-testid="tabs-panel"]');
    await expect(panel).toHaveAttribute('data-tab', 'filter');

    await page.click('[data-testid="tabs-kept"]');
    await expect(page.locator('[data-testid="tabs-kept"]')).toHaveText('1');
    await page.click('[data-testid="panel-tab-export"]');
    await expect(panel).toHaveAttribute('data-tab', 'export');
    await page.click('[data-testid="inspect-toggle"]');
    await expect(panel).toBeHidden();
    await page.click('[data-testid="inspect-toggle"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-tab', 'export');
    await expect(page.locator('[data-testid="tabs-kept"]')).toHaveText('1');
  });

  test('arrow keys move along the row without nudging the cursor', async () => {
    await page.locator('[data-testid="panel-tab-export"]').focus();
    const cursor = await page.evaluate(() => window.__tetravox?.store.getState().cursor);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-testid="tabs-panel"]')).toHaveAttribute('data-tab', 'filter');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-testid="tabs-panel"]')).toHaveAttribute('data-tab', 'export');
    expect(await page.evaluate(() => window.__tetravox?.store.getState().cursor)).toEqual(cursor);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  });

  test('the chosen tab survives closing and reopening the module', async () => {
    await page.click('[data-testid="module-slot-close"]');
    await openModule(page, TABS);
    await expect(page.locator('[data-testid="tabs-panel"]')).toHaveAttribute('data-tab', 'export');
  });

  test('in its own window the module draws its nav and the row goes', async () => {
    const popupPromise = app.waitForEvent('window');
    await page.click('[data-testid="module-slot-popout"]');
    const popup = await popupPromise;
    await expect(page.locator('[data-testid="panel-tabs"]')).toHaveCount(0);
    await popup.click('[data-testid="tabs-own-filter"]');
    await expect(popup.locator('[data-testid="tabs-panel"]')).toHaveAttribute('data-tab', 'filter');
    await popup.close();
    await expect(page.locator('[data-testid="panel-tab-filter"]')).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});
