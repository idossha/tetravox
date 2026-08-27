/**
 * **The seam between E-SCENE's pointer layer and the app's `ViewGrid`** — R1, R2 and R3 asserted
 * with a *real* mouse, inside the shipping shell, on the real engine and real data.
 *
 * `packages/engine/test/e2e/pointer.spec.ts` already proves the gestures. It proves them on
 * `test/pages/scene.html`, where the canvas is the only thing on the page. The app is not that: the
 * canvas is created by `Shell`, **adopted** by `ViewGrid` into a host `div`, and covered by an
 * absolutely-positioned grid of pane borders. Every one of R1–R3 dies silently if that grid stops
 * being `pointer-events: none`, if the canvas is re-created under the engine by a React re-render,
 * or if a capture-phase handler swallows the `pointerdown` — and none of those show up in the
 * engine's own suite, in a unit test, or in a screenshot. This file is the only place that would
 * notice.
 *
 * The oracle for "where the cursor should land" is `Engine.worldAtScreen`, which is R1's own wording
 * ("the world point implied by the pane camera") and is *not* what is under test: the question here
 * is whether a real `mousedown`/`mousemove` ever reaches the pointer layer at all, not whether the
 * projection is right. `page.mouse` is used rather than a synthetic `dispatchEvent` for exactly that
 * reason — a dispatched event would bypass the very hit-testing this file exists to check.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 */

/* eslint-disable no-empty-pattern */

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');

/** `m2m_ernie/T1.nii.gz` is 1 mm isotropic (AGENTS.md), so ½ voxel is 0.5 mm. */
const HALF_VOXEL_MM = 0.5;

interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

/** The canvas's CSS rect in viewport coordinates, plus the DPR that turns it into device pixels. */
async function canvasBox(page: Page): Promise<CanvasBox> {
  return await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="view-grid"] canvas');
    if (canvas === null) throw new Error('no canvas inside the view grid');
    const r = canvas.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      dpr: window.devicePixelRatio,
    };
  });
}

const cursorOf = async (page: Page): Promise<number[]> =>
  await page.evaluate(() => [...(window.__tetravox?.store.getState().cursor ?? [])]);

test.describe('R1–R3 through the app shell (real data)', () => {
  let app: ElectronApplication;
  let page: Page;
  let box: CanvasBox;

  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(300_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real' });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });

    await page.evaluate(async (path: string) => {
      const tv = window.__tetravox;
      if (tv?.controller == null || tv.engine == null) throw new Error('no shell');
      const allowed = await window.tetravox.allowPath(path);
      if (allowed === null) throw new Error(`main refused ${path}`);
      const name = allowed.path.split('/').pop() ?? allowed.path;
      tv.controller.open([
        { name, path: allowed.path, source: { kind: 'path', path: allowed.path } },
      ]);
      const started = Date.now();
      while (Date.now() - started < 240_000) {
        if (tv.store.getState().layers.length > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('T1.nii.gz never landed');
    }, T1);

    // The 2×2 the product opens with, so the drag happens in a pane that is *not* the whole canvas
    // — a pane-local hit test that is right only by accident on a `1x1`.
    await page.evaluate(async () => {
      const engine = window.__tetravox?.engine;
      if (engine == null) throw new Error('no engine');
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      await engine.whenSettled();
    });
    box = await canvasBox(page);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('R1: a left-drag in the axial pane moves the cursor to the world point the pane implies', async () => {
    // A point inside the axial pane, a quarter of the way in from its top-left so it is unambiguous
    // about which quadrant it belongs to and far from every pane border.
    const target = await page.evaluate(
      ([dpr]) => {
        const engine = window.__tetravox?.engine as unknown as {
          paneRect(id: string): { x: number; y: number; width: number; height: number } | null;
          worldAtScreen(id: string, x: number, y: number): number[] | null;
        };
        const rect = engine.paneRect('axial');
        if (rect === null) throw new Error('no axial pane');
        // Device pixels, canvas-relative, top-left origin — `paneRect`'s own convention.
        const devX = rect.x + rect.width * 0.35;
        const devY = rect.y + rect.height * 0.35;
        const world = engine.worldAtScreen('axial', devX, devY);
        if (world === null) throw new Error('axial pane has no world point');
        // …and the CSS offset the mouse must be moved to, which is the seam's actual arithmetic.
        return { world: [...world], cssX: devX / (dpr as number), cssY: devY / (dpr as number) };
      },
      [box.dpr] as const
    );

    const before = await cursorOf(page);
    expect(before).toHaveLength(3);

    // A real press-and-drag on the canvas. It starts elsewhere in the same pane and ends on the
    // target, so R1's "left-drag keeps moving it" is what lands the value, not the click alone.
    await page.mouse.move(box.x + target.cssX - 24, box.y + target.cssY - 24);
    await page.mouse.down();
    await page.mouse.move(box.x + target.cssX, box.y + target.cssY, { steps: 6 });
    await page.mouse.up();
    await page.evaluate(async () => {
      await window.__tetravox?.engine?.whenSettled();
    });

    const after = await cursorOf(page);
    expect(after).not.toEqual(before);
    for (let i = 0; i < 3; i += 1) {
      expect(
        Math.abs((after[i] ?? NaN) - (target.world[i] ?? NaN)),
        `cursor component ${i}: ${String(after[i])} vs ${String(target.world[i])}`
      ).toBeLessThanOrEqual(HALF_VOXEL_MM);
    }

    // …and the §8 chrome downstream of it agrees. The coordinate bar is the app's half of R1: if the
    // engine moved the cursor and the shell never heard the `cursor` event, this is where it shows.
    const shown = await page.inputValue('[data-testid="coord-input"]');
    const parsed = shown.trim().split(/\s+/).map(Number);
    expect(parsed).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs((parsed[i] ?? NaN) - (after[i] ?? NaN))).toBeLessThanOrEqual(0.05);
    }
  });

  /**
   * The defect this file was written to find, kept as its own assertion because it is a *layout*
   * invariant and nothing else in either suite asserts one.
   *
   * `interacting` (§7.2, P2-02) is entered on `pointerdown`, and A-SHELL's status bar reports it
   * because §7.2's "never degrade silently" is only true if the bar says so. The bar sits under the
   * view grid, whose `ResizeObserver` owns the canvas's drawing buffer. When the two extra readouts
   * wrapped the bar to a second line it grew 24 px → 41 px, the canvas shrank 837 → 820 device px,
   * every pane re-fitted, and the world point under a *stationary* pointer moved 4.5 px ≈ 2.93 mm
   * — mid-drag, on every gesture, in the shipping app and in no test.
   */
  test('the drawing surface does not resize because a gesture started (§7.2 × §8)', async () => {
    const rect = await page.evaluate(() => {
      const engine = window.__tetravox?.engine as unknown as {
        paneRect(id: string): { x: number; y: number; width: number; height: number } | null;
      };
      return engine.paneRect('axial');
    });
    const size = async (): Promise<{
      canvas: number[];
      pane: number[] | null;
      interacting: boolean;
    }> =>
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="view-grid"] canvas') as HTMLCanvasElement;
        const engine = window.__tetravox?.engine as unknown as {
          paneRect(id: string): { x: number; y: number; width: number; height: number } | null;
          interacting: boolean;
        };
        const p = engine.paneRect('axial');
        return {
          canvas: [c.width, c.height],
          pane: p === null ? null : [p.x, p.y, p.width, p.height],
          interacting: engine.interacting,
        };
      });

    const idle = await size();
    expect(idle.interacting).toBe(false);

    await page.mouse.move(
      box.x + (rect!.x + rect!.width / 2) / box.dpr,
      box.y + (rect!.y + rect!.height / 2) / box.dpr
    );
    await page.mouse.down();
    const held = await size();
    // The gesture is live — this is the state that used to reflow the bar.
    expect(held.interacting).toBe(true);
    expect(held.canvas).toEqual(idle.canvas);
    expect(held.pane).toEqual(idle.pane);
    await page.mouse.up();
  });

  test('R3: that drag moved the crosshair and not the scan — `camera.center` is untouched', async () => {
    const centreBefore = await page.evaluate(() => {
      const v = window.__tetravox?.engine?.scene.slices.find((x) => x.id === 'axial');
      return v === undefined ? null : [...v.camera.center];
    });
    expect(centreBefore).not.toBeNull();

    const rect = await page.evaluate(() => {
      const engine = window.__tetravox?.engine as unknown as {
        paneRect(id: string): { x: number; y: number; width: number; height: number } | null;
      };
      return engine.paneRect('axial');
    });
    expect(rect).not.toBeNull();

    const cssX = (rect!.x + rect!.width * 0.6) / box.dpr;
    const cssY = (rect!.y + rect!.height * 0.6) / box.dpr;
    await page.mouse.move(box.x + cssX - 40, box.y + cssY - 40);
    await page.mouse.down();
    await page.mouse.move(box.x + cssX, box.y + cssY, { steps: 6 });
    await page.mouse.up();
    await page.evaluate(async () => {
      await window.__tetravox?.engine?.whenSettled();
    });

    const centreAfter = await page.evaluate(() => {
      const v = window.__tetravox?.engine?.scene.slices.find((x) => x.id === 'axial');
      return v === undefined ? null : [...v.camera.center];
    });
    // R3, verbatim: "Left-drag never pans the image."
    expect(centreAfter).toEqual(centreBefore);
  });

  test('R2: ⌘/Ctrl + wheel over a pane zooms it, and the pane under the pointer is the one that zooms', async () => {
    const mmPerPx = async (): Promise<{ axial: number; coronal: number }> =>
      await page.evaluate(() => {
        const slices = window.__tetravox?.engine?.scene.slices ?? [];
        const read = (id: string): number => slices.find((v) => v.id === id)?.camera.mmPerPx ?? NaN;
        return { axial: read('axial'), coronal: read('coronal') };
      });

    const before = await mmPerPx();
    expect(Number.isFinite(before.axial)).toBe(true);

    const rect = await page.evaluate(() => {
      const engine = window.__tetravox?.engine as unknown as {
        paneRect(id: string): { x: number; y: number; width: number; height: number } | null;
      };
      return engine.paneRect('axial');
    });
    await page.mouse.move(
      box.x + (rect!.x + rect!.width / 2) / box.dpr,
      box.y + (rect!.y + rect!.height / 2) / box.dpr
    );
    await page.keyboard.down('Control');
    // `WHEEL_NOTCH` is 100 (`input/camera.ts`): a notch is `deltaY = ±100`, and the factor is
    // continuous in it (`ZOOM_STEP ** (deltaY / WHEEL_NOTCH)`) so a trackpad pinch is a fraction of
    // one. 120 would be 1.2 notches and is what a test that assumed "one event, one step" would send.
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');

    // `page.mouse.wheel` resolves before the page has handled the event (recorded in DECISIONS), so
    // the zoom is *waited for* rather than assumed to have happened by the next statement.
    await page.waitForFunction((was) => {
      const v = window.__tetravox?.engine?.scene.slices.find((x) => x.id === 'axial');
      return v !== undefined && v.camera.mmPerPx !== was;
    }, before.axial);

    const after = await mmPerPx();
    // One notch in is exactly ×1.2 smaller mm/px (`ZOOM_STEP`).
    expect(after.axial).toBeLessThan(before.axial);
    expect(after.axial).toBeCloseTo(before.axial / 1.2, 5);
    // R2 is **per pane**: the pane the pointer was not over kept its own zoom.
    expect(after.coronal).toBe(before.coronal);
  });

  test('P2-04: moving the pointer over a pane fills §8’s Mouse block, and leaving it blanks it', async () => {
    const rect = await page.evaluate(() => {
      const engine = window.__tetravox?.engine as unknown as {
        paneRect(id: string): { x: number; y: number; width: number; height: number } | null;
      };
      return engine.paneRect('coronal');
    });
    await page.mouse.move(
      box.x + (rect!.x + rect!.width * 0.45) / box.dpr,
      box.y + (rect!.y + rect!.height * 0.45) / box.dpr
    );
    await expect(page.locator('[data-testid="info-mouse-ras"]')).not.toBeEmpty();
    // One row per layer, filled from the `hover` probe rather than from the cursor's.
    await expect(
      page.locator('[data-testid="info-mouse"] [data-testid^="probe-row-"]')
    ).toHaveCount(1);

    // Off the canvas entirely: §8's "the Mouse block is blank when the pointer leaves a view".
    await page.mouse.move(box.x + box.width / 2, box.y - 20);
    await expect(page.locator('[data-testid="info-mouse-empty"]')).toBeVisible();
  });
});
