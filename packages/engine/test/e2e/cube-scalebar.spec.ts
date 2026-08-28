/**
 * §11 for directed task 10 — the **orientation cube** and the **scale bar**, off the framebuffer.
 *
 * Rule 0: *an agent cannot judge a PNG; it can judge a number.* Three numbers are computed here from
 * first principles and none of them comes from the modules under test:
 *
 * * **The bar's drawn length.** A scale bar is a promise that `N mm` is *this* long on screen, so
 *   the assertion is the span of lit pixels in the bar's own scanline against `mm / mmPerPx` — the
 *   division, written out — at two different zooms, with the millimetres read off the 1-2-5 ladder by
 *   hand. Anything else (comparing to `snapScaleBar`'s own answer, or eyeballing the golden) would
 *   let a bar that is 10 % short pass.
 * * **The cube's letters.** Decoded from the pane's pixels with the same 5×7 template matcher §8's
 *   chrome uses (`helpers/chrome.ts`), at the position the cube's own geometry puts them — which the
 *   spec derives from the pane size and the camera quaternion, not from `cubeLayout`.
 * * **The camera a click produces.** Clicking the `A` face must give the *anterior* preset, and what
 *   "anterior" means is a direction, not a quaternion: the assertion is on the eye axis and the
 *   screen-up axis the resulting rotation yields, computed in this file from the quaternion.
 *
 * The click goes through `page.mouse.click`, so what is tested is the real pointer path — canvas
 * listener, pane resolution, `clickOrientationCube` ahead of the gizmo and the orbit — rather than a
 * method call the product does not make.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasRect } from '../helpers/pixels';
import { readChromeText } from '../helpers/chrome';
import { CELL_W, GLYPH_H } from '../../src/render/font';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const VOL = 'vol_i16.nii.gz';
/** `test/pages/scene.html`'s canvas, and — in a single-pane layout — the pane. */
const PANE = 768;

// -------------------------------------------------------------------------------------------
// The overlay's layout constants, transcribed rather than imported (§11 rule 1).
// -------------------------------------------------------------------------------------------

/** `overlayMetrics`: `pad = 4 * scale`, and `scale = max(1, round(dpr)) = 1` at DPR 1. */
const PAD = 4;
/** `cubeLayout`: `min(56, floor(min(w, h) / 3))`, halved. */
const CUBE_HALF = Math.min(56, Math.floor(PANE / 3)) / 2;
const CUBE_CX = PANE - PAD - CUBE_HALF;
const CUBE_CY = PAD + CUBE_HALF;
/** `k`: the projection scale that keeps the furthest corner of a unit cube inside the box. */
const CUBE_K = CUBE_HALF / Math.sqrt(3);
/** `drawOrientationCube`: `max(1, round(half / 12))`. */
const LETTER_SCALE = Math.max(1, Math.round(CUBE_HALF / 12));
/** `scaleBarLayout`: `capHeight = max(4, 5 * scale)` — the label sits `2 px` above it. */
const BAR_CAP_H = 5;

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** The camera's world axes from its rotation, by hand — `mat4.fromQuat`'s three columns. */
function basisOf(q: Quat): { right: Vec3; up: Vec3; back: Vec3 } {
  const [x, y, z, w] = q;
  return {
    right: [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    up: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    back: [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** A world direction's cube pixel, **top-left origin**, ready for `page.mouse`. */
function cubePixelOf(rotation: Quat, dir: Vec3): { x: number; y: number } {
  const b = basisOf(rotation);
  return {
    x: CUBE_CX + dot(dir, b.right) * CUBE_K,
    y: PANE - (CUBE_CY + dot(dir, b.up) * CUBE_K),
  };
}

const round3 = (v: Vec3): number[] => v.map((c) => Math.round(c * 1000) / 1000 + 0);

// -------------------------------------------------------------------------------------------
// Scene setup
// -------------------------------------------------------------------------------------------

async function openScene(page: Page): Promise<void> {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
}

/** One 2D pane over the fixture at a given zoom, with the scale bar on and nothing else. */
async function openSlice(page: Page, mmPerPx: number): Promise<{ errors: string[] }> {
  return await page.evaluate(
    async ([url, mm]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mm as number } });
      engine.setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
        scaleBar: true,
      });
      await engine.whenSettled();
      engine.renderNow();
      return { errors: window.__tvxErrors ?? [] };
    },
    [fixture(VOL), mmPerPx] as const
  );
}

/** The 3D pane over the same fixture, with the cube on. */
async function open3D(page: Page, rotation: Quat): Promise<{ rotation: Quat; errors: string[] }> {
  return await page.evaluate(
    async ([url, rot]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      engine.setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
        orientationCube: true,
      });
      const cam = engine.scene.view3d.camera;
      engine.setView('view3d', {
        camera: { ...cam, rotation: rot as [number, number, number, number] },
      });
      await engine.whenSettled();
      engine.renderNow();
      return {
        rotation: engine.scene.view3d.camera.rotation as [number, number, number, number],
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture(VOL), rotation] as const
  );
}

/** The span of lit pixels in one canvas scanline. */
async function litSpan(
  page: Page,
  y: number
): Promise<{ first: number; last: number; width: number }> {
  const row = await readCanvasRect(page, 0, y, PANE, 1);
  let first = -1;
  let last = -1;
  for (let x = 0; x < PANE; x += 1) {
    const o = x * 4;
    if ((row[o] ?? 0) > 150 && (row[o + 1] ?? 0) > 150 && (row[o + 2] ?? 0) > 150) {
      if (first < 0) first = x;
      last = x;
    }
  }
  return { first, last, width: last - first + 1 };
}

// -------------------------------------------------------------------------------------------
// The scale bar
// -------------------------------------------------------------------------------------------

/**
 * The two zooms, with the rung a reader would pick worked out by hand:
 *
 * * `0.1 mm/px` — 1 mm is 10 px, 2 is 20, 5 is 50, all under the 60 px floor; **10 mm is 100 px**.
 * * `0.04 mm/px` — 1 mm is 25 px, 2 is 50, both under the floor; **5 mm is 125 px**.
 */
const ZOOMS: { mmPerPx: number; mm: number; px: number }[] = [
  { mmPerPx: 0.1, mm: 10, px: 100 },
  { mmPerPx: 0.04, mm: 5, px: 125 },
];

for (const zoom of ZOOMS) {
  test(`@angle scale bar: ${zoom.mm} mm is ${zoom.px} px at ${zoom.mmPerPx} mm/px`, async ({
    page,
  }) => {
    await openScene(page);
    const { errors } = await openSlice(page, zoom.mmPerPx);
    expect(errors).toEqual([]);

    // The bar's own scanline: `y = pad` in pane pixels, bottom-left origin.
    const y = PANE - 1 - PAD;
    const span = await litSpan(page, y);
    expect(span.first, 'the bar has to be drawn at all').toBeGreaterThan(0);

    // The promise the annotation makes: the drawn length **is** `mm / mmPerPx`.
    expect(Math.abs(span.width - zoom.mm / zoom.mmPerPx)).toBeLessThanOrEqual(1);
    // ...and it sits one pad off the right edge, so it cannot be a stripe of anatomy.
    expect(Math.abs(span.last - (PANE - 1 - PAD))).toBeLessThanOrEqual(1);
  });
}

test('@angle scale bar: the label names the millimetres the bar is long', async ({ page }) => {
  await openScene(page);
  await openSlice(page, 0.1);
  // `10 MM` is centred over a 100 px bar whose right end is at `PANE - pad`, so its left edge is an
  // integer and the 5×7 template matcher can read it.
  const text = '10 MM';
  const centre = PANE - PAD - 100 / 2;
  const decoded = await readChromeText(page, {
    canvasHeight: PANE,
    pane: { x: 0, y: 0, width: PANE, height: PANE },
    xLocal: centre - (text.length * CELL_W) / 2,
    yLocal: PAD + BAR_CAP_H + 2,
    length: text.length,
  });
  expect(decoded).toBe(text);
});

test('scale bar golden', async ({ page }) => {
  await openScene(page);
  await openSlice(page, 0.1);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    // The rest of the chrome back on: §11 wants the bar pictured *with* its neighbours, so a future
    // change that puts the bar under the corner info fails here rather than in a bug report.
    engine.setAnnotations({ orientationLabels: true, cornerInfo: true });
    await engine.whenSettled();
  });
  await expectGolden(page, 'scene-scale-bar');
});

// -------------------------------------------------------------------------------------------
// The orientation cube
// -------------------------------------------------------------------------------------------

/**
 * A camera 50° off the superior preset about the world x axis: `q = (sin(−25°), 0, 0, cos(−25°))`.
 *
 * Deliberately **not** a preset. At a cardinal view exactly one face is visible and it is dead
 * centre, which would let a cube that ignores the camera entirely pass; tilted, the anterior face is
 * the frontmost and sits above the centre by `cos(25°) · k`, so both the letter's position and the
 * click target depend on the rotation.
 */
const TILT: Quat = [Math.sin((-25 * Math.PI) / 180), 0, 0, Math.cos((-25 * Math.PI) / 180)];

test('@angle orientation cube: it is drawn in the corner, and only when it is on', async ({
  page,
}) => {
  await openScene(page);
  const { errors } = await open3D(page, TILT);
  expect(errors).toEqual([]);

  const box = async (): Promise<number> => {
    const px = await readCanvasRect(
      page,
      CUBE_CX - CUBE_HALF,
      PANE - (CUBE_CY + CUBE_HALF),
      CUBE_HALF * 2,
      CUBE_HALF * 2
    );
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if ((px[i] ?? 0) > 40 || (px[i + 1] ?? 0) > 40 || (px[i + 2] ?? 0) > 40) lit += 1;
    }
    return lit;
  };

  // A cube of half-extent 1 projected at `k = half/√3` covers at least its own inscribed square.
  const on = await box();
  expect(on, 'the cube covers a real part of its box').toBeGreaterThan(CUBE_HALF * CUBE_HALF);

  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ orientationCube: false });
    await engine.whenSettled();
    engine.renderNow();
  });
  // Off is off: the 3D pane is empty in that corner, so nothing at all is lit there.
  expect(await box(), 'the annotation switch really removes it').toBe(0);
});

test('@angle orientation cube: the faces are labelled with the directions they point', async ({
  page,
}) => {
  await openScene(page);
  const { rotation } = await open3D(page, TILT);

  /** Decode the letter drawn at a face centre — `drawOrientationCube`'s placement, by hand. */
  const letterAt = async (dir: Vec3): Promise<string> => {
    const b = basisOf(rotation);
    const cx = CUBE_CX + dot(dir, b.right) * CUBE_K;
    const cy = CUBE_CY + dot(dir, b.up) * CUBE_K;
    return (
      await readChromeText(page, {
        canvasHeight: PANE,
        pane: { x: 0, y: 0, width: PANE, height: PANE },
        scale: LETTER_SCALE,
        // `b.text(..., 'center')`: the string's left edge is `cx - CELL_W * scale / 2`.
        xLocal: Math.round(cx - (CELL_W * LETTER_SCALE) / 2),
        yLocal: Math.round(cy - (GLYPH_H * LETTER_SCALE) / 2),
        length: 1,
      })
    ).trim();
  };

  // Tilted back 50° from superior, the anterior and superior faces are both visible; `P`, `I`, `L`
  // and `R` are behind or edge-on.
  expect(await letterAt([0, 1, 0])).toBe('A');
  expect(await letterAt([0, 0, 1])).toBe('S');
});

test('@angle orientation cube: clicking the A face gives the anterior preset camera', async ({
  page,
}) => {
  await openScene(page);
  const { rotation } = await open3D(page, TILT);

  // The anterior face's centre, in canvas pixels, from the camera's own quaternion.
  const target = cubePixelOf(rotation, [0, 1, 0]);
  await page.mouse.click(target.x, target.y);

  const after = (await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    await engine.whenSettled();
    return engine.scene.view3d.camera.rotation;
  })) as Quat;

  // "The anterior preset" is a **direction**, not a quaternion: the eye is in front of the face and
  // superior is up. Both are read out of the resulting rotation here, by hand.
  const b = basisOf(after);
  expect(round3(b.back), 'the eye is anterior of the target').toEqual([0, 1, 0]);
  expect(round3(b.up), 'superior is screen-up').toEqual([0, 0, 1]);

  // And it is the shared preset path, so the cube and the `1`/`A` key cannot diverge.
  const viaKey = (await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.cameraPreset('view3d', 'A');
    await engine.whenSettled();
    return engine.scene.view3d.camera.rotation;
  })) as Quat;
  expect(after).toEqual(viaKey);
});

test('@angle orientation cube: a click that misses the cube does not move the camera', async ({
  page,
}) => {
  await openScene(page);
  const { rotation } = await open3D(page, TILT);
  // The box's own corner: inside the reserved square, outside the projected cube.
  await page.mouse.click(CUBE_CX - CUBE_HALF + 1, PANE - (CUBE_CY + CUBE_HALF) + 1);
  const after = (await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    await engine.whenSettled();
    return engine.scene.view3d.camera.rotation;
  })) as Quat;
  expect(after).toEqual(rotation);
});

test('orientation cube golden', async ({ page }) => {
  await openScene(page);
  // Three faces at once — the picture a regression in the shading, the winding or the letter
  // placement would move. `q` tilts about x and then about z, so `A`, `S` and `R` all show.
  const h = Math.PI / 7;
  const q: Quat = [
    Math.sin(-h) * Math.cos(h),
    Math.sin(-h) * Math.sin(h),
    Math.cos(-h) * Math.sin(h),
    Math.cos(h) * Math.cos(h),
  ];
  const n = Math.hypot(...q) || 1;
  await open3D(page, [q[0] / n, q[1] / n, q[2] / n, q[3] / n]);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ orientationLabels: true, cornerInfo: true });
    await engine.whenSettled();
  });
  await expectGolden(page, 'scene-orientation-cube');
});
