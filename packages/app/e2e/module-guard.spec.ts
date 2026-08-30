/**
 * The unsaved-module-edits close guard (§5 rule 12, DECISIONS 2026-08-30).
 *
 * This is the codebase's first `BrowserWindow 'close'` handler, and the only way to know it is wired
 * — installed on the real window, reading the real flag, calling the real `dialog.showMessageBox` —
 * is to close a real window. So the window is closed through main, and what is asserted is whether
 * the page survived it.
 *
 * `dialog.showMessageBox` is **stubbed in main** (`app.evaluate`, the `shell-phase2.spec.ts` idiom):
 * it is OS-modal, no Playwright click can reach it, and an unstubbed one would hang the run until
 * the CI cap. Everything under it stays real — the flag, the guard, `preventDefault`, the destroy.
 *
 * No module exists on this branch yet, so the renderer marks the window through the bridge member a
 * module's `ui.setDirty` will reach: `window.tetravox.setDocumentEdited`. That is the whole of the
 * renderer's side of this feature.
 */

/* eslint-disable no-empty-pattern */

import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const VOLUME = join(resolve(APP_ROOT, '..', '..', 'testdata'), 'vol_u8.nii.gz');

async function boot(
  target: LaunchTarget,
  env?: Record<string, string>
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, {
    search: 'engine=mock&mockStepMs=0',
    args: [VOLUME],
    ...(env === undefined ? {} : { env }),
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  return { app, page };
}

/**
 * Replace `dialog.showMessageBox` in main with one that counts its calls and answers `response`.
 * 0 is Discard, 1 is Cancel — the order `installCloseGuard` passes.
 */
async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    const store = globalThis as unknown as { __tvxBoxes?: number };
    store.__tvxBoxes = 0;
    dialog.showMessageBox = (async () => {
      store.__tvxBoxes = (store.__tvxBoxes ?? 0) + 1;
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}

async function boxesShown(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __tvxBoxes?: number }).__tvxBoxes ?? 0);
}

async function markEdited(page: Page, edited: boolean): Promise<void> {
  await page.evaluate((flag) => {
    window.tetravox.setDocumentEdited(flag);
  }, edited);
}

/** Ask main to close the window, the way the red button and ⌘W do. */
async function closeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
}

test.describe('closing a window with unsaved module edits', () => {
  test('Cancel keeps the window, Discard closes it', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    const { app, page } = await boot(target);
    try {
      await stubMessageBox(app, 1); // Cancel
      await markEdited(page, true);
      await closeWindow(app);

      await expect.poll(() => boxesShown(app)).toBe(1);
      // The close was interrupted: the page is still there and still answering.
      expect(page.isClosed()).toBe(false);
      expect(await page.evaluate(() => document.readyState)).toBe('complete');

      // Same gesture, this time answered Discard.
      await stubMessageBox(app, 0);
      const closed = page.waitForEvent('close', { timeout: 15_000 });
      await closeWindow(app);
      await closed;
      expect(page.isClosed()).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('a window with nothing unsaved closes without asking', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    const { app, page } = await boot(target);
    try {
      await stubMessageBox(app, 1); // would Cancel, if it were ever shown
      // Marked and then unmarked, so this is the *cleared* flag and not merely an unset one.
      await markEdited(page, true);
      await markEdited(page, false);

      const closed = page.waitForEvent('close', { timeout: 15_000 });
      await closeWindow(app);
      await closed;
      expect(page.isClosed()).toBe(true);
      expect(await boxesShown(app)).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('TETRAVOX_E2E_DISCARD=1 closes a dirty window without asking', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    // The seam every other windowless spec relies on: a harness that made a window dirty must still
    // be able to tear it down, and a job window must never stop on a box nobody can answer.
    const { app, page } = await boot(target, { TETRAVOX_E2E_DISCARD: '1' });
    try {
      await stubMessageBox(app, 1);
      await markEdited(page, true);

      const closed = page.waitForEvent('close', { timeout: 15_000 });
      await closeWindow(app);
      await closed;
      expect(page.isClosed()).toBe(true);
      expect(await boxesShown(app)).toBe(0);
    } finally {
      await app.close();
    }
  });
});
