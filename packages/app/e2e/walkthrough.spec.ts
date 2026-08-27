/**
 * **The UX walk-through recorder** — ROADMAP's Phase-2 gate item "UX walk-through recorded as a GIF",
 * owned by A-SHELL.
 *
 * It is a Playwright-Electron spec rather than a script that drives the app by hand, because the
 * gate wants a walk-through of the *product*, and the only honest way to record one is to perform
 * the same actions a test performs: real clicks on real controls, against the real engine and the
 * reference dataset. `scripts/record-walkthrough.mjs` runs this and turns what it writes into a GIF.
 *
 * **Opt-in.** It runs only with `TETRAVOX_WALKTHROUGH=1`, so `pnpm e2e` does not spend a minute and
 * a few megabytes recording a video on every run. `scripts/record-walkthrough.mjs` sets it.
 *
 * **Two outputs, on purpose.**
 *  * A **PNG sequence** (`frame-000.png`, …) plus `manifest.json` naming each step. This is written
 *    with `page.screenshot()` and needs nothing but Playwright, so the recorder always produces
 *    something a human can look at — the ffmpeg fallback path in the script has real frames to fall
 *    back *to*, rather than a WebM nobody can open.
 *  * A **WebM** of the whole window, from Playwright's own `recordVideo`, which catches the motion
 *    between steps that a screenshot cannot.
 *
 * **What the walk covers, and what it does not yet.** ROADMAP's gate names "open, orbit, cut,
 * isolate, probe, screenshot". Orbit is E-SCENE's pointer layer (P2-01) and cut/isolate are E-MESH's;
 * neither is on `main` at the time of writing, and a recorder that faked them with `setView` calls
 * would be filming a thing the user cannot do. So `STEPS` below is a declarative list with those
 * three marked `pending`, skipped with their reason printed — the recorder is complete, the walk
 * grows as the owners land, and `manifest.json` records exactly which steps were filmed.
 */

/* eslint-disable no-empty-pattern */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ENABLED = process.env['TETRAVOX_WALKTHROUGH'] === '1';
const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';
const OUT =
  process.env['TETRAVOX_WALKTHROUGH_OUT'] ?? join(APP_ROOT, 'test-results', 'walkthrough');

/** Real ernie when it is available, the committed synthetic fixtures when it is not. */
const DATASETS =
  ROOT === ''
    ? [
        resolve(APP_ROOT, '..', '..', 'testdata', 'vol_u8.nii.gz'),
        resolve(APP_ROOT, '..', '..', 'testdata', 'mesh_v2_binary.msh'),
      ]
    : [join(ROOT, 'm2m_ernie', 'T1.nii.gz'), join(ROOT, 'm2m_ernie', 'ernie.msh')];

interface StepRecord {
  index: number;
  name: string;
  caption: string;
  file: string | null;
  /** Set when the feature this step would show is not on `main` yet. */
  pending?: string;
}

test.describe('UX walk-through (ROADMAP Phase-2 gate)', () => {
  test.skip(
    !ENABLED,
    'set TETRAVOX_WALKTHROUGH=1 (or run `pnpm --filter @tetravox/app walkthrough`)'
  );
  test.describe.configure({ mode: 'serial' });

  test('records the walk-through frames', async ({}, info) => {
    test.setTimeout(600_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(join(OUT, 'frames'), { recursive: true });
    mkdirSync(join(OUT, 'video'), { recursive: true });

    const app: ElectronApplication = await launchApp(target, {
      search: 'engine=real',
      recordVideo: join(OUT, 'video'),
    });
    const page: Page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });

    const steps: StepRecord[] = [];
    let index = 0;

    /** One frame, plus its caption. Two frames of the same state make a readable GIF pause. */
    const shoot = async (name: string, caption: string, repeat = 1): Promise<void> => {
      for (let i = 0; i < repeat; i++) {
        const file = `frame-${String(index).padStart(3, '0')}.png`;
        await page.screenshot({ path: join(OUT, 'frames', file) });
        steps.push({ index, name, caption, file });
        index += 1;
      }
    };

    /** A step whose feature is not on `main` yet: recorded in the manifest, not filmed. */
    const pending = (name: string, caption: string, reason: string): void => {
      steps.push({ index, name, caption, file: null, pending: reason });
      console.log(`[walkthrough] skipped "${name}": ${reason}`);
    };

    try {
      await shoot(
        'empty',
        'Tetravox opens on an empty scene: layers left, views centre, info right.'
      );

      // 1 — Open. The §8 path a user takes: the file arrives, a load card runs, a layer appears.
      await page.evaluate(async (paths: string[]) => {
        const tv = window.__tetravox;
        if (tv?.controller == null) throw new Error('no controller');
        const requests = [];
        for (const path of paths) {
          const allowed = await window.tetravox.allowPath(path);
          if (allowed !== null) {
            requests.push({
              name: path.split('/').pop() ?? path,
              path: allowed.path,
              source: { kind: 'path' as const, path: allowed.path },
            });
          }
        }
        tv.controller.open(requests);
      }, DATASETS);

      await page.waitForFunction(
        () => (window.__tetravox?.store.getState().loads.length ?? 0) > 0,
        undefined,
        { timeout: 30_000 }
      );
      await shoot('loading', 'A load card shows the phase, the percentage and the elapsed time.');

      await page.waitForFunction(
        () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 2,
        undefined,
        { timeout: 300_000 }
      );
      await page.waitForFunction(() => window.__tetravox?.engine?.whenSettled() !== undefined);
      await shoot('loaded', 'T1 and the head mesh, in the 2×2 layout.', 2);

      // 2 — Layouts and conventions, both of which are one toolbar click.
      await page.click('[data-testid="layout-1x3"]');
      await shoot('layout', 'Layouts are one click: 2×2, 1×3, 1×1, 3D only.');
      await page.click('[data-testid="radiological-toggle"]');
      await shoot('radiological', 'RAD/NEU mirrors the in-plane right axis only — never the data.');
      await page.click('[data-testid="radiological-toggle"]');
      await page.click('[data-testid="layout-2x2"]');

      // 3 — Probe. The cursor moves, and every layer answers for that point.
      const input = page.locator('[data-testid="coord-input"]');
      await input.click();
      await input.fill('-42.0 18.0 6.0');
      await input.press('Enter');
      await shoot(
        'probe',
        'The info panel answers per layer: voxel, value, element, tag, fields.',
        2
      );

      // 4 — The raw header, verbatim.
      await page.fill('[data-testid="header-search"]', 'scl');
      await shoot('header', 'The header panel is the file’s own header, not a summary of it.', 2);
      await page.fill('[data-testid="header-search"]', '');

      // 5 — The key sheet, generated from the key map.
      await page.locator('[data-testid="view-grid"]').click();
      await page.keyboard.press('?');
      await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
      await shoot(
        'keyboard',
        'Every shortcut, generated from the key map so it cannot go stale.',
        2
      );
      await page.keyboard.press('Escape');

      // 6 — Gestures, cutting and isolation: other owners' features (see the header).
      pending(
        'orbit',
        'Drag to orbit the 3D view; the crosshair follows.',
        'E-SCENE P2-01 pointer layer'
      );
      pending(
        'cut',
        'A clip plane through the head, with exact caps.',
        'E-MESH clip planes and caps'
      );
      pending('isolate', 'Isolate one tissue and everything else steps back.', 'E-MESH isolation');

      // 7 — Screenshot, with the whole option set.
      await page.click('[data-testid="screenshot-options"]');
      await page.fill('[data-testid="screenshot-width"]', '1200');
      await page.fill('[data-testid="screenshot-dpi"]', '300');
      await page.click('[data-testid="screenshot-preview"]');
      await expect(page.locator('[data-testid="screenshot-preview-image"]')).toBeVisible({
        timeout: 60_000,
      });
      await shoot(
        'screenshot',
        'Publication screenshots: size, DPI in the PNG, chrome on or off.',
        3
      );
      await page.click('[data-testid="screenshot-cancel"]');

      // 8 — Save the scene. The end of the walk, and the thing that makes it repeatable.
      await app.evaluate(
        async ({ dialog }, path) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath: path,
          })) as typeof dialog.showSaveDialog;
        },
        join(OUT, 'walkthrough.tetravox.json')
      );
      await page.click('[data-testid="scene-save-as"]');
      await expect(page.locator('[data-testid="scene-file"]')).toBeVisible({ timeout: 30_000 });
      await shoot(
        'save',
        'Save the scene: paths relative to the file, so it travels with the data.',
        3
      );

      writeFileSync(
        join(OUT, 'manifest.json'),
        `${JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            datasets: DATASETS,
            realData: ROOT !== '',
            frames: steps.filter((s) => s.file !== null).length,
            steps,
          },
          null,
          2
        )}\n`
      );
      console.log(`[walkthrough] ${steps.filter((s) => s.file !== null).length} frames → ${OUT}`);
    } finally {
      // Playwright writes the WebM on close, so this is not optional bookkeeping.
      await app.close();
    }
  });
});
