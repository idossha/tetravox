/**
 * The §11 proof that the harness works: one raw-WebGL2 triangle, three pixels asserted analytically,
 * and one golden.
 *
 * Nothing here is transcribed from a run. The clear colour, the fill colour and the clip-space vertices
 * come from `pages/triangle-scene`, which the page bundle draws from; the expected colour of a pixel is
 * derived from the same half-plane test, and the assertion is a `readPixels` readback, not a decoded
 * screenshot.
 *
 * When Phase 1 replaces this with `engine.readPixel(viewId, x, y)` (§4.7), the shape of the test does
 * not change — only where the pixels come from.
 */

import { expect, test } from '@playwright/test';
import { expectGolden, expectPixel, readCanvasPixels } from '../helpers/pixels';
import { CANVAS_SIZE, CLEAR_RGBA, TRIANGLE_RGBA, insideTriangle } from '../pages/triangle-scene';

/**
 * The three asserted pixels. Each sits far from the nearest triangle edge, so no rasteriser tie-break
 * rule and no comparison threshold can reach it.
 */
const PIXELS: readonly { x: number; y: number; label: string }[] = [
  { x: 128, y: 159, label: 'interior, ~47 px inside the nearest edge' },
  { x: 20, y: 235, label: 'below the base' },
  { x: 230, y: 25, label: 'above the apex' },
];

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/triangle.html');
  await page.waitForFunction(() => window.__tvxRender !== undefined);
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the asserted pixels are the ones the geometry says they are', () => {
  // Guards the guard: if someone moves the triangle, this fails before the pixel assertions do, and
  // says so in geometry terms instead of as an unexplained colour mismatch.
  expect(PIXELS.map((p) => insideTriangle(p.x, p.y))).toEqual([true, false, false]);
});

test('analytic pixels: clear colour outside, fill colour inside (§11 (1))', async ({ page }) => {
  for (const { x, y, label } of PIXELS) {
    const expected = insideTriangle(x, y) ? TRIANGLE_RGBA : CLEAR_RGBA;
    await test.step(`(${x}, ${y}) — ${label}`, async () => {
      // tol = 1 is §11's default. Both colours are exact 8-bit values and there is no antialiasing, so
      // the tolerance actually needed is 0; 1 absorbs nothing but a driver rounding its own clear.
      await expectPixel(page, x, y, expected, 1);
    });
  }
});

test('no blended pixel exists on a scanline through the triangle (aa: off)', async ({ page }) => {
  // §11 / §7.0 item 8: goldens run with aa 'off' so the image is deterministic. That is only true if
  // the rasteriser produces exactly two colours. Sampling a whole scanline is the cheapest proof.
  const y = 159;
  const row = await readCanvasPixels(
    page,
    Array.from({ length: CANVAS_SIZE }, (_, x) => [x, y] as const)
  );
  const key = (px: readonly number[]): string => px.join(',');
  expect(
    [...new Set(row.map(key))].sort(),
    'an antialiased edge would introduce a third colour on this scanline'
  ).toEqual([key(CLEAR_RGBA), key(TRIANGLE_RGBA)].sort());

  // And the run of fill pixels is where the half-plane test says it is, ±1 px for the fill rule.
  const expectedRun = Array.from({ length: CANVAS_SIZE }, (_, x) => insideTriangle(x, y)).filter(
    Boolean
  ).length;
  const actualRun = row.filter((px) => key(px) === key(TRIANGLE_RGBA)).length;
  expect(Math.abs(actualRun - expectedRun)).toBeLessThanOrEqual(1);
});

test('golden (§11 (2))', async ({ page }) => {
  await expectGolden(page, 'triangle');
});
