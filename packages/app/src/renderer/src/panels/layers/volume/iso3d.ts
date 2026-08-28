/**
 * The **3D surface** switch's pure half — §4.4's `VolumeLayer.iso3d` (directed task 2, 2026-08-28).
 *
 * Every control in `VolumeProperties`'s 3D-surface block computes a `Partial<VolumeLayer>` here and
 * hands it to `controller.patchLayer`, exactly like the rest of that editor (§8: no logic in React).
 * The engine owns what a patch *means* — `layers/iso3d.ts` derives the surfaces — so this file is
 * only ever answering two questions: what does the switch turn on with, and what does the slider
 * span?
 *
 * **The slider spans the histogram, not `[min, max]`.** `m2m_ernie/T1.nii.gz` runs to exactly
 * 65535.0 `[DATA]` while its p95 is three orders of magnitude below that, so a `[min, max]` slider
 * puts every useful level inside the first pixel of travel. `Stats.histogramLo/Hi` is the range the
 * §8 histogram widget already draws, which also means the slider and the histogram under it agree.
 */

import type { VolumeDataset, VolumeIso3d, VolumeLayer } from '@tetravox/engine';
import { defaultIso3d } from '@tetravox/engine';

export interface Iso3dRange {
  lo: number;
  hi: number;
}

/** The slider's span: the histogram's, falling back to `[min, max]` and then to `[0, 1]`. */
export function iso3dRange(ds: VolumeDataset): Iso3dRange {
  const { histogramLo, histogramHi, min, max } = ds.stats;
  if (Number.isFinite(histogramLo) && Number.isFinite(histogramHi) && histogramHi > histogramLo) {
    return { lo: histogramLo, hi: histogramHi };
  }
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) return { lo: min, hi: max };
  return { lo: 0, hi: 1 };
}

/** 1/200 of the range, matching the standalone iso editor's step so the two feel the same. */
export function iso3dStep(range: Iso3dRange): number {
  const span = range.hi - range.lo;
  return span > 0 ? span / 200 : 0.01;
}

/**
 * The block the layer shows in the editor: its own, or the defaults it *would* turn on with.
 *
 * A layer with no `iso3d` still has to render a slider position and a colour swatch, and rendering
 * them from the defaults means flipping the switch changes nothing the user can see except that the
 * surface appears — rather than the controls jumping to values they were not showing a moment ago.
 */
export function effectiveIso3d(layer: VolumeLayer, ds: VolumeDataset): VolumeIso3d {
  return layer.iso3d ?? { ...defaultIso3d(ds), enabled: false };
}

/**
 * The **3D surface** switch.
 *
 * Turning it on for the first time seeds `defaultIso3d(ds)` — p95 for a scalar volume; turning it on
 * again later keeps whatever the user had set, because the block is still on the layer with
 * `enabled: false`. Turning it off keeps the settings for the same reason.
 */
export function toggleIso3d(
  layer: VolumeLayer,
  ds: VolumeDataset,
  on: boolean
): Partial<VolumeLayer> {
  const current = layer.iso3d;
  if (current === undefined) return on ? { iso3d: defaultIso3d(ds) } : {};
  return { iso3d: { ...current, enabled: on } };
}

/** One field of the block, with the rest carried — the shape every control below the switch uses. */
export function patchIso3d(
  layer: VolumeLayer,
  ds: VolumeDataset,
  patch: Partial<VolumeIso3d>
): Partial<VolumeLayer> {
  return { iso3d: { ...effectiveIso3d(layer, ds), ...patch } };
}

/** How the block summarises itself in the editor: the level, or the region count for labels. */
export function iso3dSummary(ds: VolumeDataset, spec: VolumeIso3d, regions: number): string {
  if (!spec.enabled) return 'off';
  if (ds.isLabel) return `${regions} region${regions === 1 ? '' : 's'}`;
  return `iso ${spec.iso.toPrecision(4)}`;
}
