/**
 * The layer-runtime registry and the two runtimes that do something in Phase 1.
 *
 * The registry's whole reason to exist is exhaustiveness over §4.4's four kinds, so the first test
 * asserts that rather than trusting the type. The volume probe is an **analytic** assertion in §11's
 * sense — the expected value is computed from the affine and the scale/inter, not read off a
 * previous run — and it is the one piece of §8's "zero latency" probe path that needs no GL.
 */

import { describe, expect, it } from 'vitest';
import { LAYER_KINDS, createLayerRuntime } from './registry';
import { CutManager } from '../compute/cut-manager';
import type { LayerRuntimeContext } from './runtime';
import { PICK_OPACITY_MIN, pickableIn, visibleIn } from './runtime';
import { defaultLayerFor } from '../scene/defaults';
import type { GpuStore } from '../render/gpu';
import type {
  Dataset,
  IsosurfaceLayer,
  Layer,
  PointsLayer,
  SliceView,
  View3D,
  VolumeDataset,
} from '../scene/types';

/** A context whose GPU store holds nothing: enough for probes, and for "no texture ⇒ no draw". */
const EMPTY_CONTEXT: LayerRuntimeContext = {
  gpu: { volume: () => undefined, surface: () => undefined } as unknown as GpuStore,
  client: () => undefined,
  requestRender: () => {},
  track: <T>(p: Promise<T>) => p,
  // No dataset resolves, so every `requestCut` is a no-op — which is what a registry test wants.
  cuts: new CutManager(() => undefined),
};

const AXIAL: SliceView = {
  id: 'axial',
  mode: 'axial',
  normal: [0, 0, 1],
  up: [0, 1, 0],
  camera: { center: [0, 0], mmPerPx: 1 },
};

const VIEW3D: View3D = {
  id: 'view3d',
  camera: {
    target: [0, 0, 0],
    distance: 10,
    rotation: [0, 0, 0, 1],
    fovYDeg: 35,
    orthographic: false,
    near: 1,
    far: 100,
  },
  showSlicePlanes: false,
};

/**
 * A 4×4×4 volume with `v = i`, identity affine — §11's own example fixture, minus the GL half.
 *
 * Only the fields the runtime reads are populated; the cast says so rather than fabricating a full
 * `VolumeDataset` that would go stale the moment §4.3 gains a field.
 */
function volumeDataset(isLabel = false): VolumeDataset {
  const data = new Float32Array(64);
  for (let k = 0; k < 4; k += 1) {
    for (let j = 0; j < 4; j += 1) {
      for (let i = 0; i < 4; i += 1) data[(k * 4 + j) * 4 + i] = i;
    }
  }
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    id: 'ds1',
    kind: 'volume',
    name: 'fixture',
    dims: [4, 4, 4],
    nvols: 1,
    data,
    sclSlope: 2,
    sclInter: 1,
    affine: identity,
    inverseAffine: identity,
    isLabel,
    labelTable: isLabel
      ? { byId: new Map([[3, { id: 3, name: 'three', color: [1, 0, 0, 1] }]]), entries: [] }
      : undefined,
    stats: { min: 0, max: 3, percentiles: { '2': 0, '98': 3 } },
    bounds: { min: [0, 0, 0], max: [3, 3, 3] },
    spacing: [1, 1, 1],
  } as unknown as VolumeDataset;
}

function volumeLayer(ds: VolumeDataset): Layer {
  return defaultLayerFor('layer1', ds);
}

describe('the layer registry', () => {
  it('covers every §4.4 layer kind, and each runtime reports its own', () => {
    expect([...LAYER_KINDS].sort()).toEqual(['iso', 'mesh', 'points', 'volume']);

    const ds = volumeDataset();
    const volume = createLayerRuntime(volumeLayer(ds), ds, EMPTY_CONTEXT);
    expect(volume.kind).toBe('volume');

    const iso = { id: 'l2', datasetId: 'ds1', name: 'iso', kind: 'iso' } as IsosurfaceLayer;
    expect(createLayerRuntime(iso, ds as Dataset, EMPTY_CONTEXT).kind).toBe('iso');

    const points = { id: 'l3', datasetId: 'ds1', name: 'pts', kind: 'points' } as PointsLayer;
    expect(createLayerRuntime(points, ds as Dataset, EMPTY_CONTEXT).kind).toBe('points');
  });

  it('the Phase-2 kinds are inert but present — they never crash a probe or a frame', () => {
    const ds = volumeDataset();
    for (const kind of ['iso', 'points'] as const) {
      const layer = { id: `l-${kind}`, datasetId: 'ds1', name: kind, kind } as Layer;
      const rt = createLayerRuntime(layer, ds as Dataset, EMPTY_CONTEXT);
      expect(rt.drawItems(AXIAL)).toEqual([]);
      expect(rt.drawItems(VIEW3D)).toEqual([]);
      expect(rt.pickItems(VIEW3D)).toEqual([]);
      expect(rt.probeRow([0, 0, 0])).toEqual({ layerId: `l-${kind}`, layerName: kind, kind });
      expect(() => {
        rt.refreshProbe([0, 0, 0]);
        rt.ensurePickGeometry(VIEW3D);
        rt.dispose();
      }).not.toThrow();
    }
  });
});

describe('VolumeLayerRuntime.probeRow', () => {
  it('reads the retained typed array and applies `scl_slope` / `scl_inter`', () => {
    const ds = volumeDataset();
    const rt = createLayerRuntime(volumeLayer(ds), ds, EMPTY_CONTEXT);
    // Identity affine ⇒ world (2, 1, 3) is voxel (2, 1, 3); the fixture stores `v = i` = 2, and
    // §6.1's reading is `raw * slope + inter` = 2 * 2 + 1 = 5.
    const row = rt.probeRow([2, 1, 3]);
    expect(row.voxel).toEqual([2, 1, 3]);
    expect(row.value).toBe(5);
    expect(row.labelId).toBeUndefined();
  });

  it('names the label when the dataset is one, from the table and not the raw id', () => {
    const ds = volumeDataset(true);
    const rt = createLayerRuntime(volumeLayer(ds), ds, EMPTY_CONTEXT);
    // voxel (1, 0, 0) stores 1 ⇒ 1 * 2 + 1 = 3, which the fixture's table calls "three".
    const row = rt.probeRow([1, 0, 0]);
    expect(row.labelId).toBe(3);
    expect(row.labelName).toBe('three');
  });

  it('returns a row with no value outside the volume, rather than a garbage sample', () => {
    const ds = volumeDataset();
    const rt = createLayerRuntime(volumeLayer(ds), ds, EMPTY_CONTEXT);
    for (const world of [
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
      [4, 0, 0],
      [0, 4, 0],
      [0, 0, 4],
    ] as [number, number, number][]) {
      const row = rt.probeRow(world);
      expect(row.value, String(world)).toBeUndefined();
      expect(row.voxel, String(world)).toBeUndefined();
    }
  });

  it('draws nothing without a texture, and nothing at all in a 3D pane in Phase 1', () => {
    const ds = volumeDataset();
    const rt = createLayerRuntime(volumeLayer(ds), ds, EMPTY_CONTEXT);
    // §7.3's `showIn3D` planes are Phase 2's.
    expect(rt.drawItems(VIEW3D)).toEqual([]);
    // And with no uploaded texture there is nothing to draw in 2D either.
    expect(rt.drawItems(AXIAL)).toEqual([]);
  });
});

describe('the shared visibility rules', () => {
  const ds = volumeDataset();
  const base = volumeLayer(ds);

  it('`visibleIn` honours the layer flag and the per-view override (§4.5)', () => {
    expect(visibleIn(base, AXIAL)).toBe(true);
    expect(visibleIn({ ...base, visible: false }, AXIAL)).toBe(false);
    const hidden: SliceView = { ...AXIAL, layerVisibility: { [base.id]: false } };
    expect(visibleIn(base, hidden)).toBe(false);
    // An override for a *different* layer must not hide this one.
    expect(visibleIn(base, { ...AXIAL, layerVisibility: { other: false } })).toBe(true);
  });

  it('`pickableIn` is §7.2.3’s `visible && pickable && opacity >= 0.25`', () => {
    expect(PICK_OPACITY_MIN).toBe(0.25);
    expect(pickableIn(base)).toBe(true);
    expect(pickableIn({ ...base, pickable: false })).toBe(false);
    expect(pickableIn({ ...base, visible: false })).toBe(false);
    expect(pickableIn({ ...base, opacity: 0.25 })).toBe(true);
    expect(pickableIn({ ...base, opacity: 0.2499 })).toBe(false);
  });
});
