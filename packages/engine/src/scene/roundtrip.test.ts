/**
 * The §4.6 round trip on a **synthetic full scene** (directed task 13, 2026-08-28).
 *
 * `serialize.test.ts` checks the pieces — one field, one remap, one path. This file asks the
 * question the maintainer actually asked: *does everything a user can set survive a save and a
 * load?* So every layer here is built by taking the layer `scene/defaults.ts` seeds and moving
 * **every** field off its default, including the optional ones the property editors expose (a mesh's
 * `isolate`, `glyphs`, `clip`, `tagStyle` and annotation `label`; a volume's `labelColors`,
 * `selectedLabels`, `labelOpacity` and `iso3d`; a points layer's per-point overrides and value
 * colouring; an isosurface's level and shading). The trip is the real one a scene file takes —
 * `toViewSpec` → `JSON.stringify` → `JSON.parse` → `migrateViewSpec` → `remapLayer` — and the
 * assertion is a deep equality against the layer we started with.
 *
 * Two differences from the original are expected, are §4.6's, and are asserted rather than ignored:
 *
 *  * `MeshLayer.label.table` is **not** serialised — it is re-derived from the dataset and its LUT,
 *    and `Engine.addLayer` merges the re-derived table back under the settings restored here.
 *  * `PointsLayer.labels` / `lineSegments` are dataset-derived (`MeshDataset.geo`) and a
 *    `Float32Array` respectively, so they are re-seeded rather than written.
 *
 * Anything else that differs is a field a user can set and a scene file loses, which is the bug
 * class this test exists to make impossible to add.
 */

import { describe, expect, it } from 'vitest';
import { SCENE_VERSION, applyViewSpec, migrateViewSpec, remapLayer, toViewSpec } from './serialize';
import { SceneStore } from './store';
import {
  defaultIsoLayer,
  defaultMeshLayer,
  defaultPointsLayer,
  defaultVolumeLayer,
} from './defaults';
import type { DatasetId, Layer, MeshDataset, ViewSpec, VolumeDataset } from './types';

const volumeDataset = (id: string): VolumeDataset =>
  ({
    kind: 'volume',
    id,
    name: `${id}.nii.gz`,
    path: `/data/${id}.nii.gz`,
    isLabel: true,
    labelIds: [0, 3, 17],
    stats: { percentiles: { '2': 10, '95': 88, '98': 90 }, min: 0, max: 100 },
  }) as unknown as VolumeDataset;

const meshDataset = (id: string): MeshDataset =>
  ({
    kind: 'mesh',
    id,
    name: `${id}.msh`,
    path: `/data/${id}.msh`,
    hasTris: true,
    tags: [
      { id: 2, name: 'GM', color: [0.5, 0.5, 0.5, 1], kind: 'tet', count: 4 },
      { id: 5, name: 'Scalp', color: [1, 0.8, 0.7, 1], kind: 'tri', count: 8 },
    ],
    fields: [{ source: 'elm', name: 'E', ncomp: 3, min: -44.68, max: 54.31 }],
    orient: { components: 1, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
  }) as unknown as MeshDataset;

/** A volume layer with every optional field of §4.4 populated. */
function fullVolumeLayer(): Layer {
  return {
    ...defaultVolumeLayer('layer1', volumeDataset('ds1')),
    name: 'atlas',
    visible: false,
    opacity: 0.42,
    pickable: false,
    showColorbar: true,
    volumeIndex: 3,
    colormap: 'viridis',
    colormapNegative: 'cool',
    scale: { mode: 'window', lo: 12, hi: 88, gamma: 1.4 },
    threshold: { lo: 0.25, hi: 0.75, mode: 'clamp' },
    interpolation: 'nearest',
    labelMode: 'both',
    outlineWidthPx: 3,
    visibleLabels: Uint32Array.from([3, 17]),
    labelOpacity: { 3: 0.5 },
    labelColors: { 17: [0.1, 0.2, 0.3, 1] },
    selectedLabels: [17],
    showIn3D: true,
    precision: 'f32',
    iso3d: { enabled: true, iso: 0.5, color: [1, 0, 0, 1], opacity: 0.6, smooth: true },
  } as unknown as Layer;
}

function fullMeshLayer(): Layer {
  return {
    ...defaultMeshLayer('layer2', meshDataset('ds2')),
    name: 'head',
    opacity: 0.7,
    colorMode: 'field',
    solidColor: [0.2, 0.4, 0.6, 1],
    field: { source: 'elm', name: 'E', component: 1 },
    label: {
      name: 'aparc',
      table: { entries: new Map([[1, { name: 'bankssts', color: [1, 0, 0, 1] }]]) },
      mode: 'outline',
      outlineWidthPx: 4,
      visibleLabels: Uint32Array.from([1, 5]),
    },
    colormap: 'jet',
    colormapNegative: 'bone',
    scale: { mode: 'window', lo: -3, hi: 9, gamma: 1 },
    threshold: { lo: 0.1, hi: 0.9, mode: 'clamp' },
    tagStyle: {
      2: { visible: false, opacity: 0.3, color: [0, 1, 0, 1] },
      5: { visible: true, opacity: 1 },
    },
    edges: { surface: true, caps: true },
    edgeColor: [0, 0, 0, 1],
    edgeWidthPx: 2,
    flatShading: true,
    faceMode: 'both',
    clip: {
      planes: [{ plane: { normal: [1, 0, 0], offset: 12 }, enabled: true, followCursor: true }],
      caps: true,
      capColorMode: 'tag',
    },
    isolate: {
      tags: [2],
      field: { source: 'elm', name: 'E', component: 'mag', lo: 1, hi: 9 },
      sphere: { center: [1, 2, 3], radius: 20 },
      labelVolume: { datasetId: 'ds1' as DatasetId, volumeIndex: 0, labels: [17] },
      combine: 'any',
    },
    glyphs: {
      field: { source: 'elm', name: 'E' },
      shape: 'arrow',
      subsample: { everyNth: 7 },
      scale: { mode: 'log', lengthMm: 4, normalizeTo: 'p99', logFloor: 1e-3 },
      lengthMm: 4,
      colorBy: 'magnitude',
      color: [1, 1, 0, 1],
      clipToCutPlane: false,
      onCutPlaneOnly: true,
      cutSlabMm: 2,
      headProportion: 0.25,
      origins: 'volume',
    },
    contoursIn2D: true,
    contourWidthPx: 3,
    fillIn2D: false,
  } as unknown as Layer;
}

function fullIsoLayer(): Layer {
  return {
    ...defaultIsoLayer('layer3', volumeDataset('ds1')),
    name: 'surface at p95',
    opacity: 0.55,
    iso: 42.5,
    color: [0.3, 0.7, 0.9, 1],
    smooth: true,
    faceMode: 'both',
  } as unknown as Layer;
}

function fullPointsLayer(): Layer {
  return {
    ...defaultPointsLayer('layer4', meshDataset('ds2')),
    name: 'GSN-HydroCel-185',
    points: [
      {
        name: 'E001',
        position: [1, 2, 3],
        color: [1, 0, 0, 1],
        radiusMm: 3,
        value: 0.5,
        id: 'c1',
        group: 'LINS',
        ordinal: 1,
      },
      { name: 'E002', position: [4, 5, 6], id: 'c2', group: 'LINS', ordinal: 2 },
    ],
    shape: 'sphere',
    radiusMm: 2.5,
    color: [1, 1, 1, 1],
    showLabels: true,
    labelScale: 1.5,
    labelColor: [0, 1, 1, 1],
    lineWidthPx: 3,
    lineColor: [1, 0, 1, 1],
    valueMode: 'value',
    colormap: 'hot',
    valueRange: { lo: 0, hi: 1 },
    // §13's five fields (2026-08-30): a module tag on the layer, an identity/electrode/ordinal on
    // every point, and the two rendering fields. All optional, so this layer is the one that says
    // they are persisted — the loop below asserts every key of it survives the trip.
    module: 'tetravox.seeg',
    offPlaneOpacity: 0.6,
    labelSource: 'names',
    // Dataset-derived: written by the loader, never by the scene file.
    labels: [{ position: [1, 2, 3], text: 'E001' }],
    lineSegments: Float32Array.from([0, 0, 0, 1, 1, 1]),
  } as unknown as Layer;
}

/** The whole trip a scene file takes, for one layer. */
function roundTrip(layer: Layer): Record<string, unknown> {
  const store = new SceneStore();
  store.addLayer(layer);
  const spec = toViewSpec(store.scene);
  const reread = migrateViewSpec(JSON.parse(JSON.stringify(spec)) as ViewSpec);
  const idMap = new Map<DatasetId, DatasetId>([
    ['ds1' as DatasetId, 'ds1' as DatasetId],
    ['ds2' as DatasetId, 'ds2' as DatasetId],
  ]);
  const patch = remapLayer(reread.layers[0]!, idMap);
  expect(patch).not.toBeNull();
  return patch as unknown as Record<string, unknown>;
}

describe('the §4.6 round trip on a full scene', () => {
  it('writes the current version', () => {
    expect(toViewSpec(new SceneStore().scene).version).toBe(SCENE_VERSION);
  });

  it('keeps every field of a fully-set volume layer', () => {
    const original = fullVolumeLayer() as unknown as Record<string, unknown>;
    const out = roundTrip(fullVolumeLayer());
    // `id` is re-issued by `addLayer`; `datasetId` is remapped. Everything else must match.
    for (const [key, value] of Object.entries(original)) {
      if (key === 'id' || key === 'datasetId') continue;
      expect(out[key], key).toEqual(value);
    }
  });

  it('keeps every field of a fully-set mesh layer, table apart', () => {
    const original = fullMeshLayer() as unknown as Record<string, unknown>;
    const out = roundTrip(fullMeshLayer());
    for (const [key, value] of Object.entries(original)) {
      if (key === 'id' || key === 'datasetId' || key === 'label') continue;
      expect(out[key], key).toEqual(value);
    }
    // The annotation's **settings** survive (they used to be deleted wholesale); its table does not,
    // because §4.6 re-derives it and `Engine.addLayer` merges it back underneath these three.
    const label = out['label'] as Record<string, unknown>;
    expect(label['name']).toBe('aparc');
    expect(label['mode']).toBe('outline');
    expect(label['outlineWidthPx']).toBe(4);
    expect(label['visibleLabels']).toEqual(Uint32Array.from([1, 5]));
    expect(label['table']).toBeUndefined();
  });

  it('keeps every field of an isosurface layer', () => {
    const original = fullIsoLayer() as unknown as Record<string, unknown>;
    const out = roundTrip(fullIsoLayer());
    for (const [key, value] of Object.entries(original)) {
      if (key === 'id' || key === 'datasetId') continue;
      expect(out[key], key).toEqual(value);
    }
  });

  it('keeps every user-set field of a points layer, and drops the dataset-derived two', () => {
    const original = fullPointsLayer() as unknown as Record<string, unknown>;
    const out = roundTrip(fullPointsLayer());
    for (const [key, value] of Object.entries(original)) {
      if (['id', 'datasetId', 'labels', 'lineSegments'].includes(key)) continue;
      expect(out[key], key).toEqual(value);
    }
    // Re-seeded from `MeshDataset.geo` on load — and `lineSegments` in particular must never be
    // written: `JSON.stringify` turns a Float32Array into `{"0":…}`, megabytes that restore garbage.
    expect(out['labels']).toBeUndefined();
    expect(out['lineSegments']).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // §13's module fields (2026-08-30). The loop above already covers them for a points layer; these
  // three name the specific promises §4.4 / §4.6 make about them, so a regression reads as the
  // broken promise rather than as "a key differs".
  // -------------------------------------------------------------------------------------------

  it("keeps a point's id, group and ordinal — identity is what a tool selects by", () => {
    const out = roundTrip(fullPointsLayer());
    expect(out['points']).toEqual([
      {
        name: 'E001',
        position: [1, 2, 3],
        color: [1, 0, 0, 1],
        radiusMm: 3,
        value: 0.5,
        id: 'c1',
        group: 'LINS',
        ordinal: 1,
      },
      { name: 'E002', position: [4, 5, 6], id: 'c2', group: 'LINS', ordinal: 2 },
    ]);
    expect(out['module']).toBe('tetravox.seeg');
    expect(out['offPlaneOpacity']).toBe(0.6);
    expect(out['labelSource']).toBe('names');
  });

  it('never writes `extensions` from the engine — §4.6 says the app does', () => {
    const store = new SceneStore();
    store.addLayer(fullPointsLayer());
    const spec = toViewSpec(store.scene);
    // `toViewSpec` enumerates `Scene`, and there is no module state in `Scene`. A key written here
    // would mean the engine had grown a module registry, which §4.4 forbids.
    expect('extensions' in spec).toBe(false);
  });

  it('carries an app-written `extensions` block through the file unchanged', () => {
    const store = new SceneStore();
    store.addLayer(fullPointsLayer());
    // What `lib/scene.ts` does on save: the engine's spec, plus the blocks the app is holding.
    const spec: ViewSpec = {
      ...toViewSpec(store.scene),
      extensions: {
        'tetravox.seeg': {
          module: 'tetravox.seeg',
          version: 1,
          moduleVersion: '0.1.0',
          data: { rows: { c1: { status: 'kept' } }, namePad: 2 },
        },
      },
    };
    const reread = migrateViewSpec(JSON.parse(JSON.stringify(spec)) as ViewSpec);
    expect(reread.extensions).toEqual(spec.extensions);
  });

  it('degrades to a plain points layer when an older build drops the block', () => {
    // §4.6's degradation contract: a build that has never heard of the module re-saves the scene.
    // It drops `extensions` (it holds no blocks) and keeps every per-point field, because those
    // ride `serializableLayer`'s spread — which is why §4.6 states that pass-through as a guarantee.
    const store = new SceneStore();
    store.addLayer(fullPointsLayer());
    const spec: ViewSpec = {
      ...toViewSpec(store.scene),
      extensions: {
        'tetravox.seeg': { module: 'tetravox.seeg', version: 1, moduleVersion: '0.1.0', data: {} },
      },
    };
    const { extensions: _dropped, ...withoutBlock } = spec;
    const reread = migrateViewSpec(JSON.parse(JSON.stringify(withoutBlock)) as ViewSpec);
    expect(reread.extensions).toBeUndefined();
    const points = (reread.layers[0] as unknown as { points: { group?: string }[] }).points;
    expect(points.map((p) => p.group)).toEqual(['LINS', 'LINS']);
    expect((reread.layers[0] as unknown as { module?: string }).module).toBe('tetravox.seeg');
  });

  it('survives JSON as a whole scene: four layers, four kinds, one file', () => {
    const store = new SceneStore();
    for (const layer of [fullVolumeLayer(), fullMeshLayer(), fullIsoLayer(), fullPointsLayer()]) {
      store.addLayer(layer);
    }
    store.setCursor([-42.5, 18, 6.25]);
    store.setLayout({ kind: '1+3', cells: ['view3d', 'axial', 'coronal', 'sagittal'] });
    const spec = toViewSpec(store.scene);
    const text = JSON.stringify(spec, null, 2);
    const reread = migrateViewSpec(JSON.parse(text) as ViewSpec);
    expect(reread.layers.map((l) => l.kind)).toEqual(['volume', 'mesh', 'iso', 'points']);
    expect(reread.cursor).toEqual([-42.5, 18, 6.25]);
    expect(reread.layout.kind).toBe('1+3');
    // No typed array reached the file: one would have become `{"0":…}` and read back as an object.
    expect(text).not.toContain('"0":');
  });

  it('keeps an unbounded threshold unbounded — JSON has no infinity', () => {
    // `JSON.stringify(Infinity)` is `null`, silently. `scene/defaults.ts` seeds every layer with
    // `lo: -Infinity, hi: Infinity` ("let everything through"), so before directed task 13 **every**
    // scene anyone ever saved read back with two nulls where its two bounds should be.
    const layer = {
      ...(fullVolumeLayer() as unknown as Record<string, unknown>),
      threshold: { lo: -Infinity, hi: Infinity, symmetric: false, mode: 'clamp', softEdge: 0 },
    } as unknown as Layer;
    const store = new SceneStore();
    store.addLayer(layer);
    const text = JSON.stringify(toViewSpec(store.scene));
    // On disk it is `null`, deliberately — a file a human can read, with no sentinel string in it.
    const onDisk = (JSON.parse(text) as ViewSpec).layers[0] as unknown as {
      threshold: { lo: number | null; hi: number | null };
    };
    expect(onDisk.threshold).toEqual({
      lo: null,
      hi: null,
      symmetric: false,
      mode: 'clamp',
      softEdge: 0,
    });
    // And back in memory it is the bound the null stood for.
    const out = roundTrip(layer);
    expect(out['threshold']).toEqual({
      lo: -Infinity,
      hi: Infinity,
      symmetric: false,
      mode: 'clamp',
      softEdge: 0,
    });
  });

  it('migrates a v1 spec to the current version and changes nothing else', () => {
    const spec = toViewSpec(movedScene());
    const v1 = { ...spec, version: 1 as const };
    const migrated = migrateViewSpec(v1);
    expect(migrated.version).toBe(SCENE_VERSION);
    expect({ ...migrated, version: 1 }).toEqual(v1);
    // Already current: returned as it stands, so a load does not copy a spec for nothing.
    expect(migrateViewSpec(spec)).toBe(spec);
  });
});

function movedScene() {
  const store = new SceneStore();
  store.addLayer(fullMeshLayer());
  store.setCursor([1, 2, 3]);
  return store.scene;
}

/**
 * §4.6 v2's two optional fields are JSON and survive the file unchanged.
 *
 * `measurements` was an opaque `unknown[]` when task 13 reserved the slot; task 11 gave it its real
 * type, so the shape below is a `Measurement` rather than an invented placeholder — which is the
 * point of the field having one definition.
 */
describe('v2 fields', () => {
  it('carries a theme and measurements through JSON', () => {
    const spec: ViewSpec = {
      ...toViewSpec(new SceneStore().scene),
      theme: 'light',
      measurements: [
        {
          id: 'meas1',
          kind: 'distance',
          name: 'M1',
          points: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
      ],
    };
    const reread = JSON.parse(JSON.stringify(spec)) as ViewSpec;
    expect(reread.theme).toBe('light');
    expect(reread.measurements).toEqual(spec.measurements);
  });

  it('a scene with measurements serialises them and loads them back (task 11)', () => {
    const store = new SceneStore();
    store.addMeasurement({
      id: 'meas1',
      kind: 'angle',
      name: 'M1',
      points: [
        [10, 0, 0],
        [0, 0, 0],
        [0, 10, 0],
      ],
    });
    const spec = JSON.parse(JSON.stringify(toViewSpec(store.scene))) as ViewSpec;
    expect(spec.measurements).toHaveLength(1);

    const fresh = new SceneStore();
    applyViewSpec(fresh, spec);
    expect(fresh.scene.measurements).toEqual(store.scene.measurements);

    // A v1 spec — one written before the field existed — loads as "no measurements", never as
    // "keep whatever the live scene had".
    const v1 = { ...spec, version: 1 as const };
    delete (v1 as { measurements?: unknown }).measurements;
    applyViewSpec(fresh, migrateViewSpec(v1));
    expect(fresh.scene.measurements).toEqual([]);
  });
});
