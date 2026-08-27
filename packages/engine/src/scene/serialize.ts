/**
 * `ViewSpec` in and out — §4.6's persisted form, `*.tetravox.json`.
 *
 * **This is a stub, and the audit says exactly which half.** What round-trips today is the
 * *presentation*: views, layout, cursor, radiological flag, background, lighting, annotations,
 * transparency. What does not, and is Phase 2's (owner: E-SCENE, item P2-07):
 *
 * * `DatasetRef.path` is written **absolute**; §4.6 wants it relative to the scene file with an
 *   absolute fallback.
 * * `DatasetRef.fingerprint` is `''`. The fingerprint needs the file bytes, which the UI thread does
 *   not keep (§5 rule 3) — it has to be computed in the worker at load time and carried on the meta.
 * * `applyViewSpec` does **not** restore `layers` or `activeLayerId`, and cannot as written: the
 *   datasets a load re-adds get fresh ids (`ds1`, `ds2`, …) that do not match the spec's, so the
 *   missing piece is an id remap, not an assignment.
 * * A dataset that cannot be resolved needs §8's **relocate dialog**, which is the app's half.
 *
 * Keeping the shape here, tested, means the Phase-2 work is filling in three functions rather than
 * inventing a serialisation format under time pressure.
 */

import type { SceneStore } from './store';
import type { DatasetRef, Scene, ViewSpec } from './types';

/** The §4.6 fields that survive a round trip today. Everything else is listed above as Phase 2's. */
export const ROUND_TRIP_FIELDS = [
  'slices',
  'view3d',
  'layout',
  'cursor',
  'radiological',
  'background',
  'lighting',
  'annotations',
  'transparency',
] as const;

/** One `DatasetRef` per loaded dataset. See the header for what is still a placeholder. */
export function datasetRefs(scene: Scene): DatasetRef[] {
  return [...scene.datasets.values()].map((ds) => ({
    id: ds.id,
    kind: ds.kind === 'volume' ? 'volume' : 'mesh',
    name: ds.name,
    // PHASE 2 (E-SCENE): relative to the scene file, with `absPath` as the fallback (§4.6).
    path: ds.path ?? '',
    absPath: ds.path,
    // PHASE 2 (E-SCENE): computed in the worker at load time and carried on the meta — the UI thread
    // never sees the bytes (§5 rule 3).
    fingerprint: '',
  }));
}

/** `Engine.serialize()` (§4.7): the scene as a `ViewSpec`. */
export function toViewSpec(scene: Scene): ViewSpec {
  return {
    version: 1,
    datasets: datasetRefs(scene),
    layers: scene.layers.map((l) => ({
      ...l,
      // §4.6's `SerializableLayer` replaces the `Uint32Array` with a plain array so the spec is JSON.
      visibleLabels:
        'visibleLabels' in l && l.visibleLabels !== undefined ? [...l.visibleLabels] : undefined,
    })) as ViewSpec['layers'],
    activeLayerId: scene.activeLayerId,
    slices: scene.slices,
    view3d: scene.view3d,
    layout: scene.layout,
    cursor: scene.cursor,
    radiological: scene.radiological,
    background: scene.background,
    lighting: scene.lighting,
    annotations: scene.annotations,
    transparency: scene.transparency,
  };
}

/**
 * Apply the presentation half of a `ViewSpec` to a store.
 *
 * Annotations are assigned **as the spec holds them**, not merged through
 * `SceneStore.setAnnotations` — a saved scene is a complete description, and merging would let the
 * live scene's flags leak into a loaded one. `conventionBadge` is still `true` in any spec this
 * engine wrote, because `setAnnotations` forces it (§8).
 */
export function applyViewSpec(store: SceneStore, spec: ViewSpec): void {
  store.setSlices(spec.slices);
  store.setView3D(spec.view3d);
  store.setLayout(spec.layout);
  store.setCursor(spec.cursor);
  store.setRadiological(spec.radiological);
  store.setBackground(spec.background);
  store.setLighting(spec.lighting);
  store.replaceAnnotations(spec.annotations);
  store.setTransparency(spec.transparency);
  // PHASE 2 (E-SCENE): `spec.layers` and `spec.activeLayerId`, once dataset ids are remapped.
}
