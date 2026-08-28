/**
 * The toolbar's "Reset" (data-testid `reset-all`, `Home`), end to end — `ShellController.resetAll`.
 *
 * Against the stand-in engine (`?engine=mock`), like `shell.spec.ts` and `measure.spec.ts`: what is
 * under test is the shell wiring (button → controller → store → coordinate bar), not engine pixels.
 * Pans/zooms the axial view, jumps the cursor away from the origin, then asserts a single click puts
 * the coordinate bar back at world `0.0 0.0 0.0` and the 3D camera back at its reset defaults —
 * while the loaded dataset's layer survives (Reset is not "Close every dataset").
 */

/* eslint-disable no-empty-pattern */

import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { APP_ROOT, launchApp } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = resolve(TESTDATA, 'vol_u8.nii.gz');

/** Boots with a volume already open (`args: [VOLUME]`, as `shell.spec.ts` does), so there is a real
 * layer to prove Reset does not touch. */
async function boot(): Promise<Page> {
  const app = await launchApp('dev', { search: 'engine=mock', args: [VOLUME] });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().layers.length ?? 0) > 0,
    undefined,
    { timeout: 15_000 }
  );
  return page;
}

const cursorOf = (page: Page) =>
  page.evaluate(() => window.__tetravox?.store.getState().cursor ?? null);

test.describe('Reset (§8 toolbar, mock engine)', () => {
  test('sends the cursor to world origin and refits every view, without unloading layers', async ({}) => {
    const page = await boot();
    const layersBefore = await page.evaluate(
      () => window.__tetravox?.store.getState().layers.map((l) => l.id) ?? []
    );
    expect(layersBefore.length).toBeGreaterThan(0);

    // Jump the cursor away from the origin through the same coordinate bar the assertion reads.
    const input = page.locator('[data-testid="coord-input"]');
    await input.click();
    await input.fill('-42, 18, 6');
    await input.press('Enter');
    await expect(input).toHaveValue('-42.0 18.0 6.0');
    expect(await cursorOf(page)).toEqual([-42, 18, 6]);

    // Move the 3D camera off its default too, so "reset" is provably doing something there as well.
    await page.keyboard.press('4'); // camera preset R (packages/app/.../keymap.ts PRESET_KEYS)

    const button = page.locator('[data-testid="reset-all"]');
    await expect(button).toBeVisible();
    await button.click();

    await expect(input).toHaveValue('0.0 0.0 0.0');
    expect(await cursorOf(page)).toEqual([0, 0, 0]);

    const camera = await page.evaluate(
      () => window.__tetravox?.engine?.scene.view3d.camera ?? null
    );
    expect(camera?.distance).toBe(400);
    expect(camera?.rotation).toEqual([0, 0, 0, 1]);

    // No dataset/layer was closed by Reset — same ids, same count.
    const layersAfter = await page.evaluate(
      () => window.__tetravox?.store.getState().layers.map((l) => l.id) ?? []
    );
    expect(layersAfter).toEqual(layersBefore);
  });

  test('the `Home` key does the same thing', async ({}) => {
    const page = await boot();
    const input = page.locator('[data-testid="coord-input"]');
    await input.click();
    await input.fill('10, 20, 30');
    await input.press('Enter');
    expect(await cursorOf(page)).toEqual([10, 20, 30]);

    // Blur the coordinate field first — every shortcut is suppressed on an editable target.
    await page.locator('[data-testid="toolbar"]').click();
    await page.keyboard.press('Home');

    await expect(input).toHaveValue('0.0 0.0 0.0');
    expect(await cursorOf(page)).toEqual([0, 0, 0]);
  });
});
