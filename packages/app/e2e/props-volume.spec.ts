/**
 * The §8 volume property editor, the histogram widget and the R5 Region panel, end to end.
 *
 * Against the **stand-in** engine (`?engine=mock`), on purpose. §8's rule is "everything the UI can
 * do must be reachable from the `Engine` API alone. No logic in React", and the only way to assert
 * that from outside is to press the control a user would press and then read what reached the
 * engine's scene — which is exactly what `window.__tetravox.store` projects (`layers` is
 * `Scene.layers`, refreshed on every `layers` event). Nothing here asserts a pixel; that is §11's job
 * and the engine owners'.
 *
 * The expected values are **derived** from the dataset the stand-in produced (its `Stats`, its
 * `labelIds`) rather than transcribed, so a change to the fixture can never quietly turn an
 * assertion into a tautology.
 *
 * Runs in both projects (`dev` and `packaged`), like `shell.spec.ts`.
 */

/* eslint-disable no-empty-pattern */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
/** The stand-in reads "labels" in the name and produces a §4.3 label volume, table and all. */
const LABELS = join(TESTDATA, 'labels_simnibs.nii.gz');
/** `_4d` in the name is what makes the stand-in report `nvols > 1` — audit P2-05's spinner. */
const FOUR_D = join(TESTDATA, 'vol_4d.nii.gz');

/**
 * A private Chromium user-data directory per run.
 *
 * `src/main/index.ts` takes `app.requestSingleInstanceLock()`, and that lock is scoped to the user
 * data directory — which every Tetravox worktree on this machine shares by default. A second agent
 * running its own app E2E therefore makes **this** launch quit with exit code 0 and forward its argv
 * to the other window, surfacing here as "Target page, context or browser has been closed". A
 * per-run directory scopes the lock to this run; `collectCliPaths` drops it because it starts with
 * `-`, so the §8 argv path is unaffected.
 */
let userDataDir: string | null = null;

async function boot(target: LaunchTarget): Promise<{ app: ElectronApplication; page: Page }> {
  userDataDir = mkdtempSync(join(tmpdir(), 'tvx-props-volume-'));
  const app = await launchApp(target, {
    search: 'engine=mock&mockStepMs=20',
    args: [`--user-data-dir=${userDataDir}`, LABELS, FOUR_D],
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 2,
    undefined,
    { timeout: 30_000 }
  );
  return { app, page };
}

/** The layer of the dataset whose name contains `needle`, as the store holds it. */
async function layerIdFor(page: Page, needle: string): Promise<string> {
  return page.evaluate((n) => {
    const state = window.__tetravox?.store.getState();
    const layer = state?.layers.find((l) => l.name.includes(n));
    if (layer === undefined) throw new Error(`no layer named ${n}`);
    return layer.id;
  }, needle);
}

/** One layer, straight out of the scene the engine owns. */
async function layerState(page: Page, id: string): Promise<Record<string, unknown>> {
  return page.evaluate((layerId) => {
    const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === layerId);
    if (layer === undefined) throw new Error(`no layer ${layerId}`);
    // `visibleLabels` is a `Uint32Array`; Playwright's serialiser turns one into `{0: …}`, which is
    // unassertable. Every typed array crosses as a plain number array, named for what it is.
    const clone = { ...layer } as Record<string, unknown>;
    const visible = 'visibleLabels' in layer ? layer.visibleLabels : undefined;
    clone['visibleLabelsList'] = visible === undefined ? null : [...visible];
    delete clone['visibleLabels'];
    return clone;
  }, id);
}

async function datasetStats(
  page: Page,
  id: string
): Promise<{
  min: number;
  max: number;
  histogramLo: number;
  histogramHi: number;
  percentiles: Record<string, number>;
  labelIds: number[];
}> {
  return page.evaluate((layerId) => {
    const state = window.__tetravox?.store.getState();
    const layer = state?.layers.find((l) => l.id === layerId);
    const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
    if (ds === undefined || ds.kind !== 'volume') throw new Error('no volume dataset');
    return {
      min: ds.stats.min,
      max: ds.stats.max,
      histogramLo: ds.stats.histogramLo,
      histogramHi: ds.stats.histogramHi,
      percentiles: { ...ds.stats.percentiles } as unknown as Record<string, number>,
      labelIds: ds.labelIds === undefined ? [] : [...ds.labelIds],
    };
  }, id);
}

// ------------------------------------------------------------------------------------------------
// One app for the whole file.
//
// `src/main/index.ts` takes `app.requestSingleInstanceLock()`, so a second Electron launched while
// the first is alive **quits immediately with exit code 0** and forwards its argv — which surfaces as
// "Target page, context or browser has been closed" in whichever spec launched second. Booting once
// here, rather than per `describe`, keeps that from ever being a race.
// ------------------------------------------------------------------------------------------------

let app: ElectronApplication;
let page: Page;
let labels: string;
let fourD: string;

test.beforeAll(async ({}, workerInfo) => {
  const target = workerInfo.project.name as LaunchTarget;
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');
  ({ app, page } = await boot(target));
  labels = await layerIdFor(page, 'labels_simnibs');
  fourD = await layerIdFor(page, 'vol_4d');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------

test.describe('the §8 volume property editor', () => {
  test('every §4.4 kind gets its editor, and a volume gets this one', async () => {
    await expect(page.getByTestId(`volume-properties-${labels}`)).toBeVisible();
    await expect(page.getByTestId(`volume-properties-${fourD}`)).toBeVisible();
  });

  test('the colormap picker is one updateLayer call', async () => {
    await page.getByTestId(`volume-colormap-${fourD}`).selectOption('viridis');
    expect((await layerState(page, fourD))['colormap']).toBe('viridis');
  });

  test('switching to heat carries the window across and seeds mid at the midpoint', async () => {
    const before = (await layerState(page, fourD))['scale'] as { lo: number; hi: number };
    await page.getByTestId(`volume-scale-kind-${fourD}`).selectOption('heat');
    const scale = (await layerState(page, fourD))['scale'] as Record<string, unknown>;
    expect(scale['kind']).toBe('heat');
    expect(scale['min']).toBeCloseTo(before.lo, 6);
    expect(scale['max']).toBeCloseTo(before.hi, 6);
    expect(scale['mid']).toBeCloseTo((before.lo + before.hi) / 2, 6);
  });

  test('heat’s min / mid / max, truncate, inverse and the negative branch all reach the layer', async () => {
    await page.getByTestId(`volume-heat-min-${fourD}`).fill('10');
    await page.getByTestId(`volume-heat-max-${fourD}`).fill('90');
    await page.getByTestId(`volume-heat-mid-${fourD}`).fill('40');
    await page.getByTestId(`volume-heat-truncate-${fourD}`).click();
    await page.getByTestId(`volume-heat-inverse-${fourD}`).click();
    await page.getByTestId(`volume-heat-negative-${fourD}`).selectOption('separate');

    const scale = (await layerState(page, fourD))['scale'] as Record<string, unknown>;
    expect(scale).toMatchObject({
      kind: 'heat',
      min: 10,
      mid: 40,
      max: 90,
      truncate: true,
      inverse: true,
      negative: 'separate',
    });

    // §7.6's separate negative branch is a second colormap, so its picker only exists there.
    await page.getByTestId(`volume-colormap-negative-${fourD}`).selectOption('blue-cyan');
    expect((await layerState(page, fourD))['colormapNegative']).toBe('blue-cyan');
  });

  test('heat’s mid is clamped into [min, max] rather than escaping the ramp', async () => {
    await page.getByTestId(`volume-heat-mid-${fourD}`).fill('9999');
    const scale = (await layerState(page, fourD))['scale'] as Record<string, unknown>;
    expect(scale['mid']).toBe(scale['max']);
  });

  test('back to linear, keeping [min, max] as [lo, hi]', async () => {
    await page.getByTestId(`volume-scale-kind-${fourD}`).selectOption('linear');
    expect((await layerState(page, fourD))['scale']).toEqual({ kind: 'linear', lo: 10, hi: 90 });
  });

  test('the threshold, its mode, its symmetric flag and softEdge are four separate patches', async () => {
    await page.getByTestId(`volume-threshold-lo-${fourD}`).fill('12');
    await page.getByTestId(`volume-threshold-hi-${fourD}`).fill('88');
    await page.getByTestId(`volume-threshold-symmetric-${fourD}`).click();
    await page.getByTestId(`volume-threshold-mode-${fourD}`).selectOption('clamp');
    // §4.2: softEdge is the width of the alpha ramp as a FRACTION of `hi - lo`, so the slider is 0..1.
    await page.getByTestId(`volume-threshold-softedge-${fourD}`).fill('0.5');

    expect((await layerState(page, fourD))['threshold']).toEqual({
      lo: 12,
      hi: 88,
      symmetric: true,
      mode: 'clamp',
      softEdge: 0.5,
    });
  });

  test('showIn3D is a toggle, and it starts off (§7.3’s planes are opt-in)', async () => {
    const toggle = page.getByTestId(`volume-show-in-3d-${fourD}`);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    expect((await layerState(page, fourD))['showIn3D']).toBe(true);
  });

  test('the 4D spinner steps the frame and disables itself at the ends (audit P2-05)', async () => {
    await expect(page.getByTestId(`volume-frame-prev-${fourD}`)).toBeDisabled();
    await page.getByTestId(`volume-frame-next-${fourD}`).click();
    expect((await layerState(page, fourD))['volumeIndex']).toBe(1);
    await page.getByTestId(`volume-frame-next-${fourD}`).click();
    expect((await layerState(page, fourD))['volumeIndex']).toBe(2);
    await expect(page.getByTestId(`volume-frame-next-${fourD}`)).toBeDisabled();
    await page.getByTestId(`volume-frame-prev-${fourD}`).click();
    expect((await layerState(page, fourD))['volumeIndex']).toBe(1);
  });

  test('a 3D volume has no spinner at all, rather than a dead one', async () => {
    await expect(page.getByTestId(`volume-frame-${labels}`)).toHaveCount(0);
  });

  test('a label volume’s interpolation is nearest by definition, and says which reason', async () => {
    await expect(page.getByTestId(`volume-interpolation-${labels}`)).toBeDisabled();
    const flag = page.getByTestId(`volume-forced-nearest-${labels}`);
    await expect(flag).toHaveAttribute('data-reason', 'label');
  });

  test('a filterable float volume is interpolable, and switching it is one patch', async () => {
    // The stand-in reports `floatLinear: true` and a filterable R32F, so §7.1's fallback is silent —
    // audit P2-08's *warning* leg is asserted by `patches.test.ts` against `filterable: false`.
    await expect(page.getByTestId(`volume-forced-nearest-${fourD}`)).toHaveCount(0);
    await page.getByTestId(`volume-interpolation-${fourD}`).selectOption('nearest');
    expect((await layerState(page, fourD))['interpolation']).toBe('nearest');
  });

  test('label mode reveals the outline width only when there is an outline to size', async () => {
    await expect(page.getByTestId(`volume-outline-width-${labels}`)).toHaveCount(0);
    await page.getByTestId(`volume-label-mode-${labels}`).selectOption('both');
    expect((await layerState(page, labels))['labelMode']).toBe('both');
    await page.getByTestId(`volume-outline-width-${labels}`).fill('3');
    expect((await layerState(page, labels))['outlineWidthPx']).toBe(3);
  });
});

// ------------------------------------------------------------------------------------------------

test.describe('the §8 histogram widget', () => {
  let id: string;
  let prefix: string;

  test.beforeAll(() => {
    id = fourD;
    prefix = `volume-histogram-${id}`;
  });

  test('the log-y toggle is on by default, because the air peak buries everything else', async () => {
    await expect(page.getByTestId(`${prefix}-logy`)).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId(`${prefix}-logy`).click();
    await expect(page.getByTestId(`${prefix}-logy`)).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId(`${prefix}-logy`).click();
  });

  test('the four presets compute their window from Stats.percentiles', async () => {
    const stats = await datasetStats(page, id);
    const cases: [string, number, number][] = [
      ['min-max', stats.min, stats.max],
      ['p2-p98', stats.percentiles['2'] as number, stats.percentiles['98'] as number],
      ['p50-p99.9', stats.percentiles['50'] as number, stats.percentiles['99.9'] as number],
      [
        'sym-p99',
        -Math.abs(stats.percentiles['99'] as number),
        Math.abs(stats.percentiles['99'] as number),
      ],
    ];
    for (const [preset, lo, hi] of cases) {
      await page.getByTestId(`${prefix}-preset-${preset}`).click();
      const scale = (await layerState(page, id))['scale'] as { lo: number; hi: number };
      expect(scale.lo, preset).toBeCloseTo(lo, 6);
      expect(scale.hi, preset).toBeCloseTo(hi, 6);
      await expect(page.getByTestId(`${prefix}-preset-${preset}`)).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    }
  });

  test('the strip along x says which colormap it would paint even before it can paint it', async () => {
    await page.getByTestId(`volume-colormap-${id}`).selectOption('turbo');
    await expect(page.getByTestId(`${prefix}-colormap-name`)).toHaveText('turbo');
  });

  test('dragging the window’s low handle lands on the value under the pointer', async () => {
    await page.getByTestId(`${prefix}-preset-min-max`).click();
    const stats = await datasetStats(page, id);

    // Park the threshold in the top fifth of the axis first. `handleAt` gives a tie to the threshold
    // — the pair that sits *inside* the window is the one on top — so a threshold left near the low
    // end would be the handle this drag grabbed, and the test would be asserting the other feature.
    const span = stats.histogramHi - stats.histogramLo;
    await page
      .getByTestId(`volume-threshold-lo-${id}`)
      .fill(String(stats.histogramLo + 0.8 * span));
    await page.getByTestId(`volume-threshold-hi-${id}`).fill(String(stats.histogramHi));
    const plot = page.getByTestId(`${prefix}-plot`);
    // `page.mouse` is in viewport coordinates and the layer panel scrolls, so the widget has to be
    // brought into view before its box means anything. `click()` does this itself; `mouse` cannot.
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    if (box === null) throw new Error('the plot has no box');

    // A third of the way across the axis. The axis is `histogramLo … histogramHi` (never the window),
    // which is why this expectation can be computed before the drag rather than read after it.
    const t = 1 / 3;
    const expected = stats.histogramLo + t * (stats.histogramHi - stats.histogramLo);

    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + t * box.width, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();

    const scale = (await layerState(page, id))['scale'] as { lo: number; hi: number };
    // ±0.5 % of the axis: a CSS pixel is worth (hi − lo)/width, and the pointer lands on one.
    const tol = 0.005 * (stats.histogramHi - stats.histogramLo);
    expect(Math.abs(scale.lo - expected)).toBeLessThan(tol);
    expect(scale.hi).toBeCloseTo(stats.max, 6);
  });

  test('dragging a threshold handle moves the threshold and leaves the window alone', async () => {
    const stats = await datasetStats(page, id);
    await page.getByTestId(`volume-threshold-lo-${id}`).fill(String(stats.histogramLo));
    await page.getByTestId(`volume-threshold-hi-${id}`).fill(String(stats.histogramHi));
    const windowBefore = (await layerState(page, id))['scale'];

    const plot = page.getByTestId(`${prefix}-plot`);
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    if (box === null) throw new Error('the plot has no box');
    const t = 0.75;
    const expected = stats.histogramLo + t * (stats.histogramHi - stats.histogramLo);

    // Grab the threshold's high handle, which sits at the right edge with the window's.
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + t * box.width, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();

    const layer = await layerState(page, id);
    const threshold = layer['threshold'] as { lo: number; hi: number };
    const tol = 0.005 * (stats.histogramHi - stats.histogramLo);
    expect(Math.abs(threshold.hi - expected)).toBeLessThan(tol);
    expect(layer['scale']).toEqual(windowBefore);
  });
});

// ------------------------------------------------------------------------------------------------

test.describe('the R5 Region panel', () => {
  let id: string;
  let ids: number[];

  test.beforeAll(async () => {
    id = labels;
    ids = (await datasetStats(page, id)).labelIds;
  });

  test('a label volume gets a panel; a plain intensity volume does not', async () => {
    await expect(page.getByTestId(`region-panel-${id}`)).toHaveAttribute(
      'data-kind',
      'labelVolume'
    );
    await expect(page.getByTestId(`region-panel-${fourD}`)).toHaveCount(0);
  });

  test('one row per label id in §6.1’s sorted-unique list', async () => {
    await expect(page.getByTestId(`region-list-${id}`)).toHaveAttribute(
      'data-rows',
      String(ids.length)
    );
    for (const labelId of ids) {
      await expect(page.getByTestId(`region-id-${id}-${labelId}`)).toHaveText(String(labelId));
    }
  });

  test('search-as-you-type filters by name and by exact id', async () => {
    const search = page.getByTestId(`region-search-${id}`);
    await search.fill('matter');
    await expect(page.getByTestId(`region-list-${id}`)).toHaveAttribute('data-rows', '2');
    await search.fill('10');
    await expect(page.getByTestId(`region-list-${id}`)).toHaveAttribute('data-rows', '1');
    await expect(page.getByTestId(`region-name-${id}-10`)).toBeVisible();
    await search.fill('');
    await expect(page.getByTestId(`region-list-${id}`)).toHaveAttribute(
      'data-rows',
      String(ids.length)
    );
  });

  test('the eye writes `visibleLabels`, and “all visible” is undefined and not a full list', async () => {
    expect((await layerState(page, id))['visibleLabelsList']).toBeNull();

    await page.getByTestId(`region-eye-${id}-2`).click();
    expect((await layerState(page, id))['visibleLabelsList']).toEqual(ids.filter((x) => x !== 2));
    await expect(page.getByTestId(`region-row-${id}-2`)).toHaveAttribute('data-visible', 'false');

    await page.getByTestId(`region-eye-${id}-2`).click();
    // Back to every id ⇒ §4.4's `undefined`, which is what lets the shader skip the membership test.
    expect((await layerState(page, id))['visibleLabelsList']).toBeNull();
  });

  test('Hide all, Invert and Show all are three patches over the same field', async () => {
    await page.getByTestId(`region-hideAll-${id}`).click();
    expect((await layerState(page, id))['visibleLabelsList']).toEqual([]);

    await page.getByTestId(`region-invert-${id}`).click();
    expect((await layerState(page, id))['visibleLabelsList']).toBeNull();

    await page.getByTestId(`region-eye-${id}-1`).click();
    await page.getByTestId(`region-invert-${id}`).click();
    expect((await layerState(page, id))['visibleLabelsList']).toEqual([1]);

    await page.getByTestId(`region-showAll-${id}`).click();
    expect((await layerState(page, id))['visibleLabelsList']).toBeNull();
  });

  test('Alt-click solos: exactly one id survives, and it is the selected row', async () => {
    await page.getByTestId(`region-name-${id}-3`).click({ modifiers: ['Alt'] });
    expect((await layerState(page, id))['visibleLabelsList']).toEqual([3]);
    await expect(page.getByTestId(`region-row-${id}-3`)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId(`region-row-${id}-1`)).toHaveAttribute('data-selected', 'false');
    await page.getByTestId(`region-showAll-${id}`).click();
  });

  test('a plain click selects one row; ⌘-click adds a second; ⇧-click takes the span', async () => {
    await page.getByTestId(`region-name-${id}-1`).click();
    await expect(page.getByTestId(`region-row-${id}-1`)).toHaveAttribute('data-selected', 'true');

    await page.getByTestId(`region-name-${id}-5`).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId(`region-row-${id}-1`)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId(`region-row-${id}-5`)).toHaveAttribute('data-selected', 'true');

    await page.getByTestId(`region-name-${id}-1`).click();
    await page.getByTestId(`region-name-${id}-4`).click({ modifiers: ['Shift'] });
    for (const labelId of [1, 2, 3, 4]) {
      await expect(page.getByTestId(`region-row-${id}-${labelId}`)).toHaveAttribute(
        'data-selected',
        'true'
      );
    }
    await expect(page.getByTestId(`region-row-${id}-5`)).toHaveAttribute('data-selected', 'false');
  });

  test('the per-region opacity slider writes `labelOpacity`, keyed by id', async () => {
    await page.getByTestId(`region-opacity-${id}-2`).fill('0.25');
    expect((await layerState(page, id))['labelOpacity']).toMatchObject({ 2: 0.25 });
  });

  test('a label volume’s swatch is read-only, and the panel says why rather than doing nothing', async () => {
    await expect(page.getByTestId(`region-row-${id}-1`)).toHaveAttribute(
      'data-recolorable',
      'false'
    );
    await expect(page.getByTestId(`region-color-${id}-1`)).toHaveCount(0);
    await expect(page.getByTestId(`region-swatch-${id}-1`)).toBeVisible();
  });

  test('an unnamed id gets a blank swatch, not a colour the pane will not paint', async () => {
    // The stand-in's LUT names 0, 1, 2, 3, 5 and 10; 4 and 6..9 have no `LabelEntry`, and §7.6 says
    // the *engine* paints those from its deterministic palette.
    await expect(page.getByTestId(`region-name-${id}-4`)).toHaveText('Label 4');
    expect(await page.getByTestId(`region-swatch-${id}-4`).getAttribute('style')).toBeNull();
  });

  test('double-click jumps the cursor to the centroid once labelCentroids has produced one', async () => {
    const before = await page.evaluate(() => window.__tetravox?.store.getState().cursor);

    // No centroid yet ⇒ nothing to jump to, and the panel must not invent one.
    await page.getByTestId(`region-name-${id}-2`).dblclick();
    expect(await page.evaluate(() => window.__tetravox?.store.getState().cursor)).toEqual(before);
    await expect(page.getByTestId(`region-tally-${id}-2`)).toHaveText('—');

    // Feed one the shape `OpResult['labelCentroids']` has (§6.5.2). When the facade grows a producer
    // this is the same path, driven by the engine instead of by the test.
    await page.evaluate((layerId) => {
      window.__tetravox?.controller?.setRegionStats(layerId, [
        { id: 2, centroid: [12.5, -7.25, 33], count: 1_340_029 },
      ]);
    }, id);
    await expect(page.getByTestId(`region-tally-${id}-2`)).toHaveText('1,340,029');

    await page.getByTestId(`region-name-${id}-2`).dblclick();
    expect(await page.evaluate(() => window.__tetravox?.store.getState().cursor)).toEqual([
      12.5, -7.25, 33,
    ]);
  });

  test('a click in a pane selects the row under the cursor (R5’s Freeview behaviour)', async () => {
    // The stand-in's `probe` derives a label id from the voxel, so moving the cursor moves the
    // selection — the panel reads `ProbeRow.labelId` and never resolves a voxel itself.
    const selected = await page.evaluate(async (layerId) => {
      const handle = window.__tetravox;
      const store = handle?.store;
      const engine = handle?.engine;
      if (store === undefined || engine === null || engine === undefined)
        throw new Error('no shell');
      // Walk world points until the probe reports a label other than the one already selected.
      const seen: number[] = [];
      for (let k = 0; k < 40; k += 1) {
        engine.setCursor([k * 3, k * 5, k * 7]);
        await new Promise((r) => setTimeout(r, 5));
        const state = store.getState();
        const row = state.cursorProbe?.rows.find((r) => r.layerId === layerId);
        const picked = state.regionSelection[layerId]?.ids ?? [];
        if (row?.labelId !== undefined) seen.push(row.labelId);
        if (picked.length === 1 && picked[0] === row?.labelId) return { ok: true, id: picked[0] };
      }
      return { ok: false, id: null, seen };
    }, id);

    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    await expect(page.getByTestId(`region-row-${id}-${selected.id}`)).toHaveAttribute(
      'data-selected',
      'true'
    );
  });
});
