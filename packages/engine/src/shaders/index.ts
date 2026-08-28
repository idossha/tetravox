/**
 * Every GLSL source in the engine, ESSL 3.00 — **one file per program**.
 *
 * The split is a Phase-2 ownership seam, not decoration: §7.3's completion (labels, threshold, heat,
 * `showIn3D`) and §7.4's (clip planes, caps, edges, field colouring, glyphs) are two agents editing
 * two files, with `chunks/` holding what both of them read and neither of them owns alone.
 *
 * Chunks are plain strings interpolated into a template literal. There is no `#include` runtime:
 * `Program` splices `#define`s in after the `#version` line and compiles the result (`gl/program.ts`),
 * and the §7.1 variant cache keys on those defines.
 *
 * **Shared-file rule: additive only.** Append an export for your
 * program; never reorder or re-export someone else's under a new name.
 */

export { MESH_COLOR_SOURCE, MESH_FS, MESH_THRESHOLD, MESH_VS } from './mesh';
export { OVERLAY_FS, OVERLAY_VS } from './overlay';
export { MESH_PICK_VS, PICK_FS, SLICE_PICK_FS, SLICE_PICK_VS } from './pick';
export { SLICE_FS, SLICE_VS } from './slice';
// Appended by E-SLICE (Phase 2): the slice pick program, gated exactly like the frame (§7.2.3).
export { SLICE_PICK_GATED_FS } from './slice';
// E-DERIVED: the four programs `render/passes/derived.ts` draws with (contours, `fillIn2D`, glyphs,
// points). Appended, per the shared-file rule.
export { CONTOUR_FS, CONTOUR_VS, CONTOUR_STRIP, CONTOUR_STRIP_VERTICES } from './contour';
export { FILL2D_FS, FILL2D_VS, FILL_MODE } from './fill2d';
export { GLYPH_FS, GLYPH_VS } from './glyph';
export { POINTS_FS, POINTS_VS, POINT_QUAD, POINT_QUAD_VERTICES } from './points';
