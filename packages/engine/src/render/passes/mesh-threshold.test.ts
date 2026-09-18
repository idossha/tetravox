/**
 * §4.2's mesh value gate with **one open bound** — the arithmetic half of the 2026-09-18 fix.
 *
 * The shader gates `alpha *= smoothstep(lo, lo + soft, v) * (1 - smoothstep(hi - soft, hi, v))`, so
 * a fragment inside the window survives only when `soft` is small against the data. Before the fix
 * `soft` was floored at `1e-6 · |hi − lo|` with `hi = 3.4e38` standing in for `null`, i.e. ~3.4e32,
 * and every value in any imaging field sat at the very bottom of the lower ramp: `hide` with
 * `hi: null` hid the whole layer. The expectations below evaluate the shader's own formula on the
 * uniforms the pass now sends.
 */

import { describe, expect, it } from 'vitest';
import { thresholdUniforms } from './mesh';
import type { Scale, Threshold } from '../../scene/types';

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** The shader's gate, evaluated on the CPU with the uniforms the pass sends. */
function gate(t: Threshold, scale: Scale, v: number): number {
  const u = thresholdUniforms(t, scale);
  return smoothstep(u.lo, u.lo + u.soft, v) * (1 - smoothstep(u.hi - u.soft, u.hi, v));
}

const ROI_SCALE: Scale = { kind: 'linear', lo: 0, hi: 0.127891 };
const OPEN_HI: Threshold = { lo: 1e-6, hi: Infinity, symmetric: false, mode: 'hide', softEdge: 0 };

describe('thresholdUniforms (§4.2, one open bound)', () => {
  it('`hi: null` keeps every value above `lo` — TI-Toolbox’s roi_overlay scene', () => {
    // Values the ROI field actually takes: zero outside the ROI, up to the ROI max inside it.
    expect(gate(OPEN_HI, ROI_SCALE, 0)).toBe(0);
    expect(gate(OPEN_HI, ROI_SCALE, 0.01)).toBe(1);
    expect(gate(OPEN_HI, ROI_SCALE, 0.127891)).toBe(1);
    expect(gate(OPEN_HI, ROI_SCALE, 5)).toBe(1);
  });

  it('measures the ramp against the colour scale, not against the F32 sentinel', () => {
    const u = thresholdUniforms(OPEN_HI, ROI_SCALE);
    expect(u.lo).toBe(1e-6);
    expect(u.hi).toBeGreaterThan(1e38);
    // The floor is 1e-6 of the scale span, not 1e-6 of 3.4e38.
    expect(u.soft).toBeCloseTo(0.127891 * 1e-6, 12);
  });

  it('with `softEdge > 0` the ramp is a fraction of the colour scale span', () => {
    const t: Threshold = { ...OPEN_HI, softEdge: 0.5 };
    const u = thresholdUniforms(t, ROI_SCALE);
    expect(u.soft).toBeCloseTo(0.5 * 0.127891, 12);
    expect(gate(t, ROI_SCALE, 1e-6 + 0.5 * 0.127891)).toBe(1);
    expect(gate(t, ROI_SCALE, 1e-6 + 0.25 * 0.127891)).toBeCloseTo(0.5, 6);
  });

  it('`lo: null` mirrors it: everything below `hi` survives', () => {
    const t: Threshold = { lo: -Infinity, hi: 0.05, symmetric: false, mode: 'hide', softEdge: 0 };
    expect(gate(t, ROI_SCALE, -100)).toBe(1);
    expect(gate(t, ROI_SCALE, 0.04)).toBe(1);
    expect(gate(t, ROI_SCALE, 0.06)).toBe(0);
  });

  it('two finite bounds are unchanged: the ramp is a fraction of `hi - lo`', () => {
    const t: Threshold = { lo: 1, hi: 3, symmetric: false, mode: 'hide', softEdge: 0.25 };
    const u = thresholdUniforms(t, ROI_SCALE);
    expect(u).toEqual({ lo: 1, hi: 3, soft: 0.5 });
  });

  it('a heat scale uses `max - min`, and a degenerate scale falls back to 1', () => {
    const heat: Scale = {
      kind: 'heat',
      min: 0,
      mid: 1,
      max: 4,
      truncate: false,
      inverse: false,
      negative: 'hide',
    };
    expect(thresholdUniforms({ ...OPEN_HI, softEdge: 0.5 }, heat).soft).toBe(2);
    const flat: Scale = { kind: 'linear', lo: 2, hi: 2 };
    expect(thresholdUniforms({ ...OPEN_HI, softEdge: 0.5 }, flat).soft).toBe(0.5);
  });
});
