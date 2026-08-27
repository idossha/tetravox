/**
 * The histogram widget's arithmetic, with no DOM in sight.
 *
 * Everything the widget does with a pointer — which handle was grabbed, what value a drag landed on,
 * how tall a bar is under a log-y toggle — is a pure function here, so it is asserted by `vitest`
 * against exact numbers rather than by a screenshot of a `<canvas>` (§11 rule 0, applied to DOM: an
 * agent cannot judge a picture; it can judge a number).
 *
 * **Bins come from `Stats.histogram`** — 256 counts over `[histogramLo, histogramHi]`, computed in
 * the worker (§6.1). This module never sees `VolumeDataset.data`, which is what keeps the widget off
 * the ≤ 16 ms probe budget (§8) even while a handle is being dragged.
 *
 * The x axis is the **stats** range, not the window: dragging the window handle has to be able to
 * leave the current window, and a plot whose axis moved with its own handle is unusable.
 */

import type { Stats } from '@tetravox/engine';
import type { ValueWindow } from './presets';

/** Which of the four draggable handles a gesture grabbed. */
export type HandleId = 'windowLo' | 'windowHi' | 'thresholdLo' | 'thresholdHi';

export interface PlotBox {
  /** CSS px. */
  width: number;
  height: number;
}

/** The x axis' physical range: `Stats.histogramLo … histogramHi`, widened when it is degenerate. */
export function axisRange(stats: Stats): ValueWindow {
  const lo = stats.histogramLo;
  const hi = stats.histogramHi;
  if (hi > lo) return { lo, hi };
  const eps = Math.max(Math.abs(lo) * 1e-6, 1e-12);
  return { lo: lo - eps, hi: lo + eps };
}

/** Physical value → x in `[0, width]`. Unclamped: a handle outside the axis must still be drawable. */
export function xForValue(value: number, stats: Stats, box: PlotBox): number {
  const { lo, hi } = axisRange(stats);
  return ((value - lo) / (hi - lo)) * box.width;
}

/** x in CSS px → physical value, clamped to the axis so a drag off the widget cannot run away. */
export function valueAtX(x: number, stats: Stats, box: PlotBox): number {
  const { lo, hi } = axisRange(stats);
  const t = box.width <= 0 ? 0 : Math.min(1, Math.max(0, x / box.width));
  return lo + t * (hi - lo);
}

/**
 * Bar heights in CSS px, one per bin, under the log-y toggle.
 *
 * Linear is `count / max`. Log is `log1p(count) / log1p(max)`, which is the toggle's whole point:
 * `T1.nii.gz` has 54.5 M voxels of which the air peak is most, so on a linear axis every anatomical
 * bin is under one pixel. `log1p` — not `log` — so an empty bin is exactly 0 and a bin of 1 is not
 * `-Inf`.
 */
export function barHeights(counts: Uint32Array, box: PlotBox, logY: boolean): Float32Array {
  const out = new Float32Array(counts.length);
  let max = 0;
  for (const c of counts) if (c > max) max = c;
  if (max === 0) return out;
  const denom = logY ? Math.log1p(max) : max;
  for (let i = 0; i < counts.length; i += 1) {
    const c = counts[i] ?? 0;
    out[i] = ((logY ? Math.log1p(c) : c) / denom) * box.height;
  }
  return out;
}

export interface HandleValues {
  window: ValueWindow;
  /** `null` when the layer has no threshold to drag (never for a `VolumeLayer`, which always has one). */
  threshold: ValueWindow | null;
}

/**
 * The handle nearest `x`, or `null` when none is within `tolPx`.
 *
 * Ties go to the **threshold** handles, because they sit inside the window by construction and a
 * user who has dragged them together is asking for the pair that is on top. Within a pair, `lo` wins
 * — `lo === hi` is reachable (a fully-closed threshold) and the two handles are then the same pixel.
 */
export function handleAt(
  x: number,
  values: HandleValues,
  stats: Stats,
  box: PlotBox,
  tolPx = 6
): HandleId | null {
  const candidates: [HandleId, number][] = [];
  if (values.threshold !== null) {
    candidates.push(['thresholdLo', values.threshold.lo], ['thresholdHi', values.threshold.hi]);
  }
  candidates.push(['windowLo', values.window.lo], ['windowHi', values.window.hi]);

  let best: HandleId | null = null;
  let bestD = tolPx;
  for (const [id, value] of candidates) {
    const d = Math.abs(xForValue(value, stats, box) - x);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/**
 * Apply a drag of `handle` to `x`.
 *
 * Handles **push** rather than swap: dragging `lo` past `hi` pins it at `hi`. A swap would silently
 * invert the window under the pointer and leave the user dragging a different handle than the one
 * they grabbed.
 */
export function dragHandle(
  handle: HandleId,
  x: number,
  values: HandleValues,
  stats: Stats,
  box: PlotBox
): HandleValues {
  const v = valueAtX(x, stats, box);
  switch (handle) {
    case 'windowLo':
      return { ...values, window: { lo: Math.min(v, values.window.hi), hi: values.window.hi } };
    case 'windowHi':
      return { ...values, window: { lo: values.window.lo, hi: Math.max(v, values.window.lo) } };
    case 'thresholdLo':
      if (values.threshold === null) return values;
      return {
        ...values,
        threshold: { lo: Math.min(v, values.threshold.hi), hi: values.threshold.hi },
      };
    case 'thresholdHi':
      if (values.threshold === null) return values;
      return {
        ...values,
        threshold: { lo: values.threshold.lo, hi: Math.max(v, values.threshold.lo) },
      };
  }
}

/** A tick label with as few digits as tells the two endpoints apart. */
export function formatValue(value: number, span: number): string {
  if (!Number.isFinite(value)) return '—';
  const a = Math.abs(value);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return value.toExponential(2);
  const digits = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 4;
  return value.toFixed(digits);
}
