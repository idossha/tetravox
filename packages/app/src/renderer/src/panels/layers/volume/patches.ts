/**
 * Every edit the §8 volume property editor can make, as a pure `Partial<VolumeLayer>`.
 *
 * §8's rule is "everything the UI can do must be reachable from the `Engine` API alone. No logic in
 * React." That splits a control into two halves, and this file is the half worth testing: given the
 * layer as it is and what the user just did, **what patch goes to `Engine.updateLayer`**. The `.tsx`
 * beside it is then only inputs and a `controller.patchLayer(id, …)` call.
 *
 * Nothing here reads a dataset's samples. `Stats` (§4.2, computed exactly in the worker) is the only
 * source for a seeded value, which is why switching a scale kind or hitting a preset costs nothing.
 */

import type {
  Capabilities,
  ColormapName,
  Scale,
  Stats,
  Threshold,
  VolumeDataset,
  VolumeLayer,
} from '@tetravox/engine';
import type { ValueWindow } from '../../histogram/presets';
import { normalizeWindow } from '../../histogram/presets';

/** §4.1's frozen `ColormapName` union, in declaration order, for the picker. */
export const COLORMAPS: readonly ColormapName[] = [
  'gray',
  'viridis',
  'plasma',
  'inferno',
  'magma',
  'cividis',
  'turbo',
  'jet',
  'hot',
  'cool',
  'bone',
  'coolwarm',
  'bwr',
  'freesurfer-heat',
  'blue-cyan',
];

export const LABEL_MODES: readonly VolumeLayer['labelMode'][] = ['fill', 'outline', 'both'];
export const NEGATIVE_MODES = ['mirror', 'hide', 'separate'] as const;

// ------------------------------------------------------------------------------------------------
// Scale
// ------------------------------------------------------------------------------------------------

/**
 * The value window a `Scale` displays, whichever kind it is.
 *
 * A `heat` scale's window is `[min, max]` and **not** `[-max, max]`: the negative branch is a
 * reflection of the positive one (§7.6), so the handles the user drags are the two numbers that
 * exist, not the four the bake produces.
 */
export function scaleWindow(scale: Scale): ValueWindow {
  return scale.kind === 'linear'
    ? { lo: scale.lo, hi: scale.hi }
    : { lo: scale.min, hi: scale.max };
}

/**
 * Move a `Scale`'s window without changing its kind.
 *
 * `heat`'s `mid` keeps its **fraction** of the old window rather than its absolute value: dragging
 * `max` out to a larger number should stretch the ramp, not leave `mid` pinned near the bottom of
 * it, and `mid` outside `[min, max]` is not a state §4.2 has an answer for.
 */
export function withWindow(scale: Scale, window: ValueWindow): Scale {
  const { lo, hi } = normalizeWindow(window);
  if (scale.kind === 'linear') return { ...scale, lo, hi };
  const span = scale.max - scale.min;
  const f = span > 0 ? (scale.mid - scale.min) / span : 0.5;
  return { ...scale, min: lo, max: hi, mid: lo + (hi - lo) * Math.min(1, Math.max(0, f)) };
}

/**
 * Switch a scale between §4.2's two kinds, **preserving what is on screen**.
 *
 * linear → heat keeps `[lo, hi]` as `[min, max]` and puts `mid` at the midpoint; heat → linear keeps
 * `[min, max]`. Seeding from `Stats` instead would make the picture jump every time a user looked at
 * the other kind, and the numbers they had just dialled in would be gone.
 */
export function switchScaleKind(scale: Scale, kind: Scale['kind'], stats: Stats): Scale {
  if (scale.kind === kind) return scale;
  if (kind === 'linear') {
    const w = scaleWindow(scale);
    return { kind: 'linear', lo: w.lo, hi: w.hi };
  }
  const w = normalizeWindow(scaleWindow(scale));
  return {
    kind: 'heat',
    min: w.lo,
    mid: (w.lo + w.hi) / 2,
    max: w.hi,
    truncate: false,
    inverse: false,
    negative: stats.min < 0 ? 'mirror' : 'hide',
  };
}

/** One field of a `heat` scale. A no-op on a `linear` one, which has none of them. */
export function patchHeat(
  scale: Scale,
  patch: Partial<Omit<Extract<Scale, { kind: 'heat' }>, 'kind'>>
): Scale {
  if (scale.kind !== 'heat') return scale;
  const next = { ...scale, ...patch };
  // §4.2 has no meaning for a `mid` outside the ramp, and the CPU bake divides by `mid - min`.
  next.max = Math.max(next.max, next.min);
  next.mid = Math.min(next.max, Math.max(next.min, next.mid));
  return next;
}

// ------------------------------------------------------------------------------------------------
// Threshold
// ------------------------------------------------------------------------------------------------

/**
 * Patch a `Threshold`, keeping `lo <= hi` and `softEdge` inside §4.2's definition.
 *
 * §4.2 defines `softEdge` as "the **width of the alpha ramp as a fraction of `hi - lo`**; 0 = hard
 * discard" — so it is a 0..1 number, not a count of bins and not a fraction of one bin. The editor
 * labels it that way and clamps it here, because the shader divides by it.
 */
export function patchThreshold(threshold: Threshold, patch: Partial<Threshold>): Threshold {
  const next = { ...threshold, ...patch };
  if (patch.lo !== undefined && patch.hi === undefined) next.hi = Math.max(next.hi, next.lo);
  else if (patch.hi !== undefined && patch.lo === undefined) next.lo = Math.min(next.lo, next.hi);
  else if (next.hi < next.lo) next.hi = next.lo;
  next.softEdge = Math.min(1, Math.max(0, next.softEdge));
  return next;
}

/** The threshold window the histogram draws handles for. */
export function thresholdWindow(threshold: Threshold): ValueWindow {
  return { lo: threshold.lo, hi: threshold.hi };
}

// ------------------------------------------------------------------------------------------------
// Interpolation — §7.1's named fallback, and audit P2-08
// ------------------------------------------------------------------------------------------------

export type ForcedNearest =
  /** §4.4: "Forced to `'nearest'` when `dataset.isLabel`" — a definition, not a degradation. */
  | { reason: 'label'; detail: string }
  /**
   * §7.1: "`OES_texture_float_linear` absent ⇒ force `interpolation:'nearest'` on R32F layers **and
   * flag it in the layer panel**". Phase 1 forced it and never flagged it (audit P2-08).
   */
  | { reason: 'floatLinear'; detail: string }
  | null;

/**
 * Why this layer cannot be interpolated, or `null` when it can.
 *
 * The signal is `VolumeDataset.gpu.filterable` (§4.3: "LINEAR is legal on this format on this GPU"),
 * not a re-derivation from the format name: the §6.1 ladder decides the format and `caps` decides
 * whether it filters, and the loader has already combined them into that one boolean.
 */
export function forcedNearest(ds: VolumeDataset, caps: Capabilities | null): ForcedNearest {
  if (ds.isLabel) {
    return {
      reason: 'label',
      detail:
        'Label volumes sample nearest by definition (§4.4) — an interpolated id is not an id.',
    };
  }
  if (ds.gpu.filterable) return null;
  const renderer = caps?.renderer ?? 'this renderer';
  return {
    reason: 'floatLinear',
    detail:
      `${ds.gpu.format} is not filterable on ${renderer} ` +
      '(OES_texture_float_linear absent, §7.1), so this layer is forced to nearest.',
  };
}

/** The interpolation actually in effect, which is not always the one on the layer. */
export function effectiveInterpolation(
  layer: VolumeLayer,
  ds: VolumeDataset,
  caps: Capabilities | null
): VolumeLayer['interpolation'] {
  return forcedNearest(ds, caps) === null ? layer.interpolation : 'nearest';
}

// ------------------------------------------------------------------------------------------------
// 4D
// ------------------------------------------------------------------------------------------------

/**
 * A 4D frame step, clamped to the dataset — or `null` when there is nowhere to go.
 *
 * Returning `null` rather than a no-op patch is what lets the spinner disable its own arrows: §8's
 * controls say what they can do, and audit P2-05 is what happens when they do not.
 */
export function volumeIndexPatch(
  layer: VolumeLayer,
  ds: VolumeDataset,
  next: number
): Partial<VolumeLayer> | null {
  const clamped = Math.round(next);
  if (clamped < 0 || clamped >= ds.nvols || clamped === layer.volumeIndex) return null;
  return { volumeIndex: clamped };
}

// ------------------------------------------------------------------------------------------------
// Label display
// ------------------------------------------------------------------------------------------------

/** §7.0.5's outline width is in **render-target px**, so it is clamped to a sane pixel range. */
export function clampOutlineWidth(px: number): number {
  if (!Number.isFinite(px)) return 1;
  return Math.min(8, Math.max(0.5, px));
}
