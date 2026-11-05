import { describe, expect, it } from 'vitest';
import type { Dataset, TractFieldInfo, TractogramDataset, TractsLayer } from '@tetravox/engine';
import {
  displayedText,
  groupSources,
  offersMode,
  sampleChoices,
  selectMode,
  takesBasis,
  toggleGroup,
  tractsSummary,
  VECTOR_BASES,
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

describe('sampling frames and modes', () => {
  const volume = (nvols: number, isLabel = false) =>
    ({ kind: 'volume', id: 'v', nvols, isLabel }) as unknown as Dataset;

  it('asks for a basis only where the frame changes the answer', () => {
    const rows = sampleChoices(volume(3));
    const of = (key: string) => rows.find((r) => r.key === key)!.spec;
    expect(takesBasis(of('vec-abs-dot'))).toBe(true);
    expect(takesBasis(of('vec-dot'))).toBe(true);
    expect(takesBasis(of('vec-abs-cross'))).toBe(true);
    expect(takesBasis(of('vec-magnitude'))).toBe(false);
    expect(takesBasis(of('v0'))).toBe(false);
    expect(VECTOR_BASES.map((b) => b.value)).toEqual(['world', 'fsl', 'voxel']);
  });

  it('calls a label volume what it reads', () => {
    expect(sampleChoices(volume(1, true))[0]?.label).toBe('label (nearest)');
    expect(sampleChoices(volume(1))[0]?.label).toBe('value');
  });

  it('offers group colour only when something can name a group', () => {
    const none = { groups: [], streamlineFields: [] } as unknown as TractogramDataset;
    const named = { groups: [{ id: 0 }], streamlineFields: [] } as unknown as TractogramDataset;
    const direction = { colorMode: 'direction' } as TractsLayer;
    expect(offersMode(none, direction, 'group')).toBe(false);
    expect(offersMode(none, direction, 'solid')).toBe(true);
    expect(offersMode(named, direction, 'group')).toBe(true);
    expect(offersMode(none, { colorMode: 'group' } as TractsLayer, 'group')).toBe(true);
  });
});
