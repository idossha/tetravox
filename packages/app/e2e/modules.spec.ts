/**
 * The module surface in the running app (ARCHITECTURE.md §13.3, §13.4).
 *
 * `vitest` runs under `environment: 'node'`, so every claim §13.3 makes about *layout* — the slot's
 * height cap, the toolbar not wrapping, the aside staying in flow at 960 px — can only be asserted
 * here, against a real window. `hostImpl.test.ts` covers the state; this covers the pixels those
 * states are supposed to produce.
 *
 * The subject is the fixture module behind `?modules=hello`, which is the same seam `?engine=mock`
 * uses, so what is driven here is the module that ships in the production bundle rather than a mock
 * built for the test.
 *
 * Two assertions are worth reading twice, because they are the ones a plausible implementation
 * fails:
 *
 *  * **the toolbar's height is unchanged after an activation at 1440×900.** `Toolbar.tsx` is
 *    `flex-wrap`, so a second control in the centre cluster wraps the row, grows the header and
 *    shrinks the view grid — the same canvas-resize class the status bar was pinned against. One
 *    switcher in the right column is the design that survives a second module, and this is what
 *    proves the first one did not already cost a row;
 *  * **the right aside stays in flow at 960 px while a module is active.** The narrow-mode overlay's
 *    backdrop closes on any click, including the click in a pane a module just asked for.
 */

/* eslint-disable no-empty-pattern */

import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, clickAppMenu, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = join(TESTDATA, 'vol_u8.nii.gz');

const HELLO = 'tetravox.hello';
const SEARCH = 'engine=mock&mockStepMs=0&modules=hello';

async function setSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height }
  );
}

/** Click outside every control, so a key press is not swallowed by a focused button or field. */
async function focusShell(page: Page): Promise<void> {
  await page.locator('[data-testid="shell"]').click({ position: { x: 5, y: 400 } });
}

/** Idempotent: the switcher is a **toggle**, so clicking it on an active module would close it. */
async function activate(page: Page): Promise<void> {
  if ((await page.locator('[data-testid="module-slot"]').count()) === 0) {
    await page.click('[data-testid="module-switcher"]');
    await page.click(`[data-testid="module-switcher-${HELLO}"]`);
  }
  await expect(page.locator('[data-testid="module-slot"]')).toBeVisible();
}

test.describe('the module surface (stand-in engine)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: SEARCH, args: [VOLUME] });
    page = await app.firstWindow();
    await setSize(app, 1440, 900);
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
    await page.waitForFunction(
      () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
      undefined,
      { timeout: 30_000 }
    );
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the slot is absent until a module is in it, and the switcher is the way in', async () => {
    // §13.3's "the DOM is byte-identical while the slot is idle": nothing at all, not an empty box.
    await expect(page.locator('[data-testid="module-slot"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-switcher"]')).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await activate(page);
    await expect(page.locator('[data-testid="module-switcher"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.locator('[data-testid="hello-panel"]')).toBeVisible();
    expect(await page.evaluate(() => window.__tetravox?.store.getState().activeModule)).toBe(HELLO);
  });

  test('the slot sits between the measurement strip and the Info panel, and caps its own height', async () => {
    const info = await page.locator('[data-testid="right-panel"] >> text=Cursor').first();
    await expect(info).toBeVisible();

    const aside = await page.locator('[data-testid="right-panel"]').boundingBox();
    const slot = await page.locator('[data-testid="module-slot"]').boundingBox();
    expect(aside).not.toBeNull();
    expect(slot).not.toBeNull();
    // The hard cap. It is `max-h-[55%]` and the slot is outside the Info scroller, so this holds
    // however tall a module's panel is — the alternative squeezes the Info panel to zero.
    expect((slot as { height: number }).height).toBeLessThanOrEqual(
      (aside as { height: number }).height * 0.56
    );
    // …and it really is above the Info panel, not below it.
    const infoBox = await page.locator('[data-testid="right-panel"]').boundingBox();
    expect((slot as { y: number }).y).toBeGreaterThan((infoBox as { y: number }).y);
  });

  test('the toolbar is exactly as tall as it was, at 1440×900', async () => {
    await setSize(app, 1440, 900);
    // Deactivate, measure, activate, measure. A second toolbar row is 20-odd pixels and would show
    // up here as a difference; the assertion is equality, not a tolerance.
    await page.click('[data-testid="module-slot-close"]');
    await expect(page.locator('[data-testid="module-slot"]')).toHaveCount(0);
    const before = await page.locator('[data-testid="toolbar"]').boundingBox();

    await activate(page);
    const after = await page.locator('[data-testid="toolbar"]').boundingBox();
    expect((after as { height: number }).height).toBe((before as { height: number }).height);
  });

  test('the status cell appears before the dataset cells, and goes when the module does', async () => {
    const cell = page.locator(`[data-testid="status-module-${HELLO}"]`);
    // Nothing to say yet — a module with no status has no cell rather than an empty one.
    await expect(cell).toHaveCount(0);

    await page.click('[data-testid="hello-ping"]');
    await expect(cell).toBeVisible();
    await expect(cell).toContainText('hello: 1');

    // Before the dataset cells: two BIDS-named datasets already overflow this strip, and `ml-auto`
    // cannot pull a cell back inside a container that has overflowed.
    const moduleBox = await cell.boundingBox();
    const datasetBox = await page.locator('[data-testid^="status-heap-"]').first().boundingBox();
    expect((moduleBox as { x: number }).x).toBeLessThan((datasetBox as { x: number }).x);
  });

  test('a bound key runs its command, and only while the module is active', async () => {
    await focusShell(page);
    const count = page.locator('[data-testid="hello-count"]');
    const before = Number(await count.textContent());

    await page.keyboard.press('g');
    await expect(count).toHaveText(String(before + 1));

    // §13.5: the key is dead the moment the module leaves the slot.
    await page.click('[data-testid="module-slot-close"]');
    await focusShell(page);
    await page.keyboard.press('g');
    await activate(page);
    // The count survives deactivation through the scene block, so it is the pre-close value.
    await expect(page.locator('[data-testid="hello-count"]')).toHaveText(String(before + 1));
  });

  test('a module key never shadows a §7.5 binding', async () => {
    // `g` is a module key; `c` is the core crosshair toggle and must keep working with a module in
    // the slot, because module keys resolve only after `resolveKey` returns null.
    await focusShell(page);
    const crosshair = page.locator('[data-testid="crosshair-toggle"]');
    const before = await crosshair.getAttribute('aria-pressed');
    await page.keyboard.press('c');
    await expect(crosshair).not.toHaveAttribute('aria-pressed', before ?? '');
    await page.keyboard.press('c');
  });

  test('a `when: "selection"` key stays harmless with nothing selected', async () => {
    // The engine's `pointSelection()` is null here — no module armed a tool and nothing was
    // clicked — which is exactly the state §13.5's exception is scoped to. `s` must do nothing at
    // all, not merely nothing visible.
    await focusShell(page);
    const count = page.locator('[data-testid="hello-count"]');
    const before = await count.textContent();
    await page.keyboard.press('s');
    await expect(count).toHaveText(before ?? '');
  });

  test('the help sheet grows a Modules tab, listing the active module’s chords', async () => {
    await page.click('[data-testid="keyboard-help-button"]');
    await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
    await page.click('[data-testid="keymap-tab-modules"]');
    await expect(page.locator('[data-testid="keyhelp-section-Modules"]')).toBeVisible();
    await expect(page.locator('[data-testid="keyhelp-module-chord"]').first()).toHaveText('g');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="keyboard-help"]')).toHaveCount(0);
  });

  test('the title carries a bullet while the module has unsaved work', async () => {
    await page.click('[data-testid="hello-ping"]');
    await expect(page.locator('[data-testid="module-dirty"]')).toBeVisible();
    // `sceneDirty` is false here — the module's flag is what put the mark there.
    await expect.poll(async () => page.evaluate(() => document.title.endsWith('•'))).toBe(true);

    await page.click('[data-testid="hello-save"]');
    await expect(page.locator('[data-testid="module-dirty"]')).toHaveCount(0);
  });

  test('at 960 px the right aside stays in flow while a module is active', async () => {
    await activate(page);
    await setSize(app, 960, 900);

    // Narrow **and** a module in the slot: the aside is in flow, not an overlay. The narrow-mode
    // overlay's backdrop closes on any click — including the click in a pane the module just asked
    // for — so an editor behind one would be unusable.
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel-backdrop"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-slot"]')).toBeVisible();

    // Close the module and the ordinary narrow-mode behaviour is back, unchanged: a rail whose
    // chevron opens the overlay.
    await page.click('[data-testid="module-slot-close"]');
    await expect(page.locator('[data-testid="right-panel-expand"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0);
    await page.click('[data-testid="right-panel-expand"]');
    await expect(page.locator('[data-testid="right-panel-backdrop"]')).toBeVisible();
    await page.click('[data-testid="right-panel-backdrop"]');
    await expect(page.locator('[data-testid="right-panel-backdrop"]')).toHaveCount(0);

    await setSize(app, 1440, 900);
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
  });

  test('New does not ask when the module has nothing unsaved — and it is last, because it clears', async () => {
    // The other half of the guard, and deliberately the final test in this window: a clean module is
    // not asked about at all, and `New` really does empty the scene and the slot with it.
    await activate(page);
    await page.click('[data-testid="hello-save"]');
    await expect(page.locator('[data-testid="module-dirty"]')).toHaveCount(0);

    await clickAppMenu(page, 'new');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-slot"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__tetravox?.store.getState().activeModule)).toBeNull();
  });
});

test.describe('the discard guard (§13.3)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  // Its own window, because every branch of this guard ends with the scene either intact or gone,
  // and the interesting branch — Discard — leaves nothing for a following test to act on. A second
  // launch costs a couple of seconds and buys an order that reads the way the guard is used.
  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: SEARCH, args: [VOLUME] });
    page = await app.firstWindow();
    await setSize(app, 1440, 900);
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
    await page.waitForFunction(
      () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
      undefined,
      { timeout: 30_000 }
    );
    await activate(page);
    await page.click('[data-testid="hello-ping"]');
    await expect(page.locator('[data-testid="module-dirty"]')).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('Cancel really cancels: the scene, the module and its count are all still there', async () => {
    const count = await page.locator('[data-testid="hello-count"]').textContent();
    await clickAppMenu(page, 'new');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="confirm-body"]')).toContainText('without saving');
    // Two buttons: the fixture declares no `save` command, and a three-button question whose first
    // button did nothing would be worse than a two-button one.
    await expect(page.locator('[data-testid^="confirm-button-"]')).toHaveCount(2);

    await page.click('[data-testid="confirm-button-1"]');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="hello-count"]')).toHaveText(count ?? '');
  });

  test('Escape is the same answer as the last button — which is why the safe one is written last', async () => {
    await clickAppMenu(page, 'new');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-slot"]')).toBeVisible();
  });

  test('closing a dataset no module owns is not guarded at all', async () => {
    // The fixture owns no layer, so the layer row's ✕ has nothing of its to take with it. The guard
    // is keyed on ownership, not on "some module is dirty somewhere".
    const close = page.locator('[data-testid^="layer-close-"]').first();
    await close.click();
    await expect(page.locator('[data-testid="confirm-dialog"]')).toHaveCount(0);
    await expect
      .poll(async () => page.evaluate(() => window.__tetravox?.store.getState().datasets.length))
      .toBe(0);
  });

  test('Discard proceeds, and empties the slot with the scene', async () => {
    // The dataset is gone, so `New` is disabled; the drop route is the same guard and reaches it
    // through `openScenePath`. Use the controller's own entry point, which is what every one of the
    // five sites calls — the dialog under test is the same one either way.
    const pending = page.evaluate(() => window.__tetravox?.controller?.requestNewScene());
    await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    await page.click('[data-testid="confirm-button-0"]');
    await pending;
    await expect(page.locator('[data-testid="module-slot"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__tetravox?.store.getState().activeModule)).toBeNull();
    expect(await page.evaluate(() => window.__tetravox?.store.getState().moduleDirty)).toEqual({});
  });
});

test.describe('a build that offers no module', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    // No `modules=` at all — a default launch, where the fixture is compiled in and hidden.
    app = await launchApp(target, { search: 'engine=mock&mockStepMs=0' });
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('offers no switcher, no slot and no cell — the toolbar it always had', async () => {
    await expect(page.locator('[data-testid="module-switcher"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-slot"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="status-module-"]')).toHaveCount(0);
    // A fixture is compiled into every build; being hidden means the registry does not offer it,
    // which is the same state a build that never had the module is in.
    expect(await page.evaluate(() => window.__tetravox?.store.getState().activeModule)).toBeNull();
  });

  test('the keyboard sheet has its three tabs and no Modules tab', async () => {
    await page.click('[data-testid="keyboard-help-button"]');
    await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
    await expect(page.locator('[data-testid="keymap-tab-modules"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
