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
import type { LayerPropertiesProps } from './properties';
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

  it('falls back to the kind while the dataset has not landed', () => {
    expect(layerSummary(undefined, layer('volume'))).toBe('volume');
  });

  // A-PROPS (half 2), Phase 2: the `iso` and `points` editors have landed, so their summaries are
  // no longer the bare kind. properties.test.tsx stays exhaustive over
  // §4.4's four kinds as each editor lands."
  it('describes an isosurface by its level and its source', () => {
    expect(layerSummary(volume(), layer('iso', { iso: 0.5 }))).toBe('iso 0.5000 · T1.nii.gz');
    expect(
      layerSummary(
        mesh(),
        layer('iso', {
          iso: 1.25,
          source: { datasetId: 'ds2', field: { source: 'elm', name: 'TI_max', component: 'mag' } },
        })
      )
    ).toBe('iso 1.250 · TI_max');
  });

  it('describes a points layer by its count and shape', () => {
    expect(layerSummary(mesh(), layer('points', { points: [], shape: 'sphere' }))).toBe(
      '0 points · sphere'
    );
    expect(
      layerSummary(
        mesh(),
        layer('points', { points: [{ name: 'Fp1', position: [1, 2, 3] }], shape: 'dot' })
      )
    ).toBe('1 point · dot');
  });
});

describe('the editor registry', () => {
  const EDITORS: Record<(typeof KINDS)[number], (p: LayerPropertiesProps) => unknown> = {
    volume: VolumeProperties,
    mesh: MeshProperties,
    iso: IsoProperties,
    points: PointsProperties,
  };

  it('routes every §4.4 kind to its own editor', () => {
    // `LayerProperties` returns `<Editor …/>`; creating the element does not *call* the component,
    // so this asserts the whole registration without a renderer — which matters for an editor that
    // reads context (see the next test).
    for (const kind of KINDS) {
      const element = LayerProperties({ layer: layer(kind), dataset: volume() });
      expect(element, kind).not.toBeUndefined();
      expect(element?.type, kind).toBe(EDITORS[kind]);
    }
  });

  /**
   * The three editors whose `layer.kind` guard is in **front of** every hook can be called directly:
   * the app's vitest project runs under `node` with no DOM (see `vitest.config.ts`), so a mounted
   * editor belongs in the Playwright-Electron E2E and a mismatched kind is the one call that is
   * meaningful here.
   *
   * `VolumeProperties` is deliberately **not** in this list and is not a gap. It reads
   * `useController()` / `useUi()` at the top, which is the correct order — the Rules of Hooks forbid
   * an early return *before* a hook, not after one — and the cost is that it cannot be invoked
   * outside a renderer at all, for any layer kind. Its own guard is covered where it can be: in
   * `packages/app/e2e/props-volume.spec.ts`, mounted.
   */
  it('the hook-free editors decline a layer of another kind', () => {
    for (const kind of ['mesh', 'iso', 'points'] as const) {
      expect(EDITORS[kind]({ layer: layer('volume'), dataset: volume() }), kind).toBeNull();
    }
    expect(EDITORS.mesh({ layer: layer('mesh'), dataset: volume() })).toBeNull();
  });

  it('renders nothing at all while the dataset is missing', () => {
    expect(LayerProperties({ layer: layer('volume'), dataset: undefined })).toBeNull();
  });
});
