/**
 * The R5 Region panel on **real data**, against the real WebGL2 engine.
 *
 * `m2m_ernie/segmentation/labeling.nii.gz` is the file the ownership map names for this owner, and
 * AGENTS.md says why: it is a **float32 label volume with 57 integral unique values**, so an
 * `is_label` heuristic that requires an integer dtype misclassifies the very atlas the app exists to
 * browse. Its `labeling_LUT.txt` sidecar is auto-associated by `open/sources.ts` (§7.6), which is
 * what puts names and colours on the rows.
 *
 * The pixel half is R5's gate — "hiding a label removes its colour from the pane pixels while others
 * are unchanged" — and it is asserted here the only way §11 rule 0 allows: the pane is decoded, the
 * label's own LUT colour is looked up, and the pixels carrying it are counted before and after. No
 * screenshot is *looked at*.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS.md).
 */

/* eslint-disable no-empty-pattern */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';
import type { DecodedPng } from './png';

const TESTDATA = process.env['TETRAVOX_TESTDATA'];
const LABELING =
  TESTDATA === undefined ? null : join(TESTDATA, 'm2m_ernie', 'segmentation', 'labeling.nii.gz');

/** AGENTS.md `[DATA]`, measured by `scripts/refvalues/nifti_refvalues.py`. */
const EXPECTED_DIMS = [256, 256, 208];
const EXPECTED_UNIQUE_LABELS = 57;

let app: ElectronApplication;
let page: Page;
let userDataDir: string | null = null;
let layerId: string;

/** As in `props-volume.spec.ts`: the single-instance lock is scoped to the user data directory. */
async function boot(target: LaunchTarget): Promise<void> {
  userDataDir = mkdtempSync(join(tmpdir(), 'tvx-props-real-'));
  app = await launchApp(target, {
    // No `engine=` — `ENGINE_IMPL` is `'real'`, and the point of this spec is the real slice shader.
    args: [`--user-data-dir=${userDataDir}`, LABELING as string],
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
    undefined,
    { timeout: 120_000 }
  );
  layerId = await page.evaluate(() => {
    const layer = window.__tetravox?.store.getState().layers[0];
    if (layer === undefined) throw new Error('no layer');
    return layer.id;
  });
}

interface LabelFacts {
  dims: number[];
  dtype: string;
  isLabel: boolean;
  labelIds: number[];
  /** id → the LUT's 0..255 RGBA, for every id the sidecar names. */
  colors: Record<number, [number, number, number, number]>;
}

async function labelFacts(): Promise<LabelFacts> {
  return page.evaluate((id) => {
    const state = window.__tetravox?.store.getState();
    const layer = state?.layers.find((l) => l.id === id);
    const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
    if (ds === undefined || ds.kind !== 'volume') throw new Error('no volume dataset');
    const colors: Record<number, [number, number, number, number]> = {};
    for (const entry of ds.labelTable?.entries ?? []) {
      // §4.1: colours are 0..1 floats in the scene and `[u8;4]` on the wire. `expectPixel` asserts
      // bytes, so the expected value for a label-coloured pixel is the byte form.
      colors[entry.id] = entry.color.map((c) => Math.round(c * 255)) as [
        number,
        number,
        number,
        number,
      ];
    }
    return {
      dims: [...ds.dims],
      dtype: ds.dtype,
      isLabel: ds.isLabel,
      labelIds: ds.labelIds === undefined ? [] : [...ds.labelIds],
      colors,
    };
  }, layerId);
}

/** The axial pane, decoded. Chrome is excluded so nothing but the slice can carry a label colour. */
async function axialPane(): Promise<DecodedPng> {
  const base64 = await page.evaluate(async () => {
    const engine = window.__tetravox?.engine;
    if (engine === null || engine === undefined) throw new Error('no engine');
    const axial = engine.views.find((v) => 'mode' in v && v.mode === 'axial');
    if (axial === undefined) throw new Error('no axial view');
    await engine.whenSettled();
    const blob = await engine.screenshot({
      target: 'view',
      viewId: axial.id,
      background: 'scene',
      include: {
        colorbar: false,
        orientationLabels: false,
        crosshair: false,
        cornerInfo: false,
        scaleBar: false,
      },
      autoTrim: false,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  });
  return decodePng(Buffer.from(base64, 'base64'));
}

/** How many pixels of `png` carry exactly `rgb` (alpha ignored: the pane composites onto the scene). */
function countColor(png: DecodedPng, rgb: readonly [number, number, number]): number {
  let n = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (png.pixels[i] === rgb[0] && png.pixels[i + 1] === rgb[1] && png.pixels[i + 2] === rgb[2]) {
      n += 1;
    }
  }
  return n;
}

// ------------------------------------------------------------------------------------------------

test.describe('the Region panel on labeling.nii.gz', () => {
  test.skip(
    LABELING === null,
    'TETRAVOX_TESTDATA is unset — real-data tests skip, never fail (AGENTS.md)'
  );

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    await boot(target);
  });

  test.afterAll(async () => {
    await app?.close();
    if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a float32 volume with 57 integral values is a LABEL volume, and the panel browses it', async () => {
    const facts = await labelFacts();
    expect(facts.dims).toEqual(EXPECTED_DIMS);
    // AGENTS.md: "an `is_label` heuristic that requires an integer dtype misclassifies the atlas the
    // app is meant to browse". The dtype is the trap; `isLabel` is the thing that must survive it.
    expect(facts.dtype).toBe('f32');
    expect(facts.isLabel).toBe(true);
    expect(facts.labelIds).toHaveLength(EXPECTED_UNIQUE_LABELS);

    await expect(page.getByTestId(`region-panel-${layerId}`)).toHaveAttribute(
      'data-kind',
      'labelVolume'
    );
    await expect(page.getByTestId(`region-list-${layerId}`)).toHaveAttribute(
      'data-rows',
      String(EXPECTED_UNIQUE_LABELS)
    );
  });

  test('every row carries the id §6.1 found, and the LUT sidecar named most of them', async () => {
    const facts = await labelFacts();
    for (const id of facts.labelIds) {
      await expect(page.getByTestId(`region-id-${layerId}-${id}`)).toHaveText(String(id));
    }
    // `labeling_LUT.txt` is the only source of a name here; a panel showing 57 "Label n" rows would
    // mean the sidecar never reached the loader (§7.6's auto-association).
    const named = Object.keys(facts.colors).length;
    expect(named, 'ids named by labeling_LUT.txt').toBeGreaterThan(EXPECTED_UNIQUE_LABELS / 2);
  });

  test('search-as-you-type narrows 57 rows to the one whose id was typed', async () => {
    const facts = await labelFacts();
    const id = facts.labelIds.at(-1) as number;
    await page.getByTestId(`region-search-${layerId}`).fill(String(id));
    await expect(page.getByTestId(`region-row-${layerId}-${id}`)).toBeVisible();
    await expect(page.getByTestId(`region-list-${layerId}`)).toHaveAttribute('data-rows', '1');
    await page.getByTestId(`region-search-${layerId}`).fill('');
  });

  test('hiding a label removes exactly its colour from the pane (R5’s gate)', async () => {
    const facts = await labelFacts();
    const before = await axialPane();
    expect(before.width, 'the axial pane has pixels').toBeGreaterThan(0);

    // Which labels are actually on screen at the default cursor, and how much of each. Derived from
    // the pane and the LUT — never from a remembered id, so a different slice cannot silently make
    // this test assert nothing.
    const present = facts.labelIds
      .filter((id) => id !== 0 && facts.colors[id] !== undefined)
      .map((id) => {
        const rgba = facts.colors[id] as [number, number, number, number];
        return {
          id,
          rgb: [rgba[0], rgba[1], rgba[2]] as const,
          n: countColor(before, [rgba[0], rgba[1], rgba[2]]),
        };
      })
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);

    expect(
      present.length,
      'at least two LUT colours are visible in the axial pane, so “others unchanged” means something'
    ).toBeGreaterThanOrEqual(2);

    const target = present[0] as (typeof present)[number];
    const other = present[1] as (typeof present)[number];

    // The panel's swatch and the pane agree on the colour. This is what makes the count below an
    // assertion about *this row* rather than about some colour that happens to be on screen.
    // Chromium normalises an inline `#rrggbb` to `rgb(r, g, b)`, which is the same bytes the pane
    // was counted for — §4.1's "the wire `[u8;4]` is what an expected pixel is written in".
    const swatch = await page.getByTestId(`region-color-${layerId}-${target.id}`).inputValue();
    const hex = (c: number): string => c.toString(16).padStart(2, '0');
    expect(swatch).toBe(`#${hex(target.rgb[0])}${hex(target.rgb[1])}${hex(target.rgb[2])}`);

    await page.getByTestId(`region-eye-${layerId}-${target.id}`).click();
    const hidden = await page.evaluate((id) => {
      const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
      const visible = layer !== undefined && 'visibleLabels' in layer ? layer.visibleLabels : null;
      return visible == null ? null : [...visible];
    }, layerId);
    expect(hidden, 'the eye writes §4.4’s `visibleLabels`').not.toBeNull();
    expect(hidden).not.toContain(target.id);
    expect(hidden).toContain(other.id);

    const after = await axialPane();

    // R5's gate, both halves at once: the hidden label's colour is gone from the pane, and every
    // other label's pixel count is exactly what it was.
    expect(countColor(after, target.rgb), 'the hidden label’s colour is gone').toBe(0);
    expect(countColor(after, other.rgb), 'every other label is untouched').toBe(other.n);

    // Put it back, so the recolour test below starts from the same pane.
    await page.getByTestId(`region-eye-${layerId}-${target.id}`).click();
    const restored = await axialPane();
    expect(
      Buffer.from(restored.pixels).equals(Buffer.from(before.pixels)),
      'showing it again restores the pane byte for byte'
    ).toBe(true);
  });

  test('recolouring a label repaints exactly its pixels, and only those (R5’s gate)', async () => {
    const facts = await labelFacts();
    const before = await axialPane();
    const present = facts.labelIds
      .map((id) => ({ id, rgb: facts.colors[id] }))
      .filter(
        (r): r is { id: number; rgb: [number, number, number, number] } => r.rgb !== undefined
      )
      .map((r) => ({ ...r, n: countColor(before, [r.rgb[0], r.rgb[1], r.rgb[2]]) }))
      .filter((r) => r.n > 20)
      .sort((a, b) => b.n - a.n);
    expect(present.length).toBeGreaterThanOrEqual(2);
    const target = present[0] as (typeof present)[number];
    const other = present[1] as (typeof present)[number];

    // A colour no LUT entry uses, so the count after is unambiguous. `k / 255` round-trips exactly
    // (§4.1), which is what lets this be an equality rather than a tolerance.
    const NEW: [number, number, number] = [1, 254, 3];
    expect(
      facts.labelIds.some((id) => {
        const c = facts.colors[id];
        return c !== undefined && c[0] === NEW[0] && c[1] === NEW[1] && c[2] === NEW[2];
      }),
      'the new colour must not already be some other label’s'
    ).toBe(false);
    expect(countColor(before, NEW), 'nothing is that colour before the edit').toBe(0);

    await page.evaluate(
      ([id, tag]: [string, number]) => {
        const el = document.querySelector(`[data-testid="region-color-${id}-${tag}"]`);
        if (el === null) throw new Error('no colour input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, '#01fe03');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      [layerId, target.id] as [string, number]
    );

    // The edit lands on the **layer** (§4.4's `VolumeLayer.labelColors`), which is what §4.6
    // serialises — the dataset's `labelTable` still holds the file's own colour.
    const stored = await page.evaluate(
      ([id, tag]: [string, number]) => {
        const state = window.__tetravox?.store.getState();
        const layer = state?.layers.find((l) => l.id === id);
        const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
        if (layer?.kind !== 'volume' || ds?.kind !== 'volume') throw new Error('no volume');
        return {
          override: layer.labelColors?.[tag] ?? null,
          file: ds.labelTable?.byId.get(tag)?.color ?? null,
        };
      },
      [layerId, target.id] as [string, number]
    );
    expect(stored.override?.map((c) => Math.round(c * 255))).toEqual([...NEW, 255]);
    expect(stored.file?.map((c) => Math.round(c * 255))).toEqual([...target.rgb]);

    const after = await axialPane();
    expect(countColor(after, NEW), 'exactly the recoloured label’s pixels are the new colour').toBe(
      target.n
    );
    expect(countColor(after, [target.rgb[0], target.rgb[1], target.rgb[2]])).toBe(0);
    expect(countColor(after, [other.rgb[0], other.rgb[1], other.rgb[2]])).toBe(other.n);
  });
});
