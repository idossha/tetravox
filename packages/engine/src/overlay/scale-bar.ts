/**
 * The **scale bar** — §4.5's `Annotations.scaleBar`, drawn in every 2D pane (directed task 10,
 * 2026-08-28).
 *
 * `Annotations` has named `scaleBar` since Phase 0 and nothing drew one, which made every 2D picture
 * a picture with no scale on it: `ZOOM 1.42X` in the corner is a ratio to a fit the reader never saw,
 * so a lesion measured off a screenshot was measured in pixels. A bar with a millimetre label is the
 * only annotation that makes a saved PNG dimensionally honest.
 *
 * **The length is snapped, not fitted.** A bar of "137 mm" is arithmetic, not a ruler: the reader has
 * to divide. So the length is chosen from `1 / 2 / 5 / 10 / 20 / 50 / 100 mm` — the 1-2-5 decade
 * ladder every map scale uses — and the *pixels* are whatever that comes to at the current zoom.
 * {@link SCALE_BAR_MIN_PX}…{@link SCALE_BAR_MAX_PX} is the window a snapped length has to land in to
 * be readable; the ladder is dense enough (ratio ≤ 2.5) that some rung always lands inside a window
 * of ratio 2.67, at every zoom the ladder spans.
 *
 * Everything here is pure: pane metrics and `mmPerPx` in, `OverlayBuilder` quads out, so §11 asserts
 * the drawn length in pixels against `mm / mmPerPx` without a GL context and again off the
 * framebuffer.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import type { vec4 } from '../scene/types';

/** The 1-2-5 ladder, in millimetres. */
export const SCALE_BAR_STEPS: readonly number[] = [1, 2, 5, 10, 20, 50, 100];

/** Shorter than this and the bar is a tick; longer and it crowds the corner info. */
export const SCALE_BAR_MIN_PX = 60;
export const SCALE_BAR_MAX_PX = 160;

export interface ScaleBarChoice {
  /** The snapped length in millimetres — what the label says. */
  mm: number;
  /** That length in pane pixels: exactly `mm / mmPerPx`, never rounded. */
  px: number;
}

/**
 * Pick the rung of the ladder whose drawn length lands in the readable window.
 *
 * Ties go to the **shorter** rung, because the ladder is walked upward and the first rung inside the
 * window wins. Outside the ladder's span — a pane zoomed past 100 mm ≪ 60 px, or 1 mm ≫ 160 px — no
 * rung fits, and the closest one in **log** space is taken: a bar 1.5× too long is the same error as
 * one 1.5× too short, which is not what a linear comparison would say.
 */
export function snapScaleBar(mmPerPx: number): ScaleBarChoice {
  const perPx = mmPerPx > 0 ? mmPerPx : 1;
  let best = SCALE_BAR_STEPS[0]!;
  let bestErr = Infinity;
  const ideal = Math.sqrt(SCALE_BAR_MIN_PX * SCALE_BAR_MAX_PX);
  for (const mm of SCALE_BAR_STEPS) {
    const px = mm / perPx;
    if (px >= SCALE_BAR_MIN_PX && px <= SCALE_BAR_MAX_PX) return { mm, px };
    const err = Math.abs(Math.log(px / ideal));
    if (err < bestErr) {
      bestErr = err;
      best = mm;
    }
  }
  return { mm: best, px: best / perPx };
}

/** Where the bar is drawn, in pane pixels, bottom-left origin. */
export interface ScaleBarLayout extends ScaleBarChoice {
  /** Left end of the bar. */
  x: number;
  /** Bottom of the bar. */
  y: number;
  /** Bar thickness. */
  thickness: number;
  /** How far the end caps rise above the bar. */
  capHeight: number;
}

/**
 * Bottom-right, one `pad` off both edges — the corner §8 leaves free (corner info bottom-left,
 * RAD/NEU badge top-right, colour bars down the right edge from under the badge, orientation letters
 * at the four edge midpoints).
 *
 * The bar's own row of pixels contains nothing but the bar and its caps, which is deliberate: §11's
 * assertion is that the **drawn** length is `mm / mmPerPx`, and that is a measurement of one scanline
 * only as long as the label sits above the bar rather than beside it.
 */
export function scaleBarLayout(m: OverlayMetrics, mmPerPx: number): ScaleBarLayout {
  const choice = snapScaleBar(mmPerPx);
  const thickness = Math.max(2, 2 * m.scale);
  return {
    ...choice,
    x: m.widthPx - m.pad - choice.px,
    y: m.pad,
    thickness,
    capHeight: Math.max(4, 5 * m.scale),
  };
}

/**
 * Append the bar, its two end caps and its label.
 *
 * The bar is the theme's `text` over a one-pixel `halo` plate, the same pairing every label in this
 * pass uses — so it stays visible over bright scalp in the dark theme and over air in the light one.
 * The label is written `10 MM`, in the alphabet `render/font.ts` actually has: no `µ`, no `×`.
 */
export function drawScaleBar(
  b: OverlayBuilder,
  m: OverlayMetrics,
  mmPerPx: number,
  color: vec4,
  halo: vec4
): void {
  const l = scaleBarLayout(m, mmPerPx);
  const t = Math.max(1, m.scale);
  const plate: vec4 = [halo[0], halo[1], halo[2], Math.min(halo[3], color[3])];

  // The plate first, one pixel proud of everything the bar draws, so the measured extent of the
  // *bright* pixels is still exactly `px`.
  b.rect(l.x - t, l.y - t, l.px + 2 * t, l.capHeight + 2 * t, plate);
  b.rect(l.x, l.y, l.px, l.thickness, color);
  b.rect(l.x, l.y, l.thickness, l.capHeight, color);
  b.rect(l.x + l.px - l.thickness, l.y, l.thickness, l.capHeight, color);

  b.labelWithHalo(
    `${l.mm} MM`,
    l.x + l.px / 2,
    l.y + l.capHeight + 2 * m.scale,
    m.scale,
    color,
    'center'
  );
}
