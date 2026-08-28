/**
 * The measurement item of §7.2's pass 3 — directed task 11 (2026-08-28).
 *
 * A `Measurement` (§4.5) is world points; this file is the pure layout that turns already-projected
 * **pane pixels** into the quads and the label the overlay pass draws. Like every module in this
 * directory it takes an {@link OverlayBuilder} and returns nothing, so §11 can assert its geometry
 * with no GL context at all.
 *
 * Three things are deliberate:
 *
 * * **Constant screen width.** `gl.lineWidth()` is a no-op — `ALIASED_LINE_WIDTH_RANGE` is `[1,1]`
 *   `[M2Max]` — so the segment is screen-space quad expansion (§7.0.6), exactly like the crosshair
 *   and the gizmo. Its width is in overlay pixels scaled by `OverlayMetrics.scale`, which is what
 *   keeps a measurement two pixels wide at every zoom instead of a hairline when zoomed out and a
 *   ribbon when zoomed in.
 * * **The endpoints are drawn.** A segment with no ends is a line, and a user cannot see which pixel
 *   the click actually landed on — which is the one thing they need to see to trust the number.
 * * **The label sits beside the geometry, not on it.** Text drawn over its own line is unreadable at
 *   any halo strength. A segment's label is lifted off the midpoint; an angle's is pushed out along
 *   the **bisector**, which is by construction the direction furthest from both arms. See
 *   {@link measureLabelAnchor} — §11 caught the naive placement by decoding a right angle's label
 *   as `90.0LDEG`, the `L` being the arm running up through the space.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import { GLYPH_H } from '../render/font';
import type { Plane, vec3, vec4 } from '../scene/types';

/** Segment width, in unscaled overlay pixels. */
export const MEASURE_WIDTH_PX = 2;
/** Half-width of an endpoint's square marker, in unscaled overlay pixels. */
export const MEASURE_ENDPOINT_PX = 3;
/**
 * How far off a 2D pane's plane a point may be and still be drawn in it, in millimetres.
 *
 * A 2D pane shows one plane, and a measurement whose points are 40 mm away from it is not *in* that
 * pane — drawing it anyway is the smear §7.2's point-label slab exists to prevent. Half a
 * millimetre is under the finest voxel in the reference dataset (`label_prep/*` is 0.5 mm), so a
 * point clicked in the pane is always inside it while a point from the neighbouring slice is not.
 */
export const MEASURE_SLAB_MM = 0.5;

/** A measurement, already projected into one pane. Pane pixels, origin **bottom-left**. */
export interface PlacedMeasurement {
  points: [number, number][];
  /** What `derived/measure.ts`'s `formatMeasurement` produced — upper case, the font's alphabet. */
  label: string;
}

/** True when `p` is close enough to `plane` to belong to the pane that draws it. */
export function onPlane(plane: Plane, p: vec3, slabMm = MEASURE_SLAB_MM): boolean {
  const d = plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] + plane.offset;
  return Math.abs(d) <= slabMm;
}

/** A thick screen-space segment, as one quad — §7.0.6's expansion, the gizmo's arcs' primitive. */
function segment(
  b: OverlayBuilder,
  a: [number, number],
  c: [number, number],
  halfWidth: number,
  color: vec4
): void {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  b.quad(
    [a[0] + nx, a[1] + ny],
    [c[0] + nx, c[1] + ny],
    [c[0] - nx, c[1] - ny],
    [a[0] - nx, a[1] - ny],
    color
  );
}

/**
 * Draw one placed measurement: its segments, a marker on every endpoint, and its label.
 *
 * Two points give one segment; three give two, sharing the vertex — the angle's arms, which is what
 * makes the picture say *which* angle the number is about.
 */
export function drawMeasurement(
  b: OverlayBuilder,
  m: OverlayMetrics,
  placed: PlacedMeasurement,
  color: vec4
): void {
  const half = (MEASURE_WIDTH_PX * m.scale) / 2;
  const tick = MEASURE_ENDPOINT_PX * m.scale;
  const pts = placed.points;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    segment(b, pts[i] as [number, number], pts[i + 1] as [number, number], half, color);
  }
  for (const p of pts) b.rect(p[0] - tick, p[1] - tick, tick * 2, tick * 2, color);

  if (placed.label === '' || pts.length < 2) return;
  const at = measureLabelAnchor(pts, m);
  if (at === null) return;
  b.labelWithHalo(placed.label, at[0], at[1], m.scale, color, 'center');
}

/**
 * Where a measurement's label goes: its **lower-left** corner in pane pixels, centred horizontally
 * on the anchor, or `null` when there is nothing to label.
 *
 * Exported because §11 decodes the label back out of the framebuffer and has to know where to look,
 * and because the rule is worth stating once rather than twice:
 *
 * * a **segment** is labelled at its midpoint, lifted clear of the line — above it when the segment
 *   runs upward on screen, above by a further glyph height when it runs downward, so the text never
 *   straddles the rule it names;
 * * an **angle** is labelled along the **outward bisector** of its two arms. Not at the vertex: the
 *   arms meet there, and a label lifted straight up from a vertex whose arm also goes straight up is
 *   drawn over that arm — which §11 caught, decoding the space in `90.0 DEG` as a glyph. The
 *   bisector is by construction the direction that is furthest from both arms.
 */
export function measureLabelAnchor(
  pts: readonly [number, number][],
  m: OverlayMetrics
): [number, number] | null {
  const tick = MEASURE_ENDPOINT_PX * m.scale;
  if (pts.length >= 3) {
    const v = pts[1] as [number, number];
    const dir = bisector(pts[0] as [number, number], v, pts[2] as [number, number]);
    const r = MEASURE_LABEL_GAP_PX * m.scale;
    // Vertically centred on the offset point, so the text reads as attached to the corner.
    return [v[0] + dir[0] * r, v[1] + dir[1] * r - (GLYPH_H * m.scale) / 2];
  }
  const a = pts[0] as [number, number];
  const c = pts[1] as [number, number];
  const lift = tick + 2 * m.scale + (c[1] - a[1] > 0 ? 0 : GLYPH_H * m.scale);
  return [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2 + lift];
}

/** How far from the vertex an angle's label sits, in unscaled overlay pixels. */
export const MEASURE_LABEL_GAP_PX = 16;

/** The unit vector bisecting the angle `a-v-b`, pointing **away** from both arms. */
function bisector(a: [number, number], v: [number, number], b: [number, number]): [number, number] {
  const unit = (p: [number, number]): [number, number] => {
    const dx = p[0] - v[0];
    const dy = p[1] - v[1];
    const l = Math.hypot(dx, dy);
    return l > 1e-6 ? [dx / l, dy / l] : [0, 0];
  };
  const u = unit(a);
  const w = unit(b);
  // The arms' directions sum to the inward bisector; negate it to point out of the corner. For a
  // straight angle the sum is zero, and any perpendicular will do — take the arm's normal.
  const sx = -(u[0] + w[0]);
  const sy = -(u[1] + w[1]);
  const l = Math.hypot(sx, sy);
  if (l > 1e-6) return [sx / l, sy / l];
  return [-u[1], u[0]];
}

/**
 * Height of a measurement's label in pane pixels — what a caller needs to know it fits.
 *
 * Exported for the same reason `labelHeightPx` is in `point-labels.ts`: the pass places these and a
 * placement that cannot say how tall its text is cannot avoid running off the top of a pane.
 */
export function measureLabelHeightPx(m: OverlayMetrics): number {
  return GLYPH_H * m.scale;
}
