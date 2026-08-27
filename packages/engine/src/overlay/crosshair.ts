/**
 * The crosshair (§4.5 `Annotations.crosshair`, §7.5 key `c`).
 *
 * Two full-width / full-height quads, **never `LINES`**: `gl.lineWidth()` is a no-op —
 * `ALIASED_LINE_WIDTH_RANGE` is `[1,1]` `[M2Max]` — so every `*WidthPx` knob on line-drawn geometry
 * is screen-space quad expansion (§7.0.6).
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import type { vec4 } from '../scene/types';

/** Pane pixel position of the crosshair centre, origin bottom-left. */
export interface CrosshairSpec {
  x: number;
  y: number;
}

export function drawCrosshair(
  b: OverlayBuilder,
  m: OverlayMetrics,
  c: CrosshairSpec,
  color: vec4
): void {
  const t = Math.max(1, m.scale);
  b.rect(0, c.y - t / 2, m.widthPx, t, color);
  b.rect(c.x - t / 2, 0, t, m.heightPx, color);
}

/** Arm half-length of the 3D crosshair, in unscaled overlay pixels. */
export const CROSSHAIR_3D_ARM_PX = 14;

/**
 * The **3D** crosshair — R1's "the 3D crosshair moves".
 *
 * A short cross at the cursor's projection, not the 2D pane's full-width rules: in a 3D view those
 * would read as two lines floating in space with no relation to the geometry, and they would cross
 * the orientation letters on all four edges. A marker at the projected point says the one thing the
 * requirement is about — *the cursor is here* — and moves when the cursor does.
 *
 * The caller has already projected the world cursor (`view/geometry.ts`'s `worldToPane3D`) and
 * dropped it if it is behind the eye; this function is pure layout.
 */
export function drawCrosshair3D(
  b: OverlayBuilder,
  m: OverlayMetrics,
  c: CrosshairSpec,
  color: vec4
): void {
  const t = Math.max(1, m.scale);
  const arm = CROSSHAIR_3D_ARM_PX * m.scale;
  b.rect(c.x - arm, c.y - t / 2, arm * 2, t, color);
  b.rect(c.x - t / 2, c.y - arm, t, arm * 2, color);
}
