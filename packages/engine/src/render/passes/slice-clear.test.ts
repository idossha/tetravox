/**
 * §4.4's `clearBackground`, the arithmetic half: which volumes get it by default, and the
 * `uClearBelow` uniform the slice pass sends. The pixels are `test/e2e/slice-clear-background.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import { clearBelow } from './slice';
import {
  backgroundLevel,
  defaultLayerFor,
  defaultVolumeLayer,
  hasBackgroundFill,
} from '../../scene/defaults';
import type { GpuScalarFormat, VolumeDataset, VolumeLayer } from '../../scene/types';

/** The sentinel `clearBelow` answers when nothing is cleared (`slice.ts`'s `UNBOUNDED`). */
const OFF = -1e30;

function volume(
  over: {
    min?: number;
    max?: number;
    p1?: number;
    p5?: number;
    isLabel?: boolean;
    format?: GpuScalarFormat;
    scale?: number;
  } = {}
): VolumeDataset {
  const min = over.min ?? 0;
  const max = over.max ?? 65535;
  const p5 = over.p5 ?? min;
  const p1 = over.p1 ?? p5;
  return {
    kind: 'volume',
    id: 'ds1',
    name: 'T1.nii.gz',
    isLabel: over.isLabel ?? false,
    gpu: {
      format: over.format ?? 'R16',
      scale: over.scale ?? 1,
      offset: min,
      filterable: true,
      chunked: false,
    },
    stats: {
      min,
      max,
      mean: 0,
      percentiles: {
        '0.1': min,
        '1': p1,
        '2': p5,
        '5': p5,
        '50': (min + max) / 2,
        '95': max * 0.9,
        '98': max * 0.95,
        '99': max * 0.97,
        '99.9': max,
      },
      histogram: new Uint32Array(256),
      histogramLo: min,
      histogramHi: max,
    },
  } as unknown as VolumeDataset;
}

function layer(ds: VolumeDataset, over: Partial<VolumeLayer> = {}): VolumeLayer {
  return { ...defaultVolumeLayer('layer1', ds), ...over };
}

/** One fine histogram bin of `ds` (§6.1's 65536 bins over `[min, max]`). */
const bin = (ds: VolumeDataset): number => (ds.stats.max - ds.stats.min) / 65536;

describe('backgroundLevel and hasBackgroundFill — the default rule', () => {
  it('a low plateau (p1 === p5) is the background, whatever the minimum below it', () => {
    // ernie's T1.nii.gz: min −41.8 from 0.1 % ringing voxels, the zero plateau reported (float
    // path) as its bin's lower edge, −0.78. The level must clear the true 0, so it adds a bin.
    const t1 = volume({ min: -41.8075, max: 65535, p1: -0.782, p5: -0.782, format: 'R32F' });
    expect(hasBackgroundFill(t1)).toBe(true);
    expect(backgroundLevel(t1.stats)).toBeCloseTo(-0.782 + bin(t1), 9);
    expect(backgroundLevel(t1.stats)).toBeGreaterThan(0);
    expect(backgroundLevel(t1.stats)).toBeLessThan(0.25);
  });

  it('a padded CT qualifies, and its level stays under the next integer', () => {
    const ct = volume({ min: -1024, max: 3071, p1: -1024, p5: -1024 });
    expect(hasBackgroundFill(ct)).toBe(true);
    expect(backgroundLevel(ct.stats)).toBeGreaterThan(-1024);
    expect(backgroundLevel(ct.stats)).toBeLessThan(-1023);
  });

  it('no plateau ⇒ not seeded, and an explicit enable falls back to the minimum', () => {
    // A z-map: one extreme voxel at the minimum, a spread of values above it.
    const z = volume({ min: -11700, max: 11700, p1: -11700, p5: -10500 });
    expect(hasBackgroundFill(z)).toBe(false);
    expect(backgroundLevel(z.stats)).toBe(-11700 + bin(z));
  });

  it('is false for labels, RGB and a constant volume', () => {
    expect(hasBackgroundFill(volume({ isLabel: true }))).toBe(false);
    expect(hasBackgroundFill(volume({ format: 'RGBA8' }))).toBe(false);
    expect(hasBackgroundFill(volume({ min: 7, max: 7, p5: 7 }))).toBe(false);
  });

  it('seeds `clearBackground` on exactly those layers, and leaves it absent otherwise', () => {
    expect(defaultVolumeLayer('l', volume()).clearBackground).toEqual({ enabled: true });
    expect('clearBackground' in defaultVolumeLayer('l', volume({ p1: 0, p5: 100 }))).toBe(false);
    expect('clearBackground' in defaultVolumeLayer('l', volume({ isLabel: true }))).toBe(false);
    expect((defaultLayerFor('l', volume()) as VolumeLayer).clearBackground).toEqual({
      enabled: true,
    });
  });
});

describe('clearBelow — the uniform', () => {
  it('clears nothing when the field is absent, disabled, or the layer is labels or tensors', () => {
    const ds = volume();
    const noFill = volume({ p1: 0, p5: 100 });
    expect(clearBelow(layer(noFill), noFill)).toBe(OFF);
    expect(clearBelow(layer(ds, { clearBackground: { enabled: false } }), ds)).toBe(OFF);
    const labels = volume({ isLabel: true });
    expect(clearBelow(layer(labels, { clearBackground: { enabled: true } }), labels)).toBe(OFF);
    const tensor = { order: 'fsl', basis: 'fsl', stride: 1, minFA: 0 } as const;
    expect(clearBelow(layer(ds, { tensor }), ds)).toBe(OFF);
  });

  it('defaults to the background level, plus half a code on the normalised formats', () => {
    const ds = volume({ min: 0, scale: 1 });
    expect(clearBelow(layer(ds), ds)).toBe(backgroundLevel(ds.stats) + 0.5);
    const r8 = volume({ min: 0, max: 255, format: 'R8', scale: 2 });
    expect(clearBelow(layer(r8), r8)).toBe(backgroundLevel(r8.stats) + 1);
  });

  it('an explicit cut-off gets only the format slack: half a code, never a whole one', () => {
    for (const scale of [1, 0.25, 3.7, 1e-4]) {
      const ds = volume({ min: -1024, scale });
      const cut = clearBelow(layer(ds, { clearBackground: { enabled: true, value: 40 } }), ds);
      expect(cut).toBe(40 + 0.5 * scale);
      expect(cut).toBeLessThan(40 + scale);
    }
  });

  it('allows a relative ulp on the float formats, and nothing at zero', () => {
    const on = (value: number) => ({ clearBackground: { enabled: true, value } });
    const f32 = volume({ format: 'R32F' });
    expect(clearBelow(layer(f32, on(0)), f32)).toBe(0);
    expect(clearBelow(layer(f32, on(-1000)), f32)).toBe(-1000 + 1000 * 2 ** -22);
    const half = volume({ format: 'R16F' });
    expect(clearBelow(layer(half, on(2048)), half)).toBe(2048 + 2);
  });

  it("uses the layer's own cut-off when it has one, and the background level when not finite", () => {
    const ds = volume({ min: 0, format: 'R32F' });
    const level = backgroundLevel(ds.stats);
    const at = (value: number) =>
      clearBelow(layer(ds, { clearBackground: { enabled: true, value } }), ds);
    expect(at(300)).toBe(300 + 300 * 2 ** -22);
    expect(at(NaN)).toBe(level + level * 2 ** -22);
    expect(at(Infinity)).toBe(level + level * 2 ** -22);
  });
});
