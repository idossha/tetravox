/**
 * **⌘S on a scene that was opened rather than saved** (§5 rule 10, DECISIONS 2026-08-30).
 *
 * `ShellController.saveScene` writes to the attached `sceneFile.path`, and `openScenePath` attaches
 * one — but before this fix only the Save sheet ever called `allowWrite`, so main answered "not on
 * the write list" and the first Save of a session silently did nothing. The bug is invisible from
 * inside the renderer: the store still says the scene is attached, and Save As… works. It is only
 * visible **on disk**, so this spec judges the bytes on disk and nothing else.
 *
 * Save is triggered through the **application menu item ⌘S is the accelerator for**, in main, rather
 * than through the toolbar's own Save button: the accelerator is what a user presses, and the item's
 * click handler is the whole of what it does (`main/menu.ts` → `tetravox:scene-command`). A
 * Playwright key press cannot reach a native menu, so the item is clicked where it lives.
 *
 * Stand-in engine (`?engine=mock`): nothing here is a rendering feature — the assertion is a file's
 * contents — and the real-engine persistence path already has `scene-realdata.spec.ts`.
 */

/* eslint-disable no-empty-pattern */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, clickAppMenu, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const VOLUME = join(resolve(APP_ROOT, '..', '..', 'testdata'), 'vol_u8.nii.gz');

async function boot(
  target: LaunchTarget,
  args: string[]
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, { search: 'engine=mock&mockStepMs=0', args });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  return { app, page };
}

/** The native dialogs are OS-modal; `app.evaluate` replaces them in main, leaving IPC real. */
async function stubDialogs(
  app: ElectronApplication,
  paths: { save?: string; open?: string }
): Promise<void> {
  await app.evaluate(async ({ dialog }, { save, open }) => {
    dialog.showSaveDialog = (async () => ({
      canceled: save === undefined,
      filePath: save,
    })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({
      canceled: open === undefined,
      filePaths: open === undefined ? [] : [open],
    })) as typeof dialog.showOpenDialog;
  }, paths);
}

/**
 * Click a File-menu item in main — the same handler its accelerator runs.
 *
 * `MenuItem.click` is typed as the `(item, window, event)` callback Electron hands the caller; it is
 * invoked here with no arguments because `buildMenu`'s handlers take none, and the cast is what says
 * so to `tsc`.
 */
async function clickFileMenuItem(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File');
    const found = file?.submenu?.items.find((item) => item.label === wanted);
    if (found === undefined) throw new Error(`no File menu item called ${wanted}`);
    (found.click as unknown as () => void)();
  }, label);
}

async function setCursor(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="coord-input"]');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

function sceneOnDisk(path: string): { cursor: number[]; layers: unknown[] } {
  return JSON.parse(readFileSync(path, 'utf8')) as { cursor: number[]; layers: unknown[] };
}

test.describe('saving a scene that was opened from disk', () => {
  test('⌘S writes over the opened file, without a Save sheet', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    const dir = mkdtempSync(join(tmpdir(), 'tetravox-save-opened-'));
    const scenePath = join(dir, 'study.tetravox.json');
    const { app, page } = await boot(target, [VOLUME]);
    try {
      await page.waitForFunction(
        () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
        undefined,
        { timeout: 30_000 }
      );

      // A scene on disk to open. Save As… is the only route that works before the fix, which is
      // exactly why the fixture is made with it.
      await stubDialogs(app, { save: scenePath });
      await setCursor(page, '-42 18 6');
      await clickAppMenu(page, 'save-as');
      await expect
        .poll(async () =>
          page.evaluate(() => window.__tetravox?.store.getState().sceneFile?.name ?? null)
        )
        .toBe('study.tetravox.json');
      expect(sceneOnDisk(scenePath).cursor).toEqual([-42, 18, 6]);

      // Reopen it into an empty scene. The path is now attached by `openScenePath`, and the Save
      // sheet has not been shown for it in this window.
      await clickAppMenu(page, 'new');
      await stubDialogs(app, { open: scenePath });
      await clickAppMenu(page, 'open-scene');
      await page.waitForFunction(
        () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
        undefined,
        { timeout: 30_000 }
      );

      // Any further dialog would be a failure of the thing under test, so both are made to cancel:
      // a Save that falls through to Save As… now writes nothing at all.
      await stubDialogs(app, {});
      await setCursor(page, '7 -3 11');
      await clickFileMenuItem(app, 'Save Scene');

      await expect.poll(() => sceneOnDisk(scenePath).cursor).toEqual([7, -3, 11]);
      // The renderer agrees: the same file is still attached, the save reported no error, and the
      // scene is no longer dirty — a write that main had refused would have set `sceneError`.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const s = window.__tetravox?.store.getState();
            return {
              name: s?.sceneFile?.name ?? null,
              dirty: s?.sceneDirty ?? null,
              error: s?.sceneError ?? null,
            };
          })
        )
        .toEqual({ name: 'study.tetravox.json', dirty: false, error: null });
      // The layer survived the round trip, so this is a saved scene and not a truncated file.
      expect(sceneOnDisk(scenePath).layers).toHaveLength(1);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
