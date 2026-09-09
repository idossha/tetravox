import { describe, expect, it, vi } from 'vitest';
import { TetravoxEngine } from '../engine';
import type { Dataset, DatasetRef, Layer, ViewSpec } from './types';

vi.mock('../gl/context', () => ({ createContext: () => ({ gl: {}, caps: {} }) }));
vi.mock('../gl/timer', () => ({ Timer: class {} }));
vi.mock('../render/renderer', () => ({ Renderer: class {} }));
vi.mock('../render/gpu', () => ({ GpuStore: class {} }));
vi.mock('../derived/store', () => ({ DerivedStore: class {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  const engine = new TetravoxEngine({} as HTMLCanvasElement);
  const slow = deferred<Dataset>();
  const fast = deferred<Dataset>();
  vi.spyOn(engine, 'addDataset').mockImplementation((src) =>
    src.kind === 'path' && src.path === 'slow' ? slow.promise : fast.promise
  );
  vi.spyOn(engine, 'removeDataset').mockImplementation(() => {});
  vi.spyOn(engine, 'addLayer').mockImplementation((patch) => {
    const layer = { ...patch, id: `new-${patch.datasetId}` } as Layer;
    engine.scene.layers.push(layer);
    return layer;
  });
  const spec: ViewSpec = {
    ...engine.serialize(),
    datasets: ['slow', 'fast'].map((id) => ({ id, name: id, kind: 'volume' }) as DatasetRef),
    layers: ['slow', 'fast'].map(
      (id) => ({ id: `layer-${id}`, datasetId: id, kind: 'volume' }) as ViewSpec['layers'][number]
    ),
    activeLayerId: 'layer-slow',
  };
  return { engine, spec, slow, fast };
}
const dataset = (id: string) => ({ id, kind: 'volume' }) as Dataset;
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('progressive scene loading', () => {
  it('starts every load before waiting and renders a later small dataset while the first is pending', async () => {
    const { engine, spec, slow, fast } = harness();
    const done = engine.load(spec, (ref) => ref.id);
    expect(engine.addDataset).toHaveBeenCalledTimes(2);
    fast.resolve(dataset('fast-ready'));
    await tick();
    expect(engine.scene.layers.map((l) => l.id)).toEqual(['new-fast-ready']);
    const camera = { ...engine.scene.view3d.camera, distance: 777 };
    engine.setView(engine.scene.view3d.id, { camera });
    slow.resolve(dataset('slow-ready'));
    await done;
    expect(engine.scene.layers.map((l) => l.id)).toEqual(['new-slow-ready', 'new-fast-ready']);
    expect(engine.scene.view3d.camera).toEqual(camera);
    expect(engine.scene.activeLayerId).toBe('new-slow-ready');
  });
  it('keeps successful layers when another dataset fails', async () => {
    const { engine, spec, slow, fast } = harness();
    const done = engine.load(spec, (ref) => ref.id);
    const failure = expect(done).rejects.toThrow('slow: unreadable');
    fast.resolve(dataset('fast-ready'));
    slow.reject(new Error('unreadable'));
    await failure;
    expect(engine.scene.layers.map((l) => l.id)).toEqual(['new-fast-ready']);
  });
  it('does not attach late layers after cancellation', async () => {
    const { engine, spec, slow, fast } = harness();
    const abort = new AbortController();
    const done = engine.load(spec, (ref) => ref.id, abort.signal);
    const failure = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    fast.resolve(dataset('fast-ready'));
    slow.resolve(dataset('slow-ready'));
    await failure;
    expect(engine.addLayer).not.toHaveBeenCalled();
    expect(engine.removeDataset).toHaveBeenCalled();
  });
  it('reuses a retained URL even when incoming dataset IDs change and loads only the addition', async () => {
    const { engine, spec, fast } = harness();
    engine.scene.datasets.set('cached', { id: 'cached', kind: 'volume', path: 'slow' } as Dataset);
    spec.datasets[0]!.id = 'renamed-ref';
    spec.layers[0]!.datasetId = 'renamed-ref';
    const done = engine.load(spec, (ref) => (ref.id === 'renamed-ref' ? 'slow' : 'fast'));
    expect(engine.addDataset).toHaveBeenCalledTimes(1);
    expect(engine.scene.layers[0]?.datasetId).toBe('cached');
    fast.resolve(dataset('added'));
    await done;
    expect(engine.scene.layers.map((layer) => layer.datasetId)).toEqual(['cached', 'added']);
  });
  it('releases datasets absent from the next selection instead of retaining an unbounded cache', async () => {
    const { engine, spec, slow, fast } = harness();
    engine.scene.datasets.set('removed', {
      id: 'removed',
      kind: 'volume',
      path: 'obsolete',
    } as Dataset);
    const done = engine.load(spec, (ref) => ref.id);
    expect(engine.removeDataset).toHaveBeenCalledWith('removed');
    slow.resolve(dataset('slow'));
    fast.resolve(dataset('fast'));
    await done;
  });
  it('normalizes a legacy solid mesh with field:null before it becomes the first visible layer', async () => {
    const { engine, spec, slow, fast } = harness();
    spec.layers[1] = {
      ...spec.layers[1],
      kind: 'mesh',
      colorMode: 'solid',
      field: null,
    } as unknown as ViewSpec['layers'][number];
    const done = engine.load(spec, (ref) => ref.id);
    fast.resolve({ id: 'roi', kind: 'mesh' } as Dataset);
    await tick();
    expect(engine.scene.layers).toHaveLength(1);
    expect(engine.scene.layers[0]?.kind).toBe('mesh');
    expect(engine.scene.layers[0]).not.toHaveProperty('field');
    slow.resolve(dataset('anatomy'));
    await done;
    expect(engine.scene.layers).toHaveLength(2);
  });
});
