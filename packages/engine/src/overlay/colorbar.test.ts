/**
 * §8's colour bar, without a GL context.
 *
 * `overlay/*` is pure geometry appended into an {@link OverlayBuilder}, which is what lets §11 test
 * chrome placement with numbers instead of a picture. Two things are worth asserting here and
 * nowhere else: the **spec** a volume layer produces (which value range the bar shows, where its
 * ticks and threshold notches fall) and the **placement** of the bar relative to §8's other chrome —
 * the one collision that would matter is the right-edge orientation letter, which §8 calls a
 * laterality-safety requirement rather than decoration.
 */

import { describe, expect, it } from 'vitest';
import { OverlayBuilder, FLOATS_PER_VERTEX, overlayMetrics } from './builder';
import { colorbarLayout, drawColorbar, formatTick, volumeColorbarSpec } from './colorbar';
import { bakeScale } from '../color/colormaps';
import { CELL_W } from '../render/font';
import { defaultVolumeLayer } from '../scene/defaults';
import type { Scale, Stats, vec4, VolumeDataset, VolumeLayer } from '../scene/types';

const TEXT: vec4 = [0.92, 0.94, 0.98, 1];
const PANE = { w: 384, h: 384 };

const STATS: Stats = {
  min: 0,
  max: 4,
  mean: 1,
  percentiles: {
    '0.1': 0,
    '1': 0,
    '2': 0,
    '5': 0,
    '50': 1,
    '95': 3,
    '98': 3.5,
    '99': 3.8,
    '99.9': 4,
  },
  histogram: new Uint32Array(256),
  histogramLo: 0,
  histogramHi: 4,
};

function volume(isLabel = false, units?: string): VolumeDataset {
  return {
    kind: 'volume',
    id: 'ds1',
    name: 'TI_max',
    dims: [2, 2, 2],
    nvols: 1,
    affine: new Float32Array(16),
    inverseAffine: new Float32Array(16),
    spacing: [1, 1, 1],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    dtype: 'f32',
    data: new Float32Array(8),
    sclSlope: 1,
    sclInter: 0,
    isLabel,
    stats: STATS,
    units,
    gpu: { format: 'R32F', scale: 1, offset: 0, filterable: true, chunked: false },
    headerJson: '{}',
    worker: { id: 1 },
    handle: 1,
  };
}

function layerWith(scale: Scale, patch: Partial<VolumeLayer> = {}): VolumeLayer {
  return { ...defaultVolumeLayer('layer1', volume()), scale, ...patch };
}

/** Every vertex the builder holds, as `{x, y, u, color}` in NDC. */
function vertices(b: OverlayBuilder): { x: number; y: number; u: number; rgba: number[] }[] {
  const data = b.build();
  const out: { x: number; y: number; u: number; rgba: number[] }[] = [];
  for (let i = 0; i < data.length; i += FLOATS_PER_VERTEX) {
    out.push({
      x: data[i] ?? 0,
      y: data[i + 1] ?? 0,
      u: data[i + 2] ?? 0,
      rgba: [data[i + 4] ?? 0, data[i + 5] ?? 0, data[i + 6] ?? 0, data[i + 7] ?? 0],
    });
  }
  return out;
}

/** NDC → pane pixels, the inverse of what `OverlayBuilder.begin` set up. */
function toPx(v: number, extent: number): number {
  return ((v + 1) / 2) * extent;
}

describe('volumeColorbarSpec', () => {
  it('a linear scale shows [lo, hi] with a tick at each end', () => {
    const layer = layerWith({ kind: 'linear', lo: -2, hi: 6 });
    const spec = volumeColorbarSpec(layer, volume(), bakeScale(layer.scale, 'viridis'))!;
    expect(spec.ticks.map((t) => [t.t, t.label])).toEqual([
      [0, '-2'],
      [1, '6'],
    ]);
    expect(spec.ramp.length / 4).toBe(256);
    expect(spec.notches).toEqual([]);
    expect(spec.title).toBe('TI_max');
  });

  it('units come from the dataset and are drawn with the title', () => {
    const layer = layerWith({ kind: 'linear', lo: 0, hi: 1 });
    const spec = volumeColorbarSpec(layer, volume(false, 'V/m'), bakeScale(layer.scale, 'gray'))!;
    expect(spec.units).toBe('V/m');
  });

  it("heat with negative:'hide' shows [0, max] and ticks 0 / mid / max (§8)", () => {
    const scale: Scale = {
      kind: 'heat',
      min: 1,
      mid: 2,
      max: 4,
      truncate: false,
      inverse: false,
      negative: 'hide',
    };
    const layer = layerWith(scale);
    const baked = bakeScale(scale, 'hot');
    const spec = volumeColorbarSpec(layer, volume(), baked)!;
    expect(spec.ticks.map((t) => t.label)).toEqual(['0', '2', '4']);
    expect(spec.ticks[1]?.t).toBeCloseTo(0.5, 6);
    // Half the 256-texel bake: the LUT spans [-4, 4] and only [0, 4] is displayed.
    expect(spec.ramp.length / 4).toBe(128);
  });

  it("heat with negative:'mirror' shows [-max, max] and labels the centre", () => {
    const scale: Scale = {
      kind: 'heat',
      min: 1,
      mid: 2,
      max: 4,
      truncate: false,
      inverse: false,
      negative: 'mirror',
    };
    const layer = layerWith(scale);
    const spec = volumeColorbarSpec(layer, volume(), bakeScale(scale, 'hot'))!;
    expect(spec.ticks.map((t) => t.label)).toEqual(['-4', '0', '2', '4']);
    expect(spec.ticks[1]?.t).toBeCloseTo(0.5, 6);
    expect(spec.ticks[2]?.t).toBeCloseTo(0.75, 6);
    expect(spec.ramp.length / 4).toBe(256);
  });

  it('a finite threshold becomes a notch, at its position along the displayed range', () => {
    const layer = layerWith(
      { kind: 'linear', lo: 0, hi: 10 },
      { threshold: { lo: 2, hi: 8, symmetric: false, mode: 'hide', softEdge: 0 } }
    );
    const spec = volumeColorbarSpec(layer, volume(), bakeScale(layer.scale, 'gray'))!;
    expect(spec.notches).toEqual([0.2, 0.8]);
  });

  it('the default unbounded threshold draws no notch, and neither does one at the very end', () => {
    const layer = layerWith(
      { kind: 'linear', lo: 0, hi: 10 },
      { threshold: { lo: 0, hi: Infinity, symmetric: false, mode: 'clamp', softEdge: 0 } }
    );
    const spec = volumeColorbarSpec(layer, volume(), bakeScale(layer.scale, 'gray'))!;
    expect(spec.notches).toEqual([]);
  });

  it('a label volume has no bar — it has §8’s region panel instead', () => {
    const layer = layerWith({ kind: 'linear', lo: 0, hi: 1 });
    expect(volumeColorbarSpec(layer, volume(true), bakeScale(layer.scale, 'gray'))).toBeNull();
  });

  it('`showColorbar: false` means no bar', () => {
    const layer = layerWith({ kind: 'linear', lo: 0, hi: 1 }, { showColorbar: false });
    expect(volumeColorbarSpec(layer, volume(), bakeScale(layer.scale, 'gray'))).toBeNull();
  });
});

describe('formatTick', () => {
  /** The 45 characters `render/font.ts` can draw. A glyph outside this set renders as a blank. */
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:-+/()';

  it('only ever emits characters the bitmap font has — including an UPPERCASE exponent', () => {
    for (const v of [0, 1, -1, 0.5, 3.14159, -273.15, 65535, 1e-9, -2.5e7, 1 / 3]) {
      const s = formatTick(v);
      for (const ch of s) expect(ALPHABET.includes(ch), `${v} -> ${s}: ${ch}`).toBe(true);
    }
    expect(formatTick(1.2e-9)).toBe('1.2E-9');
  });

  it('is compact and lossless enough to read a scale off', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(3.152071)).toBe('3.15');
    expect(formatTick(0.0123)).toBe('0.012');
    expect(formatTick(65535)).toBe('65535');
    expect(formatTick(-2)).toBe('-2');
  });

  it('is empty for a non-finite edge rather than drawing INFINITY', () => {
    expect(formatTick(Infinity)).toBe('');
    expect(formatTick(NaN)).toBe('');
  });
});

describe('drawColorbar — placement', () => {
  const m = overlayMetrics(PANE.w, PANE.h, 1);

  function bar(slot = 0): OverlayBuilder {
    const layer = layerWith(
      { kind: 'linear', lo: 0, hi: 10 },
      { threshold: { lo: 2, hi: 8, symmetric: false, mode: 'hide', softEdge: 0 } }
    );
    const spec = volumeColorbarSpec(layer, volume(), bakeScale(layer.scale, 'gray'))!;
    const b = new OverlayBuilder();
    b.begin(PANE.w, PANE.h);
    drawColorbar(b, m, spec, TEXT, slot);
    return b;
  }

  it('draws something, and every vertex lands inside the pane', () => {
    const vs = vertices(bar());
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) {
      expect(toPx(v.x, PANE.w)).toBeGreaterThanOrEqual(0);
      expect(toPx(v.x, PANE.w)).toBeLessThanOrEqual(PANE.w);
      expect(toPx(v.y, PANE.h)).toBeGreaterThanOrEqual(0);
      expect(toPx(v.y, PANE.h)).toBeLessThanOrEqual(PANE.h);
    }
  });

  it('leaves §8’s right-edge orientation letter its cell', () => {
    // `overlay/letters.ts` puts the right letter at `width - pad - CELL_W`, vertically centred.
    const letterLeft = PANE.w - m.pad - CELL_W * m.scale;
    const solid = vertices(bar()).filter((v) => v.u < 0);
    for (const v of solid) expect(toPx(v.x, PANE.w)).toBeLessThanOrEqual(letterLeft);
  });

  it('the ramp is one row per bar pixel, painting the LUT bottom-to-top', () => {
    const layout = colorbarLayout(m, 'right');
    const layer = layerWith({ kind: 'linear', lo: 0, hi: 10 });
    const baked = bakeScale(layer.scale, 'gray');
    const spec = volumeColorbarSpec(layer, volume(), baked)!;
    const b = new OverlayBuilder();
    b.begin(PANE.w, PANE.h);
    drawColorbar(b, m, spec, TEXT, 0);
    const solid = vertices(b).filter((v) => v.u < 0);
    // 2 backing rects + `length` ramp rows, six vertices each; the ticks are text (u >= 0).
    expect(solid.length).toBe((2 + layout.length) * 6);
    // Bottom row is the LUT's dark end, top row its bright end — the bar reads low-to-high upward.
    const rows = solid.slice(12); // skip the two backing rects
    expect(rows[0]?.rgba[0]).toBeLessThan(0.02);
    expect(rows[rows.length - 1]?.rgba[0]).toBeGreaterThan(0.98);
  });

  it('clears the RAD/NEU badge: nothing of the bar reaches the top text line', () => {
    // The badge is drawn on the first line under the top edge (`overlay/letters.ts`); the bar's
    // title is the highest thing it draws, and it starts one full line below that.
    const badgeBottom = PANE.h - m.pad - m.lineH;
    for (const v of vertices(bar())) expect(toPx(v.y, PANE.h)).toBeLessThan(badgeBottom);
  });

  it('stacking moves the bar down by one pitch and nothing else', () => {
    const layout = colorbarLayout(m, 'right');
    const first = vertices(bar(0)).filter((v) => v.u < 0);
    const second = vertices(bar(1)).filter((v) => v.u < 0);
    expect(second.length).toBe(first.length);
    // The builder stores NDC in a Float32Array, so a pane pixel round-trips to ~4e-6; assert to a
    // thousandth of a pixel, which is three orders finer than anything that could be a layout bug.
    for (let i = 0; i < first.length; i += 1) {
      expect(toPx(second[i]!.x, PANE.w)).toBeCloseTo(toPx(first[i]!.x, PANE.w), 3);
      expect(toPx(first[i]!.y, PANE.h) - toPx(second[i]!.y, PANE.h)).toBeCloseTo(layout.pitch, 3);
    }
  });

  it('a threshold notch is drawn across the bar at its own fraction of the length', () => {
    const layout = colorbarLayout(m, 'right');
    const withNotch = vertices(bar()).filter((v) => v.u < 0).length;
    const layer = layerWith({ kind: 'linear', lo: 0, hi: 10 });
    const spec = volumeColorbarSpec(layer, volume(), bakeScale(layer.scale, 'gray'))!;
    const b = new OverlayBuilder();
    b.begin(PANE.w, PANE.h);
    drawColorbar(b, m, spec, TEXT, 0);
    const without = vertices(b).filter((v) => v.u < 0).length;
    // Two notches (lo and hi), six vertices each.
    expect(withNotch - without).toBe(12);
    expect(layout.length).toBeGreaterThan(0);
  });
});
