/**
 * The `points` layer (§4.4 `PointsLayer`): electrodes, ROI spheres, SimNIBS `eeg_positions/*.csv`.
 *
 * §7.4 fixes the shape of every instanced draw in this engine — "one instanced draw of a shared VAO
 * with per-instance origin … **No new geometry from WASM**" — so a points layer is one draw of a
 * **shared unit quad**, instanced once per point, with the sphere resolved analytically in the
 * fragment shader. A tessellated ball per point would be geometry built on the UI thread, which
 * AGENTS rule 7 forbids, and it would cost 60× the vertices for a rounder silhouette nobody can see
 * at electrode scale.
 *
 * **Two panes, one program.** `POINTS_2D` decides which:
 *
 * * **3D (`POINTS_2D 0`)** — a view-aligned billboard of radius `radiusMm`, shaded as a hemisphere
 *   (`z = sqrt(1 - r²)` in billboard space) so it reads as a ball rather than a disc, and lit by the
 *   same headlight as §7.4's meshes.
 * * **2D (`POINTS_2D 1`)** — the sphere's **intersection with the pane's plane**: a disc of radius
 *   `sqrt(radius² - d²)` where `d` is the signed distance from the centre to the plane. A point
 *   farther than its own radius from the plane is not on this slice and is dropped entirely, which
 *   is what makes a points layer sweep with the cursor the way §4.4 means it to.
 *
 * `shape: 'dot'` is the same draw with a screen-space radius instead of a world one, so a marker
 * stays visible at any zoom.
 *
 * **Ghosting (§4.4's `offPlaneOpacity`, 2026-08-30).** `uGhostAlpha` is the one addition: at 0 —
 * the value every caller that does not ask for ghosting passes, and the default the uniform is not
 * set to at all in the 3D variant — the 2D branch is the cull above, verbatim. Above 0 the
 * off-slice points are drawn too, at the **full** radius (a projection of the whole sphere, not a
 * vanishing cross-section) and at that alpha. It is a uniform and not a third program variant on
 * purpose: `derived.ts` already writes per-layer uniforms into this program, the branch costs one
 * comparison on a draw of a few hundred instances, and a variant would double the program cache for
 * a layer flag.
 */

import { PRECISION_FLOAT, VERSION } from './chunks/caps';

/** The shared unit quad, as a `TRIANGLE_STRIP`: the billboard every instance expands into. */
export const POINT_QUAD = new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]);
export const POINT_QUAD_VERTICES = 4;

export const POINTS_VS = `${VERSION}
${PRECISION_FLOAT}
layout(location = 0) in vec2 aCorner;     // unit quad, -1..1
layout(location = 1) in vec3 aCenter;     // per-instance world position
layout(location = 2) in vec4 aColor;      // per-instance RGBA, 0..1
layout(location = 3) in float aRadius;    // per-instance radius in mm

uniform mat4 uViewProj;
uniform vec3 uRight;                      // pane / camera right, world, unit
uniform vec3 uUp;                         // pane / camera up, world, unit
uniform vec3 uNormal;                     // pane normal (2D) or view direction (3D), unit
uniform float uPlaneOffset;               // §4.1 Plane.offset of the pane's plane (2D only)
uniform float uMmPerPx;                   // 2D: pane scale, for the 'dot' screen-space radius
uniform float uDotPx;                     // > 0 selects a screen-space radius of this many pixels
#if POINTS_2D
uniform float uGhostAlpha;                // §4.4 offPlaneOpacity: 0 = cull off-slice points (default)
#endif

out vec2 vCorner;
out vec4 vColor;
#if POINTS_2D
// 1 on the slice, \`uGhostAlpha\` off it. A varying and not a second uniform because on-slice and
// off-slice points are ONE instanced draw (§7.4), so the two cases differ per instance.
out float vAlphaScale;
#endif

void main() {
  vColor = aColor;
  vCorner = aCorner;
  float r = aRadius;
#if POINTS_2D
  vAlphaScale = 1.0;
  // The sphere ∩ plane circle. \`uNormal · c + uPlaneOffset\` is §4.1's signed distance, verbatim.
  float d = dot(uNormal, aCenter) + uPlaneOffset;
  float rr = r * r - d * d;
  if (rr > 0.0) {
    r = sqrt(rr);
  } else if (uGhostAlpha > 0.0) {
    // §4.4's ghost: not on this slice, but drawn anyway at the FULL radius, so a depth electrode's
    // shaft stays a shaft while the slice sweeps through it. \`r\` is already \`aRadius\`.
    vAlphaScale = uGhostAlpha;
  } else {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off screen: this point is not on this slice
    return;
  }
  if (uDotPx > 0.0) r = uDotPx * uMmPerPx;
  // Draw on the plane itself, so the disc is never clipped by the pane's own depth range.
  vec3 center = aCenter - uNormal * d;
#else
  vec3 center = aCenter;
#endif
  vec3 world = center + uRight * (aCorner.x * r) + uUp * (aCorner.y * r);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

export const POINTS_FS = `${VERSION}
${PRECISION_FLOAT}
in vec2 vCorner;
in vec4 vColor;
#if POINTS_2D
in float vAlphaScale;                     // 1 on the slice, §4.4's offPlaneOpacity off it
#endif
uniform float uAmbient;
uniform float uOpacity;
out vec4 fragColor;

void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;                  // the quad's corners are not part of the sphere
#if POINTS_2D
  // A cross-section is flat: no shading, so the pixel is the point's colour exactly and an analytic
  // test can name it. \`vAlphaScale\` is 1 for every on-slice point, so a layer that does not ghost
  // is bit-identical to what it was before ghosting existed.
  fragColor = vec4(vColor.rgb, vColor.a * uOpacity * vAlphaScale);
#else
  // Headlight on the hemisphere the billboard stands for; the light direction is the view direction,
  // so the normal's z component is the whole diffuse term (§7.4).
  float z = sqrt(max(0.0, 1.0 - r2));
  float diff = z;
  vec3 rgb = vColor.rgb * (uAmbient + (1.0 - uAmbient) * diff);
  fragColor = vec4(rgb, vColor.a * uOpacity);
#endif
}`;
