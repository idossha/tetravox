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

/**
 * `valueMode: 'value'` — a parsed view's per-point scalar through the layer's colormap (task 6).
 *
 * Resolved on the CPU in `packPoints`, so it is asserted here rather than as a pixel: the whole
 * point of keeping `points[].value` alongside the colour is that a colormap change recolours the
 * layer without reloading the file, and that is a property of this function.
 */
describe('point colours from a value', () => {
  const withValues = (over: Partial<PointsLayer> = {}): PointsLayer =>
    layer({
      points: [
        { position: [0, 0, 0], value: 0 },
        { position: [1, 0, 0], value: 1 },
      ],
      valueRange: { lo: 0, hi: 1 },
      colormap: 'viridis',
      ...over,
    });

  it('leaves every point the layer colour in the default solid mode', () => {
    const packed = packPoints(withValues());
    // The buffer is f32, so the layer's 0.85 comes back as its nearest float.
    for (const at of [3, 11]) {
      expect(packed[at]).toBeCloseTo(1, 6);
      expect(packed[at + 1]).toBeCloseTo(0.85, 6);
      expect(packed[at + 2]).toBeCloseTo(0.2, 6);
      expect(packed[at + 3]).toBeCloseTo(1, 6);
    }
  });

  it('maps the range endpoints to the colormap endpoints', () => {
    const packed = packPoints(withValues({ valueMode: 'value' }));
    const lo = [...packed.slice(3, 6)];
    const hi = [...packed.slice(11, 14)];
    expect(lo).not.toEqual(hi);
    // viridis runs dark blue-purple → bright yellow-green, so the top of the range is brighter.
    expect(hi[1]).toBeGreaterThan(lo[1] as number);
    // Alpha comes from the layer, so layer opacity and per-point colour stay separable.
    expect(packed[6]).toBe(1);
  });

  /**
   * Every SimNIBS net writes `{0}` for every electrode. A flat field has no gradient to show, so
   * it takes the colormap's midpoint — never a division by zero, and never all-black.
   */
  it('maps a flat field to the colormap midpoint', () => {
    const flat = withValues({
      valueMode: 'value',
      points: [
        { position: [0, 0, 0], value: 0 },
        { position: [1, 0, 0], value: 0 },
      ],
      valueRange: { lo: 0, hi: 0 },
    });
    const packed = packPoints(flat);
    expect([...packed.slice(3, 7)]).toEqual([...packed.slice(11, 15)]);
    expect(Number.isFinite(packed[3])).toBe(true);
    expect(packed[3]).toBeGreaterThan(0);
  });

  it('lets a per-point colour win over the value, as it does over the layer colour', () => {
    const packed = packPoints(
      withValues({
        valueMode: 'value',
        points: [{ position: [0, 0, 0], value: 1, color: [0, 1, 0, 1] }],
      })
    );
    expect([...packed.slice(3, 7)]).toEqual([0, 1, 0, 1]);
  });
});
