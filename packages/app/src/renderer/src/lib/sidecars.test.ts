import { describe, expect, it } from 'vitest';
import { hemisphereOf, isSurfaceDataName } from './sidecars';

describe('isSurfaceDataName (§6.2, per-vertex files for an open surface)', () => {
  it('names the SimNIBS annotations and the FreeSurfer morph files', () => {
    for (const p of [
      '/m2m_ernie/segmentation/lh.ernie_DK40.annot',
      'rh.ernie_a2009s.annot',
      'lh.thickness',
      'C:\\\\subjects\\\\ernie\\\\surf\\\\lh.curv',
      'lh.sulc',
      'lh.area',
    ]) {
      expect(isSurfaceDataName(p), p).toBe(true);
    }
  });
  it('names a data-only GIfTI by intent suffix and nothing else', () => {
    expect(isSurfaceDataName('surf.func.gii')).toBe(true);
    expect(isSurfaceDataName('surf.shape.gii')).toBe(true);
    expect(isSurfaceDataName('surf.label.gii')).toBe(true);
    // A surface, a volume, a mesh, a scene: datasets, opened as themselves.
    for (const p of ['lh.pial.gii', 'lh.pial', 'T1.nii.gz', 'ernie.msh', 'x.tetravox.json']) {
      expect(isSurfaceDataName(p), p).toBe(false);
    }
  });
});

describe('hemisphereOf', () => {
  it('reads the FreeSurfer prefix off the base name only', () => {
    expect(hemisphereOf('/x/lh.pial.gii')).toBe('lh');
    expect(hemisphereOf('rh.ernie_DK40.annot')).toBe('rh');
    expect(hemisphereOf('/lh/ernie.msh')).toBeNull();
  });
});
