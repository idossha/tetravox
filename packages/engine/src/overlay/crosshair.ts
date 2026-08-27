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
