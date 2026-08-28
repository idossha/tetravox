/**
 * §7.4's `tagStyle` — per-tag visible / opacity / colour, the thing §8's tissue table is backed by.
 *
 * §11's second named example is *"a 4-tet mesh with tag colours from a fixture LUT ⇒ the cap pixel is
 * exactly the tag colour — the **0..255 wire value** from `MeshMeta.tags[].color`, which §4.1
 * requires to round-trip exactly"*. Phase 1 asserted that for the **dataset's** colours; R5 adds the
 * half that matters for a region panel: an *edited* colour must reach the pixel with the same
 * exactness, and hiding a tag must remove exactly its pixels.
 *
 * The shading is solved out rather than modelled — see `mesh-support.ts`'s `fitShading`. Nothing in
 * any expectation below comes from the shader's ambient or specular constants, or from a previous
 * run.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readCanvasPixels } from '../helpers/pixels';
import {
  BACK_FACE_CAMERA,
  FACE_HALF_MM,
  FRONT_FACE_CAMERA,
  fitShading,
  isBackground,
  isPlausibleShading,
  PANE,
} from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

/** ±9 mm on the front face, in pane pixels: the tag-1002 (z > 0) and tag-1001 (z < 0) halves. */
const DZ = Math.round((9 / FACE_HALF_MM) * (PANE / 2));
const TOP: readonly [number, number] = [PANE / 2, PANE / 2 - DZ];
const BOTTOM: readonly [number, number] = [PANE / 2, PANE / 2 + DZ];

/** An exact 0..255 triple, so §4.1's round trip is asserted on values that cannot be rounded. */
const MAGENTA255 = [204, 51, 153, 255] as const;

async function openFixture(page: Page): Promise<{ id: number; rgba: number[] }[]> {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return page.evaluate(
    async ([url, lutUrl, camera]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        // The LUT only: the fixture's `.msh.opt` hides tag 1001, and this spec is about `tagStyle`.
        sidecars: { lut: lutUrl as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      window.__tvxLayerId = layer.id;
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.setView('view3d', { camera: camera as never });
      await engine.whenSettled();
      return 'tags' in ds
        ? ds.tags.map((t) => ({
            id: t.id,
            rgba: t.color.map((c) => Math.round(c * 255)),
          }))
        : [];
    },
    [fixture('mesh_v2_binary.msh'), fixture('mesh_v2_binary_LUT.txt'), FRONT_FACE_CAMERA] as const
  );
}

declare global {
  interface Window {
    __tvxLayerId?: string;
  }
}

test('tagStyle.color reaches the pixel as the exact 0..255 value it was set to (§4.1, R5)', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const tags = await openFixture(page);
  expect(pageErrors).toEqual([]);

  const lut1002 = tags.find((t) => t.id === 1002)?.rgba ?? [];
  const lut1001 = tags.find((t) => t.id === 1001)?.rgba ?? [];
  expect(lut1002).toEqual([255, 239, 179, 255]);
  expect(lut1001).toEqual([104, 163, 255, 255]);

  // Before: the upper half of the front face is tag 1002 in its LUT colour.
  const [before] = await readCanvasPixels(page, [TOP]);
  const base = fitShading(lut1002, before!);
  expect(base.residual, 'the un-styled pixel is the dataset tag colour').toBeLessThan(1.5);
  expect(isPlausibleShading(base)).toBe(true);

  // R5's recolour: one `updateLayer` call, one 0..255 triple, and nothing else changes.
  await page.evaluate((rgb) => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(window.__tvxLayerId!, {
      tagStyle: {
        1001: { visible: true, opacity: 1 },
        1002: {
          visible: true,
          opacity: 1,
          color: [rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, rgb[3]! / 255],
        },
      },
    } as never);
  }, MAGENTA255);

  const [after, other] = await readCanvasPixels(page, [TOP, BOTTOM]);
  const fitNew = fitShading(MAGENTA255, after!);
  const fitOld = fitShading(lut1002, after!);
  console.log(
    `[tagstyle] recoloured rgb(${after!.slice(0, 3).join(',')}) fits ${MAGENTA255.slice(0, 3).join(',')} ` +
      `at residual ${fitNew.residual.toFixed(2)}; the old colour fits at ${fitOld.residual.toFixed(2)}`
  );
  expect(
    fitNew.residual,
    'the recoloured pixel is exactly the new tag colour, scaled'
  ).toBeLessThan(1.5);
  expect(isPlausibleShading(fitNew)).toBe(true);
  // The two colours run in opposite directions in red and blue (255→204 against 179→153 is a *third*
  // of the change in green), so the old one cannot be fitted to the new pixel.
  expect(fitOld.s < 0.05 || fitOld.residual > 3).toBe(true);

  // "others are unchanged" (R5's gate): the tag-1001 half still fits its own LUT colour.
  const fitOther = fitShading(lut1001, other!);
  expect(fitOther.residual, 'the other tag is untouched by the recolour').toBeLessThan(1.5);
});

test('tagStyle.visible removes exactly that tag’s pixels, and opacity 0 is the same (R5)', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const tags = await openFixture(page);
  expect(pageErrors).toEqual([]);
  const lut1001 = tags.find((t) => t.id === 1001)?.rgba ?? [];

  const setStyle = async (style: unknown): Promise<void> => {
    await page.evaluate((s) => {
      window.__tvxEngine!.updateLayer(window.__tvxLayerId!, { tagStyle: s } as never);
    }, style);
  };

  // Hide tag 1002. Its exterior faces are the whole z > 0 half of the cube — the near sheet at TOP
  // *and* the far one behind it — so nothing is left along that ray and the pane shows through.
  await setStyle({ 1001: { visible: true, opacity: 1 }, 1002: { visible: false, opacity: 1 } });
  const [hiddenTop, keptBottom] = await readCanvasPixels(page, [TOP, BOTTOM]);
  expect(isBackground(hiddenTop!), `hiding 1002 leaves rgb(${hiddenTop!.join(',')})`).toBe(true);
  expect(
    fitShading(lut1001, keptBottom!).residual,
    'hiding one tag leaves the other byte-identical in colour'
  ).toBeLessThan(1.5);

  // Opacity 0 is the same skipped sub-draw, by a different route (§7.2's `alpha <= 0`).
  await setStyle({ 1001: { visible: true, opacity: 1 }, 1002: { visible: true, opacity: 0 } });
  const [zeroTop] = await readCanvasPixels(page, [TOP]);
  expect(isBackground(zeroTop!)).toBe(true);

  // And solo — R5's Alt-click — is "hide every other row": only 1002 survives.
  await setStyle({ 1001: { visible: false, opacity: 1 }, 1002: { visible: true, opacity: 1 } });
  const [soloTop, soloBottom] = await readCanvasPixels(page, [TOP, BOTTOM]);
  expect(isBackground(soloBottom!), 'solo hides the other tag').toBe(true);
  expect(
    fitShading(tags.find((t) => t.id === 1002)!.rgba, soloTop!).residual,
    'solo leaves the chosen tag exactly as it was'
  ).toBeLessThan(1.5);
});

test('per-tag opacity is a real blend, not a skipped draw', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await openFixture(page);
  expect(pageErrors).toEqual([]);

  const [opaque] = await readCanvasPixels(page, [TOP]);
  await page.evaluate(() => {
    window.__tvxEngine!.updateLayer(window.__tvxLayerId!, {
      tagStyle: { 1001: { visible: true, opacity: 1 }, 1002: { visible: true, opacity: 0.5 } },
    } as never);
  });
  const [blended] = await readCanvasPixels(page, [TOP]);

  // The pane's two sheets of tag 1002 both blend, so the composite is not a single mix — but it is
  // strictly between the background and the opaque colour in every channel, which a skipped draw
  // (background) and an ignored opacity (unchanged) both fail.
  for (let c = 0; c < 3; c += 1) {
    const bg = [10, 13, 18][c]!;
    const lo = Math.min(bg, opaque![c]!);
    const hi = Math.max(bg, opaque![c]!);
    expect(blended![c]!, `channel ${c} of rgb(${blended!.slice(0, 3).join(',')})`).toBeGreaterThan(
      lo + 1
    );
    expect(blended![c]!).toBeLessThan(hi - 1);
  }
});

test('the pane really is the front face: the back camera sees the same cube from +X', async ({
  page,
}) => {
  // The geometry `mesh-support.ts` inverts is worth pinning on its own, because every other
  // expectation in these specs is computed from it.
  await openFixture(page);
  const [front] = await readCanvasPixels(page, [TOP]);
  await page.evaluate((camera) => {
    window.__tvxEngine!.setView('view3d', { camera: camera as never });
  }, BACK_FACE_CAMERA);
  const [back] = await readCanvasPixels(page, [TOP]);
  // Both faces are tag 1002 at z = +9 and the same distance from the eye, so the two pixels agree.
  for (let c = 0; c < 3; c += 1) expect(Math.abs(front![c]! - back![c]!)).toBeLessThanOrEqual(2);
});
