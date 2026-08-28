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
 * **What the walk covers.** ROADMAP's gate names "open, orbit, cut, isolate, probe, screenshot", and
 * all six are filmed. Orbit is E-SCENE's pointer layer (P2-01) and cut/isolate are E-MESH's; while
 * those were unmerged the three steps were recorded in the manifest as `pending` rather than faked
 * with `setView` calls, because a recorder that films a thing the user cannot do is worse than a
 * short walk. They are merged now, so the walk performs them the way a user does: a real drag in the
 * 3D pane, the clip-plane panel's Add, the isolation panel's tag toggle. `pending()` stays for the
 * next feature that is filmed before it lands.
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

    /** Wait for the engine to be idle — §7.2's `whenSettled`, through the E2E handle. */
    const settle = async (p: Page): Promise<void> => {
      await p.evaluate(async () => {
        await window.__tetravox?.engine?.whenSettled();
      });
    };

    /** The id of the mesh layer, or `null` when the walk is running on volumes only. */
    const meshLayerId = async (p: Page): Promise<string | null> =>
      p.evaluate(
        () => window.__tetravox?.store.getState().layers.find((l) => l.kind === 'mesh')?.id ?? null
      );

    /** Set a range/select the way a user's drag does: the native setter, then input + change. */
    const setControl = async (p: Page, testId: string, value: string): Promise<void> => {
      await p.evaluate(
        ([id, v]) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          if (el === null) throw new Error(`no control [data-testid="${id}"]`);
          const proto =
            el instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter === undefined) throw new Error('no value setter');
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        [testId, value] as const
      );
    };

    /** Open one collapsed §8 property section, if it is not open already. */
    const openSection = async (p: Page, testId: string): Promise<void> => {
      const section = p.locator(`[data-testid="${testId}"]`);
      if ((await section.getAttribute('data-open')) !== 'true') {
        await p.click(`[data-testid="${testId}-toggle"]`);
        await expect(section).toHaveAttribute('data-open', 'true');
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

      // 1 — Open. **Through the Open… button**, with the OS dialog stubbed in main, so the walk
      // takes the §8 path a user takes: `open/sources.ts` derives the §6.5.1 sidecars beside each
      // file, and §7.6 seeds the tissue names and colours from `ernie.msh.opt`. Building the
      // requests by hand here — which is what this step used to do — skipped that, and filmed a
      // tissue table reading `tag 1` … `tag 1099` on a dataset whose names the product does show.
      for (const dataset of DATASETS) {
        await app.evaluate(async ({ dialog }, path) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [path],
          })) as typeof dialog.showOpenDialog;
        }, dataset);
        await page.click('[data-testid="open-button"]');
      }

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

      // Back to the probe point. Step 5 clicks the view grid to take the keyboard back (§7.5), and
      // a left-click in a 2D pane *is* "set the cursor" (R1) — at the grid's centre that lands on a
      // pane corner, which put the walk 152 mm below the head and filmed two empty panes.
      await input.click();
      await input.fill('-42.0 18.0 6.0');
      await input.press('Enter');
      await settle(page);

      // 6 — Gestures, cutting and isolation. All three are performed through the product's own
      // controls: a real `pointerdown`/`move`/`up` in the 3D pane (§7.5's arcball) and the two mesh
      // panels' buttons. Nothing here calls the engine directly.
      const grid = page.locator('[data-testid="view-grid"]');
      const box = await grid.boundingBox();
      if (box === null) throw new Error('the view grid has no box');
      // The 3D pane is the bottom-right cell of the 2×2 (`scene/defaults.ts`).
      const orbitAt = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.75 };
      await page.mouse.move(orbitAt.x, orbitAt.y);
      await page.mouse.down();
      await page.mouse.move(orbitAt.x + 90, orbitAt.y - 40, { steps: 12 });
      await page.mouse.up();
      await settle(page);
      await shoot('orbit', 'Drag to orbit the 3D view; the crosshair follows.', 2);

      const meshLayer = await meshLayerId(page);
      if (meshLayer !== null) {
        await page.click(`[data-testid="layer-name-${meshLayer}"]`);
        await openSection(page, `mesh-clip-${meshLayer}`);
        await page.click(`[data-testid="mesh-clip-add-${meshLayer}"]`);
        // The added plane's default normal is `+Z` (`ClipPlanes.tsx`) with an offset outside the
        // scene, so it clips nothing — right for "added, not yet moved", wrong for a picture of a
        // cut. Dragging the offset to 0 puts it through the middle of the head and shows §7.4's
        // exact caps, which is what this frame is for.
        await setControl(page, `mesh-clip-offset-${meshLayer}-0`, '0');
        await settle(page);
        // The plane really is clipping, not merely present: a picture cannot say so and a caption
        // must not be the only evidence.
        expect(
          await page.evaluate((id: string) => {
            const l = window.__tetravox?.store.getState().layers.find((x) => x.id === id);
            return l?.kind === 'mesh' ? l.clip.planes[0]?.plane : null;
          }, meshLayer)
        ).toEqual({ normal: [0, 0, 1], offset: 0 });
        await shoot('cut', 'A clip plane through the head, with exact caps.', 2);

        await openSection(page, `mesh-isolate-${meshLayer}`);
        // Tag 2 is GM on ernie and tet tag 2 on the synthetic lattice — present either way.
        const tag = page.locator(`[data-testid="mesh-isolate-tag-${meshLayer}-2"]`);
        if ((await tag.count()) > 0) {
          await tag.click();
          await settle(page);
          await shoot('isolate', 'Isolate one tissue and everything else steps back.', 2);
          await page.click(`[data-testid="mesh-isolate-clear-${meshLayer}"]`);
        } else {
          pending('isolate', 'Isolate one tissue and everything else steps back.', 'no tet tag 2');
        }
        await page.click(`[data-testid="mesh-clip-remove-${meshLayer}-0"]`);
        await settle(page);
      } else {
        pending('cut', 'A clip plane through the head, with exact caps.', 'no mesh layer');
        pending('isolate', 'Isolate one tissue and everything else steps back.', 'no mesh layer');
      }

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
