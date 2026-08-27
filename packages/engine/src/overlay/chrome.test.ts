/**
 * The §8 2D chrome is "a laterality-safety requirement, not decoration", and §11 asserts it by
 * decoding it back out of the framebuffer (`test/helpers/chrome.ts`). That test needs a GL context.
 * This one does not: chrome placement is a pure function of the pane, so its invariants can be
 * checked on the vertex buffer itself, which is where a layout regression starts.
 */

import { describe, expect, it } from 'vitest';
import { badgeFor } from './badge';
import { OverlayBuilder, FLOATS_PER_VERTEX, overlayMetrics } from './builder';
import { buildChrome } from './chrome';
import { drawCrosshair } from './crosshair';
import { GLYPH_H } from '../render/font';
import type { vec4 } from '../scene/types';

const WHITE: vec4 = [1, 1, 1, 1];
const YELLOW: vec4 = [1, 0.85, 0.2, 0.9];

/** Every vertex as `[ndcX, ndcY, u, v, r, g, b, a]`. */
function vertices(b: OverlayBuilder): number[][] {
  const data = b.build();
  const out: number[][] = [];
  for (let i = 0; i < data.length; i += FLOATS_PER_VERTEX) {
    out.push(Array.from(data.subarray(i, i + FLOATS_PER_VERTEX)));
  }
  return out;
}

describe('overlayMetrics', () => {
  it('rounds the font scale up to at least 1 and derives padding from it', () => {
    expect(overlayMetrics(100, 50, 0.4)).toEqual({
      widthPx: 100,
      heightPx: 50,
      scale: 1,
      pad: 4,
      lineH: GLYPH_H + 3,
    });
    expect(overlayMetrics(100, 50, 2)).toEqual({
      widthPx: 100,
      heightPx: 50,
      scale: 2,
      pad: 8,
      lineH: (GLYPH_H + 3) * 2,
    });
  });
});

describe('drawCrosshair', () => {
  it('is two full-span quads, never LINES (§7.0.6)', () => {
    const b = new OverlayBuilder();
    b.begin(200, 100);
    drawCrosshair(b, overlayMetrics(200, 100, 1), { x: 100, y: 50 }, YELLOW);
    const v = vertices(b);
    // Two rects, six vertices each; `u < 0` marks a solid quad rather than a font sample.
    expect(v).toHaveLength(12);
    expect(v.every((p) => (p[2] as number) < 0)).toBe(true);
    // The horizontal bar spans the whole pane: NDC x reaches both -1 and +1.
    const xs = v.slice(0, 6).map((p) => p[0]);
    expect(Math.min(...(xs as number[]))).toBe(-1);
    expect(Math.max(...(xs as number[]))).toBe(1);
    // The vertical bar spans the whole pane in y.
    const ys = v.slice(6).map((p) => p[1]);
    expect(Math.min(...(ys as number[]))).toBe(-1);
    expect(Math.max(...(ys as number[]))).toBe(1);
  });
});

describe('badgeFor', () => {
  it('is the radiological flag and nothing else (§8: not optional)', () => {
    expect(badgeFor(false)).toBe('NEU');
    expect(badgeFor(true)).toBe('RAD');
  });
});

describe('buildChrome', () => {
  const full = {
    widthPx: 512,
    heightPx: 384,
    uiScale: 1,
    letters: { left: 'L', right: 'R', top: 'A', bottom: 'P' },
    cornerLines: ['AXIAL', 'RAS -0.7 18.0 6.0', 'SLICE 104'],
    badge: 'NEU' as const,
    crosshair: { x: 233, y: 100 },
    crosshairColor: YELLOW,
    textColor: WHITE,
  };

  it('emits every item, and each one is separable by its vertex count', () => {
    const count = (input: Parameters<typeof buildChrome>[1]): number => {
      const b = new OverlayBuilder();
      b.begin(input.widthPx, input.heightPx);
      buildChrome(b, input);
      return b.vertexCount;
    };
    const all = count(full);
    // Each glyph is 6 vertices, drawn 5× by `labelWithHalo` (4 halo offsets + the glyph).
    const glyph = 6 * 5;
    expect(all - count({ ...full, crosshair: null })).toBe(12);
    expect(all - count({ ...full, letters: undefined })).toBe(4 * glyph);
    expect(all - count({ ...full, badge: undefined })).toBe(3 * glyph);
    const cornerChars = full.cornerLines.join('').length;
    expect(all - count({ ...full, cornerLines: undefined })).toBe(cornerChars * glyph);
  });

  it('draws the active border last, as four rects', () => {
    const withBorder = new OverlayBuilder();
    withBorder.begin(full.widthPx, full.heightPx);
    buildChrome(withBorder, { ...full, activeBorder: [0.35, 0.62, 1, 1] });
    const without = new OverlayBuilder();
    without.begin(full.widthPx, full.heightPx);
    buildChrome(without, full);
    expect(withBorder.vertexCount - without.vertexCount).toBe(24);
    // "Last" matters: nothing may paint over the active-pane accent.
    const tail = vertices(withBorder).slice(-24);
    const f32 = (x: number): number => Math.fround(x);
    expect(tail.every((p) => p[4] === f32(0.35) && p[5] === f32(0.62) && p[6] === 1)).toBe(true);
  });

  it('is pure — the same input twice is the same buffer', () => {
    const once = new OverlayBuilder();
    once.begin(full.widthPx, full.heightPx);
    buildChrome(once, full);
    const twice = new OverlayBuilder();
    twice.begin(full.widthPx, full.heightPx);
    buildChrome(twice, full);
    expect(Array.from(twice.build())).toEqual(Array.from(once.build()));
  });
});
