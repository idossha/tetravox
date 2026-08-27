/**
 * The RAD / NEU convention badge (§8).
 *
 * `Annotations.conventionBadge` is `true`, **not optional** — the badge is always drawn, and §11
 * requires it in every golden, so a regression that drops it fails CI. `setAnnotations` enforces the
 * flag; this module draws whichever of the two words the radiological flag selects.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import { GLYPH_H } from '../render/font';
import type { vec4 } from '../scene/types';

export type ConventionBadge = 'RAD' | 'NEU';

export function badgeFor(radiological: boolean): ConventionBadge {
  return radiological ? 'RAD' : 'NEU';
}

export function drawBadge(
  b: OverlayBuilder,
  m: OverlayMetrics,
  badge: ConventionBadge,
  color: vec4
): void {
  b.labelWithHalo(
    badge,
    m.widthPx - m.pad,
    m.heightPx - m.pad - GLYPH_H * m.scale,
    m.scale,
    color,
    'right'
  );
}
