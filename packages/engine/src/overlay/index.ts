/**
 * `src/overlay/` — the §7.2 pass-3 items, one module per thing that is drawn.
 *
 * The pass itself (`render/passes/overlay.ts`) owns the GL program, the dynamic buffer and the one
 * draw call; everything here is pure geometry appended into an {@link OverlayBuilder}. That split is
 * what lets §11 test chrome placement without a GL context, and what keeps four Phase-2 additions —
 * colour bars, the gizmo, contours and glyph labels — out of each other's files.
 *
 * **Shared-file rule: additive only.** Append an export for your
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
export { CONTOUR_PICK_PX, nearestContourDistanceSqPx, segmentDistanceSqPx } from './contours';
export type { ContourQuad } from './contours';
// Appended for parsed Gmsh views (task 6): a points layer's screen-projected 3D text labels.
export { drawPointLabels, labelHeightPx, placePointLabels } from './point-labels';
// §4.4's `labelSource` (2026-08-30): which array a points layer's text comes from, resolved once.
export { pointLabelAnchors } from './point-labels';
export type { LabelPlacement, PlacedLabel } from './point-labels';
// Directed task 9 (2026-08-28): the pass-3 chrome palette, so `setAnnotations`'s neighbour
// `setTheme` has something to carry and the halo flips with the embedder's theme.
export { DEFAULT_OVERLAY_THEME, resolveOverlayTheme } from './theme';
export type { OverlayTheme } from './theme';
// Directed task 11 (2026-08-28): the measurement item — segments, endpoints and the mm/degree
// label, all in screen-space quads at a constant width (§7.0.6).
export {
  drawMeasurement,
  measureLabelAnchor,
  measureLabelHeightPx,
  onPlane,
  MEASURE_ENDPOINT_PX,
  MEASURE_LABEL_GAP_PX,
  MEASURE_SLAB_MM,
  MEASURE_WIDTH_PX,
} from './measure';
export type { PlacedMeasurement } from './measure';
// Directed task 10 (2026-08-28): the 3D pane's orientation cube and the 2D panes' scale bar — the
// two §7.2 pass-3 items §4.5's `Annotations` names (`orientationCube`, `scaleBar`) but nothing drew.
export {
  CUBE_EDGE_SHADE,
  CUBE_FACES,
  CUBE_PX,
  CUBE_SHADE_MAX,
  CUBE_SHADE_MIN,
  cameraBasis,
  cubeFaceAt,
  cubeFaces,
  cubeLayout,
  drawOrientationCube,
} from './orientation-cube';
export type {
  CameraBasis,
  CubeColors,
  CubeFace,
  CubeFaceQuad,
  CubeLayout,
} from './orientation-cube';
export {
  SCALE_BAR_MAX_PX,
  SCALE_BAR_MIN_PX,
  SCALE_BAR_STEPS,
  drawScaleBar,
  scaleBarLayout,
  snapScaleBar,
} from './scale-bar';
export type { ScaleBarChoice, ScaleBarLayout } from './scale-bar';
// §13's point editing (2026-08-30): the selection / hover rings, and the shader's disc rule stated
// once on the CPU so a hit test and a ring cannot drift away from the picture.
export {
  DOT_RADIUS_PX,
  POINT_HOT_RING_WIDTH_PX,
  POINT_RING_GAP_PX,
  POINT_RING_MIN_RADIUS_PX,
  POINT_RING_SEGMENTS,
  POINT_RING_WIDTH_PX,
  discRadiusPx,
  drawPointRing,
  ringRadiusPx,
} from './point-ring';
export type { DiscShape } from './point-ring';
