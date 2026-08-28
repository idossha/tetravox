/**
 * §4.4's `GlyphSpec` on the synthetic lattice: **which way an arrow points on screen, and how long
 * it is in pixels** (directed task 7).
 *
 * `derived.spec.ts` already asserts that arrows appear, that `subsample` is the density knob and
 * that hiding a tag removes them. What no test asserted before is the part a user reads a *number*
 * off: the direction and the length. Both live entirely in the vertex shader, so a golden PNG can
 * only say that some ink arrived.
 *
 * The method, and why it is analytic rather than a picture:
 *
 * * the draw is reduced to **one instance** (`subsample: { maxCount: 1 }` over 48 tets is a stride
 *   of 48, and `meshCentroids` returns exactly one origin);
 * * `Engine.glyphInstances` reports that instance's origin, field vector and length in **millimetres**
 *   — the renderer's own inputs, out of the arrays the tables were uploaded from;
 * * the camera is `FRONT_FACE_CAMERA`, whose projection is written out in `mesh-support.ts`, so the
 *   origin and the tip project to pane pixels by hand;
 * * every magenta pixel is then resolved into (**along**, **across**) the projected axis. An arrow
 *   that points the right way puts all of its ink between 0 and the tip, within the shaft's own
 *   radius of the axis — which is a statement about direction *and* length, in pixels, and it fails
 *   for a sign flip, a transposed frame, a wrong scaling mode and a wrong reference magnitude alike.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasRect } from '../helpers/pixels';
import { FRONT_FACE_CAMERA, PANE } from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const LATTICE = `/@fs${REPO}testdata/mesh_v2_binary.msh`;
const LATTICE_OPT = `/@fs${REPO}testdata/mesh_v2_binary.msh.opt`;

/** `FRONT_FACE_CAMERA`: eye on −X at 31 mm, forward +X, screen-right −Y, screen-up +Z. */
const EYE_X = -FRONT_FACE_CAMERA.distance;
const TAN_HALF_FOV = Math.tan((FRONT_FACE_CAMERA.fovYDeg * Math.PI) / 360);

/**
 * A world point as a pane pixel, top-left origin. The aspect is 1 (the pane is square), so one
 * `tan(fov/2)` serves both axes.
 *
 * `mesh-support.ts`'s `worldToFacePixel` is this specialised to the cube's front face, where the
 * depth is the constant 21 mm. A glyph is not on that face, so the depth stays a variable here.
 */
function worldToPanePixel(p: readonly [number, number, number]): [number, number] {
  const depth = p[0] - EYE_X;
  const ndcX = -p[1] / (depth * TAN_HALF_FOV);
  const ndcY = p[2] / (depth * TAN_HALF_FOV);
  return [((ndcX + 1) / 2) * PANE, ((1 - ndcY) / 2) * PANE];
}

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/**
 * One magenta glyph on the lattice's interior, with the surface hidden, in the front-face camera.
 *
 * The tri tags go invisible and the tet tags stay on — the same one state `derived.spec.ts` uses to
 * separate the two origin paths — so nothing but the arrow is drawn and every magenta pixel in the
 * pane belongs to it.
 */
async function oneGlyph(
  page: Page,
  mode: 'fixed' | 'linear' | 'sqrt' | 'log',
  lengthMm: number
): Promise<{
  origin: [number, number, number];
  vector: [number, number, number];
  magnitude: number;
  lengthMm: number;
  element: number;
  count: number;
}> {
  return await page.evaluate(
    async ([url, opt, m, len]) => {
      const engine = window.__tvxEngine!;
      engine.retainGlyphSources(true);
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      engine.updateLayer(layer.id, {
        tagStyle: {
          1: { visible: true, opacity: 1 },
          2: { visible: true, opacity: 1 },
          1001: { visible: false, opacity: 1 },
          1002: { visible: false, opacity: 1 },
        },
        glyphs: {
          field: { source: 'elm', name: 'E' },
          shape: 'arrow',
          // 48 tets, one glyph: the op's stride is 48 and exactly one centroid comes back.
          subsample: { maxCount: 1 },
          scale: {
            mode: m as 'fixed' | 'linear' | 'sqrt' | 'log',
            lengthMm: len as number,
            normalizeTo: 'max',
            logFloor: 0.5,
          },
          lengthMm: len as number,
          colorBy: 'solid',
          color: [1, 0, 1, 1],
          clipToCutPlane: false,
          // Interior origins: the surface is hidden (it would occlude the arrow), and a hidden tag
          // has no surface glyphs at all — §7.4 restricts origins to visible tags.
          origins: 'volume',
          headProportion: 0.3,
        },
      });
      engine.setView('view3d', {
        camera: {
          target: [0, 0, 0],
          distance: 31,
          rotation: [0.5, -0.5, -0.5, 0.5],
          fovYDeg: (2 * Math.atan(15 / 31) * 180) / Math.PI,
          orthographic: false,
          near: 1,
          far: 200,
        },
      });
      await engine.whenSettled();
      engine.renderNow();
      // The origin and field ops are requested by the first draw; `whenSettled` covers the load,
      // not those, so wait for the readback to become available rather than for a frame count.
      let inst = engine.glyphInstances(layer.id);
      for (let i = 0; i < 200 && (inst === null || inst.length === 0); i += 1) {
        engine.renderNow();
        await new Promise((r) => setTimeout(r, 25));
        inst = engine.glyphInstances(layer.id);
      }
      if (inst === null || inst.length === 0) throw new Error('no glyph instances');
      const first = inst[0]!;
      return {
        origin: first.origin as [number, number, number],
        vector: first.vector as [number, number, number],
        magnitude: first.magnitude,
        lengthMm: first.lengthMm,
        element: first.element,
        count: inst.length,
      };
    },
    [LATTICE, LATTICE_OPT, mode, lengthMm] as const
  );
}

/** Every magenta pixel in the pane, as `[x, y]` with a top-left origin. */
async function magentaPixels(page: Page): Promise<[number, number][]> {
  const px = await readCanvasRect(page, 0, 0, PANE, PANE);
  const out: [number, number][] = [];
  for (let y = 0; y < PANE; y += 1) {
    for (let x = 0; x < PANE; x += 1) {
      const i = (y * PANE + x) * 4;
      if ((px[i] ?? 0) > 110 && (px[i + 1] ?? 0) < 70 && (px[i + 2] ?? 0) > 110) out.push([x, y]);
    }
  }
  return out;
}

test('an arrow points along its field vector, and its drawn length is the scaling model', async ({
  page,
}) => {
  const errors = await openScene(page);
  const g = await oneGlyph(page, 'fixed', 6);
  expect(errors).toEqual([]);
  expect(g.count, 'maxCount 1 over 48 tets must be exactly one instance').toBe(1);

  // The lattice's `E` is `(0.25·row, 1 − 0.125·row, 2.5)` over the 0-based element rows
  // (`scripts/gen-fixtures.py`), so the readback's vector must be that function of its own element
  // number — the one assertion that catches an off-by-one in `ownerTet - 1`, which is the indexing
  // §6.5.2 licenses only when `identityElementNumbers` holds.
  const r = g.element - 1;
  expect(g.vector[0]).toBeCloseTo(0.25 * r, 4);
  expect(g.vector[1]).toBeCloseTo(1 - 0.125 * r, 4);
  expect(g.vector[2]).toBeCloseTo(2.5, 5);
  expect(g.magnitude).toBeCloseTo(Math.hypot(0.25 * r, 1 - 0.125 * r, 2.5), 4);
  // `fixed` puts the length at exactly `lengthMm`, whatever the magnitude is.
  expect(g.lengthMm).toBeCloseTo(6, 10);

  const unit = g.vector.map((v) => v / g.magnitude) as [number, number, number];
  const tip: [number, number, number] = [
    g.origin[0] + unit[0] * g.lengthMm,
    g.origin[1] + unit[1] * g.lengthMm,
    g.origin[2] + unit[2] * g.lengthMm,
  ];
  const o = worldToPanePixel(g.origin);
  const t = worldToPanePixel(tip);
  const axis: [number, number] = [t[0] - o[0], t[1] - o[1]];
  const axisLen = Math.hypot(axis[0], axis[1]);
  expect(axisLen, 'the arrow must be tens of pixels long, not sub-pixel').toBeGreaterThan(40);
  const ux = axis[0] / axisLen;
  const uy = axis[1] / axisLen;

  const pixels = await magentaPixels(page);
  expect(pixels.length, 'the one arrow must be on screen').toBeGreaterThan(200);

  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let maxAcross = 0;
  for (const [x, y] of pixels) {
    const dx = x + 0.5 - o[0];
    const dy = y + 0.5 - o[1];
    const along = dx * ux + dy * uy;
    const across = Math.abs(-dx * uy + dy * ux);
    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    maxAcross = Math.max(maxAcross, across);
  }

  // §7.4's template is a unit arrow from 0 to 1 along +Z with head radius 0.16 of the length, so in
  // pane pixels the ink runs from 0 to `axisLen` along the axis and stays within the head's own
  // projected radius of it. That radius is measured off the arrow's **full** length, not off
  // `axisLen`: the arrow is foreshortened (it points partly at the eye, which is why `axisLen` is a
  // fraction of the 6 mm), and its girth is not.
  const pxPerMm = PANE / (2 * (g.origin[0] - EYE_X) * TAN_HALF_FOV);
  const girthPx = 0.16 * g.lengthMm * pxPerMm + 3;
  // Each bound fails for a different mistake: ink far behind the origin is an arrow drawn backwards,
  // a short `maxAlong` is a wrong length, and a large `maxAcross` is a broken orthonormal frame.
  expect(minAlong, 'no ink behind the origin: the arrow starts at the element').toBeGreaterThan(
    -girthPx
  );
  expect(maxAlong, 'the tip reaches the projected tip').toBeGreaterThan(axisLen - 4);
  expect(maxAlong, 'and does not overshoot it').toBeLessThan(axisLen + 4);
  expect(maxAcross, 'the ink stays inside the head radius').toBeLessThan(girthPx);
});

test('the drawn length follows the scaling mode, measured in pane pixels', async ({ page }) => {
  // A fresh page per mode: `oneGlyph` adds a dataset and a layer, and two layers in one pane would
  // put two arrows' ink in the same readback.
  let errors = await openScene(page);
  const fixed = await oneGlyph(page, 'fixed', 6);
  const fixedInk = await magentaPixels(page);
  errors = [...errors, ...(await openScene(page))];
  const linear = await oneGlyph(page, 'linear', 6);
  const linearInk = await magentaPixels(page);
  expect(errors).toEqual([]);

  const extent = (pixels: [number, number][], origin: readonly number[]): number => {
    const o = worldToPanePixel(origin as [number, number, number]);
    let max = 0;
    for (const [x, y] of pixels) max = Math.max(max, Math.hypot(x + 0.5 - o[0], y + 0.5 - o[1]));
    return max;
  };

  expect(fixed.lengthMm).toBeCloseTo(6, 10);
  // `normalizeTo: 'max'` and the lattice's own magnitudes: linear length is `6·m/R`, which the
  // readback reports and the ink has to match in the same ratio.
  const ratio = linear.lengthMm / fixed.lengthMm;
  expect(ratio).toBeGreaterThan(0);
  expect(ratio).toBeLessThan(1);
  const drawnRatio = extent(linearInk, linear.origin) / extent(fixedInk, fixed.origin);
  expect(drawnRatio, `expected ${ratio}`).toBeGreaterThan(ratio - 0.08);
  expect(drawnRatio).toBeLessThan(ratio + 0.08);
});

/**
 * The §11 golden for the new scaling: **`derived-glyphs-log`**.
 *
 * The same lattice and the same camera as `derived-glyphs-e-field`, with `mode: 'log'` and the
 * magnitude colour bar and the legend line on — so the picture carries its own key, which is the
 * point of the change. `everyNth: 1` over the tets, colour by magnitude on `viridis`.
 */
test('golden: derived-glyphs-log', async ({ page }) => {
  const errors = await openScene(page);
  await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setAnnotations({ colorbars: true, cornerInfo: true });
      engine.updateLayer(layer.id, {
        tagStyle: {
          1: { visible: true, opacity: 1 },
          2: { visible: true, opacity: 1 },
          1001: { visible: false, opacity: 1 },
          1002: { visible: false, opacity: 1 },
        },
        colormap: 'viridis',
        showColorbar: true,
        glyphs: {
          field: { source: 'elm', name: 'E' },
          shape: 'arrow',
          subsample: { everyNth: 1 },
          scale: { mode: 'log', lengthMm: 5, normalizeTo: 'max', logFloor: 2.7 },
          lengthMm: 5,
          colorBy: 'magnitude',
          color: [1, 0, 1, 1],
          clipToCutPlane: false,
          origins: 'volume',
          headProportion: 0.35,
        },
      });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_OPT] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-glyphs-log');
});
