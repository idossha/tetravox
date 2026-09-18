/**
 * §4.2's mesh value gate with **one open bound**, as pixels (2026-09-18).
 *
 * `threshold: {lo, hi: null, mode: 'hide'}` is "hide below `lo`, no upper bound" — the shape
 * TI-Toolbox writes for its ROI overlays. It used to hide the whole layer: the ramp floor was
 * `1e-6 · (F32_MAX − lo)`, and every value sat at the foot of the lower ramp
 * (`render/passes/mesh-threshold.test.ts` has the arithmetic). Here the same lattice
 * `mesh-gate.spec.ts` uses is gated at a `lo` between its two probes: on the front face
 * `node_scalar = −1 + 0.01·y + 0.001·z`, so the top probe (z = +9) reads −0.991 and the bottom
 * one (z = −9) reads −1.009. With `lo = −1` the top probe must still be the field colour and the
 * bottom one must be background — an expectation that needs no golden to be exact.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import {
  FACE_HALF_MM,
  facePixelToWorld,
  FRONT_FACE_CAMERA,
  isBackground,
  nodeScalarAt,
  PANE,
} from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const LATTICE = fixture('mesh_v2_binary.msh');
const LATTICE_LUT = fixture('mesh_v2_binary_LUT.txt');

const DZ = Math.round((9 / FACE_HALF_MM) * (PANE / 2));
const TOP: readonly [number, number] = [PANE / 2, PANE / 2 - DZ];
const BOTTOM: readonly [number, number] = [PANE / 2, PANE / 2 + DZ];

declare global {
  interface Window {
    __tvxOpenGateLayer?: string;
  }
}

async function openLattice(page: Page, patch: Record<string, unknown>): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([url, lutUrl, camera, p]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      window.__tvxOpenGateLayer = layer.id;
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.setView('view3d', { camera: camera as never });
      engine.updateLayer(layer.id, p as never);
      for (let i = 0; i < 40; i += 1) {
        await engine.whenSettled();
        await new Promise((r) => setTimeout(r, 25));
      }
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_LUT, FRONT_FACE_CAMERA, patch] as const
  );
  return errors;
}

const FIELD = {
  colorMode: 'field',
  field: { source: 'node', name: 'node_scalar', component: 'mag' },
  colormap: 'viridis',
  scale: { kind: 'linear', lo: -1.11, hi: 1.11 },
};

/** Apply a patch and settle until the geometry variant it needs has landed (see `mesh-gate.spec.ts`). */
async function patchAndSettle(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(window.__tvxOpenGateLayer!, p as never);
    for (let i = 0; i < 40; i += 1) {
      await engine.whenSettled();
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.whenSettled();
  }, patch);
}

function samePixel(a: readonly number[], b: readonly number[], tol = 2): boolean {
  return [0, 1, 2].every((c) => Math.abs((a[c] ?? 0) - (b[c] ?? 0)) <= tol);
}

/**
 * The gate removes a fragment, and `faceMode: 'both'` then shows whatever was behind it — the
 * lattice's inner walls, not the background — so "hidden" is asserted as "no longer the pixel the
 * ungated field painted", and "kept" as "still exactly that pixel". Before the fix both probes
 * changed, because the whole layer vanished.
 */
test('`hide` with `hi: null` keeps the values above `lo` and drops the ones below', async ({
  page,
}) => {
  const lo = -1;
  expect(nodeScalarAt(facePixelToWorld(TOP[0], TOP[1]))).toBeGreaterThan(lo);
  expect(nodeScalarAt(facePixelToWorld(BOTTOM[0], BOTTOM[1]))).toBeLessThan(lo);
  const errors = await openLattice(page, FIELD);
  const [top0, bottom0] = await readCanvasPixels(page, [TOP, BOTTOM]);
  expect(isBackground(top0!)).toBe(false);
  expect(isBackground(bottom0!)).toBe(false);
  await patchAndSettle(page, {
    threshold: { lo, hi: null, symmetric: false, mode: 'hide', softEdge: 0 },
  });
  const [top, bottom] = await readCanvasPixels(page, [TOP, BOTTOM]);
  console.log(
    `[mesh-threshold-open] top ${top0!.join(',')} -> ${top!.join(',')}; ` +
      `bottom ${bottom0!.join(',')} -> ${bottom!.join(',')}`
  );
  expect(samePixel(top!, top0!), 'above `lo`: the field pixel is kept').toBe(true);
  expect(samePixel(bottom!, bottom0!), 'below `lo`: the field pixel is gone').toBe(false);
  expect(errors).toEqual([]);
});

test('`hide` with `lo: null` is the mirror image', async ({ page }) => {
  const errors = await openLattice(page, FIELD);
  const [top0, bottom0] = await readCanvasPixels(page, [TOP, BOTTOM]);
  await patchAndSettle(page, {
    threshold: { lo: null, hi: -1, symmetric: false, mode: 'hide', softEdge: 0 },
  });
  const [top, bottom] = await readCanvasPixels(page, [TOP, BOTTOM]);
  expect(samePixel(top!, top0!), 'above `hi`: the field pixel is gone').toBe(false);
  expect(samePixel(bottom!, bottom0!), 'below `hi`: the field pixel is kept').toBe(true);
  expect(errors).toEqual([]);
});

test('golden: mesh-threshold-open', async ({ page }) => {
  const errors = await openLattice(page, {
    ...FIELD,
    threshold: { lo: -1, hi: null, symmetric: false, mode: 'hide', softEdge: 0 },
  });
  expect(errors).toEqual([]);
  await expectGolden(page, 'mesh-threshold-open');
});
