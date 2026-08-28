/**
 * The glyph scaling model, as arithmetic (§11 rule 0: "an agent cannot judge a PNG; it can judge a
 * number"). Everything here is checked against the closed form, never against a recorded output.
 *
 * The three properties that make the overlay legend a true sentence rather than a label:
 *
 * 1. every mode is **non-decreasing** in |E| — a bigger field never draws a shorter arrow;
 * 2. every mode sends the **reference magnitude to exactly `lengthMm`**, so "1 mm = x V/m" holds;
 * 3. `log` is **floored**, and at or below the floor the length is 0 — the instance is dropped
 *    rather than drawn as a dot at a value the scale cannot place.
 */

import { describe, expect, it } from 'vitest';
import {
  glyphColorT,
  glyphLegendLine,
  glyphLengthMm,
  glyphScaling,
  glyphScalingWord,
  referenceMagnitude,
} from './glyph-scale';
import type { GlyphScaling, GlyphSpec, Stats } from '../scene/types';

const MODES = ['fixed', 'linear', 'sqrt', 'log'] as const;

function scaling(patch: Partial<GlyphScaling> = {}): GlyphScaling {
  return { mode: 'linear', lengthMm: 6, normalizeTo: 'p99', logFloor: 0.01, ...patch };
}

/** `ernie_TDCS_1_scalar.msh`'s `E`, from `scripts/reference/glyphs.py` (AGENTS.md's mesh table). */
const ERNIE_E: Stats = {
  min: 8.563626769948982e-13,
  max: 57.78990622669672,
  mean: 0,
  percentiles: {
    '0.1': 0,
    '1': 0,
    '2': 0,
    '5': 0.05,
    '50': 0.3,
    '95': 2,
    '98': 3,
    '99': 3.8457819135959825,
    '99.9': 12,
  },
  histogram: new Uint32Array(256),
  histogramLo: 0,
  histogramHi: 1,
};

function spec(patch: Partial<GlyphSpec> = {}): GlyphSpec {
  return {
    field: { source: 'elm', name: 'E' },
    shape: 'arrow',
    subsample: { everyNth: 100 },
    scale: scaling(),
    lengthMm: 6,
    colorBy: 'magnitude',
    color: [1, 1, 1, 1],
    clipToCutPlane: false,
    ...patch,
  };
}

describe('referenceMagnitude', () => {
  it('reads the field statistics p99 and max, which are of the MAGNITUDE for a vector field', () => {
    expect(referenceMagnitude(scaling({ normalizeTo: 'p99' }), ERNIE_E)).toBeCloseTo(3.84578, 5);
    expect(referenceMagnitude(scaling({ normalizeTo: 'max' }), ERNIE_E)).toBeCloseTo(57.7899, 4);
  });

  it('takes an explicit number, and `null` means "lengthMm per unit of |E|"', () => {
    expect(referenceMagnitude(scaling({ normalizeTo: 2.5 }), ERNIE_E)).toBe(2.5);
    expect(referenceMagnitude(scaling({ normalizeTo: null }), ERNIE_E)).toBe(1);
  });

  it('falls back to 1 rather than dividing by a statistic it does not have', () => {
    expect(referenceMagnitude(scaling({ normalizeTo: 'p99' }), undefined)).toBe(1);
    expect(referenceMagnitude(scaling({ normalizeTo: 0 }), ERNIE_E)).toBe(1);
    expect(referenceMagnitude(scaling({ normalizeTo: -3 }), ERNIE_E)).toBe(1);
  });
});

describe('glyphLengthMm', () => {
  it('sends the reference magnitude to exactly lengthMm, in every mode', () => {
    for (const mode of MODES) {
      expect(glyphLengthMm(scaling({ mode }), 4, 4), mode).toBeCloseTo(6, 12);
    }
  });

  it('is the closed form of each mode', () => {
    const R = 4;
    expect(glyphLengthMm(scaling({ mode: 'fixed' }), 0.5, R)).toBe(6);
    expect(glyphLengthMm(scaling({ mode: 'fixed' }), 400, R)).toBe(6);
    expect(glyphLengthMm(scaling({ mode: 'linear' }), 1, R)).toBeCloseTo(1.5, 12);
    expect(glyphLengthMm(scaling({ mode: 'sqrt' }), 1, R)).toBeCloseTo(3, 12);
    // log10(1/0.01) / log10(4/0.01) = 2 / 2.60206 = 0.76862…
    expect(glyphLengthMm(scaling({ mode: 'log', logFloor: 0.01 }), 1, R)).toBeCloseTo(
      (6 * Math.log10(100)) / Math.log10(400),
      12
    );
  });

  it('is non-decreasing in |E| across seven decades, in every mode', () => {
    const mags = Array.from({ length: 400 }, (_, i) => 1e-4 * Math.pow(10, (7 * i) / 399));
    for (const mode of MODES) {
      const s = scaling({ mode, logFloor: 0.01 });
      let prev = -1;
      for (const m of mags) {
        const L = glyphLengthMm(s, m, 3.8457819135959825);
        expect(L, `${mode} at ${m}`).toBeGreaterThanOrEqual(prev);
        prev = L;
      }
    }
  });

  it('floors log: at and below the floor there is no arrow, just above it there is', () => {
    const s = scaling({ mode: 'log', logFloor: 0.01 });
    expect(glyphLengthMm(s, 0.001, 4)).toBe(0);
    expect(glyphLengthMm(s, 0.01, 4)).toBe(0);
    expect(glyphLengthMm(s, 0.0101, 4)).toBeGreaterThan(0);
    // The reference mesh's minimum magnitude, 8.56e-13, is thirteen decades below its p99. Without a
    // floor `log` would spend twelve of them on numerical noise; with one, that element is dropped.
    expect(glyphLengthMm(s, ERNIE_E.min, 3.8457819135959825)).toBe(0);
  });

  it('leaves a floor at or above the reference as a two-valued map, not a NaN', () => {
    const s = scaling({ mode: 'log', logFloor: 10 });
    expect(glyphLengthMm(s, 5, 4)).toBe(0);
    expect(glyphLengthMm(s, 40, 4)).toBe(6);
  });

  it('gives a null vector no length except under `fixed`, which is direction-only', () => {
    expect(glyphLengthMm(scaling({ mode: 'linear' }), 0, 4)).toBe(0);
    expect(glyphLengthMm(scaling({ mode: 'log' }), 0, 4)).toBe(0);
    expect(glyphLengthMm(scaling({ mode: 'fixed' }), 0, 4)).toBe(6);
  });

  it('normalises: the same magnitude is 15x longer against p99 than against ernie E max', () => {
    // The defect the object form exists to fix. A grey-matter magnitude of 0.0182 V/m
    // (`scripts/reference/glyphs.py`, element 1178298) against the field maximum draws 0.0019 mm of
    // arrow at a 6 mm setting — invisible, and indistinguishable from a broken field lookup.
    const m = 0.01821099238544652;
    const vsMax = glyphLengthMm(scaling({ mode: 'linear' }), m, ERNIE_E.max);
    const vsP99 = glyphLengthMm(scaling({ mode: 'linear' }), m, ERNIE_E.percentiles['99']);
    expect(vsMax).toBeCloseTo(0.00189, 5);
    expect(vsP99 / vsMax).toBeCloseTo(ERNIE_E.max / ERNIE_E.percentiles['99'], 6);
    expect(vsP99 / vsMax).toBeGreaterThan(15);
  });
});

describe('glyphScaling (the legacy strings)', () => {
  it("reads 'fixed' and 'byMagnitude' as what those scenes were composed against", () => {
    expect(glyphScaling(spec({ scale: 'fixed', lengthMm: 4 }))).toEqual({
      mode: 'fixed',
      lengthMm: 4,
      normalizeTo: 'max',
      logFloor: 0,
    });
    expect(glyphScaling(spec({ scale: 'byMagnitude', lengthMm: 4 }))).toEqual({
      mode: 'linear',
      lengthMm: 4,
      normalizeTo: 'max',
      logFloor: 0,
    });
  });

  it('passes the object form through unchanged', () => {
    const s = scaling({ mode: 'sqrt', lengthMm: 9 });
    expect(glyphScaling(spec({ scale: s }))).toBe(s);
  });
});

describe('glyphLegendLine', () => {
  const info = {
    name: 'E',
    source: 'elm' as const,
    ncomp: 3 as const,
    n: 5_900_498,
    units: 'V/m',
    partial: false,
    stats: ERNIE_E,
  };

  it('states the map and the number that makes it readable', () => {
    expect(glyphLegendLine(spec({ scale: scaling({ mode: 'linear' }) }), info)).toBe(
      'E: LENGTH PROP TO MAG E, 6 MM AT 3.85 V/M'
    );
    expect(glyphLegendLine(spec({ scale: scaling({ mode: 'sqrt' }) }), info)).toBe(
      'E: LENGTH PROP TO SQRT MAG E, 6 MM AT 3.85 V/M'
    );
    expect(glyphLegendLine(spec({ scale: scaling({ mode: 'log' }) }), info)).toBe(
      'E: LENGTH PROP TO LOG10 MAG E, 0 MM AT 0.01, 6 MM AT 3.85 V/M'
    );
    expect(glyphLegendLine(spec({ scale: scaling({ mode: 'fixed' }) }), info)).toBe(
      'E: DIRECTION ONLY, 6 MM ARROWS'
    );
  });

  it('is spelled in glyphs the overlay font actually has (`render/font.ts`)', () => {
    // No lowercase, and no `|`, `~` or `=`: a missing glyph decodes as a space, so a legend written
    // with them would lose exactly the words that carry the meaning.
    const ATLAS = /^[A-Z0-9 .,:\-+/()]+$/;
    for (const mode of MODES) {
      const line = glyphLegendLine(spec({ scale: scaling({ mode }) }), info);
      expect(line, mode).toBe(line.toUpperCase());
      expect(ATLAS.test(line), `${mode}: ${line}`).toBe(true);
    }
  });

  it('names the scaling on the colour bar too, so length and colour quote one map', () => {
    expect(glyphScalingWord(spec({ scale: scaling({ mode: 'log' }) }))).toBe('LOG10');
    expect(glyphScalingWord(spec({ scale: 'byMagnitude' }))).toBe('LINEAR');
  });
});

describe('glyphColorT', () => {
  it('is the same map as the length, so a bar titled LOG10 describes its own ramp', () => {
    const s = scaling({ mode: 'log', logFloor: 0.01, lengthMm: 6 });
    for (const m of [0.05, 0.5, 1, 3.8457819135959825]) {
      expect(glyphColorT(s, m, 3.8457819135959825)).toBeCloseTo(
        glyphLengthMm(s, m, 3.8457819135959825) / 6,
        12
      );
    }
  });

  it('is linear in |E| under `fixed`, whose lengths carry nothing', () => {
    expect(glyphColorT(scaling({ mode: 'fixed' }), 2, 4)).toBeCloseTo(0.5, 12);
    expect(glyphColorT(scaling({ mode: 'fixed' }), 400, 4)).toBe(1);
  });

  it('stays inside 0..1 above the reference and below the floor', () => {
    expect(glyphColorT(scaling({ mode: 'linear' }), 400, 4)).toBe(1);
    expect(glyphColorT(scaling({ mode: 'log', logFloor: 1 }), 0.5, 4)).toBe(0);
  });

  it('lifts a cortical magnitude off the bottom of the ramp, which is the point', () => {
    // Grey matter on the reference mesh is ~0.1–0.5 V/m against a 3.85 p99: linear paints it the
    // bottom colour, log spreads it over the middle of the bar.
    const R = 3.8457819135959825;
    expect(glyphColorT(scaling({ mode: 'linear' }), 0.3, R)).toBeLessThan(0.1);
    const log = glyphColorT(scaling({ mode: 'log', logFloor: 0.01 }), 0.3, R);
    expect(log).toBeGreaterThan(0.5);
    expect(log).toBeLessThan(0.8);
  });
});
