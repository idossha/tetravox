/**
 * §4.4's `VolumeLayer.iso3d` — the derivation, without a GPU (directed task 2, 2026-08-28).
 *
 * The whole feature rests on one claim: **the surfaces are a pure function of the volume layer**, so
 * "follows the 4D frame / visibility / region visibility / recolour, and goes with the volume" needs
 * no synchronisation code and cannot drift. That claim is testable here in full — the engine's only
 * remaining job is to reconcile one runtime per derived layer, and §11's analytic sphere test proves
 * the pixels.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultIso3d,
  derivedIsoLayers,
  iso3dLabelColor,
  iso3dLabels,
  iso3dLayerId,
} from './iso3d';
import { defaultVolumeLayer } from '../scene/defaults';
import type { LabelEntry, Stats, vec4, VolumeDataset, VolumeLayer } from '../scene/types';

/** Sparse ids, the shape a real SimNIBS LUT has; 0 is background and never gets a surface. */
const IDS = Uint32Array.from([0, 1, 5, 530]);

const COLORS: Record<number, vec4> = {
  0: [0, 0, 0, 0],
  1: [230 / 255, 230 / 255, 210 / 255, 1],
  5: [1, 239 / 255, 179 / 255, 1],
  530: [20 / 255, 180 / 255, 90 / 255, 1],
};

function stats(p95: number, max: number): Stats {
  return {
    min: 0,
    max,
    mean: 0,
    percentiles: {
      '0.1': 0,
      '1': 0,
      '2': 0,
      '5': 0,
      '50': max / 4,
      '95': p95,
      '98': max,
      '99': max,
      '99.9': max,
    },
    histogram: new Uint32Array(256),
    histogramLo: 0,
    histogramHi: max,
  };
}

function dataset(isLabel: boolean, s: Stats): VolumeDataset {
  const entries: LabelEntry[] = [...IDS].map((id) => ({
    id,
    name: `L${id}`,
    color: [...(COLORS[id] ?? [0, 0, 0, 1])] as vec4,
  }));
  return {
    kind: 'volume',
    id: 'ds1',
    name: isLabel ? 'final_tissues' : 'T1',
    dims: [2, 2, 2],
    nvols: 4,
    affine: new Float32Array(16),
    inverseAffine: new Float32Array(16),
    spacing: [1, 1, 1],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    dtype: isLabel ? 'u16' : 'f32',
    data: isLabel ? new Uint16Array(8) : new Float32Array(8),
    sclSlope: 1,
    sclInter: 0,
    isLabel,
    ...(isLabel
      ? { labelIds: IDS, labelTable: { entries, byId: new Map(entries.map((e) => [e.id, e])) } }
      : {}),
    stats: s,
    gpu: { format: 'R32F', scale: 1, offset: 0, filterable: true, chunked: false },
    headerJson: '{}',
    worker: { id: 1 },
    handle: 1,
  };
}

/** A T1-shaped scalar volume: p95 far below a max of exactly 65535 `[DATA]`. */
const SCALAR = dataset(false, stats(1123.5, 65535));
const LABELS = dataset(true, stats(5, 530));

function layerOn(ds: VolumeDataset): VolumeLayer {
  return { ...defaultVolumeLayer('layer1', ds), iso3d: defaultIso3d(ds) };
}

describe('defaultIso3d', () => {
  it('opens a scalar volume at its p95, not at the midpoint of [min, max]', () => {
    // The trap this encodes: `T1.nii.gz` runs to 65535.0, so a midpoint default (32767.5) is an
    // empty surface and a slider whose whole useful range is one pixel wide.
    expect(defaultIso3d(SCALAR).iso).toBe(1123.5);
    expect(defaultIso3d(SCALAR).enabled).toBe(true);
  });
});

describe('derivedIsoLayers — a scalar volume', () => {
  it('is nothing at all until `iso3d` says otherwise', () => {
    const bare = defaultVolumeLayer('layer1', SCALAR);
    expect(bare.iso3d).toBeUndefined();
    expect(derivedIsoLayers(bare, SCALAR)).toEqual([]);
    // Off keeps the settings and builds nothing — the switch is not a delete.
    const off: VolumeLayer = { ...bare, iso3d: { ...defaultIso3d(SCALAR), enabled: false } };
    expect(derivedIsoLayers(off, SCALAR)).toEqual([]);
  });

  it('is one surface, at the layer own 4D frame, in the layer own colour', () => {
    const layer: VolumeLayer = { ...layerOn(SCALAR), volumeIndex: 2 };
    const [iso, ...rest] = derivedIsoLayers(layer, SCALAR);
    expect(rest).toEqual([]);
    expect(iso!.id).toBe(iso3dLayerId('layer1'));
    expect(iso!.kind).toBe('iso');
    expect(iso!.iso).toBe(1123.5);
    // Follows the 4D frame: this is the whole reason the volume layer owns the surface.
    expect(iso!.source).toEqual({ datasetId: 'ds1', volumeIndex: 2 });
    expect(iso!.color).toEqual(layer.iso3d!.color);
    expect(iso!.pickable).toBe(false);
  });

  it('follows the volume layer visibility and opacity', () => {
    const hidden: VolumeLayer = { ...layerOn(SCALAR), visible: false };
    expect(derivedIsoLayers(hidden, SCALAR)[0]!.visible).toBe(false);
    const faint: VolumeLayer = {
      ...layerOn(SCALAR),
      iso3d: { ...defaultIso3d(SCALAR), opacity: 0.35 },
    };
    // `iso3d.opacity` alone still makes a ghost shell under a solid slice…
    expect(derivedIsoLayers(faint, SCALAR)[0]!.opacity).toBeCloseTo(0.35);
    // …and the layer's own slider governs the surfaces too — a surface that ignored it read as a
    // bug (2026-08-30). The two multiply, so the default `iso3d.opacity` of 1 follows the slider.
    const dimmed: VolumeLayer = { ...faint, opacity: 0.5 };
    expect(derivedIsoLayers(dimmed, SCALAR)[0]!.opacity).toBeCloseTo(0.175);
    const sliderOnly: VolumeLayer = { ...layerOn(SCALAR), opacity: 0.5 };
    expect(derivedIsoLayers(sliderOnly, SCALAR)[0]!.opacity).toBeCloseTo(0.5);
  });
});

describe('derivedIsoLayers — a label volume', () => {
  it('is one ISOLATED surface per region, in the LUT colour, and never for background', () => {
    const layers = derivedIsoLayers(layerOn(LABELS), LABELS);
    expect(layers.map((l) => l.id)).toEqual([
      iso3dLayerId('layer1', 1),
      iso3dLayerId('layer1', 5),
      iso3dLayerId('layer1', 530),
    ]);
    // `source.label`, not a level: `value >= k - 0.5` is the union of every id at or above `k`, and
    // SimNIBS ids do not nest. This is what routes the build to §6.5.2's `marchingCubesLabel`.
    expect(layers.map((l) => l.source.label)).toEqual([1, 5, 530]);
    expect(layers.map((l) => l.iso)).toEqual([0.5, 0.5, 0.5]);
    expect(layers[1]!.color).toEqual(COLORS[5]);
    expect(layers[0]!.name).toBe('L1 · surface');
  });

  it('follows region visibility, and a selection narrows further', () => {
    const layer = layerOn(LABELS);
    const hidden: VolumeLayer = { ...layer, visibleLabels: Uint32Array.from([1, 530]) };
    expect(iso3dLabels(hidden, LABELS)).toEqual([1, 530]);
    const selected: VolumeLayer = { ...hidden, selectedLabels: [530] };
    expect(iso3dLabels(selected, LABELS)).toEqual([530]);
    // A cleared selection is "no narrowing", not "nothing" — emptying the 3D view on a stray click
    // in the region panel would be indistinguishable from the feature being broken.
    expect(iso3dLabels({ ...hidden, selectedLabels: [] }, LABELS)).toEqual([1, 530]);
  });

  it('follows the per-region opacity slider, on top of the layer opacity', () => {
    const layer: VolumeLayer = {
      ...layerOn(LABELS),
      visibleLabels: Uint32Array.from([1, 530]),
      labelOpacity: { 530: 0.4 },
    };
    const byId = new Map(
      derivedIsoLayers(layer, LABELS).map((l) => [l.source.label, l.opacity] as const)
    );
    expect(byId.get(1)).toBeCloseTo(1);
    expect(byId.get(530)).toBeCloseTo(0.4);
    const dimmed: VolumeLayer = { ...layer, opacity: 0.5 };
    expect(
      derivedIsoLayers(dimmed, LABELS).find((l) => l.source.label === 530)?.opacity
    ).toBeCloseTo(0.2);
  });

  it('follows a recolour, with the layer override beating the LUT', () => {
    const recoloured: VolumeLayer = {
      ...layerOn(LABELS),
      labelColors: { 5: [0.1, 0.2, 0.3, 1] },
    };
    expect(iso3dLabelColor(recoloured, LABELS.labelTable, 5)).toEqual([0.1, 0.2, 0.3, 1]);
    expect(iso3dLabelColor(recoloured, LABELS.labelTable, 1)).toEqual(COLORS[1]);
    const found = derivedIsoLayers(recoloured, LABELS).find((l) => l.source.label === 5);
    expect(found!.color).toEqual([0.1, 0.2, 0.3, 1]);
  });

  it('keeps a region surface id stable when its neighbours come and go', () => {
    // The engine reconciles runtimes by this id, so a stable id is what stops a region-panel click
    // from rebuilding marching cubes for every tissue that did not change.
    const all = derivedIsoLayers(layerOn(LABELS), LABELS);
    const fewer = derivedIsoLayers(
      { ...layerOn(LABELS), visibleLabels: Uint32Array.from([5]) },
      LABELS
    );
    expect(fewer.map((l) => l.id)).toEqual([all[1]!.id]);
  });
});
