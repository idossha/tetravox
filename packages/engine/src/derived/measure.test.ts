/**
 * `derived/measure.ts` — the arithmetic a measurement *is* (directed task 11).
 *
 * §11 rule 0: an agent cannot judge a picture, it can judge a number. These are the numbers, and
 * they are checked against closed forms — a 3-4-5 triangle, a right angle between world axes, an
 * equilateral triangle's 60° — rather than against whatever the implementation happens to print.
 */

import { describe, expect, it } from 'vitest';
import {
  angleDeg,
  distanceMm,
  formatMeasurement,
  formatMeasurementHtml,
  measurementFocus,
  measurementValue,
  nextMeasurementName,
  pointsNeeded,
} from './measure';
import type { Measurement, vec3 } from '../scene/types';

const m = (kind: Measurement['kind'], points: vec3[]): Measurement => ({
  id: 'x',
  kind,
  name: 'M1',
  points,
});

describe('distanceMm', () => {
  it('is the Euclidean world distance', () => {
    // 3-4-5, offset off the origin so a forgotten subtraction cannot pass.
    expect(distanceMm([10, 20, 30], [13, 24, 30])).toBeCloseTo(5, 12);
    expect(distanceMm([0, 0, 0], [1, 2, 2])).toBeCloseTo(3, 12);
  });

  it('is symmetric, and zero for a point on itself', () => {
    const a: vec3 = [-84.436612, 136.15704, -128.860523];
    const b: vec3 = [83.3978, -92.398125, 99.951712];
    expect(distanceMm(a, b)).toBeCloseTo(distanceMm(b, a), 12);
    expect(distanceMm(a, a)).toBe(0);
  });

  it('is the ernie bounding box diagonal, to the millimetre', () => {
    // `docs/TESTING.md`'s node bbox for `m2m_ernie/ernie.msh` — a real number, not a made-up one.
    const min: vec3 = [-84.436612, -92.398125, -128.860523];
    const max: vec3 = [83.3978, 136.15704, 99.951712];
    expect(distanceMm(min, max)).toBeCloseTo(
      Math.sqrt(167.834412 ** 2 + 228.555165 ** 2 + 228.812235 ** 2),
      6
    );
  });
});

describe('angleDeg', () => {
  it('is 90° between two world axes', () => {
    expect(angleDeg([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 12);
    expect(angleDeg([0, 5, 0], [0, 0, 0], [0, 0, 7])).toBeCloseTo(90, 12);
  });

  it('is 60° in an equilateral triangle and 180° for a straight line', () => {
    const a: vec3 = [0, 0, 0];
    const b: vec3 = [1, 0, 0];
    const c: vec3 = [0.5, Math.sqrt(3) / 2, 0];
    expect(angleDeg(b, a, c)).toBeCloseTo(60, 10);
    expect(angleDeg([-1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(180, 10);
    expect(angleDeg([1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(0, 10);
  });

  it('does not lose precision near 0° and 180°, where the acos form does', () => {
    // 1e-6 rad off collinear. `acos(dot)` here is evaluated where |derivative| ~ 1e6, and the
    // argument can round to exactly 1; `atan2(|u x v|, u.v)` is conditioned uniformly.
    const eps = 1e-6;
    expect(angleDeg([1, 0, 0], [0, 0, 0], [Math.cos(eps), Math.sin(eps), 0])).toBeCloseTo(
      (eps * 180) / Math.PI,
      9
    );
    expect(angleDeg([1, 0, 0], [0, 0, 0], [-Math.cos(eps), Math.sin(eps), 0])).toBeCloseTo(
      180 - (eps * 180) / Math.PI,
      9
    );
  });

  it('is 0, never NaN, for a zero-length arm', () => {
    expect(angleDeg([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBe(0);
    expect(Number.isNaN(angleDeg([0, 0, 0], [0, 0, 0], [0, 0, 0]))).toBe(false);
  });

  it('is scale-invariant — the arms are directions, not lengths', () => {
    const wide = angleDeg([1000, 0, 0], [0, 0, 0], [0, 0.001, 0]);
    expect(wide).toBeCloseTo(90, 10);
  });
});

describe('measurementValue', () => {
  it('reports millimetres for a distance and degrees for an angle', () => {
    expect(
      measurementValue(
        m('distance', [
          [0, 0, 0],
          [3, 4, 0],
        ])
      )
    ).toEqual({
      value: 5,
      unit: 'mm',
    });
    const angle = measurementValue(
      m('angle', [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
      ])
    );
    expect(angle.unit).toBe('deg');
    expect(angle.value).toBeCloseTo(90, 12);
  });

  it('is 0 rather than NaN for an incomplete measurement', () => {
    expect(measurementValue(m('distance', [[0, 0, 0]]))).toEqual({ value: 0, unit: 'mm' });
    expect(
      measurementValue(
        m('angle', [
          [0, 0, 0],
          [1, 0, 0],
        ])
      )
    ).toEqual({ value: 0, unit: 'deg' });
  });
});

describe('formatMeasurement', () => {
  it('uses only characters the §7.2 bitmap font has', () => {
    // `render/font.ts`'s CHARS. A lower-case `mm` or a `°` would draw as blanks.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:-+/()';
    const label = formatMeasurement(
      m('distance', [
        [0, 0, 0],
        [3, 4, 0],
      ])
    );
    expect(label).toBe('5.0 MM');
    for (const ch of label) expect(alphabet).toContain(ch);
    const angle = formatMeasurement(
      m('angle', [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
      ])
    );
    expect(angle).toBe('90.0 DEG');
    for (const ch of angle) expect(alphabet).toContain(ch);
  });

  it('spells the same number properly for the DOM', () => {
    expect(
      formatMeasurementHtml(
        m('distance', [
          [0, 0, 0],
          [3, 4, 0],
        ])
      )
    ).toBe('5.0 mm');
    expect(
      formatMeasurementHtml(
        m('angle', [
          [1, 0, 0],
          [0, 0, 0],
          [0, 1, 0],
        ])
      )
    ).toBe('90.0 °');
  });
});

describe('measurementFocus', () => {
  it('is the midpoint of a segment and the vertex of an angle', () => {
    expect(
      measurementFocus(
        m('distance', [
          [0, 0, 0],
          [4, 6, 8],
        ])
      )
    ).toEqual([2, 3, 4]);
    expect(
      measurementFocus(
        m('angle', [
          [1, 0, 0],
          [9, 9, 9],
          [0, 1, 0],
        ])
      )
    ).toEqual([9, 9, 9]);
  });
});

describe('nextMeasurementName', () => {
  it('counts up, and reuses a name a delete freed', () => {
    expect(nextMeasurementName([])).toBe('M1');
    const one = m('distance', []);
    expect(nextMeasurementName([{ ...one, name: 'M1' }])).toBe('M2');
    expect(
      nextMeasurementName([
        { ...one, name: 'M1' },
        { ...one, name: 'M3' },
      ])
    ).toBe('M2');
  });
});

describe('pointsNeeded', () => {
  it('is two for a distance and three for an angle', () => {
    expect(pointsNeeded('distance')).toBe(2);
    expect(pointsNeeded('angle')).toBe(3);
  });
});
