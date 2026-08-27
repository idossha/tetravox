/**
 * The mesh colour bar's spec — §8's "one per visible scalar layer", produced but not drawn.
 *
 * The numbers below are `Thalamus_TI.msh`'s: one `$ElementData` field `TI_max`, min
 * 1.0863735014567724e-12, max 10.293712064403254 `[DATA]`. The bar has to describe *that* scale, not
 * the field's raw range, because what the user sees is the layer's `Scale`.
 */

import { describe, expect, it } from 'vitest';
import { meshColorbarSpec, tickPosition } from './mesh-colorbar';
import type { MeshDataset, MeshLayer, Stats } from '../scene/types';

const stats = (min: number, max: number): Stats => ({
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
});

function dataset(units?: string): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds1',
    name: 'Thalamus_TI.msh',
    transform: new Float32Array(16),
    appliedTransform: new Float32Array(16),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    nNodes: 847165,
    nTris: 1177213,
    nTets: 4722625,
    hasTris: true,
    fields: [
      {
        name: 'TI_max',
        source: 'elm',
        ncomp: 1,
        n: 5899838,
        partial: false,
        stats: stats(1.0863735014567724e-12, 10.293712064403254),
        ...(units !== undefined ? { units } : {}),
      },
    ],
    tags: [],
    skipped: [],
    orient: { components: 1, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
    topologyBuilt: false,
    worker: { id: 1 },
    handle: 1,
  };
}

function layer(over: Partial<MeshLayer> = {}): MeshLayer {
  return {
    id: 'l1',
    datasetId: 'ds1',
    name: 'Thalamus_TI',
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: true,
    kind: 'mesh',
    colorMode: 'field',
    field: { source: 'elm', name: 'TI_max', component: 'mag' },
    solidColor: [0, 0, 0, 1],
    colormap: 'viridis',
    scale: { kind: 'linear', lo: 0, hi: 0.5 },
    threshold: { lo: -Infinity, hi: Infinity, symmetric: false, mode: 'clamp', softEdge: 0 },
    tagStyle: {},
    edges: { surface: false, caps: false },
    edgeColor: [0, 0, 0, 1],
    edgeWidthPx: 1,
    flatShading: false,
    faceMode: 'both',
    clip: { planes: [], caps: true, capColorMode: 'inherit' },
    contoursIn2D: true,
    contourWidthPx: 1,
    fillIn2D: true,
    ...over,
  };
}

describe('meshColorbarSpec', () => {
  it('describes the layer’s scale, with the ramp the shader itself samples', () => {
    const spec = meshColorbarSpec(layer(), dataset('V/m'));
    expect(spec).not.toBeNull();
    expect(spec?.layerId).toBe('l1');
    expect(spec?.title).toBe('TI_max');
    expect(spec?.units).toBe('V/m');
    expect(spec?.position).toBe('right');
    // 256x1 RGBA8 for a linear scale (§7.6).
    expect(spec?.ramp.length).toBe(256 * 4);
    expect(spec?.ticks.map((t) => t.t)).toEqual([0, 1]);
    expect(spec?.ticks.map((t) => t.label)).toEqual(['0', '0.5']);
  });

  it('adds the `mid` tick for a heat scale, and 512 texels for the separate negative branch', () => {
    const spec = meshColorbarSpec(
      layer({
        scale: {
          kind: 'heat',
          min: 0.1,
          mid: 0.3,
          max: 0.6,
          truncate: false,
          inverse: false,
          negative: 'separate',
        },
      }),
      dataset()
    );
    expect(spec?.ramp.length).toBe(512 * 4);
    // Endpoints are ±max for a heat scale, so `mid` at 0.3 sits at (0.3 + 0.6) / 1.2 = 0.75.
    expect(spec?.ticks.map((t) => t.t)).toEqual([0, 0.75, 1]);
  });

  it('draws a notch only for a finite threshold bound — an infinite one has no position', () => {
    expect(meshColorbarSpec(layer(), dataset())?.notches).toEqual([]);
    const spec = meshColorbarSpec(
      layer({
        threshold: { lo: 0.1, hi: 0.4, symmetric: false, mode: 'hide', softEdge: 0 },
      }),
      dataset()
    );
    expect(spec?.notches).toEqual([0.2, 0.8]);
  });

  it('is null for a layer with no continuous scale to describe, or with the bar switched off', () => {
    expect(meshColorbarSpec(layer({ colorMode: 'tag' }), dataset())).toBeNull();
    expect(meshColorbarSpec(layer({ colorMode: 'label' }), dataset())).toBeNull();
    expect(meshColorbarSpec(layer({ showColorbar: false }), dataset())).toBeNull();
    expect(meshColorbarSpec(layer({ visible: false }), dataset())).toBeNull();
  });
});

describe('tickPosition', () => {
  it('places a value on a linear bar', () => {
    expect(tickPosition({ kind: 'linear', lo: 0, hi: 10 }, 2.5)).toBeCloseTo(0.25, 12);
  });
  it('clamps outside the scale rather than running off the bar', () => {
    expect(tickPosition({ kind: 'linear', lo: 0, hi: 10 }, -5)).toBe(0);
    expect(tickPosition({ kind: 'linear', lo: 0, hi: 10 }, 50)).toBe(1);
  });
  it('a degenerate scale has no positions rather than a division by zero', () => {
    expect(tickPosition({ kind: 'linear', lo: 3, hi: 3 }, 3)).toBe(0);
  });
});
