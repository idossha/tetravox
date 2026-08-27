/**
 * One pane's chrome, composed from the item modules beside this file.
 *
 * Pure: every position is derived from `widthPx` / `heightPx` / `uiScale`, so the same input always
 * produces the same buffer and §11's goldens are not at the mercy of a layout that drifts.
 *
 * **Draw order is part of the contract, not a detail.** The crosshair goes down first so letters and
 * corner lines sit on top of it where they overlap; the active-pane border goes last so nothing
 * covers it. Phase 2 appends colour bars and the gizmo — after the crosshair, before the border.
 */

import { drawBadge } from './badge';
import type { ConventionBadge } from './badge';
import type { OverlayBuilder } from './builder';
import { overlayMetrics } from './builder';
import { drawCornerLines } from './corner';
import type { CornerLines } from './corner';
import { drawCrosshair, drawCrosshair3D } from './crosshair';
import type { CrosshairSpec } from './crosshair';
import { drawGizmo } from './gizmo';
import type { GizmoColors, GizmoSpec } from './gizmo';
import { drawEdgeLetters } from './letters';
import type { EdgeLetters } from './letters';
import type { mat4, vec4 } from '../scene/types';

export interface ChromeInput {
  widthPx: number;
  heightPx: number;
  /** Scale factor for the bitmap font, at least 1. */
  uiScale: number;
  letters?: EdgeLetters;
  /** `['AXIAL', 'SLICE 104', 'RAS -0.7 18.0 6.0']` — drawn bottom-left, one line each. */
  cornerLines?: CornerLines;
  /** Always drawn when present; `Annotations.conventionBadge` is `true`, not optional (§8). */
  badge?: ConventionBadge;
  /** Pane pixel position of the crosshair, or `null`. */
  crosshair?: CrosshairSpec | null;
  /**
   * Pane pixel position of the **3D** crosshair — the cursor projected into a `View3D` — or `null`
   * when it is behind the eye or the annotation is off (R1, appended by E-SCENE).
   */
  crosshair3d?: CrosshairSpec | null;
  crosshairColor: vec4;
  textColor: vec4;
  /** 1 px accent border, drawn when this pane is the active view. */
  activeBorder?: vec4;
  /**
   * The cut-plane gizmo and its view-projection — §7.5's oblique affordances, 3D panes only
   * (appended by E-SCENE).
   */
  gizmo?: { spec: GizmoSpec; viewProj: mat4; colors: GizmoColors } | null;
}

/** Compose one pane's chrome. Pure: every position is derived from `widthPx` / `heightPx`. */
export function buildChrome(b: OverlayBuilder, c: ChromeInput): void {
  const m = overlayMetrics(c.widthPx, c.heightPx, c.uiScale);

  if (c.crosshair != null) drawCrosshair(b, m, c.crosshair, c.crosshairColor);
  if (c.crosshair3d != null) drawCrosshair3D(b, m, c.crosshair3d, c.crosshairColor);
  if (c.letters !== undefined) drawEdgeLetters(b, m, c.letters, c.textColor);
  if (c.cornerLines !== undefined) drawCornerLines(b, m, c.cornerLines, c.textColor);
  if (c.badge !== undefined) drawBadge(b, m, c.badge, c.textColor);

  // PHASE 2: colour bars (`overlay/colorbar.ts`) land here, between the chrome and the border.
  // The gizmo is below, after them: §7.2 lists it before the annotations in the pass, but it is the
  // thing a user is dragging, so nothing may draw over it except the active-pane border.
  if (c.gizmo != null) drawGizmo(b, m, c.gizmo.viewProj, c.gizmo.spec, c.gizmo.colors);

  if (c.activeBorder !== undefined)
    drawActiveBorder(b, c.widthPx, c.heightPx, m.scale, c.activeBorder);
}

/** §8: "a coloured border on the active view pane". Four 1 px rects, at the DPR's thickness. */
function drawActiveBorder(
  b: OverlayBuilder,
  widthPx: number,
  heightPx: number,
  scale: number,
  color: vec4
): void {
  const t = Math.max(1, scale);
  b.rect(0, 0, widthPx, t, color);
  b.rect(0, heightPx - t, widthPx, t, color);
  b.rect(0, 0, t, heightPx, color);
  b.rect(widthPx - t, 0, t, heightPx, color);
}
