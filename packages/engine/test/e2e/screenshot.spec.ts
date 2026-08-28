/**
 * P2-06 — `ScreenshotOptions`, asserted from inside the file `screenshot()` returns.
 *
 * §11's obligation for this feature is explicit: *"The screenshot's pHYs chunk carries the requested
 * DPI — parse the chunk, do not eyeball the image."* Every assertion below follows that rule. The
 * PNG is decoded in Node (`helpers/png.ts`) and the expectations are counts and sizes, never a
 * comparison against a stored picture: no golden is captured here, because a screenshot golden would
 * only re-photograph what `pointer.spec.ts` and `phase1-gate.spec.ts` already photograph, while
 * saying nothing about the crop, the DPI or the `include` flags — which are the feature.
 *
 * Tagged `@angle` so both Playwright projects run it: the crop arithmetic, the chunk and the
 * suppression flags are renderer-independent, and running them on the real GPU is free.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { countPixels, decodePng, pixelAt } from '../helpers/png';
import type { DecodedPng } from '../helpers/png';
import type { ScreenshotOptions } from '../../src/api';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

/**
 * `vol_f32.nii.gz` — 5×4×3 float32, 60 distinct values `[FIXTURE]`.
 *
 * Chosen over the 8³ `vol_asym.nii` the pointer gate uses because this spec asserts *content*: a
 * volume of two unique integral values is detected as a **label** volume (§6.1's `is_label`), and at
 * the fit cursor its axial plane is entirely label 0 — which draws nothing at all, so "the pane is
 * not the background colour" would be false for reasons that have nothing to do with screenshots.
 */
const FIXTURE = fixture('vol_f32.nii.gz');

/** The scene page's canvas, and therefore every pane rectangle below. */
const CANVAS = 768;
const HALF = CANVAS / 2;
/** The 2×2 layout's panes, canvas pixels, top-left origin. */
const PANES = {
  axial: { x: 0, y: 0, width: HALF, height: HALF },
  coronal: { x: HALF, y: 0, width: HALF, height: HALF },
} as const;

/**
 * `scene/defaults.ts`'s background, as the 8-bit values a PNG holds.
 *
 * `[0.04, 0.05, 0.07, 1]` × 255 = 10.2, 12.75, 17.85. The renderer writes an unsigned-normalised
 * value, so each channel is the *rounded* product; the ±1 tolerance below covers the two renderer
 * classes' rounding of the same float, not a guess about the colour.
 */
const SCENE_BG: [number, number, number] = [10, 13, 18];

/** The overlay's `CROSSHAIR_COLOR` (`[1, 0.85, 0.2, 0.9]`) — bright in R and G, dark in B. */
const isCrosshair = (r: number, g: number, b: number): boolean => r > 170 && g > 130 && b < 110;
/** The overlay's `TEXT_COLOR` (`[0.92, 0.94, 0.98, 1]`) — bright in all three, unlike the crosshair. */
const isText = (r: number, g: number, b: number): boolean => r > 150 && g > 150 && b > 150;

const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol;

async function openScene(page: Page): Promise<void> {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
}

async function load(page: Page, url: string, cells: string[]): Promise<void> {
  await page.evaluate(
    async ([u, ids]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: u as string });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({
        kind: (ids as string[]).length === 4 ? '2x2' : '1x1',
        cells: ids as string[],
      });
      await engine.whenSettled();
    },
    [url, cells] as const
  );
}

const INCLUDE_ALL: ScreenshotOptions['include'] = {
  colorbar: true,
  orientationLabels: true,
  crosshair: true,
  cornerInfo: true,
  scaleBar: true,
  orientationCube: true,
};
const INCLUDE_NONE: ScreenshotOptions['include'] = {
  colorbar: false,
  orientationLabels: false,
  crosshair: false,
  cornerInfo: false,
  scaleBar: false,
  orientationCube: false,
};

/** Take one screenshot through the frozen §4.7 entry point and decode it here, in Node. */
async function shoot(page: Page, opts: Partial<ScreenshotOptions>): Promise<DecodedPng> {
  const bytes = await page.evaluate(
    async (o) => {
      const engine = window.__tvxEngine!;
      const blob = await engine.screenshot({
        target: 'grid',
        background: 'scene',
        include: {
          colorbar: true,
          orientationLabels: true,
          crosshair: true,
          cornerInfo: true,
          scaleBar: true,
        },
        autoTrim: false,
        ...(o as Record<string, unknown>),
      } as Parameters<typeof engine.screenshot>[0]);
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    opts as Record<string, unknown>
  );
  return decodePng(Uint8Array.from(bytes));
}

// ===========================================================================================
// dpi -> the pHYs chunk (§11's named obligation for this feature)
// ===========================================================================================

test('@angle P2-06: the requested DPI is in the pHYs chunk, and absent when not asked for', async ({
  page,
}) => {
  await openScene(page);
  await load(page, FIXTURE, ['axial', 'coronal', 'sagittal', 'view3d']);

  const stamped = await shoot(page, { width: 192, dpi: 300 });
  expect([stamped.width, stamped.height]).toEqual([192, 192]);
  // 300 dpi = 300 / 0.0254 = 11811.02 px/m, stored as an integer, so it reads back as 299.9994.
  expect(stamped.dpi).not.toBeNull();
  expect(stamped.dpi!).toBeCloseTo(300, 2);

  const plain = await shoot(page, { width: 192 });
  expect(plain.dpi).toBeNull();
});

// ===========================================================================================
// width / height / scale — rendered at the size, not upscaled
// ===========================================================================================

test('@angle P2-06: width alone keeps the aspect ratio, and scale supersamples rather than enlarging', async ({
  page,
}) => {
  await openScene(page);
  await load(page, FIXTURE, ['axial', 'coronal', 'sagittal', 'view3d']);

  const wide = await shoot(page, { width: 256 });
  expect([wide.width, wide.height]).toEqual([256, 256]);

  // `scale` is a supersample factor: the output stays 256 px, drawn from a 512 px render.
  const ss = await shoot(page, { width: 256, scale: 2 });
  expect([ss.width, ss.height]).toEqual([256, 256]);

  // The canvas is restored: the next screenshot is native size again.
  const native = await shoot(page, {});
  expect([native.width, native.height]).toEqual([CANVAS, CANVAS]);
});

test('@angle P2-06: target:"view" is the pane, cropped out of the same frame the grid shot holds', async ({
  page,
}) => {
  await openScene(page);
  await load(page, FIXTURE, ['axial', 'coronal', 'sagittal', 'view3d']);

  const grid = await shoot(page, {});
  const pane = await shoot(page, { target: 'view', viewId: 'coronal' });
  expect([pane.width, pane.height]).toEqual([HALF, HALF]);

  // Every pixel of the pane shot is the corresponding pixel of the grid shot. Both are full-quality
  // renders of the same scene under `deterministic: true`, so this is an equality, not a similarity.
  let same = 0;
  for (let y = 0; y < HALF; y += 4) {
    for (let x = 0; x < HALF; x += 4) {
      const a = pixelAt(pane, x, y);
      const b = pixelAt(grid, PANES.coronal.x + x, PANES.coronal.y + y);
      if (a.every((v, i) => near(v, b[i] ?? 0, 1))) same += 1;
    }
  }
  const sampled = Math.ceil(HALF / 4) ** 2;
  expect(same / sampled).toBeGreaterThan(0.999);
});

test('@angle P2-06: target:"view" at a size renders the whole canvas bigger so the pane is that size', async ({
  page,
}) => {
  await openScene(page);
  await load(page, FIXTURE, ['axial', 'coronal', 'sagittal', 'view3d']);

  const png = await shoot(page, { target: 'view', viewId: 'axial', width: 512 });
  expect([png.width, png.height]).toEqual([512, 512]);
  // A 384 px pane upscaled to 512 would have blurred the 1 px crosshair into a 2 px smear at best;
  // a real 512 px render keeps it thin. The crosshair is 2 full-length rules of `max(1, uiScale)` px,
  // so an exact render has ~2 * 512 crosshair pixels and an upscale has ~4/3 of that.
  const arms = countPixels(png, isCrosshair);
  expect(arms).toBeGreaterThan(512);
  expect(arms).toBeLessThan(512 * 3);
});

// ===========================================================================================
// include — the flags must actually toggle what is drawn
// ===========================================================================================

test('@angle P2-06: every include flag suppresses its chrome item, and the badge survives all of them', async ({
  page,
}) => {
  await openScene(page);
  await load(page, FIXTURE, ['axial']);

  const all = await shoot(page, { width: CANVAS, include: INCLUDE_ALL });
  const none = await shoot(page, { width: CANVAS, include: INCLUDE_NONE });

  // crosshair: present, then gone entirely.
  expect(countPixels(all, isCrosshair)).toBeGreaterThan(500);
  expect(countPixels(none, isCrosshair)).toBe(0);

  // orientationLabels + cornerInfo: the letters and the corner block are ink, and they go.
  const textAll = countPixels(all, isText);
  const textNone = countPixels(none, isText);
  expect(textAll).toBeGreaterThan(textNone + 100);

  // §8: `Annotations.conventionBadge` is `true`, not optional — `include` has no flag for it and a
  // screenshot may never drop it. The badge is the top-right 3 glyphs.
  const badge = { x: CANVAS - 40, y: 0, width: 40, height: 20 };
  expect(countPixels(none, isText, badge)).toBeGreaterThan(10);

  // Only the crosshair reaches the middle of the pane, so its removal cannot have taken the anatomy
  // with it: the centre is still not the background colour.
  const mid = pixelAt(none, CANVAS / 2 + 8, CANVAS / 2 + 8);
  expect(mid.slice(0, 3).some((v, i) => !near(v, SCENE_BG[i] ?? 0))).toBe(true);
});

// ===========================================================================================
// background
// ===========================================================================================

test('@angle P2-06: background scene / white / transparent each reach the corner pixel', async ({
  page,
}) => {
  await openScene(page);
  await load(page, FIXTURE, ['axial']);

  // Native size, so the pane is the one the fit zoom was computed for and the 5x4x3 mm fixture
  // leaves a real border. (Asking for a small `width` shrinks the pane without changing `mmPerPx`,
  // which fills it with anatomy and leaves no background pixel to assert.)
  const scene = await shoot(page, { include: INCLUDE_NONE, background: 'scene' });
  const corner = pixelAt(scene, 1, 1);
  expect(corner[3]).toBe(255);
  expect(SCENE_BG.every((v, i) => near(corner[i] ?? 0, v))).toBe(true);

  const white = await shoot(page, { include: INCLUDE_NONE, background: 'white' });
  expect(pixelAt(white, 1, 1)).toEqual([255, 255, 255, 255]);

  // The two-render matte: nothing was drawn at the corner, so its coverage is zero.
  const clear = await shoot(page, { include: INCLUDE_NONE, background: 'transparent' });
  expect(pixelAt(clear, 1, 1)).toEqual([0, 0, 0, 0]);
  // ... and the anatomy is still fully opaque, which is what distinguishes a matte from a key-out.
  expect(pixelAt(clear, CANVAS / 2 + 6, CANVAS / 2 + 6)[3]).toBe(255);
});

// ===========================================================================================
// autoTrim
// ===========================================================================================

test('@angle P2-06: autoTrim removes the uniform border and leaves content on every edge', async ({
  page,
}) => {
  await openScene(page);
  await load(page, FIXTURE, ['axial', 'coronal', 'sagittal', 'view3d']);

  const full = await shoot(page, { target: 'view', viewId: 'axial', include: INCLUDE_NONE });
  expect([full.width, full.height]).toEqual([HALF, HALF]);
  // The 8 mm fixture at the fit zoom does not reach the pane edges, so the border is background.
  const bg = pixelAt(full, 0, 0);
  expect(SCENE_BG.every((v, i) => near(bg[i] ?? 0, v))).toBe(true);

  const trimmed = await shoot(page, {
    target: 'view',
    viewId: 'axial',
    include: INCLUDE_NONE,
    autoTrim: true,
  });
  expect(trimmed.width).toBeLessThan(full.width);
  expect(trimmed.height).toBeLessThan(full.height);
  expect(trimmed.width).toBeGreaterThan(8);
  // The invariant of a bounding box, which is what the trim computes: **every** edge of the result
  // carries at least one non-background pixel, or it could have been trimmed further. Asserting the
  // corner pixel instead would be wrong — a bounding box's corner is background whenever the content
  // is not a rectangle, which is the normal case for anatomy.
  const notBg = (r: number, g: number, b: number): boolean =>
    !SCENE_BG.every((v, i) => near([r, g, b][i] ?? 0, v));
  const edges: { x: number; y: number; width: number; height: number }[] = [
    { x: 0, y: 0, width: trimmed.width, height: 1 },
    { x: 0, y: trimmed.height - 1, width: trimmed.width, height: 1 },
    { x: 0, y: 0, width: 1, height: trimmed.height },
    { x: trimmed.width - 1, y: 0, width: 1, height: trimmed.height },
  ];
  for (const edge of edges) {
    expect(countPixels(trimmed, notBg, edge), JSON.stringify(edge)).toBeGreaterThan(0);
  }

  // With every dataset gone and every `include` flag off, the only thing left in the pane is the
  // RAD/NEU badge — §8's "not optional" made visible: the trim collapses to three 5x7 glyphs with a
  // 1 px halo, ~20x9 px, and not to nothing.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    for (const ds of [...engine.scene.datasets.values()]) engine.removeDataset(ds.id);
    await engine.whenSettled();
  });
  const empty = await shoot(page, {
    target: 'view',
    viewId: 'axial',
    include: INCLUDE_NONE,
    autoTrim: true,
    background: 'transparent',
  });
  expect(empty.width).toBeGreaterThan(4);
  expect(empty.width).toBeLessThan(40);
  expect(empty.height).toBeGreaterThan(4);
  expect(empty.height).toBeLessThan(20);
});
