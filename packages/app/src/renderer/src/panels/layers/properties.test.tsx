/**
 * The per-kind property registry (§8's "per-kind property editor").
 *
 * Two things worth pinning before four editors are written into it: the registry is **exhaustive**
 * over §4.4's four layer kinds, and the summary line each kind produces is the one Phase 1 shipped —
 * the split moved that text, and a silent change to it is the kind of thing no golden would catch,
 * because the layer panel is DOM, not pixels.
 */

import { describe, expect, it } from 'vitest';
import type { Dataset, Layer, MeshDataset, VolumeDataset } from '@tetravox/engine';
import { LayerProperties, layerSummary } from './properties';
import { IsoProperties } from './iso/IsoProperties';
import { MeshProperties } from './mesh/MeshProperties';
import { PointsProperties } from './points/PointsProperties';
import { VolumeProperties } from './volume/VolumeProperties';

const KINDS = ['volume', 'mesh', 'iso', 'points'] as const;

function volume(over: Partial<VolumeDataset> = {}): Dataset {
  return {
    id: 'ds1',
    kind: 'volume',
    name: 'T1.nii.gz',
    dims: [4, 5, 6],
    nvols: 1,
    dtype: 'f32',
    isLabel: false,
    ...over,
  } as unknown as Dataset;
}

function mesh(over: Partial<MeshDataset> = {}): Dataset {
  return {
    id: 'ds2',
    kind: 'mesh',
    name: 'ernie.msh',
    nNodes: 12,
    nTris: 20,
    nTets: 48,
    hasTris: true,
    ...over,
  } as unknown as Dataset;
}

function layer(kind: Layer['kind'], over: Record<string, unknown> = {}): Layer {
  return { id: 'l1', datasetId: 'ds1', name: 'n', kind, ...over } as unknown as Layer;
}

describe('layerSummary', () => {
  it('describes a volume by dims and dtype', () => {
    expect(layerSummary(volume(), layer('volume'))).toBe('4×5×6 f32');
  });

  it('marks a label volume, because it takes §7.3’s palette branch and not the colormap one', () => {
    expect(layerSummary(volume({ isLabel: true }), layer('volume'))).toBe('4×5×6 f32 · labels');
  });

  it('shows the 4D index only when there is more than one frame (§7.5’s `,` / `.`)', () => {
    expect(layerSummary(volume({ nvols: 1 }), layer('volume', { volumeIndex: 0 }))).toBe(
      '4×5×6 f32'
    );
    expect(layerSummary(volume({ nvols: 8 }), layer('volume', { volumeIndex: 3 }))).toBe(
      '4×5×6 f32 · vol 3/7'
    );
  });

  it('describes a mesh by its counts, and says when it brought no triangles', () => {
    expect(layerSummary(mesh(), layer('mesh'))).toBe('12 nodes · 20 tris · 48 tets');
    // `grey_Thalamus_TI.msh` is the real case: 0 tris, so the 3D view comes from `extract_boundary`.
    expect(layerSummary(mesh({ hasTris: false, nTris: 0 }), layer('mesh'))).toBe(
      '12 nodes · no tris · 48 tets'
    );
  });

  it('falls back to the kind while the dataset has not landed, and for the Phase-2 kinds', () => {
    expect(layerSummary(undefined, layer('volume'))).toBe('volume');
    expect(layerSummary(volume(), layer('iso'))).toBe('iso');
    expect(layerSummary(mesh(), layer('points'))).toBe('points');
  });
});

describe('the editor registry', () => {
  it('has an entry for every §4.4 kind', () => {
    for (const kind of KINDS) {
      const element = LayerProperties({ layer: layer(kind), dataset: volume() });
      expect(element, kind).not.toBeUndefined();
    }
  });

  it('routes a volume layer to A-PROPS’ editor', () => {
    // `LayerProperties` returns `<Editor …/>`; creating the element does not call the component, so
    // this asserts the registration without needing a renderer for an editor that reads context.
    const element = LayerProperties({ layer: layer('volume'), dataset: volume() });
    expect(element?.type).toBe(VolumeProperties);
  });

  it('draws nothing for the kinds whose editors are still Phase 2’s', () => {
    for (const Editor of [MeshProperties, IsoProperties, PointsProperties]) {
      expect(Editor({ layer: layer('volume'), dataset: volume() })).toBeNull();
    }
  });

  it('renders nothing at all while the dataset is missing', () => {
    expect(LayerProperties({ layer: layer('volume'), dataset: undefined })).toBeNull();
  });
});
