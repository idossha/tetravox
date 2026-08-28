/**
 * §8's colour bars, as pixels — **required in every screenshot from Phase 2 on** (§11).
 *
 * The bar is drawn into the GL framebuffer with the rest of the chrome, so it can be asserted the
 * same way anything else in §11 is: compute where a texel of the ramp lands and what colour it must
 * be, then read that pixel back. Two independent claims are checked, and both are the kind a picture
 * cannot settle:
 *
 * * **The bar shows the LUT the slice samples.** With `colormap: 'gray'` and a linear scale the
 *   ramp's channel at bar position `p` is `round(255 · (i + 0.5) / 256)` for the texel
 *   `i = floor(((p + 0.5) / length) · 256)` a `NEAREST` fetch selects — one expression, derived
 *   here, with no table to transcribe.
 * * **One bar per visible scalar layer, stacked in layer order.** Slot 1 exists and is painted in
 *   its own colormap, and both slots are background again when `Annotations.colorbars` is off — so
 *   the pixels asserted above are the bar's and nothing else's.
 *
 * The geometry comes from `colorbarLayout` / `overlayMetrics`, imported rather than copied: a test
 * that re-types the layout asserts a transcription, and the thing under test here is the colour at a
 * position, not the position itself (`overlay/colorbar.test.ts` owns the layout, without a GL
 * context).
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import { colorbarLayout, overlayMetrics } from '../../src/overlay';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

/** Not a label volume, so it gets a bar; label volumes get §8's region panel instead. */
const VOL = 'vol_i16.nii.gz';
const PANE = 768;
const MM_PER_PX = 0.02;

const M = overlayMetrics(PANE, PANE, 1);
const BAR = colorbarLayout(M, 'right');
/** `drawColorbar`'s right-hand column, in pane pixels (bottom-left origin, as the builder works). */
const BAR_X = PANE - M.pad - 2 * 6 * M.scale - BAR.thickness; // 2 characters of gutter, CELL_W = 6
const BAR_TOP = PANE - M.pad - 7 * M.scale - M.lineH; // GLYPH_H = 7
const barY0 = (slot: number): number => BAR_TOP - slot * BAR.pitch - BAR.length;

/** Top-left-origin canvas pixel of bar `slot`'s ramp row `p`. */
function barPixel(slot: number, p: number): [number, number] {
  return [BAR_X + Math.floor(BAR.thickness / 2), PANE - 1 - (barY0(slot) + p)];
}

/** `gray` is a two-stop map, so the ramp position *is* the channel; the LUT is 256 texels. */
function grayAtRampPosition(p: number): number {
  const i = Math.min(255, Math.floor(((p + 0.5) / BAR.length) * 256));
  return Math.round((255 * (i + 0.5)) / 256);
}

async function openTwoScalarLayers(page: Page): Promise<void> {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([url, mmPerPx]) => {
      const engine = window.__tvxEngine!;
      const a = await engine.addDataset({ kind: 'path', path: url as string });
      const la = engine.addLayer({ datasetId: a.id, kind: 'volume' });
      const b = await engine.addDataset({ kind: 'path', path: url as string });
      const lb = engine.addLayer({ datasetId: b.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.updateLayer(la.id, { colormap: 'gray', name: 'BASE' });
      engine.updateLayer(lb.id, {
        colormap: 'viridis',
        name: 'OVERLAY',
        opacity: 0.5,
        threshold: { lo: -4000, hi: 4000, symmetric: false, mode: 'hide', softEdge: 0 },
      });
      await engine.whenSettled();
    },
    [fixture(VOL), MM_PER_PX] as const
  );
}

test('the colour bar paints the LUT the slice samples, one bar per visible scalar layer', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await openTwoScalarLayers(page);

  // Off first: whatever is at these pixels now is what the bar has to replace.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ colorbars: false });
    await engine.whenSettled();
  });
  const probes: [number, number][] = [
    barPixel(0, 0),
    barPixel(0, Math.floor(BAR.length / 2)),
    barPixel(0, BAR.length - 1),
    barPixel(1, Math.floor(BAR.length / 2)),
  ];
  const before = await readCanvasPixels(page, probes);

  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ colorbars: true });
    await engine.whenSettled();
  });
  const after = await readCanvasPixels(page, probes);

  expect(pageErrors).toEqual([]);

  // The three sampled rows of the `gray` bar are the LUT texels a NEAREST fetch selects there.
  const rows = [0, Math.floor(BAR.length / 2), BAR.length - 1];
  rows.forEach((p, k) => {
    const want = grayAtRampPosition(p);
    const got = after[k]!;
    for (let c = 0; c < 3; c += 1) {
      expect(
        Math.abs((got[c] ?? 0) - want),
        `bar row ${p}: channel ${c} expected ${want}, got ${got.join(',')}`
      ).toBeLessThanOrEqual(1);
    }
  });
  // A ramp, not a flat block.
  expect(after[0]![0]).toBeLessThan(after[2]![0]);

  // Slot 1 is the second layer's bar, in its own colormap — `viridis` is never grey.
  const second = after[3]!;
  expect(second[0] === second[1] && second[1] === second[2]).toBe(false);

  // …and every one of those pixels was something else with the bars off, so the assertions above
  // are about the bar and not about whatever happens to be behind it.
  probes.forEach((_, k) => {
    const a = before[k]!;
    const b = after[k]!;
    expect(a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]).toBe(true);
  });
});

/**
 * The `slice-colorbar` golden: two scalar layers, two bars, full §8 chrome.
 *
 * The lower bar is `gray` with no threshold; the upper is `viridis` with a `hide` threshold, so its
 * bar carries the two notches §8 asks for ("the threshold cut drawn as a notch") and the golden pins
 * the notch positions as well as the ramps.
 */
test('colour bar golden', async ({ page }) => {
  test.setTimeout(120_000);
  await openTwoScalarLayers(page);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ colorbars: true });
    await engine.whenSettled();
  });
  await expectGolden(page, 'slice-colorbar');
});
