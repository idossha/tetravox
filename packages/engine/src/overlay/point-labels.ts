/**
 * 3D text labels for a points layer — §7.2 pass 3, screen-projected (directed task 6).
 *
 * A parsed Gmsh view's `T3` primitives are *text at a world position*: `E001` above the electrode
 * it names. There is no 3D-text geometry here and there does not need to be — the anchor is
 * projected through the pane's own view-projection and the string is drawn as flat overlay glyphs
 * at that pixel, with the halo `OverlayBuilder.labelWithHalo` already gives every other overlay
 * string. That is what makes the labels legible over bright scalp at every zoom, and what keeps
 * them the same size in a 4 mm-wide pane and a 200 mm one.
 *
 * **Placement is pure**, so §11 can assert where a label lands from first principles without a GL
 * context: {@link placePointLabels} takes a view-projection and returns pane pixels, and the pass
 * only feeds the result to the builder.
 *
 * **Occlusion: not implemented, deliberately.** A label behind the head still draws. §7.2.3's pick
 * target carries element ids, not depth, and it is rendered *after* the overlay in the frame it
 * would have to be read from — so hiding an occluded label would need either a `readPixels`
 * round-trip (a full pipeline stall, per pane, per frame) or a second depth resolve this pass has
 * no budget for. What *is* implemented is the free half: a label whose anchor is behind the eye
 * (`w < 0`, which `worldToPane3D` returns `null` for) and one whose anchor falls outside the pane
 * are both dropped. See `docs/DECISIONS.md`, 2026-08-28.
 */

import { worldToPane3D } from '../view/geometry';
import { GLYPH_H } from '../render/font';
import type { OverlayBuilder, OverlayMetrics } from './builder';
import type { mat4, vec3, vec4 } from '../scene/types';

/** One placed label: pane pixels, **origin bottom-left**, like every other overlay item. */
export interface PlacedLabel {
  text: string;
  x: number;
  y: number;
}

export interface LabelPlacement {
  /** Pane size in render-target pixels. */
  width: number;
  height: number;
  /**
   * Signed world-mm distance from the pane's plane, and the tolerance — a 2D pane only draws the
   * labels within `±slabMm` of the slice it shows. Omit for a 3D pane, which draws all of them.
   */
  slab?: { normal: vec3; offset: number; slabMm: number };
  /** Text is lifted this many pixels above the anchor, so it clears the point's sphere. */
  liftPx: number;
}

/**
 * Project label anchors into pane pixels, dropping the ones that cannot be drawn.
 *
 * Anchors behind the eye, outside the pane, or (in a 2D pane) further than `slabMm` from the plane
 * are dropped. The order of the survivors is the input order, which is what lets a test name the
 * n-th label.
 */
export function placePointLabels(
  labels: readonly { position: vec3; text: string }[],
  viewProj: mat4,
  place: LabelPlacement
): PlacedLabel[] {
  const out: PlacedLabel[] = [];
  for (const l of labels) {
    if (place.slab !== undefined) {
      const n = place.slab.normal;
      const d =
        n[0] * l.position[0] + n[1] * l.position[1] + n[2] * l.position[2] + place.slab.offset;
      if (Math.abs(d) > place.slab.slabMm) continue;
    }
    const p = worldToPane3D(viewProj, { width: place.width, height: place.height }, l.position);
    if (p === null) continue;
    // `worldToPane3D` answers top-down (it is the pointer's convention); overlay pixels run
    // bottom-up. One flip, here, so every consumer below is in overlay space.
    const x = p[0];
    const y = place.height - 1 - p[1] + place.liftPx;
    if (x < 0 || x > place.width || y < 0 || y > place.height) continue;
    out.push({ text: l.text, x, y });
  }
  return out;
}

/**
 * Draw placed labels centred on their anchors, with the standard 1 px halo.
 *
 * `labelScale` multiplies the pane's own font magnification, so a label tracks the UI scale like
 * the orientation letters do and a user who wants bigger text gets bigger text at every DPR.
 */
export function drawPointLabels(
  b: OverlayBuilder,
  m: OverlayMetrics,
  placed: readonly PlacedLabel[],
  labelScale: number,
  color: vec4
): void {
  const scale = Math.max(1, Math.round(m.scale * Math.max(0.25, labelScale)));
  for (const l of placed) {
    // Rounded to the pixel grid for the same reason `letters.ts` rounds: a glyph quad straddling
    // pixel centres samples the NEAREST atlas one texel row late and loses its top row.
    b.labelWithHalo(l.text, Math.round(l.x), Math.round(l.y), scale, color, 'center');
  }
}

/** Height of one label line in pane pixels, for a caller stacking something below it. */
export function labelHeightPx(m: OverlayMetrics, labelScale: number): number {
  return GLYPH_H * Math.max(1, Math.round(m.scale * Math.max(0.25, labelScale)));
}
