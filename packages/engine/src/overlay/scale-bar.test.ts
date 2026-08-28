/**
 * §11 for the scale bar's pure half: the snap, and where the bar lands in the pane.
 *
 * The claim under test is the one a reader of a screenshot relies on — **the drawn length in pixels
 * is exactly `mm / mmPerPx`** — so nothing here compares the module to itself: the expected pixel
 * length is that division, written out, and the expected millimetres are read off the 1-2-5 ladder by
 * hand.
 */

import { describe, expect, it } from 'vitest';
import { OverlayBuilder, overlayMetrics } from './builder';
import {
  SCALE_BAR_MAX_PX,
  SCALE_BAR_MIN_PX,
  SCALE_BAR_STEPS,
  drawScaleBar,
  scaleBarLayout,
  snapScaleBar,
} from './scale-bar';

describe('snapScaleBar', () => {
  it('picks the rung a reader can divide by, at four zooms', () => {
    // Hand-computed: the first rung whose `mm / mmPerPx` lands in [60, 160].
    expect(snapScaleBar(0.1)).toEqual({ mm: 10, px: 100 });
    expect(snapScaleBar(0.05)).toEqual({ mm: 5, px: 100 });
    expect(snapScaleBar(0.5)).toEqual({ mm: 50, px: 100 });
    expect(snapScaleBar(0.02)).toEqual({ mm: 2, px: 100 });
  });

  it('the drawn length is the division, never a rounded one', () => {
    for (const mmPerPx of [0.037, 0.11, 0.29, 0.83, 0.41]) {
      const { mm, px } = snapScaleBar(mmPerPx);
      expect(px).toBeCloseTo(mm / mmPerPx, 12);
    }
  });

  it('lands inside the readable window everywhere the ladder spans', () => {
    // 1 mm at 160 px through 100 mm at 60 px — every zoom the ladder can serve.
    for (let mmPerPx = 1 / SCALE_BAR_MAX_PX; mmPerPx <= 100 / SCALE_BAR_MIN_PX; mmPerPx *= 1.03) {
      const { mm, px } = snapScaleBar(mmPerPx);
      expect(SCALE_BAR_STEPS).toContain(mm);
      expect(px).toBeGreaterThanOrEqual(SCALE_BAR_MIN_PX);
      expect(px).toBeLessThanOrEqual(SCALE_BAR_MAX_PX);
    }
  });

  it('past the ends of the ladder it takes the closest rung rather than inventing one', () => {
    // Zoomed so far out that even 100 mm is 10 px: 100 mm is still the closest rung.
    expect(snapScaleBar(10)).toEqual({ mm: 100, px: 10 });
    // Zoomed so far in that even 1 mm is 1000 px.
    expect(snapScaleBar(0.001)).toEqual({ mm: 1, px: 1000 });
  });

  it('a non-positive mmPerPx is treated as 1 rather than dividing by zero', () => {
    expect(Number.isFinite(snapScaleBar(0).px)).toBe(true);
    expect(Number.isFinite(snapScaleBar(-1).px)).toBe(true);
  });
});

describe('scaleBarLayout', () => {
  it('sits in the bottom-right corner, one pad off both edges', () => {
    const m = overlayMetrics(512, 512, 1);
    const l = scaleBarLayout(m, 0.1);
    expect(l.x + l.px).toBe(m.widthPx - m.pad);
    expect(l.y).toBe(m.pad);
  });

  it('scales its furniture with the DPR but not its length', () => {
    const one = scaleBarLayout(overlayMetrics(512, 512, 1), 0.1);
    const two = scaleBarLayout(overlayMetrics(512, 512, 2), 0.1);
    expect(two.px).toBe(one.px);
    expect(two.thickness).toBeGreaterThan(one.thickness);
    expect(two.capHeight).toBeGreaterThan(one.capHeight);
  });
});

describe('drawScaleBar', () => {
  it('appends geometry — bar, two caps, a plate and a labelled string', () => {
    const b = new OverlayBuilder();
    b.begin(512, 512);
    drawScaleBar(b, overlayMetrics(512, 512, 1), 0.1, [1, 1, 1, 1], [0, 0, 0, 1]);
    // 4 rects = 24 vertices, plus `10 MM` at 5 glyphs × 5 draws (4 halo + 1) × 6 vertices.
    expect(b.vertexCount).toBe(24 + 5 * 5 * 6);
  });
});
