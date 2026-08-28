/**
 * The histogram widget's arithmetic.
 *
 * Every expectation here is *derived* — the round trip `valueAtX(xForValue(v))`, the definition of
 * `log1p`, the half-plane a handle's tolerance describes — rather than a number copied out of a run.
 * That is §11 rule 0 applied to a DOM widget: an agent cannot judge a picture of a histogram, but it
 * can judge whether the pixel under the pointer is the value the layer was patched with.
 */

import { describe, expect, it } from 'vitest';
import type { Stats } from '@tetravox/engine';
import {
  axisRange,
  barHeights,
  dragHandle,
  formatValue,
  handleAt,
  valueAtX,
  xForValue,
} from './geometry';
import type { HandleValues, PlotBox } from './geometry';

const BOX: PlotBox = { width: 256, height: 64 };

function stats(over: Partial<Stats> = {}): Stats {
  return {
    min: -10,
    max: 90,
    mean: 40,
    percentiles: {
      '0.1': -9,
      '1': -8,
      '2': -6,
      '5': 0,
      '50': 40,
      '95': 80,
      '98': 85,
      '99': 88,
      '99.9': 89.5,
    },
    histogram: new Uint32Array(256),
    histogramLo: -10,
    histogramHi: 90,
    ...over,
  };
}

describe('the x axis', () => {
  it('is the stats range, so a handle drag never moves the axis under its own pointer', () => {
    const s = stats();
    expect(axisRange(s)).toEqual({ lo: s.histogramLo, hi: s.histogramHi });
  });

  it('widens a degenerate range rather than dividing by zero', () => {
    const a = axisRange(stats({ histogramLo: 7, histogramHi: 7 }));
    expect(a.hi).toBeGreaterThan(a.lo);
  });

  it('maps the endpoints to the box edges and the midpoint to the middle', () => {
    const s = stats();
    expect(xForValue(-10, s, BOX)).toBe(0);
    expect(xForValue(90, s, BOX)).toBe(BOX.width);
    expect(xForValue(40, s, BOX)).toBeCloseTo(BOX.width / 2, 10);
  });

  it('round-trips value → x → value', () => {
    const s = stats();
    for (const v of [-10, -3.25, 0, 17.5, 89.75, 90]) {
      expect(valueAtX(xForValue(v, s, BOX), s, BOX)).toBeCloseTo(v, 9);
    }
  });

  it('clamps a drag that left the widget, so a pointer at x = −500 pins to the low end', () => {
    const s = stats();
    expect(valueAtX(-500, s, BOX)).toBe(s.histogramLo);
    expect(valueAtX(BOX.width + 500, s, BOX)).toBe(s.histogramHi);
  });
});

describe('bar heights', () => {
  const counts = Uint32Array.from([0, 1, 9, 99, 999]);
  // The result is a `Float32Array` — 24 bits of mantissa — so five decimals is the honest tolerance
  // for a height in the tens, not a fudge factor.
  const F32 = 5;

  it('is count / max on a linear axis', () => {
    const h = barHeights(counts, BOX, false);
    expect(h[0]).toBe(0);
    expect(h[4]).toBe(BOX.height);
    expect(h[3]).toBeCloseTo((99 / 999) * BOX.height, F32);
  });

  it('is log1p(count) / log1p(max) on a log axis — an empty bin is exactly zero', () => {
    const h = barHeights(counts, BOX, true);
    expect(h[0]).toBe(0);
    expect(h[4]).toBeCloseTo(BOX.height, F32);
    expect(h[2]).toBeCloseTo((Math.log1p(9) / Math.log1p(999)) * BOX.height, F32);
  });

  it('lifts the small bins the linear axis buries — that is the toggle’s whole point', () => {
    const linear = barHeights(counts, BOX, false);
    const log = barHeights(counts, BOX, true);
    expect(linear[1] as number).toBeLessThan(0.1);
    expect(log[1] as number).toBeGreaterThan(1);
  });

  it('is all zero when every bin is empty, rather than NaN', () => {
    expect([...barHeights(new Uint32Array(4), BOX, true)]).toEqual([0, 0, 0, 0]);
  });
});

describe('grabbing a handle', () => {
  const s = stats();
  const values: HandleValues = { window: { lo: -10, hi: 90 }, threshold: { lo: 15, hi: 65 } };

  it('finds the handle under the pointer', () => {
    expect(handleAt(xForValue(15, s, BOX), values, s, BOX)).toBe('thresholdLo');
    expect(handleAt(xForValue(65, s, BOX), values, s, BOX)).toBe('thresholdHi');
    expect(handleAt(xForValue(-10, s, BOX), values, s, BOX)).toBe('windowLo');
    expect(handleAt(xForValue(90, s, BOX), values, s, BOX)).toBe('windowHi');
  });

  it('grabs nothing in open ground', () => {
    expect(handleAt(xForValue(40, s, BOX), values, s, BOX)).toBeNull();
  });

  it('prefers the threshold when a window handle sits on top of it', () => {
    const stacked: HandleValues = { window: { lo: 15, hi: 90 }, threshold: { lo: 15, hi: 65 } };
    expect(handleAt(xForValue(15, s, BOX), stacked, s, BOX)).toBe('thresholdLo');
  });

  it('offers no threshold handles when the layer has no threshold', () => {
    const none: HandleValues = { window: { lo: -10, hi: 90 }, threshold: null };
    expect(handleAt(xForValue(15, s, BOX), none, s, BOX)).toBeNull();
  });
});

describe('dragging a handle', () => {
  const s = stats();
  const values: HandleValues = { window: { lo: -10, hi: 90 }, threshold: { lo: 15, hi: 65 } };

  it('moves the grabbed handle to the value under the pointer and leaves the other alone', () => {
    const next = dragHandle('windowLo', xForValue(20, s, BOX), values, s, BOX);
    expect(next.window.lo).toBeCloseTo(20, 9);
    expect(next.window.hi).toBe(90);
    expect(next.threshold).toEqual(values.threshold);
  });

  it('pushes rather than swaps, so the user keeps the handle they grabbed', () => {
    const past = dragHandle('windowLo', xForValue(90 + 50, s, BOX), values, s, BOX);
    expect(past.window.lo).toBe(90);
    expect(past.window.hi).toBe(90);
  });

  it('moves a threshold handle without touching the window', () => {
    const next = dragHandle('thresholdHi', xForValue(30, s, BOX), values, s, BOX);
    expect(next.threshold?.hi).toBeCloseTo(30, 9);
    expect(next.threshold?.lo).toBe(15);
    expect(next.window).toEqual(values.window);
  });

  it('is a no-op on a threshold handle when there is no threshold', () => {
    const none: HandleValues = { window: { lo: -10, hi: 90 }, threshold: null };
    expect(dragHandle('thresholdLo', 100, none, s, BOX)).toBe(none);
  });
});

describe('tick formatting', () => {
  it('spends digits where the span needs them', () => {
    expect(formatValue(1234.5678, 5000)).toBe('1235');
    expect(formatValue(1.234567, 2)).toBe('1.23');
    expect(formatValue(0.001234, 0.01)).toBe('0.0012');
  });

  it('goes exponential where a fixed notation would be all zeros or all digits', () => {
    expect(formatValue(655350, 655400)).toBe('6.55e+5');
    expect(formatValue(8.563626769948982e-13, 57.8)).toBe('8.56e-13');
  });

  it('says so when there is no number', () => {
    expect(formatValue(Number.NaN, 1)).toBe('—');
  });
});
