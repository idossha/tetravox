/**
 * §11 (1) for §7.3's scalar path: **the pixel is `LUT(value)`, computed on the CPU.**
 *
 * The expected RGBA is derived from first principles in this file — §4.2's two-segment heat ramp,
 * the `gray` colormap (two stops, so the expected channel is `round(255 · t)` with no table to
 * transcribe), and the `NEAREST` texel the shader fetches. Nothing here calls `bakeScale`, so the
 * assertion is on the whole chain rather than on the bake agreeing with itself.
 *
 * The **value** at each asserted pixel comes from `Engine.probe`, which §4.3/§8 resolve on the UI
 * thread out of the retained typed array — a genuinely independent path from the GPU texture the
 * fragment sampled. That is what lets these tests assert `LUT(value)` over hundreds of pixels
 * without transcribing a fixture's voxels.
 *
 * **Every analytic test runs twice**, §11's paired `forceCaps` pattern: once as the renderer comes
 * (R16 on ANGLE/Metal, R32F under SwiftShader) and once with `norm16: false` forced. The golden
 * authority has no `EXT_texture_norm16`, so a golden can only ever pin the R32F branch; the R16
 * branch of the §6.1 ladder executes here or nowhere.
 *
 * `vol_i16.nii.gz` is the fixture. It is not a label volume (§6.1's `is_label` is "integral ∧
 * min ≥ 0 ∧ unique ≤ 4096", and its min is −11700), so it takes the colormap branch; and it is
 * **symmetric about zero**, which is what lets one fixture exercise `heat`'s negative branch,
 * `truncate`, and a symmetric threshold. `vol_ramp4.nii` and `vol_asym.nii` are both classified as
 * labels and never reach a colormap at all.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import type { Rgba } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const VOL = 'vol_i16.nii.gz';
const PANE = 768;
/** 0.02 mm/px: the fixture is a ~9 × 10 × 8 mm box, so this fills most of the pane. */
const MM_PER_PX = 0.02;

/** The physical range of `vol_i16.nii.gz` (`testdata/manifest.json`). */
const DATA_LO = -11700;
const DATA_HI = 11700;

// -------------------------------------------------------------------------------------------
// The display model, reimplemented from §4.2 / §7.6 — never imported from the engine.
// -------------------------------------------------------------------------------------------

interface Heat {
  min: number;
  mid: number;
  max: number;
  truncate: boolean;
  inverse: boolean;
  negative: 'mirror' | 'hide' | 'separate';
}

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** `gray` is `[0,0,0] → [255,255,255]`, so the ramp position *is* the channel. */
const grayByte = (t: number): number => Math.round(255 * clamp01(t));

/** §4.2's heat ramp on `|v|`: `min → 0`, `mid → 0.5`, `max → 1`. */
function heatPosition(s: Heat, v: number): number {
  const a = Math.abs(v);
  let t: number;
  if (a <= s.min) t = 0;
  else if (a <= s.mid) t = (0.5 * (a - s.min)) / (s.mid - s.min);
  else if (a <= s.max) t = 0.5 + (0.5 * (a - s.mid)) / (s.max - s.mid);
  else t = 1;
  return s.inverse ? 1 - t : t;
}

/** The value the texel a fragment lands in was baked for: `lo + ((i + 0.5) / width) · (hi − lo)`. */
function texelValue(lo: number, hi: number, width: number, v: number): number {
  const i = Math.min(width - 1, Math.floor(clamp01((v - lo) / (hi - lo)) * width));
  return lo + ((i + 0.5) / width) * (hi - lo);
}

/** What §7.3's fragment paints for `v` under a `heat` scale and `gray`, before blending. */
function heatRgba(s: Heat, v: number): [number, number, number, number] {
  // `truncate` clips instead of saturating; it is a discard, so it happens before the LUT.
  if (s.truncate && Math.abs(v) > s.max) return [0, 0, 0, 0];
  const tv = texelValue(-s.max, s.max, 256, v);
  if (Math.abs(tv) < s.min) return [0, 0, 0, 0]; // below `min` a heat scale contributes nothing
  if (tv < 0 && s.negative === 'hide') return [0, 0, 0, 0];
  const g = grayByte(heatPosition(s, tv));
  return [g, g, g, 255];
}

/** ...and under a `linear` scale. */
function linearRgba(lo: number, hi: number, v: number): [number, number, number, number] {
  const tv = texelValue(lo, hi, 256, v);
  const g = grayByte((tv - lo) / (hi - lo));
  return [g, g, g, 255];
}

/** `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` over the cleared background, in 8-bit storage. */
function over(src: [number, number, number, number], alpha: number, bg: Rgba): Rgba {
  const a = clamp01(alpha) * (src[3] / 255);
  return [
    Math.round(src[0] * a + (bg[0] ?? 0) * (1 - a)),
    Math.round(src[1] * a + (bg[1] ?? 0) * (1 - a)),
    Math.round(src[2] * a + (bg[2] ?? 0) * (1 - a)),
    255,
  ];
}

/** §4.2's `softEdge`: "width of the alpha ramp as a fraction of `hi - lo`; 0 = hard discard". */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function expectRgb(px: Rgba, expected: Rgba, tol: number, label: string): void {
  for (let c = 0; c < 3; c += 1) {
    const got = px[c] ?? 0;
    const want = expected[c] ?? 0;
    expect(
      Math.abs(got - want),
      `${label}: channel ${c} expected ${want} ±${tol}, got ${got} (whole pixel ${px.join(',')})`
    ).toBeLessThanOrEqual(tol);
  }
}

// -------------------------------------------------------------------------------------------
// Harness
// -------------------------------------------------------------------------------------------

interface Loaded {
  layerId: string;
  cursor: [number, number, number];
  /** The cleared background, as `readCanvasPixels` reports it — the RGBA every discard leaves. */
  background: Rgba;
  format: string;
  /**
   * Per-channel tolerance.
   *
   * **0 on R32F** — the payload stores physical units, so the fragment's value is the probe's value
   * and the texel is the one this file computed. **3 on R16**, where the payload is a normalised
   * 16-bit code: a value sitting on a LUT texel boundary (1500 and −1500 do, for the scales below)
   * can quantise to either side of it, and two adjacent texels of a 256-step ramp differ by up to
   * two levels. That is the whole reason §11 wants the pair run rather than one of them.
   */
  tol: number;
}

/** Open the scene page with `vol_i16.nii.gz` alone in a 1×1 axial pane, chrome off. */
async function openVolume(page: Page, norm16 = true): Promise<Loaded> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`/test/pages/scene.html${norm16 ? '' : '?norm16=0'}`);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const info = await page.evaluate(
    async ([url, mmPerPx]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      // `interpolation: 'nearest'` so the fragment reads the voxel `probe` rounds to. It is a
      // reading, not a quality knob (§7.2); this test is about the colour of a known value.
      engine.updateLayer(layer.id, { interpolation: 'nearest' });
      await engine.whenSettled();
      return {
        layerId: layer.id,
        cursor: engine.scene.cursor as [number, number, number],
        background: engine.scene.background.map((c) => Math.round(c * 255)),
        isLabel: 'isLabel' in ds ? ds.isLabel : null,
        format: 'gpu' in ds ? ds.gpu.format : '',
        norm16: engine.caps.norm16,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture(VOL), MM_PER_PX] as const
  );

  expect(pageErrors).toEqual([]);
  expect(info.errors).toEqual([]);
  // The premise of every assertion below: the colormap branch, not the `R8UI` + palette branch.
  expect(info.isLabel).toBe(false);
  expect(info.format, 'the §6.1 ladder row this leg takes').toBe(info.norm16 ? 'R16' : 'R32F');
  if (!norm16) expect(info.norm16, '`forceCaps` may only ever REMOVE a capability').toBe(false);
  const bg = info.background;
  const background: Rgba = [bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0, 255];
  return { ...info, background, tol: info.format === 'R32F' ? 0 : 3 };
}

/** Pane pixel (top-left origin) → world mm, for a neurological axial pane at `camera.center` 0. */
function worldOf(cursor: [number, number, number], x: number, y: number): [number, number, number] {
  const glY = PANE - 1 - y;
  return [
    cursor[0] + (x + 0.5 - PANE / 2) * MM_PER_PX,
    cursor[1] + (glY + 0.5 - PANE / 2) * MM_PER_PX,
    cursor[2],
  ];
}

/** A grid over the pane, with the value `probe` reads at each point and the pixel drawn there. */
async function sample(
  page: Page,
  cursor: [number, number, number],
  step = 29
): Promise<{ pt: [number, number]; value: number | undefined; px: Rgba }[]> {
  const pts: [number, number][] = [];
  for (let y = 20; y < PANE; y += step) for (let x = 20; x < PANE; x += step) pts.push([x, y]);
  const worlds = pts.map(([x, y]) => worldOf(cursor, x, y));
  const values = await page.evaluate((ws) => {
    const engine = window.__tvxEngine!;
    return (ws as [number, number, number][]).map((w) => {
      const row = engine.probe(w).rows[0];
      return typeof row?.value === 'number' ? row.value : null;
    });
  }, worlds);
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

/** §11's paired legs: the renderer's own ladder row, and the forced-R32F one. */
const LEGS = [
  { name: 'as-is', norm16: true },
  { name: 'forceCaps norm16:false', norm16: false },
] as const;

// -------------------------------------------------------------------------------------------
// heat
// -------------------------------------------------------------------------------------------

/**
 * `min`/`mid`/`max` chosen so no voxel value sits on a decision boundary: the fixture's values are
 * multiples of 100 in ±{300…700, 1300…1700, 8300…8700}, so nothing is at 1000, 4000 or 8000 and the
 * R16 leg's quantisation cannot flip a fragment between drawn and discarded.
 */
const HEAT: Heat = {
  min: 1000,
  mid: 4000,
  max: 8000,
  truncate: false,
  inverse: false,
  negative: 'hide',
};

for (const leg of LEGS) {
  test(`@angle heat (${leg.name}): every pixel is LUT(value), min/mid/max computed on the CPU`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    await setLayer(page, info.layerId, {
      colormap: 'gray',
      scale: { kind: 'heat', ...HEAT },
    });

    const grid = await sample(page, info.cursor);
    let painted = 0;
    let dead = 0;
    let negative = 0;
    for (const { pt, value, px } of grid) {
      const label = `(${pt.join(',')}) v=${value}`;
      if (value === undefined) {
        // Outside the volume's own AABB — §7.3's texcoord discard.
        expectRgb(px, info.background, 0, `${label} outside the volume`);
        continue;
      }
      const src = heatRgba(HEAT, value);
      if (src[3] === 0) dead += 1;
      else painted += 1;
      if (value < 0) negative += 1;
      expectRgb(px, over(src, 1, info.background), info.tol, label);
    }
    // The scale has to actually exercise every branch, or the test is asserting nothing.
    expect(painted, 'pixels above min').toBeGreaterThan(20);
    expect(dead, 'pixels below min (a heat scale is an overlay)').toBeGreaterThan(20);
    expect(negative, "pixels on the negative branch (negative:'hide')").toBeGreaterThan(20);
  });

  test(`@angle heat (${leg.name}): the negative branch — hide, mirror and inverse`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    for (const variant of [
      { ...HEAT, negative: 'mirror' as const },
      { ...HEAT, inverse: true },
      { ...HEAT, negative: 'mirror' as const, inverse: true },
    ]) {
      await setLayer(page, info.layerId, { colormap: 'gray', scale: { kind: 'heat', ...variant } });
      const grid = await sample(page, info.cursor, 41);
      let checked = 0;
      let mirrored = 0;
      for (const { pt, value, px } of grid) {
        if (value === undefined) continue;
        const src = heatRgba(variant, value);
        expectRgb(
          px,
          over(src, 1, info.background),
          info.tol,
          `${JSON.stringify(variant)} (${pt.join(',')}) v=${value}`
        );
        checked += 1;
        if (value < 0 && src[3] > 0) mirrored += 1;
      }
      expect(checked).toBeGreaterThan(20);
      // `mirror` must actually paint the negative branch; `hide` never would.
      if (variant.negative === 'mirror') expect(mirrored).toBeGreaterThan(5);
    }
  });

  test(`@angle heat (${leg.name}): \`truncate\` clips above max instead of saturating`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    const counts: Record<string, { above: number; painted: number }> = {};
    for (const truncate of [false, true]) {
      const scale = { ...HEAT, negative: 'mirror' as const, truncate };
      await setLayer(page, info.layerId, { colormap: 'gray', scale: { kind: 'heat', ...scale } });
      const grid = await sample(page, info.cursor);
      let above = 0;
      let painted = 0;
      for (const { pt, value, px } of grid) {
        if (value === undefined) continue;
        if (Math.abs(value) > HEAT.max) above += 1;
        const src = heatRgba(scale, value);
        if (src[3] > 0) painted += 1;
        expectRgb(
          px,
          over(src, 1, info.background),
          info.tol,
          `truncate=${truncate} (${pt.join(',')}) v=${value}`
        );
      }
      counts[String(truncate)] = { above, painted };
    }
    // The two runs have to differ by exactly the out-of-range pixels, or `truncate` is inert — which
    // is what it was before Phase 2 (`t = scale.truncate ? 1 : 1`).
    const saturating = counts.false ?? { above: 0, painted: 0 };
    const clipping = counts.true ?? { above: 0, painted: 0 };
    expect(saturating.above, 'pixels above max').toBeGreaterThan(10);
    expect(clipping.painted).toBe(saturating.painted - saturating.above);
  });
}

test('heat golden', async ({ page }) => {
  const info = await openVolume(page, false);
  await setLayer(page, info.layerId, {
    colormap: 'inferno',
    colormapNegative: 'blue-cyan',
    scale: { kind: 'heat', ...HEAT, negative: 'separate' },
  });
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ colorbars: true, orientationLabels: true, cornerInfo: true });
    await engine.whenSettled();
  });
  await expectGolden(page, 'slice-heat-scale');
});

// -------------------------------------------------------------------------------------------
// threshold
// -------------------------------------------------------------------------------------------

for (const leg of LEGS) {
  test(`@angle threshold (${leg.name}), softEdge 0: below \`lo\` is absent, inside is not`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    const threshold = { lo: 1000, hi: 8000, symmetric: false, mode: 'hide' as const, softEdge: 0 };
    await setLayer(page, info.layerId, {
      colormap: 'gray',
      scale: { kind: 'linear', lo: DATA_LO, hi: DATA_HI },
      threshold,
    });

    const grid = await sample(page, info.cursor);
    let below = 0;
    let inside = 0;
    let above = 0;
    for (const { pt, value, px } of grid) {
      if (value === undefined) continue;
      const label = `(${pt.join(',')}) v=${value}`;
      if (value < threshold.lo) {
        below += 1;
        expectRgb(px, info.background, 0, `${label} below lo must be discarded`);
      } else if (value > threshold.hi) {
        above += 1;
        expectRgb(px, info.background, 0, `${label} above hi must be discarded`);
      } else {
        inside += 1;
        expectRgb(
          px,
          over(linearRgba(DATA_LO, DATA_HI, value), 1, info.background),
          info.tol,
          `${label} inside the window`
        );
      }
    }
    expect(below, 'values below lo').toBeGreaterThan(20);
    expect(inside, 'values inside the window').toBeGreaterThan(10);
    expect(above, 'values above hi').toBeGreaterThan(10);
  });

  test(`@angle threshold (${leg.name}), softEdge 0.5: alpha is the smoothstep, by hand`, async ({
    page,
  }) => {
    const info = await openVolume(page, leg.norm16);
    const threshold = {
      lo: 1000,
      hi: 8000,
      symmetric: false,
      mode: 'hide' as const,
      softEdge: 0.5,
    };
    await setLayer(page, info.layerId, {
      colormap: 'gray',
      scale: { kind: 'linear', lo: DATA_LO, hi: DATA_HI },
      threshold,
    });

    const ramp = threshold.softEdge * (threshold.hi - threshold.lo);
    const grid = await sample(page, info.cursor);
    let ramped = 0;
    for (const { pt, value, px } of grid) {
      if (value === undefined) continue;
      const alpha =
        smoothstep(threshold.lo, threshold.lo + ramp, value) *
        (1 - smoothstep(threshold.hi - ramp, threshold.hi, value));
      const label = `(${pt.join(',')}) v=${value} a=${alpha.toFixed(4)}`;
      if (alpha <= 0) {
        expectRgb(px, info.background, 0, `${label} fully ramped out`);
        continue;
      }
      if (alpha > 0.02 && alpha < 0.98) ramped += 1;
      // +2 over the format tolerance: the ramp is float maths in the shader and 8-bit in the
      // framebuffer, so the blend rounds once more than a hard-edged fragment does.
      expectRgb(
        px,
        over(linearRgba(DATA_LO, DATA_HI, value), alpha, info.background),
        info.tol + 2,
        label
      );
    }
    // A soft edge that never lands strictly between 0 and 1 is a hard edge with extra uniforms.
    expect(ramped, 'partially ramped pixels').toBeGreaterThan(10);
  });

  test(`@angle threshold (${leg.name}): \`symmetric\` compares |v| (§7.3)`, async ({ page }) => {
    const info = await openVolume(page, leg.norm16);
    const threshold = { lo: 1000, hi: 9000, symmetric: true, mode: 'hide' as const, softEdge: 0 };
    await setLayer(page, info.layerId, {
      colormap: 'gray',
      scale: { kind: 'linear', lo: DATA_LO, hi: DATA_HI },
      threshold,
    });
    const grid = await sample(page, info.cursor);
    let negativeKept = 0;
    let nearZeroDropped = 0;
    for (const { pt, value, px } of grid) {
      if (value === undefined) continue;
      const label = `(${pt.join(',')}) v=${value}`;
      if (Math.abs(value) < threshold.lo || Math.abs(value) > threshold.hi) {
        nearZeroDropped += 1;
        expectRgb(px, info.background, 0, `${label} outside |v| window`);
      } else {
        if (value < 0) negativeKept += 1;
        expectRgb(
          px,
          over(linearRgba(DATA_LO, DATA_HI, value), 1, info.background),
          info.tol,
          label
        );
      }
    }
    // The whole point of `symmetric`: a negative value of large magnitude survives a positive `lo`,
    // which it never would under `v >= lo`.
    expect(negativeKept, 'negative values kept by |v| >= lo').toBeGreaterThan(10);
    expect(nearZeroDropped, 'values outside the |v| window').toBeGreaterThan(10);
  });
}

test('threshold softEdge golden', async ({ page }) => {
  const info = await openVolume(page, false);
  // A window over the positive half with a quarter-width ramp: the fixture's ±{300…8700} bands then
  // show as three visibly different alphas, which is what a regression on `softEdge` would move.
  await setLayer(page, info.layerId, {
    colormap: 'viridis',
    scale: { kind: 'linear', lo: 0, hi: 9000 },
    threshold: { lo: 1000, hi: 9000, symmetric: false, mode: 'hide', softEdge: 0.25 },
  });
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ colorbars: true, orientationLabels: true, cornerInfo: true });
    await engine.whenSettled();
  });
  await expectGolden(page, 'slice-threshold-softedge');
});

// -------------------------------------------------------------------------------------------
// interpolation — §7.2's forbidden-fallback rule: a reading, never a quality knob
// -------------------------------------------------------------------------------------------

test('@angle interpolation: LINEAR reaches the GPU and differs from NEAREST between centres', async ({
  page,
}) => {
  const info = await openVolume(page);
  const read = async (interpolation: 'linear' | 'nearest'): Promise<Uint8Array> =>
    Uint8Array.from(
      await page.evaluate(
        async ([id, mode, pane, lo, hi]) => {
          const engine = window.__tvxEngine!;
          engine.updateLayer(id as string, {
            interpolation: mode as 'linear' | 'nearest',
            colormap: 'gray',
            scale: { kind: 'linear', lo: lo as number, hi: hi as number },
          });
          await engine.whenSettled();
          engine.renderNow();
          const gl = document.querySelector('canvas')!.getContext('webgl2')!;
          const P = pane as number;
          const px = new Uint8Array(P * P * 4);
          gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return [...px];
        },
        [info.layerId, interpolation, PANE, DATA_LO, DATA_HI] as const
      )
    );
  const nearest = await read('nearest');
  const linear = await read('linear');
  let differing = 0;
  for (let i = 0; i < nearest.length; i += 4) if (nearest[i] !== linear[i]) differing += 1;
  // Trilinear over a 5×4×3 volume at 0.02 mm/px is a gradient where NEAREST is flat blocks: the two
  // must differ over a large part of the footprint, or the layer's reading never reached the GPU.
  expect(differing, 'pixels where LINEAR differs from NEAREST').toBeGreaterThan(10_000);
});
