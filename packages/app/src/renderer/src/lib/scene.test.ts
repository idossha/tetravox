/**
 * §4.6's path arithmetic and the layer reconcile, without a filesystem.
 *
 * Every assertion here is a string or a shape, which is the point: "paths are stored relative to the
 * scene file with an absolute fallback" is a rule about text, and the only way a relocate dialog can
 * be trusted is if the candidate order it skips is checkable without moving real files around.
 */

import { describe, expect, it } from 'vitest';
import type { DatasetRef, Layer, ViewSpec } from '@tetravox/engine';
import {
  defaultSceneName,
  dirName,
  isAbsolutePath,
  joinPath,
  layersToRestore,
  normalisePath,
  parseScene,
  relativePath,
  relocationCandidates,
  serialiseScene,
  withRelativePaths,
} from './scene';

describe('paths', () => {
  it('recognises POSIX, drive-letter and UNC absolutes', () => {
    expect(isAbsolutePath('/a/b')).toBe(true);
    expect(isAbsolutePath('C:\\a\\b')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('a/b')).toBe(false);
    expect(isAbsolutePath('../a')).toBe(false);
  });

  it('takes the directory off a path', () => {
    expect(dirName('/a/b/scene.tetravox.json')).toBe('/a/b');
    expect(dirName('C:\\a\\b\\scene.json')).toBe('C:\\a\\b');
    expect(dirName('scene.json')).toBe('');
  });

  it('collapses . and .. but never drops a leading ..', () => {
    expect(normalisePath('/a/b/../c')).toBe('/a/c');
    expect(normalisePath('/a/./b//c')).toBe('/a/b/c');
    // Dropping this `..` would silently open a *different* file, which is the whole risk here.
    expect(normalisePath('../T1.nii.gz')).toBe('../T1.nii.gz');
    expect(normalisePath('../../a/../b')).toBe('../../b');
    // `/..` is `/`: the root has no parent to walk into.
    expect(normalisePath('/..')).toBe('/');
  });

  it('joins a scene directory with a relative ref, and lets an absolute ref win', () => {
    expect(joinPath('/scenes', '../data/T1.nii.gz')).toBe('/data/T1.nii.gz');
    expect(joinPath('/scenes', '/elsewhere/T1.nii.gz')).toBe('/elsewhere/T1.nii.gz');
    expect(joinPath('C:\\scenes', 'data\\T1.nii.gz')).toBe('C:\\scenes\\data\\T1.nii.gz');
  });

  it('expresses a target relative to a directory', () => {
    expect(relativePath('/a/b', '/a/b/T1.nii.gz')).toBe('T1.nii.gz');
    expect(relativePath('/a/b/scenes', '/a/b/data/T1.nii.gz')).toBe('../data/T1.nii.gz');
    expect(relativePath('/a/b', '/a/b')).toBe('.');
  });

  it('refuses to relativise across roots, because `../../../..` across drives is a wrong path', () => {
    expect(relativePath('C:\\a', 'D:\\b\\T1.nii.gz')).toBe('D:\\b\\T1.nii.gz');
    expect(relativePath('/a', 'C:\\b')).toBe('C:\\b');
    expect(relativePath('relative/dir', '/a/T1.nii.gz')).toBe('/a/T1.nii.gz');
  });
});

// ------------------------------------------------------------------------------------------------

function ref(over: Partial<DatasetRef> = {}): DatasetRef {
  return {
    id: 'ds1',
    kind: 'volume',
    name: 'T1.nii.gz',
    path: 'data/T1.nii.gz',
    fingerprint: '',
    ...over,
  };
}

describe('relocationCandidates', () => {
  it('tries the relative form first, so a folder copied whole never opens the dialog', () => {
    const candidates = relocationCandidates(
      ref({ absPath: '/old/machine/data/T1.nii.gz' }),
      '/new/machine'
    );
    expect(candidates[0]).toBe('/new/machine/data/T1.nii.gz');
    expect(candidates[1]).toBe('/old/machine/data/T1.nii.gz');
    // The flattened "everything in one folder" case is the last resort.
    expect(candidates[2]).toBe('/new/machine/T1.nii.gz');
  });

  it('drops duplicates so a caller never stats the same path twice', () => {
    const candidates = relocationCandidates(ref({ path: 'T1.nii.gz' }), '/scenes');
    expect(candidates).toEqual(['/scenes/T1.nii.gz']);
  });

  it('works with no absPath at all', () => {
    expect(relocationCandidates(ref(), '/scenes')).toEqual([
      '/scenes/data/T1.nii.gz',
      '/scenes/T1.nii.gz',
    ]);
  });
});

// ------------------------------------------------------------------------------------------------

function spec(over: Partial<ViewSpec> = {}): ViewSpec {
  return {
    version: 1,
    datasets: [ref({ path: '/data/T1.nii.gz' })],
    layers: [],
    activeLayerId: null,
    slices: [],
    view3d: {} as ViewSpec['view3d'],
    layout: { kind: '2x2', cells: [] },
    cursor: [0, 0, 0],
    radiological: false,
    background: [0, 0, 0, 1],
    lighting: { ambient: 0.25, headlight: true },
    annotations: {} as ViewSpec['annotations'],
    transparency: { mode: 'twoPhase' },
    ...over,
  };
}

describe('withRelativePaths', () => {
  it('rewrites an absolute path into the §4.6 pair', () => {
    const out = withRelativePaths(spec(), '/scenes/s.tetravox.json');
    expect(out.datasets[0]?.path).toBe('../data/T1.nii.gz');
    expect(out.datasets[0]?.absPath).toBe('/data/T1.nii.gz');
  });

  it('leaves an already-relative path alone, so it is idempotent once P2-07 lands', () => {
    const relative = spec({ datasets: [ref({ path: '../data/T1.nii.gz' })] });
    expect(withRelativePaths(relative, '/scenes/s.tetravox.json')).toEqual(relative);
  });

  it('round-trips through the serialised text', () => {
    const text = serialiseScene(spec(), '/scenes/s.tetravox.json');
    const parsed = parseScene(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.spec?.datasets[0]?.path).toBe('../data/T1.nii.gz');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('parseScene', () => {
  it('refuses a version it does not know rather than guessing', () => {
    const result = parseScene(JSON.stringify({ version: 2, datasets: [], layers: [] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('version 2');
  });

  it('refuses non-JSON and non-objects with the reason', () => {
    expect(parseScene('not json').ok).toBe(false);
    expect(parseScene('42').error).toBe('not an object');
    // An array *is* an object, so it fails on the field it is missing rather than on its shape.
    expect(parseScene('[]').error).toBe('unsupported scene version undefined');
  });

  it('requires the two arrays the shell itself reads', () => {
    expect(parseScene(JSON.stringify({ version: 1, layers: [] })).error).toBe('no datasets array');
    expect(parseScene(JSON.stringify({ version: 1, datasets: [] })).error).toBe('no layers array');
  });
});

describe('defaultSceneName', () => {
  it('names the file after the first dataset, extension stripped', () => {
    expect(defaultSceneName(spec())).toBe('T1.tetravox.json');
  });

  it('falls back to `scene` for an empty scene', () => {
    expect(defaultSceneName(spec({ datasets: [] }))).toBe('scene.tetravox.json');
  });
});

// ------------------------------------------------------------------------------------------------

function specLayer(over: Record<string, unknown> = {}): ViewSpec['layers'][number] {
  return {
    id: 'ly1',
    datasetId: 'ds1',
    kind: 'volume',
    name: 'T1.nii.gz',
    visible: true,
    opacity: 1,
    ...over,
  } as unknown as ViewSpec['layers'][number];
}

function liveLayer(over: Partial<Layer> = {}): Layer {
  return {
    id: 'live1',
    datasetId: 'newDs1',
    kind: 'volume',
    name: 'T1.nii.gz',
    visible: true,
    opacity: 1,
    ...over,
  } as unknown as Layer;
}

describe('layersToRestore', () => {
  const map = new Map([['ds1', 'newDs1']]);

  it('asks for the spec layers the engine did not restore, with the remapped dataset id', () => {
    const out = layersToRestore({ specLayers: [specLayer()], liveLayers: [], datasetIdMap: map });
    expect(out).toHaveLength(1);
    expect(out[0]?.datasetId).toBe('newDs1');
    expect(out[0]?.kind).toBe('volume');
    // The stale ids are stripped: the engine mints its own, and a saved `LayerId` means nothing now.
    expect(out[0]?.patch['id']).toBeUndefined();
    expect(out[0]?.patch['datasetId']).toBeUndefined();
    expect(out[0]?.patch['name']).toBe('T1.nii.gz');
  });

  it('is a no-op once `Engine.load` restores layers itself (audit P2-07)', () => {
    expect(
      layersToRestore({ specLayers: [specLayer()], liveLayers: [liveLayer()], datasetIdMap: map })
    ).toEqual([]);
  });

  it('skips a spec layer whose dataset the user chose not to relocate', () => {
    expect(
      layersToRestore({ specLayers: [specLayer()], liveLayers: [], datasetIdMap: new Map() })
    ).toEqual([]);
  });

  it('matches counterparts one for one, so a second layer over the same dataset is still added', () => {
    const out = layersToRestore({
      specLayers: [specLayer(), specLayer({ id: 'ly2', name: 'T1.nii.gz overlay' })],
      liveLayers: [liveLayer()],
      datasetIdMap: map,
    });
    expect(out.map((a) => a.patch['name'])).toEqual(['T1.nii.gz overlay']);
  });

  it('converts `visibleLabels` back to the Uint32Array the engine indexes', () => {
    const out = layersToRestore({
      specLayers: [
        specLayer({
          visibleLabels: [1, 2, 5],
          label: { name: 'DK40', mode: 'fill', outlineWidthPx: 1, visibleLabels: [3] },
        }),
      ],
      liveLayers: [],
      datasetIdMap: map,
    });
    expect(out[0]?.patch['visibleLabels']).toBeInstanceOf(Uint32Array);
    expect([...(out[0]?.patch['visibleLabels'] as Uint32Array)]).toEqual([1, 2, 5]);
    const label = out[0]?.patch['label'] as { visibleLabels: Uint32Array };
    expect(label.visibleLabels).toBeInstanceOf(Uint32Array);
    expect([...label.visibleLabels]).toEqual([3]);
  });
});
