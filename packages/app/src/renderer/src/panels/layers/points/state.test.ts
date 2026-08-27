/**
 * The points editor's reducers.
 *
 * The layer is shaped after a SimNIBS `eeg_positions/*.csv` net: named electrodes, most of them
 * following the layer's colour and radius, a couple carrying their own.
 */

import { describe, expect, it } from 'vitest';
import type { PointsLayer, vec4 } from '@tetravox/engine';
import {
  filterPoints,
  pointRows,
  pointsSourceText,
  resetPoint,
  setPointColor,
  setPointRadius,
  setPointsColor,
  setPointsRadius,
  setPointsShape,
  setShowLabels,
} from './state';

const RED: vec4 = [1, 0, 0, 1];

function pointsLayer(over: Partial<PointsLayer> = {}): PointsLayer {
  return {
    id: 'ly1',
    datasetId: 'ds1',
    name: 'eeg_positions.csv',
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: false,
    kind: 'points',
    points: [
      { name: 'Fp1', position: [-21.2, 66.9, 12.1] },
      { name: 'Fp2', position: [21.2, 66.9, 12.1], color: RED },
      { name: 'Cz', position: [0, -9.2, 100.2], radiusMm: 8 },
    ],
    shape: 'sphere',
    radiusMm: 4,
    color: [0.2, 0.8, 1, 1],
    showLabels: false,
    ...over,
  };
}

describe('point rows', () => {
  it('falls back to the layer’s colour and radius, and flags the points that do not', () => {
    const rows = pointRows(pointsLayer());
    expect(rows.map((r) => r.name)).toEqual(['Fp1', 'Fp2', 'Cz']);
    expect(rows[0]?.color).toEqual([0.2, 0.8, 1, 1]);
    expect(rows[0]?.radiusMm).toBe(4);
    expect(rows[0]?.overridden).toBe(false);
    expect(rows[1]?.color).toEqual(RED);
    expect(rows[1]?.overridden).toBe(true);
    expect(rows[2]?.radiusMm).toBe(8);
    expect(rows[2]?.overridden).toBe(true);
  });

  it('names an unnamed point by its index, so a row is never blank', () => {
    const rows = pointRows(pointsLayer({ points: [{ position: [0, 0, 0] }] }));
    expect(rows[0]?.name).toBe('#1');
  });

  it('searches by name', () => {
    const rows = pointRows(pointsLayer());
    expect(filterPoints(rows, 'fp').map((r) => r.name)).toEqual(['Fp1', 'Fp2']);
    expect(filterPoints(rows, '').length).toBe(3);
  });

  it('says where the points came from and how many there are', () => {
    const dataset = { kind: 'volume', name: 'x', path: '/data/eeg_positions.csv' } as never;
    expect(pointsSourceText(dataset, pointsLayer())).toBe('/data/eeg_positions.csv · 3 points');
    expect(pointsSourceText(undefined, pointsLayer({ points: [{ position: [0, 0, 0] }] }))).toBe(
      'eeg_positions.csv · 1 point'
    );
  });
});

describe('point controls', () => {
  it('is one field per control, and never a negative radius', () => {
    expect(setPointsRadius(pointsLayer(), 6)).toEqual({ radiusMm: 6 });
    expect(setPointsRadius(pointsLayer(), -1)).toEqual({ radiusMm: 0 });
    expect(setPointsColor(pointsLayer(), RED)).toEqual({ color: RED });
    expect(setPointsShape(pointsLayer(), 'dot')).toEqual({ shape: 'dot' });
    expect(setShowLabels(pointsLayer(), true)).toEqual({ showLabels: true });
  });

  it('overrides one point without touching its neighbours', () => {
    const patch = setPointColor(pointsLayer(), 0, RED);
    expect(patch.points?.[0]?.color).toEqual(RED);
    expect(patch.points?.[2]).toEqual(pointsLayer().points[2]);
    expect(setPointRadius(pointsLayer(), 0, 2).points?.[0]?.radiusMm).toBe(2);
    expect(setPointColor(pointsLayer(), 99, RED)).toEqual({});
  });

  it('resets a point back to the layer’s own colour and radius', () => {
    const layer = pointsLayer();
    const patch = resetPoint(layer, 1);
    expect(patch.points?.[1]).toEqual({ name: 'Fp2', position: [21.2, 66.9, 12.1] });
    const rows = pointRows({ ...layer, ...patch } as PointsLayer);
    expect(rows[1]?.overridden).toBe(false);
    expect(rows[1]?.color).toEqual(layer.color);
  });
});
