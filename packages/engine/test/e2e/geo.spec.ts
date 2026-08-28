/**
 * Gmsh parsed post-processing views (`.geo` / `.pos`) — §11's analytic pixel assertions, plus the
 * real-data evidence (directed task 6).
 *
 * Rule 0: *an agent cannot judge a PNG; it can judge a number.* Every expected pixel below is
 * arithmetic on `testdata/view_electrodes.geo`'s literal coordinates and the pane camera, never a
 * recorded value — the fixture is 20 lines of ascii and its `SP(1, 2, 3){10};` is the point the
 * first test looks for.
 *
 * The axial camera: `right = +X`, `up = +Y`, pane centred on the cursor. At `mmPerPx = 0.1` a
 * point at world `(1, 2, ·)` with the cursor at `(0, 0, ·)` lands 10 px right of centre and 20 px
 * **up** the screen, which is 20 px lower in top-left canvas rows.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectPixel, readCanvasRect } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const VIEW_GEO = `/@fs${REPO}testdata/view_electrodes.geo`;
const SCRIPT_GEO = `/@fs${REPO}testdata/view_geometry_script.geo`;

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const fsUrl = (rel: string): string => `/@fs${ROOT}/${rel}`;

const PANE = 768;
const CX = PANE / 2;
const CY = PANE / 2;
/** `scene/defaults.ts`'s background, as bytes. */
const BG = [10, 13, 18, 255] as const;
const RED = [255, 0, 0, 255] as const;

/** mm per pane pixel, and therefore the whole projection. */
const MM_PER_PX = 0.1;
/** Big enough that the label anchor 5 mm above the electrode is inside the pane's slab. */
const RADIUS_MM = 6;

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/**
 * `testdata/view_electrodes.geo` in an axial pane, cursor at the fixture's `SP(1, 2, 3)`.
 *
 * The layer kind is named here because this fixture carries an `ST` and an `SQ` as well: a view
 * with triangles is a surface, and `defaultLayerFor` is right to say so. The *default* kind is
 * asserted separately, on the real electrode net, which has no triangles at all.
 */
async function axialFixture(
  page: Page
): Promise<{ layerId: string; kind: string; n: number; defaultKind: string }> {
  return await page.evaluate(
    async ([url, mmPerPx, radiusMm]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'points' });
      engine.updateLayer(layer.id, { color: [1, 0, 0, 1], radiusMm: radiusMm as number });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setCursor([0, 0, 3]);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
      const points = layer.kind === 'points' ? (layer.points?.length ?? 0) : 0;
      // What the dataset would have opened as with no kind named — the surface, for this fixture.
      const auto = engine.addLayer({ datasetId: ds.id, kind: undefined as never });
      engine.removeLayer(auto.id);
      return { layerId: layer.id, kind: layer.kind, n: points, defaultKind: auto.kind };
    },
    [VIEW_GEO, MM_PER_PX, RADIUS_MM] as const
  );
}

test('a parsed view’s point lands on the pixel the projection names', async ({ page }) => {
  const errors = await openScene(page);
  const opened = await axialFixture(page);

  // The fixture's first view is 2 `SP` plus a `VP`; the second view adds one more.
  expect(opened.kind).toBe('points');
  expect(opened.n).toBe(4);
  // …and because it also carries an `ST` and an `SQ`, its *default* layer is the surface.
  expect(opened.defaultKind).toBe('mesh');

  // `SP(1, 2, 3){10}` with the cursor at (0, 0, 3): 1 mm right, 2 mm up at 0.1 mm/px.
  const px = CX + 1 / MM_PER_PX;
  const py = CY - 2 / MM_PER_PX;
  await expectPixel(page, px, py, RED);
  // Still inside the 6 mm disc 4 mm out…
  await expectPixel(page, px + 4 / MM_PER_PX, py, RED);
  // …and outside it at 8 mm. (The fixture's other points are at z = 3, 0 and 9, all ≥ 5 mm away in
  // x or z, so nothing else can be covering this pixel.)
  await expectPixel(page, px + 8 / MM_PER_PX, py, BG);

  // `SP(9,9,9)` — the second view's point — is 6 mm off this plane, so its sphere does not reach it.
  await expectPixel(page, CX + 9 / MM_PER_PX, CY - 9 / MM_PER_PX, BG);
  expect(errors).toEqual([]);
});

/**
 * The label and its halo, in pixels.
 *
 * `T3(1, 2, 8, 0){"E001"}` sits 5 mm above `SP(1, 2, 3)`, so with a 6 mm radius it is inside the
 * pane's slab. It is drawn `radiusMm / mmPerPx` pixels above the anchor, centred, with the 1 px
 * dark halo `OverlayBuilder.labelWithHalo` gives every overlay string. So the box around that
 * position must contain **both** near-white glyph pixels and near-black halo pixels — and must
 * contain neither once labels are turned off.
 */
test('a label draws above its point, with a halo, and only while showLabels is on', async ({
  page,
}) => {
  const errors = await openScene(page);
  const { layerId } = await axialFixture(page);
  await page.evaluate(
    async ([id]) => {
      const engine = window.__tvxEngine!;
      // White text, so "glyph" and "halo" are the two extremes of the same box.
      engine.updateLayer(id as string, { showLabels: true, labelColor: [1, 1, 1, 1] });
      await engine.whenSettled();
    },
    [layerId] as const
  );

  const px = CX + 1 / MM_PER_PX;
  const py = CY - 2 / MM_PER_PX;
  const lift = RADIUS_MM / MM_PER_PX;
  // A box centred on the label's baseline position, generous enough to hold `E001` at any UI scale
  // and small enough that only the label can be in it (the nearest point is `lift` px below).
  const box = { x: px - 40, y: py - lift - 4, w: 80, h: 20 };

  const on = await readCanvasRect(page, box.x, box.y, box.w, box.h);
  const bright = countWhere(on, (r, g, b) => r > 200 && g > 200 && b > 200);
  const halo = countWhere(on, (r, g, b) => r < 40 && g < 40 && b < 40 && !isBg(r, g, b));
  expect(bright, 'the label’s glyph pixels').toBeGreaterThan(0);
  expect(halo, 'the halo around them').toBeGreaterThan(0);

  await page.evaluate(
    async ([id]) => {
      const engine = window.__tvxEngine!;
      engine.updateLayer(id as string, { showLabels: false });
      await engine.whenSettled();
    },
    [layerId] as const
  );
  const off = await readCanvasRect(page, box.x, box.y, box.w, box.h);
  expect(countWhere(off, (r, g, b) => r > 200 && g > 200 && b > 200)).toBe(0);
  expect(errors).toEqual([]);
});

/**
 * The 2D slab: a 187-electrode net projected whole onto one axial slice is an unreadable smear of
 * names belonging to slices 80 mm away, so a 2D pane draws only the labels near its plane.
 */
test('a 2D pane hides the labels of points that are not near its slice', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await axialFixture(page);
  const px = CX + 1 / MM_PER_PX;
  const py = CY - 2 / MM_PER_PX;
  const lift = RADIUS_MM / MM_PER_PX;
  const box = { x: px - 40, y: py - lift - 4, w: 80, h: 20 };

  await page.evaluate(
    async ([id]) => {
      const engine = window.__tvxEngine!;
      engine.updateLayer(id as string, { showLabels: true, labelColor: [1, 1, 1, 1] });
      await engine.whenSettled();
    },
    [layerId] as const
  );
  expect(
    countWhere(
      await readCanvasRect(page, box.x, box.y, box.w, box.h),
      (r, g, b) => r > 200 && g > 200 && b > 200
    )
  ).toBeGreaterThan(0);

  // Step the cursor 20 mm off the plane. The anchor is now far outside the slab; nothing is drawn.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setCursor([0, 0, 40]);
    await engine.whenSettled();
  });
  expect(
    countWhere(
      await readCanvasRect(page, box.x, box.y, box.w, box.h),
      (r, g, b) => r > 200 && g > 200 && b > 200
    )
  ).toBe(0);
  expect(errors).toEqual([]);
});

/**
 * A `.geo` that is a Gmsh geometry script must fail with the message that names the command, not
 * with `sniff`'s "unrecognised mesh format" and not with an empty layer that looks like a success.
 */
test('a geometry script is rejected by name', async ({ page }) => {
  await openScene(page);
  const message = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    try {
      await engine.addDataset({ kind: 'path', path: url as string });
      return 'no error';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, SCRIPT_GEO);
  expect(message).toContain('geometry script');
  expect(message).toContain('Point(');
});

// -------------------------------------------------------------------------------------------
// Real data — `m2m_ernie/eeg_positions/GSN-HydroCel-185.geo` on ernie
// -------------------------------------------------------------------------------------------

test.describe('real data', () => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');

  /**
   * 187 electrodes on ernie's scalp and on his T1 slices.
   *
   * The counts are `AGENTS.md`-grade: 187 `SP` + 187 `T3`, measured on the file with grep, and the
   * same numbers `crates/tvx-mesh-io/tests/real_data.rs` asserts. What this test adds is that they
   * survive the whole chain — worker, wire, layer, GPU — and that they land **on** the scalp: the
   * net's bounding box must sit inside `ernie.msh`'s, which it does not if the coordinates were
   * read component-major-wrong or a transform was applied that should not have been.
   */
  test('GSN-HydroCel-185 loads 187 named electrodes inside ernie’s bounding box', async ({
    page,
  }) => {
    const errors = await openScene(page);
    const got = await page.evaluate(
      async ([net]) => {
        const engine = window.__tvxEngine!;
        const ds = await engine.addDataset({ kind: 'path', path: net as string });
        const layer = engine.addLayer({ datasetId: ds.id, kind: undefined as never });
        await engine.whenSettled();
        const points = layer.kind === 'points' ? (layer.points ?? []) : [];
        return {
          kind: layer.kind,
          n: points.length,
          labels: layer.kind === 'points' ? (layer.labels?.length ?? 0) : 0,
          first: points[0]?.name,
          last: points[points.length - 1]?.name,
          bounds: ds.kind === 'mesh' ? ds.geo?.bounds : undefined,
        };
      },
      [fsUrl('m2m_ernie/eeg_positions/GSN-HydroCel-185.geo')] as const
    );

    expect(got.kind).toBe('points');
    expect(got.n).toBe(187);
    expect(got.labels).toBe(187);
    // One `T3` per `SP`, in order, so the names pair by index.
    expect(got.first).toBe('E001');
    expect(got.last).toBe('RPA');

    // `AGENTS.md`: ernie.msh spans (−84.44, −92.40, −128.86) … (83.40, 136.16, 99.95). A scalp net
    // is inside that, with the label anchors' 5 mm lift included.
    const b = got.bounds!;
    expect(b.min[0]).toBeGreaterThan(-84.44);
    expect(b.min[1]).toBeGreaterThan(-92.4);
    expect(b.max[0]).toBeLessThan(83.4);
    expect(b.max[1]).toBeLessThan(136.16);
    expect(b.max[2]).toBeLessThan(99.96 + 5);
    expect(errors).toEqual([]);
  });

  /**
   * The evidence a human looks at, written only when asked for — the same discipline §11 applies to
   * goldens (`TETRAVOX_SCREENSHOT_DIR`, as `packages/app/e2e/phase1-gate.spec.ts` uses it).
   * Nothing is asserted about the image; the assertions are the tests above it.
   */
  test('screenshots: the net on ernie’s scalp, and on a T1 slice', async ({ page }) => {
    const dir = process.env.TETRAVOX_SCREENSHOT_DIR;
    test.skip(dir === undefined || dir === '', 'TETRAVOX_SCREENSHOT_DIR is unset');
    const out = resolve(REPO, dir!);
    mkdirSync(out, { recursive: true });
    const errors = await openScene(page);

    await page.evaluate(
      async ([mesh, opt, net]) => {
        const engine = window.__tvxEngine!;
        const scalp = await engine.addDataset({
          kind: 'path',
          path: mesh as string,
          sidecars: { opt: opt as string },
        });
        const meshLayer = engine.addLayer({ datasetId: scalp.id, kind: 'mesh' });
        // Scalp only (tag 1005 / 5), translucent, so the electrodes on it are visible.
        const tagStyle: Record<number, { visible: boolean; opacity: number }> = {};
        for (const t of scalp.kind === 'mesh' ? scalp.tags : []) {
          tagStyle[t.id] = { visible: t.id === 1005 || t.id === 5, opacity: 0.85 };
        }
        engine.updateLayer(meshLayer.id, { tagStyle });

        const ds = await engine.addDataset({ kind: 'path', path: net as string });
        const points = engine.addLayer({ datasetId: ds.id, kind: undefined as never });
        engine.updateLayer(points.id, { radiusMm: 4, showLabels: true, labelScale: 1 });
        engine.setLayout({ kind: '1x1', cells: ['view3d'] });
        await engine.whenSettled();
        engine.renderNow();
      },
      [
        fsUrl('m2m_ernie/ernie.msh'),
        fsUrl('m2m_ernie/ernie.msh.opt'),
        fsUrl('m2m_ernie/eeg_positions/GSN-HydroCel-185.geo'),
      ] as const
    );
    await page.locator('canvas#gl').screenshot({ path: join(out, 'geo-electrodes.png') });

    // The 2D close-up: the same net over ernie's T1, zoomed to a handful of electrodes so the
    // markers and their names are both legible.
    await page.evaluate(
      async ([t1]) => {
        const engine = window.__tvxEngine!;
        const vol = await engine.addDataset({ kind: 'path', path: t1 as string });
        // Under everything: §4.4 orders layers bottom→top, and the T1 is the anatomy the
        // electrodes are being shown *on*.
        const t1Layer = engine.addLayer({ datasetId: vol.id, kind: 'volume' });
        engine.reorderLayers([
          t1Layer.id,
          ...engine.scene.layers.map((l) => l.id).filter((id) => id !== t1Layer.id),
        ]);
        engine.setLayout({ kind: '1x1', cells: ['axial'] });
        // An axial slice high enough to cross the electrode cap.
        engine.setCursor([0, 0, 70]);
        engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.28 } });
        await engine.whenSettled();
        engine.renderNow();
      },
      [fsUrl('m2m_ernie/T1.nii.gz')] as const
    );
    await page.locator('canvas#gl').screenshot({ path: join(out, 'geo-electrodes-2d.png') });
    expect(errors).toEqual([]);
  });
});

/** Count the pixels of a `readCanvasRect` buffer that satisfy `pred`. */
function countWhere(buf: Uint8Array, pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (pred(buf[i] ?? 0, buf[i + 1] ?? 0, buf[i + 2] ?? 0)) n += 1;
  }
  return n;
}

function isBg(r: number, g: number, b: number): boolean {
  return r === BG[0] && g === BG[1] && b === BG[2];
}
