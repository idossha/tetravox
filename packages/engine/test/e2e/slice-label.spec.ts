/**
 * §7.3's label path and **R5's gate assertions**, as frame algebra.
 *
 * R5 asks for three things to be provable: *hiding a label removes its colour from the pane pixels
 * while others are unchanged*, *recolouring changes exactly those pixels to the new colour*, and
 * *solo leaves only the chosen label*. Every one of them is a statement about a **set of pixels**,
 * so the tests here render the whole pane and compare it byte for byte rather than sampling — a
 * sample grid can miss the pixel that moved, and "others are unchanged" is exactly the clause a
 * sample grid cannot check.
 *
 * The set under test is defined by the *first* frame: `target` is every pixel painted in the label's
 * own LUT colour. Everything after that is "the changed set equals `target`", which is an equality,
 * not a tolerance. That works because `visibleLabels`, `labelOpacity` and a recolour are all folded
 * into the `N × 1` palette (`layers/volume.ts`) — one texel of one texture changes and the shader
 * has no branch to take, so byte-identical elsewhere is the *mechanism*, not a hope.
 *
 * Two pixel sets are excluded, and both are excluded by **measurement** rather than by a guess:
 *
 * * **Chrome.** §8's RAD/NEU badge is `Annotations.conventionBadge: true`, "not optional", so it is
 *   in every frame and is not background. The frame drawn *before the layer is added* names those
 *   pixels exactly.
 * * **Outside the volume's own AABB**, for the outline coverage clause only — see the second test.
 *
 * Ground truth for the colours and the affine is `testdata/manifest.json`, written by nibabel and by
 * the authored LUT expectation; nothing here is read back out of the engine.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGolden } from '../helpers/pixels';
import {
  LABEL_OUTLINE_DARKEN,
  LABEL_SELECT_COLOR,
  LABEL_SELECT_WIDTH_SCALE,
} from '../../src/render/passes/slice';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const manifest = JSON.parse(readFileSync(`${REPO}testdata/manifest.json`, 'utf8')) as {
  sidecars: Record<string, { expected: { id: number; name: string; rgba255: number[] }[] }>;
};

const VOL = 'labels_simnibs.nii.gz';
const LUT = 'labels_simnibs_LUT.txt';
const PANE = 768;
/** 0.02 mm/px: the fixture is a ~9 × 10 × 8 mm box, so each voxel is a large block on screen. */
const MM_PER_PX = 0.02;

/** The label this file mutes, recolours and solos. `3` = CSF, `rgb(104, 163, 255)`. */
const TARGET_ID = 3;

const LUT_ENTRIES = manifest.sidecars[LUT]!.expected;
const ALL_IDS = LUT_ENTRIES.map((e) => e.id);
const TARGET_RGB = LUT_ENTRIES.find((e) => e.id === TARGET_ID)!.rgba255.slice(0, 3);
/** A colour no LUT entry has, so "became the new colour" cannot be satisfied by accident. */
const NEW_RGB = [255, 0, 255];

/** An opaque stand-in for id 0 ("Unknown", `A = 0`), used to measure the volume's footprint. */
const FOOTPRINT_RGB = [0, 255, 0];

/**
 * Everything one scenario reports back. Counts only — a 2.4 MB framebuffer never crosses the
 * Playwright boundary, and every clause of R5 is a count once the sets are compared in the page.
 */
interface R5Report {
  paneBytes: number;
  /** §8's badge and any other chrome: non-background before the layer exists. */
  chrome: number;
  /** Pixels painted in `TARGET_ID`'s LUT colour in the baseline frame. */
  target: number;
  /** Pixels painted in some *other* label's colour, i.e. the "others" R5 says must not change. */
  others: number;
  hide: {
    changed: number;
    changedOutsideTarget: number;
    targetUnchanged: number;
    nowBackground: number;
  };
  recolour: { changed: number; changedOutsideTarget: number; targetIsNewColour: number };
  solo: { nonBackground: number; nonBackgroundOutsideTarget: number };
  opacity: { changed: number; changedOutsideTarget: number; targetIsBlend: number };
  select: { changed: number; changedOutsideTarget: number; rimIsEmphasis: number };
}

async function openAtlas(page: Page): Promise<{ report: R5Report; errors: string[] }> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const report = await page.evaluate(
    async ([url, lutUrl, mmPerPx, pane, targetId, targetRgb, newRgb, allIds, selectColor]) => {
      // `setLabelColor` / `setSelectedLabels` are `TetravoxEngine` members, not §4.7 `Engine` ones —
      // `VolumeLayer` has no field for a label colour or a selection, and §12.3 closes
      // `scene/types.ts` to everyone but W-WASM. Filed with the integrator; the cast is the test
      // harness's, not the app's.
      const engine = window.__tvxEngine! as typeof window.__tvxEngine & {
        setLabelColor(
          layerId: string,
          labelId: number,
          color: [number, number, number, number]
        ): boolean;
        setSelectedLabels(layerId: string, ids: number[]): void;
      };
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const grab = (): Uint8Array => {
        engine.renderNow();
        const px = new Uint8Array(P * P * 4);
        gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const settle = async (): Promise<Uint8Array> => {
        await engine.whenSettled();
        return grab();
      };

      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });

      const bg = engine.scene.background.map((c) => Math.round(c * 255));
      const n = P * P;
      const rgbAt = (f: Uint8Array, i: number): [number, number, number] => [
        f[i * 4] ?? 0,
        f[i * 4 + 1] ?? 0,
        f[i * 4 + 2] ?? 0,
      ];
      const same = (a: [number, number, number], b: number[]): boolean =>
        a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

      // §8's RAD/NEU badge is not optional, so it is in every frame and is not background. The frame
      // before the layer exists names its pixels exactly — no guess about where the glyphs land.
      const empty = await settle();
      const isChrome = new Uint8Array(n);
      let chrome = 0;
      for (let i = 0; i < n; i += 1) {
        if (!same(rgbAt(empty, i), bg)) {
          isChrome[i] = 1;
          chrome += 1;
        }
      }

      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      const base = await settle();

      // The two sets R5 talks about, taken from the baseline frame alone.
      const isTarget = new Uint8Array(n);
      let target = 0;
      let others = 0;
      for (let i = 0; i < n; i += 1) {
        if (isChrome[i] === 1) continue;
        const c = rgbAt(base, i);
        if (same(c, targetRgb as number[])) {
          isTarget[i] = 1;
          target += 1;
        } else if (!same(c, bg)) {
          others += 1;
        }
      }

      /** Which pixels differ from the baseline, split by whether they are in `target`. */
      const diff = (f: Uint8Array): { changed: number; changedOutsideTarget: number } => {
        let changed = 0;
        let changedOutsideTarget = 0;
        for (let i = 0; i < n; i += 1) {
          if (isChrome[i] === 1) continue;
          const a = rgbAt(base, i);
          const b = rgbAt(f, i);
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
          changed += 1;
          if (isTarget[i] !== 1) changedOutsideTarget += 1;
        }
        return { changed, changedOutsideTarget };
      };

      // --- hide -------------------------------------------------------------------------------
      engine.updateLayer(layer.id, {
        visibleLabels: Uint32Array.from((allIds as number[]).filter((v) => v !== targetId)),
      });
      const hidden = await settle();
      let targetUnchanged = 0;
      let nowBackground = 0;
      for (let i = 0; i < n; i += 1) {
        if (isTarget[i] !== 1) continue;
        const b = rgbAt(hidden, i);
        if (same(b, targetRgb as number[])) targetUnchanged += 1;
        if (same(b, bg)) nowBackground += 1;
      }
      const hide = { ...diff(hidden), targetUnchanged, nowBackground };

      // --- recolour ---------------------------------------------------------------------------
      engine.updateLayer(layer.id, { visibleLabels: undefined });
      const nrgb = newRgb as number[];
      engine.setLabelColor(layer.id, targetId as number, [
        (nrgb[0] ?? 0) / 255,
        (nrgb[1] ?? 0) / 255,
        (nrgb[2] ?? 0) / 255,
        1,
      ]);
      const recoloured = await settle();
      let targetIsNewColour = 0;
      for (let i = 0; i < n; i += 1) {
        if (isTarget[i] === 1 && same(rgbAt(recoloured, i), nrgb)) targetIsNewColour += 1;
      }
      const recolour = { ...diff(recoloured), targetIsNewColour };
      // Put the LUT colour back before the remaining scenarios.
      const trgb = targetRgb as number[];
      engine.setLabelColor(layer.id, targetId as number, [
        (trgb[0] ?? 0) / 255,
        (trgb[1] ?? 0) / 255,
        (trgb[2] ?? 0) / 255,
        1,
      ]);
      await engine.whenSettled();

      // --- solo (Alt-click: mute all others) --------------------------------------------------
      engine.updateLayer(layer.id, { visibleLabels: Uint32Array.from([targetId as number]) });
      const soloed = await settle();
      let nonBackground = 0;
      let nonBackgroundOutsideTarget = 0;
      for (let i = 0; i < n; i += 1) {
        if (isChrome[i] === 1) continue;
        if (same(rgbAt(soloed, i), bg)) continue;
        nonBackground += 1;
        if (isTarget[i] !== 1) nonBackgroundOutsideTarget += 1;
      }
      const solo = { nonBackground, nonBackgroundOutsideTarget };

      // --- per-label opacity ------------------------------------------------------------------
      engine.updateLayer(layer.id, {
        visibleLabels: undefined,
        labelOpacity: { [targetId as number]: 0.5 },
      });
      const muted = await settle();
      // The palette carries `round(255 · 0.5) = 128`, so the blend the frame does is 128/255.
      const blend = [0, 1, 2].map((c) =>
        Math.round((trgb[c] ?? 0) * (128 / 255) + (bg[c] ?? 0) * (1 - 128 / 255))
      );
      let targetIsBlend = 0;
      for (let i = 0; i < n; i += 1) {
        if (isTarget[i] !== 1) continue;
        const b = rgbAt(muted, i);
        if (Math.abs(b[0] - (blend[0] ?? 0)) <= 1 && Math.abs(b[1] - (blend[1] ?? 0)) <= 1) {
          targetIsBlend += 1;
        }
      }
      const opacity = { ...diff(muted), targetIsBlend };

      // --- selection emphasis (R5's "outline emphasis in the panes") --------------------------
      engine.updateLayer(layer.id, { labelOpacity: undefined });
      await engine.whenSettled();
      engine.setSelectedLabels(layer.id, [targetId as number]);
      const selected = await settle();
      const sc = (selectColor as number[]).map((c) => Math.round(c * 255));
      let rimIsEmphasis = 0;
      for (let i = 0; i < n; i += 1) {
        if (isTarget[i] !== 1) continue;
        if (same(rgbAt(selected, i), sc)) rimIsEmphasis += 1;
      }
      const select = { ...diff(selected), rimIsEmphasis };
      engine.setSelectedLabels(layer.id, []);
      await engine.whenSettled();

      return {
        paneBytes: base.length,
        chrome,
        target,
        others,
        hide,
        recolour,
        solo,
        opacity,
        select,
      };
    },
    [
      fixture(VOL),
      fixture(LUT),
      MM_PER_PX,
      PANE,
      TARGET_ID,
      TARGET_RGB,
      NEW_RGB,
      ALL_IDS,
      LABEL_SELECT_COLOR,
    ] as const
  );

  return { report, errors: pageErrors };
}

test('R5: hide, recolour, solo, mute and select, asserted over every pixel of the pane', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { report, errors } = await openAtlas(page);
  expect(errors).toEqual([]);
  expect(report.paneBytes).toBe(PANE * PANE * 4);

  // The premise: the label is on screen, and so are others for "unchanged" to mean anything.
  expect(report.target, 'pixels painted in the target label’s colour').toBeGreaterThan(2000);
  expect(report.others, 'pixels painted in some other label’s colour').toBeGreaterThan(2000);
  // …and the excluded set is the badge, not half the pane.
  expect(report.chrome, '§8’s badge is drawn and is not optional').toBeGreaterThan(0);
  expect(report.chrome).toBeLessThan(PANE * PANE * 0.01);

  // --- hide: "those pixels change, others byte-identical" -----------------------------------
  expect(report.hide.changed, 'hiding changed nothing').toBeGreaterThan(0);
  expect(report.hide.changedOutsideTarget, 'a pixel outside the label changed').toBe(0);
  expect(report.hide.changed).toBe(report.target);
  expect(report.hide.targetUnchanged, 'the label’s colour survived being hidden').toBe(0);
  expect(report.hide.nowBackground, 'every hidden pixel is the scene background').toBe(
    report.target
  );

  // --- recolour: "exactly those pixels become the new colour" -------------------------------
  expect(report.recolour.changed).toBe(report.target);
  expect(report.recolour.changedOutsideTarget).toBe(0);
  expect(report.recolour.targetIsNewColour).toBe(report.target);

  // --- solo: "only the chosen label" --------------------------------------------------------
  expect(report.solo.nonBackground).toBe(report.target);
  expect(report.solo.nonBackgroundOutsideTarget).toBe(0);

  // --- labelOpacity -------------------------------------------------------------------------
  expect(report.opacity.changed).toBe(report.target);
  expect(report.opacity.changedOutsideTarget).toBe(0);
  expect(report.opacity.targetIsBlend).toBe(report.target);

  // --- selection emphasis: a rim on the selected label, nothing else touched ----------------
  expect(report.select.changed, 'selecting drew no rim').toBeGreaterThan(0);
  expect(report.select.changedOutsideTarget, 'selection touched another label').toBe(0);
  expect(report.select.rimIsEmphasis).toBe(report.select.changed);
  // A rim, not a repaint: most of the label's interior keeps its own colour.
  expect(report.select.changed).toBeLessThan(report.target * 0.9);
});

// -------------------------------------------------------------------------------------------
// fill / outline / both
// -------------------------------------------------------------------------------------------

test('labelMode: outline keeps the fill’s boundary and discards its interior; both darkens it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const r = await page.evaluate(
    async ([url, lutUrl, mmPerPx, pane, darken, widthPx, footprintRgb]) => {
      const engine = window.__tvxEngine! as typeof window.__tvxEngine & {
        setLabelColor(
          layerId: string,
          labelId: number,
          color: [number, number, number, number]
        ): boolean;
      };
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
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });

      const bg = engine.scene.background.map((c) => Math.round(c * 255));
      const n = P * P;
      const rgbAt = (f: Uint8Array, i: number): [number, number, number] => [
        f[i * 4] ?? 0,
        f[i * 4 + 1] ?? 0,
        f[i * 4 + 2] ?? 0,
      ];
      const isBg = (c: [number, number, number]): boolean =>
        c[0] === bg[0] && c[1] === bg[1] && c[2] === bg[2];

      // §8's RAD/NEU badge is not optional, so it is in every frame; the frame before the layer
      // exists names its pixels, and they are excluded from every set below.
      await engine.whenSettled();
      const empty = grab();
      const isChrome = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) isChrome[i] = isBg(rgbAt(empty, i)) ? 0 : 1;

      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.updateLayer(layer.id, { outlineWidthPx: widthPx as number });
      await engine.whenSettled();

      // **The volume's footprint, measured rather than re-derived.** §7.3's outline taps are
      // `clamp(tc, 0, 1)`, so a tap that leaves the box reads the edge voxel and finds the same
      // label: the volume's outer silhouette is by construction not an outline, and is therefore
      // not part of the boundary set the coverage clause is about.
      //
      // Which pane pixels are inside the box is found by giving id 0 ("Unknown", `A = 0` in the
      // LUT) an opaque colour for one frame: every in-box fragment then paints, so the painted set
      // **is** the footprint, to the pixel. Re-deriving it from the manifest's affine instead
      // reproduces the pane→world mapping to within a fraction of a pixel and leaves a one-pixel
      // rind of silhouette in the boundary set — which is the AABB edge wearing a disguise.
      const fp = footprintRgb as number[];
      engine.setLabelColor(layer.id, 0, [
        (fp[0] ?? 0) / 255,
        (fp[1] ?? 0) / 255,
        (fp[2] ?? 0) / 255,
        1,
      ]);
      await engine.whenSettled();
      const footprint = grab();
      const inside = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        inside[i] = isChrome[i] === 1 || isBg(rgbAt(footprint, i)) ? 0 : 1;
      }
      engine.setLabelColor(layer.id, 0, [0, 0, 0, 0]);
      await engine.whenSettled();

      engine.updateLayer(layer.id, { labelMode: 'fill' });
      await engine.whenSettled();
      const fill = grab();
      engine.updateLayer(layer.id, { labelMode: 'outline' });
      await engine.whenSettled();
      const outline = grab();
      engine.updateLayer(layer.id, { labelMode: 'both' });
      await engine.whenSettled();
      const both = grab();

      // The fill's own boundary, inside the box: a painted pixel with an in-box 4-neighbour of a
      // different colour — a different label, or a label the LUT gives `A = 0` ("Unknown"), which
      // is the atlas boundary an outline exists to draw.
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
      let outlineOffBoundary = 0;
      let boundaryCovered = 0;
      let outlineWrongColour = 0;
      for (let i = 0; i < n; i += 1) {
        if (isChrome[i] === 1) continue;
        const o = rgbAt(outline, i);
        if (isBg(o)) continue;
        outlinePainted += 1;
        if (boundary[i] === 1) boundaryCovered += 1;
        else outlineOffBoundary += 1;
        // An outline fragment is painted the label's OWN colour, which is the fill's colour there.
        const f = rgbAt(fill, i);
        if (o[0] !== f[0] || o[1] !== f[1] || o[2] !== f[2]) outlineWrongColour += 1;
      }

      // `both`: the fill everywhere, with the boundary multiplied by `darken`.
      let bothInteriorIsFill = 0;
      let bothInterior = 0;
      let bothRimIsDarkened = 0;
      let bothRim = 0;
      const k = darken as number;
      for (let i = 0; i < n; i += 1) {
        if (isChrome[i] === 1) continue;
        const f = rgbAt(fill, i);
        if (isBg(f)) continue;
        const b = rgbAt(both, i);
        const isRim = !isBg(rgbAt(outline, i));
        if (isRim) {
          bothRim += 1;
          const want = [0, 1, 2].map((c) => Math.round((f[c] ?? 0) * k));
          if (Math.abs(b[0] - (want[0] ?? 0)) <= 1 && Math.abs(b[1] - (want[1] ?? 0)) <= 1) {
            bothRimIsDarkened += 1;
          }
        } else {
          bothInterior += 1;
          if (b[0] === f[0] && b[1] === f[1] && b[2] === f[2]) bothInteriorIsFill += 1;
        }
      }

      return {
        fillPainted,
        boundaryCount,
        outlinePainted,
        outlineOffBoundary,
        boundaryCovered,
        outlineWrongColour,
        bothRim,
        bothRimIsDarkened,
        bothInterior,
        bothInteriorIsFill,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture(VOL), fixture(LUT), MM_PER_PX, PANE, LABEL_OUTLINE_DARKEN, 2, FOOTPRINT_RGB] as const
  );

  expect(pageErrors).toEqual([]);
  expect(r.errors).toEqual([]);
  expect(r.fillPainted).toBeGreaterThan(10_000);
  expect(r.boundaryCount).toBeGreaterThan(500);

  // `outline` draws the boundary and discards the interior: far fewer pixels than the fill.
  expect(r.outlinePainted).toBeGreaterThan(0);
  expect(r.outlinePainted).toBeLessThan(r.fillPainted * 0.5);
  // ...in the label's own colour, everywhere.
  expect(r.outlineWrongColour).toBe(0);
  // §11's coverage clause: the outline covers ≥ 99 % of the fill's boundary.
  expect(r.boundaryCovered / r.boundaryCount).toBeGreaterThanOrEqual(0.99);
  // The band is wider than one pixel, so it necessarily spills off the boundary set itself.
  expect(r.outlineOffBoundary).toBeGreaterThan(0);

  // `both` is the fill plus a darkened rim — it must differ from `fill`, or the mode is a no-op.
  expect(r.bothInterior).toBeGreaterThan(1000);
  expect(r.bothInteriorIsFill).toBe(r.bothInterior);
  expect(r.bothRim).toBeGreaterThan(500);
  expect(r.bothRimIsDarkened / r.bothRim).toBeGreaterThan(0.99);
});

test('the selection rim is wider than the plain outline, by its own factor', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const r = await page.evaluate(
    async ([url, lutUrl, mmPerPx, pane, targetId, selectColor]) => {
      const engine = window.__tvxEngine! as typeof window.__tvxEngine & {
        setSelectedLabels(layerId: string, ids: number[]): void;
      };
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const count = (match: (c: [number, number, number]) => boolean): number => {
        engine.renderNow();
        const px = new Uint8Array(P * P * 4);
        gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let k = 0;
        for (let i = 0; i < P * P; i += 1) {
          if (match([px[i * 4] ?? 0, px[i * 4 + 1] ?? 0, px[i * 4 + 2] ?? 0])) k += 1;
        }
        return k;
      };
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.updateLayer(layer.id, { labelMode: 'fill', outlineWidthPx: 2 });
      engine.setSelectedLabels(layer.id, [targetId as number]);
      await engine.whenSettled();
      const sc = (selectColor as number[]).map((c) => Math.round(c * 255));
      const isEmphasis = (c: [number, number, number]): boolean =>
        c[0] === sc[0] && c[1] === sc[1] && c[2] === sc[2];
      const narrow = count(isEmphasis);
      engine.updateLayer(layer.id, { outlineWidthPx: 4 });
      await engine.whenSettled();
      const wide = count(isEmphasis);
      return { narrow, wide };
    },
    [fixture(VOL), fixture(LUT), MM_PER_PX, PANE, TARGET_ID, LABEL_SELECT_COLOR] as const
  );
  expect(r.narrow).toBeGreaterThan(100);
  // The rim is `outlineWidthPx · LABEL_SELECT_WIDTH_SCALE` wide, so doubling the knob widens it.
  expect(r.wide).toBeGreaterThan(r.narrow * 1.5);
  expect(LABEL_SELECT_WIDTH_SCALE).toBeGreaterThan(1);
});

/**
 * The `slice-label-outline` golden: `outline` mode with one label selected.
 *
 * It carries §8's 2D chrome (letters, corner info, RAD/NEU badge) and **no colour bar**, because a
 * label volume does not get one — §8 gives it the region panel instead, and `volumeColorbarSpec`
 * returns `null` for it. The scalar layers' bars are in `slice-colorbar` and in the ernie goldens.
 */
test('label outline golden', async ({ page }) => {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([url, lutUrl, mmPerPx, targetId]) => {
      const engine = window.__tvxEngine! as typeof window.__tvxEngine & {
        setSelectedLabels(layerId: string, ids: number[]): void;
      };
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.updateLayer(layer.id, { labelMode: 'outline', outlineWidthPx: 2 });
      engine.setSelectedLabels(layer.id, [targetId as number]);
      engine.setAnnotations({ colorbars: true });
      await engine.whenSettled();
    },
    [fixture(VOL), fixture(LUT), MM_PER_PX, TARGET_ID] as const
  );
  await expectGolden(page, 'slice-label-outline');
});
