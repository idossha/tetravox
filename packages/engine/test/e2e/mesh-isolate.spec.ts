/**
 * §7.4's element isolation, on the committed 3×3×3 lattice.
 *
 * The fixture is what makes this analytic: `scripts/gen-fixtures.py` tags a tet by the sign of its
 * centroid's `z` — 24 tets tagged 1 below `z = 0`, 24 tagged 2 above, confirmed by
 * `testdata/manifest.json`'s `tetTagCounts`. So "isolate tag 2" has an exact answer in three
 * independent currencies at once:
 *
 * * **a count** — `meshIsolation().visibleTets === 24`, straight off §6.5.2's result;
 * * **a boundary** — `extract_boundary` over the masked tets is the box `z ∈ [0, 10]`, so the pane's
 *   lower half becomes background and its upper half keeps drawing;
 * * **a colour** — the surviving surface is tagged with its **tet** tag (`push_face` pushes
 *   `mesh.tet_tags[t]`), so the pixel is tag 2's colour, lit.
 *
 * The composed case is the one §7.4 cares about most: the cut is issued with the same `maskId`, so a
 * cap over isolated-away tets cannot exist. Every expectation below is computed from the fixture's
 * geometry, never recorded from a run.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import {
  CAP_PLANE,
  capPointAtPaneY,
  facePixelToWorld,
  FRONT_FACE_CAMERA,
  isBackground,
  PANE,
  solveShading,
  worldToFacePixel,
} from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

/** Tet tag 2's LUT colour is a pure grey; R5's recolour path gives it something assertable. */
const TAG2_EDITED = [68, 136, 204, 255] as const;
/** The fixture's tag-2 tet count, from `testdata/manifest.json`. */
const TAG2_TETS = 24;

declare global {
  interface Window {
    __tvxIsolateLayer?: string;
  }
}

interface IsolateOptions {
  clip?: boolean;
}

/** Load the lattice under {@link FRONT_FACE_CAMERA}, with tag 2 recoloured and nothing isolated. */
async function openLattice(page: Page, opts: IsolateOptions = {}): Promise<void> {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([mesh, lut, camera, tag2, plane, o]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { lut: lut as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      window.__tvxIsolateLayer = layer.id;
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.setView('view3d', { camera: camera as never });
      const c = tag2 as readonly number[];
      engine.updateLayer(layer.id, {
        tagStyle: {
          1: { visible: true, opacity: 1 },
          2: { visible: true, opacity: 1, color: [c[0]! / 255, c[1]! / 255, c[2]! / 255, 1] },
          1001: { visible: true, opacity: 1 },
          1002: { visible: true, opacity: 1 },
        },
        clip:
          (o as IsolateOptions).clip === true
            ? { planes: [{ plane, enabled: true }], caps: true, capColorMode: 'inherit' }
            : { planes: [], caps: true, capColorMode: 'inherit' },
      } as never);
      await engine.whenSettled();
    },
    [
      fixture('mesh_v2_binary.msh'),
      fixture('mesh_v2_binary_LUT.txt'),
      FRONT_FACE_CAMERA,
      TAG2_EDITED,
      CAP_PLANE,
      opts,
    ] as const
  );
}

/** Apply an `IsolateSpec` (or clear it) and wait for the mask and its boundary to land. */
async function setIsolate(page: Page, spec: unknown): Promise<void> {
  await page.evaluate(async (s) => {
    window.__tvxEngine!.updateLayer(window.__tvxIsolateLayer!, { isolate: s } as never);
    await window.__tvxEngine!.whenSettled();
  }, spec);
}

function isolation(
  page: Page
): Promise<{ maskId: number; visibleTets: number; generation: number } | null> {
  return page.evaluate(() => {
    const engine = window.__tvxEngine as unknown as {
      meshIsolation(id: string): { maskId: number; visibleTets: number; generation: number } | null;
    };
    return engine.meshIsolation(window.__tvxIsolateLayer!);
  });
}

/** Two pane pixels on the cube's front face: one in the tag-2 half, one in the tag-1 half. */
const UPPER: [number, number] = [PANE / 2 - 80, PANE / 2 - 120];
const LOWER: [number, number] = [PANE / 2 - 80, PANE / 2 + 120];

test('the fixture’s halves really are where this spec says they are', () => {
  // The pixels above are the whole spec's frame of reference, so the mapping is asserted rather
  // than assumed: `facePixelToWorld` is `mesh-support.ts`'s inverse of the camera projection.
  expect(facePixelToWorld(UPPER[0], UPPER[1])[2]).toBeGreaterThan(1);
  expect(facePixelToWorld(LOWER[0], LOWER[1])[2]).toBeLessThan(-1);
});

test('§7.4 isolate by tag: the mask, its boundary and its colour all agree', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openLattice(page);
  expect(await isolation(page), 'nothing is isolated on load').toBeNull();

  const [beforeUpper, beforeLower] = await readCanvasPixels(page, [UPPER, LOWER]);
  expect(isBackground(beforeUpper!)).toBe(false);
  expect(isBackground(beforeLower!)).toBe(false);

  await setIsolate(page, { tags: [2], combine: 'all' });

  const state = await isolation(page);
  expect(state, 'a mask is in force').not.toBeNull();
  // §6.5.2's own count, against the fixture's manifest. A mask that selected the wrong half would
  // still be 24, which is why the pixels below are asserted too.
  expect(state!.visibleTets, 'the mask holds exactly the tag-2 tets').toBe(TAG2_TETS);

  const [upper, lower] = await readCanvasPixels(page, [UPPER, LOWER]);
  expect(
    isBackground(lower!),
    `the tag-1 half is gone from the re-derived boundary, got rgb(${lower!.join(',')})`
  ).toBe(true);
  // …and what is left is tag 2, exactly: `extract_boundary` tags a derived face with its owning
  // tet's tag, so the sub-mesh's surface carries tet tag 2 and reads the same `tagStyle` colour.
  const solved = solveShading(TAG2_EDITED, upper!);
  console.log(
    `[isolate] visibleTets ${String(state!.visibleTets)}; kept pixel rgb(${upper!
      .slice(0, 3)
      .join(',')}) is ${TAG2_EDITED.slice(0, 3).join(',')} at s=${solved.s.toFixed(3)}`
  );
  expect(solved.feasible, 'the isolated boundary is tag 2’s colour, lit').toBe(true);
  expect(errors).toEqual([]);
});

test('clearing the isolation brings the whole mesh back, and frees the mask', async ({ page }) => {
  await openLattice(page);
  await setIsolate(page, { tags: [2], combine: 'all' });
  expect(isBackground((await readCanvasPixels(page, [LOWER]))[0]!)).toBe(true);

  await setIsolate(page, undefined);
  expect(await isolation(page), 'the mask is released, not merely ignored').toBeNull();
  const [lower] = await readCanvasPixels(page, [LOWER]);
  expect(isBackground(lower!), `the tag-1 half is back, got rgb(${lower!.join(',')})`).toBe(false);
});

test('re-isolating to a different tag re-derives the boundary rather than reusing it', async ({
  page,
}) => {
  await openLattice(page);
  await setIsolate(page, { tags: [2], combine: 'all' });
  const first = await isolation(page);
  await setIsolate(page, { tags: [1], combine: 'all' });
  const second = await isolation(page);

  expect(second!.visibleTets).toBe(24);
  // §6.5.2 makes `generation` part of the geometry cache key precisely because mask ids are reused;
  // a stale key here would leave tag 2's boundary on screen under tag 1's mask.
  expect(second!.generation).not.toBe(first!.generation);
  const [upper, lower] = await readCanvasPixels(page, [UPPER, LOWER]);
  expect(isBackground(upper!), 'the tag-2 half is gone now').toBe(true);
  expect(isBackground(lower!), 'the tag-1 half is what draws').toBe(false);
});

test('§7.4 isolation composes with clipping: the cut carries the mask', async ({ page }) => {
  await openLattice(page, { clip: true });
  await setIsolate(page, { tags: [2], combine: 'all' });

  const cut = await page.evaluate(() => {
    const engine = window.__tvxEngine as unknown as {
      meshCut(id: string): { triangleCount: number; tag: Int32Array } | null;
    };
    const c = engine.meshCut(window.__tvxIsolateLayer!);
    return c === null ? null : { triangleCount: c.triangleCount, tags: [...new Set(c.tag)] };
  });
  expect(cut, 'the clipped layer still has a cut under the mask').not.toBeNull();
  expect(cut!.triangleCount).toBeGreaterThan(0);
  // The cut takes the same `maskId`, so a cap over an isolated-away tet cannot exist. Without the
  // mask this list is [1, 2].
  expect(cut!.tags, 'every cap triangle belongs to an isolated tet').toEqual([2]);

  // …and the pane agrees: the cap's tag-1 half is background, its tag-2 half is not.
  const above = worldToFacePixel(capPointAtPaneY(PANE / 2 - 60));
  const below = worldToFacePixel(capPointAtPaneY(PANE / 2 + 60));
  const [kept, removed] = await readCanvasPixels(page, [
    [Math.round(above[0]) + 12, Math.round(above[1])],
    [Math.round(below[0]) + 12, Math.round(below[1])],
  ]);
  expect(isBackground(kept!)).toBe(false);
  expect(
    isBackground(removed!),
    `the isolated-away half has no cap, got rgb(${removed!.join(',')})`
  ).toBe(true);
});

test('an isolation is a progress state, not an instant checkbox (§8)', async ({ page }) => {
  await openLattice(page);
  // §7.4 calls the mask allocation plus `extract_boundary` over the sub-mesh work in progress. The
  // flag is read synchronously after the patch, before anything is awaited.
  const loading = (): Promise<boolean> =>
    page.evaluate(() => {
      const engine = window.__tvxEngine as unknown as { meshLayerLoading(id: string): boolean };
      return engine.meshLayerLoading(window.__tvxIsolateLayer!);
    });
  const during = await page.evaluate(() => {
    const engine = window.__tvxEngine as unknown as {
      updateLayer(id: string, patch: unknown): void;
      meshLayerLoading(id: string): boolean;
    };
    engine.updateLayer(window.__tvxIsolateLayer!, { isolate: { tags: [2], combine: 'all' } });
    return engine.meshLayerLoading(window.__tvxIsolateLayer!);
  });
  expect(during, 'the layer reports loading while the mask is in flight').toBe(true);
  await page.evaluate(() => window.__tvxEngine!.whenSettled());
  expect(await loading(), 'and stops once the boundary has landed').toBe(false);
});

test('golden: mesh-isolate-tags', async ({ page }) => {
  await openLattice(page);
  await setIsolate(page, { tags: [2], combine: 'all' });
  await expectGolden(page, 'mesh-isolate-tags');
});
