/**
 * §7.4's cap palette and §4.4's `IsolateSpec` → §6.5.1's `IsolateCriteriaT`.
 *
 * The two conversions in `layers/mesh.ts` that have to be exactly right before a pixel exists: the
 * `N x 2 RGBA8` tag palette a cap reads (whose bytes §4.1 requires to round-trip the LUT exactly),
 * and the criteria object that is `JSON.stringify`d into `mesh_isolate` — where a typed array would
 * silently become `{"0":…}` and a wrong `worldToVoxel` would isolate the wrong tets with no error.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCapPalette,
  capColorSourceOf,
  capPaletteKey,
  tetTagIndex,
  toIsolateCriteria,
} from './mesh';
import { MESH_COLOR_SOURCE } from '../shaders';
import { defaultLayerFor } from '../scene/defaults';
import type { IsolateSpec, MeshDataset, MeshLayer, VolumeDataset } from '../scene/types';

/** The fixture LUT's exact 0..255 wire values, as §4.1 stores them: 0..1 floats of `k / 255`. */
const TAG1 = [230, 230, 210] as const;
const TAG2 = [129, 129, 129] as const;
const wire = (c: readonly number[]): [number, number, number, number] => [
  c[0]! / 255,
  c[1]! / 255,
  c[2]! / 255,
  1,
];

function meshDataset(): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds1',
    name: 'lattice',
    transform: new Float32Array(16),
    appliedTransform: new Float32Array(16),
    bounds: { min: [-10, -10, -10], max: [10, 10, 10] },
    nNodes: 27,
    nTris: 56,
    nTets: 48,
    hasTris: true,
    fields: [],
    tags: [
      // Deliberately interleaved: a cap palette must index **tet** tags only, and ernie's tri tags
      // (1001–1099) and tet tags (1–10) are different numbers for the same tissue.
      { id: 1001, kind: 'tri', name: 'A_surface', color: wire([104, 163, 255]), count: 24 },
      { id: 1, kind: 'tet', name: 'Tissue_A', color: wire(TAG1), count: 24 },
      { id: 1002, kind: 'tri', name: 'B_surface', color: wire([255, 239, 179]), count: 32 },
      { id: 2, kind: 'tet', name: 'Tissue_B', color: wire(TAG2), count: 24 },
    ],
    skipped: [],
    orient: { openComponents: 0, flippedTags: [], signedVolumes: [] },
    topologyBuilt: false,
    worker: { id: 'w1' },
    handle: 1,
  } as unknown as MeshDataset;
}

function meshLayer(patch: Partial<MeshLayer> = {}): MeshLayer {
  return { ...(defaultLayerFor('l1', meshDataset()) as MeshLayer), ...patch };
}

describe('tetTagIndex', () => {
  it('indexes tet tags only, in dataset order', () => {
    // A cut is a slab through the *volume* elements, so `CutSnapshot.tag` is always a tet tag.
    // Including 1001 here would paint a cap with a surface tag's colour wherever the numbering
    // happened to collide.
    expect([...tetTagIndex(meshDataset())]).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });
});

describe('buildCapPalette', () => {
  const ds = meshDataset();
  const index = tetTagIndex(ds);

  it('row 0 is the dataset’s 0..255 wire colour, byte for byte (§4.1)', () => {
    const p = buildCapPalette(meshLayer(), ds, index, new Set());
    expect([...p.slice(0, 4)]).toEqual([...TAG1, 255]);
    expect([...p.slice(4, 8)]).toEqual([...TAG2, 255]);
  });

  it('folds visibility into alpha, so hiding a tissue is an 8N-byte upload and no re-cut (R5)', () => {
    const layer = meshLayer({
      tagStyle: { 1: { visible: false, opacity: 1 }, 2: { visible: true, opacity: 1 } },
    });
    const p = buildCapPalette(layer, ds, index, new Set());
    expect(p[3]).toBe(0);
    expect(p[7]).toBe(255);
    // …and the hidden tag's *colour* is untouched, so unhiding needs no other state.
    expect([...p.slice(0, 3)]).toEqual([...TAG1]);
  });

  it('a tagStyle colour overrides the LUT exactly, and row 1 carries the selection', () => {
    const layer = meshLayer({
      tagStyle: {
        1: { visible: true, opacity: 1, color: wire([68, 136, 204]) },
        2: { visible: true, opacity: 1 },
      },
    });
    const p = buildCapPalette(layer, ds, index, new Set([2]));
    expect([...p.slice(0, 4)]).toEqual([68, 136, 204, 255]);
    // Row 1 starts at N * 4 = 8 bytes in; tag 2 is index 1, so its selection byte is at 8 + 4.
    expect(p[8]).toBe(0);
    expect(p[12]).toBe(255);
  });
});

describe('capPaletteKey', () => {
  const ds = meshDataset();
  const index = tetTagIndex(ds);

  it('changes with every byte the palette would contain, and with nothing else', () => {
    const base = capPaletteKey('l1', meshLayer(), ds, index, new Set());
    expect(capPaletteKey('l1', meshLayer(), ds, index, new Set())).toBe(base);
    // A recolour, a hide and a selection each mint a new texture; an unrelated patch does not.
    const recoloured = meshLayer({
      tagStyle: { 1: { visible: true, opacity: 1, color: wire([1, 2, 3]) } },
    });
    expect(capPaletteKey('l1', recoloured, ds, index, new Set())).not.toBe(base);
    const hidden = meshLayer({ tagStyle: { 1: { visible: false, opacity: 1 } } });
    expect(capPaletteKey('l1', hidden, ds, index, new Set())).not.toBe(base);
    expect(capPaletteKey('l1', meshLayer(), ds, index, new Set([1]))).not.toBe(base);
    expect(capPaletteKey('l1', meshLayer({ opacity: 0.5 }), ds, index, new Set())).toBe(base);
    // Two layers over one mesh keep two textures: the key is per layer.
    expect(capPaletteKey('l2', meshLayer(), ds, index, new Set())).not.toBe(base);
  });
});

describe('capColorSourceOf', () => {
  it('`tag` pins the tet tag; `inherit` follows the layer as far as a cut vertex can', () => {
    const pin = (m: 'tag' | 'inherit', l: Partial<MeshLayer>): number =>
      capColorSourceOf(meshLayer({ ...l, clip: { planes: [], caps: true, capColorMode: m } }));
    expect(
      pin('tag', { colorMode: 'field', field: { source: 'elm', name: 'e', component: 'mag' } })
    ).toBe(MESH_COLOR_SOURCE.capTag);
    expect(pin('inherit', { colorMode: 'solid' })).toBe(MESH_COLOR_SOURCE.uniform);
    expect(pin('inherit', { colorMode: 'tag' })).toBe(MESH_COLOR_SOURCE.capTag);
    expect(
      pin('inherit', { colorMode: 'field', field: { source: 'elm', name: 'e', component: 'mag' } })
    ).toBe(MESH_COLOR_SOURCE.elmField);
    expect(
      pin('inherit', { colorMode: 'field', field: { source: 'node', name: 'n', component: 'mag' } })
    ).toBe(MESH_COLOR_SOURCE.nodeField);
    // A `.annot` id is a NODE quantity and a cut vertex lies between two nodes, where no id is
    // defined. There is no honest interpolation of a categorical value, so the cross-section of a
    // labelled surface is drawn by tissue — which is what it is.
    expect(pin('inherit', { colorMode: 'label' })).toBe(MESH_COLOR_SOURCE.capTag);
  });
});

describe('toIsolateCriteria', () => {
  const volume = {
    kind: 'volume',
    id: 'ds2',
    dims: [4, 5, 6],
    dtype: 'u16',
    // §6.3: "FLAT, length 16, column-major — deliberately NOT [[f64;4];4]".
    inverseAffine: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, -3, -4, 1]),
  } as unknown as VolumeDataset;

  it('carries only the branches the spec set, and every array as plain JSON', () => {
    const spec: IsolateSpec = {
      tags: [1, 2],
      sphere: { center: [1, 2, 3], radius: 4 },
      combine: 'any',
    };
    const c = toIsolateCriteria(spec, undefined);
    expect(c).toEqual({ combine: 'any', tags: [1, 2], sphere: { center: [1, 2, 3], radius: 4 } });
    // §6.5.1: the object is `JSON.stringify`d into `mesh_isolate`, so a typed array anywhere in it
    // would arrive as `{"0":…}` and match no tet at all.
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(Array.isArray(c.tags)).toBe(true);
    expect(Array.isArray(c.sphere?.center)).toBe(true);
  });

  it('reads a label volume’s dims / worldToVoxel / dtype off the volume the criterion names', () => {
    const spec: IsolateSpec = {
      labelVolume: { datasetId: 'ds2', volumeIndex: 0, labels: [10, 11] },
      combine: 'all',
    };
    const c = toIsolateCriteria(spec, volume);
    // §6.3 rejects a mismatch as `Error::Parse`, and the only way to be right is to read them from
    // the volume rather than to carry a copy in the scene.
    expect(c.labelVolume?.dims).toEqual([4, 5, 6]);
    expect(c.labelVolume?.dtype).toBe('u16');
    expect(c.labelVolume?.worldToVoxel.length).toBe(16);
    expect([...c.labelVolume!.worldToVoxel]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, -3, -4, 1,
    ]);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it('drops the labelVolume branch when the named dataset is gone', () => {
    const spec: IsolateSpec = {
      tags: [3],
      labelVolume: { datasetId: 'gone', volumeIndex: 0, labels: [1] },
      combine: 'all',
    };
    // The caller refuses to issue this case at all; the conversion still must not emit a half-built
    // criterion whose `dims` would come from nowhere.
    expect(toIsolateCriteria(spec, undefined).labelVolume).toBeUndefined();
  });
});
