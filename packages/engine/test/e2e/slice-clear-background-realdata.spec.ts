/**
 * §4.4's `clearBackground` on ernie's `T1.nii.gz` — the file that motivated it: float32, 50.3 % of
 * its voxels exactly 0 (`python3 -c` over nibabel, 2026-11-02), drawn as a black box inside the
 * pane background before this field existed.
 *
 * Its minimum is −41.8, from 0.1 % ringing voxels: the background is the zero **plateau**, not the
 * minimum, which is the case `backgroundLevel` exists for.
 *
 * Gated on `TETRAVOX_TESTDATA`. The value at every asserted pixel comes from `Engine.probe`; nearest
 * sampling makes the pixel's voxel the probe's voxel. The `gray` LUT paints r = g = b, and the pane
 * background is not grey, so "cleared" and "painted" are told apart without a colour model.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readCanvasPixels } from '../helpers/pixels';
import type { Rgba } from '../helpers/pixels';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const T1 = 'm2m_ernie/T1.nii.gz';
const PANE = 768;
/** 0.37 mm: with the centre on a voxel edge, `0.37·k − 141.895` is never a whole number of mm. */
const MM_PER_PX = 0.37;

test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');

interface Opened {
  layerId: string;
  clearBackground: unknown;
  cursor: [number, number, number];
  background: Rgba;
  min: number;
}

async function openT1(page: Page, norm16: boolean): Promise<Opened> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/test/pages/scene.html${norm16 ? '' : '?norm16=0'}`);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const r = await page.evaluate(
    async ([url, mmPerPx]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      const seeded = (engine.scene.layers[0] as { clearBackground?: unknown }).clearBackground;
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      // A quarter voxel off the centre **slice**: 256 is even, so the centre is a voxel boundary and
      // the probe and the fragment could each take a different slice. In-plane the cursor stays put
      // (`camera.center` is relative to it) and `MM_PER_PX` keeps pixel centres off voxel edges.
      const c = engine.scene.cursor;
      engine.setCursor([c[0], c[1], c[2] + 0.25]);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.updateLayer(layer.id, { interpolation: 'nearest' });
      await engine.whenSettled();
      return {
        layerId: layer.id,
        clearBackground: seeded ?? null,
        cursor: engine.scene.cursor as [number, number, number],
        background: engine.scene.background.map((c) => Math.round(c * 255)),
        min: 'stats' in ds ? ds.stats.min : NaN,
        errors: window.__tvxErrors ?? [],
      };
    },
    [`/@fs${ROOT}/${T1}`, MM_PER_PX] as const
  );
  expect(errors).toEqual([]);
  expect(r.errors).toEqual([]);
  const bg = r.background;
  return { ...r, background: [bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0, 255] };
}

async function grid(
  page: Page,
  cursor: [number, number, number]
): Promise<{ pt: [number, number]; value: number | undefined; px: Rgba }[]> {
  const pts: [number, number][] = [];
  // Inset from the edges: §8's RAD/NEU badge is drawn in the top-right corner whatever the annotations.
  for (let y = 40; y < PANE - 40; y += 17)
    for (let x = 40; x < PANE - 40; x += 17) pts.push([x, y]);
  const worlds = pts.map(([x, y]): [number, number, number] => [
    cursor[0] + (x + 0.5 - PANE / 2) * MM_PER_PX,
    cursor[1] + (PANE - 1 - y + 0.5 - PANE / 2) * MM_PER_PX,
    cursor[2],
  ]);
  const values = await page.evaluate(
    (ws) =>
      (ws as [number, number, number][]).map((w) => {
        const row = window.__tvxEngine!.probe(w).rows[0];
        return typeof row?.value === 'number' ? row.value : null;
      }),
    worlds
  );
  const px = await readCanvasPixels(page, pts);
  return pts.map((pt, i) => ({ pt, value: values[i] ?? undefined, px: px[i] ?? [0, 0, 0, 0] }));
}

const isBg = (px: Rgba, bg: Rgba): boolean => px[0] === bg[0] && px[1] === bg[1] && px[2] === bg[2];
const isGrey = (px: Rgba): boolean => px[0] === px[1] && px[1] === px[2];

for (const norm16 of [true, false]) {
  test(`@angle T1.nii.gz opens with its zero padding cleared (norm16 ${norm16})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const t1 = await openT1(page, norm16);
    // The minimum is NOT the background: 0.1 % ringing voxels reach −41.8 below the zero plateau.
    expect(t1.min, 'T1.nii.gz has a few negative voxels').toBeLessThan(-40);
    expect(t1.clearBackground, 'a 50 % zero plateau ⇒ on by default').toEqual({ enabled: true });
    expect(isGrey(t1.background), 'the pane background is not a grey the LUT can paint').toBe(
      false
    );

    let cleared = 0;
    let painted = 0;
    for (const { pt, value, px } of await grid(page, t1.cursor)) {
      if (value === undefined || value <= 0) {
        expect(isBg(px, t1.background), `(${pt}) v=${value} is background, got ${px}`).toBe(true);
        if (value !== undefined) cleared += 1;
      } else if (value > 1.5) {
        // (0, 1.5] is left unasserted: the default cut is one fine histogram bin (~1.0) above the
        // plateau's reported lower edge, plus half an R16 code (~0.5) — `slice-clear.test.ts` pins it.
        expect(isGrey(px), `v=${value} is painted grey, got ${px.join(',')}`).toBe(true);
        painted += 1;
      }
    }
    expect(cleared, 'zero voxels inside the FOV').toBeGreaterThan(200);
    expect(painted, 'head voxels').toBeGreaterThan(200);

    // Off: the same zero voxels are the colormap's black again — the box the user reported.
    await page.evaluate(async (id) => {
      const engine = window.__tvxEngine!;
      engine.updateLayer(id, { clearBackground: { enabled: false } });
      await engine.whenSettled();
    }, t1.layerId);
    let black = 0;
    for (const { value, px } of await grid(page, t1.cursor)) {
      if (value === 0) {
        expect(isGrey(px), `v=0 is painted once nothing is cleared, got ${px.join(',')}`).toBe(
          true
        );
        black += 1;
      }
    }
    expect(black).toBeGreaterThan(200);
  });
}
