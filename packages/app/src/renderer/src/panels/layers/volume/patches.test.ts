/**
 * The volume editor's patch builders.
 *
 * §8: "everything the UI can do must be reachable from the `Engine` API alone. No logic in React."
 * That makes the interesting question not "did the control render" but "**what patch did it emit**",
 * and this file is where every §4.2 clause the editor touches is pinned to a number: `softEdge` as a
 * *fraction of `hi - lo`* rather than a bin count, `heat`'s `mid` inside `[min, max]`, and §7.1's
 * forced-nearest fallback flagged rather than silently applied (audit P2-08).
 */

import { describe, expect, it } from 'vitest';
import type {
  Capabilities,
  Scale,
  Stats,
  Threshold,
  VolumeDataset,
  VolumeLayer,
} from '@tetravox/engine';
import {
  COLORMAPS,
  clampOutlineWidth,
  colormapStops,
  effectiveInterpolation,
  forcedNearest,
  patchHeat,
  patchThreshold,
  scaleWindow,
  switchScaleKind,
  thresholdWindow,
  volumeIndexPatch,
  withWindow,
} from './patches';

const STATS: Stats = {
  // T1.nii.gz's real range: float32, and its max is exactly 65535 (AGENTS.md).
  min: -41.807507,
  max: 65535,
  mean: 312.5,
  percentiles: {
    '0.1': -30,
    '1': -20,
    '2': -10,
    '5': 0,
    '50': 400,
    '95': 3000,
    '98': 4000,
    '99': 5000,
    '99.9': 60000,
  },
  histogram: new Uint32Array(256),
  histogramLo: -41.807507,
  histogramHi: 65535,
};

const POSITIVE_STATS: Stats = { ...STATS, min: 0, histogramLo: 0 };

function volumeDataset(over: Partial<VolumeDataset> = {}): VolumeDataset {
  return {
    kind: 'volume',
    id: 'ds1',
    name: 'T1.nii.gz',
    dims: [256, 256, 208],
    nvols: 1,
    dtype: 'f32',
    isLabel: false,
    stats: STATS,
    gpu: { format: 'R16', scale: 1, offset: 0, filterable: true, chunked: false },
    ...over,
  } as unknown as VolumeDataset;
}

function volumeLayer(over: Partial<VolumeLayer> = {}): VolumeLayer {
  return {
    id: 'ly1',
    datasetId: 'ds1',
    kind: 'volume',
    name: 'T1.nii.gz',
    volumeIndex: 0,
    colormap: 'gray',
    scale: { kind: 'linear', lo: 0, hi: 100 },
    threshold: { lo: 0, hi: 100, symmetric: false, mode: 'hide', softEdge: 0 },
    interpolation: 'linear',
    labelMode: 'fill',
    outlineWidthPx: 1,
    showIn3D: false,
    precision: 'auto',
    ...over,
  } as unknown as VolumeLayer;
}

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)', ...over } as Capabilities;
}

describe('the colormap list', () => {
  it('is §4.1’s frozen union in declaration order, so a new colormap cannot be silently dropped', () => {
    expect(COLORMAPS).toHaveLength(15);
    expect(COLORMAPS[0]).toBe('gray');
    expect(COLORMAPS.at(-1)).toBe('blue-cyan');
  });
});

describe('the scale window', () => {
  it('is [lo, hi] for linear and [min, max] — not [−max, max] — for heat', () => {
    expect(scaleWindow({ kind: 'linear', lo: -3, hi: 7 })).toEqual({ lo: -3, hi: 7 });
    const heat: Scale = {
      kind: 'heat',
      min: 2,
      mid: 5,
      max: 9,
      truncate: false,
      inverse: false,
      negative: 'mirror',
    };
    expect(scaleWindow(heat)).toEqual({ lo: 2, hi: 9 });
  });

  it('moves a linear scale’s endpoints', () => {
    expect(withWindow({ kind: 'linear', lo: 0, hi: 1 }, { lo: 5, hi: 50 })).toEqual({
      kind: 'linear',
      lo: 5,
      hi: 50,
    });
  });

  it('keeps heat’s `mid` at the same fraction of the window it was at', () => {
    const heat: Scale = {
      kind: 'heat',
      min: 0,
      mid: 2.5,
      max: 10,
      truncate: false,
      inverse: false,
      negative: 'mirror',
    };
    // mid was a quarter of the way up; after stretching to [0, 40] it must still be.
    const next = withWindow(heat, { lo: 0, hi: 40 });
    expect(next).toMatchObject({ kind: 'heat', min: 0, max: 40, mid: 10 });
  });

  it('never produces a zero-width window, because the CPU bake divides by it', () => {
    const next = withWindow({ kind: 'linear', lo: 0, hi: 1 }, { lo: 4, hi: 4 });
    expect(next.kind === 'linear' && next.hi > next.lo).toBe(true);
  });
});

describe('switching scale kind', () => {
  it('is a no-op on the kind it already is, identity included', () => {
    const scale: Scale = { kind: 'linear', lo: 1, hi: 2 };
    expect(switchScaleKind(scale, 'linear', STATS)).toBe(scale);
  });

  it('carries the window across, so the picture does not jump', () => {
    const heat = switchScaleKind({ kind: 'linear', lo: 20, hi: 60 }, 'heat', STATS);
    expect(heat).toMatchObject({ kind: 'heat', min: 20, mid: 40, max: 60 });
    expect(switchScaleKind(heat, 'linear', STATS)).toEqual({ kind: 'linear', lo: 20, hi: 60 });
  });

  it('seeds the negative branch from the data: mirror when there are negatives, hide when not', () => {
    const withNegatives = switchScaleKind({ kind: 'linear', lo: 0, hi: 1 }, 'heat', STATS);
    expect(withNegatives.kind === 'heat' && withNegatives.negative).toBe('mirror');
    const allPositive = switchScaleKind({ kind: 'linear', lo: 0, hi: 1 }, 'heat', POSITIVE_STATS);
    expect(allPositive.kind === 'heat' && allPositive.negative).toBe('hide');
  });
});

describe('heat’s own fields', () => {
  const heat: Scale = {
    kind: 'heat',
    min: 0,
    mid: 5,
    max: 10,
    truncate: false,
    inverse: false,
    negative: 'mirror',
  };

  it('toggles truncate and inverse without touching the ramp', () => {
    expect(patchHeat(heat, { truncate: true })).toMatchObject({
      min: 0,
      mid: 5,
      max: 10,
      truncate: true,
    });
    expect(patchHeat(heat, { inverse: true })).toMatchObject({ inverse: true });
  });

  it('keeps `mid` inside [min, max] — §4.2 has no meaning for one outside it', () => {
    expect(patchHeat(heat, { mid: 40 })).toMatchObject({ mid: 10 });
    expect(patchHeat(heat, { mid: -40 })).toMatchObject({ mid: 0 });
  });

  it('pushes `max` up rather than letting it fall below `min`', () => {
    expect(patchHeat(heat, { min: 20 })).toMatchObject({ min: 20, max: 20, mid: 20 });
  });

  it('is a no-op on a linear scale, which has none of these fields', () => {
    const linear: Scale = { kind: 'linear', lo: 0, hi: 1 };
    expect(patchHeat(linear, { truncate: true })).toBe(linear);
  });
});

describe('the threshold', () => {
  const threshold: Threshold = { lo: 10, hi: 90, symmetric: false, mode: 'hide', softEdge: 0 };

  it('reports its window for the histogram’s handles', () => {
    expect(thresholdWindow(threshold)).toEqual({ lo: 10, hi: 90 });
  });

  it('pushes `hi` when `lo` is dragged past it, rather than swapping the pair', () => {
    expect(patchThreshold(threshold, { lo: 120 })).toMatchObject({ lo: 120, hi: 120 });
    expect(patchThreshold(threshold, { hi: 5 })).toMatchObject({ lo: 5, hi: 5 });
  });

  it('clamps `softEdge` to 0..1 — §4.2 makes it a FRACTION of hi − lo, not a bin count', () => {
    expect(patchThreshold(threshold, { softEdge: 0.5 }).softEdge).toBe(0.5);
    expect(patchThreshold(threshold, { softEdge: 12 }).softEdge).toBe(1);
    expect(patchThreshold(threshold, { softEdge: -1 }).softEdge).toBe(0);
  });

  it('carries `symmetric` and `mode` through untouched', () => {
    const next = patchThreshold(threshold, { symmetric: true, mode: 'clamp' });
    expect(next).toMatchObject({ symmetric: true, mode: 'clamp', lo: 10, hi: 90 });
  });
});

describe('§7.1’s forced-nearest fallback (audit P2-08)', () => {
  it('is silent on a filterable format', () => {
    expect(forcedNearest(volumeDataset(), caps())).toBeNull();
    expect(effectiveInterpolation(volumeLayer(), volumeDataset(), caps())).toBe('linear');
  });

  it('flags an unfilterable one, naming the format and the renderer', () => {
    const ds = volumeDataset({
      gpu: { format: 'R32F', scale: 1, offset: 0, filterable: false, chunked: false },
    });
    const forced = forcedNearest(ds, caps({ renderer: 'SwiftShader' }));
    expect(forced?.reason).toBe('floatLinear');
    expect(forced?.detail).toContain('R32F');
    expect(forced?.detail).toContain('SwiftShader');
    // The layer still says `linear`; what is in EFFECT is nearest, and that is what the panel shows.
    expect(effectiveInterpolation(volumeLayer(), ds, caps())).toBe('nearest');
  });

  it('calls a label volume’s nearest a definition, not a degradation', () => {
    const ds = volumeDataset({ isLabel: true });
    expect(forcedNearest(ds, caps())?.reason).toBe('label');
  });

  it('survives a null `caps`, which is what the panel has before the engine has booted', () => {
    const ds = volumeDataset({
      gpu: { format: 'R32F', scale: 1, offset: 0, filterable: false, chunked: false },
    });
    expect(forcedNearest(ds, null)?.reason).toBe('floatLinear');
  });
});

describe('the 4D spinner (audit P2-05)', () => {
  const ds = volumeDataset({ nvols: 3 });

  it('steps within the dataset', () => {
    expect(volumeIndexPatch(volumeLayer(), ds, 1)).toEqual({ volumeIndex: 1 });
    expect(volumeIndexPatch(volumeLayer({ volumeIndex: 2 }), ds, 1)).toEqual({ volumeIndex: 1 });
  });

  it('returns null off either end, so the arrow can disable itself rather than lie', () => {
    expect(volumeIndexPatch(volumeLayer(), ds, -1)).toBeNull();
    expect(volumeIndexPatch(volumeLayer({ volumeIndex: 2 }), ds, 3)).toBeNull();
  });

  it('returns null for the frame already shown, so no needless volumeFrame op is issued', () => {
    expect(volumeIndexPatch(volumeLayer(), ds, 0)).toBeNull();
  });

  it('has nowhere to go in a 3D volume', () => {
    expect(volumeIndexPatch(volumeLayer(), volumeDataset({ nvols: 1 }), 1)).toBeNull();
  });
});

describe('the outline width (§7.0.5, render-target px)', () => {
  it('stays in a range a 4-tap outline can actually draw', () => {
    expect(clampOutlineWidth(2)).toBe(2);
    expect(clampOutlineWidth(0)).toBe(0.5);
    expect(clampOutlineWidth(99)).toBe(8);
    expect(clampOutlineWidth(Number.NaN)).toBe(1);
  });
});

describe('§8’s colormap strip', () => {
  it('samples the engine’s own table, so the strip cannot disagree with the pane', () => {
    const stops = colormapStops('gray', 5);
    expect(stops).toHaveLength(5);
    // `gray` is the one colormap whose stops are arithmetic: `t → (t, t, t)`, and `k / 255`
    // round-trips exactly, so these are equalities and not tolerances.
    expect(stops[0]).toBe('#000000');
    expect(stops[4]).toBe('#ffffff');
    expect(stops[2]).toBe('#808080');
  });

  it('is monotonic and never repeats an endpoint, at the default resolution', () => {
    const stops = colormapStops('viridis');
    expect(stops).toHaveLength(17);
    expect(stops[0]).not.toBe(stops[stops.length - 1]);
    expect(new Set(stops).size).toBeGreaterThan(10);
  });

  it('asks for at least two stops however few it is told to take', () => {
    expect(colormapStops('gray', 1)).toHaveLength(2);
    expect(colormapStops('gray', 0)).toHaveLength(2);
  });

  it('returns nothing for a user .json colormap id, rather than painting the wrong one', () => {
    // §4.4 allows `colormap: string`; only the engine can resolve one, so the strip stays neutral.
    expect(colormapStops('my-custom-map')).toEqual([]);
  });
});
