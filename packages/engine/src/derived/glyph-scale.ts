/**
 * The **glyph scaling model** — one function, shared by the renderer, the colour bar, the overlay
 * legend and the app editor, so none of the four can describe a different arrow than the one drawn.
 *
 * §4.4's `GlyphSpec.scale` used to be `'fixed' | 'byMagnitude'`, and `'byMagnitude'` normalised to
 * the field's **maximum**. On `ernie_TDCS_1_scalar.msh` that is 57.7899 V/m against a 99th
 * percentile of 1.2 V/m `[DATA]`, so every arrow but the few in the electrode gel came out under
 * 2 % of `lengthMm` — the picture was empty and the knob had no useful setting. The object form
 * (added 2026-08-28, see `docs/DECISIONS.md`) separates the three decisions that were tangled in
 * that one word:
 *
 * * **`mode`** — the shape of the map from magnitude to length;
 * * **`normalizeTo`** — the magnitude that maps to `lengthMm` (`'p99'`, `'max'`, an explicit number,
 *   or `null` for "`lengthMm` per unit of |E|", the only setting whose arrows are in field units);
 * * **`logFloor`** — where `log` bottoms out, in field units. A logarithm has no zero, so a floor is
 *   not a nicety: without one `mode: 'log'` on a field whose minimum is 8.56e-13 (`E` on the
 *   reference mesh `[DATA]`) spans thirteen decades and spends twelve of them on numerical noise.
 *
 * Every mode is **non-decreasing** in |E| and every one sends the reference magnitude to exactly
 * `lengthMm`, which is what makes the legend line ("1 mm = …") a true statement rather than a label.
 * `packages/engine/src/derived/glyph-scale.test.ts` asserts both properties on all four modes.
 */

import type { GlyphScaling, GlyphSpec, MeshFieldInfo, Stats } from '../scene/types';

/** Smallest reference magnitude worth dividing by; below it a field is all noise. */
const TINY = 1e-20;

/** §4.4's default scaling: the one the app opens a new `GlyphSpec` with. */
export const DEFAULT_GLYPH_LENGTH_MM = 6;

/**
 * The scaling a spec asks for, in object form.
 *
 * The legacy `'fixed' | 'byMagnitude'` strings are still valid `GlyphSpec.scale` values — a scene
 * saved before 2026-08-28 round-trips — and mean exactly what they meant: `'fixed'` is
 * `mode: 'fixed'`, `'byMagnitude'` is `mode: 'linear'` normalised to the field **max**, which is
 * the behaviour those scenes were composed against.
 */
export function glyphScaling(spec: GlyphSpec): GlyphScaling {
  const s = spec.scale;
  if (typeof s !== 'string') return s;
  return {
    mode: s === 'fixed' ? 'fixed' : 'linear',
    lengthMm: spec.lengthMm,
    normalizeTo: 'max',
    logFloor: 0,
  };
}

/**
 * The magnitude that maps to `lengthMm`.
 *
 * `stats` is the field's own — of the **magnitude** when `ncomp > 1` (§4.4's `MeshFieldInfo`), which
 * is exactly the quantity an arrow's length stands for, so no percentile has to be recomputed here.
 */
export function referenceMagnitude(scaling: GlyphScaling, stats: Stats | undefined): number {
  const n = scaling.normalizeTo;
  if (n === null) return 1;
  if (typeof n === 'number') return Number.isFinite(n) && n > 0 ? n : 1;
  if (stats === undefined) return 1;
  const v = n === 'max' ? stats.max : stats.percentiles['99'];
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Arrow length in **millimetres** for one magnitude.
 *
 * `ref` is {@link referenceMagnitude}'s answer; `L(ref) === lengthMm` in every mode, which the unit
 * test pins. `log` returns 0 at and below the floor — an arrow of zero length is the honest picture
 * of a value the scale cannot place, and the shader drops it rather than drawing a dot.
 */
export function glyphLengthMm(scaling: GlyphScaling, mag: number, ref: number): number {
  const L = scaling.lengthMm;
  if (!Number.isFinite(mag) || mag <= 0) return scaling.mode === 'fixed' ? L : 0;
  const R = Math.max(TINY, ref);
  switch (scaling.mode) {
    case 'fixed':
      return L;
    case 'linear':
      return (L * mag) / R;
    case 'sqrt':
      return L * Math.sqrt(mag / R);
    case 'log': {
      const f = Math.max(TINY, scaling.logFloor);
      if (mag <= f) return 0;
      const denom = Math.log10(R / f);
      // A floor at or above the reference leaves no decades to spread over; everything above the
      // floor then gets the full length, which is `fixed` restricted to the values that qualify.
      if (!(denom > 0)) return L;
      return (L * Math.log10(mag / f)) / denom;
    }
  }
}

/**
 * Where a magnitude sits on the glyph colour ramp, 0..1.
 *
 * **The colour follows the same map as the length**, which is why the colour bar can be titled with
 * the scaling at all. A ramp that stayed linear under a `LOG10` bar would be a bar that lies: on
 * `ernie_TDCS_1_scalar.msh` grey matter runs 0.1–0.5 V/m against a 3.85 p99, so a linear ramp paints
 * the entire cortex the bottom colour while the arrows — correctly — spread over most of the length
 * range. One quantity, one map, two encodings of it.
 *
 * `fixed` is the exception: its lengths carry no information, so its colour is linear in |E|, which
 * is the only encoding of magnitude that mode has.
 */
export function glyphColorT(scaling: GlyphScaling, mag: number, ref: number): number {
  if (scaling.mode === 'fixed') {
    return clamp01(mag / Math.max(TINY, ref));
  }
  return clamp01(glyphLengthMm(scaling, mag, ref) / Math.max(TINY, scaling.lengthMm));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * §8's legend line: "arrow length ∝ log10|E|, 1 mm = …", in the alphabet the overlay font has.
 *
 * `render/font.ts`'s atlas is `A-Z 0-9 space . , : - + / ( )` — no lowercase, and **no `|`, `~` or
 * `=`**. A missing glyph decodes as a space, so `LENGTH ~ |E| = 6 MM` would reach the picture as
 * `LENGTH   E    6 MM`: the words that carry the meaning, silently gone. Hence `MAG E`, `PROP TO`
 * and `AT`, which are spelled in glyphs that exist. The app editor shows the same sentence.
 */
export function glyphLegendLine(
  spec: GlyphSpec,
  info: MeshFieldInfo | undefined,
  /** `GlyphSpec.in2D`: the drawn vector is the in-plane component, and the key says so. */
  inPlane = false
): string {
  const scaling = glyphScaling(spec);
  const ref = referenceMagnitude(scaling, info?.stats);
  const name = spec.field.name.toUpperCase();
  // The key's label says where the vector was projected; the map itself is still "MAG E".
  const label = (inPlane ? 'IN-PLANE ' : '') + name;
  const units = info?.units !== undefined ? ` ${info.units.toUpperCase()}` : '';
  const L = scaling.lengthMm;
  switch (scaling.mode) {
    case 'fixed':
      return `${label}: DIRECTION ONLY, ${fmt(L)} MM ARROWS`;
    case 'linear':
      return `${label}: LENGTH PROP TO MAG ${name}, ${fmt(L)} MM AT ${fmt(ref)}${units}`;
    case 'sqrt':
      return `${label}: LENGTH PROP TO SQRT MAG ${name}, ${fmt(L)} MM AT ${fmt(ref)}${units}`;
    case 'log': {
      const f = Math.max(TINY, scaling.logFloor);
      return `${label}: LENGTH PROP TO LOG10 MAG ${name}, 0 MM AT ${fmt(f)}, ${fmt(L)} MM AT ${fmt(ref)}${units}`;
    }
  }
}

/** The word a colour bar puts beside the field name, so the bar says which map it is describing. */
export function glyphScalingWord(spec: GlyphSpec): string {
  const m = glyphScaling(spec).mode;
  return m === 'fixed' ? 'FIXED' : m === 'linear' ? 'LINEAR' : m === 'sqrt' ? 'SQRT' : 'LOG10';
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 100000 || a < 0.001) return v.toExponential(1).toUpperCase();
  if (a >= 100) return String(Math.round(v));
  if (a >= 1) return trim(v.toFixed(2));
  return trim(v.toFixed(3));
}

function trim(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
