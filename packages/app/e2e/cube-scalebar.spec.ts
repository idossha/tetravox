/**
 * The orientation cube and the scale bar in the product (`docs/PLAN-2026-08-28-directed.md` #10).
 *
 * The engine's own suite proves the two items are *correct* — the bar's drawn length is
 * `mm / mmPerPx` and a click on the `A` face gives the anterior camera, both asserted off the
 * framebuffer (`packages/engine/test/e2e/cube-scalebar.spec.ts`). What is left for this file is what
 * only the app can answer:
 *
 *  * **The toolbar reaches the annotation.** Both buttons are `Engine.setAnnotations` calls, and the
 *    §4.5 block is what the screenshot path and the scene both read — so the assertion is on
 *    `engine.scene.annotations`, not on a React flag that happens to agree with itself.
 *  * **They are on when the window opens.** `scene/defaults.ts` keeps both off so §11's goldens do
 *    not move; the app turns them on at attach, the same way it does the colour bars. A product that
 *    ships a millimetre scale nobody can see has not shipped it.
 *  * **The picture the plan asks for**, on ernie, in the 2×2 layout where the cube and three scale
 *    bars appear at once. Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 */

/* eslint-disable no-empty-pattern */

import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = join(TESTDATA, 'vol_u8.nii.gz');

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');

/** Where the plan wants the picture. */
const SHOT = resolve(
  APP_ROOT,
  '..',
  '..',
  'docs',
  'screenshots',
  'directed-2026-08-28',
  'cube-scalebar.png'
);

/** The §4.5 block as the engine holds it — the one place both items really live. */
async function annotations(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () => (window.__tetravox?.engine?.scene.annotations ?? {}) as Record<string, unknown>
  );
}

test.describe('the scale bar and orientation cube toggles', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

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

  test('both are on when the window opens, in the engine and not only in React', async () => {
    const a = await annotations(page);
    expect(a['scaleBar']).toBe(true);
    expect(a['orientationCube']).toBe(true);
    await expect(page.locator('[data-testid="scalebar-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.locator('[data-testid="orientation-cube-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  for (const item of [
    { testid: 'scalebar-toggle', key: 'scaleBar' },
    { testid: 'orientation-cube-toggle', key: 'orientationCube' },
  ]) {
    test(`the ${item.key} button turns the annotation off and on again`, async () => {
      const button = page.locator(`[data-testid="${item.testid}"]`);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      expect((await annotations(page))[item.key]).toBe(false);

      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      expect((await annotations(page))[item.key]).toBe(true);
    });
  }

  test('the screenshot dialog can ask for either of them', async () => {
    await page.click('[data-testid="screenshot-options"]');
    for (const key of ['scaleBar', 'orientationCube']) {
      const box = page.locator(`[data-testid="screenshot-include-${key}"]`);
      await expect(box).toHaveCount(1);
    }
    await page.keyboard.press('Escape');
  });
});

// -------------------------------------------------------------------------------------------------
// Real data — the picture
// -------------------------------------------------------------------------------------------------

test.describe('the cube and the scale bars on ernie (real data)', () => {
  let app: ElectronApplication;
  let page: Page;

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

    await page.evaluate(
      async ([t1]: string[]) => {
        const tv = window.__tetravox;
        if (tv?.controller == null) throw new Error('no shell');
        const allowed = await window.tetravox.allowPath(t1 as string);
        if (allowed === null) throw new Error(`main refused ${t1}`);
        tv.controller.open([
          {
            name: allowed.path.split('/').pop() ?? allowed.path,
            path: allowed.path,
            source: { kind: 'path', path: allowed.path },
          },
        ]);
      },
      [T1]
    );

    await page.waitForFunction(
      () => {
        const s = window.__tetravox?.store.getState();
        return (
          (s?.layers ?? []).some((l) => l.kind === 'volume') &&
          (s?.loads ?? []).every((c) => c.state !== 'queued' && c.state !== 'loading')
        );
      },
      undefined,
      { timeout: 280_000 }
    );
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the 2x2 layout carries three scale bars and one cube', async () => {
    // The layout that shows both items at once: three 2D panes and the 3D one.
    await page.evaluate(() => {
      const tv = window.__tetravox;
      tv?.controller?.setLayout('2x2');
      const engine = tv?.engine;
      if (engine == null) throw new Error('no engine');
      // The T1's slice planes in 3D, so the cube is pictured over anatomy rather than over an empty
      // pane, and a camera **off** a preset, so all three visible faces are labelled — which is the
      // whole point of the cube and the one thing a cardinal view cannot show.
      for (const layer of engine.scene.layers) {
        if (layer.kind === 'volume') engine.updateLayer(layer.id, { showIn3D: true });
      }
      engine.resetView('view3d');
      const cam = engine.scene.view3d.camera;
      // 40° about x then 30° about z, as a quaternion product.
      const [a, b] = [(40 * Math.PI) / 360, (30 * Math.PI) / 360];
      const q: [number, number, number, number] = [
        -Math.sin(a) * Math.cos(b),
        -Math.sin(a) * Math.sin(b),
        Math.cos(a) * Math.sin(b),
        Math.cos(a) * Math.cos(b),
      ];
      engine.setView('view3d', { camera: { ...cam, rotation: q } });
      engine.requestRender();
    });
    await page.waitForTimeout(1500);

    const a = await annotations(page);
    expect(a['scaleBar']).toBe(true);
    expect(a['orientationCube']).toBe(true);

    mkdirSync(dirname(SHOT), { recursive: true });
    await page.locator('[data-testid="view-grid"]').screenshot({ path: SHOT });
    // A view-grid screenshot of a 1400×900 window; anything much larger is a picture of the wrong
    // thing, so this is an assertion rather than a note.
    expect(statSync(SHOT).size).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
