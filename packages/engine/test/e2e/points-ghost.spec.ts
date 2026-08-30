/**
 * §4.4's points-layer additions for §13's modules (2026-08-30) — the analytic gate.
 *
 * §11 rule 0: an agent cannot judge a picture, it can judge a number. So the claim under test is
 * stated as an RGBA computed from first principles, never read off a previous render:
 *
 * > a point off the slice is drawn at its **full** radius and at `offPlaneOpacity`, blended over
 * > whatever the slice already painted.
 *
 * The pane's blend is `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` (`GL_STATE.blend2d`), so the expected pixel
 * is `src·a + dst·(1 − a)` — arithmetic over two numbers this file knows independently: the layer's
 * own colour, and the tag colour `testdata/manifest.json` authored for the fixture under it.
 *
 * The scene is `derived.spec.ts`'s coronal lattice, deliberately: its `fillIn2D` paints a **known**
 * tag colour under the points, which is what turns "the ghost is translucent" into a number, and
 * `mesh_v2_binary.msh.opt` hides tag 1 — so the pane has two different destinations for one source
 * and a ghost implemented as a fixed dimmed colour cannot pass both.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectPixel } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const LATTICE = fixture('mesh_v2_binary.msh');
const LATTICE_OPT = fixture('mesh_v2_binary.msh.opt');

/** The canvas in `test/pages/scene.html`; with `1x1` the pane *is* the canvas. */
const PANE = 768;
const CX = PANE / 2;
const CY = PANE / 2;

/** `testdata/manifest.json` → `sidecars['mesh_v2_binary.msh.opt'].expected.tagColor[2]`. */
const TAG2 = [129, 129, 129] as const;
/** `scene/defaults.ts`'s `background`, as bytes. */
const BG = [10, 13, 18] as const;

/** The points' colour: pure red, so every channel of the blend below is a different number. */
const RED = [255, 0, 0] as const;
const GHOST = 0.6;

type Rgba = [number, number, number, number];

/**
 * `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` over an opaque destination, in wire bytes.
 *
 * The destination alpha is 1 — the pane was cleared opaque and every layer under the points is —
 * so the result's alpha is `a + 1·(1 − a) = 1`, i.e. 255, whatever `a` is.
 */
function over(src: readonly number[], dst: readonly number[], a: number): Rgba {
  const mix = (i: number): number => Math.round((src[i] ?? 0) * a + (dst[i] ?? 0) * (1 - a));
  return [mix(0), mix(1), mix(2), 255];
}

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html?aa=off');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/**
 * The coronal lattice of `derived.spec.ts`, with one points layer on the same dataset.
 *
 * `mmPerPx = 0.05` and `center = [0, 0]` make the pane an exact 20 px/mm ruler around the cursor:
 * world `(x, ·, z)` lands at `(CX + x/0.05, CY − z/0.05)`, and every pixel named below follows from
 * that rather than from a measurement.
 *
 * The cursor's `y = 2.5` is `derived.spec.ts`'s choice and it matters here too: the node grid sits
 * at `y ∈ {−10, 0, 10}` and a plane through a node plane is the degenerate cut.
 */
async function ghostScene(
  page: Page,
  layer: Record<string, unknown> = {}
): Promise<{ layerId: string }> {
  return await page.evaluate(
    async ([url, opt, patch]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      const points = engine.addLayer({
        datasetId: ds.id,
        kind: 'points',
        // Two points 10 mm apart along the pane normal: one exactly on the plane the cursor
        // derives, one 10 mm off it with a 2 mm radius — so its cross-section with this slice is
        // empty and nothing but a ghost can draw it.
        points: [
          { position: [-5, 2.5, 5], name: 'ON', id: 'p0', group: 'A', ordinal: 1 },
          { position: [5, 12.5, 5], name: 'OFF', id: 'p1', group: 'A', ordinal: 2 },
        ],
        color: [1, 0, 0, 1],
        radiusMm: 2,
        ...(patch as Record<string, unknown>),
      });
      engine.setLayout({ kind: '1x1', cells: ['coronal'] });
      engine.setCursor([0, 2.5, 0]);
      engine.setView('coronal', { camera: { center: [0, 0], mmPerPx: 0.05 } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
      return { layerId: points.id };
    },
    [LATTICE, LATTICE_OPT, layer] as const
  );
}

/** Pane pixels of a world point in the coronal pane above: right = +X, up = +Z, 0.05 mm/px. */
const at = (x: number, z: number): [number, number] => [CX + x / 0.05, CY - z / 0.05];

test('absent offPlaneOpacity is the cull: the off-slice point draws nothing', async ({ page }) => {
  const errors = await openScene(page);
  await ghostScene(page);

  const [onX, onY] = at(-5, 5);
  // The on-slice point is its own colour exactly: a 2D cross-section is unshaded (§7.2), so this is
  // the layer colour's wire bytes and nothing else.
  await expectPixel(page, onX, onY, [...RED, 255]);
  // 1.5 mm out is still inside the 2 mm disc; 2.5 mm out is not, and shows the tag under it.
  await expectPixel(page, onX + 30, onY, [...RED, 255]);
  await expectPixel(page, onX + 50, onY, [...TAG2, 255]);
  // The off-slice point is absent — not dimmed, absent. That is what every scene written before
  // `offPlaneOpacity` existed does, and what "absent reproduces the previous behaviour" means here.
  await expectPixel(page, ...at(5, 5), [...TAG2, 255]);
  expect(errors).toEqual([]);
});

test('offPlaneOpacity 0.6 draws the off-slice point at its full radius, blended', async ({
  page,
}) => {
  const errors = await openScene(page);
  await ghostScene(page, { offPlaneOpacity: GHOST });

  const [gx, gy] = at(5, 5);
  // The claim, as arithmetic: 0.6 of red over tag 2's grey.
  await expectPixel(page, gx, gy, over(RED, TAG2, GHOST), 2);
  // **Full radius, not the vanishing cross-section.** The point is 10 mm off the plane, so
  // `sqrt(r² − d²)` has no root; the ghost is the whole 2 mm disc, and 1.5 mm out is inside it.
  await expectPixel(page, gx + 30, gy, over(RED, TAG2, GHOST), 2);
  await expectPixel(page, gx + 50, gy, [...TAG2, 255]);
  // The on-slice point is untouched by ghosting — `vAlphaScale` is 1 for it, so it is opaque still.
  await expectPixel(page, ...at(-5, 5), [...RED, 255]);
  expect(errors).toEqual([]);
});

test('a ghost blends over whatever is behind it, background included', async ({ page }) => {
  const errors = await openScene(page);
  // One point below `z = 0`, where `tagVisible[1] = false` leaves the pane empty: same source, same
  // alpha, a different destination. A ghost implemented as a fixed dimmed colour rather than an
  // alpha would pass the test above and fail this one.
  await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.addLayer({
        datasetId: ds.id,
        kind: 'points',
        points: [{ position: [5, 12.5, -5], name: 'OFF' }],
        color: [1, 0, 0, 1],
        radiusMm: 2,
        offPlaneOpacity: 0.6,
      });
      engine.setLayout({ kind: '1x1', cells: ['coronal'] });
      engine.setCursor([0, 2.5, 0]);
      engine.setView('coronal', { camera: { center: [0, 0], mmPerPx: 0.05 } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_OPT] as const
  );
  await expectPixel(page, ...at(5, -5), over(RED, BG, GHOST), 2);
  expect(errors).toEqual([]);
});

test("shape 'dot' ghosts at its constant pixel radius, at every zoom", async ({ page }) => {
  const errors = await openScene(page);
  await ghostScene(page, { shape: 'dot', offPlaneOpacity: GHOST });

  // `derived.ts` passes `uDotPx = 4 * uiScale` and the golden legs run at `dpr: 1`, so a ghosted dot
  // is a 4 px disc: its centre and 3 px out are inside it, 6 px out is not. That is the radius the
  // on-slice dot draws at too — a screen-space marker has no second size to fade to.
  const [dx, dy] = at(5, 5);
  await expectPixel(page, dx, dy, over(RED, TAG2, GHOST), 2);
  await expectPixel(page, dx + 3, dy, over(RED, TAG2, GHOST), 2);
  await expectPixel(page, dx + 6, dy, [...TAG2, 255]);

  // Zoom out 4×. A world-radius ghost would shrink to a quarter of the disc; this one does not move.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setView('coronal', { camera: { center: [0, 0], mmPerPx: 0.2 } });
    await engine.whenSettled();
  });
  const zx = CX + 5 / 0.2;
  const zy = CY - 5 / 0.2;
  await expectPixel(page, zx, zy, over(RED, TAG2, GHOST), 2);
  await expectPixel(page, zx + 3, zy, over(RED, TAG2, GHOST), 2);
  await expectPixel(page, zx + 6, zy, [...TAG2, 255]);
  expect(errors).toEqual([]);
});
