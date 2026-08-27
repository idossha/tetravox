/**
 * The four edge orientation letters (§8).
 *
 * **A laterality-safety requirement, not decoration.** The letters themselves come from
 * `view/geometry.ts`'s `edgeLetters`, which derives them from the slice basis and the radiological
 * flag — never hardcoded per pane. This module only places them.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import { GLYPH_H } from '../render/font';
import type { vec4 } from '../scene/types';

export interface EdgeLetters {
  left: string;
  right: string;
  top: string;
  bottom: string;
}

export function drawEdgeLetters(
  b: OverlayBuilder,
  m: OverlayMetrics,
  letters: EdgeLetters,
  color: vec4
): void {
  // Rounded to the pixel grid on purpose: `heightPx / 2 - (GLYPH_H * s) / 2` is a half-pixel for
  // an odd glyph height, and a glyph quad straddling pixel centres samples the NEAREST atlas one
  // texel row late — it drops the glyph's top row, which is the difference between an `R` and
  // something a template match calls an `X`. Every other string here is already integral.
  const mid = Math.round(m.heightPx / 2 - (GLYPH_H * m.scale) / 2);
  const midX = m.widthPx / 2;
  b.labelWithHalo(letters.left, m.pad, mid, m.scale, color, 'left');
  b.labelWithHalo(letters.right, m.widthPx - m.pad, mid, m.scale, color, 'right');
  b.labelWithHalo(
    letters.top,
    midX,
    m.heightPx - m.pad - GLYPH_H * m.scale,
    m.scale,
    color,
    'center'
  );
  b.labelWithHalo(letters.bottom, midX, m.pad, m.scale, color, 'center');
}
