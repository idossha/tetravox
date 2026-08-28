/**
 * The points editor's parsed-Gmsh-view knobs (task 6): label size, and solid-vs-value colouring.
 *
 * Pure state functions, tested without React for the same reason the rest of `state.ts` is: what a
 * control produces is a patch, and a patch is a value.
 */

import { describe, expect, it } from 'vitest';
import { hasPointValues, setLabelScale, setPointsColormap, setValueMode } from './state';
import type { PointsLayer } from '@tetravox/engine';

function layer(over: Partial<PointsLayer> = {}): PointsLayer {
  return {
    id: 'l1',
    datasetId: 'ds1',
    name: 'GSN-HydroCel-185',
    visible: true,
    opacity: 1,
    pickable: false,
    showColorbar: false,
    kind: 'points',
    points: [],
    shape: 'sphere',
    radiusMm: 4,
    color: [1, 0.85, 0.2, 1],
    showLabels: true,
    ...over,
  };
}

describe('label size', () => {
  it('clamps to a legible range', () => {
    expect(setLabelScale(layer(), 2)).toEqual({ labelScale: 2 });
    expect(setLabelScale(layer(), 0)).toEqual({ labelScale: 0.5 });
    expect(setLabelScale(layer(), 99)).toEqual({ labelScale: 4 });
  });
});

describe('colouring by value', () => {
  const withValues = layer({
    points: [
      { position: [0, 0, 0], value: 2 },
      { position: [1, 0, 0], value: 7 },
    ],
  });

  it('offers the row only when the points carry values', () => {
    expect(hasPointValues(withValues)).toBe(true);
    expect(hasPointValues(layer({ points: [{ position: [0, 0, 0] }] }))).toBe(false);
    expect(hasPointValues(layer())).toBe(false);
  });

  it('seeds the range from the points on the first switch to value mode', () => {
    expect(setValueMode(withValues, 'value')).toEqual({
      valueMode: 'value',
      valueRange: { lo: 2, hi: 7 },
    });
  });

  it('leaves a range the user already set alone', () => {
    const pinned = layer({ ...withValues, valueRange: { lo: 0, hi: 1 } });
    expect(setValueMode(pinned, 'value')).toEqual({ valueMode: 'value' });
  });

  it('switching back to solid touches nothing else', () => {
    expect(setValueMode(withValues, 'solid')).toEqual({ valueMode: 'solid' });
  });

  it('passes the colormap through', () => {
    expect(setPointsColormap(withValues, 'turbo')).toEqual({ colormap: 'turbo' });
  });
});
