/**
 * §7.3's completion **on ernie** — the two §11 tests this owner owes, the heat scale's analytic
 * pixel test on real data, the 2×2 golden with colour bars, and §9.1 row 14.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2). CI leaves it unset by
 * design, so everything here is reproducible only on a machine with the reference dataset.
 *
 * The files, and why each one:
 *
 * * `m2m_ernie/T1.nii.gz` — float32 with a physical max of **exactly 65535.0**, the base every
 *   overlay sits on.
 * * `Simulations/Thalamus/TI/niftis/Thalamus_TI_subject_TI_max.nii.gz` — a **continuous scalar**
 *   (0 … 3.152071), so it takes the colormap-and-blend path §11's compositing row is about. It is
 *   also the file the heat scale is worth having for.
 * * `m2m_ernie/segmentation/labeling.nii.gz` — a **float32 label volume with 57 integral unique
 *   values**. An `is_label` heuristic that requires an integer dtype misclassifies the atlas the app
 *   is meant to browse, and then none of the label path below is exercised at all.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectGolden } from '../helpers/pixels';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const fsUrl = (rel: string): string => `/@fs${ROOT}/${rel}`;

const T1 = 'm2m_ernie/T1.nii.gz';
const THALAMUS_TI = 'Simulations/Thalamus/TI/niftis/Thalamus_TI_subject_TI_max.nii.gz';
const LABELING = 'm2m_ernie/segmentation/labeling.nii.gz';
const LABELING_LUT = 'm2m_ernie/segmentation/labeling_LUT.txt';

const PANE = 768;

/** The heat scale used on `TI_max` throughout, chosen so every branch of §4.2's ramp is exercised. */
const HEAT = {
  kind: 'heat' as const,
  min: 0.5,
  mid: 1.5,
  max: 3.0,
  truncate: false,
  inverse: false,
  negative: 'hide' as const,
};

test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

// -------------------------------------------------------------------------------------------
// §11 — Label outline zoom
// -------------------------------------------------------------------------------------------

/**
 * §11's named **Label outline zoom** test.
 *
 * `labeling.nii.gz` in `outline` mode at 0.05, 1.0 and 5.0 mm/px: measured thickness in
 * **[0.8, 2.9] px** and ≥ 99 % coverage of the fill boundary at each. The point of the row is that
 * §7.3's step is **screen-relative** — `0.5 · outlineWidthPx · duv`, where `duv` is the texture-space
 * extent of one screen pixel — so the band is a constant screen width at any zoom. The rejected
 * voxel-space step (`inPlaneVoxelAxis · max(1, outlineWidthPx · pxInVoxels)`) yields a **12.87 px**
 * band at 0.05 mm/px, which blows the upper bound on the first row of the table.
 *
 * **Thickness is measured, not assumed.** For a band of perpendicular width `w` along a boundary of
 * length `L`, the outline covers `w · L` pixels while the fill's own 4-connected boundary set covers
 * one pixel on each side, i.e. `2 · L`. So `w = 2 · outlinePixels / boundaryPixels`, which needs no
 * assumption about the boundary's shape and degrades gracefully where it curves.
 */
test('§11 label outline zoom: constant screen-width outlines at 0.05, 1.0 and 5.0 mm/px', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);

  const r = await page.evaluate(
    async ([url, lutUrl, t1, pane, zooms, widthPx]) => {
      const engine = window.__tvxEngine!;
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const grab = (): Uint8Array => {
        engine.renderNow();
        const px = new Uint8Array(P * P * 4);
        gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();

      const bg = engine.scene.background.map((c) => Math.round(c * 255));
      const n = P * P;
      const rgbAt = (f: Uint8Array, i: number): [number, number, number] => [
        f[i * 4] ?? 0,
        f[i * 4 + 1] ?? 0,
        f[i * 4 + 2] ?? 0,
      ];
      const isBg = (c: [number, number, number]): boolean =>
        c[0] === bg[0] && c[1] === bg[1] && c[2] === bg[2];

      // §8's badge is not optional; the frame before the layer exists names its pixels.
      const empty = grab();
      const isChrome = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) isChrome[i] = isBg(rgbAt(empty, i)) ? 0 : 1;

      // **The volume's footprint, per zoom, measured rather than re-derived.** §7.3's outline taps
      // are `clamp(tc, 0, 1)`, so a tap that leaves the box reads the edge voxel and finds the same
      // label: where the head is cut off by the FOV — the neck, and the back of the skull on this
      // subject — the atlas touches the box edge and that silhouette is by construction not an
      // outline. `T1.nii.gz` shares this file's grid and affine to four decimals `[DATA]`, and any
      // linear window paints its whole box opaque, so a T1-only frame *is* the footprint. It is
      // removed again before a single measurement is taken.
      const t1ds = await engine.addDataset({ kind: 'path', path: t1 as string });
      const t1layer = engine.addLayer({ datasetId: t1ds.id, kind: 'volume' });

      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.updateLayer(layer.id, { outlineWidthPx: widthPx as number, visible: false });

      const out: {
        mmPerPx: number;
        fillPainted: number;
        boundary: number;
        outline: number;
        covered: number;
        thicknessPx: number;
        coverage: number;
      }[] = [];

      for (const mmPerPx of zooms as readonly number[]) {
        engine.setView('axial', { camera: { center: [0, 0], mmPerPx } });
        engine.updateLayer(t1layer.id, { visible: true });
        engine.updateLayer(layer.id, { visible: false });
        await engine.whenSettled();
        const box = grab();
        const inside = new Uint8Array(n);
        for (let i = 0; i < n; i += 1) {
          inside[i] = isChrome[i] === 1 || isBg(rgbAt(box, i)) ? 0 : 1;
        }
        engine.updateLayer(t1layer.id, { visible: false });
        engine.updateLayer(layer.id, { visible: true, labelMode: 'fill' });
        await engine.whenSettled();
        const fill = grab();
        engine.updateLayer(layer.id, { labelMode: 'outline' });
        await engine.whenSettled();
        const outline = grab();

        const boundary = new Uint8Array(n);
        let boundaryCount = 0;
        let fillPainted = 0;
        for (let y = 1; y < P - 1; y += 1) {
          for (let x = 1; x < P - 1; x += 1) {
            const i = y * P + x;
            if (inside[i] !== 1) continue;
            const c = rgbAt(fill, i);
            if (isBg(c)) continue;
            fillPainted += 1;
            for (const j of [i - 1, i + 1, i - P, i + P]) {
              if (inside[j] !== 1) continue;
              const e = rgbAt(fill, j);
              if (e[0] !== c[0] || e[1] !== c[1] || e[2] !== c[2]) {
                boundary[i] = 1;
                boundaryCount += 1;
                break;
              }
            }
          }
        }
        let outlinePainted = 0;
        let covered = 0;
        for (let i = 0; i < n; i += 1) {
          if (isChrome[i] === 1) continue;
          if (isBg(rgbAt(outline, i))) continue;
          outlinePainted += 1;
          if (boundary[i] === 1) covered += 1;
        }
        out.push({
          mmPerPx,
          fillPainted,
          boundary: boundaryCount,
          outline: outlinePainted,
          covered,
          thicknessPx: boundaryCount > 0 ? (2 * outlinePainted) / boundaryCount : 0,
          coverage: boundaryCount > 0 ? covered / boundaryCount : 0,
        });
      }

      return {
        isLabel: 'isLabel' in ds ? ds.isLabel : null,
        dtype: 'dtype' in ds ? ds.dtype : null,
        uniqueLabels: 'labelIds' in ds ? (ds.labelIds?.length ?? 0) : 0,
        rows: out,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(LABELING), fsUrl(LABELING_LUT), fsUrl(T1), PANE, [0.05, 1.0, 5.0], 2] as const
  );

  expect(errors).toEqual([]);
  expect(r.errors).toEqual([]);
  // AGENTS.md: a **float32** label volume with 57 integral unique values. If `is_label` required an
  // integer dtype this would be a grey ramp and every row below would be measuring nothing.
  expect(r.dtype).toBe('f32');
  expect(r.isLabel).toBe(true);
  expect(r.uniqueLabels).toBe(57);

  for (const row of r.rows) {
    const where = `${row.mmPerPx} mm/px`;
    expect(row.fillPainted, `${where}: the atlas must be on screen`).toBeGreaterThan(1000);
    expect(row.boundary, `${where}: the fill must have a boundary`).toBeGreaterThan(100);
    expect(row.thicknessPx, `${where}: outline thickness`).toBeGreaterThanOrEqual(0.8);
    expect(row.thicknessPx, `${where}: outline thickness`).toBeLessThanOrEqual(2.9);
    expect(row.coverage, `${where}: fill-boundary coverage`).toBeGreaterThanOrEqual(0.99);
  }
  console.log(
    `[§11 label outline zoom] ${r.rows
      .map(
        (x) =>
          `${x.mmPerPx} mm/px: ${x.thicknessPx.toFixed(2)} px, ` +
          `${(x.coverage * 100).toFixed(1)}% of ${x.boundary}`
      )
      .join(' | ')}`
  );
  test.info().annotations.push({ type: 'bench', description: JSON.stringify(r.rows) });
});

// -------------------------------------------------------------------------------------------
// §11 — Overlay compositing in 3D (`showIn3D`)
// -------------------------------------------------------------------------------------------

/**
 * §11's named **Overlay compositing in 3D** test — the Phase-2 variant of Phase 1's row.
 *
 * The same pair (`Thalamus_TI_subject_TI_max.nii.gz` over `T1.nii.gz`) on an **oblique** plane in
 * the **3D** view, with `VolumeLayer.showIn3D`, asserting the same exact-100 % count under
 * `depthFunc(LEQUAL)`. This is the variant that pins §7.3's shared-plane-geometry rule: two coplanar
 * quads with different vertex data do not produce identical interpolated depth (1.6–11.8 % overlay
 * dropout `[M2Max]`), and in 3D — unlike 2D, where the whole pass runs depth-off — that dropout is
 * visible immediately.
 *
 * "Exactly 100 %" is asserted as **independence over every pixel of the pane**: at opacity 1 the
 * composite must not move by one byte when the base is hidden or re-windowed, while each of those
 * changes the base visibly on its own.
 */
test('§11 overlay compositing in 3D: TI_max over T1 on an oblique showIn3D plane', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);
  const n = 1 / Math.sqrt(3);

  const r = await page.evaluate(
    async ([t1, ti, k, pane]) => {
      const engine = window.__tvxEngine!;
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const grab = (): Uint8Array => {
        engine.renderNow();
        const px = new Uint8Array(P * P * 4);
        gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const diff = (a: Uint8Array, b: Uint8Array): number => {
        let d = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) d += 1;
        }
        return d;
      };

      const base = await engine.addDataset({ kind: 'path', path: t1 as string });
      const baseLayer = engine.addLayer({ datasetId: base.id, kind: 'volume' });
      // The oblique plane §11 names, carried into the 3D pane by `showIn3D`.
      engine.setView('axial', {
        mode: 'oblique',
        normal: [k as number, k as number, k as number],
        up: [0, 0, 1],
      });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.updateLayer(baseLayer.id, { showIn3D: true });
      engine.resetView('view3d');
      await engine.whenSettled();
      const baseOnly = grab();

      const scale0 = (
        engine.scene.layers[0] as { scale: { kind: 'linear'; lo: number; hi: number } }
      ).scale;
      const scale1 = {
        kind: 'linear' as const,
        lo: scale0.lo,
        hi: scale0.lo + (scale0.hi - scale0.lo) * 3,
      };
      engine.updateLayer(baseLayer.id, { scale: scale1 });
      await engine.whenSettled();
      const baseRewindowed = grab();
      engine.updateLayer(baseLayer.id, { scale: scale0 });
      await engine.whenSettled();

      const over = await engine.addDataset({ kind: 'path', path: ti as string });
      const overLayer = engine.addLayer({ datasetId: over.id, kind: 'volume' });
      engine.updateLayer(overLayer.id, { showIn3D: true, opacity: 1 });
      await engine.whenSettled();
      const composited = grab();

      engine.updateLayer(baseLayer.id, { scale: scale1 });
      await engine.whenSettled();
      const compositedRewindowed = grab();
      engine.updateLayer(baseLayer.id, { scale: scale0, visible: false });
      await engine.whenSettled();
      const compositedNoBase = grab();
      engine.updateLayer(baseLayer.id, { visible: true });
      await engine.whenSettled();

      const bg = engine.scene.background.map((c) => Math.round(c * 255));
      let footprint = 0;
      for (let i = 0; i < composited.length; i += 4) {
        if (composited[i] !== bg[0] || composited[i + 1] !== bg[1] || composited[i + 2] !== bg[2]) {
          footprint += 1;
        }
      }

      return {
        pixels: P * P,
        footprint,
        controlRewindow: diff(baseOnly, baseRewindowed),
        controlOverlayCovers: diff(baseOnly, composited),
        leakRewindow: diff(composited, compositedRewindowed),
        leakHidden: diff(composited, compositedNoBase),
        overIsLabel: 'isLabel' in over ? over.isLabel : null,
        overMax: 'stats' in over ? over.stats.max : null,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(T1), fsUrl(THALAMUS_TI), n, PANE] as const
  );

  expect(errors).toEqual([]);
  expect(r.errors).toEqual([]);
  // A continuous scalar, not a label volume: the colormap path, and AGENTS.md's max for this file.
  expect(r.overIsLabel).toBe(false);
  expect(r.overMax).toBeCloseTo(3.152071, 5);

  expect(r.controlRewindow, 're-windowing the base must visibly change it').toBeGreaterThan(
    r.pixels * 0.02
  );
  expect(r.controlOverlayCovers, 'the overlay must change a real part of the view').toBeGreaterThan(
    r.pixels * 0.01
  );
  expect(r.footprint, 'the planes must cover a real part of the pane').toBeGreaterThan(
    r.pixels * 0.05
  );
  expect(r.leakRewindow, 'a base re-window must not reach through an opaque overlay in 3D').toBe(0);
  expect(r.leakHidden, 'nor must hiding the base entirely').toBe(0);

  // The measurement above needs the chrome out of the way; §11 needs it **in** the golden — "every
  // golden includes the §8 2D chrome … and, from Phase 2, the colour bars". So it goes back on for
  // the capture, which is a different frame from the ones the counts were taken on.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({
      orientationLabels: true,
      cornerInfo: true,
      crosshair: true,
      colorbars: true,
    });
    await engine.whenSettled();
  });
  await expectGolden(page, 'slice-showin3d-composite');
});

// -------------------------------------------------------------------------------------------
// The heat scale, analytically, on ernie
// -------------------------------------------------------------------------------------------

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** §4.2's heat ramp on `|v|`: `min → 0`, `mid → 0.5`, `max → 1`. */
function heatPosition(v: number): number {
  const a = Math.abs(v);
  if (a <= HEAT.min) return 0;
  if (a <= HEAT.mid) return (0.5 * (a - HEAT.min)) / (HEAT.mid - HEAT.min);
  if (a <= HEAT.max) return 0.5 + (0.5 * (a - HEAT.mid)) / (HEAT.max - HEAT.mid);
  return 1;
}

/**
 * What §7.3's fragment paints for `v` under {@link HEAT} and `cool`, before blending.
 *
 * `cool` is a two-stop map, `[0,255,255] → [255,0,255]`, so the expected channels are
 * `round(255 · t)`, `round(255 · (1 − t))`, `255` — no table to transcribe. A `heat` scale bakes
 * over `[−max, max]` in 256 texels at their centres, and the shader fetches `NEAREST`, so the value
 * the fragment shows is the one its texel was baked for.
 */
function heatRgba(v: number): [number, number, number, number] {
  const i = Math.min(255, Math.floor(clamp01((v + HEAT.max) / (2 * HEAT.max)) * 256));
  const tv = -HEAT.max + ((i + 0.5) / 256) * (2 * HEAT.max);
  if (Math.abs(tv) < HEAT.min) return [0, 0, 0, 0];
  if (tv < 0) return [0, 0, 0, 0]; // negative: 'hide'
  const t = heatPosition(tv);
  return [Math.round(255 * t), Math.round(255 * (1 - t)), 255, 255];
}

test('heat on TI_max over T1: every opaque overlay pixel is LUT(value), every other is the base', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);

  const r = await page.evaluate(
    async ([t1, ti, pane, mmPerPx, heat]) => {
      const engine = window.__tvxEngine!;
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const grab = (): Uint8Array => {
        engine.renderNow();
        const px = new Uint8Array(P * P * 4);
        gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };

      const base = await engine.addDataset({ kind: 'path', path: t1 as string });
      engine.addLayer({ datasetId: base.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
      const baseOnly = grab();

      const over = await engine.addDataset({ kind: 'path', path: ti as string });
      const overLayer = engine.addLayer({ datasetId: over.id, kind: 'volume' });
      engine.updateLayer(overLayer.id, {
        colormap: 'cool',
        scale: heat as never,
        interpolation: 'nearest',
        opacity: 1,
      });
      await engine.whenSettled();
      const composited = grab();

      // A grid over the pane, with the overlay's value at each point read through `probe` — the
      // retained typed array (§4.3), a different path from the texture the fragment sampled.
      const cur = engine.scene.cursor;
      const pts: [number, number][] = [];
      for (let y = 12; y < P; y += 9) for (let x = 12; x < P; x += 9) pts.push([x, y]);
      const rows = pts.map(([x, y]) => {
        // `readPixels` is bottom-left origin, and so is the world mapping below; `pts` are in the
        // same frame, so the framebuffer index is `y · P + x` with no flip anywhere. Mixing the two
        // conventions here reads the pixel from the mirrored row and every assertion becomes a
        // comparison of two unrelated points.
        const world: [number, number, number] = [
          cur[0]! + (x + 0.5 - P / 2) * (mmPerPx as number),
          cur[1]! + (y + 0.5 - P / 2) * (mmPerPx as number),
          cur[2]!,
        ];
        const probe = engine.probe(world).rows;
        const v = probe[1]?.value;
        const i = y * P + x;
        return {
          x,
          y,
          value: typeof v === 'number' ? v : null,
          px: [composited[i * 4] ?? 0, composited[i * 4 + 1] ?? 0, composited[i * 4 + 2] ?? 0] as [
            number,
            number,
            number,
          ],
          basePx: [baseOnly[i * 4] ?? 0, baseOnly[i * 4 + 1] ?? 0, baseOnly[i * 4 + 2] ?? 0] as [
            number,
            number,
            number,
          ],
        };
      });
      return {
        overFormat: 'gpu' in over ? over.gpu.format : '',
        rows,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(T1), fsUrl(THALAMUS_TI), PANE, 0.2, HEAT] as const
  );

  expect(errors).toEqual([]);
  expect(r.errors).toEqual([]);

  let opaque = 0;
  let dead = 0;
  for (const row of r.rows) {
    if (row.value === null) continue; // outside the overlay's own AABB
    const want = heatRgba(row.value);
    const label = `(${row.x},${row.y}) v=${row.value}`;
    if (want[3] === 0) {
      dead += 1;
      // Below `min`, a heat scale contributes nothing — that is what makes it an overlay, and the
      // pixel must be exactly what the base painted there.
      expect(row.px, `${label}: below min, the base must show through unchanged`).toEqual(
        row.basePx
      );
      continue;
    }
    opaque += 1;
    for (let c = 0; c < 3; c += 1) {
      expect(
        Math.abs((row.px[c] ?? 0) - (want[c] ?? 0)),
        `${label}: channel ${c} expected ${want[c]}, got ${row.px.join(',')}`
      ).toBeLessThanOrEqual(1);
    }
  }
  // The scale has to exercise both branches, or the test is asserting nothing.
  expect(opaque, 'pixels above the heat scale’s min').toBeGreaterThan(50);
  expect(dead, 'pixels below it, where the base shows through').toBeGreaterThan(50);
});

// -------------------------------------------------------------------------------------------
// The 2×2 golden, and §9.1 row 14
// -------------------------------------------------------------------------------------------

/** T1 + `TI_max` (heat) + `labeling.nii.gz` (outline), in the 2×2 layout, with the colour bars. */
async function buildErnieScene(page: Page, mmPerPx: number | null): Promise<void> {
  await page.evaluate(
    async ([t1, ti, lab, lut, heat, mm]) => {
      const engine = window.__tvxEngine!;
      const base = await engine.addDataset({ kind: 'path', path: t1 as string });
      const baseLayer = engine.addLayer({ datasetId: base.id, kind: 'volume' });
      // `showIn3D` on both scalar layers, so the 3D pane of the 2×2 golden carries §7.3's planes
      // and the compositing rule is pinned by this golden as well as by the one above.
      engine.updateLayer(baseLayer.id, { name: 'T1', showIn3D: true });

      const over = await engine.addDataset({ kind: 'path', path: ti as string });
      const overLayer = engine.addLayer({ datasetId: over.id, kind: 'volume' });
      engine.updateLayer(overLayer.id, {
        name: 'TI MAX',
        colormap: 'cool',
        scale: heat as never,
        opacity: 1,
        showIn3D: true,
      });

      const atlas = await engine.addDataset({
        kind: 'path',
        path: lab as string,
        sidecars: { lut: lut as string },
      });
      const atlasLayer = engine.addLayer({ datasetId: atlas.id, kind: 'volume' });
      engine.updateLayer(atlasLayer.id, {
        name: 'LABELING',
        labelMode: 'outline',
        outlineWidthPx: 2,
      });

      engine.setAnnotations({ colorbars: true });
      if (mm !== null) {
        engine.setLayout({ kind: '1x1', cells: ['axial'] });
        engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mm as number } });
      }
      await engine.whenSettled();
    },
    [fsUrl(T1), fsUrl(THALAMUS_TI), fsUrl(LABELING), fsUrl(LABELING_LUT), HEAT, mmPerPx] as const
  );
}

test('the ernie 2×2 golden: T1 + TI_max (heat) + labeling outlines, with colour bars', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);
  await buildErnieScene(page, null);
  expect(errors).toEqual([]);
  await expectGolden(page, 'slice-ernie-2x2');
});

/**
 * §9.1 row 14 — *"Slice scrub, T1 + 2 overlays + label outlines: 60 fps at full quality"*, whose
 * evidence column reads "3-layer composite 1.04 ms, 4-tap outline 1.10 ms `[M2Max]`".
 *
 * Timed **inside the page** around `renderNow()`, at full quality, with the same three layers the
 * row names, scrubbing 20 slices. The number is reported whether or not it passes the 8 ms budget,
 * because §9's rule is that a `[TARGET]` row gets a measured figure rather than an assertion.
 */
test('§9.1 row 14: slice scrub with T1 + TI_max + label outlines', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);
  await buildErnieScene(page, 0.5);

  const r = await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    const frames: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      engine.stepCursor('axial', 1);
      const t0 = performance.now();
      engine.renderNow();
      frames.push(performance.now() - t0);
    }
    frames.sort((a, b) => a - b);
    return {
      median: frames[Math.floor(frames.length / 2)] ?? 0,
      p95: frames[Math.floor(frames.length * 0.95)] ?? 0,
      max: frames[frames.length - 1] ?? 0,
      layers: engine.scene.layers.length,
    };
  });

  expect(errors).toEqual([]);
  expect(r.layers).toBe(3);
  console.log(
    `[bench] §9.1 row 14 slice scrub (T1 + TI_max heat + labeling outline, 768² 1x1, DPR 1): ` +
      `median ${r.median.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, max ${r.max.toFixed(2)} ms`
  );
  test.info().annotations.push({ type: 'bench', description: JSON.stringify(r) });
});
