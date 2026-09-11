/** Authored percentile anchors pin display conversion, independently of voxel statistics computation.
 * Run: pnpm exec vitest run packages/app/src/renderer/src/panels/layers/volume/threshold-percentiles.test.ts
 */
import { describe, expect, it } from 'vitest';
import { percentToValue, valueToPercent } from './threshold-percentiles';

const stats = {
  min: -20,
  max: 1000,
  percentiles: {
    '0.1': -10,
    '1': 0,
    '2': 5,
    '5': 10,
    '50': 100,
    '95': 400,
    '98': 550,
    '99': 650,
    '99.9': 900,
  },
};

describe('threshold percentile conversion', () => {
  it('preserves every stored percentile and both endpoints', () => {
    for (const [percent, value] of Object.entries(stats.percentiles)) {
      expect(percentToValue(stats, Number(percent))).toBe(value);
      expect(valueToPercent(stats, value)).toBe(Number(percent));
    }
    expect(percentToValue(stats, 0)).toBe(-20);
    expect(percentToValue(stats, 100)).toBe(1000);
    expect(valueToPercent(stats, -20)).toBe(0);
    expect(valueToPercent(stats, 1000)).toBe(100);
  });

  it('estimates between adjacent anchors, rather than using a fraction of the intensity range', () => {
    // Halfway between p5=10 and p50=100; halfway between p95=400 and p98=550.
    expect(percentToValue(stats, 27.5)).toBe(55);
    expect(valueToPercent(stats, 55)).toBe(27.5);
    expect(percentToValue(stats, 96.5)).toBe(475);
    expect(valueToPercent(stats, 475)).toBe(96.5);
  });

  it('clamps out-of-range inputs and maps unlimited bounds to endpoints', () => {
    for (const input of [-Infinity, -1]) expect(percentToValue(stats, input)).toBe(-20);
    for (const input of [Infinity, 101]) expect(percentToValue(stats, input)).toBe(1000);
    for (const input of [-Infinity, -21]) expect(valueToPercent(stats, input)).toBe(0);
    for (const input of [Infinity, 1001]) expect(valueToPercent(stats, input)).toBe(100);
    expect(percentToValue(stats, NaN)).toBeNaN();
    expect(valueToPercent(stats, NaN)).toBeNaN();
  });

  it('uses the earliest percentile for a tied interior value without dividing by zero', () => {
    const tied = { ...stats, percentiles: { ...stats.percentiles, '50': 10 } };
    expect(percentToValue(tied, 27.5)).toBe(10);
    expect(valueToPercent(tied, 10)).toBe(5);
    expect(valueToPercent(tied, 205)).toBe(72.5);
  });

  it('keeps constant volumes finite and preserves unlimited upper bounds', () => {
    const constant = {
      min: 7,
      max: 7,
      percentiles: {
        '0.1': 7,
        '1': 7,
        '2': 7,
        '5': 7,
        '50': 7,
        '95': 7,
        '98': 7,
        '99': 7,
        '99.9': 7,
      },
    };
    expect(percentToValue(constant, 63)).toBe(7);
    expect(valueToPercent(constant, 7)).toBe(0);
    expect(valueToPercent(constant, Infinity)).toBe(100);
  });
});
