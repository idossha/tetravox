/**
 * The shared line geometry (§13.4: every kernel is a pure function with a vitest).
 *
 * The cases here are the ones whose answer can be derived on paper — a perfectly straight shaft, a
 * known perpendicular offset, a known gap — so a failure names the defect rather than a tolerance.
 * The numpy cross-check on the real phantom is `modules/seeg-fixtures.test.ts`, which replays
 * `testdata/manifest.json`'s `seeg` block.
 */

import { describe, expect, it } from 'vitest';
import type { vec3 } from '@tetravox/engine';
import {
  canonicaliseAxis,
  centroidOf,
  distanceMm,
  dominantEigenvector,
  fitLine,
  lineMetrics,
  median,
  orderAlong,
  projectOntoLine,
  respaceEven,
  sortedGaps,
  standardDeviation,
} from './geometry';

/** `n` points from `start` along a unit direction, `pitch` apart. */
function shaft(start: vec3, dir: vec3, pitch: number, n: number): vec3[] {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const u: vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  return Array.from(
    { length: n },
    (_v, i) =>
      [
        start[0] + u[0] * pitch * i,
        start[1] + u[1] * pitch * i,
        start[2] + u[2] * pitch * i,
      ] as vec3
  );
}

describe('fitLine', () => {
  it('recovers a perfectly straight shaft with zero residual', () => {
    const points = shaft([1, 2, 3], [0.25, 0.35, 0.9], 3.5, 6);
    const fit = fitLine(points);
    expect(fit).not.toBeNull();
    expect((fit as { rmsMm: number }).rmsMm).toBeCloseTo(0, 10);
    // The axis is the shaft's direction, up to the canonical sign.
    const len = Math.hypot(0.25, 0.35, 0.9);
    const expected = [0.25 / len, 0.35 / len, 0.9 / len];
    for (let i = 0; i < 3; i += 1) {
      expect((fit as { axis: vec3 }).axis[i]).toBeCloseTo(expected[i] as number, 9);
    }
    // Projections are the arc length: 0, 3.5, 7 … about the centroid.
    const t = (fit as { t: number[] }).t;
    for (let i = 1; i < t.length; i += 1) {
      expect((t[i] as number) - (t[i - 1] as number)).toBeCloseTo(3.5, 9);
    }
  });

  it('reports the RMS of a known perpendicular offset', () => {
    // Four points along x, offset ±0.2 mm in y in a pattern whose covariance with x is exactly
    // zero — so the fitted line IS the x axis and every residual is 0.2 mm. (The alternating
    // pattern is not symmetric that way: it tilts the fit and the RMS comes out below 0.2.)
    const points: vec3[] = [
      [0, 0.2, 0],
      [1, -0.2, 0],
      [2, -0.2, 0],
      [3, 0.2, 0],
    ];
    expect((fitLine(points) as { rmsMm: number }).rmsMm).toBeCloseTo(0.2, 9);
  });

  it('is null for fewer than two points', () => {
    expect(fitLine([])).toBeNull();
    expect(fitLine([[1, 1, 1]])).toBeNull();
  });

  it('pins the axis sign, so a fixture compares numbers and not a tie-break', () => {
    const forward = fitLine(shaft([0, 0, 0], [0, 0, 1], 2, 4));
    const backward = fitLine(shaft([0, 0, 6], [0, 0, -1], 2, 4));
    // The same physical line walked in the other direction gives the same canonical axis.
    expect((forward as { axis: vec3 }).axis).toEqual((backward as { axis: vec3 }).axis);
    expect((forward as { axis: vec3 }).axis[2]).toBeGreaterThan(0);
  });
});

describe('canonicaliseAxis', () => {
  it('makes the largest-magnitude component positive', () => {
    expect(canonicaliseAxis([-0.9, 0.3, 0.1])).toEqual([0.9, -0.3, -0.1]);
    expect(canonicaliseAxis([0.1, -0.9, 0.3])).toEqual([-0.1, 0.9, -0.3]);
  });

  it('breaks an exact tie on the earlier component', () => {
    expect(canonicaliseAxis([-0.5, 0.5, 0])).toEqual([0.5, -0.5, -0]);
  });
});

describe('dominantEigenvector', () => {
  it('finds the axis of a diagonal matrix', () => {
    expect(dominantEigenvector([1, 0, 0, 0, 9, 0, 0, 0, 4])).toEqual([0, 1, 0]);
  });

  it('finds the axis of a rank-one outer product', () => {
    // v vᵀ for v = (3, 4, 0)/5 scaled by 25: the dominant eigenvector is v itself.
    const v = [3, 4, 0];
    const m = [9, 12, 0, 12, 16, 0, 0, 0, 0];
    const axis = dominantEigenvector(m);
    const len = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
    for (let i = 0; i < 3; i += 1) {
      expect(axis[i]).toBeCloseTo((v[i] as number) / len, 9);
    }
  });
});

describe('lineMetrics', () => {
  it('reports zero RMS, zero CV and the true pitch on an even shaft', () => {
    const metrics = lineMetrics(shaft([0, 0, 0], [1, 0, 0], 3.5, 8));
    expect(metrics?.rmsMm).toBeCloseTo(0, 10);
    expect(metrics?.spacingCv).toBeCloseTo(0, 10);
    expect(metrics?.pitchMm).toBeCloseTo(3.5, 10);
  });

  it('takes the MEDIAN gap, so one missing contact does not move the pitch', () => {
    const even = shaft([0, 0, 0], [1, 0, 0], 3.5, 8);
    const gapped = [...even.slice(0, 3), ...even.slice(4)];
    expect(lineMetrics(gapped)?.pitchMm).toBeCloseTo(3.5, 10);
    // …and the CV notices, which is the number that is supposed to say "something is off".
    expect(lineMetrics(gapped)?.spacingCv).toBeGreaterThan(0.2);
  });

  it('reports no CV for two contacts, because one gap has no dispersion', () => {
    const metrics = lineMetrics([
      [0, 0, 0],
      [3.5, 0, 0],
    ]);
    expect(metrics?.spacingCv).toBeNull();
    expect(metrics?.pitchMm).toBeCloseTo(3.5, 10);
  });
});

describe('median, standardDeviation, sortedGaps', () => {
  it('averages the two middle values of an even-length list, like numpy', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it('is the POPULATION standard deviation (ddof = 0)', () => {
    // numpy: np.std([1, 2, 3, 4]) == 1.118033988749895
    expect(standardDeviation([1, 2, 3, 4])).toBeCloseTo(1.118033988749895, 12);
  });

  it('sorts before differencing, so the input order cannot matter', () => {
    expect(sortedGaps([3, 0, 1])).toEqual([1, 2]);
  });
});

describe('projectOntoLine, orderAlong, respaceEven', () => {
  it('drops a point onto the line it is beside', () => {
    expect(projectOntoLine([2, 5, 0], [0, 0, 0], [1, 0, 0])).toEqual([2, 0, 0]);
  });

  it('orders by projection, not by array order', () => {
    const points: vec3[] = [
      [6, 0, 0],
      [0, 0, 0],
      [3, 0, 0],
    ];
    expect(orderAlong(points)).toEqual([1, 2, 0]);
  });

  it('re-spaces at the median gap, in ascending order along the line', () => {
    const points: vec3[] = [
      [0, 0, 0],
      [3.4, 0.1, 0],
      [7.1, -0.1, 0],
      [10.4, 0, 0],
    ];
    const spaced = respaceEven(points) as vec3[];
    expect(spaced).toHaveLength(4);
    const gaps = [1, 2, 3].map((i) => distanceMm(spaced[i - 1] as vec3, spaced[i] as vec3));
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0] as number, 9);
    // Every re-spaced point is on the fitted line, so the RMS collapses.
    expect(lineMetrics(spaced)?.rmsMm).toBeCloseTo(0, 9);
  });

  it('is null when there is no line to fit', () => {
    expect(respaceEven([[1, 1, 1]])).toBeNull();
    expect(centroidOf([])).toBeNull();
  });
});
