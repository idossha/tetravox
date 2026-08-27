/**
 * `ViewSpec` round trip (§4.6).
 *
 * The point of the test is the *boundary*: the fields listed in {@link ROUND_TRIP_FIELDS} must come
 * back byte-for-byte through `toViewSpec` → `applyViewSpec` → `toViewSpec`, and the ones the audit
 * calls out as Phase 2's — `layers`, `activeLayerId`, relative paths, fingerprints — must be visibly
 * absent rather than silently half-working.
 */

import { describe, expect, it } from 'vitest';
import { ROUND_TRIP_FIELDS, applyViewSpec, datasetRefs, toViewSpec } from './serialize';
import { SceneStore } from './store';
import type { Scene, ViewSpec } from './types';

/** A store whose presentation has been moved off every default, so a no-op would fail. */
function movedStore(): SceneStore {
  const store = new SceneStore();
  store.setCursor([-42.5, 18, 6.25]);
  store.setRadiological(true);
  store.setLayout({ kind: '1x3', cells: ['axial', 'coronal', 'sagittal'] });
  store.setBackground([0.1, 0.2, 0.3, 1]);
  store.setLighting({ ambient: 0.5, headlight: false });
  store.setTransparency({ mode: 'peel', peelLayers: 6 });
  store.setAnnotations({ crosshair: false, orientationLabels: false, scaleBar: true });
  store.setView('axial', { mode: 'oblique', normal: [0.5773, 0.5773, 0.5773], up: [0, 0, 1] });
  store.setView('view3d', { showSlicePlanes: true });
  return store;
}

describe('toViewSpec / applyViewSpec', () => {
  it('round-trips every presentation field', () => {
    const source = movedStore();
    const spec = toViewSpec(source.scene);

    const target = new SceneStore();
    applyViewSpec(target, spec);
    const again = toViewSpec(target.scene);

    for (const field of ROUND_TRIP_FIELDS) {
      expect(again[field], field).toEqual(spec[field]);
    }
    // And the fresh store really did move — otherwise the assertion above is vacuous.
    const untouched = toViewSpec(new SceneStore().scene);
    for (const field of ROUND_TRIP_FIELDS) {
      expect(again[field], field).not.toEqual(untouched[field]);
    }
  });

  it('does not merge annotations — a saved scene is a complete description', () => {
    const spec = toViewSpec(movedStore().scene);
    const target = new SceneStore();
    // Move the live scene the *other* way first; none of it may survive the load.
    target.setAnnotations({ crosshair: true, orientationLabels: true, scaleBar: false });
    applyViewSpec(target, spec);
    expect(target.scene.annotations).toEqual(spec.annotations);
    // §8: `conventionBadge` is true, not optional, in anything this engine wrote.
    expect(target.scene.annotations.conventionBadge).toBe(true);
  });

  it('writes version 1 and no datasets for an empty scene', () => {
    const spec = toViewSpec(new SceneStore().scene);
    expect(spec.version).toBe(1);
    expect(spec.datasets).toEqual([]);
    expect(spec.layers).toEqual([]);
    expect(spec.activeLayerId).toBeNull();
  });

  it('is JSON-serialisable — `*.tetravox.json` is the persisted form', () => {
    const spec = toViewSpec(movedStore().scene);
    const parsed = JSON.parse(JSON.stringify(spec)) as ViewSpec;
    const target = new SceneStore();
    applyViewSpec(target, parsed);
    expect(toViewSpec(target.scene).slices).toEqual(spec.slices);
    expect(toViewSpec(target.scene).cursor).toEqual(spec.cursor);
  });

  it('names the Phase-2 gaps rather than half-implementing them', () => {
    // A dataset ref carries an absolute path and an empty fingerprint (§4.6 wants relative + hash).
    const scene = {
      datasets: new Map([
        ['ds1', { id: 'ds1', kind: 'volume', name: 'T1.nii.gz', path: '/abs/T1.nii.gz' }],
      ]),
    } as unknown as Scene;
    const refs = datasetRefs(scene);
    expect(refs[0]?.path).toBe('/abs/T1.nii.gz');
    expect(refs[0]?.absPath).toBe('/abs/T1.nii.gz');
    expect(refs[0]?.fingerprint).toBe('');

    // And `applyViewSpec` restores no layers, because the dataset ids would not match.
    const target = new SceneStore();
    applyViewSpec(target, { ...toViewSpec(movedStore().scene), activeLayerId: 'layer9' });
    expect(target.scene.layers).toEqual([]);
    expect(target.scene.activeLayerId).toBeNull();
  });
});
