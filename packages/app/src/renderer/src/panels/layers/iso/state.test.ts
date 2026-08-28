/**
 * The isosurface editor's reducers. Same rule as the mesh editor's: the patch is the product.
 */

import { describe, expect, it } from 'vitest';
import type { Dataset, IsosurfaceLayer, Stats } from '@tetravox/engine';
import {
  isoRange,
  isoSourceKey,
  isoSourceOptions,
  isoStep,
  selectIsoSource,
  setIso,
  setIsoColor,
  setIsoFaceMode,
  setIsoSmooth,
} from './state';

function stats(min: number, max: number): Stats {
  return {
    min,
    max,
    mean: (min + max) / 2,
    percentiles: {
      '0.1': min,
      '1': min,
      '2': min,
      '5': min,
      '50': (min + max) / 2,
      '95': max,
      '98': max,
      '99': max,
      '99.9': max,
    },
    histogram: new Uint32Array(256),
    histogramLo: min,
    histogramHi: max,
  };
}

/** `final_tissues.nii.gz` (0…10) and `Thalamus_TI.msh` (`TI_max`, 0…10.29), in shape. */
const DATASETS: Dataset[] = [
  {
    kind: 'volume',
    id: 'v1',
    name: 'final_tissues.nii.gz',
    stats: stats(0, 10),
  } as unknown as Dataset,
  {
    kind: 'mesh',
    id: 'm1',
    name: 'Thalamus_TI.msh',
    fields: [
      { name: 'TI_max', source: 'elm', ncomp: 1, n: 1, partial: false, stats: stats(0, 10.29) },
    ],
  } as unknown as Dataset,
];

function isoLayer(over: Partial<IsosurfaceLayer> = {}): IsosurfaceLayer {
  return {
    id: 'ly1',
    datasetId: 'v1',
    name: 'iso',
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: false,
    kind: 'iso',
    source: { datasetId: 'v1', volumeIndex: 0 },
    iso: 0.5,
    color: [1, 1, 1, 1],
    smooth: true,
    faceMode: 'cull',
    ...over,
  };
}

describe('iso sources', () => {
  it('lists every volume and every mesh field in the scene, volumes first', () => {
    expect(isoSourceOptions(DATASETS).map((o) => o.key)).toEqual(['vol:v1', 'mesh:m1:elm:TI_max']);
  });

  it('round-trips the layer’s own source through its key', () => {
    expect(isoSourceKey(isoLayer())).toBe('vol:v1');
    expect(
      isoSourceKey(
        isoLayer({
          source: { datasetId: 'm1', field: { source: 'elm', name: 'TI_max', component: 'mag' } },
        })
      )
    ).toBe('mesh:m1:elm:TI_max');
  });

  it('moves the level to the middle of the new range when the source changes', () => {
    const options = isoSourceOptions(DATASETS);
    // 65535 in T1's units is not an iso level in TI_max's; carrying it across is an empty surface.
    const patch = selectIsoSource(options, 'mesh:m1:elm:TI_max');
    expect(patch.source).toEqual({
      datasetId: 'm1',
      field: { source: 'elm', name: 'TI_max', component: 'mag' },
    });
    expect(patch.iso).toBeCloseTo(5.145, 6);
    expect(selectIsoSource(options, 'vol:v1').iso).toBe(5);
    expect(selectIsoSource(options, 'vol:nope')).toEqual({});
  });

  it('spans the source’s own range, and falls back to 0…1 when the source is gone', () => {
    const options = isoSourceOptions(DATASETS);
    expect(isoRange(options, isoLayer())).toEqual({ lo: 0, hi: 10 });
    expect(isoRange(options, isoLayer({ source: { datasetId: 'gone' } }))).toEqual({
      lo: 0,
      hi: 1,
    });
    expect(isoStep({ lo: 0, hi: 10 })).toBe(0.05);
    expect(isoStep({ lo: 3, hi: 3 })).toBe(0.01);
  });
});

describe('iso appearance', () => {
  it('is one field per control', () => {
    expect(setIso(isoLayer(), 2.5)).toEqual({ iso: 2.5 });
    expect(setIsoColor(isoLayer(), [1, 0, 0, 1])).toEqual({ color: [1, 0, 0, 1] });
    expect(setIsoSmooth(isoLayer(), false)).toEqual({ smooth: false });
    expect(setIsoFaceMode(isoLayer(), 'both')).toEqual({ faceMode: 'both' });
  });
});
