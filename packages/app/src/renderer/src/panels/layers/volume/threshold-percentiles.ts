import type { Stats, PercentileKey } from '@tetravox/engine';

const KEYS: PercentileKey[] = ['0.1', '1', '2', '5', '50', '95', '98', '99', '99.9'];

type ThresholdStats = Pick<Stats, 'min' | 'max' | 'percentiles'>;

function anchors(stats: ThresholdStats): [number, number][] {
  return [
    [0, stats.min],
    ...KEYS.map((key): [number, number] => [Number(key), stats.percentiles[key]]),
    [100, stats.max],
  ];
}

/** Exact at stored percentiles; intermediate percentiles are linear estimates, not voxel ranks. */
export function percentToValue(stats: ThresholdStats, percent: number): number {
  if (Number.isNaN(percent)) return NaN;
  if (percent <= 0) return stats.min;
  if (percent >= 100) return stats.max;
  const points = anchors(stats);
  for (let i = 1; i < points.length; i++) {
    const [hiPercent, hiValue] = points[i]!;
    if (percent <= hiPercent) {
      const [loPercent, loValue] = points[i - 1]!;
      return loValue + ((percent - loPercent) / (hiPercent - loPercent)) * (hiValue - loValue);
    }
  }
  return stats.max;
}

/** Inverts the same estimate. Tied values use the first anchor; endpoints take precedence. */
export function valueToPercent(stats: ThresholdStats, value: number): number {
  if (Number.isNaN(value)) return NaN;
  if (value === -Infinity || value <= stats.min) return 0;
  if (value === Infinity || value >= stats.max) return 100;
  const points = anchors(stats);
  for (let i = 1; i < points.length; i++) {
    const [hiPercent, hiValue] = points[i]!;
    if (value <= hiValue) {
      const [loPercent, loValue] = points[i - 1]!;
      return loPercent + ((value - loValue) / (hiValue - loValue)) * (hiPercent - loPercent);
    }
  }
  return 100;
}
