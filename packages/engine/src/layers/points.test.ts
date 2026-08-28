/**
 * The points layer's two pure functions: what goes into the instance buffer, and what a probe row
 * says.
 *
 * Both are exercised without a GL context on purpose — §11's rule 0 cuts this way for anything that
 * is not a pixel: the packing is eight floats in a fixed order, and an off-by-one there paints every
 * electrode with its neighbour's colour, which looks plausible and is wrong.
 */

import { describe, expect, it } from 'vitest';
import { POINT_INSTANCE_FLOATS, nearestPoint, packPoints } from './points';
import type { PointsLayer } from '../scene/types';

function layer(over: Partial<PointsLayer> = {}): PointsLayer {
  return {
    id: 'l1',
    datasetId: 'ds1',
    name: 'Electrodes',
    visible: true,
    opacity: 1,
    pickable: false,
    showColorbar: false,
    kind: 'points',
    points: [],
    shape: 'sphere',
    radiusMm: 4,
    color: [1, 0.85, 0.2, 1],
    showLabels: false,
    ...over,
  };
}

describe('packPoints', () => {
  it('writes centre, colour and radius per instance, in that order', () => {
    const l = layer({
      points: [
        { position: [1, 2, 3], name: 'Fp1' },
        { position: [4, 5, 6], color: [0, 0.5, 1, 0.25], radiusMm: 7 },
      ],
    });
    const a = packPoints(l);
    expect(a.length).toBe(2 * POINT_INSTANCE_FLOATS);
    // The first falls back to the layer's colour and radius.
    expect([...a.subarray(0, 8)]).toEqual([
      1, 2, 3, 1, 0.8500000238418579, 0.20000000298023224, 1, 4,
    ]);
    // The second carries its own.
    expect([...a.subarray(8, 16)]).toEqual([4, 5, 6, 0, 0.5, 1, 0.25, 7]);
  });

  it('is empty for a layer with no points', () => {
    expect(packPoints(layer()).length).toBe(0);
  });
});

describe('nearestPoint', () => {
  it('finds the closest point and reports its index, name and distance', () => {
    const l = layer({
      points: [
        { position: [0, 0, 0], name: 'A' },
        { position: [10, 0, 0], name: 'B' },
      ],
    });
    const near = nearestPoint(l, [9, 0, 0]);
    expect(near).toEqual({ index: 1, name: 'B', distance: 1 });
  });

  it('is null when there is nothing to find', () => {
    expect(nearestPoint(layer(), [0, 0, 0])).toBeNull();
  });
});
