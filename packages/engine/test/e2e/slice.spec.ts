/**
 * §11 rule 1 for the §7.3 slice shader: **analytic pixels first**.
 *
 * The label path is asserted here because it is the one with an index remap in the middle of it —
 * dense index → `N x 1 RGBA8` palette (§7.3) — and an off-by-one there paints every region with its
 * neighbour's colour, which looks entirely plausible.
 *
 * Ground truth is `testdata/manifest.json`, written by nibabel and by the authored LUT expectation;
 * nothing here is read back out of the engine. The affine is inverted **in the test** so the
 * expected voxel for a pixel is computed independently of the engine's own `inverseAffine`.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCanvasPixels } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const manifest = JSON.parse(readFileSync(`${REPO}testdata/manifest.json`, 'utf8')) as {
  volumes: Record<string, { dims: [number, number, number]; affine: number[][] }>;
  sidecars: Record<string, { expected: { id: number; name: string; rgba255: number[] }[] }>;
};

const VOL = 'labels_simnibs.nii.gz';
const LUT = 'labels_simnibs_LUT.txt';
const PANE = 768;
const MM_PER_PX = 0.05;

/** Invert a 4x4 row-major affine — the manifest's layout (§3). Gauss–Jordan, no library. */
function invert(m: number[][]): number[][] {
  const a = m.map((r, i) => [...r, ...[0, 0, 0, 0].map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < 4; col += 1) {
    let piv = col;
    for (let r = col; r < 4; r += 1) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    const d = a[col]![col]!;
    for (let j = 0; j < 8; j += 1) a[col]![j]! /= d;
    for (let r = 0; r < 4; r += 1) {
      if (r === col) continue;
      const f = a[r]![col]!;
      for (let j = 0; j < 8; j += 1) a[r]![j]! -= f * a[col]![j]!;
    }
  }
  return a.map((r) => r.slice(4));
}

function apply(m: number[][], p: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map(
    (r) => m[r]![0]! * p[0] + m[r]![1]! * p[1] + m[r]![2]! * p[2] + m[r]![3]!
  ) as [number, number, number];
}

test('a label volume paints each region its LUT colour, at the voxel the affine names', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const rec = manifest.volumes[VOL]!;
  const dims = rec.dims;
  // Centre the view on the middle of the volume, in world mm.
  const centreVoxel: [number, number, number] = [
    (dims[0] - 1) / 2,
    (dims[1] - 1) / 2,
    (dims[2] - 1) / 2,
  ];
  const cursor = apply(rec.affine, centreVoxel);

  const info = await page.evaluate(
    async ([url, lutUrl, mmPerPx, cur]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setCursor(cur as [number, number, number]);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      (engine as unknown as { setAnnotations(p: object): void }).setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      await engine.whenSettled();
      return {
        isLabel: 'isLabel' in ds ? ds.isLabel : null,
        format: 'gpu' in ds ? ds.gpu.format : null,
        labelIds: 'labelIds' in ds && ds.labelIds !== undefined ? Array.from(ds.labelIds) : null,
        tableSize: 'labelTable' in ds ? (ds.labelTable?.entries.length ?? 0) : 0,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture(VOL), fixture(LUT), MM_PER_PX, cursor] as const
  );

  expect(pageErrors).toEqual([]);
  expect(info.errors).toEqual([]);
  // §6.1: integral, min >= 0, 7 unique values -> a label volume, whatever its dtype.
  expect(info.isLabel).toBe(true);
  // §6.1 rows 1-2 are the NEAREST rows and are gated on `!want_linear`; the engine asks for
  // `wantLinear: false` precisely so a label volume lands here and not on the R8 grey ramp.
  expect(info.format).toBe('R8UI');
  expect(info.labelIds).toEqual([0, 1, 2, 3, 5, 10, 530]);
  expect(info.tableSize).toBe(7);

  // The expected colour of a pixel: pixel -> world -> voxel (inverting the manifest's own affine)
  // -> label id -> LUT rgba. The label id per voxel is not in the manifest, so the assertion is the
  // weaker but still independent one: every sampled pixel must be *one of* the LUT colours, the set
  // of colours actually painted must be exactly the LUT's non-transparent set, and a pixel outside
  // the volume must be background.
  const lutEntries = manifest.sidecars[LUT]!.expected;
  const opaque = lutEntries.filter((e) => (e.rgba255[3] ?? 0) > 0);
  const inv = invert(rec.affine);

  const pts: [number, number][] = [];
  for (let y = 40; y < PANE; y += 37) for (let x = 40; x < PANE; x += 37) pts.push([x, y]);
  const px = await readCanvasPixels(page, pts);

  const worldOf = (x: number, y: number): [number, number, number] => {
    // Axial, neurological: right = +X, up = +Y (§3). `readCanvasPixels` uses top-left origin.
    const glY = PANE - 1 - y;
    return [
      cursor[0] + (x + 0.5 - PANE / 2) * MM_PER_PX,
      cursor[1] + (glY + 0.5 - PANE / 2) * MM_PER_PX,
      cursor[2],
    ];
  };

  const painted = new Set<string>();
  let inside = 0;
  let outside = 0;
  pts.forEach(([x, y], i) => {
    const v = apply(inv, worldOf(x, y));
    const within = v.every((c, k) => c >= -0.5 && c <= (dims[k] ?? 1) - 0.5);
    const got = px[i]!;
    const isBackground = got[0] < 20 && got[1] < 20 && got[2] < 25;
    if (!within) {
      outside += 1;
      expect(isBackground, `pixel (${x},${y}) is outside the volume and must be discarded`).toBe(
        true
      );
      return;
    }
    inside += 1;
    if (isBackground) return; // a voxel whose label is id 0 ("Unknown", A = 0) — legitimately discarded
    painted.add(`${got[0]},${got[1]},${got[2]}`);
  });

  expect(inside, 'the sample grid must cross the volume').toBeGreaterThan(20);
  expect(outside, 'the sample grid must also leave the volume').toBeGreaterThan(20);

  const allowed = new Set(opaque.map((e) => `${e.rgba255[0]},${e.rgba255[1]},${e.rgba255[2]}`));
  for (const c of painted) {
    expect(
      allowed.has(c),
      `painted colour ${c} is not one of the LUT's ${[...allowed].join(' | ')}`
    ).toBe(true);
  }
  // Every non-background label in the file must actually reach the screen: 6 opaque LUT ids, and the
  // fixture uses all of them.
  expect(painted.size).toBe(opaque.length);
});
