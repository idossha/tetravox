/**
 * §4.4's `clearBackground` on the real renderer: **a voxel at or below the cut-off is the pane
 * background, every other voxel is `LUT(value)`**, computed on the CPU.
 *
 * `vol_bgfill.nii.gz` is a 16 × 14 × 4 CT-like slab: a ring of −1024 padding (78 % of the voxels)
 * around an 8 × 6 interior of `−1023 + 40·n`. Its first interior voxel is **one** unit above the
 * padding, so a cut-off slack of a whole code would erase it — the assertion that pins
 * `clearBelow`'s half-code. The value at each pixel comes from `Engine.probe` (the UI thread's
 * retained array), not from the texture the fragment sampled, exactly as `slice-scale.spec.ts`
 * does; that file is also where the `gray` + `linear` model below comes from.
 *
 * Every analytic test runs on both §6.1 ladder rows — the renderer's own (R16 where it has
 * `EXT_texture_norm16`) and forced R32F — because the slack differs between them.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import type { Rgba } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const VOL = 'vol_bgfill.nii.gz';
const PANE = 768;
/** The slab is 16 × 14 mm; 0.025 mm/px puts all of it, plus a margin outside its AABB, in the pane. */
const MM_PER_PX = 0.025;
/** Axial slice k = 0 (voxel centres sit at z = −1.5 … 1.5), so no pixel straddles two slices. */
const CURSOR: [number, number, number] = [0, 0, -1.5];

/** The padding value and the interior's first voxel (`scripts/gen-fixtures.py`). */
const PAD = -1024;
const FIRST = -1023;
/** Voxel (4, 4, 0) — the `FIRST` voxel's centre in world mm (identity affine, origin −7.5/−6.5). */
const FIRST_WORLD: [number, number, number] = [-3.5, -2.5, -1.5];

/** A window wide enough that `PAD` is a grey distinct from the background, so "cleared" is visible. */
const LO = -2000;
const HI = 7000;

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** The texel a fragment of value `v` lands in, on a 256-wide LUT over `[lo, hi]`. */
function texelValue(v: number): number {
  const i = Math.min(255, Math.floor(clamp01((v - LO) / (HI - LO)) * 256));
  return LO + ((i + 0.5) / 256) * (HI - LO);
}

/** `gray` under `linear {LO, HI}` — `slice-scale.spec.ts`'s model. */
function grayRgba(v: number): Rgba {
  const g = Math.round(255 * clamp01((texelValue(v) - LO) / (HI - LO)));
  return [g, g, g, 255];
}

/** The pixel §4.4 says is drawn for value `v` under cut-off `cut` (`-Infinity` = off). */
function expected(v: number | undefined, cut: number, bg: Rgba): Rgba {
  if (v === undefined || v <= cut) return bg;
  return grayRgba(v);
}

function expectRgb(px: Rgba, want: Rgba, tol: number, label: string): void {
  for (let c = 0; c < 3; c += 1) {
    expect(
      Math.abs((px[c] ?? 0) - (want[c] ?? 0)),
      `${label}: channel ${c} expected ${want[c]} ±${tol}, got ${px[c]} (pixel ${px.join(',')})`
    ).toBeLessThanOrEqual(tol);
  }
}

const same = (a: Rgba, b: Rgba): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

interface Loaded {
  layerId: string;
  clearBackground: unknown;
  background: Rgba;
  tol: number;
}

async function openVolume(page: Page, norm16: boolean): Promise<Loaded> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`/test/pages/scene.html${norm16 ? '' : '?norm16=0'}`);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const info = await page.evaluate(
    async ([url, mmPerPx, cursor, lo, hi]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setCursor(cursor as [number, number, number]);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      // The default `clearBackground` is read **before** any patch: it is what the worker's
      // stats and `defaultVolumeLayer` decided, end to end.
      const seeded = (engine.scene.layers[0] as { clearBackground?: unknown }).clearBackground;
      engine.updateLayer(layer.id, {
        interpolation: 'nearest',
        scale: { kind: 'linear', lo: lo as number, hi: hi as number },
      });
      await engine.whenSettled();
      return {
        layerId: layer.id,
        clearBackground: seeded ?? null,
        background: engine.scene.background.map((c) => Math.round(c * 255)),
        isLabel: 'isLabel' in ds ? ds.isLabel : null,
        min: 'stats' in ds ? ds.stats.min : null,
        format: 'gpu' in ds ? ds.gpu.format : '',
        norm16: engine.caps.norm16,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture(VOL), MM_PER_PX, CURSOR, LO, HI] as const
  );
  expect(pageErrors).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.isLabel, 'a negative minimum keeps the slab off the label path').toBe(false);
  expect(info.min).toBe(PAD);
  expect(info.format, 'the §6.1 ladder row this leg takes').toBe(info.norm16 ? 'R16' : 'R32F');
  const bg = info.background;
  return {
    layerId: info.layerId,
    clearBackground: info.clearBackground,
    background: [bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0, 255],
    tol: info.format === 'R32F' ? 0 : 3,
  };
}

/** Pane pixel (top-left origin) → world mm, for the neurological axial pane centred on `CURSOR`. */
function worldOf(x: number, y: number): [number, number, number] {
  const glY = PANE - 1 - y;
  return [
    CURSOR[0] + (x + 0.5 - PANE / 2) * MM_PER_PX,
    CURSOR[1] + (glY + 0.5 - PANE / 2) * MM_PER_PX,
    CURSOR[2],
  ];
}

/** ...and back, to the pixel whose centre is nearest `w`. */
function pixelOf(w: [number, number, number]): [number, number] {
  const x = Math.round((w[0] - CURSOR[0]) / MM_PER_PX + PANE / 2 - 0.5);
  const glY = Math.round((w[1] - CURSOR[1]) / MM_PER_PX + PANE / 2 - 0.5);
  return [x, PANE - 1 - glY];
}

interface Sample {
  pt: [number, number];
  value: number | undefined;
  px: Rgba;
}

/** A grid over the pane plus the `FIRST` voxel's own pixel, each with its probed value. */
async function sample(page: Page, step = 17): Promise<Sample[]> {
  const pts: [number, number][] = [pixelOf(FIRST_WORLD)];
  for (let y = 12; y < PANE; y += step) for (let x = 12; x < PANE; x += step) pts.push([x, y]);
  const values = await page.evaluate(
    (ws) =>
      (ws as [number, number, number][]).map((w) => {
        const row = window.__tvxEngine!.probe(w).rows[0];
        return typeof row?.value === 'number' ? row.value : null;
      }),
    pts.map(([x, y]) => worldOf(x, y))
  );
  const px = await readCanvasPixels(page, pts);
  return pts.map((pt, i) => ({ pt, value: values[i] ?? undefined, px: px[i] ?? [0, 0, 0, 0] }));
}

async function setLayer(page: Page, layerId: string, patch: object): Promise<void> {
  await page.evaluate(
    async ([id, p]) => {
      const engine = window.__tvxEngine!;
      engine.updateLayer(id as string, p as never);
      await engine.whenSettled();
    },
    [layerId, patch] as const
  );
}

/** Assert every sampled pixel against the model; return how many were cleared and painted. */
function assertGrid(
  grid: Sample[],
  cut: number,
  info: Loaded
): { cleared: number; painted: number; outside: number } {
  let cleared = 0;
  let painted = 0;
  let outside = 0;
  for (const { pt, value, px } of grid) {
    if (value === undefined) outside += 1;
    else if (value <= cut) cleared += 1;
    else painted += 1;
    expectRgb(px, expected(value, cut, info.background), info.tol, `(${pt.join(',')}) v=${value}`);
  }
  return { cleared, painted, outside };
}

const LEGS = [
  { name: 'as-is', norm16: true },
  { name: 'forceCaps norm16:false', norm16: false },
] as const;

for (const leg of LEGS) {
  test(`@angle default (${leg.name}): a padded volume opens with its background cleared`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    expect(info.clearBackground, '78 % of the voxels at the minimum ⇒ on by default').toEqual({
      enabled: true,
    });
    // The premise of "cleared is visible": the padding's own grey is not the background colour.
    expect(same(grayRgba(PAD), info.background)).toBe(false);

    const grid = await sample(page);
    const first = grid[0]!;
    expect(first.value, 'the pixel sits on the FIRST voxel').toBe(FIRST);
    const n = assertGrid(grid, PAD, info);
    expect(n.cleared, 'padding pixels cleared').toBeGreaterThan(300);
    expect(n.painted, 'interior pixels painted').toBeGreaterThan(150);
    expect(n.outside, 'pixels outside the AABB').toBeGreaterThan(100);
    // One unit above the padding is tissue, not background: the slack is half a code, not one.
    expectRgb(first.px, grayRgba(FIRST), info.tol, 'the FIRST voxel survives the default cut');
  });

  test(`@angle off (${leg.name}): disabling it draws the padding as LUT(min) again`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    await setLayer(page, info.layerId, { clearBackground: { enabled: false } });
    const n = assertGrid(await sample(page), -Infinity, info);
    expect(n.cleared).toBe(0);
    expect(n.painted, 'padding and interior both painted').toBeGreaterThan(450);
  });

  test(`@angle cut-off (${leg.name}): an explicit value clears everything at or below it`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    // Between two stored values (297 and 337): nothing sits on the decision boundary. Slice k = 0
    // holds −1023 … 857, so this splits its interior roughly 34 : 14 voxels.
    await setLayer(page, info.layerId, { clearBackground: { enabled: true, value: 300 } });
    const n = assertGrid(await sample(page), 300, info);
    expect(n.cleared, 'padding plus the interior below 300').toBeGreaterThan(350);
    expect(n.painted, 'interior above 300').toBeGreaterThan(50);

    // Exactly on a stored value: "at or below" includes it, and the next value up survives.
    const ON = FIRST + 40 * 20;
    await setLayer(page, info.layerId, { clearBackground: { enabled: true, value: ON } });
    const grid = await sample(page);
    assertGrid(grid, ON, info);
    expect(grid.filter((s) => s.value === ON).length, 'pixels on the cut value').toBeGreaterThan(0);
    expect(grid.filter((s) => s.value === ON + 40).length, 'pixels just above').toBeGreaterThan(0);

    // A cut-off below the data clears nothing, and dropping the value restores the background level.
    await setLayer(page, info.layerId, { clearBackground: { enabled: true, value: -5000 } });
    expect(assertGrid(await sample(page), -5000, info).cleared).toBe(0);
    await setLayer(page, info.layerId, { clearBackground: { enabled: true } });
    expect(assertGrid(await sample(page), PAD, info).cleared).toBeGreaterThan(300);
  });
}

test('pick: a cleared pixel is not the layer, exactly like a threshold discard (§7.2.3)', async ({
  page,
}) => {
  const info = await openVolume(page, false);
  const padPx = pixelOf([-6.5, -5.5, -1.5]); // voxel (1, 1, 0): padding
  const tissuePx = pixelOf([0.5, 0.5, -1.5]); // voxel (8, 7, 0): interior
  const pickAt = (pt: [number, number]): Promise<string | null> =>
    page.evaluate(
      ([x, y]) => window.__tvxEngine!.pick('axial', x as number, y as number)?.layerId ?? null,
      pt
    );
  expect(await pickAt(tissuePx)).toBe(info.layerId);
  expect(await pickAt(padPx)).toBeNull();
  await setLayer(page, info.layerId, { clearBackground: { enabled: false } });
  expect(await pickAt(padPx), 'the same pixel is the layer once nothing is cleared').toBe(
    info.layerId
  );
});

test('showIn3D: the cleared padding is not drawn on the 3D planes either', async ({ page }) => {
  test.setTimeout(120_000);
  const info = await openVolume(page, false);
  // A 128-unit window whose texel edge falls at −1023.5: under the 2D tests' window the padding and
  // the FIRST voxel share a texel, and a count of "the padding's grey" would count FIRST too.
  // 256 texels of 0.5 from −1100 put −1024 in texel 151 and −1023 in 154.
  const lo3 = -1100;
  const hi3 = lo3 + 128;
  const padTexel = Math.floor(((PAD - lo3) / (hi3 - lo3)) * 256);
  const padG = Math.round((255 * (padTexel + 0.5)) / 256);
  const firstG = Math.round((255 * (Math.floor(((FIRST - lo3) / (hi3 - lo3)) * 256) + 0.5)) / 256);
  expect(padG, 'the padding and FIRST are different greys under this window').not.toBe(firstG);
  const count = await page.evaluate(
    async ([id, grey, lo, hi]) => {
      const engine = window.__tvxEngine!;
      const g = [grey, grey, grey] as number[];
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ orientationCube: false, colorbars: false });
      engine.updateLayer(id as string, {
        showIn3D: true,
        scale: { kind: 'linear', lo: lo as number, hi: hi as number },
      });
      engine.resetView('view3d');
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const padPixels = async (clear: boolean): Promise<number> => {
        engine.updateLayer(id as string, { clearBackground: { enabled: clear } });
        await engine.whenSettled();
        engine.renderNow();
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 0; i < w * h; i += 1) {
          if (px[i * 4] === g[0] && px[i * 4 + 1] === g[1] && px[i * 4 + 2] === g[2]) n += 1;
        }
        return n;
      };
      return { off: await padPixels(false), on: await padPixels(true) };
    },
    [info.layerId, padG, lo3, hi3] as const
  );
  expect(count.off, "the padding's grey covers the planes when nothing is cleared").toBeGreaterThan(
    1000
  );
  expect(count.on, 'and none of it is drawn once it is cleared').toBe(0);
});

test('clear-background golden', async ({ page }) => {
  await openVolume(page, false);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ colorbars: true, orientationLabels: true, cornerInfo: true });
    await engine.whenSettled();
  });
  await expectGolden(page, 'slice-clear-background');
});
