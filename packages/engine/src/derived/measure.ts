/**
 * Measurement arithmetic — directed task 11 (2026-08-28).
 *
 * Everything a `Measurement` (§4.5) *means* is in this file, and it is pure: a length, an angle,
 * the string the overlay prints and the point §8's jump-to sends the cursor to. Nothing here knows
 * about GL, about panes, or about the pointer.
 *
 * **The length is a world distance, not a screen one.** §3 fixes one world — scanner RAS
 * millimetres — and the two clicks that made a segment were turned into world points by
 * `paneToWorld` (2D) or by the pick (3D) before they ever reached a `Measurement`. So the number
 * does not move when the pane is zoomed, when the convention flips to radiological, or when the
 * same segment is read off the 3D pane. A viewer that measured in pixels and multiplied by
 * `mmPerPx` would be right only for a point that happens to lie on the plane it was clicked in, and
 * silently wrong for every 3D pick.
 *
 * **The label is upper case, and that is not a style choice.** §7.2's pass-3 font
 * (`render/font.ts`) is a 5×7 bitmap over `A-Z 0-9 .,:-+/()` — there are no lower-case cells and no
 * degree sign, so `12.3 mm` would draw as two blanks and `45°` as one. `MM` and `DEG` are what the
 * atlas can actually say, and §11's chrome decoder reads them straight back out.
 */

import type { Measurement, vec3 } from '../scene/types';

/** Straight-line world distance in millimetres. */
export function distanceMm(a: vec3, b: vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/**
 * The angle at `vertex` between the rays to `a` and to `b`, in **degrees**, 0..180.
 *
 * Computed with `atan2(|u × v|, u · v)` rather than `acos(u · v / |u||v|)`. The two agree in exact
 * arithmetic and do not agree in floating point: near 0° and near 180° the cosine form loses most
 * of its significant digits (the derivative of `acos` is unbounded there) and can be handed an
 * argument fractionally outside `[-1, 1]`, which is `NaN`. The `atan2` form is conditioned
 * uniformly over the whole range and cannot leave it.
 *
 * A zero-length arm has no angle; that is `0`, not `NaN`, so a degenerate double-click reads as a
 * degenerate measurement instead of blanking the label.
 */
export function angleDeg(a: vec3, vertex: vec3, b: vec3): number {
  const u: vec3 = [a[0] - vertex[0], a[1] - vertex[1], a[2] - vertex[2]];
  const v: vec3 = [b[0] - vertex[0], b[1] - vertex[1], b[2] - vertex[2]];
  const cross: vec3 = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const sin = Math.hypot(cross[0], cross[1], cross[2]);
  const cos = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (sin === 0 && cos === 0) return 0;
  return (Math.atan2(sin, cos) * 180) / Math.PI;
}

/** What a measurement is worth, and in what unit. `0 mm` for one that has too few points. */
export function measurementValue(m: Pick<Measurement, 'kind' | 'points'>): {
  value: number;
  unit: 'mm' | 'deg';
} {
  const [a, b, c] = m.points;
  if (m.kind === 'angle') {
    if (a === undefined || b === undefined || c === undefined) return { value: 0, unit: 'deg' };
    return { value: angleDeg(a, b, c), unit: 'deg' };
  }
  if (a === undefined || b === undefined) return { value: 0, unit: 'mm' };
  return { value: distanceMm(a, b), unit: 'mm' };
}

/**
 * The overlay's label: one decimal, then the unit, in the only alphabet §7.2's font has.
 *
 * One decimal because that is the precision the numbers deserve — a click is a pixel, and a pixel
 * is `mmPerPx` millimetres wide (0.5 mm at the ernie fit) — and because it is what §8's corner
 * `RAS` readout already prints.
 */
export function formatMeasurement(m: Pick<Measurement, 'kind' | 'points'>): string {
  const { value, unit } = measurementValue(m);
  return `${value.toFixed(1)} ${unit === 'mm' ? 'MM' : 'DEG'}`;
}

/** The same number for §8's panel, where the DOM can spell `mm` and `°` properly. */
export function formatMeasurementHtml(m: Pick<Measurement, 'kind' | 'points'>): string {
  const { value, unit } = measurementValue(m);
  return `${value.toFixed(1)} ${unit === 'mm' ? 'mm' : '°'}`;
}

/**
 * Where §8's jump-to sends the cursor: the segment's midpoint, or an angle's **vertex**.
 *
 * The vertex rather than a centroid, because the vertex is the thing an angle is about — a centroid
 * of three points is a location nothing was clicked at.
 */
export function measurementFocus(m: Pick<Measurement, 'kind' | 'points'>): vec3 | null {
  const [a, b, c] = m.points;
  if (m.kind === 'angle') return b ?? null;
  if (a === undefined || b === undefined) return a ?? null;
  void c;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** How many points a kind is complete at. */
export function pointsNeeded(kind: Measurement['kind']): number {
  return kind === 'angle' ? 3 : 2;
}

/**
 * `M1`, `M2`, … — the first name not already taken.
 *
 * Derived from the existing names rather than from a counter, so deleting `M2` and measuring again
 * gives `M2` back instead of `M4`, and so a loaded scene's names are never duplicated.
 */
export function nextMeasurementName(existing: readonly Measurement[]): string {
  const taken = new Set(existing.map((m) => m.name));
  for (let i = 1; ; i += 1) {
    const name = `M${i}`;
    if (!taken.has(name)) return name;
  }
}
