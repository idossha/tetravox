/**
 * A parsed Gmsh view (`.geo` / `.pos`) becoming a scene: `GeoPayloadT` → `GeoData` → a points
 * layer (directed task 6).
 *
 * This is the seam the whole feature hangs on and none of it is a pixel, so it is asserted here
 * rather than in a screenshot: the wire arrays are flat and de-indexed, and an off-by-one in the
 * stride puts every electrode at its neighbour's coordinates — which renders as a plausible,
 * wrong net.
 */

import { describe, expect, it } from 'vitest';
import { geoFromWire, meshDatasetFromMeta } from './fromMeta';
import { defaultLayerFor, defaultPointsLayer } from './defaults';
import { looksLikeGeoView, meshFormatFor } from '../datasets/source';
import type { GeoPayloadT, MeshMeta } from '@tetravox/protocol';
import type { MeshDataset, PointsLayer } from './types';

function wire(over: Partial<GeoPayloadT> = {}): GeoPayloadT {
  return {
    points: new Float32Array([1, 2, 3, 4, 5, 6]),
    pointValues: new Float32Array([10, 20]),
    pointView: new Uint32Array([0, 0]),
    labelPositions: new Float32Array([1, 2, 8, 4, 5, 11]),
    labelTexts: ['E001', 'E002'],
    lineSegments: new Float32Array([0, 0, 0, 1, 0, 0]),
    lineValues: new Float32Array([0, 1]),
    viewNames: ['view 1'],
    views: [{ name: 'view 1', points: 2, labels: 2, lines: 1, tris: 0, timeSteps: 1, skipped: [] }],
    bounds: { min: [0, 0, 0], max: [4, 5, 11] },
    ...over,
  };
}

function meshMeta(over: Partial<MeshMeta> = {}): MeshMeta {
  return {
    handle: 1,
    name: 'GSN-HydroCel-185.geo',
    fingerprint: 'tvxfp1-0-0',
    nNodes: 0,
    nTris: 0,
    nTets: 0,
    hasTris: false,
    appliedTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    bounds: { min: [0, 0, 0], max: [4, 5, 11] },
    tags: [],
    fields: [],
    skipped: [],
    orient: { components: 0, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
    ...over,
  } as MeshMeta;
}

function dataset(geo?: GeoPayloadT, meta: Partial<MeshMeta> = {}): MeshDataset {
  return meshDatasetFromMeta('ds1', meshMeta(meta), { id: 1 }, undefined, geo);
}

describe('a parsed view on the wire', () => {
  it('de-interleaves points, values and label anchors', () => {
    const geo = geoFromWire(wire());
    expect(geo.points).toEqual([
      { position: [1, 2, 3], value: 10, view: 0 },
      { position: [4, 5, 6], value: 20, view: 0 },
    ]);
    expect(geo.labels).toEqual([
      { position: [1, 2, 8], text: 'E001' },
      { position: [4, 5, 11], text: 'E002' },
    ]);
    // Line segments stay a typed array: they feed a vertex buffer verbatim (§7.0.6).
    expect(geo.lineSegments).toBeInstanceOf(Float32Array);
    expect(geo.lineSegments.length).toBe(6);
  });

  it('rides onto the mesh dataset, and is absent for every other format', () => {
    expect(dataset(wire()).geo?.points).toHaveLength(2);
    expect(dataset(undefined).geo).toBeUndefined();
  });
});

describe('a parsed view becoming a points layer', () => {
  it('seeds positions, values and — because the counts match — names', () => {
    const layer = defaultPointsLayer('l1', dataset(wire()));
    expect(layer.points).toEqual([
      { position: [1, 2, 3], value: 10, name: 'E001' },
      { position: [4, 5, 6], value: 20, name: 'E002' },
    ]);
    expect(layer.name).toBe('view 1');
    expect(layer.labels).toHaveLength(2);
    expect(layer.lineSegments).toBeInstanceOf(Float32Array);
    expect(layer.valueRange).toEqual({ lo: 10, hi: 20 });
  });

  /**
   * SimNIBS writes one `T3` per `SP`, so a net pairs by index — but a file that does not is legal,
   * and the labels must still draw from their own anchors. Only the probe row goes unnamed.
   */
  it('still draws the labels when the counts do not match, without guessing at a pairing', () => {
    const layer = defaultPointsLayer(
      'l1',
      dataset(wire({ labelTexts: ['only'], labelPositions: new Float32Array([1, 2, 8]) }))
    );
    expect(layer.points.every((p) => p.name === undefined)).toBe(true);
    expect(layer.labels).toEqual([{ position: [1, 2, 8], text: 'only' }]);
  });

  /** Labels default on when the file brought text, and off when it did not. */
  it('turns labels on exactly when the view has any', () => {
    expect(defaultPointsLayer('l', dataset(wire())).showLabels).toBe(true);
    expect(
      defaultPointsLayer(
        'l',
        dataset(wire({ labelTexts: [], labelPositions: new Float32Array(0) }))
      ).showLabels
    ).toBe(false);
  });

  /** A net has no triangles, so its default layer must be points and not an empty surface. */
  it('is the default layer kind for a triangle-less parsed view', () => {
    expect(defaultLayerFor('l1', dataset(wire())).kind).toBe('points');
    // A view that does carry `ST` triangles is a surface, like any other mesh.
    expect(
      defaultLayerFor('l1', dataset(wire(), { hasTris: true, nTris: 4, nNodes: 12 })).kind
    ).toBe('mesh');
    // And nothing about a plain mesh changed.
    expect(defaultLayerFor('l1', dataset(undefined, { hasTris: true })).kind).toBe('mesh');
  });

  it('leaves a points layer with no parsed view exactly as it was', () => {
    const layer: PointsLayer = defaultPointsLayer('l1', dataset(undefined));
    expect(layer.points).toEqual([]);
    expect(layer.showLabels).toBe(false);
    expect(layer.labels).toBeUndefined();
    expect(layer.lineSegments).toBeUndefined();
    expect(layer.name).toBe('Points');
  });
});

describe('picking the loader', () => {
  it('routes .geo and .pos to the parsed-view reader and nothing else', () => {
    for (const n of ['GSN-HydroCel-185.geo', 'field.pos', 'A.GEO', 'x.Pos']) {
      expect(looksLikeGeoView(n), n).toBe(true);
      expect(meshFormatFor(n), n).toBe('geo');
    }
    for (const n of ['ernie.msh', 'lh.central.gii', 'patch.ply', 'T1.nii.gz', 'geometry']) {
      expect(looksLikeGeoView(n), n).toBe(false);
      expect(meshFormatFor(n), n).toBe('auto');
    }
  });
});
