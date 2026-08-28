/**
 * The measurement tool in the app, end to end.
 *
 * Two halves, the split `layer-collapse.spec.ts` and `props-realdata.spec.ts` already make:
 *
 *  * **Behaviour**, against the stand-in engine (`?engine=mock`) — the toolbar mode, the `m` key,
 *    the panel's rows, its value, its jump-to and its delete. The stand-in has no pointer layer, so
 *    the measurements come in through `Engine.addMeasurement`, which is the same §4.7 member the
 *    clicks end in; what is under test here is §8's shell, not the gesture. The gesture has its own
 *    analytic gate in `packages/engine/test/e2e/measure.spec.ts`.
 *  * **Real data**, against the real engine on `T1.nii.gz` + `ernie.msh` — two clicks in a pane of
 *    the running app produce a length in millimetres, and the picture the plan asks for. Skips,
 *    never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 *
 * The value in the panel is asserted to be **the engine's number**, not merely "some millimetres":
 * a panel that formatted its own arithmetic could disagree with the label drawn on the picture, and
 * two different answers to "how long is it" is the one failure a measurement tool cannot have.
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
const ERNIE = join(ROOT, 'm2m_ernie', 'ernie.msh');

/** Where the plan wants the picture. */
const SHOT = resolve(
  APP_ROOT,
  '..',
  '..',
  'docs',
  'screenshots',
  'directed-2026-08-28',
  'measure.png'
);

const measurements = async (page: Page): Promise<{ id: string; kind: string; name: string }[]> =>
  page.evaluate(
    () =>
      (window.__tetravox?.store.getState().measurements ?? []).map((m) => ({
        id: m.id,
        kind: m.kind,
        name: m.name,
      })) as { id: string; kind: string; name: string }[]
  );

// -------------------------------------------------------------------------------------------------
// Behaviour, on the stand-in engine
// -------------------------------------------------------------------------------------------------

test.describe('the measurement panel (stand-in engine)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=mock&mockStepMs=0', args: [VOLUME] });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900);
    });
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

  test('the toolbar button and `m` are the same mode, and both reach the engine', async () => {
    const button = page.locator('[data-testid="measure-toggle"]');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.__tetravox?.engine?.measureMode())).toBe(false);

    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    // §8: the projection is a projection — the engine really holds the mode.
    expect(await page.evaluate(() => window.__tetravox?.engine?.measureMode())).toBe(true);

    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    // The key does the same thing, and is suppressed in a text field like every other §7.5 binding.
    await page.locator('[data-testid="shell"]').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('m');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('m');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  test('the panel appears with the mode and lists what was placed', async () => {
    // Off, and nothing placed: no panel at all — an empty heading is chrome that says nothing.
    await expect(page.locator('[data-testid="measure-panel"]')).toHaveCount(0);

    await page.locator('[data-testid="measure-toggle"]').click();
    await expect(page.locator('[data-testid="measure-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="measure-empty"]')).toBeVisible();

    // A 3-4-5 triangle in world millimetres: the value is a number this test knows independently.
    const placed = await page.evaluate(() =>
      window.__tetravox?.engine?.addMeasurement({
        kind: 'distance',
        points: [
          [0, 0, 0],
          [3, 4, 0],
        ],
      })
    );
    expect(placed?.name).toBe('M1');

    const row = page.locator(`[data-testid="measure-row-${placed!.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-measure-kind', 'distance');
    await expect(page.locator(`[data-testid="measure-value-${placed!.id}"]`)).toHaveText('5.0 mm');
    await expect(page.locator('[data-testid="measure-count"]')).toHaveText('1');
  });

  test('an angle row reports degrees, and jump-to puts the cursor on it', async () => {
    const placed = await page.evaluate(() =>
      window.__tetravox?.engine?.addMeasurement({
        kind: 'angle',
        points: [
          [10, 0, 0],
          [0, 0, 0],
          [0, 10, 0],
        ],
      })
    );
    await expect(page.locator(`[data-testid="measure-value-${placed!.id}"]`)).toHaveText('90.0 °');
    await expect(page.locator(`[data-testid="measure-row-${placed!.id}"]`)).toHaveAttribute(
      'data-measure-kind',
      'angle'
    );

    // Jump-to sends the cursor to the vertex — §4.5 derives every 2D plane from the cursor, so all
    // three panes arrive at the measurement together.
    await page.click(`[data-testid="measure-jump-${placed!.id}"]`);
    await expect
      .poll(() => page.evaluate(() => window.__tetravox?.store.getState().cursor))
      .toEqual([0, 0, 0]);
  });

  test('delete removes the row, and the scene it was saved in', async () => {
    const before = await measurements(page);
    expect(before).toHaveLength(2);
    // Saved in the scene (§4.6), which is what makes a measurement a note rather than a flicker.
    const spec = await page.evaluate(
      () =>
        JSON.parse(JSON.stringify(window.__tetravox?.engine?.serialize())) as {
          measurements?: { id: string }[];
        }
    );
    expect(spec.measurements).toHaveLength(2);

    for (const m of before) await page.click(`[data-testid="measure-delete-${m.id}"]`);
    expect(await measurements(page)).toEqual([]);
    await expect(page.locator('[data-testid="measure-empty"]')).toBeVisible();

    const after = await page.evaluate(
      () =>
        JSON.parse(JSON.stringify(window.__tetravox?.engine?.serialize())) as {
          measurements?: unknown[];
        }
    );
    expect(after.measurements).toEqual([]);

    await page.locator('[data-testid="measure-toggle"]').click();
    await expect(page.locator('[data-testid="measure-panel"]')).toHaveCount(0);
  });
});

// -------------------------------------------------------------------------------------------------
// Real data — two clicks on ernie, and the picture
// -------------------------------------------------------------------------------------------------

test.describe('measuring on ernie (real data)', () => {
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
      async ([t1, mesh]: string[]) => {
        const tv = window.__tetravox;
        if (tv?.controller == null) throw new Error('no shell');
        for (const path of [t1, mesh] as string[]) {
          const allowed = await window.tetravox.allowPath(path);
          if (allowed === null) throw new Error(`main refused ${path}`);
          const opt = path.endsWith('.msh')
            ? await window.tetravox.allowPath(`${allowed.path}.opt`)
            : null;
          tv.controller.open([
            {
              name: allowed.path.split('/').pop() ?? allowed.path,
              path: allowed.path,
              source: {
                kind: 'path',
                path: allowed.path,
                ...(opt === null ? {} : { sidecars: { opt: opt.path } }),
              },
            },
          ]);
        }
      },
      [T1, ERNIE]
    );

    await page.waitForFunction(
      () => {
        const state = window.__tetravox?.store.getState();
        return (
          (state?.layers ?? []).some((l) => l.kind === 'volume') &&
          (state?.layers ?? []).some((l) => l.kind === 'mesh') &&
          (state?.loads ?? []).every((c) => c.state !== 'queued' && c.state !== 'loading')
        );
      },
      undefined,
      { timeout: 280_000 }
    );
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('two clicks in a pane give a length in millimetres, and a third an angle', async () => {
    test.setTimeout(180_000);
    await page.locator('[data-testid="measure-toggle"]').click();
    await expect(page.locator('[data-testid="measure-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    const canvas = page.locator('[data-testid="engine-canvas"]');
    const box = (await canvas.boundingBox())!;
    // Two points inside the top-left pane of the 2×2 layout, well clear of its edge chrome.
    const quarterW = box.width / 2;
    const quarterH = box.height / 2;
    const p1 = { x: box.x + quarterW * 0.35, y: box.y + quarterH * 0.35 };
    const p2 = { x: box.x + quarterW * 0.7, y: box.y + quarterH * 0.55 };

    await page.mouse.click(p1.x, p1.y);
    await page.mouse.click(p2.x, p2.y);
    await expect.poll(async () => (await measurements(page)).length).toBe(1);

    const [m] = await measurements(page);
    expect(m!.kind).toBe('distance');
    await expect(page.locator(`[data-testid="measure-row-${m!.id}"]`)).toBeVisible();

    // The panel's number is the engine's, to the digit — one arithmetic, two renderings.
    const expected = await page.evaluate((id) => {
      const found = (window.__tetravox?.store.getState().measurements ?? []).find(
        (x) => x.id === id
      )!;
      const [a, b] = found.points as unknown as [number[], number[]];
      return `${Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!).toFixed(1)} mm`;
    }, m!.id);
    await expect(page.locator(`[data-testid="measure-value-${m!.id}"]`)).toHaveText(expected);
    // A real head is tens of millimetres across a pane; a zero would mean both clicks landed on the
    // same world point, which is the way this can fail while still "working".
    expect(Number.parseFloat(expected)).toBeGreaterThan(1);

    // The third click promotes the same row to an angle.
    await page.mouse.click(box.x + quarterW * 0.45, box.y + quarterH * 0.75);
    await expect.poll(async () => (await measurements(page))[0]?.kind).toBe('angle');
    await expect(page.locator(`[data-testid="measure-value-${m!.id}"]`)).toContainText('°');

    mkdirSync(dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
    // ≤ 2 MB: a whole-window PNG of a 1400×900 shell, per the other directed-task pictures.
    expect(statSync(SHOT).size).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
