/**
 * `contoursIn2D` — tissue-boundary and surface contour lines on a 2D pane (§7.4, §7.0.6, R4).
 *
 * **`gl.lineWidth()` is a no-op**: `ALIASED_LINE_WIDTH_RANGE` is `[1,1]` `[M2Max]`, so
 * `contourWidthPx` is implemented as **instanced screen-space quad expansion** and never as `LINES`
 * plus a width. That is the whole reason this program exists as a separate one: a `LINES` draw would
 * silently give 1 px at every zoom and every DPR, and the §11 obligation this file carries is
 * exactly "a contour segment's screen-space width at two zooms is `contourWidthPx` ± 0.5 px".
 *
 * Geometry: one 4-vertex `TRIANGLE_STRIP` instanced once per segment. The per-instance attributes
 * are the segment's two world endpoints, read straight out of `CutSnapshot.boundarySegments` /
 * `edgeSegments` / the `contours` op's `segments` — **6 floats per segment**, so the same buffer is
 * bound twice with `vertexAttribPointer` at offsets 0 and 12 and a divisor of 1. Nothing is expanded
 * on the CPU.
 *
 * The expansion is done after the perspective divide, in **render-target pixels** (§7.0.5: every
 * `*WidthPx` knob is in render-target pixels and must be scaled by the DPR/SSAA factor — the pass
 * passes `uWidthPx` already scaled). `uCapPx` extends each end along the segment so a chain of
 * segments has no gap at its joints; it is a longitudinal extension only and never changes the
 * measured perpendicular width.
 *
 * A degenerate segment (both endpoints at the same place, or one behind the eye in a 3D pane) is
 * collapsed to nothing rather than being given an arbitrary normal.
 */

import { PRECISION_FLOAT, VERSION } from './chunks/caps';

/** Vertices in the shared unit strip: `(t, side)` with `t` along the segment, `side` across it. */
export const CONTOUR_STRIP = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
export const CONTOUR_STRIP_VERTICES = 4;

export const CONTOUR_VS = `${VERSION}
${PRECISION_FLOAT}
layout(location = 0) in vec2 aCorner;     // (t along, side across) in {0,1} x {-1,+1}
layout(location = 1) in vec3 aA;          // per-instance: segment start, world mm
layout(location = 2) in vec3 aB;          // per-instance: segment end, world mm

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec2 uViewport;                   // render-target pixels of this pane
uniform float uWidthPx;                   // contourWidthPx, already DPR-scaled
uniform float uCapPx;                     // longitudinal extension at each end

void main() {
  vec4 ca = uViewProj * (uModel * vec4(aA, 1.0));
  vec4 cb = uViewProj * (uModel * vec4(aB, 1.0));
  // Both endpoints behind the near plane: emit nothing rather than a mirrored quad.
  if (ca.w <= 0.0 || cb.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 sa = (ca.xy / ca.w) * 0.5 * uViewport;
  vec2 sb = (cb.xy / cb.w) * 0.5 * uViewport;
  vec2 d = sb - sa;
  float len = length(d);
  if (len < 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);

  vec4 c = mix(ca, cb, aCorner.x);
  // Half the width across, plus the cap along, both in pixels; converted to clip space by the same
  // factor the projection used, so the result is a constant screen width at any zoom.
  vec2 offsetPx = nrm * (uWidthPx * 0.5) * aCorner.y + dir * uCapPx * (aCorner.x * 2.0 - 1.0);
  c.xy += offsetPx / (0.5 * uViewport) * c.w;
  gl_Position = c;
}`;

export const CONTOUR_FS = `${VERSION}
${PRECISION_FLOAT}
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  fragColor = uColor;
}`;
