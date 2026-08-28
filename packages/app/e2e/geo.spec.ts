/**
 * Opening a Gmsh parsed post-processing view in the app: the two ways a file arrives, what the
 * layer panel then holds, and the two editor controls the format brought with it (task 6).
 *
 * Against the **real** engine (`?engine=real`), because the whole point is that a `.geo` really
 * parses — the stand-in engine has no reader. The fixture is committed
 * (`testdata/view_electrodes.geo`), so this runs everywhere and not only where
 * `TETRAVOX_TESTDATA` is set.
 *
 * §8's four ways a file arrives are one code path in `open/sources.ts`: a drop and a menu Open
 * differ only in how the path is obtained, so this drives the drop (which is a real DOM gesture)
 * and the `controller.open` a menu Open ends in. **The dialog's own filters are a unit test**
 * (`src/main/menu.test.ts`) — `OPEN_FILTERS` is a constant in main, and reaching it through an
 * OS-modal dialog would test Electron rather than this repo.
 */

/* eslint-disable no-empty-pattern */

import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
/** 2 `SP` + a `VP` + a second view's `SP` = 4 points; 2 `T3` labels; `SL`, `ST` and `SQ` besides. */
const VIEW_GEO = join(TESTDATA, 'view_electrodes.geo');
const SCRIPT_GEO = join(TESTDATA, 'view_geometry_script.geo');

interface PointsSnapshot {
  id: string;
  points: number;
  labels: number;
  showLabels: boolean;
  hasLines: boolean;
  firstValue: number | undefined;
}

/** Whatever points layer the store holds, reduced to the things this spec asserts. */
async function pointsLayer(page: Page): Promise<PointsSnapshot | null> {
  return await page.evaluate(() => {
    const layer = window.__tetravox?.store.getState().layers.find((l) => l.kind === 'points') as
      | {
          id: string;
          points?: { value?: number }[];
          labels?: unknown[];
          showLabels?: boolean;
          lineSegments?: { length: number };
        }
      | undefined;
    if (layer === undefined) return null;
    return {
      id: layer.id,
      points: layer.points?.length ?? 0,
      labels: layer.labels?.length ?? 0,
      showLabels: layer.showLabels === true,
      hasLines: (layer.lineSegments?.length ?? 0) > 0,
      firstValue: layer.points?.[0]?.value,
    };
  });
}

async function waitForPoints(page: Page): Promise<PointsSnapshot> {
  await page.waitForFunction(
    () => window.__tetravox?.store.getState().layers.some((l) => l.kind === 'points') === true,
    undefined,
    { timeout: 60_000 }
  );
  const snapshot = await pointsLayer(page);
  if (snapshot === null) throw new Error('no points layer');
  return snapshot;
}

/** Drive a native control the way a user does — React tracks the DOM value itself. */
async function setControl(page: Page, testId: string, value: string): Promise<void> {
  await page.evaluate(
    ([id, v]) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el === null) throw new Error(`no control [data-testid="${id}"]`);
      const proto =
        el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter === undefined) throw new Error('no value setter');
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [testId, value] as const
  );
}

/** Drop path-backed `File`s onto the shell — the mechanism `shell.spec.ts` established. */
async function dropFiles(page: Page, paths: readonly string[]): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'tvx-drop-probe';
    document.body.appendChild(input);
  });
  await page.setInputFiles('#tvx-drop-probe', [...paths]);
  await page.evaluate(() => {
    const input = document.getElementById('tvx-drop-probe') as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
    document
      .querySelector('[data-testid="shell"]')
      ?.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
      );
    input.remove();
  });
}

test.describe('a Gmsh parsed view in the app', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(180_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real' });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('a dropped .geo opens as a points layer with its labels and lines', async () => {
    test.setTimeout(120_000);
    await dropFiles(page, [VIEW_GEO]);
    const layer = await waitForPoints(page);

    expect(layer.points).toBe(4);
    expect(layer.labels).toBe(2);
    // Labels default on, because the view brought text.
    expect(layer.showLabels).toBe(true);
    // The fixture's one `SL`.
    expect(layer.hasLines).toBe(true);
    // `SP(1, 2, 3){10}` — the value came through beside the position.
    expect(layer.firstValue).toBe(10);
  });

  test('the editor sizes the labels and colours the points by value', async () => {
    const layer = await waitForPoints(page);
    await page.click(`[data-testid="layer-row-${layer.id}"]`).catch(() => {
      /* the row may already be active; selecting it is a convenience, not the assertion */
    });

    // Label size — offered because this layer has labels.
    await expect(page.locator(`[data-testid="points-label-scale-${layer.id}"]`)).toBeVisible();
    await setControl(page, `points-label-scale-${layer.id}`, '2');
    await expect
      .poll(async () =>
        page.evaluate((id) => {
          const l = window.__tetravox?.store.getState().layers.find((x) => x.id === id) as
            { labelScale?: number } | undefined;
          return l?.labelScale;
        }, layer.id)
      )
      .toBe(2);

    // Colour-by — offered because the points carry values.
    await setControl(page, `points-value-mode-${layer.id}`, 'value');
    await setControl(page, `points-colormap-${layer.id}`, 'turbo');
    await expect
      .poll(async () =>
        page.evaluate((id) => {
          const l = window.__tetravox?.store.getState().layers.find((x) => x.id === id) as
            | { valueMode?: string; colormap?: string; valueRange?: { lo: number; hi: number } }
            | undefined;
          return { mode: l?.valueMode, map: l?.colormap, range: l?.valueRange };
        }, layer.id)
      )
      // The range was seeded from the fixture's own values on the first switch: 5 (the `VP`'s
      // magnitude) … 20, with the second view's 0.5 as the floor.
      .toMatchObject({ mode: 'value', map: 'turbo' });
  });

  test('a geometry script fails with the message that names the command', async () => {
    const message = await page.evaluate(async (path: string) => {
      const tv = window.__tetravox;
      if (tv?.controller == null) throw new Error('no shell');
      const allowed = await window.tetravox.allowPath(path);
      if (allowed === null) throw new Error(`main refused ${path}`);
      tv.controller.open([
        {
          name: allowed.path.split('/').pop() ?? allowed.path,
          path: allowed.path,
          source: { kind: 'path', path: allowed.path },
        },
      ]);
      // The failure surfaces on the load card (`lib/loads.ts`) and, for a toast-worthy code, in a
      // toast's `detail`. Either carries the reader's message; the card is the one that always does.
      const started = Date.now();
      while (Date.now() - started < 60_000) {
        const state = tv.store.getState();
        const failed = state.loads.find((c) => c.state === 'failed');
        if (failed?.message != null && failed.message !== '') return failed.message;
        await new Promise((r) => setTimeout(r, 20));
      }
      return 'no error';
    }, SCRIPT_GEO);
    expect(message).toContain('geometry script');
  });
});
