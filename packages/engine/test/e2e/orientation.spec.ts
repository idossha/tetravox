/**
 * §11's **three mandatory orientation tests** — the ones with a dedicated Phase-0 fixture.
 *
 * > three mandatory orientation tests on an *asymmetric* synthetic volume (a bright cube in the
 * > left-anterior-superior octant only): the bright pixel is on screen-**left** in neurological and
 * > screen-**right** after `setRadiological(true)`, in each of the three 2D views.
 *
 * `testdata/vol_asym.nii` exists for this and for nothing else (`scripts/gen-fixtures.py`,
 * `testdata/README.md`). Everything asserted below is computed from first principles (§11 rule 1):
 *
 * * the cube's world centroid is **measured from the dataset's own samples** — the raw array §4.3
 *   keeps on the UI thread — through the affine `testdata/manifest.json` records, so the test proves
 *   the fixture is left-anterior-superior instead of assuming it;
 * * the pixel the cube must land on is computed from §3's basis rules (`right = cross(up, normal)`
 *   over the preset normals `+Z / −Y / −X`), written out here as literals so the expectation does
 *   not come from `src/view/geometry.ts`;
 * * the other pixel is that one reflected about the pane's vertical axis, which is what §3 says
 *   `radiological` is — "negates `right` only".
 *
 * `vol_asym.nii` is integral, non-negative and has 2 unique values, so §6.1's `is_label` holds and it
 * takes the `R8UI` + palette path: dense index 0 (sample 0) has no table entry, gets `[0,0,0,0]` and
 * is discarded by the §7.3 shader — so a non-cube pixel inside the volume is *exactly* the scene
 * background, and both halves of every assertion below are an exact RGBA.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectPixel, readCanvasPixels } from '../helpers/pixels';
import type { Rgba } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const manifest = JSON.parse(readFileSync(`${REPO}testdata/manifest.json`, 'utf8')) as {
  volumes: Record<string, { dims: [number, number, number]; affine: number[][] }>;
};

const VOL = 'vol_asym.nii';
const PANE = 768;
/** 7.68 mm either side of the cursor, so the 8 mm fixture fills the pane. */
const MM_PER_PX = 0.02;

/** `defaultScene().background` is `[0.04, 0.05, 0.07, 1]`; the clear rounds it to 8-bit. */
const BACKGROUND: Rgba = [
  Math.round(0.04 * 255),
  Math.round(0.05 * 255),
  Math.round(0.07 * 255),
  255,
];

type Vec3 = [number, number, number];
type Preset = 'axial' | 'coronal' | 'sagittal';

/** §3's screen basis per preset, spelled out rather than imported (§11 rule 1). */
const BASIS: Record<Preset, { right: Vec3; up: Vec3; normal: Vec3 }> = {
  axial: { normal: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0] },
  coronal: { normal: [0, -1, 0], up: [0, 0, 1], right: [1, 0, 0] },
  sagittal: { normal: [-1, 0, 0], up: [0, 0, 1], right: [0, -1, 0] },
};

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The manifest's row-major affine applied to a voxel index (§3). */
function toWorld(affine: number[][], v: Vec3): Vec3 {
  return [0, 1, 2].map(
    (r) => affine[r]![0]! * v[0] + affine[r]![1]! * v[1] + affine[r]![2]! * v[2] + affine[r]![3]!
  ) as Vec3;
}

/**
 * The top-left-origin pixel whose centre is nearest a world point, with the cursor at the pane
 * centre: `world = cursor + right·sx + up·sy`, and pixel `p` samples `(p + 0.5 − PANE/2)·mmPerPx`.
 */
function pixelOf(view: Preset, cursor: Vec3, world: Vec3): [number, number] {
  const d: Vec3 = [world[0] - cursor[0], world[1] - cursor[1], world[2] - cursor[2]];
  const b = BASIS[view];
  const x = Math.floor(dot(d, b.right) / MM_PER_PX + PANE / 2 - 0.5);
  const glY = Math.floor(dot(d, b.up) / MM_PER_PX + PANE / 2 - 0.5);
  return [x, PANE - 1 - glY];
}

interface Scene {
  cube: Vec3;
  /** Screen-left pixel of the cube in neurological, and its mirror. */
  xCube: number;
  xMirror: number;
  y: number;
  rowX: number[];
}

/**
 * Load the fixture into one pane and put the cursor on the cube **along the view normal only**, so
 * the plane cuts the cube while the cube sits off to one side of the pane. Leaves the page in
 * neurological.
 */
async function setup(page: Page, view: Preset): Promise<Scene> {
  const rec = manifest.volumes[VOL]!;
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  // The bright octant's centroid, in voxels, out of the raw samples §4.3 keeps on the UI thread.
  const measured = (await page.evaluate(
    async ([url, dims]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const d = 'data' in ds ? (ds.data as ArrayLike<number>) : null;
      if (d === null) throw new Error('volume dataset has no samples');
      const [nx, ny, nz] = dims as [number, number, number];
      const s = [0, 0, 0];
      let n = 0;
      for (let k = 0; k < nz; k += 1)
        for (let j = 0; j < ny; j += 1)
          for (let i = 0; i < nx; i += 1) {
            if ((d[(k * ny + j) * nx + i] ?? 0) > 0) {
              s[0]! += i;
              s[1]! += j;
              s[2]! += k;
              n += 1;
            }
          }
      if (n === 0) throw new Error('the fixture has no bright voxels');
      return [s[0]! / n, s[1]! / n, s[2]! / n, n];
    },
    [fixture(VOL), rec.dims] as const
  )) as [number, number, number, number];

  // §11's fixture is one 3×3×3 block, so the centroid is exact.
  expect(measured[3], 'vol_asym.nii must carry a 3×3×3 bright cube').toBe(27);
  const cube = toWorld(rec.affine, [measured[0], measured[1], measured[2]]);
  // Left-anterior-superior in scanner RAS is −x, +y, +z (§3).
  expect(cube[0], 'the cube must be in the LEFT half').toBeLessThan(0);
  expect(cube[1], 'the cube must be ANTERIOR').toBeGreaterThan(0);
  expect(cube[2], 'the cube must be SUPERIOR').toBeGreaterThan(0);

  const n = BASIS[view].normal;
  const along = dot(cube, n);
  const cursor: Vec3 = [n[0] * along, n[1] * along, n[2] * along];

  await page.evaluate(
    async ([id, cur, mm]) => {
      const engine = window.__tvxEngine!;
      const ds = engine.scene.datasets.values().next().value!;
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: [id as string] });
      // Order matters: the engine centres the cursor and refits every pane on the first dataset.
      engine.setCursor(cur as [number, number, number]);
      engine.setView(id as string, { camera: { center: [0, 0], mmPerPx: mm as number } });
      (engine as unknown as { setAnnotations(p: object): void }).setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      await engine.whenSettled();
    },
    [view, cursor, MM_PER_PX] as const
  );

  const [xCube, y] = pixelOf(view, cursor, cube);
  // The left half of a scanline through the cube; its mirror is `PANE - 1 - x`.
  const rowX: number[] = [];
  for (let x = 12; x < PANE / 2; x += 3) rowX.push(x);
  return { cube, xCube, xMirror: PANE - 1 - xCube, y, rowX };
}

async function goRadiological(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setRadiological(true);
    await engine.whenSettled();
  });
}

for (const view of ['axial', 'coronal', 'sagittal'] as const) {
  test(`@angle §11 orientation — the LAS cube is screen-left in ${view}, screen-right in RAD`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const s = await setup(page, view);

    // Neurological: the cube is the screen-LEFT pixel, and its mirror is empty volume — discarded
    // to the scene background, an RGBA computed from `defaultScene()`, not from a previous run.
    await expectPixel(page, s.xMirror, s.y, BACKGROUND, 1);
    const [lit] = await readCanvasPixels(page, [[s.xCube, s.y] as const]);
    expect(lit!.join(), `${view}/NEU: the LAS cube must be on screen-LEFT`).not.toBe(
      BACKGROUND.join()
    );
    expect(lit![3], 'the cube is opaque').toBe(255);
    const rowNeu = await readCanvasPixels(
      page,
      s.rowX.map((x) => [x, s.y] as const)
    );

    // Radiological negates `right` only: the same pane, mirrored about its vertical axis. The cube
    // swaps sides and keeps its colour exactly.
    await goRadiological(page);
    await expectPixel(page, s.xCube, s.y, BACKGROUND, 1);
    await expectPixel(page, s.xMirror, s.y, lit!, 1);
    // …and not only at those two pixels: every pixel of a scanline through the cube reappears at its
    // mirror position, which is the whole content of "a mirror about the vertical screen axis".
    const rowRad = await readCanvasPixels(
      page,
      s.rowX.map((x) => [PANE - 1 - x, s.y] as const)
    );
    expect(rowNeu).toEqual(rowRad);

    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__tvxErrors ?? [])).toEqual([]);
  });
}

test('@angle §11 orientation — the cube lands on the pixel §3 names, to the pixel', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const s = await setup(page, 'axial');
  // 8³ voxels of 1 mm at origin −3.5: the fixture spans −4 … +4 mm and the 3³ cube's centroid is
  // (−2.5, 2.5, 2.5) — 125 px from the pane centre at 0.02 mm/px.
  expect(s.cube).toEqual([-2.5, 2.5, 2.5]);
  expect(manifest.volumes[VOL]!.dims).toEqual([8, 8, 8]);
  expect([s.xCube, s.y]).toEqual([258, 259]);
  // 3 mm of cube is 150 px wide and its centre is 125 px left of the pane centre, so its right edge
  // is at pixel 333: +74 is still cube and +90 is past it. Both pin the plane maths in absolute
  // pixels, not just the side.
  const [inside] = await readCanvasPixels(page, [[s.xCube + 74, s.y] as const]);
  expect(inside!.join(), 'still inside the cube').not.toBe(BACKGROUND.join());
  await expectPixel(page, s.xCube + 90, s.y, BACKGROUND, 1);
});
