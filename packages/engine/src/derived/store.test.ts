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
import { surfaceContourKey, surfaceContourRequest } from './store';
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
      { name: 'TI_max_ROI', source: 'node', ncomp: 1, n: 8, partial: false, stats: STATS },
      { name: 'TI_normal_ROI', source: 'node', ncomp: 1, n: 8, partial: false, stats: STATS },
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
    const req = surfaceContourRequest(fieldLayer('TI_max_ROI'), ds);
    expect(req.annotation).toBeUndefined();
    expect(req.scalar).toEqual({ name: 'TI_max_ROI', component: 'mag' });
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
      ...fieldLayer('TI_max_ROI'),
      colorMode: 'label',
      label: { name: 'TI_normal_ROI', table: { entries: [] }, mode: 'fill', outlineWidthPx: 1 },
    } as unknown as MeshLayer;
    const req = surfaceContourRequest(layer, ds);
    expect(req.annotation).toBe('TI_normal_ROI');
    expect(req.scalar).toBeUndefined();
  });
});

describe('surfaceContourKey', () => {
  it('differs between two fields on the same dataset and pane', () => {
    const ds = surfaceDataset();
    const a = surfaceContourKey(
      'ds1',
      'axial',
      surfaceContourRequest(fieldLayer('TI_max_ROI'), ds),
      undefined
    );
    const b = surfaceContourKey(
      'ds1',
      'axial',
      surfaceContourRequest(fieldLayer('TI_normal_ROI'), ds),
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
      surfaceContourRequest(fieldLayer('TI_max_ROI'), ds),
      undefined
    );
    expect(solid).not.toBe(scalar);
  });

  it('differs by component, pane and mask, and is stable for the same request', () => {
    const ds = surfaceDataset();
    const base = fieldLayer('TI_max_ROI');
    const k = (layer: MeshLayer, view = 'axial', mask?: number): string =>
      surfaceContourKey('ds1', view, surfaceContourRequest(layer, ds), mask);
    expect(k(base)).toBe(k({ ...base }));
    expect(k(base)).not.toBe(k({ ...base, field: { ...base.field!, component: 0 } }));
    expect(k(base)).not.toBe(k(base, 'coronal'));
    expect(k(base)).not.toBe(k(base, 'axial', 3));
  });
});
