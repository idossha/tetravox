/**
 * The four §8 histogram presets.
 *
 * A preset is a lookup into `Stats.percentiles`, so the assertion that matters is *which* percentile
 * each one reads — an off-by-one between `2–98 %` and `p50–p99.9` produces a plausible-looking window
 * that is silently the wrong one. Every expected value below is written as the percentile it must
 * come from, never as the number that percentile happens to hold.
 */

import { describe, expect, it } from 'vitest';
import type { PercentileKey, Stats } from '@tetravox/engine';
import { PRESETS, activePreset, applyPreset, normalizeWindow } from './presets';

/** Distinct, irregular values so a wrong percentile can never coincide with the right one. */
const P: Record<PercentileKey, number> = {
  '0.1': -37.5,
  '1': -12.25,
  '2': -3.5,
  '5': 4.75,
  '50': 118.5,
  '95': 902.25,
  '98': 1104.5,
  '99': 1301.75,
  '99.9': 1750.125,
};

const STATS: Stats = {
  min: -41.807507,
  max: 65535,
  mean: 312.5,
  percentiles: P,
  histogram: new Uint32Array(256),
  histogramLo: -41.807507,
  histogramHi: 65535,
};

describe('the §8 presets', () => {
  it('offers exactly the four §8 names, in §8’s order', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['min-max', 'p2-p98', 'p50-p99.9', 'sym-p99']);
  });

  it('min–max is Stats.min … Stats.max, not p0.1 … p99.9', () => {
    expect(applyPreset('min-max', STATS)).toEqual({ lo: STATS.min, hi: STATS.max });
  });

  it('2–98 % reads percentiles 2 and 98', () => {
    expect(applyPreset('p2-p98', STATS)).toEqual({ lo: P['2'], hi: P['98'] });
  });

  it('p50–p99.9 reads percentiles 50 and 99.9', () => {
    expect(applyPreset('p50-p99.9', STATS)).toEqual({ lo: P['50'], hi: P['99.9'] });
  });

  it('symmetric ±p99 is centred on zero and reads p99 alone', () => {
    expect(applyPreset('sym-p99', STATS)).toEqual({ lo: -P['99'], hi: P['99'] });
  });

  it('symmetric ±p99 uses the magnitude, so an all-negative field still gets a window', () => {
    const negative: Stats = { ...STATS, percentiles: { ...P, '99': -8 } };
    expect(applyPreset('sym-p99', negative)).toEqual({ lo: -8, hi: 8 });
  });
});

describe('normalizeWindow', () => {
  it('orders the pair', () => {
    expect(normalizeWindow({ lo: 9, hi: 2 })).toEqual({ lo: 2, hi: 9 });
  });

  it('never returns a zero-width window, because every consumer divides by it', () => {
    const w = normalizeWindow({ lo: 5, hi: 5 });
    expect(w.hi).toBeGreaterThan(w.lo);
    expect(w.hi - w.lo).toBeLessThan(1e-3);
  });
});

describe('activePreset', () => {
  it('names the preset a window already is', () => {
    expect(activePreset(applyPreset('p2-p98', STATS), STATS)).toBe('p2-p98');
    expect(activePreset(applyPreset('sym-p99', STATS), STATS)).toBe('sym-p99');
  });

  it('is null once the user has dragged a handle', () => {
    const w = applyPreset('p2-p98', STATS);
    expect(activePreset({ lo: w.lo, hi: w.hi + 1000 }, STATS)).toBeNull();
  });

  it('survives a round trip through a four-decimal number field', () => {
    const w = applyPreset('p50-p99.9', STATS);
    const typed = { lo: Number(w.lo.toFixed(4)), hi: Number(w.hi.toFixed(4)) };
    expect(activePreset(typed, STATS)).toBe('p50-p99.9');
  });
});
