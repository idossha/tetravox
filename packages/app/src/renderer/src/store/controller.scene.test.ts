/**
 * The Phase-2 controller: scene save/load, relocate, the screenshot spec, the LUT export, the MNI
 * space and `.msh.opt` Reset — all against the stand-in engine and an **in-memory filesystem**.
 *
 * The filesystem is a `Map<string, string>` behind the same `TetravoxBridge` shape the preload
 * exposes, which buys the property that matters: `allowPath` returns null for a path that is not in
 * the map, exactly as the real one returns null for a path it cannot `realpath`. So "the scene moved
 * and its data did not" is a map with two keys instead of a directory to shuffle, and the relocate
 * path is exercised without a dialog.
 *
 * §11 rule 0 cuts the DOM way here (as it does for A-PROPS): these assert **state and calls**, never
 * pixels. The rendered dialogs are asserted in `packages/app/e2e/shell-phase2.spec.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DatasetRef, MeshLayer, ScreenshotOptions } from '@tetravox/engine';
import type { TetravoxBridge } from '../../../preload/index';
import { NoGlEngine } from '../engine/mockEngine';
import { ShellController } from './controller';
import { createUiStore } from './store';
import type { UiStore } from './store';
import type { OpenRequest } from '../open/sources';
import { parseScene } from '../lib/scene';

// ------------------------------------------------------------------------------------------------
// A filesystem that is a Map, behind the real bridge shape
// ------------------------------------------------------------------------------------------------

interface FakeFs {
  files: Map<string, string>;
  /** What the next Save dialog returns; null = the user cancelled. */
  savePath: string | null;
  /** What the next Open-scene dialog returns. */
  openScenePath: string | null;
  /** What the next relocate picker returns, consumed one per call. */
  relocations: (string | null)[];
  writes: { path: string; text: string }[];
  bridge: TetravoxBridge;
}

function fakeFs(files: Record<string, string> = {}): FakeFs {
  const fs: FakeFs = {
    files: new Map(Object.entries(files)),
    savePath: null,
    openScenePath: null,
    relocations: [],
    writes: [],
    bridge: {} as TetravoxBridge,
  };
  fs.bridge = {
    openDialog: async () => [],
    getDroppedFilePath: () => '',
    // The existence check and the allow-list are one call, as in the real bridge (§5 rule 9).
    allowPath: async (path: string) =>
      fs.files.has(path) ? { path, url: `tetravox://file/${encodeURIComponent(path)}` } : null,
    startupPaths: async () => [],
    phase0Fixture: async () => null,
    onOpened: () => () => {},
    log: () => {},
    openSceneDialog: async () =>
      fs.openScenePath === null
        ? null
        : { path: fs.openScenePath, url: `tetravox://file/${fs.openScenePath}` },
    saveSceneDialog: async () => fs.savePath,
    relocateDialog: async () => {
      const next = fs.relocations.shift() ?? null;
      return next === null ? null : { path: next, url: `tetravox://file/${next}` };
    },
    readSceneFile: async (path: string) => {
      const text = fs.files.get(path);
      return text === undefined
        ? { ok: false, error: 'not on the allow-list' }
        : { ok: true, path, text };
    },
    writeSceneFile: async (path: string, text: string) => {
      fs.writes.push({ path, text });
      fs.files.set(path, text);
      return { ok: true, path };
    },
    onSceneCommand: () => () => {},
  };
  (globalThis as { tetravox?: TetravoxBridge }).tetravox = fs.bridge;
  return fs;
}

const open: ShellController[] = [];
afterEach(() => {
  for (const controller of open.splice(0)) controller.detach();
  delete (globalThis as { tetravox?: TetravoxBridge }).tetravox;
});

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

function pathRequest(path: string, sidecars?: { opt?: string }): OpenRequest {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    name,
    path,
    source: { kind: 'path', path, ...(sidecars === undefined ? {} : { sidecars }) },
  };
}

async function settled(store: UiStore): Promise<void> {
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!store.getState().loads.some((c) => c.state === 'queued' || c.state === 'loading')) return;
  }
  throw new Error('loads never settled');
}

const T1 = '/data/m2m_ernie/T1.nii.gz';
const MESH = '/data/m2m_ernie/ernie.msh';

/** A controller with T1 + ernie open, over a filesystem that has both. */
async function loadedScene(): Promise<{
  fs: FakeFs;
  store: UiStore;
  controller: ShellController;
  engine: NoGlEngine;
}> {
  const fs = fakeFs({ [T1]: '', [MESH]: '' });
  const { store, controller, engine } = harness();
  controller.open([pathRequest(T1), pathRequest(MESH)]);
  await settled(store);
  return { fs, store, controller, engine };
}

// ------------------------------------------------------------------------------------------------

describe('scene save (§4.6, §8)', () => {
  it('writes a version-1 spec with §4.6’s relative-plus-absolute path pair', async () => {
    const { fs, controller } = await loadedScene();
    fs.savePath = '/scenes/study.tetravox.json';

    await expect(controller.saveSceneAs()).resolves.toBe(true);
    expect(fs.writes).toHaveLength(1);

    const parsed = parseScene(fs.writes[0]?.text as string);
    expect(parsed.ok).toBe(true);
    const refs = parsed.spec?.datasets ?? [];
    expect(refs.map((r) => r.name)).toEqual(['T1.nii.gz', 'ernie.msh']);
    expect(refs[0]?.path).toBe('../data/m2m_ernie/T1.nii.gz');
    expect(refs[0]?.absPath).toBe(T1);
    expect(parsed.spec?.layers).toHaveLength(2);
  });

  it('attaches the file, so a second Save writes the same path without asking', async () => {
    const { fs, store, controller } = await loadedScene();
    fs.savePath = '/scenes/study.tetravox.json';
    await controller.saveSceneAs();
    expect(store.getState().sceneFile?.name).toBe('study.tetravox.json');

    fs.savePath = null; // a cancelled dialog would abort a Save As; Save must not open one
    await expect(controller.saveScene()).resolves.toBe(true);
    expect(fs.writes).toHaveLength(2);
    expect(fs.writes[1]?.path).toBe('/scenes/study.tetravox.json');
  });

  it('reports a write failure instead of claiming success', async () => {
    const { fs, store, controller } = await loadedScene();
    fs.savePath = '/read-only/study.tetravox.json';
    fs.bridge.writeSceneFile = async () => ({ ok: false, error: 'not on the write list' });

    await expect(controller.saveSceneAs()).resolves.toBe(false);
    expect(store.getState().sceneError).toBe('not on the write list');
    expect(store.getState().toasts).toHaveLength(1);
    expect(store.getState().sceneFile).toBeNull();
  });

  it('a cancelled Save As writes nothing and is not an error', async () => {
    const { fs, store, controller } = await loadedScene();
    fs.savePath = null;
    await expect(controller.saveSceneAs()).resolves.toBe(false);
    expect(fs.writes).toHaveLength(0);
    expect(store.getState().sceneError).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------

describe('scene load (§4.6, §8, audit P2-07)', () => {
  it('restores the datasets, the layers and the cursor of a saved scene', async () => {
    const { fs, controller } = await loadedScene();
    const scenePath = '/scenes/study.tetravox.json';
    fs.savePath = scenePath;
    // Move the cursor and the layout, so the restore has something to prove.
    controller.setLayout('1x3');
    controller.jumpToCoordinate('-42 18 6');
    await controller.saveSceneAs();

    // A fresh session over the same filesystem.
    const second = harness();
    await expect(second.controller.openScenePath(scenePath)).resolves.toBe(true);

    const state = second.store.getState();
    expect(state.datasets.map((d) => d.name)).toEqual(['T1.nii.gz', 'ernie.msh']);
    // The layers are back even though `Engine.load` does not restore them (P2-07): the shell's
    // reconcile asked for the ones the engine left out, against the remapped dataset ids.
    expect(state.layers.map((l) => l.kind)).toEqual(['volume', 'mesh']);
    expect(state.layers.every((l) => state.datasets.some((d) => d.id === l.datasetId))).toBe(true);
    expect(state.cursor).toEqual([-42, 18, 6]);
    expect(state.layoutKind).toBe('1x3');
    expect(state.sceneFile?.path).toBe(scenePath);
  });

  it('resolves a dataset that moved with the scene, without a dialog', async () => {
    // The scene records `../data/m2m_ernie/T1.nii.gz` relative to `/scenes`. Copy both one level
    // down and the relative path still resolves while the absolute one does not — §4.6's whole point.
    const fs = fakeFs({ [T1]: '', [MESH]: '' });
    const first = harness();
    first.controller.open([pathRequest(T1)]);
    await settled(first.store);
    fs.savePath = '/scenes/study.tetravox.json';
    await first.controller.saveSceneAs();
    const text = fs.writes[0]?.text as string;

    // Now: the original data is gone, and everything lives under /moved.
    fakeFs({
      '/moved/scenes/study.tetravox.json': text,
      '/moved/data/m2m_ernie/T1.nii.gz': '',
    });
    const second = harness();
    await expect(
      second.controller.openScenePath('/moved/scenes/study.tetravox.json')
    ).resolves.toBe(true);
    expect(second.store.getState().datasets[0]?.path).toBe('/moved/data/m2m_ernie/T1.nii.gz');
    expect(second.store.getState().dialog).toBe('none');
  });

  it('raises the relocate dialog for what no candidate found, and applies the answer', async () => {
    const fs = fakeFs({ [T1]: '' });
    const first = harness();
    first.controller.open([pathRequest(T1)]);
    await settled(first.store);
    fs.savePath = '/scenes/study.tetravox.json';
    await first.controller.saveSceneAs();
    const text = fs.writes[0]?.text as string;

    // The scene survives; the volume does not.
    const orphan = fakeFs({
      '/scenes/study.tetravox.json': text,
      '/elsewhere/T1.nii.gz': '',
    });
    const second = harness();
    await expect(second.controller.openScenePath('/scenes/study.tetravox.json')).resolves.toBe(
      false
    );

    const request = second.store.getState().relocate;
    expect(second.store.getState().dialog).toBe('relocate');
    expect(request?.missing).toHaveLength(1);
    expect(request?.missing[0]?.ref.name).toBe('T1.nii.gz');
    // The dialog is told what was looked for, in order and de-duplicated — the relative form
    // resolves to the same place the absolute fallback does here, so it is tried once, not twice.
    expect(request?.missing[0]?.tried).toEqual(['/data/m2m_ernie/T1.nii.gz', '/scenes/T1.nii.gz']);

    orphan.relocations = ['/elsewhere/T1.nii.gz'];
    const ref = request?.missing[0]?.ref as DatasetRef;
    const picked = await second.controller.pickRelocation(ref);
    expect(picked).toBe('/elsewhere/T1.nii.gz');

    await expect(second.controller.resolveRelocate([picked])).resolves.toBe(true);
    expect(second.store.getState().datasets[0]?.path).toBe('/elsewhere/T1.nii.gz');
    expect(second.store.getState().layers).toHaveLength(1);
    expect(second.store.getState().dialog).toBe('none');
  });

  it('opening without the missing dataset leaves a scene with no layer for it', async () => {
    const fs = fakeFs({ [T1]: '' });
    const first = harness();
    first.controller.open([pathRequest(T1)]);
    await settled(first.store);
    fs.savePath = '/scenes/study.tetravox.json';
    await first.controller.saveSceneAs();

    fakeFs({ '/scenes/study.tetravox.json': fs.writes[0]?.text as string });
    const second = harness();
    await second.controller.openScenePath('/scenes/study.tetravox.json');
    await expect(second.controller.resolveRelocate([null])).resolves.toBe(true);
    expect(second.store.getState().datasets).toHaveLength(0);
    expect(second.store.getState().layers).toHaveLength(0);
  });

  it('refuses a file that is not a scene, with the reason', async () => {
    fakeFs({ '/scenes/notes.txt': 'hello' });
    const { store, controller } = harness();
    await expect(controller.openScenePath('/scenes/notes.txt')).resolves.toBe(false);
    expect(store.getState().sceneError).toContain('JSON');
    expect(store.getState().toasts[0]?.title).toContain('Could not parse');
  });

  it('refuses a scene from a future version rather than restoring the wrong thing', async () => {
    fakeFs({
      '/scenes/next.tetravox.json': JSON.stringify({ version: 2, datasets: [], layers: [] }),
    });
    const { store, controller } = harness();
    await expect(controller.openScenePath('/scenes/next.tetravox.json')).resolves.toBe(false);
    expect(store.getState().sceneError).toContain('version 2');
  });

  it('reports a file it cannot read', async () => {
    fakeFs();
    const { store, controller } = harness();
    await expect(controller.openScenePath('/nope.tetravox.json')).resolves.toBe(false);
    expect(store.getState().sceneError).toBe('not on the allow-list');
  });
});

describe('New scene', () => {
  it('closes every dataset — §5 rule 1, the only way the wasm heap comes back', async () => {
    const { store, controller, engine } = await loadedScene();
    expect(store.getState().datasets).toHaveLength(2);
    const ids = store.getState().datasets.map((d) => d.id);

    controller.newScene();
    expect(store.getState().datasets).toHaveLength(0);
    expect(store.getState().layers).toHaveLength(0);
    expect(store.getState().loads).toHaveLength(0);
    expect(store.getState().sceneFile).toBeNull();
    // A dataset is not closed until its worker is terminated; the stand-in records the call.
    for (const id of ids) expect(engine.terminations).toContain(id);
  });
});

// ------------------------------------------------------------------------------------------------

describe('the screenshot spec (§4.7, audit P2-06)', () => {
  it('reads the DPI back out of the PNG’s own pHYs chunk (§11)', async () => {
    fakeFs();
    const { store, controller } = harness();
    const options: ScreenshotOptions = {
      ...controller.snapshotOptions(),
      width: 40,
      height: 30,
      dpi: 300,
    };
    await expect(controller.saveScreenshot(options)).resolves.toBe(true);

    const record = store.getState().lastScreenshot;
    expect(record?.isPng).toBe(true);
    expect(record?.width).toBe(40);
    expect(record?.height).toBe(30);
    // Parsed, not assumed: this is the assertion §11 asks for on the screenshot path.
    expect(record?.dpi).toBe(300);
    expect(record?.requestedDpi).toBe(300);
  });

  it('remembers the edited options, so the toolbar button shoots what the dialog last set', async () => {
    fakeFs();
    const { controller } = harness();
    const options: ScreenshotOptions = {
      target: 'view',
      viewId: 'axial',
      width: 64,
      height: 64,
      dpi: 72,
      background: 'white',
      include: {
        colorbar: false,
        orientationLabels: false,
        crosshair: false,
        cornerInfo: false,
        scaleBar: true,
      },
      autoTrim: true,
    };
    controller.setScreenshotOptions(options);
    expect(controller.snapshotOptions()).toEqual(options);
    await controller.screenshot();
    expect(controller.snapshotOptions()).toEqual(options);
  });

  it('closes the dialog when it saves, so a Save is never ambiguous about having happened', async () => {
    fakeFs();
    const { store, controller } = harness();
    controller.openDialogKind('screenshot');
    expect(store.getState().dialog).toBe('screenshot');
    await controller.saveScreenshot(controller.snapshotOptions());
    expect(store.getState().dialog).toBe('none');
  });

  it('offers every view to the `target: view` selector', () => {
    fakeFs();
    const { controller } = harness();
    expect(controller.viewIds()).toEqual(['sagittal', 'coronal', 'axial', 'view3d']);
  });
});

// ------------------------------------------------------------------------------------------------

describe('the MNI column (audit P2-10)', () => {
  it('is absent when no volume carries a toTemplate — the common case on subject data', async () => {
    const { controller } = await loadedScene();
    expect(controller.templateSource()).toBeNull();
    controller.setCoordSpace('mni');
    // Nothing to convert with, so the field falls back to world rather than showing a wrong number.
    expect(controller.coordText()).toBe('0.0 0.0 0.0');
    expect(controller.jumpToCoordinate('10 10 10')).toBe(false);
  });

  it('converts both ways when a volume carries one', async () => {
    fakeFs({ [T1]: '' });
    const { store, controller } = harness({ toTemplate: true });
    controller.open([pathRequest(T1)]);
    await settled(store);

    expect(controller.templateSource()?.toTemplate.name).toBe('MNI152');
    controller.setCoordSpace('ras');
    controller.jumpToCoordinate('-42 18 6');
    controller.setCoordSpace('mni');
    // The stand-in's transform is a 12 mm anterior shift.
    expect(controller.coordText()).toBe('-42.0 30.0 6.0');

    expect(controller.jumpToCoordinate('0 42 0')).toBe(true);
    expect(store.getState().cursor).toEqual([0, 30, 0]);
  });
});

// ------------------------------------------------------------------------------------------------

describe('the `.msh.opt` Reset (§7.6)', () => {
  it('does nothing for a mesh that had no sidecar', async () => {
    const { store, controller } = await loadedScene();
    const mesh = store.getState().layers.find((l) => l.kind === 'mesh');
    expect(controller.resetMeshOptDefaults(mesh?.id as string)).toBe(false);
  });

  it('re-seeds tag colours, visibility and the field range from `MeshDataset.opt`', async () => {
    fakeFs({ [MESH]: '', [`${MESH}.opt`]: '' });
    const { store, controller } = harness();
    controller.open([pathRequest(MESH, { opt: `${MESH}.opt` })]);
    await settled(store);

    const layerId = store.getState().layers[0]?.id as string;
    // Edit away from the defaults, the way the tissue table will.
    controller.setOpacity(layerId, 0.3);
    expect(controller.resetMeshOptDefaults(layerId)).toBe(true);

    const layer = store.getState().layers[0];
    if (layer?.kind !== 'mesh') throw new Error('expected a mesh layer');
    const dataset = store.getState().datasets[0];
    if (dataset?.kind !== 'mesh') throw new Error('expected a mesh dataset');

    // Every tag has a style, tag 3 is the hidden one the sidecar names, and the colours are the
    // sidecar's 0..1 values copied through — no second /255 (§4.1).
    expect(Object.keys(layer.tagStyle)).toHaveLength(dataset.tags.length);
    expect(layer.tagStyle[3]?.visible).toBe(false);
    expect(layer.tagStyle[1]?.visible).toBe(true);
    expect(layer.tagStyle[1]?.color).toEqual(dataset.opt?.tagColor[1]);
    expect(layer.scale).toEqual({ kind: 'linear', lo: 0, hi: 0.5 });
    expect(layer.showColorbar).toBe(true);
    // Reset is about the sidecar's defaults, not about undoing every edit.
    expect(layer.opacity).toBe(0.3);
  });
});

// ------------------------------------------------------------------------------------------------

describe('Save LUT… (R5)', () => {
  it('exports a label volume’s table', async () => {
    const fs = fakeFs({ '/data/final_tissues.nii.gz': '' });
    const { store, controller } = harness();
    controller.open([pathRequest('/data/final_tissues.nii.gz')]);
    await settled(store);

    const layerId = store.getState().layers[0]?.id as string;
    expect(controller.lutEntriesFor(layerId)).not.toBeNull();

    fs.savePath = '/out/final_tissues_LUT.txt';
    await expect(controller.saveLut(layerId)).resolves.toBe(true);
    const text = fs.writes[0]?.text as string;
    expect(text.split('\n')[0]).toBe('#No.\tLabel Name:\tR\tG\tB\tA');
    // The stand-in's label table has ids 0,1,2,3,5,10 — sparse on purpose (§4.2).
    expect(text).toContain('\n5\tScalp\t');
    expect(text).toContain('\n10\tMuscle\t');
  });

  it('exports a mesh’s tissue tags, with the edited colour rather than the default', async () => {
    const fs = fakeFs({ [MESH]: '' });
    const { engine, store, controller } = harness();
    controller.open([pathRequest(MESH)]);
    await settled(store);

    const layerId = store.getState().layers[0]?.id as string;
    // The edit R5's colour picker makes is `tagStyle[id].color`, through `Engine.updateLayer` — the
    // same §4.7 call A-PROPS's swatch will issue. The export reads it back from the layer.
    engine.updateLayer<MeshLayer>(layerId, {
      tagStyle: { 2: { visible: true, opacity: 1, color: [1, 0, 0, 1] } },
    });

    const entries = controller.lutEntriesFor(layerId);
    expect(entries?.find((e) => e.id === 2)?.color).toEqual([1, 0, 0, 1]);

    fs.savePath = '/out/ernie_LUT.txt';
    await expect(controller.saveLut(layerId, 'freesurfer')).resolves.toBe(true);
    expect(fs.writes[0]?.text).toContain('255   0   0 255');
  });

  it('refuses a layer with no label table, and says why', async () => {
    fakeFs({ [T1]: '' });
    const { store, controller } = harness();
    controller.open([pathRequest(T1)]);
    await settled(store);
    const layerId = store.getState().layers[0]?.id as string;
    expect(controller.lutEntriesFor(layerId)).toBeNull();
    await expect(controller.saveLut(layerId)).resolves.toBe(false);
    expect(store.getState().sceneError).toContain('no label table');
  });
});

// ------------------------------------------------------------------------------------------------

describe('the dialog switch', () => {
  it('is one at a time, and the File-menu commands route to the right one', async () => {
    const { fs, store, controller } = await loadedScene();
    controller.openDialogKind('keyboard');
    expect(store.getState().dialog).toBe('keyboard');
    controller.toggleKeyboardHelp();
    expect(store.getState().dialog).toBe('none');
    controller.openDialogKind('screenshot');
    controller.closeDialog();
    expect(store.getState().dialog).toBe('none');

    fs.savePath = '/scenes/menu.tetravox.json';
    await controller.runSceneCommand('saveAs');
    expect(fs.writes).toHaveLength(1);
    await controller.runSceneCommand('new');
    expect(store.getState().datasets).toHaveLength(0);
  });
});
