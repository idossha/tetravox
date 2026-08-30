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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGolden, expectPixel, readCanvasRect } from '../helpers/pixels';
import { readChromeText } from '../helpers/chrome';
import { CELL_W } from '../../src/render/font';
import { DEFAULT_OVERLAY_THEME } from '../../src/overlay/theme';

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

// -------------------------------------------------------------------------------------------
// §4.4's `labelSource` — which array the in-pane text comes from
// -------------------------------------------------------------------------------------------

/**
 * The lower-left corner, in pane pixels with a bottom-left origin, of a label centred on the world
 * point `at(x, z)` draws at.
 *
 * Derived from §7.2's rule rather than measured: `placePointLabels` flips the top-down projection
 * (`height − 1 − y`) and lifts by `radiusMm / mmPerPx` pixels; `drawPointLabels` centres the string
 * on the anchor, so the left edge is half its width back. `CELL_W` is the font's own cell pitch.
 */
function labelCorner(x: number, z: number, length: number): { xLocal: number; yLocal: number } {
  const [ax, ayTop] = at(x, z);
  const liftPx = 2 / 0.05; // radiusMm / mmPerPx, at uiScale 1
  return {
    xLocal: Math.round(ax) - (length * CELL_W) / 2,
    yLocal: Math.round(PANE - 1 - ayTop + liftPx),
  };
}

/** Decode `length` glyphs at a label's corner. The text is white here, so the default ink applies. */
async function readLabel(page: Page, corner: { xLocal: number; yLocal: number }, length: number) {
  return readChromeText(page, {
    canvasHeight: PANE,
    pane: { x: 0, y: 0, width: PANE, height: PANE },
    ...corner,
    length,
  });
}

test("labelSource 'names' draws points[].name, and the slab still culls the ghosted ones", async ({
  page,
}) => {
  const errors = await openScene(page);
  // White text so §11's glyph matcher can use its own near-white ink predicate: the red discs, the
  // 0.6 ghost blend over them and the grey tag are all outside it, so anything it reads IS a glyph.
  await ghostScene(page, {
    showLabels: true,
    labelSource: 'names',
    labelColor: [1, 1, 1, 1],
    offPlaneOpacity: GHOST,
  });

  // The on-slice point's name, decoded back out of the framebuffer rather than eyeballed.
  expect(await readLabel(page, labelCorner(-5, 5, 2), 2)).toBe('ON');

  // **The labels do not follow the discs.** The second point is 10 mm off the plane: its disc is
  // ghosted (the test above proves that pixel is a blend) and its name is *not* drawn, because
  // §7.2's slab is `max(radiusMm, 1) = 2 mm`. That divergence is stated in §4.4 and §7.2; this is it
  // asserted — nothing but background arithmetic where `OFF` would have been.
  expect(await readLabel(page, labelCorner(5, 5, 3), 3)).toBe('');
  expect(errors).toEqual([]);
});

test("labelSource absent still reads the labels array, not the points' names", async ({ page }) => {
  const errors = await openScene(page);
  // `labels[0].text` differs from every `points[].name`, so the two sources cannot be confused: a
  // resolver that fell through to the names would decode `ON` here.
  await ghostScene(page, {
    showLabels: true,
    labelColor: [1, 1, 1, 1],
    labels: [{ position: [-5, 2.5, 5], text: 'LBL' }],
  });
  expect(await readLabel(page, labelCorner(-5, 5, 3), 3)).toBe('LBL');
  expect(errors).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// §13's selection ring — `DrawInput.pointSelection` / `pointHot`, in `OverlayTheme.select`
// -------------------------------------------------------------------------------------------

/** `OverlayTheme.select`'s violet, as the bytes `readPixel` returns (§4.1's exact-round-trip rule). */
const SELECT_RGBA: Rgba = [
  Math.round(DEFAULT_OVERLAY_THEME.select[0] * 255),
  Math.round(DEFAULT_OVERLAY_THEME.select[1] * 255),
  Math.round(DEFAULT_OVERLAY_THEME.select[2] * 255),
  255,
];

/**
 * Every distance from `(cx, cyTop)` at which the ring's own colour appears, over a box around it.
 *
 * §11's scale bar is asserted this way — "the drawn length is exactly `mm / mmPerPx`, read off the
 * framebuffer" — and a ring makes the same kind of promise: it *is* a radius, so the test measures
 * the radius rather than poking one pixel and trusting the rasteriser to have put it there. The box
 * is wider than any ring under test, so "no ring" is an empty array rather than a near miss.
 */
async function ringRadii(page: Page, cx: number, cyTop: number, half = 70): Promise<number[]> {
  const x0 = Math.round(cx - half);
  const y0 = Math.round(cyTop - half);
  const size = half * 2;
  const px = await readCanvasRect(page, x0, y0, size, size);
  const out: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      const hit =
        Math.abs((px[o] ?? 0) - SELECT_RGBA[0]) <= 1 &&
        Math.abs((px[o + 1] ?? 0) - SELECT_RGBA[1]) <= 1 &&
        Math.abs((px[o + 2] ?? 0) - SELECT_RGBA[2]) <= 1;
      if (hit) out.push(Math.hypot(x0 + x - cx, y0 + y - cyTop));
    }
  }
  return out;
}

/** A ring's measured radius must be `disc + gap` — 40 px of disc here, so 42, ± the ring's width. */
function expectRingAt(radii: readonly number[], expected: number): void {
  expect(radii.length, 'ring pixels found').toBeGreaterThan(80);
  expect(Math.min(...radii)).toBeGreaterThanOrEqual(expected - 2);
  expect(Math.max(...radii)).toBeLessThanOrEqual(expected + 2);
}

/** Arm the engine's §13 render seam. By array index — that is what the frame carries. */
async function highlight(
  page: Page,
  h: {
    selection?: { layerId: string; index: number } | null;
    hot?: { layerId: string; index: number } | null;
  } | null
): Promise<void> {
  await page.evaluate(async (spec) => {
    const engine = window.__tvxEngine!;
    engine.setPointHighlight(spec as never);
    await engine.whenSettled();
  }, h);
}

test('the selection ring is drawn at the disc radius plus the gap, in the theme colour', async ({
  page,
}) => {
  const errors = await openScene(page);
  const { layerId } = await ghostScene(page);
  // `setPointHighlight` is the engine's render-side seam (§13). P2's facade `setPointSelection`
  // resolves a `points[].id` to the index this takes; the ring is the same either way.
  await highlight(page, { selection: { layerId, index: 0 } });

  const [ox, oy] = at(-5, 5);
  // The on-slice point is a 2 mm sphere on the plane at 0.05 mm/px — a 40 px disc — so §7.2's
  // "r + 2 px" is a ring of radius 42, measured all the way round.
  expectRingAt(await ringRadii(page, ox, oy), 42);
  // Inside the ring is still the disc and outside is still the slice — a ring, not a filled halo.
  await expectPixel(page, ox + 30, oy, [...RED, 255]);
  await expectPixel(page, ox + 50, oy, [...TAG2, 255]);
  expect(errors).toEqual([]);
});

test('the ring follows the ghost: a ghosted point rings at its FULL radius', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await ghostScene(page, { offPlaneOpacity: GHOST });
  await highlight(page, { selection: { layerId, index: 1 } });

  // Point 1 is 10 mm off a 2 mm sphere, so it has no cross-section at all: the only radius a ring
  // can come from is the ghost's full 2 mm — 40 px of disc, 42 px of ring. A ring computed from
  // `sqrt(r² − d²)` would be NaN here; one at a fixed size would have looked right on the other
  // point and wrong on this one.
  const [gx, gy] = at(5, 5);
  expectRingAt(await ringRadii(page, gx, gy), 42);
  // …and inside it, the ghost is still a ghost.
  await expectPixel(page, gx + 30, gy, over(RED, TAG2, GHOST), 2);
  expect(errors).toEqual([]);
});

test('a selection the pane does not draw draws no ring at all', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await ghostScene(page);
  const [gx, gy] = at(5, 5);
  const [ox, oy] = at(-5, 5);

  // Point 1 is culled here — no `offPlaneOpacity` — so a ring around it would claim the tool had
  // selected something the user cannot see.
  await highlight(page, { selection: { layerId, index: 1 } });
  expect(await ringRadii(page, gx, gy)).toEqual([]);
  await expectPixel(page, gx, gy, [...TAG2, 255]);

  // A stale index is a missing ring, never a ring around the wrong contact: after a delete the two
  // are one array replacement apart.
  await highlight(page, { selection: { layerId, index: 9 } });
  expect(await ringRadii(page, ox, oy)).toEqual([]);
  expect(errors).toEqual([]);
});

test('the hot ring is the thinner one, and never doubles the selection ring', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await ghostScene(page, { offPlaneOpacity: GHOST });
  const [ox, oy] = at(-5, 5);
  const [gx, gy] = at(5, 5);

  await highlight(page, {
    selection: { layerId, index: 0 },
    hot: { layerId, index: 1 },
  });
  const selected = await ringRadii(page, ox, oy);
  const hot = await ringRadii(page, gx, gy);
  // Both rings are at the disc radius plus the gap; the hot one is the thinner, so it covers fewer
  // pixels of the same circle — which is how a user tells "I am over this" from "this is selected".
  expectRingAt(selected, 42);
  expectRingAt(hot, 42);
  expect(hot.length).toBeLessThan(selected.length);

  // Both halves name the same point: one ring, and it is the selection's. "Draw both" gives two
  // concentric rings a pixel apart, which reads as a rendering fault rather than as a selection.
  await highlight(page, {
    selection: { layerId, index: 0 },
    hot: { layerId, index: 0 },
  });
  expect((await ringRadii(page, ox, oy)).length).toBe(selected.length);
  expect(await ringRadii(page, gx, gy)).toEqual([]);
  expect(errors).toEqual([]);
});

test('clearing the highlight removes every ring', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await ghostScene(page);
  const [ox, oy] = at(-5, 5);
  await highlight(page, { selection: { layerId, index: 0 } });
  expectRingAt(await ringRadii(page, ox, oy), 42);

  // `null` clears both halves: a frame that kept the hot ring after a clear would leave a ring on
  // the pane the moment the tool was disarmed.
  await highlight(page, null);
  expect(await ringRadii(page, ox, oy)).toEqual([]);
  expect(await page.evaluate(() => window.__tvxEngine!.pointHighlight())).toEqual({
    selection: null,
    hot: null,
  });
  expect(errors).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// The §11 golden
// -------------------------------------------------------------------------------------------

/**
 * `derived-points-ghost` — the one new regression picture for all three additions at once.
 *
 * The scene is `testdata/ct_shafts.nii.gz`, the phantom `derived/voxel-box.ts` is tested against:
 * three depth electrodes, 3.5 mm contact pitch, oblique to every axis. That is deliberate rather
 * than convenient — the whole point of `offPlaneOpacity` is that a shaft is a *shaft* and not one
 * contact at a time, and no synthetic lattice can show that. In the picture: the on-slice contacts
 * are opaque discs, the rest of each shaft is ghosted at 0.6, every contact carries its own name
 * through `labelSource: 'names'` (slab-culled, so only the near ones are labelled — the divergence
 * §7.2 states), and one contact wears the selection ring.
 *
 * The contact positions come from `testdata/manifest.json`, not from a literal here, so the picture
 * and the numeric tests cannot describe two different electrodes.
 */
interface ManifestContacts {
  voxelBox: { contacts: { group: string; ordinal: number; world: [number, number, number] }[] };
}
const CONTACTS = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../testdata/manifest.json', import.meta.url)),
      'utf8'
    )
  ) as ManifestContacts
).voxelBox.contacts;

/** One colour per electrode — far apart, and none of them the ring's violet. */
const GROUP_COLOR: Record<string, [number, number, number, number]> = {
  A: [1, 0.45, 0.15, 1],
  B: [0.3, 0.95, 0.5, 1],
  C: [1, 0.85, 0.25, 1],
};

test('golden: derived-points-ghost', async ({ page }) => {
  const errors = await openScene(page);
  await page.evaluate(
    async ([url, contacts, colors]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const volume = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      // A fixed window, so the picture is a function of the scene rather than of a percentile —
      // and a NARROW one, `0…120`, which puts the phantom's ~40 HU soft tissue at a mid grey and
      // saturates the metal. A ghost blended over black is indistinguishable from a dim contact;
      // over grey it is the thing this picture exists to regress.
      engine.updateLayer(volume.id, { scale: { kind: 'linear', lo: 0, hi: 120 } });
      const rows = contacts as {
        group: string;
        ordinal: number;
        world: [number, number, number];
      }[];
      const palette = colors as Record<string, [number, number, number, number]>;
      const points = engine.addLayer({
        datasetId: ds.id,
        kind: 'points',
        module: 'tetravox.seeg',
        name: 'Contacts · ct_shafts',
        points: rows.map((c) => ({
          id: `${c.group}${String(c.ordinal).padStart(2, '0')}`,
          group: c.group,
          ordinal: c.ordinal,
          name: `${c.group}${String(c.ordinal).padStart(2, '0')}`,
          position: c.world,
          color: palette[c.group],
        })),
        color: [1, 1, 1, 1],
        radiusMm: 1.2,
        showLabels: true,
        labelSource: 'names',
        labelColor: [0.95, 0.96, 1, 1],
        offPlaneOpacity: 0.6,
      });
      // The cursor on A3, so its own slice shows opaque discs and the rest of the shaft ghosts.
      const a3 = rows.find((c) => c.group === 'A' && c.ordinal === 3)!;
      engine.setCursor(a3.world);
      engine.setPointHighlight({ selection: { layerId: points.id, index: rows.indexOf(a3) } });
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      // §11: "every golden includes the §8 2D chrome … and the colour bars."
      engine.setAnnotations({ colorbars: true });
      for (const id of ['axial', 'coronal', 'sagittal']) {
        engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.09 } });
      }
      engine.resetView('view3d');
      await engine.whenSettled();
    },
    [fixture('ct_shafts.nii.gz'), CONTACTS, GROUP_COLOR] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-points-ghost');
});
