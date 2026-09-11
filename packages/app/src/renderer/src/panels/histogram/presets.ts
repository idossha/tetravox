/** Scalar contrast presets use exact worker percentiles without scanning samples on the UI thread. */

import type { Stats } from '@tetravox/engine';

export type PresetId = 'p1-p99' | 'p50-p99.9' | 'p95-p99.9';

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

/** Scalar contrast choices progress from nearly the whole distribution to its upper tail. */
export const SCALAR_PRESETS: readonly Preset[] = [
  { id: 'p1-p99', label: '1–99%', title: 'Percentiles 1–99 — nearly the full intensity range' },
  {
    id: 'p50-p99.9',
    label: '50–99.9%',
    title: 'Percentiles 50–99.9 — the upper half of intensities',
  },
  { id: 'p95-p99.9', label: '95–99.9%', title: 'Percentiles 95–99.9 — the highest intensities' },
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
    case 'p1-p99':
      return { lo: p['1'], hi: p['99'] };
    case 'p95-p99.9':
      return { lo: p['95'], hi: p['99.9'] };
    case 'p50-p99.9':
      return { lo: p['50'], hi: p['99.9'] };
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
 * input, and `1–99%` typed back in at four decimals is still `1–99%` as far as the user is
 * concerned.
 */
export function activePreset(
  window: ValueWindow,
  stats: Stats,
  tol = 1e-4,
  presets: readonly Preset[] = SCALAR_PRESETS
): PresetId | null {
  const span = Math.max(Math.abs(stats.max - stats.min), Number.EPSILON);
  for (const preset of presets) {
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
