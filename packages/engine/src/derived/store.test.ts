/**
 * The surface-contour request and its latest-wins key (2026-09-18) — the half of the scalar
 * outline that has an answer before a GL context exists.
 *
 * The store keeps one pending `contours` result per key and serves whatever landed under it. A
 * key that named only the dataset, the pane and the annotation would hand a layer that switched
 * fields the *previous* field's segments and values until the plane next moved — the same staleness
 * `annotation` was already keyed against. So the key must carry the scalar request too.
 */

import { describe, expect, it } from 'vitest';
import { surfaceContourKey, surfaceContourRequest, surfaceContourPlane } from './store';
import { defaultMeshLayer } from '../scene/defaults';
import type { MeshDataset, MeshLayer } from '../scene/types';

const STATS = { min: 0, max: 1 };

function surfaceDataset(): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds1',
    name: 'roi_overlay.msh',
    nTets: 0,
    nTris: 8,
    hasTris: true,
    tags: [{ id: 5003, color: [0.5, 0.5, 0.5, 1], kind: 'tri', count: 8 }],
    fields: [
      { name: 'signal_a', source: 'node', ncomp: 1, n: 8, partial: false, stats: STATS },
      { name: 'signal_b', source: 'node', ncomp: 1, n: 8, partial: false, stats: STATS },
      { name: 'per_tri', source: 'elm', ncomp: 1, n: 8, partial: false, stats: STATS },
    ],
    orient: { components: 1, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
  } as unknown as MeshDataset;
}

function fieldLayer(name: string, source: 'node' | 'elm' = 'node'): MeshLayer {
  return {
    ...defaultMeshLayer('layer1', surfaceDataset()),
    colorMode: 'field',
    field: { source, name, component: 'mag' },
  };
}

describe('surfaceContourRequest', () => {
  it('asks for nothing beyond the segments for a solid or tag-coloured surface', () => {
    const ds = surfaceDataset();
    const req = surfaceContourRequest(defaultMeshLayer('layer1', ds), ds);
    expect(req).toEqual({ field: undefined });
  });

  it('asks for `field` values when the layer colours by a node field', () => {
    const ds = surfaceDataset();
    const req = surfaceContourRequest(fieldLayer('signal_a'), ds);
    expect(req.annotation).toBeUndefined();
    expect(req.scalar).toEqual({ name: 'signal_a', component: 'mag' });
    expect(req.field).toBe(ds.fields[0]);
  });

  it('keeps the single-colour outline for an element field or an unknown field', () => {
    const ds = surfaceDataset();
    expect(surfaceContourRequest(fieldLayer('per_tri', 'elm'), ds).scalar).toBeUndefined();
    expect(surfaceContourRequest(fieldLayer('nope'), ds).scalar).toBeUndefined();
  });

  it('an annotation is categorical, never scalar', () => {
    const ds = surfaceDataset();
    const layer: MeshLayer = {
      ...fieldLayer('signal_a'),
      colorMode: 'label',
      label: { name: 'signal_b', table: { entries: [] }, mode: 'fill', outlineWidthPx: 1 },
    } as unknown as MeshLayer;
    const req = surfaceContourRequest(layer, ds);
    expect(req.annotation).toBe('signal_b');
    expect(req.scalar).toBeUndefined();
  });
});

describe('surfaceContourKey', () => {
  it('differs between two fields on the same dataset and pane', () => {
    const ds = surfaceDataset();
    const a = surfaceContourKey(
      'ds1',
      'axial',
      surfaceContourRequest(fieldLayer('signal_a'), ds),
      undefined
    );
    const b = surfaceContourKey(
      'ds1',
      'axial',
      surfaceContourRequest(fieldLayer('signal_b'), ds),
      undefined
    );
    expect(a).not.toBe(b);
  });

  it('differs between a solid and a scalar outline of the same surface', () => {
    const ds = surfaceDataset();
    const solid = surfaceContourKey(
      'ds1',
      'axial',
      surfaceContourRequest(defaultMeshLayer('l', ds), ds),
      undefined
    );
    const scalar = surfaceContourKey(
      'ds1',
      'axial',
      surfaceContourRequest(fieldLayer('signal_a'), ds),
      undefined
    );
    expect(solid).not.toBe(scalar);
  });

  it('differs by component, pane and mask, and is stable for the same request', () => {
    const ds = surfaceDataset();
    const base = fieldLayer('signal_a');
    const k = (layer: MeshLayer, view = 'axial', mask?: number): string =>
      surfaceContourKey('ds1', view, surfaceContourRequest(layer, ds), mask);
    expect(k(base)).toBe(k({ ...base }));
    expect(k(base)).not.toBe(k({ ...base, field: { ...base.field!, component: 0 } }));
    expect(k(base)).not.toBe(k(base, 'coronal'));
    expect(k(base)).not.toBe(k(base, 'axial', 3));
  });
});

it('pulls translated and nonuniformly scaled world planes into surface coordinates', () => {
  const model = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 10, 1]);
  expect(surfaceContourPlane({ normal: [0, 0, 1], offset: -10 }, model)).toEqual({
    normal: [0, 0, 1],
    offset: 0,
  });
  const plane = surfaceContourPlane({ normal: [1, 1, 0], offset: -11 }, model)!;
  // Model points x=3,y=-2 and x=-3,y=2 both map onto x_world+y_world=11.
  for (const [x, y] of [
    [3, -2],
    [-3, 2],
  ]) {
    expect(plane.normal[0] * x! + plane.normal[1] * y! + plane.offset).toBeCloseTo(0, 12);
  }
  expect(surfaceContourPlane({ normal: [0, 0, 1], offset: 0 }, new Float32Array(16))).toBeNull();
});
