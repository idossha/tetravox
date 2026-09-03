/**
 * The two gaps `normalize.ts` closes: URL resolution, and the nine view fields a host cannot know.
 *
 * The URL half is the one that bites in production. A host serving data from its own API sends
 * root-relative paths (`/api/files/raw/…`), and those are **not** one of the two shapes
 * `datasets/source.ts`'s `fileUrl` passes through — unresolved they become a `tetravox://file/`
 * request no browser outside Electron can serve. Both spellings are asserted here.
 */

import { describe, expect, it } from 'vitest';
import type { ViewSpec } from '@tetravox/engine';
import { normalizeScene, resolveUrl } from './normalize';

/** A stand-in for `Engine.serialize()` on the empty scene, with the nine fields that matter. */
const TEMPLATE = {
  version: 2,
  datasets: [],
  layers: [],
  activeLayerId: null,
  slices: [{ id: 'axial' }],
  view3d: { id: 'view3d', camera: { distance: 300 } },
  layout: { kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] },
  cursor: [0, 0, 0],
  radiological: false,
  background: [0, 0, 0, 1],
  lighting: { ambient: 0.25, headlight: true },
  annotations: { crosshair: true },
  transparency: { mode: 'twoPhase' },
} as unknown as ViewSpec;

const BASE = 'http://viewer.example/tetravox/index.html';

const scene = (path: string, extra: Record<string, unknown> = {}) => ({
  datasets: [{ id: 'd1', kind: 'volume' as const, name: 'T1.nii.gz', path, ...extra }],
  layers: [{ id: 'l1', datasetId: 'd1', kind: 'volume' }],
});

describe('dataset URL resolution', () => {
  it('passes an absolute http(s) URL through unchanged', () => {
    const { spec, resolved } = normalizeScene(
      scene('https://data.example/sub-01/T1.nii.gz'),
      TEMPLATE,
      BASE
    );
    expect(resolved['d1']).toBe('https://data.example/sub-01/T1.nii.gz');
    expect(spec.datasets[0]?.path).toBe('https://data.example/sub-01/T1.nii.gz');
  });

  it('resolves a ROOT-relative path against the base origin', () => {
    // The shape a host with its own file API sends. `/api/...` is neither `scheme://` nor `/@fs/`,
    // so leaving it for `fileUrl` would produce `tetravox://file/%2Fapi%2F...`.
    const { resolved } = normalizeScene(scene('/api/files/raw/mnt/000/T1.nii.gz'), TEMPLATE, BASE);
    expect(resolved['d1']).toBe('http://viewer.example/api/files/raw/mnt/000/T1.nii.gz');
  });

  it('resolves a document-relative path against the embed page, not the origin root', () => {
    const { resolved } = normalizeScene(scene('data/T1.nii.gz'), TEMPLATE, BASE);
    expect(resolved['d1']).toBe('http://viewer.example/tetravox/data/T1.nii.gz');
  });

  it('honours an explicit baseUrl over the default', () => {
    const { resolved } = normalizeScene(
      scene('T1.nii.gz'),
      TEMPLATE,
      'https://cdn.example/subj/9/'
    );
    expect(resolved['d1']).toBe('https://cdn.example/subj/9/T1.nii.gz');
  });

  it('resolves a sidecar against the DATASET, never against the page', () => {
    // ARCHITECTURE.md 4.6: a sidecar travels with the file it describes.
    const { spec } = normalizeScene(
      scene('/api/files/raw/m2m_ernie/final_tissues.nii.gz', {
        sidecars: { lut: { path: 'final_tissues_LUT.txt' } },
      }),
      TEMPLATE,
      BASE
    );
    expect(spec.datasets[0]?.sidecars?.lut).toEqual({
      path: '',
      absPath: 'http://viewer.example/api/files/raw/m2m_ernie/final_tissues_LUT.txt',
    });
  });

  it('defaults an absent fingerprint to the empty string', () => {
    const { spec } = normalizeScene(scene('/T1.nii.gz'), TEMPLATE, BASE);
    expect(spec.datasets[0]?.fingerprint).toBe('');
  });

  it('keeps a fingerprint the host did send', () => {
    const { spec } = normalizeScene(
      scene('/T1.nii.gz', { fingerprint: 'tvxfp1-0000000003400160-8192ec923b9c8951' }),
      TEMPLATE,
      BASE
    );
    expect(spec.datasets[0]?.fingerprint).toBe('tvxfp1-0000000003400160-8192ec923b9c8951');
  });

  it('throws on a path no base can make sense of', () => {
    expect(() => normalizeScene(scene('T1.nii.gz'), TEMPLATE, 'not-a-url')).toThrow();
  });
});

describe('view fields', () => {
  it('fills every field the host omitted from the template', () => {
    const { spec } = normalizeScene(scene('/T1.nii.gz'), TEMPLATE, BASE);
    for (const key of [
      'slices',
      'view3d',
      'layout',
      'cursor',
      'radiological',
      'background',
      'lighting',
      'annotations',
      'transparency',
    ] as const) {
      expect(spec[key]).toEqual(TEMPLATE[key]);
    }
    expect(spec.version).toBe(2);
    expect(spec.activeLayerId).toBeNull();
  });

  it('never overrides a field the host did send', () => {
    const { spec } = normalizeScene(
      { ...scene('/T1.nii.gz'), cursor: [10, 20, 30], radiological: true, activeLayerId: 'l1' },
      TEMPLATE,
      BASE
    );
    expect(spec.cursor).toEqual([10, 20, 30]);
    expect(spec.radiological).toBe(true);
    expect(spec.activeLayerId).toBe('l1');
  });

  it('carries through a field this build has never heard of', () => {
    // ARCHITECTURE.md 4.6 makes the same promise for per-layer fields, and for the same reason: a
    // host written against a later build must not have its scene silently trimmed on the way in.
    const { spec } = normalizeScene(
      { ...scene('/T1.nii.gz'), somethingNewer: { a: 1 } },
      TEMPLATE,
      BASE
    );
    expect((spec as unknown as Record<string, unknown>)['somethingNewer']).toEqual({ a: 1 });
  });

  it('passes layers through verbatim', () => {
    const layers = [{ id: 'l1', datasetId: 'd1', kind: 'volume', colormap: 'hot', opacity: 0.5 }];
    const { spec } = normalizeScene({ ...scene('/T1.nii.gz'), layers }, TEMPLATE, BASE);
    expect(spec.layers).toEqual(layers);
  });
});

describe('resolveUrl', () => {
  it('is exactly the URL constructor rule', () => {
    expect(resolveUrl('https://a.example/x', 'http://b.example/y/')).toBe('https://a.example/x');
    expect(resolveUrl('//a.example/x', 'https://b.example/y/')).toBe('https://a.example/x');
    expect(resolveUrl('../up.nii', 'http://b.example/y/z/')).toBe('http://b.example/y/up.nii');
  });
});
