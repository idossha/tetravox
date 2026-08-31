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
 *
 * Every test here holds the app open past its last window (`holdOpen` below) and gives that hold
 * back in `shutdown`. See `holdOpen`'s comment: without it, two of these three tests are green on
 * macOS and red on Linux for a reason that has nothing to do with the guard they assert.
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
  await holdOpen(app);
  return { app, page };
}

/**
 * Hold the app open after its last window closes, so an assertion made *after* the close can still
 * reach main.
 *
 * `main/index.ts` quits on `window-all-closed` on every platform except macOS. Every one of these
 * tests closes the only window and then asks main a question about it, so on Linux and Windows the
 * question races the process exit — which is exactly how `a window with nothing unsaved closes
 * without asking` and the E2E-seam test failed on ubuntu (`electronApplication.evaluate: Target
 * page, context or browser has been closed`, CI run 33335197110) while passing on every macOS run.
 *
 * The honest fix is to take the app's *lifetime* out of an assertion about the *close guard*, not to
 * phrase the assertion around one platform's lifetime: a `before-quit` veto in main keeps the
 * process alive, and `shutdown` drops the veto before `app.close()` — which quits the app, so a
 * still-vetoed quit would hang the teardown instead. Nothing the guard does is stubbed or skipped:
 * the `close` handler, the edited flag, `preventDefault` and the `destroy` are all still the real
 * ones, and after this every platform takes the same path through the test, which is what lets a
 * macOS machine reason about the ubuntu leg at all.
 */
async function holdOpen(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    const store = globalThis as unknown as { __tvxHold?: boolean };
    store.__tvxHold = true;
    electronApp.on('before-quit', (event) => {
      if ((globalThis as unknown as { __tvxHold?: boolean }).__tvxHold === true) {
        event.preventDefault();
      }
    });
  });
}

/** Give `holdOpen`'s veto back, then close the app. Tolerates an app that is already gone. */
async function shutdown(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(() => {
      (globalThis as unknown as { __tvxHold?: boolean }).__tvxHold = false;
    })
    .catch(() => {});
  await app.close();
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
      await shutdown(app);
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
      await shutdown(app);
    }
  });

  /**
   * The E2E seam, and the build it belongs to (2026-08-30).
   *
   * `dev` is the build that runs tests, so the seam works there: a harness that made a window dirty
   * must be able to tear it down, and a job window must never stop on a box nobody can answer.
   * `packaged` is the build a *user* launches, where the same variable is ambient state — a dotfile,
   * a wrapper script, a leftover `export` in the shell — and switching off the only guard unsaved
   * module edits have is not something an environment should be able to do. One spec, and the
   * target decides which half of the rule it asserts.
   */
  test('the E2E seam works in dev and is ignored in a packaged build', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    const { app, page } = await boot(target, { TETRAVOX_E2E_DISCARD: '1' });
    try {
      await stubMessageBox(app, 1); // Cancel, if a box is ever shown
      await markEdited(page, true);

      if (target === 'packaged') {
        // The seam is closed: the box is shown, Cancel keeps the window, the edits survive.
        await closeWindow(app);
        await expect.poll(() => boxesShown(app)).toBe(1);
        expect(page.isClosed()).toBe(false);
        // …and Discard still closes it, so this leg leaves no window hanging behind it.
        await stubMessageBox(app, 0);
        const discarded = page.waitForEvent('close', { timeout: 15_000 });
        await closeWindow(app);
        await discarded;
        expect(page.isClosed()).toBe(true);
        return;
      }

      const closed = page.waitForEvent('close', { timeout: 15_000 });
      await closeWindow(app);
      await closed;
      expect(page.isClosed()).toBe(true);
      expect(await boxesShown(app)).toBe(0);
    } finally {
      await shutdown(app);
    }
  });
});
