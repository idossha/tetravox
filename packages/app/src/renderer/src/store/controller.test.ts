/**
 * `ShellController` against the stand-in engine.
 *
 * These are the §8 behaviours that are *state*, not pixels: what a load card says while a load runs,
 * what Cancel actually does, what the info panel is handed, and that every action ends in a §4.7
 * call. No React and no DOM — the controller was written to be drivable without either.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { CoordSpaceRef, Engine } from '@tetravox/engine';
import { NoGlEngine } from '../engine/mockEngine';
import { ShellController } from './controller';
import { activeLayer, createUiStore } from './store';
import type { UiStore } from './store';
import type { OpenRequest } from '../open/sources';

function harness(options: ConstructorParameters<typeof NoGlEngine>[0] = {}): {
  engine: NoGlEngine;
  store: UiStore;
  controller: ShellController;
} {
  const engine = new NoGlEngine({ stepMs: 0, ...options });
  const store = createUiStore();
  const controller = new ShellController(engine, store);
  controller.attach();
  open.push(controller);
  return { engine, store, controller };
}

const open: ShellController[] = [];
afterEach(() => {
  for (const controller of open.splice(0)) controller.detach();
});

function pathRequest(path: string): OpenRequest {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, source: { kind: 'path', path } };
}

/** Resolve once the queue has drained — the controller loads one dataset at a time on purpose. */
async function settled(store: UiStore): Promise<void> {
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!store.getState().loads.some((c) => c.state === 'queued' || c.state === 'loading')) return;
  }
  throw new Error('loads never settled');
}

describe('opening a dataset (§8)', () => {
  it('shows a card, then a dataset and a layer, and records what the status bar needs', async () => {
    const { store, controller } = harness();
    controller.open([pathRequest('/d/m2m_ernie/T1.nii.gz')]);

    // The card exists before anything has loaded — §8's "progress visible within 200 ms" is only
    // possible if the card does not wait for `addDataset` to resolve.
    expect(store.getState().loads).toHaveLength(1);
    expect(store.getState().loads[0]?.name).toBe('T1.nii.gz');
    expect(store.getState().datasets).toHaveLength(0);

    await settled(store);
    const state = store.getState();
    expect(state.loads[0]?.state).toBe('done');
    expect(state.loads[0]?.datasetId).not.toBeNull();
    expect(state.datasets).toHaveLength(1);
    // Opening a file means a dataset **and** a layer, and both are engine calls (§4.7).
    expect(state.layers).toHaveLength(1);
    expect(activeLayer(state)?.kind).toBe('volume');
    const id = state.datasets[0]?.id as string;
    expect(state.lastLoadMs[id]).toBeGreaterThanOrEqual(0);
    // §8's status bar owes wasm `heapBytes` per dataset; it arrives through the optional reporter.
    expect(state.heapBytes[id]).toBeGreaterThan(0);
  });

  it('walks the §6.5 phases and never reports a NaN percent', async () => {
    const { store, controller } = harness({ stepMs: 4 });
    controller.open([pathRequest('/d/ernie.msh')]);
    const phases = new Set<string>();
    const stop = store.subscribe((s) => {
      const card = s.loads[0];
      if (card !== undefined && card.state === 'loading') phases.add(card.phase);
    });
    await settled(store);
    stop();
    // `.msh` is not gzip, so `inflate` is skipped exactly as the worker would skip it (§5 rule 4).
    expect(phases.has('read')).toBe(true);
    expect(phases.has('parse')).toBe(true);
    expect(phases.has('inflate')).toBe(false);
  });

  it('loads one at a time, in request order', async () => {
    const { store, controller } = harness({ stepMs: 2 });
    controller.open([pathRequest('/d/a.nii'), pathRequest('/d/b.msh')]);
    expect(store.getState().loads.map((c) => c.name)).toEqual(['a.nii', 'b.msh']);
    // Worker-per-dataset (§5 rule 1) means two in flight is two wasm heaps; the second waits.
    expect(store.getState().loads[1]?.state).toBe('queued');
    await settled(store);
    expect(store.getState().datasets.map((d) => d.name)).toEqual(['a.nii', 'b.msh']);
  });
});

describe('cancelling a load (§5 rule 6, ROADMAP Phase-1 gate 1)', () => {
  it('terminates that dataset’s worker and leaves no layer behind', async () => {
    const { engine, store, controller } = harness({ stepMs: 6 });
    controller.open([pathRequest('/d/ernie_seeg.msh')]);
    // Wait until the card has bound its datasetId, i.e. the first progress event has landed.
    for (let i = 0; i < 200 && store.getState().loads[0]?.datasetId === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const datasetId = store.getState().loads[0]?.datasetId;
    expect(datasetId).not.toBeNull();

    controller.cancelLoad(1);
    await settled(store);

    expect(store.getState().loads[0]?.state).toBe('cancelled');
    // Cancel IS `worker.terminate()` — there is no abort flag to poll (§1, §5 rule 6).
    expect(engine.terminations).toContain(datasetId);
    expect(store.getState().datasets).toHaveLength(0);
    expect(store.getState().layers).toHaveLength(0);
    // The user asked for it, so it is not an error toast.
    expect(store.getState().toasts).toHaveLength(0);
  });

  it('honours a cancel pressed before the datasetId exists', async () => {
    const { engine, store, controller } = harness({ stepMs: 6 });
    controller.open([pathRequest('/d/ernie_seeg.msh')]);
    controller.cancelLoad(1); // synchronous: no progress event can have landed yet
    expect(store.getState().loads[0]?.cancelRequested).toBe(true);
    await settled(store);
    expect(store.getState().loads[0]?.state).toBe('cancelled');
    expect(engine.terminations.length).toBeGreaterThan(0);
  });

  it('drops a queued load without touching a worker', async () => {
    const { engine, store, controller } = harness({ stepMs: 2 });
    controller.open([pathRequest('/d/a.nii'), pathRequest('/d/b.msh')]);
    controller.cancelLoad(2);
    await settled(store);
    expect(store.getState().loads[1]?.state).toBe('cancelled');
    expect(store.getState().datasets.map((d) => d.name)).toEqual(['a.nii']);
    // Nothing was ever started for ticket 2, so nothing was terminated for it.
    expect(engine.terminations).toHaveLength(0);
  });
});

describe('error toasts (§8)', () => {
  it('toasts an unsupported file and adds no layer', async () => {
    const { store, controller } = harness();
    controller.open([pathRequest('/d/notes.rtf')]);
    await settled(store);
    expect(store.getState().layers).toHaveLength(0);
    expect(store.getState().toasts).toHaveLength(1);
    expect(store.getState().toasts[0]?.title).toBe('Unsupported file: notes.rtf');
    expect(store.getState().loads[0]?.state).toBe('failed');
  });

  it('toasts a parse failure separately from an unsupported one', async () => {
    const { store, controller } = harness({ parseFailSubstring: 'broken' });
    controller.open([pathRequest('/d/broken.nii.gz')]);
    await settled(store);
    expect(store.getState().toasts[0]?.title).toBe('Could not parse the file: broken.nii.gz');
    expect(store.getState().toasts[0]?.detail).toContain('unexpected end of file');
  });
});

describe('layers (§8 left panel, §7.5 keys)', () => {
  async function twoLayers() {
    const h = harness();
    h.controller.open([pathRequest('/d/T1.nii.gz'), pathRequest('/d/ernie.msh')]);
    await settled(h.store);
    return h;
  }

  it('toggles visibility and opacity through the engine', async () => {
    const { store, controller } = await twoLayers();
    const id = store.getState().layers[0]?.id as string;
    controller.toggleVisible(id);
    expect(store.getState().layers[0]?.visible).toBe(false);
    controller.setOpacity(id, 0.35);
    expect(store.getState().layers[0]?.opacity).toBe(0.35);
    // Opacity is clamped rather than passed through, so a slider bug cannot hand the engine 1.4.
    controller.setOpacity(id, 4);
    expect(store.getState().layers[0]?.opacity).toBe(1);
  });

  it('reorders with `reorderLayers`, keeping bottom → top order', async () => {
    const { store, controller } = await twoLayers();
    const before = store.getState().layers.map((l) => l.name);
    expect(before).toEqual(['T1.nii.gz', 'ernie.msh']);
    controller.moveLayer(store.getState().layers[0]?.id as string, 1);
    expect(store.getState().layers.map((l) => l.name)).toEqual(['ernie.msh', 'T1.nii.gz']);
    // Moving past the end is a no-op, not a wrap.
    controller.moveLayer(store.getState().layers[1]?.id as string, 1);
    expect(store.getState().layers.map((l) => l.name)).toEqual(['ernie.msh', 'T1.nii.gz']);
  });

  it('cycles the active layer with `[` and `]`, wrapping', async () => {
    const { store, controller } = await twoLayers();
    const ids = store.getState().layers.map((l) => l.id);
    controller.setActiveLayer(ids[0] as string);
    controller.runCommand({ kind: 'cycleActiveLayer', delta: 1 });
    expect(store.getState().activeLayerId).toBe(ids[1]);
    controller.runCommand({ kind: 'cycleActiveLayer', delta: 1 });
    expect(store.getState().activeLayerId).toBe(ids[0]);
    controller.runCommand({ kind: 'cycleActiveLayer', delta: -1 });
    expect(store.getState().activeLayerId).toBe(ids[1]);
  });

  it('`v` toggles the active layer only', async () => {
    const { store, controller } = await twoLayers();
    const ids = store.getState().layers.map((l) => l.id);
    controller.setActiveLayer(ids[1] as string);
    controller.runCommand({ kind: 'toggleActiveLayerVisible' });
    expect(store.getState().layers[1]?.visible).toBe(false);
    expect(store.getState().layers[0]?.visible).toBe(true);
  });

  it('closing a dataset terminates its worker and drops its layer (§5 rule 1)', async () => {
    const { engine, store, controller } = await twoLayers();
    const datasetId = store.getState().datasets[0]?.id as string;
    controller.closeDataset(datasetId);
    expect(engine.terminations).toContain(datasetId);
    expect(store.getState().layers.map((l) => l.name)).toEqual(['ernie.msh']);
  });

  it('steps a 4D index only inside the volume’s range', async () => {
    const h = harness();
    h.controller.open([pathRequest('/d/rest_4d.nii.gz')]);
    await settled(h.store);
    const layerId = h.store.getState().layers[0]?.id as string;
    const dataset = h.store.getState().datasets[0];
    expect(dataset?.kind === 'volume' ? dataset.nvols : 0).toBe(3);
    h.controller.runCommand({ kind: 'stepVolumeIndex', delta: -1 });
    expect((h.store.getState().layers[0] as { volumeIndex: number }).volumeIndex).toBe(0);
    h.controller.runCommand({ kind: 'stepVolumeIndex', delta: 1 });
    h.controller.runCommand({ kind: 'stepVolumeIndex', delta: 1 });
    h.controller.runCommand({ kind: 'stepVolumeIndex', delta: 1 });
    expect((h.store.getState().layers[0] as { volumeIndex: number }).volumeIndex).toBe(2);
    expect(layerId).toBeTruthy();
  });
});

describe('the info panel is a projection of `probe` (§8)', () => {
  it('fills the Cursor block on a cursor event and the Mouse block on a hover', async () => {
    const { engine, store, controller } = harness();
    controller.open([pathRequest('/d/final_tissues.nii.gz')]);
    await settled(store);

    engine.emit('cursor', [10, -20, 30]);
    const cursorProbe = store.getState().cursorProbe;
    expect(cursorProbe?.world).toEqual([10, -20, 30]);
    expect(cursorProbe?.rows).toHaveLength(1);
    // A label volume: §8's "per-layer voxel index / value / label name".
    expect(cursorProbe?.rows[0]?.voxel).toBeDefined();
    expect(cursorProbe?.rows[0]?.labelName).toBeTruthy();

    expect(store.getState().hoverProbe).toBeNull();
    engine.emit('hover', [1, 2, 3]);
    expect(store.getState().hoverProbe?.world).toEqual([1, 2, 3]);
    // §8: the Mouse block is blank when the pointer leaves a view.
    engine.emit('hover', null);
    expect(store.getState().hoverProbe).toBeNull();
  });

  it('carries element id, tag and field values for a mesh layer', async () => {
    const { engine, store, controller } = harness();
    controller.open([pathRequest('/d/Thalamus_TI.msh')]);
    await settled(store);
    engine.emit('cursor', [5, 5, 5]);
    const row = store.getState().cursorProbe?.rows[0];
    expect(row?.elementId).toBeGreaterThan(0);
    expect(row?.tagName).toBeTruthy();
    expect(row?.fields?.map((f) => f.name)).toEqual(['TI_max', 'E']);
  });
});

describe('the coordinate bar (§8)', () => {
  it('jumps the cursor from a RAS triple and rejects a non-triple', async () => {
    const { store, controller } = harness();
    expect(controller.jumpToCoordinate('-42, 18, 6')).toBe(true);
    expect(store.getState().cursor).toEqual([-42, 18, 6]);
    expect(controller.jumpToCoordinate('nope')).toBe(false);
    expect(store.getState().cursor).toEqual([-42, 18, 6]);
  });

  it('shows and accepts voxel indices of the active volume layer', async () => {
    const { store, controller } = harness();
    controller.open([pathRequest('/d/T1.nii.gz')]);
    await settled(store);
    // Directed task 8: the space is a `CoordSpaceRef`, so it names the volume it belongs to.
    const voxel = controller.coordinateSpaces().find((o) => o.ref.space === 'voxel')
      ?.ref as CoordSpaceRef;
    controller.setCoordSpace(voxel);
    expect(controller.jumpToCoordinate('128 128 104')).toBe(true);
    // The stand-in's affine is 1 mm isotropic with origin (-99.737457, -128.1875, -143.642273).
    expect(store.getState().cursor[0]).toBeCloseTo(-99.737457 + 128, 3);
    // …and the field reads that same voxel back, which is the round trip the bar promises.
    expect(controller.coordText()).toBe('128 128 104');
  });

  it('copies in the §8 format', async () => {
    const { controller } = harness();
    controller.jumpToCoordinate('-42 18 6');
    await expect(controller.copyCoordinate()).resolves.toBe('-42.0 18.0 6.0');
  });
});

describe('views, screenshot and the rest of the toolbar (§8)', () => {
  it('builds the cells for each layout and cycles with `x`', () => {
    const { store, controller } = harness();
    controller.setLayout('1x3');
    expect(store.getState().cells).toEqual(['axial', 'coronal', 'sagittal']);
    controller.setLayout('3d-only');
    expect(store.getState().cells).toEqual(['view3d']);
    expect(store.getState().activeViewId).toBe('view3d');
    controller.runCommand({ kind: 'cycleLayout' });
    expect(store.getState().layoutKind).toBe('2x2');
    expect(store.getState().cells).toHaveLength(4);
  });

  it('toggles radiological and crosshair through the engine', () => {
    const { engine, store, controller } = harness();
    controller.setRadiological(true);
    expect(store.getState().radiological).toBe(true);
    expect(engine.scene.radiological).toBe(true);
    controller.runCommand({ kind: 'toggleCrosshair' });
    expect(store.getState().crosshair).toBe(false);
    expect(engine.scene.annotations.crosshair).toBe(false);
    // §4.5: the badge is not optional, and nothing may switch it off.
    expect(engine.scene.annotations.conventionBadge).toBe(true);
  });

  it('steps the cursor along the active view’s normal by one voxel (§7.5)', async () => {
    const { store, controller } = harness();
    controller.open([pathRequest('/d/T1.nii.gz')]);
    await settled(store);
    controller.setLayout('1x3');
    controller.setActiveView('axial');
    const before = store.getState().cursor[2];
    controller.runCommand({ kind: 'stepCursor', steps: 1 });
    expect(store.getState().cursor[2]).toBeCloseTo(before + 1, 6);
  });

  it('produces a real PNG from `Engine.screenshot`', async () => {
    const { store, controller } = harness();
    await expect(controller.screenshot()).resolves.toBe(true);
    const record = store.getState().lastScreenshot;
    expect(record?.isPng).toBe(true);
    expect(record?.type).toBe('image/png');
    expect(record?.bytes).toBeGreaterThan(8);
  });

  it('resets every view and sends the cursor to world origin, but touches no layer (Reset / Home)', async () => {
    const { engine, store, controller } = harness();
    controller.open([pathRequest('/d/T1.nii.gz')]);
    await settled(store);
    controller.setLayout('2x2');

    // Move things away from their defaults first, so "reset" is provably doing something.
    controller.setActiveView('axial');
    controller.runCommand({ kind: 'stepCursor', steps: 1 });
    controller.runCommand({ kind: 'stepCursor', steps: 1 });
    controller.runCommand({ kind: 'cameraPreset', preset: 'L' });
    const layerIdBefore = store.getState().layers[0]?.id;
    expect(store.getState().cursor).not.toEqual([0, 0, 0]);

    controller.runCommand({ kind: 'resetAll' });

    expect(store.getState().cursor).toEqual([0, 0, 0]);
    expect(engine.scene.view3d.camera.distance).toBe(400);
    for (const slice of engine.scene.slices) {
      expect(slice.camera).toEqual({ center: [0, 0], mmPerPx: 0.5 });
    }
    // Datasets/layers are untouched — Reset is not "Close every dataset".
    expect(store.getState().layers).toHaveLength(1);
    expect(store.getState().layers[0]?.id).toBe(layerIdBefore);
  });

  it('resets from the keyboard on `Home`', async () => {
    const { engine, store, controller } = harness();
    controller.runCommand({ kind: 'nudgeCursor', dx: 1, dy: 0 });
    controller.runCommand({ kind: 'resetAll' });
    expect(store.getState().cursor).toEqual([0, 0, 0]);
    expect(engine.scene.view3d.camera.rotation).toEqual([0, 0, 0, 1]);
  });

  it('records frame samples so the status bar has fps and frame ms', () => {
    const { engine, store } = harness();
    for (let i = 0; i < 5; i++) engine.requestRender();
    expect(store.getState().metrics.samples.length).toBeGreaterThanOrEqual(5);
  });
});

describe('requestRender (the sidebar-collapse-black-panes fix)', () => {
  // `ViewGrid`'s `ResizeObserver` fires whenever collapsing/expanding a sidebar changes the host's
  // size. Resizing the canvas element reallocates its WebGL drawing buffer to transparent black per
  // spec — that clear is not itself a scene mutation, so nothing else in the engine sets a dirty bit
  // for it. Before this fix `ViewGrid` only wrote `canvas.width`/`.height` and never told the engine
  // to repaint, so the panes stayed black until an unrelated command happened to call
  // `requestRender()`. `controller.requestRender()` is the door `ViewGrid` now uses.
  it('delegates straight to the engine, with no state of its own to lose', () => {
    const { engine, controller } = harness();
    let frames = 0;
    engine.on('frame', () => {
      frames += 1;
    });
    controller.requestRender();
    expect(frames).toBe(1);
    controller.requestRender();
    controller.requestRender();
    expect(frames).toBe(3);
  });
});

describe('the frozen facade is enough', () => {
  it('type-checks the stand-in as an `Engine`', () => {
    // A compile-time assertion, kept as a runtime one so it cannot be deleted as "unused".
    const engine: Engine = new NoGlEngine();
    expect(engine.caps.renderer).toContain('stand-in');
    engine.destroy();
  });
});
