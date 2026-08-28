/**
 * The **3D surface** switch's pure half (§4.4's `iso3d`, directed task 2, 2026-08-28).
 *
 * The engine owns what a patch means (`layers/iso3d.test.ts`); what is left to check here is the two
 * decisions the editor makes on its own — the slider's span, and what the switch turns on with.
 */

import { describe, expect, it } from 'vitest';
import type { Stats, VolumeDataset, VolumeLayer } from '@tetravox/engine';
import {
  effectiveIso3d,
  iso3dRange,
  iso3dStep,
  iso3dSummary,
  patchIso3d,
  toggleIso3d,
} from './iso3d';

function stats(over: Partial<Stats> = {}): Stats {
  return {
    min: -41.807507,
    // `T1.nii.gz` really does reach exactly 65535.0 `[DATA]`, and its p95 is three orders of
    // magnitude below that — the reason the slider spans the histogram and not `[min, max]`.
    max: 65535,
    mean: 300,
    percentiles: {
      '0.1': 0,
      '1': 0,
      '2': 0,
      '5': 0,
      '50': 120,
      '95': 1123.5,
      '98': 2000,
      '99': 4000,
      '99.9': 60000,
    },
    histogram: new Uint32Array(256),
    histogramLo: 0,
    histogramHi: 2048,
    ...over,
  };
}

function dataset(over: Partial<VolumeDataset> = {}): VolumeDataset {
  return {
    kind: 'volume',
    id: 'ds1',
    name: 'T1.nii.gz',
    dims: [2, 2, 2],
    nvols: 1,
    affine: new Float32Array(16),
    inverseAffine: new Float32Array(16),
    spacing: [1, 1, 1],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    dtype: 'f32',
    data: new Float32Array(8),
    sclSlope: 1,
    sclInter: 0,
    isLabel: false,
    stats: stats(),
    gpu: { format: 'R32F', scale: 1, offset: 0, filterable: true, chunked: false },
    headerJson: '{}',
    worker: { id: 1 },
    handle: 1,
    ...over,
  };
}

const LAYER: VolumeLayer = {
  id: 'layer1',
  datasetId: 'ds1',
  name: 'T1.nii.gz',
  visible: true,
  opacity: 1,
  pickable: true,
  showColorbar: false,
  kind: 'volume',
  volumeIndex: 0,
  colormap: 'gray',
  scale: { kind: 'linear', lo: 0, hi: 1 },
  threshold: { lo: 0, hi: 1, symmetric: false, mode: 'clamp', softEdge: 0 },
  interpolation: 'linear',
  labelMode: 'fill',
  outlineWidthPx: 1,
  showIn3D: false,
  precision: 'auto',
};

describe('iso3dRange — the slider spans the histogram', () => {
  it('is the histogram range, not [min, max]', () => {
    expect(iso3dRange(dataset())).toEqual({ lo: 0, hi: 2048 });
    // p95 has to be *inside* the span, or the default level is off the end of the slider.
    const range = iso3dRange(dataset());
    expect(1123.5).toBeGreaterThan(range.lo);
    expect(1123.5).toBeLessThan(range.hi);
  });

  it('falls back to [min, max], then to [0, 1], rather than producing a dead slider', () => {
    const noHistogram = dataset({ stats: stats({ histogramLo: 0, histogramHi: 0 }) });
    expect(iso3dRange(noHistogram)).toEqual({ lo: -41.807507, hi: 65535 });
    const flat = dataset({ stats: stats({ histogramLo: 0, histogramHi: 0, min: 1, max: 1 }) });
    expect(iso3dRange(flat)).toEqual({ lo: 0, hi: 1 });
    expect(iso3dStep({ lo: 0, hi: 1 })).toBeCloseTo(0.005);
  });
});

describe('the switch', () => {
  it('turns on at p95 the first time, and keeps the user settings after that', () => {
    const on = toggleIso3d(LAYER, dataset(), true).iso3d!;
    expect(on.enabled).toBe(true);
    expect(on.iso).toBe(1123.5);

    const edited: VolumeLayer = { ...LAYER, iso3d: { ...on, iso: 900, smooth: false } };
    // Off is not a delete…
    const off = toggleIso3d(edited, dataset(), false).iso3d!;
    expect(off).toEqual({ ...edited.iso3d, enabled: false });
    // …so on again is the user's own level, not p95 a second time.
    const again = toggleIso3d({ ...edited, iso3d: off }, dataset(), true).iso3d!;
    expect(again.iso).toBe(900);
    expect(again.smooth).toBe(false);
  });

  it('shows the defaults it would turn on with, so flipping it moves no control', () => {
    const shown = effectiveIso3d(LAYER, dataset());
    expect(shown.enabled).toBe(false);
    expect(shown.iso).toBe(1123.5);
    expect(toggleIso3d(LAYER, dataset(), true).iso3d!.iso).toBe(shown.iso);
  });

  it('patches one field and carries the rest', () => {
    const patched = patchIso3d(LAYER, dataset(), { opacity: 0.4 }).iso3d!;
    expect(patched.opacity).toBe(0.4);
    expect(patched.iso).toBe(1123.5);
  });

  it('summarises the level for a scalar volume and the region count for a label one', () => {
    const spec = toggleIso3d(LAYER, dataset(), true).iso3d!;
    expect(iso3dSummary(dataset(), spec, 0)).toBe('iso 1124');
    expect(iso3dSummary(dataset({ isLabel: true }), spec, 3)).toBe('3 regions');
    expect(iso3dSummary(dataset({ isLabel: true }), spec, 1)).toBe('1 region');
    expect(iso3dSummary(dataset(), { ...spec, enabled: false }, 0)).toBe('off');
  });
});
