/**
 * TI-Toolbox's ROI overlay (`roi_overlay.msh` + `.msh.opt`), opened **bare**, on an axial pane
 * through the ROI (2026-09-18). Real data, so it skips without `TETRAVOX_TESTDATA` or without
 * the analysis directory under it.
 *
 * What one open of the bare mesh must give, end to end: the `.msh.opt`'s `Visible = 1` view seeds
 * `colorMode:'overlay'` on `TI_max_ROI` (the surface form of `'field'`) with a `hide` gate just above zero (`scene/defaults.ts`),
 * the gate keeps the field where it is non-zero (`render/passes/mesh.ts`), and the 2D outline is
 * the scalar-coloured one (`derived/store.ts`, `shaders/contour.ts`). The field is zero outside
 * the ROI by construction, so on a slice the outline exists **only** inside the ROI's bounding box
 * and its pixels are colormap colours, never the solid-outline default.
 */

import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { readCanvasRect } from '../helpers/pixels';

/**
 * The sample: `TETRAVOX_ROI_OVERLAY` names a `roi_overlay.msh` directly (any subject's analysis
 * directory), else the one under `TETRAVOX_TESTDATA`. The ROI's bounding box and cursor come from
 * the `scene.tetravox.json` TI-Toolbox writes beside it (`meta.framing.regions[0]`), so the test
 * does not carry one subject's numbers.
 */
const root = process.env.TETRAVOX_TESTDATA;
const ANALYSIS = 'Simulations/L_Insula/Analyses/Mesh/cortical_lh.insula_DK40';
const MSH =
  process.env.TETRAVOX_ROI_OVERLAY ??
  (root === undefined ? undefined : `${root}/${ANALYSIS}/roi_overlay.msh`);

const PANE = 768;
const BG = [10, 13, 18] as const;
/** `SURFACE_CONTOUR_PALETTE[0]`, the solid default, as bytes. */
const YELLOW = [255, 230, 38] as const;
const MM_PER_PX = 0.3;

interface Region {
  bbox: { min: [number, number, number]; max: [number, number, number] };
  cursor: [number, number, number];
}

function regionOf(mshPath: string): Region | null {
  const scenePath = mshPath.replace(/roi_overlay\.msh$/, 'scene.tetravox.json');
  if (!existsSync(scenePath)) return null;
  const scene = JSON.parse(readFileSync(scenePath, 'utf8')) as {
    meta?: { framing?: { regions?: { bbox_ras: number[][]; cursor_ras: number[] }[] } };
  };
  const r = scene.meta?.framing?.regions?.[0];
  if (r === undefined) return null;
  return {
    bbox: {
      min: r.bbox_ras[0] as [number, number, number],
      max: r.bbox_ras[1] as [number, number, number],
    },
    cursor: r.cursor_ras as [number, number, number],
  };
}

test('@angle a bare roi_overlay.msh shows a colormap-coloured outline inside the ROI only', async ({
  page,
}) => {
  test.skip(MSH === undefined, 'TETRAVOX_TESTDATA and TETRAVOX_ROI_OVERLAY are unset');
  test.skip(MSH !== undefined && !existsSync(MSH), `${MSH} is not present`);
  const region = MSH === undefined ? null : regionOf(MSH);
  test.skip(region === null, 'no scene.tetravox.json with a framed region beside the mesh');
  if (region === null) return;
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => !!window.__tvxEngine);
  const state = await page.evaluate(
    async ([path, cursor, mmPerPx]) => {
      const e = window.__tvxEngine!;
      const ds = await e.addDataset({
        kind: 'path',
        path: path as string,
        sidecars: { opt: `${path as string}.opt` },
      });
      if (ds.kind !== 'mesh') throw Error('mesh required');
      // R1: a triangle-only mesh opens as a surface — the kind the app gives a bare `.msh` sheet.
      const l = e.addLayer({ kind: 'surface', datasetId: ds.id });
      e.setLayout({ kind: '1x1', cells: ['axial'] });
      e.setCursor(cursor as [number, number, number]);
      e.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      e.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      for (let i = 0; i < 60; i += 1) {
        await e.whenSettled();
        await new Promise((r) => setTimeout(r, 50));
      }
      await e.whenSettled();
      const layer = e.scene.layers.find((x) => x.id === l.id) as {
        colorMode: string;
        overlay?: { name: string };
        colormap: string;
        threshold: { lo: number; hi: number; mode: string };
        contoursIn2D: boolean;
      };
      const b = ds.bounds;
      return {
        nTets: ds.nTets,
        fields: ds.fields.map((f) => `${f.source}:${f.name}`),
        colorMode: layer.colorMode,
        field: layer.overlay?.name,
        colormap: layer.colormap,
        threshold: layer.threshold,
        contoursIn2D: layer.contoursIn2D,
        anchor: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2],
      };
    },
    [`/@fs${MSH}`, region.cursor, MM_PER_PX] as const
  );

  // The seed, as the file dictates it.
  expect(state.nTets).toBe(0);
  expect(state.fields).toEqual(['node:TI_max_ROI', 'node:TI_normal_ROI']);
  expect(state.colorMode).toBe('overlay');
  expect(state.field).toBe('TI_max_ROI');
  expect(state.colormap).toBe('turbo');
  expect(state.threshold.mode).toBe('hide');
  expect(state.threshold.hi === null || state.threshold.hi === Infinity).toBe(true);
  expect(state.contoursIn2D).toBe(true);

  // The ROI's bounding box in pane pixels (axial: right = +X, up = +Y, about the bounds centre).
  const toPx = (x: number, y: number): [number, number] => [
    Math.round(PANE / 2 + (x - state.anchor[0]!) / MM_PER_PX),
    Math.round(PANE / 2 - (y - state.anchor[1]!) / MM_PER_PX),
  ];
  const [x0, y1] = toPx(region.bbox.min[0], region.bbox.min[1]);
  const [x1, y0] = toPx(region.bbox.max[0], region.bbox.max[1]);
  const MARGIN = 6; // px: the line's own half-width, caps and the box's rounding

  const img = await readCanvasRect(page, 0, 0, PANE, PANE);
  const inside: string[] = [];
  let outside = 0;
  let yellow = 0;
  for (let y = 0; y < PANE; y += 1) {
    for (let x = 0; x < PANE; x += 1) {
      const i = (y * PANE + x) * 4;
      const c = [img[i] ?? 0, img[i + 1] ?? 0, img[i + 2] ?? 0];
      if ([0, 1, 2].every((k) => Math.abs(c[k]! - BG[k]!) <= 2)) continue;
      // The pane's own chrome (the convention badge) lives in the top-right corner.
      if (y < 16 && x > PANE - 40) continue;
      if ([0, 1, 2].every((k) => Math.abs(c[k]! - YELLOW[k]!) <= 2)) yellow += 1;
      const inBox = x >= x0 - MARGIN && x <= x1 + MARGIN && y >= y0 - MARGIN && y <= y1 + MARGIN;
      if (inBox) inside.push(c.join(','));
      else outside += 1;
    }
  }
  const distinct = new Set(inside);
  console.log(
    `[roi-overlay] box x ${x0}..${x1} y ${y0}..${y1}; inside ${inside.length} px, ` +
      `${distinct.size} colours; outside ${outside}; yellow ${yellow}`
  );
  expect(inside.length, 'the outline exists inside the ROI').toBeGreaterThan(50);
  expect(distinct.size, 'it is a colormap, not one colour').toBeGreaterThan(8);
  expect(yellow, 'never the solid-outline default').toBe(0);
  expect(outside, 'nothing is drawn outside the ROI: the field is zero there and hidden').toBe(0);
  expect(errors).toEqual([]);
});
