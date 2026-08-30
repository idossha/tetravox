/**
 * **Directed task 12 — a surface's intersection with each 2D pane, as a constant-width line.**
 *
 * The reference is a Freeview screenshot: the pial surface drawn as a thin yellow outline on the
 * axial, sagittal and coronal panes, and the surface itself in 3D. What that reduces to, and what
 * this file asserts, is four things:
 *
 * 1. a surface layer draws a contour **by default**, in its palette colour, with no fill;
 * 2. the contour is **where the geometry says it is** — the expected pixel is computed here, in
 *    Node, from the fixture's own construction rule and the pane's projection, and never from a
 *    previous run (§11 rule 0);
 * 3. hiding the layer removes it — the same pixel is background;
 * 4. the width is constant in **screen** pixels across a zoom, which is the whole reason §7.0.6's
 *    quad expansion exists (`gl.lineWidth()` is a no-op, `ALIASED_LINE_WIDTH_RANGE` is `[1,1]`).
 *
 * `surf_gzipb64.surf.gii` is the fixture: `scripts/gen-fixtures.py`'s `surface_patch()`, a 4×4 grid
 * of vertices triangulated into 18 triangles, plus the GIfTI `GIFTI_XFORM` translation. It is a
 * **surface** — 16 nodes, 0 tets — so it takes the §7.4 surface defaults and goes down
 * `derived/store.ts`'s `contours` path rather than `cut`, which is the path under test.
 *
 * Every analytic test is tagged `@angle`, so §11's "run the analytic assertions twice" covers this
 * feature on the real GPU as well as on the golden authority. The golden itself is not: §11 stores
 * one per renderer class and only `test/golden/swiftshader/` exists.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, expectPixel, readCanvasRect } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const SURFACE = fixture('surf_gzipb64.surf.gii');

/** The canvas in `test/pages/scene.html`; a `1x1` pane fills it. */
const PANE = 768;
const CX = PANE / 2;
const CY = PANE / 2;

/**
 * `scene/defaults.ts`'s `SURFACE_CONTOUR_PALETTE[0]` — Freeview's pial yellow — as the bytes a
 * framebuffer holds. `[1, 0.9, 0.15, 1] × 255 = 255, 229.5, 38.25`, and the renderer writes the
 * rounded unsigned-normalised value.
 */
const YELLOW = [255, 230, 38, 255] as const;
/** `scene/defaults.ts`'s `background`, as bytes. */
const BG = [10, 13, 18, 255] as const;

// -----------------------------------------------------------------------------------------------
// The fixture's geometry, from its construction rule — not from the file
// -----------------------------------------------------------------------------------------------

/**
 * `scripts/gen-fixtures.py`'s `surface_patch()` and `GIFTI_XFORM`, transcribed.
 *
 * ```py
 * xs = linspace(-30, 30, 4);  ys = linspace(-20, 20, 4)
 * z  = 5*cos(pi*i/3) + 2*sin(pi*j/3)
 * xform = translate(2.5, -4, 7.25)
 * ```
 *
 * Rebuilding it here rather than reading the GIfTI is the point: if the reader and the renderer
 * ever agreed on the *wrong* geometry, a test that asked the reader would agree with them.
 */
function fixtureVertices(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let j = 0; j < 4; j += 1) {
    for (let i = 0; i < 4; i += 1) {
      const x = -30 + 20 * i;
      const y = -20 + (40 / 3) * j;
      const z = 5 * Math.cos((Math.PI * i) / 3) + 2 * Math.sin((Math.PI * j) / 3);
      out.push([x + 2.5, y - 4, z + 7.25]);
    }
  }
  return out;
}

/** The same quad→two-triangle split the generator writes: `(a, a+1, a+5)` and `(a, a+5, a+4)`. */
function fixtureTriangles(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let j = 0; j < 3; j += 1) {
    for (let i = 0; i < 3; i += 1) {
      const a = j * 4 + i;
      out.push([a, a + 1, a + 5]);
      out.push([a, a + 5, a + 4]);
    }
  }
  return out;
}

/**
 * Every triangle's intersection with `dot(normal, p) + offset = 0`, as `[a, b]` pairs of world mm.
 *
 * The same rule §6.3's `surface_contours` uses — a vertex exactly on the plane counts as
 * non-negative — written independently, because this is the reference the render is checked against.
 */
function contourSegments(
  normal: [number, number, number],
  offset: number
): [[number, number, number], [number, number, number]][] {
  const verts = fixtureVertices();
  const out: [[number, number, number], [number, number, number]][] = [];
  for (const tri of fixtureTriangles()) {
    const p = tri.map((k) => verts[k] as [number, number, number]);
    const d = p.map(
      (q) => normal[0] * q[0] + normal[1] * q[1] + normal[2] * q[2] + offset
    ) as number[];
    const hits: [number, number, number][] = [];
    for (let k = 0; k < 3; k += 1) {
      const a = k;
      const b = (k + 1) % 3;
      const da = d[a] as number;
      const db = d[b] as number;
      if (da >= 0 === db >= 0) continue;
      const t = da / (da - db);
      const pa = p[a] as [number, number, number];
      const pb = p[b] as [number, number, number];
      hits.push([
        pa[0] + (pb[0] - pa[0]) * t,
        pa[1] + (pb[1] - pa[1]) * t,
        pa[2] + (pb[2] - pa[2]) * t,
      ]);
    }
    if (hits.length === 2)
      out.push([hits[0] as [number, number, number], hits[1] as [number, number, number]]);
  }
  return out;
}

/**
 * The in-plane origin a 2D pane draws about: the **scene bounds' centre**, not the world origin.
 *
 * `SliceView.camera.center` is an offset from `planeAnchor(scene bounds)` (`engine.ts`'s
 * `#rendered`), so `center: [0, 0]` means "centred on the data", which for this fixture is
 * `(2.5, −4)` in x/y — the GIfTI translation, since `surface_patch()` is centred on the origin
 * before it. Derived from the fixture's own bounding box rather than typed in, so it stays right if
 * the fixture ever moves.
 */
function sceneAnchor(): [number, number, number] {
  const verts = fixtureVertices();
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k] as number, v[k] as number);
      hi[k] = Math.max(hi[k] as number, v[k] as number);
    }
  }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

/**
 * A world point's pane pixel in the **axial** pane, top-left origin.
 *
 * The axial basis is `normal = +Z`, `up = +Y`, so `right = cross(up, normal) = +X` (§3), and
 * `radiological` is `false` by default so nothing is mirrored. A fragment samples at the pixel
 * *centre*, so the pixel showing an in-plane offset `d` from the anchor is `N/2 + d/mm − 0.5` — the
 * same −0.5 `derived-r4.spec.ts` derives at length.
 */
function axialPixel(w: readonly [number, number, number], mmPerPx: number): [number, number] {
  const a = sceneAnchor();
  return [
    Math.round(CX + (w[0] - a[0]) / mmPerPx - 0.5),
    Math.round(CY - (w[1] - a[1]) / mmPerPx - 0.5),
  ];
}

// -----------------------------------------------------------------------------------------------

async function openScene(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/test/pages/scene.html${query}`);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/** The patch on an axial pane at `z`, with the chrome off so every lit pixel is the contour. */
async function axialSurface(
  page: Page,
  z: number,
  mmPerPx: number
): Promise<{
  layerId: string;
  contourColor: number[] | undefined;
  widthPx: number;
  fill: boolean;
}> {
  return await page.evaluate(
    async ([url, zz, scale]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setCursor([0, 0, zz as number]);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: scale as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
      const l = engine.scene.layers.find((x) => x.id === layer.id) as {
        contourColor?: number[];
        contourWidthPx: number;
        fillIn2D: boolean;
      };
      return {
        layerId: layer.id,
        contourColor: l.contourColor,
        widthPx: l.contourWidthPx,
        fill: l.fillIn2D,
      };
    },
    [SURFACE, z, mmPerPx] as const
  );
}

/**
 * The whole pane in one `readPixels`.
 *
 * Every assertion below samples tens of points, and a round trip per point is both slow and — worse
 * — spread over several frames. One rectangle is one frame, so what the assertions compare is a
 * single picture.
 */
async function paneImage(page: Page): Promise<Uint8Array> {
  return readCanvasRect(page, 0, 0, PANE, PANE);
}

/** Is this pixel the contour colour? ±2 per channel, the renderer-class rounding window. */
function isYellow(img: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= PANE || y >= PANE) return false;
  const i = (y * PANE + x) * 4;
  return (
    Math.abs((img[i] ?? 0) - YELLOW[0]) <= 2 &&
    Math.abs((img[i + 1] ?? 0) - YELLOW[1]) <= 2 &&
    Math.abs((img[i + 2] ?? 0) - YELLOW[2]) <= 2
  );
}

/** How many pixels in a `±r` box around `(x, y)` are the contour colour. */
function yellowNear(img: Uint8Array, x: number, y: number, r: number): number {
  let n = 0;
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) if (isYellow(img, x + dx, y + dy)) n += 1;
  }
  return n;
}

// -----------------------------------------------------------------------------------------------
// 1 + 2 — a surface draws its intersection, in its palette colour, where the geometry says
// -----------------------------------------------------------------------------------------------

test('a surface draws its plane intersection at the computed screen position, by default @angle', async ({
  page,
}) => {
  const errors = await openScene(page);
  const mmPerPx = 0.25;
  // `z = 8` cuts the patch across its whole width: the fixture's world z spans 2.25 … 13.98, and 8
  // is inside every column's range, so the intersection is a full-width polyline and not a corner.
  const state = await axialSurface(page, 8, mmPerPx);

  // (1) The §7.4 surface defaults, read back off the layer the engine actually built.
  expect(state.fill, 'a surface has no tets, so nothing to fill').toBe(false);
  expect(state.widthPx).toBe(1.5);
  expect(state.contourColor?.slice(0, 3)).toEqual([1, 0.9, 0.15]);

  // (2) The expected positions, from `contourSegments` — this file's own plane-triangle code.
  const segs = contourSegments([0, 0, 1], -8);
  expect(segs.length, 'the plane crosses the patch').toBeGreaterThan(4);

  // Midpoints, so the sample is on the *interior* of a segment rather than at a joint where two
  // segments' caps overlap and the covered pixel is ambiguous by half a width.
  const img = await paneImage(page);
  let hits = 0;
  for (const [a, b] of segs) {
    const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const [x, y] = axialPixel(mid, mmPerPx);
    // A 1.5 px line through a computed point covers the pixel it passes through, but *which* of
    // the two pixels either side of a sub-pixel centre is a rounding question, not a geometry one.
    // `r = 1` is that ambiguity and nothing more: at 0.25 mm/px a wrong answer misses by tens of px.
    if (yellowNear(img, x, y, 1) > 0) hits += 1;
  }
  expect(hits, `${hits}/${segs.length} computed segment midpoints have a contour pixel`).toBe(
    segs.length
  );

  // (3) Off the surface entirely — 300 px above the patch's top edge is background, so "yellow
  // somewhere" is not what the assertion above is measuring.
  await expectPixel(page, CX, 40, BG);
  expect(errors).toEqual([]);
});

test('hiding the layer removes the contour, and showing it puts it back @angle', async ({
  page,
}) => {
  // Three full-pane readbacks at ~10.5 s apiece on a loaded SwiftShader CI runner put this test
  // just past the default 30 s (measured off the 2026-08-30 ubuntu run's trace: setup → first
  // image 10.6 s, hide → second image 10.5 s; the third readback hit the limit — the same
  // arithmetic behind PR #5's one-off timeout here). The assertions are cheap, the readbacks are
  // not, so the budget is tripled rather than an assertion dropped.
  test.slow();
  const errors = await openScene(page);
  const mmPerPx = 0.25;
  const { layerId } = await axialSurface(page, 8, mmPerPx);

  const segs = contourSegments([0, 0, 1], -8);
  const first = segs[0] as [[number, number, number], [number, number, number]];
  const mid: [number, number, number] = [
    (first[0][0] + first[1][0]) / 2,
    (first[0][1] + first[1][1]) / 2,
    (first[0][2] + first[1][2]) / 2,
  ];
  const [x, y] = axialPixel(mid, mmPerPx);
  expect(yellowNear(await paneImage(page), x, y, 1)).toBeGreaterThan(0);

  await page.evaluate(async (id) => {
    window.__tvxEngine!.updateLayer(id as string, { visible: false });
    await window.__tvxEngine!.whenSettled();
  }, layerId);
  // A wider box than the positive assertion used: "gone" has to mean gone from the neighbourhood,
  // not merely from the one pixel the line happened to cover.
  expect(yellowNear(await paneImage(page), x, y, 3)).toBe(0);
  await expectPixel(page, x, y, BG);

  await page.evaluate(async (id) => {
    window.__tvxEngine!.updateLayer(id as string, { visible: true });
    await window.__tvxEngine!.whenSettled();
  }, layerId);
  expect(yellowNear(await paneImage(page), x, y, 1)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

// -----------------------------------------------------------------------------------------------
// 4 — constant screen width under zoom, and the contour follows the cursor
// -----------------------------------------------------------------------------------------------

test('the contour keeps its screen width when the zoom changes by an order of magnitude @angle', async ({
  page,
}) => {
  const errors = await openScene(page);
  const mmPerPx = 0.25;
  await axialSurface(page, 8, mmPerPx);

  /**
   * The segment that runs **straight up the pane**, and its midpoint.
   *
   * At `z = 8` the patch's contour has a leg at constant world x (the plane clears a whole column
   * of the grid at once), which projects to a vertical line whatever the zoom. Measuring a
   * horizontal run across a vertical line is the width itself, with no slope correction — which is
   * what makes the two numbers below comparable rather than merely similar.
   */
  const vertical = contourSegments([0, 0, 1], -8).reduce((best, seg) => {
    const span = (t: [[number, number, number], [number, number, number]]): number =>
      Math.abs(t[0][1] - t[1][1]) - Math.abs(t[0][0] - t[1][0]);
    return span(seg) > span(best) ? seg : best;
  });
  expect(Math.abs(vertical[0][0] - vertical[1][0]), 'the leg is vertical in world x').toBeLessThan(
    1e-3
  );
  const mid: [number, number, number] = [vertical[0][0], (vertical[0][1] + vertical[1][1]) / 2, 8];

  /** The contiguous run of contour pixels along the row through `(x, y)`, searched ±20 px. */
  const rowRun = async (scale: number): Promise<number> => {
    const img = await paneImage(page);
    const [x, y] = axialPixel(mid, scale);
    let n = 0;
    for (let dx = -20; dx <= 20; dx += 1) if (isYellow(img, x + dx, y)) n += 1;
    return n;
  };

  const wide = await rowRun(mmPerPx);
  expect(wide, 'the contour crosses the sampled row').toBeGreaterThan(0);

  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.025 } });
    await engine.whenSettled();
  });
  const zoomed = await rowRun(0.025);

  // A constant-**world**-width line would be ten times thicker here; §7.0.6's expansion makes it
  // the same. One pixel of tolerance is the sub-pixel position of the line's centre, nothing more.
  expect(
    Math.abs(zoomed - wide),
    `${wide} px at 0.25 mm/px, ${zoomed} px at 0.025 mm/px`
  ).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('the contour follows the cursor as the slice sweeps, latest-wins @angle', async ({ page }) => {
  const errors = await openScene(page);
  const mmPerPx = 0.25;
  await axialSurface(page, 8, mmPerPx);

  // Twenty steps without awaiting each: R4's "sweeping never queues" — the pane's cut key is
  // re-pointed, not enqueued — so what settles must be the contour of the **last** plane, not of
  // some plane in the middle of the sweep.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    for (let i = 0; i < 20; i += 1) engine.setCursor([0, 0, 4 + i * 0.3]);
    await engine.whenSettled();
  });

  const segs = contourSegments([0, 0, 1], -(4 + 19 * 0.3));
  expect(segs.length).toBeGreaterThan(4);
  const img = await paneImage(page);
  let hits = 0;
  for (const [a, b] of segs) {
    const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0];
    const [x, y] = axialPixel(mid, mmPerPx);
    if (yellowNear(img, x, y, 1) > 0) hits += 1;
  }
  expect(hits, 'the settled contour is the final plane, not one from the sweep').toBe(segs.length);
  expect(errors).toEqual([]);
});

// -----------------------------------------------------------------------------------------------
// The pick — clicking a contour selects its layer
// -----------------------------------------------------------------------------------------------

test('clicking on a contour makes that surface the active layer @angle', async ({ page }) => {
  const errors = await openScene(page);
  const mmPerPx = 0.25;
  const { layerId } = await axialSurface(page, 8, mmPerPx);

  const segs = contourSegments([0, 0, 1], -8);
  const seg = segs[Math.floor(segs.length / 2)] as [
    [number, number, number],
    [number, number, number],
  ];
  const mid: [number, number, number] = [
    (seg[0][0] + seg[1][0]) / 2,
    (seg[0][1] + seg[1][1]) / 2,
    8,
  ];
  const [x, y] = axialPixel(mid, mmPerPx);

  const onLine = await page.evaluate(
    ([px, py]) => window.__tvxEngine!.contourAtScreen('axial', px as number, py as number),
    [x, y] as const
  );
  expect(onLine).toBe(layerId);

  // 200 px away from any contour is a miss — the test would be vacuous if everything were a hit.
  const offLine = await page.evaluate(() => window.__tvxEngine!.contourAtScreen('axial', 20, 20));
  expect(offLine).toBeNull();

  // And the gesture R1 binds — a plain left-click — selects it, on top of setting the cursor.
  const active = await page.evaluate(
    ([px, py]) => {
      const engine = window.__tvxEngine!;
      engine.setActiveLayer(null);
      engine.setCursorFromScreen('axial', px as number, py as number);
      return engine.scene.activeLayerId;
    },
    [x, y] as const
  );
  expect(active).toBe(layerId);
  expect(errors).toEqual([]);
});

// -----------------------------------------------------------------------------------------------
// The golden
// -----------------------------------------------------------------------------------------------

test('golden: derived-surface-contours-2x2', async ({ page }) => {
  const errors = await openScene(page);
  await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url as string });
    engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
    // The Freeview arrangement the brief names: the outline on all three 2D panes, the surface
    // itself in 3D. The cursor is inside the patch on all three axes so no pane is empty.
    engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
    engine.setCursor([2.5, -4, 8]);
    for (const id of ['axial', 'coronal', 'sagittal']) {
      engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.25 } });
    }
    await engine.whenSettled();
  }, SURFACE);
  await expectGolden(page, 'derived-surface-contours-2x2');
  expect(errors).toEqual([]);
});
