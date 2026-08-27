/**
 * `ViewSpec` round trip (§4.6, P2-07).
 *
 * The point of the test is the *boundary*: the fields listed in {@link ROUND_TRIP_FIELDS} must come
 * back byte-for-byte through `toViewSpec` → `applyViewSpec` → `toViewSpec`, and the four things the
 * audit called out — relative paths, fingerprints, the dataset-id remap, `activeLayerId` — must each
 * be asserted on its own rather than inferred from a scene that happens to look right.
 *
 * Everything below is a pure function. The half that needs a live engine (creating the layers a
 * remap points at, on real files, from a **moved** directory) is `test/e2e/scene-io.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ROUND_TRIP_FIELDS,
  applyViewSpec,
  candidatePaths,
  commonDirectory,
  datasetRefs,
  fingerprintFromMeta,
  isRestorableKind,
  joinPath,
  relativePath,
  remapLayer,
  remapViews,
  serializableLayer,
  toViewSpec,
} from './serialize';
import { SceneStore } from './store';
import { defaultMeshLayer, defaultVolumeLayer } from './defaults';
import type {
  Layer,
  MeshDataset,
  Scene,
  SerializableLayer,
  ViewSpec,
  VolumeDataset,
} from './types';

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

  it('leaves layers to the engine — `applyViewSpec` is the view half alone', () => {
    // Restoring a layer means creating its runtime, which is `addLayer`'s job; the store cannot.
    const target = new SceneStore();
    applyViewSpec(target, { ...toViewSpec(movedStore().scene), activeLayerId: 'layer9' });
    expect(target.scene.layers).toEqual([]);
    expect(target.scene.activeLayerId).toBeNull();
  });
});

// =============================================================================================
// P2-07 (1) — paths relative to the scene file, with an absolute fallback (§4.6)
// =============================================================================================

describe('relativePath / joinPath', () => {
  it('round-trips a path under the directory', () => {
    expect(relativePath('/data/sub-ernie', '/data/sub-ernie/m2m/T1.nii.gz')).toBe('m2m/T1.nii.gz');
    expect(joinPath('/data/sub-ernie', 'm2m/T1.nii.gz')).toBe('/data/sub-ernie/m2m/T1.nii.gz');
  });

  it('climbs with `..` when the file is outside the directory', () => {
    expect(relativePath('/data/scenes', '/data/sub-ernie/T1.nii.gz')).toBe(
      '../sub-ernie/T1.nii.gz'
    );
    expect(joinPath('/data/scenes', '../sub-ernie/T1.nii.gz')).toBe('/data/sub-ernie/T1.nii.gz');
  });

  it('gives up rather than inventing a relative path across roots or protocols', () => {
    // Nothing in common below the root.
    expect(relativePath('/a/b', '/x/y/T1.nii.gz')).toBe('/x/y/T1.nii.gz');
    // A URL is passed to the worker verbatim (`datasets/source.ts`) and is not a path.
    expect(relativePath('/data', 'https://host/T1.nii.gz')).toBe('https://host/T1.nii.gz');
    expect(joinPath('/data', 'https://host/T1.nii.gz')).toBe('https://host/T1.nii.gz');
    // Absolute stays absolute.
    expect(joinPath('/data', '/elsewhere/T1.nii.gz')).toBe('/elsewhere/T1.nii.gz');
  });

  it('treats a Vite `/@fs/` alias as the path it structurally is — the §11 harness depends on it', () => {
    expect(relativePath('/@fs/data/scenes', '/@fs/data/sub/T1.nii.gz')).toBe('../sub/T1.nii.gz');
    expect(joinPath('/@fs/data/scenes', '../sub/T1.nii.gz')).toBe('/@fs/data/sub/T1.nii.gz');
  });

  it('reads a Windows separator, and writes one form', () => {
    expect(relativePath('C:\\data\\sub', 'C:\\data\\sub\\m2m\\T1.nii.gz')).toBe('m2m/T1.nii.gz');
  });
});

describe('commonDirectory', () => {
  it('is the deepest shared directory of the files themselves', () => {
    expect(commonDirectory(['/data/sub/m2m/T1.nii.gz', '/data/sub/m2m/ernie.msh'])).toBe(
      '/data/sub/m2m'
    );
    expect(commonDirectory(['/data/sub/m2m/T1.nii.gz', '/data/sub/sim/x.msh'])).toBe('/data/sub');
  });

  it('is empty when there is nothing usable to share', () => {
    expect(commonDirectory([])).toBe('');
    expect(commonDirectory(['', ''])).toBe('');
    expect(commonDirectory(['https://a/x.nii', 'https://b/y.nii'])).toBe('');
  });
});

describe('datasetRefs', () => {
  const scene = (paths: string[]): Scene =>
    ({
      datasets: new Map(
        paths.map((p, i) => [
          `ds${i + 1}`,
          { id: `ds${i + 1}`, kind: 'volume', name: p.split('/').pop(), path: p },
        ])
      ),
    }) as unknown as Scene;

  it('writes the path relative to the scene directory it is given, and always an absPath', () => {
    const refs = datasetRefs(scene(['/data/sub/m2m/T1.nii.gz']), { sceneDir: '/data/scenes' });
    expect(refs[0]?.path).toBe('../sub/m2m/T1.nii.gz');
    expect(refs[0]?.absPath).toBe('/data/sub/m2m/T1.nii.gz');
  });

  it('falls back to the datasets’ own common directory when no scene directory is set', () => {
    const refs = datasetRefs(scene(['/data/sub/m2m/T1.nii.gz', '/data/sub/m2m/ernie.msh']));
    expect(refs.map((r) => r.path)).toEqual(['T1.nii.gz', 'ernie.msh']);
  });

  it('carries the loader’s fingerprint when there is one, and `""` when there is not', () => {
    const refs = datasetRefs(scene(['/d/a.nii', '/d/b.nii']), {
      fingerprints: new Map([['ds1', '1234-abcd-ef01']]),
    });
    expect(refs[0]?.fingerprint).toBe('1234-abcd-ef01');
    expect(refs[1]?.fingerprint).toBe('');
  });
});

describe('candidatePaths — the resolution order §4.6 gives', () => {
  const ref = {
    id: 'ds1',
    kind: 'volume' as const,
    name: 'T1.nii.gz',
    path: '../sub/T1.nii.gz',
    absPath: '/old/sub/T1.nii.gz',
    fingerprint: '',
  };

  it('tries the scene-relative path first and the absolute one second', () => {
    expect(candidatePaths(ref, '/new/scenes')).toEqual([
      '/new/sub/T1.nii.gz',
      '/old/sub/T1.nii.gz',
    ]);
  });

  it('never repeats the same path twice', () => {
    expect(candidatePaths({ ...ref, path: '/old/sub/T1.nii.gz' }, null)).toEqual([
      '/old/sub/T1.nii.gz',
    ]);
  });
});

describe('fingerprintFromMeta — W-WASM gap 1, read defensively', () => {
  it('takes a string and nothing else', () => {
    expect(fingerprintFromMeta({ fingerprint: 'abc' })).toBe('abc');
    expect(fingerprintFromMeta({ fingerprint: 42 })).toBe('');
    expect(fingerprintFromMeta({})).toBe('');
    expect(fingerprintFromMeta(null)).toBe('');
  });
});

// =============================================================================================
// P2-07 (2) — layers: JSON-safe out, dataset-id remapped back in
// =============================================================================================

const volumeDataset = (id: string): VolumeDataset =>
  ({
    kind: 'volume',
    id,
    name: `${id}.nii.gz`,
    isLabel: false,
    stats: { percentiles: { '2': 10, '98': 90 }, min: 0, max: 100 },
  }) as unknown as VolumeDataset;

const meshDataset = (id: string): MeshDataset =>
  ({
    kind: 'mesh',
    id,
    name: `${id}.msh`,
    tags: [
      { id: 2, name: 'GM', color: [0.5, 0.5, 0.5, 1], kind: 'tet', count: 4 },
      { id: 5, name: 'Scalp', color: [1, 0.8, 0.7, 1], kind: 'tri', count: 8 },
    ],
    orient: { components: 1, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
  }) as unknown as MeshDataset;

describe('serializableLayer (§4.6 SerializableLayer)', () => {
  it('turns `visibleLabels` into a plain array — a Uint32Array is not JSON', () => {
    const layer: Layer = {
      ...defaultVolumeLayer('layer1', volumeDataset('ds1')),
      visibleLabels: Uint32Array.from([3, 17, 530]),
    };
    const out = serializableLayer(layer) as { visibleLabels?: number[] };
    expect(out.visibleLabels).toEqual([3, 17, 530]);
    // The trap this exists for: JSON.stringify turns a typed array into {"0":3,...} without a word.
    expect(JSON.parse(JSON.stringify(out.visibleLabels))).toEqual([3, 17, 530]);
  });

  it('drops `MeshLayer.label.table` — §4.6 re-derives it from the dataset and its LUT', () => {
    const mesh = defaultMeshLayer('layer2', meshDataset('ds2'));
    const layer: Layer = {
      ...mesh,
      colorMode: 'label',
      label: {
        name: 'DK40',
        table: { entries: [{ id: 1, name: 'a', color: [1, 0, 0, 1] }], byId: new Map() },
        mode: 'outline',
        outlineWidthPx: 2,
        visibleLabels: Uint32Array.from([1]),
      },
    };
    const out = serializableLayer(layer) as { label?: Record<string, unknown> };
    expect(out.label).toEqual({
      name: 'DK40',
      mode: 'outline',
      outlineWidthPx: 2,
      visibleLabels: [1],
    });
    // A Map stringifies to `{}`, which is how a table would silently become an empty one.
    expect(JSON.stringify(out.label)).not.toContain('byId');
  });

  it('carries R5’s edits: `tagStyle` colour, visibility and opacity survive JSON', () => {
    const mesh = defaultMeshLayer('layer3', meshDataset('ds3'));
    const layer: Layer = {
      ...mesh,
      tagStyle: {
        2: { visible: false, opacity: 0.35, color: [0.1, 0.2, 0.3, 1] },
        5: { visible: true, opacity: 1 },
      },
    };
    const parsed = JSON.parse(JSON.stringify(serializableLayer(layer))) as SerializableLayer;
    expect((parsed as unknown as { tagStyle: Record<string, unknown> }).tagStyle).toEqual({
      2: { visible: false, opacity: 0.35, color: [0.1, 0.2, 0.3, 1] },
      5: { visible: true, opacity: 1 },
    });
  });
});

describe('remapLayer — the dataset-id remap a load cannot work without', () => {
  const idMap = new Map([
    ['ds1', 'ds7'],
    ['ds2', 'ds8'],
  ]);

  it('rewrites the layer’s own dataset and returns it as an addLayer patch, without the old id', () => {
    const layer = serializableLayer(defaultVolumeLayer('layer1', volumeDataset('ds1')));
    const patch = remapLayer(layer, idMap);
    expect(patch?.datasetId).toBe('ds7');
    expect((patch as unknown as { id?: string }).id).toBeUndefined();
  });

  it('restores `visibleLabels` as a Uint32Array, not the array JSON held', () => {
    const layer = serializableLayer({
      ...defaultVolumeLayer('layer1', volumeDataset('ds1')),
      visibleLabels: Uint32Array.from([1, 2]),
    });
    const patch = remapLayer(JSON.parse(JSON.stringify(layer)) as SerializableLayer, idMap);
    expect((patch as { visibleLabels?: Uint32Array }).visibleLabels).toBeInstanceOf(Uint32Array);
    expect([...((patch as { visibleLabels?: Uint32Array }).visibleLabels ?? [])]).toEqual([1, 2]);
  });

  it('rewrites the SECOND dataset a mesh layer names — `isolate.labelVolume`', () => {
    const mesh = defaultMeshLayer('layer2', meshDataset('ds2'));
    const layer = serializableLayer({
      ...mesh,
      isolate: {
        combine: 'all',
        labelVolume: { datasetId: 'ds1', volumeIndex: 0, labels: [17] },
      },
    });
    const patch = remapLayer(layer, idMap) as { isolate?: { labelVolume?: { datasetId: string } } };
    expect(patch.isolate?.labelVolume?.datasetId).toBe('ds7');
  });

  it('drops an isolation whose label volume did not come back, rather than pointing at a stranger', () => {
    const mesh = defaultMeshLayer('layer2', meshDataset('ds2'));
    const layer = serializableLayer({
      ...mesh,
      isolate: {
        combine: 'all',
        labelVolume: { datasetId: 'dsGone', volumeIndex: 0, labels: [17] },
      },
    });
    const patch = remapLayer(layer, idMap) as { isolate?: { labelVolume?: unknown } };
    expect(patch.isolate?.labelVolume).toBeUndefined();
  });

  it('returns null when the layer’s own dataset did not resolve', () => {
    const layer = serializableLayer(defaultVolumeLayer('layer1', volumeDataset('dsGone')));
    expect(remapLayer(layer, idMap)).toBeNull();
  });

  it('only claims the kinds `scene/defaults.ts` can seed today', () => {
    expect(isRestorableKind('volume')).toBe(true);
    expect(isRestorableKind('mesh')).toBe(true);
    expect(isRestorableKind('iso')).toBe(false);
    expect(isRestorableKind('points')).toBe(false);
  });
});

describe('remapViews — `layerVisibility` is keyed by LayerId too', () => {
  it('rewrites the ids and drops the ones the load did not recreate', () => {
    const store = new SceneStore();
    store.setView('axial', { layerVisibility: { layer1: false, layerGone: false } });
    store.setView3D({ ...store.scene.view3d, layerVisibility: { layer1: true } });
    const spec = toViewSpec(store.scene);
    const { slices, view3d } = remapViews(spec, new Map([['layer1', 'layer9']]));
    expect(slices[0]?.layerVisibility).toEqual({ layer9: false });
    expect(view3d.layerVisibility).toEqual({ layer9: true });
  });

  it('leaves a view that names no layer without the field at all', () => {
    const spec = toViewSpec(new SceneStore().scene);
    const { slices } = remapViews(spec, new Map());
    expect('layerVisibility' in (slices[0] ?? {})).toBe(false);
  });
});
