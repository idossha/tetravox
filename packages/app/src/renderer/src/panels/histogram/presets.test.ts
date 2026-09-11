/**
 * The shared scalar histogram presets.
 *
 * A preset is a lookup into `Stats.percentiles`, so the assertion that matters is *which* percentile
 * each one reads — an off-by-one between `1–99%` and `p50–p99.9` produces a plausible-looking window
 * that is silently the wrong one. Every expected value below is written as the percentile it must
 * come from, never as the number that percentile happens to hold.
 */

import { describe, expect, it } from 'vitest';
import type { PercentileKey, Stats } from '@tetravox/engine';
import { SCALAR_PRESETS, activePreset, applyPreset, normalizeWindow } from './presets';

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

describe('the scalar presets', () => {
  it('offers exactly the broad, upper-half and upper-tail windows', () => {
    expect(SCALAR_PRESETS.map((p) => p.id)).toEqual(['p1-p99', 'p50-p99.9', 'p95-p99.9']);
  });

  it('uses percentile endpoints rather than percentages of the value range', () => {
    expect(applyPreset('p1-p99', STATS)).toEqual({ lo: P['1'], hi: P['99'] });
    expect(applyPreset('p50-p99.9', STATS)).toEqual({ lo: P['50'], hi: P['99.9'] });
    expect(applyPreset('p95-p99.9', STATS)).toEqual({ lo: P['95'], hi: P['99.9'] });
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
    expect(activePreset(applyPreset('p1-p99', STATS), STATS)).toBe('p1-p99');
    expect(activePreset(applyPreset('p95-p99.9', STATS), STATS)).toBe('p95-p99.9');
  });

  it('is null once the user has dragged a handle', () => {
    const w = applyPreset('p1-p99', STATS);
    expect(activePreset({ lo: w.lo, hi: w.hi + 1000 }, STATS)).toBeNull();
  });

  it('survives a round trip through a four-decimal number field', () => {
    const w = applyPreset('p50-p99.9', STATS);
    const typed = { lo: Number(w.lo.toFixed(4)), hi: Number(w.hi.toFixed(4)) };
    expect(activePreset(typed, STATS)).toBe('p50-p99.9');
  });
});

describe('custom preset choices', () => {
  it('only recognizes choices offered by the current editor', () => {
    const tailOnly = SCALAR_PRESETS.filter((preset) => preset.id === 'p95-p99.9');
    expect(activePreset({ lo: P['95'], hi: P['99.9'] }, STATS, 1e-4, tailOnly)).toBe('p95-p99.9');
    expect(activePreset({ lo: P['1'], hi: P['99'] }, STATS, 1e-4, tailOnly)).toBeNull();
  });
});
