/**
 * The contour item's **screen-space geometry, as a pure function** — the CPU twin of
 * `shaders/contour.ts`'s vertex shader.
 *
 * §7.0.6 makes `contourWidthPx` "instanced screen-space quad expansion, never `LINES` +
 * `lineWidth`", and §11's obligation on it is a measured width in pixels at two zooms. A pixel
 * assertion proves the drawn result; this function proves the *arithmetic* without a GL context, so
 * a regression in the expansion is a failing unit test rather than a two-pixel difference in a
 * golden that `maxDiffPixelRatio: 0.002` would swallow.
 *
 * The two must stay in step, and they do because they are the same four lines: project both
 * endpoints, take the screen-space direction, expand along its perpendicular by half the width, and
 * extend along it by the cap. Everything here is in **render-target pixels** with the pane's own
 * origin at its centre, which is what the shader's `(clip.xy / clip.w) · 0.5 · viewport` computes.
 */

import type { mat4, vec2, vec3 } from '../scene/types';

/** The four corners of one expanded segment, in pane pixels with the origin at the pane's centre. */
export interface ContourQuad {
  /** `(t, side)` order: `(0,−1)`, `(0,+1)`, `(1,−1)`, `(1,+1)` — the `TRIANGLE_STRIP` the shader draws. */
  corners: [vec2, vec2, vec2, vec2];
  /** Perpendicular width in pixels — always `widthPx`, which is the point of the whole mechanism. */
  widthPx: number;
}

function project(viewProj: mat4, p: vec3, viewport: vec2): vec2 | null {
  const w =
    (viewProj[3] ?? 0) * p[0] +
    (viewProj[7] ?? 0) * p[1] +
    (viewProj[11] ?? 0) * p[2] +
    (viewProj[15] ?? 1);
  if (w <= 0) return null;
  const x =
    (viewProj[0] ?? 0) * p[0] +
    (viewProj[4] ?? 0) * p[1] +
    (viewProj[8] ?? 0) * p[2] +
    (viewProj[12] ?? 0);
  const y =
    (viewProj[1] ?? 0) * p[0] +
    (viewProj[5] ?? 0) * p[1] +
    (viewProj[9] ?? 0) * p[2] +
    (viewProj[13] ?? 0);
  return [(x / w) * 0.5 * viewport[0], (y / w) * 0.5 * viewport[1]];
}

/**
 * Expand one world-space segment into the quad the contour program draws.
 *
 * Returns `null` for a segment that projects to nothing — both endpoints behind the eye, or a
 * zero-length projection — which is exactly the case the shader pushes off screen rather than giving
 * an arbitrary normal.
 */
export function expandContourSegment(
  a: vec3,
  b: vec3,
  viewProj: mat4,
  viewport: vec2,
  widthPx: number,
  capPx = widthPx * 0.5
): ContourQuad | null {
  const sa = project(viewProj, a, viewport);
  const sb = project(viewProj, b, viewport);
  if (sa === null || sb === null) return null;
  const dx = sb[0] - sa[0];
  const dy = sb[1] - sa[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const dir: vec2 = [dx / len, dy / len];
  const nrm: vec2 = [-dir[1], dir[0]];
  const half = widthPx * 0.5;
  const corner = (t: 0 | 1, side: -1 | 1): vec2 => {
    const base: vec2 = [sa[0] + dx * t, sa[1] + dy * t];
    const along = capPx * (t * 2 - 1);
    return [
      base[0] + nrm[0] * half * side + dir[0] * along,
      base[1] + nrm[1] * half * side + dir[1] * along,
    ];
  };
  return {
    corners: [corner(0, -1), corner(0, 1), corner(1, -1), corner(1, 1)],
    widthPx,
  };
}

/** How many instances a segment array draws: 6 floats per segment (§6.5.1 `CutPayload`). */
export function contourInstanceCount(segments: Float32Array): number {
  return Math.floor(segments.length / 6);
}

// -----------------------------------------------------------------------------------------------
// Picking a contour (§7.4, directed task 12)
// -----------------------------------------------------------------------------------------------

/**
 * How close, in **render-target pixels**, a click has to be to a contour to select its layer.
 *
 * Wider than any sane `contourWidthPx` on purpose: a 1.5 px line is not a target a mouse can be
 * asked to hit, and Freeview's own outline click has the same generosity. The effective radius is
 * `max(this, contourWidthPx / 2)`, so a deliberately thick contour is never *harder* to hit than a
 * thin one.
 */
export const CONTOUR_PICK_PX = 5;

/**
 * The squared distance, in pane pixels, from `(x, y)` to the projected segment `a → b`.
 *
 * `Infinity` when the segment does not project — the same "emit nothing" case the shader has for a
 * segment behind the eye or of zero screen length, so what cannot be drawn cannot be clicked.
 *
 * Coordinates are the pane's own: origin at its centre, **y up**, which is what {@link
 * expandContourSegment} produces and what `(clip.xy / clip.w) · 0.5 · viewport` means.
 */
export function segmentDistanceSqPx(
  a: vec3,
  b: vec3,
  viewProj: mat4,
  viewport: vec2,
  x: number,
  y: number
): number {
  const sa = project(viewProj, a, viewport);
  const sb = project(viewProj, b, viewport);
  if (sa === null || sb === null) return Number.POSITIVE_INFINITY;
  const dx = sb[0] - sa[0];
  const dy = sb[1] - sa[1];
  const len2 = dx * dx + dy * dy;
  // A degenerate segment is unpickable, not a point: the shader pushes it off screen rather than
  // giving it an arbitrary normal, and a line nobody can see must not be a line anybody can click.
  if (len2 < 1e-12) return Number.POSITIVE_INFINITY;
  const t = Math.min(1, Math.max(0, ((x - sa[0]) * dx + (y - sa[1]) * dy) / len2));
  const ex = x - (sa[0] + dx * t);
  const ey = y - (sa[1] + dy * t);
  return ex * ex + ey * ey;
}

/**
 * The nearest segment in a packed `contours` / `boundarySegments` array, as a squared pixel distance.
 *
 * Six floats per segment (§6.5.1), read in place: a pial contour is a few thousand segments and a
 * click is one event, so a linear scan is ~20 µs and needs no acceleration structure to justify it.
 * `viewProj` must already include the dataset's model matrix — the caller has it, this does not.
 */
export function nearestContourDistanceSqPx(
  segments: Float32Array,
  viewProj: mat4,
  viewport: vec2,
  x: number,
  y: number
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 5 < segments.length; i += 6) {
    const d = segmentDistanceSqPx(
      [segments[i] ?? 0, segments[i + 1] ?? 0, segments[i + 2] ?? 0],
      [segments[i + 3] ?? 0, segments[i + 4] ?? 0, segments[i + 5] ?? 0],
      viewProj,
      viewport,
      x,
      y
    );
    if (d < best) best = d;
  }
  return best;
}
