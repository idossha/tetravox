/**
 * `src/overlay/` — the §7.2 pass-3 items, one module per thing that is drawn.
 *
 * The pass itself (`render/passes/overlay.ts`) owns the GL program, the dynamic buffer and the one
 * draw call; everything here is pure geometry appended into an {@link OverlayBuilder}. That split is
 * what lets §11 test chrome placement without a GL context, and what keeps four Phase-2 additions —
 * colour bars, the gizmo, contours and glyph labels — out of each other's files.
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** Append an export for your
 * item; never reorder or rename an existing one.
 */

export { OverlayBuilder, FLOATS_PER_VERTEX, overlayMetrics } from './builder';
export type { OverlayMetrics } from './builder';
export { badgeFor, drawBadge } from './badge';
export type { ConventionBadge } from './badge';
export { buildChrome } from './chrome';
export type { ChromeInput } from './chrome';
export { drawColorbar } from './colorbar';
export type { ColorbarSpec, ColorbarTick } from './colorbar';
// Appended by E-SLICE (Phase 2): the bar's layout and the volume producer (§8).
export { colorbarLayout, formatTick, volumeColorbarSpec } from './colorbar';
export type { ColorbarLayout } from './colorbar';
export { drawCornerLines } from './corner';
export type { CornerLines } from './corner';
export { drawCrosshair } from './crosshair';
export type { CrosshairSpec } from './crosshair';
export { drawCrosshair3D, CROSSHAIR_3D_ARM_PX } from './crosshair';
export { drawGizmo } from './gizmo';
export type { GizmoSpec } from './gizmo';
export {
  gizmoBasis,
  gizmoHandleAt,
  handlePoints,
  planeBasis,
  ARC_SEGMENTS,
  HANDLE_HIT_PX,
  KNOB_PX,
  RING_SEGMENTS,
} from './gizmo';
export type { GizmoColors, GizmoHandle } from './gizmo';
export { drawEdgeLetters } from './letters';
export type { EdgeLetters } from './letters';
// E-DERIVED: the contour item's pure screen-space expansion, the CPU twin of `shaders/contour.ts`.
export { contourInstanceCount, expandContourSegment } from './contours';
export type { ContourQuad } from './contours';
