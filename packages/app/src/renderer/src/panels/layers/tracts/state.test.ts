import { describe, expect, it } from 'vitest';
import type { Dataset, TractFieldInfo, TractogramDataset, TractsLayer } from '@tetravox/engine';
import {
  displayedText,
  groupSources,
  sampleChoices,
  selectMode,
  toggleGroup,
  tractsSummary,
} from './state';

const percentiles = {
  '0.1': 0,
  '1': 0,
  '2': 1,
  '5': 2,
  '50': 5,
  '95': 8,
  '98': 9,
  '99': 9,
  '99.9': 10,
};
const field = (name: string, extra: Partial<TractFieldInfo> = {}): TractFieldInfo => ({
  name,
  stats: {
    min: 0,
    max: 10,
    mean: 5,
    percentiles,
    histogram: new Uint32Array(256),
    histogramLo: 0,
    histogramHi: 10,
  },
  nanCount: 0,
  ...extra,
});

const tract = (extra: Partial<TractogramDataset> = {}): TractogramDataset =>
  ({
    kind: 'tractogram',
    id: 'ds1',
    name: 'a.tck',
    nStreamlines: 10,
    nPoints: 100,
    sourceStreamlines: 10,
    sourcePoints: 100,
    vertexFields: [field('along')],
    streamlineFields: [field('edge', { categorical: true }), field('length_mm', { builtin: true })],
    groups: [],
    ...extra,
  }) as TractogramDataset;

const layer = { kind: 'tracts', colorMode: 'direction' } as TractsLayer;

describe('the tracts editor', () => {
  it('says "displaying N of M" exactly while N < M', () => {
    expect(displayedText(tract())).toBe('10 streamlines · 100 points');
    expect(displayedText(tract({ sourceStreamlines: 40 }))).toBe(
      'displaying 10 of 40 streamlines · 100 points'
    );
    expect(tractsSummary(tract(), layer)).toContain('direction');
  });

  it('a scalar mode lands on a field at its percentile window', () => {
    expect(selectMode(layer, tract(), 'vertex')).toMatchObject({
      colorMode: 'vertex',
      field: 'along',
      scale: { kind: 'linear', lo: 1, hi: 9 },
    });
    expect(selectMode(layer, tract(), 'solid')).toMatchObject({ colorMode: 'solid' });
  });

  it('offers only categorical fields as group sources, and the file groups first', () => {
    expect(groupSources(tract()).map((s) => s.value)).toEqual(['edge']);
    const named = tract({ groups: [{ id: 0, name: 'cst', count: 3 }] });
    expect(groupSources(named).map((s) => s.value)).toEqual(['', 'edge']);
  });

  it('toggling groups returns to "all" rather than listing them all', () => {
    expect(toggleGroup([1, 2], undefined, 2)).toEqual([1]);
    expect(toggleGroup([1, 2], [1], 2)).toBeUndefined();
  });

  it('offers sampling that fits the source: frames, vector ops, tet meshes only', () => {
    const scalar = { kind: 'volume', id: 'v', nvols: 1 } as Dataset;
    expect(sampleChoices(scalar).map((c) => c.spec.op)).toEqual(['value']);
    const vector = { kind: 'volume', id: 'v', nvols: 3 } as Dataset;
    expect(sampleChoices(vector).map((c) => c.spec.op)).toEqual([
      'value',
      'value',
      'value',
      'magnitude',
      'dot',
      'abs-dot',
      'abs-cross',
    ]);
    const mesh = {
      kind: 'mesh',
      id: 'm',
      nTets: 4,
      fields: [
        { name: 'E', source: 'elm', ncomp: 3 },
        { name: 'TI_max', source: 'elm', ncomp: 1 },
      ],
    } as unknown as Dataset;
    const rows = sampleChoices(mesh);
    expect(rows.filter((c) => c.spec.field?.name === 'E')).toHaveLength(4);
    expect(rows.find((c) => c.spec.field?.name === 'TI_max')?.spec.op).toBe('value');
    const sheet = { kind: 'mesh', id: 's', nTets: 0, fields: [] } as unknown as Dataset;
    expect(sampleChoices(sheet)).toEqual([]);
  });
});
