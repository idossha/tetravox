/**
 * The histogram widget — **Phase 2** (owner: A-PROPS).
 *
 * §8: "in the volume and mesh-field property editors: log-y toggle, draggable window and threshold
 * handles, the current colormap painted along the x axis, and presets `min–max`, `2–98 %`,
 * `p50–p99.9`, `symmetric ±p99`."
 *
 * The bins come from `Stats` (§6.1 computes percentiles exactly, with no sampling), so this widget
 * never touches the sample array itself — which is what keeps it off the ≤ 16 ms probe budget and
 * why it can live in React at all.
 *
 * One editor, two producers: a volume layer's `Scale`/`Threshold` and a mesh field's. It takes the
 * numbers, not the layer, so neither owner needs the other's types.
 */

import type { Stats } from '@tetravox/engine';

export interface HistogramProps {
  stats: Stats;
  /** The window currently applied, in physical units. */
  window: { lo: number; hi: number };
  /** The threshold currently applied, or `null` when there is none. */
  threshold: { lo: number; hi: number } | null;
  onWindow(lo: number, hi: number): void;
  onThreshold(lo: number, hi: number): void;
}

export function Histogram(_props: HistogramProps): React.JSX.Element | null {
  return null;
}
