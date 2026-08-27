/**
 * The corner annotation (§8): "view name, slice index of the active volume layer, world RAS of the
 * plane".
 *
 * Lines are supplied already formatted — the slice index in particular is derived from the volume's
 * **affine** (`voxelAxisAlong`), never from a voxel axis hardcoded per view mode, and that
 * derivation belongs to the caller, not to a text layout function.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import type { vec4 } from '../scene/types';

/** `['AXIAL', 'RAS -0.7 18.0 6.0', 'SLICE 104']`, drawn bottom-left, one line each, first at top. */
export type CornerLines = readonly string[];

export function drawCornerLines(
  b: OverlayBuilder,
  m: OverlayMetrics,
  lines: CornerLines,
  color: vec4
): void {
  lines.forEach((line, i) => {
    b.labelWithHalo(line, m.pad, m.pad + (lines.length - 1 - i) * m.lineH, m.scale, color, 'left');
  });
}
