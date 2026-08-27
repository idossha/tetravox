/**
 * The §7.2 pass-3 overlay program — orientation letters, corner info, the RAD/NEU badge, the
 * crosshair, and (Phase 2) contours, colour bars and the cut-plane gizmo. One dynamic buffer, one
 * draw.
 *
 * `gl.lineWidth()` is a **no-op** (`ALIASED_LINE_WIDTH_RANGE` is `[1,1]` `[M2Max]`), so the
 * crosshair is screen-space quad expansion like every other `*WidthPx` knob on line-drawn geometry —
 * never `LINES`.
 *
 * A negative `aUv.x` marks a solid quad; otherwise the vertex samples the bitmap font atlas.
 */

import { PRECISION_FLOAT, VERSION } from './chunks/caps';

export const OVERLAY_VS = `${VERSION}
${PRECISION_FLOAT}
layout(location = 0) in vec2 aPos;      // NDC
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const OVERLAY_FS = `${VERSION}
${PRECISION_FLOAT}
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uAtlas;
out vec4 fragColor;
void main() {
  float a = vColor.a;
  if (vUv.x >= 0.0) {
    a *= texture(uAtlas, vUv).r;
  }
  if (a <= 0.0) discard;
  fragColor = vec4(vColor.rgb, a);
}`;
