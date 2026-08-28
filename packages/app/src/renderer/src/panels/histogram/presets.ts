/**
 * The four §8 histogram presets, as a pure function of `Stats`.
 *
 * §8: "presets `min–max`, `2–98 %`, `p50–p99.9`, `symmetric ±p99`". §4.2's `Stats.percentiles` is a
 * `Record<PercentileKey, number>` computed **exactly** in the worker (§6.1, no sampling), so a preset
 * is a lookup and a subtraction — never a scan of `VolumeDataset.data`, which is what keeps this
 * widget off the ≤ 16 ms probe budget (§8).
 *
 * `symmetric ±p99` is read **literally**: one percentile, one number, `[-|p99|, +|p99|]`. It exists so
 * a diverging colormap (`bwr` / `coolwarm`, which §7.6 centres at 0 when `threshold.symmetric`) is
 * centred on zero rather than on the middle of the data; taking `max(|p1|, |p99|)` instead would make
 * a one-sided tail silently widen the window the user asked for.
 */

import type { Stats } from '@tetravox/engine';

export type PresetId = 'min-max' | 'p2-p98' | 'p50-p99.9' | 'sym-p99';

export interface ValueWindow {
  lo: number;
  hi: number;
}

export interface Preset {
  id: PresetId;
  /** What the button says. */
  label: string;
  /** The tooltip — which percentiles it reads, so the button is self-documenting. */
  title: string;
}

/** In §8's order. */
export const PRESETS: readonly Preset[] = [
  { id: 'min-max', label: 'min–max', title: 'The full range: Stats.min … Stats.max' },
  { id: 'p2-p98', label: '2–98 %', title: 'Percentiles 2 … 98 — the usual anatomical window' },
  { id: 'p50-p99.9', label: 'p50–p99.9', title: 'Percentiles 50 … 99.9 — an overlay’s hot tail' },
  {
    id: 'sym-p99',
    label: '±p99',
    title: 'Symmetric about zero: −|p99| … +|p99|, for a diverging colormap',
  },
];

/**
 * The window a preset asks for.
 *
 * A degenerate result (`lo === hi`, which every constant volume produces) is returned as-is: it is
 * the honest answer, and {@link normalizeWindow} is where a consumer that cannot divide by zero
 * widens it.
 */
export function applyPreset(id: PresetId, stats: Stats): ValueWindow {
  const p = stats.percentiles;
  switch (id) {
    case 'min-max':
      return { lo: stats.min, hi: stats.max };
    case 'p2-p98':
      return { lo: p['2'], hi: p['98'] };
    case 'p50-p99.9':
      return { lo: p['50'], hi: p['99.9'] };
    case 'sym-p99': {
      const a = Math.abs(p['99']);
      return { lo: -a, hi: a };
    }
  }
}

/** `lo <= hi`, and a non-zero width so `(v - lo) / (hi - lo)` is always finite. */
export function normalizeWindow({ lo, hi }: ValueWindow): ValueWindow {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  if (b > a) return { lo: a, hi: b };
  const eps = Math.max(Math.abs(a) * 1e-6, Number.MIN_VALUE * 4, 1e-12);
  return { lo: a - eps, hi: a + eps };
}

/**
 * Which preset (if any) the current window already is.
 *
 * Compared with a relative tolerance rather than `===`: the window round-trips through a number
 * input, and `2–98 %` typed back in at four decimals is still `2–98 %` as far as the user is
 * concerned.
 */
export function activePreset(window: ValueWindow, stats: Stats, tol = 1e-4): PresetId | null {
  const span = Math.max(Math.abs(stats.max - stats.min), Number.EPSILON);
  for (const preset of PRESETS) {
    const want = applyPreset(preset.id, stats);
    if (
      Math.abs(want.lo - window.lo) <= tol * span &&
      Math.abs(want.hi - window.hi) <= tol * span
    ) {
      return preset.id;
    }
  }
  return null;
}
