/**
 * The cut-plane gizmo and the oblique rotate handles — **Phase 2** (§7.5's "oblique affordances",
 * §7.4's "6 clip planes with exact caps + gizmo").
 *
 * Empty but typed. Two contract facts are already fixed and are recorded here so the implementation
 * inherits them rather than rediscovering them:
 *
 * * The gizmo is drawn in the **overlay** pass, where §7.2 requires **all clip distances disabled** —
 *   "or the gizmo gets clipped by the plane it manipulates".
 * * Its lines are instanced screen-space quads, never `LINES` + `lineWidth` (§7.0.6).
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import type { mat4, Plane, vec3, vec4 } from '../scene/types';

export interface GizmoSpec {
  /** The plane being manipulated, in §6.0's convention: keep `dot(normal, x) + offset >= 0`. */
  plane: Plane;
  /** World-space centre the handles orbit, normally the scene bounds' centre. */
  center: vec3;
  /** Handle size in world mm. */
  radiusMm: number;
  /** Which handle the pointer is over, for highlight. */
  hot: 'none' | 'translate' | 'rotateU' | 'rotateV';
}

/**
 * Append the gizmo's geometry, projected with `viewProj`. **Phase 2 fills this in** (owner:
 * E-SCENE); a no-op today.
 */
export function drawGizmo(
  _b: OverlayBuilder,
  _m: OverlayMetrics,
  _viewProj: mat4,
  _spec: GizmoSpec,
  _color: vec4
): void {
  // PHASE 2: a ring plus two rotate arcs and a translate arrow, all as screen-space quads.
}
