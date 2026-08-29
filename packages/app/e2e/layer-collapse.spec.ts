/**
 * The layer-panel disclosure, end to end.
 *
 * Two halves, and the split is the same one `shell.spec.ts` and `props-realdata.spec.ts` make:
 *
 *  * **Behaviour**, against the stand-in engine (`?engine=mock`) — a chevron per row, an
 *    expand/collapse-all in the panel header, `←`/`→` on the active row, and the two properties
 *    that make the state *chrome*: it never reaches the scene, and it survives a re-render and a
 *    reorder. Nothing here asserts a pixel; the disclosure has no pixel to assert.
 *  * **Real data**, against the real engine on `T1.nii.gz` + `ernie.msh` — the region panel of a
 *    mesh editor really goes away with its layer, and the panel screenshot the plan asks for.
 *    Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 *
 * The header line is asserted **present while collapsed** rather than merely "something is hidden":
 * a collapse that also took the eye or the opacity slider with it would pass a hide-only test.
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
const LABELS = join(TESTDATA, 'labels_simnibs.nii.gz');

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
  'layer-collapse.png'
);

/** The store's disclosure map, which is the only place this state exists. */
async function collapsed(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => window.__tetravox?.store.getState().collapsedLayers ?? {});
}

async function layerIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__tetravox?.store.getState().layers.map((l) => l.id) ?? []);
}

// -------------------------------------------------------------------------------------------------
// Behaviour, on the stand-in engine
// -------------------------------------------------------------------------------------------------

test.describe('the layer disclosure (stand-in engine)', () => {
  let app: ElectronApplication;
  let page: Page;
  let ids: string[];

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=mock&mockStepMs=0', args: [VOLUME, LABELS] });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
    await page.waitForFunction(
      () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 2,
      undefined,
      { timeout: 30_000 }
    );
    ids = await layerIds(page);
    expect(ids).toHaveLength(2);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('every row starts expanded, with its body and a chevron that says so', async () => {
    for (const id of ids) {
      await expect(page.locator(`[data-testid="layer-row-${id}"]`)).toHaveAttribute(
        'data-collapsed',
        'false'
      );
      await expect(page.locator(`[data-testid="layer-body-${id}"]`)).toBeVisible();
      await expect(page.locator(`[data-testid="layer-disclosure-${id}"]`)).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    }
    expect(await collapsed(page)).toEqual({});
  });

  test('the chevron hides the property editor and keeps the whole header line', async () => {
    const id = ids[0] as string;
    await page.click(`[data-testid="layer-disclosure-${id}"]`);

    await expect(page.locator(`[data-testid="layer-body-${id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="layer-row-${id}"]`)).toHaveAttribute(
      'data-collapsed',
      'true'
    );
    // The header line survives intact — name, eye, opacity slider (§8's row).
    await expect(page.locator(`[data-testid="layer-name-${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="layer-eye-${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="layer-opacity-${id}"]`)).toBeVisible();

    // …and it still works while collapsed: the opacity slider is a §4.7 call, not decoration.
    await page.locator(`[data-testid="layer-opacity-${id}"]`).fill('0.4');
    expect(
      await page.evaluate(
        (l) => window.__tetravox?.store.getState().layers.find((x) => x.id === l)?.opacity,
        id
      )
    ).toBeCloseTo(0.4, 5);

    // The *other* row is untouched — a disclosure is per row.
    await expect(page.locator(`[data-testid="layer-body-${ids[1] as string}"]`)).toBeVisible();

    await page.click(`[data-testid="layer-disclosure-${id}"]`);
    await expect(page.locator(`[data-testid="layer-body-${id}"]`)).toBeVisible();
  });

  test('the panel header collapses and expands every row', async () => {
    const button = page.locator('[data-testid="layer-collapse-all"]');
    await expect(button).toHaveAttribute('data-action', 'collapse');
    await button.click();
    for (const id of ids) {
      await expect(page.locator(`[data-testid="layer-body-${id}"]`)).toHaveCount(0);
    }
    // Once they are all shut the same control offers the opposite.
    await expect(button).toHaveAttribute('data-action', 'expand');
    await button.click();
    for (const id of ids) {
      await expect(page.locator(`[data-testid="layer-body-${id}"]`)).toBeVisible();
    }
    expect(await collapsed(page)).toEqual({});
  });

  test('← collapses the active row and → expands it, without nudging the cursor', async () => {
    const id = ids[1] as string;
    const row = page.locator(`[data-testid="layer-row-${id}"]`);
    await page.click(`[data-testid="layer-name-${id}"]`);
    await expect(row).toHaveAttribute('data-active', 'true');
    const cursor = await page.evaluate(() => window.__tetravox?.store.getState().cursor);

    await row.focus();
    await row.press('ArrowLeft');
    await expect(page.locator(`[data-testid="layer-body-${id}"]`)).toHaveCount(0);
    await row.press('ArrowRight');
    await expect(page.locator(`[data-testid="layer-body-${id}"]`)).toBeVisible();

    // §7.5 gives ←/→ to the in-plane cursor nudge. Scoping the binding to a focused row means the
    // cursor must not have moved while the row consumed those two presses.
    expect(await page.evaluate(() => window.__tetravox?.store.getState().cursor)).toEqual(cursor);
  });

  test('the state survives a re-render and a reorder, and never reaches the scene', async () => {
    const [bottom, top] = ids as [string, string];
    await page.click(`[data-testid="layer-disclosure-${top}"]`);
    await expect(page.locator(`[data-testid="layer-body-${top}"]`)).toHaveCount(0);

    // A re-render of the whole panel, forced by an engine event the panel is downstream of.
    await page.evaluate(() => window.__tetravox?.engine?.emit?.('cursor', [3, 4, 5]));
    await expect(page.locator(`[data-testid="layer-row-${top}"]`)).toHaveAttribute(
      'data-collapsed',
      'true'
    );

    // A reorder moves the row; the disclosure follows the layer, not the position.
    await page.click(`[data-testid="layer-down-${top}"]`);
    expect(await layerIds(page)).toEqual([top, bottom]);
    await expect(page.locator(`[data-testid="layer-row-${top}"]`)).toHaveAttribute(
      'data-collapsed',
      'true'
    );
    await expect(page.locator(`[data-testid="layer-row-${bottom}"]`)).toHaveAttribute(
      'data-collapsed',
      'false'
    );
    await page.click(`[data-testid="layer-up-${top}"]`);

    // Chrome, not scene: what the engine would serialise carries no disclosure at all.
    const spec = await page.evaluate(() => JSON.stringify(window.__tetravox?.engine?.serialize()));
    expect(spec).not.toContain('collapsed');

    await page.click(`[data-testid="layer-disclosure-${top}"]`);
  });
});

// -------------------------------------------------------------------------------------------------
// Real data — the region panel, and the picture
// -------------------------------------------------------------------------------------------------

test.describe('the layer disclosure on ernie (real data)', () => {
  let app: ElectronApplication;
  let page: Page;
  let volumeId: string;
  let meshId: string;

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

    // T1 first, then `ernie.msh` with its `.msh.opt` sidecar — the sidecar is what turns the mesh
    // editor's tag list into tissue names, and so into the region panel this test looks for.
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
        const layers = window.__tetravox?.store.getState().layers ?? [];
        return (
          layers.some((l) => l.kind === 'volume') &&
          layers.some((l) => l.kind === 'mesh') &&
          (window.__tetravox?.store.getState().loads ?? []).every(
            (c) => c.state !== 'queued' && c.state !== 'loading'
          )
        );
      },
      undefined,
      { timeout: 280_000 }
    );

    const found = await page.evaluate(() => {
      const layers = window.__tetravox?.store.getState().layers ?? [];
      return {
        volume: layers.find((l) => l.kind === 'volume')?.id ?? '',
        mesh: layers.find((l) => l.kind === 'mesh')?.id ?? '',
      };
    });
    volumeId = found.volume;
    meshId = found.mesh;
    expect(volumeId).not.toBe('');
    expect(meshId).not.toBe('');
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the region panel inside the mesh editor collapses with its layer', async () => {
    await page.click(`[data-testid="layer-name-${meshId}"]`);
    const region = page.locator(`[data-testid="region-panel-${meshId}"]`);
    await expect(region).toBeVisible();

    await page.click(`[data-testid="layer-disclosure-${meshId}"]`);
    await expect(region).toHaveCount(0);

    await page.click(`[data-testid="layer-disclosure-${meshId}"]`);
    await expect(region).toBeVisible();
  });

  test('the panel, one row collapsed and one expanded', async () => {
    // The plan's picture: T1 + ernie.msh, the mesh row shut and the volume row open.
    await page.click(`[data-testid="layer-disclosure-${meshId}"]`);
    await expect(page.locator(`[data-testid="layer-body-${meshId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="layer-body-${volumeId}"]`)).toBeVisible();

    mkdirSync(dirname(SHOT), { recursive: true });
    await page.locator('[data-testid="layer-panel"]').screenshot({ path: SHOT });
    // ≤ 300 KB, per the plan. A panel screenshot that blows past that is a screenshot of the wrong
    // thing, so this is an assertion rather than a note.
    expect(statSync(SHOT).size).toBeLessThanOrEqual(300 * 1024);

    await page.click(`[data-testid="layer-disclosure-${meshId}"]`);
  });
});
