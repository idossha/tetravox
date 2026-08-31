/**
 * The module host, against the stand-in engine and a `Map` for a filesystem (§13.4).
 *
 * The `panels.test.ts` idiom — `NoGlEngine` + `createUiStore` + `ShellController.attach()` — because
 * everything under test is **state and calls**, never pixels: what the store holds after a module
 * activates, what a command does to the title, what a scene file carries, what the guard asks. The
 * rendered slot, switcher, status cell and confirm dialog are asserted in
 * `packages/app/e2e/modules.spec.ts`, where there is a DOM.
 *
 * The fixture module is the subject throughout, driven through `?modules=hello` exactly as the E2E
 * drives it, so the thing tested here is the thing that ships.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { TetravoxBridge } from '../../../preload/index';
import { NoGlEngine } from '../engine/mockEngine';
import { ShellController } from '../store/controller';
import { anyModuleDirty, createUiStore, dirtyModuleIds } from '../store/store';
import type { UiStore } from '../store/store';
import { parseScene, sceneExtensions } from '../lib/scene';
import type { Dataset, PointToolEvent } from '@tetravox/engine';
import type { ModuleHost } from './host';
import { ModuleHostError } from './host';
import { blockBytes, createHistory, createModuleHost, MAX_BLOCK_BYTES } from './hostImpl';
import { readerClaim } from './readers';
import { setInstalledModules } from './registry';
import { helloManifest } from '../../../modules/hello/manifest';
import type { ModuleManifest } from '../../../modules/manifest-types';

const HELLO = 'tetravox.hello';

// ------------------------------------------------------------------------------------------------
// A filesystem that is a Map, behind the real bridge shape (`controller.scene.test.ts`'s idiom)
// ------------------------------------------------------------------------------------------------

interface FakeFs {
  files: Map<string, string>;
  savePath: string | null;
  writes: { path: string; text: string }[];
}

function fakeBridge(files: Record<string, string> = {}): FakeFs {
  const fs: FakeFs = { files: new Map(Object.entries(files)), savePath: null, writes: [] };
  const settings = {
    theme: 'system' as const,
    freesurferSubjectsDir: '',
    recentScenes: [],
    reopenLastScene: false,
    screenshotDefaults: { background: 'scene' as const, dpi: 144, autoTrim: false },
  };
  const bridge = {
    settings: async () => settings,
    setSettings: async () => settings,
    allowPath: async (path: string) =>
      fs.files.has(path) ? { path, url: `tetravox://file/${encodeURIComponent(path)}` } : null,
    readSceneFile: async (path: string) => {
      const text = fs.files.get(path);
      return text === undefined
        ? { ok: false as const, error: 'not on the allow-list' }
        : { ok: true as const, path, text };
    },
    writeSceneFile: async (path: string, text: string) => {
      fs.writes.push({ path, text });
      fs.files.set(path, text);
      return { ok: true as const, path };
    },
    saveSceneDialog: async () => fs.savePath,
    rememberScene: async () => null,
    configPath: async () => '/tvx-test/tetravoxrc',
    revealConfigFile: async () => {},
    startupPaths: async () => [],
    startupScene: async () => null,
    subjectSpaces: async () => null,
    surfaceSpaces: async () => null,
    // §5 rule 12's flag. A real member with a real handler now, so `syncDocumentEdited` calls it
    // outright — a fake bridge that omits it is a fake bridge the controller throws against.
    setDocumentEdited: () => {},
    log: () => {},
  } as unknown as TetravoxBridge;
  (globalThis as { tetravox?: TetravoxBridge }).tetravox = bridge;
  return fs;
}

const open: ShellController[] = [];
afterEach(() => {
  for (const controller of open.splice(0)) controller.detach();
  delete (globalThis as { tetravox?: TetravoxBridge }).tetravox;
});

function harness(search = '?modules=hello'): {
  engine: NoGlEngine;
  store: UiStore;
  controller: ShellController;
} {
  const engine = new NoGlEngine({ stepMs: 0 });
  const store = createUiStore();
  const controller = new ShellController(engine, store);
  controller.setModuleSearch(search);
  controller.attach();
  open.push(controller);
  return { engine, store, controller };
}

// ------------------------------------------------------------------------------------------------

describe('the registry gate', () => {
  it('offers a fixture only when the launch query names it', () => {
    // Asked by id rather than by count, because product modules are in this list too from
    // 2026-08-30 (`tetravox.seeg`) and a count would say "the fixture is hidden" by accident.
    const ids = (search: string): string[] =>
      harness(search)
        .controller.modules()
        .map((m) => m.manifest.id);
    expect(ids('')).not.toContain(HELLO);
    expect(ids('?modules=hello')).toContain(HELLO);
    // The full id and `all` work too, so a developer poking at the surface does not have to guess.
    expect(ids('?modules=tetravox.hello')).toContain(HELLO);
    expect(ids('?engine=mock&modules=all')).toContain(HELLO);
  });

  it('refuses to activate a module this window does not offer', async () => {
    const { store, controller } = harness('');
    await expect(controller.activateModule(HELLO)).resolves.toBe(false);
    expect(store.getState().activeModule).toBeNull();
  });
});

describe('activation', () => {
  it('puts the module in the slot, with a panel ready in the same render', async () => {
    const { store, controller } = harness();
    expect(controller.modulePanel()).toBeNull();
    await expect(controller.activateModule(HELLO)).resolves.toBe(true);
    expect(store.getState().activeModule).toBe(HELLO);
    // §13.3: `activeModule` is set only after `activate` resolved, so a component that saw the id
    // can rely on the panel.
    expect(controller.modulePanel()).not.toBeNull();
    expect(controller.activeModuleManifest()?.title).toBe('Hello');
  });

  it('is idempotent, and the switcher toggles it back off', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    const panel = controller.modulePanel();
    await controller.activateModule(HELLO);
    expect(controller.modulePanel()).toBe(panel);

    await controller.toggleModule(HELLO);
    expect(store.getState().activeModule).toBeNull();
    expect(controller.modulePanel()).toBeNull();
  });

  it('drops the module when the controller detaches', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    controller.detach();
    open.length = 0;
    expect(store.getState().activeModule).toBeNull();
  });
});

describe('commands, status and dirt', () => {
  it('runs a command, which fills the status cell and marks the module dirty', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    expect(store.getState().moduleStatus[HELLO]).toBeUndefined();

    await controller.moduleCommand(HELLO, 'ping');
    expect(store.getState().moduleStatus[HELLO]).toBe('hello: 1');
    expect(store.getState().moduleDirty[HELLO]).toBe(true);
  });

  it('is a different flag from `sceneDirty`, which a cursor click sets and this must not be', async () => {
    // The title's `•` is the OR of the two (`syncTitle`); this asserts the input to that OR, because
    // vitest runs under `environment: 'node'` and there is no `document` to read a title from. The
    // rendered title is asserted in `packages/app/e2e/modules.spec.ts`.
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    expect(anyModuleDirty(store.getState())).toBe(false);

    await controller.moduleCommand(HELLO, 'ping');
    expect(store.getState().sceneDirty).toBe(false);
    expect(anyModuleDirty(store.getState())).toBe(true);
    expect(dirtyModuleIds(store.getState())).toEqual([HELLO]);

    await controller.moduleCommand(HELLO, 'save');
    expect(store.getState().moduleDirty[HELLO]).toBeUndefined();
    expect(anyModuleDirty(store.getState())).toBe(false);
  });

  it('ignores a command addressed to a module that is not in the slot', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    await controller.moduleCommand('tetravox.absent', 'ping');
    expect(store.getState().moduleStatus[HELLO]).toBeUndefined();
  });

  it('reports a command that throws as a toast rather than as a broken slot', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    await controller.moduleCommand(HELLO, 'no-such-command');
    expect(store.getState().toasts).toHaveLength(1);
    expect(store.getState().activeModule).toBe(HELLO);
  });

  it('clears the status cell when the module leaves the slot', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    await controller.moduleCommand(HELLO, 'ping');
    controller.deactivateModule();
    expect(store.getState().moduleStatus[HELLO]).toBeUndefined();
  });
});

describe('keys (§13.5)', () => {
  it('runs the bound command, and only while the module is active', async () => {
    const { store, controller } = harness();
    const g = {
      key: 'g',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      editable: false,
    };
    expect(controller.handleModuleKey(g)).toBe(false);

    await controller.activateModule(HELLO);
    expect(controller.handleModuleKey(g)).toBe(true);
    await Promise.resolve();
    expect(store.getState().moduleStatus[HELLO]).toBe('hello: 1');

    controller.deactivateModule();
    expect(controller.handleModuleKey(g)).toBe(false);
  });

  it('leaves a `when: "selection"` key unclaimed while nothing is selected', async () => {
    // `hasSelection` is `engine.pointSelection() !== null` and nothing is selected, which is
    // exactly the state §13.5's exception is scoped to: the key stays harmless rather than firing
    // on nothing. The other half — the same key claimed once a point *is* selected — is asserted
    // in 'the wired host' below.
    const { controller } = harness();
    await controller.activateModule(HELLO);
    expect(
      controller.handleModuleKey({
        key: 's',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        editable: false,
      })
    ).toBe(false);
  });
});

describe('the scene block (§13.2)', () => {
  it('is written as the module edits, with the manifest’s versions on it', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    await controller.moduleCommand(HELLO, 'ping');

    const block = store.getState().moduleBlocks[HELLO];
    expect(block).toEqual({
      module: HELLO,
      version: helloManifest.sceneBlock?.version,
      moduleVersion: helloManifest.version,
      data: { count: 1, note: 'ping 1' },
    });
  });

  it('survives deactivation, and is restored when the module comes back', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    await controller.moduleCommand(HELLO, 'ping');
    await controller.moduleCommand(HELLO, 'ping');
    controller.deactivateModule();
    expect(store.getState().moduleBlocks[HELLO]?.data).toEqual({ count: 2, note: 'ping 2' });

    await controller.activateModule(HELLO);
    expect(store.getState().moduleBlocks[HELLO]?.data).toEqual({ count: 2, note: 'ping 2' });
    // A restored block is the file's own content: nothing is unsaved yet.
    expect(store.getState().moduleDirty[HELLO]).toBeUndefined();
  });

  it('round-trips through a saved scene and back into the module', async () => {
    const fs = fakeBridge({ '/data/T1.nii.gz': '' });
    const { controller } = harness();
    await controller.activateModule(HELLO);
    await controller.moduleCommand(HELLO, 'ping');
    await controller.moduleCommand(HELLO, 'ping');
    await controller.moduleCommand(HELLO, 'ping');
    await controller.moduleCommand(HELLO, 'save');

    fs.savePath = '/scenes/s.tetravox.json';
    await expect(controller.saveSceneAs()).resolves.toBe(true);
    const written = parseScene(fs.writes[0]?.text as string);
    expect(sceneExtensions(written.spec as never)[HELLO]?.data).toEqual({
      count: 3,
      note: 'saved',
    });

    // Now open it again, from scratch: `openScenePath` clears the scene, adopts the file's blocks
    // and hands each one back to its module.
    const second = harness();
    await expect(second.controller.openScenePath('/scenes/s.tetravox.json')).resolves.toBe(true);
    expect(second.store.getState().moduleBlocks[HELLO]?.data).toEqual({ count: 3, note: 'saved' });
    // `onSceneBlock` is not one of the fixture's activation routes, so the slot stays empty and the
    // block is simply carried — which is the same behaviour a build without the module has.
    expect(second.store.getState().activeModule).toBeNull();

    // …and re-saving from that second window writes the block straight back out.
    fs.savePath = '/scenes/again.tetravox.json';
    await second.controller.saveSceneAs();
    const again = parseScene(fs.writes[1]?.text as string);
    expect(sceneExtensions(again.spec as never)[HELLO]?.data).toEqual({ count: 3, note: 'saved' });
  });

  it('is forgotten with the scene, and the slot empties with it', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    await controller.moduleCommand(HELLO, 'ping');

    controller.newScene();
    expect(store.getState().moduleBlocks).toEqual({});
    expect(store.getState().moduleDirty).toEqual({});
    expect(store.getState().activeModule).toBeNull();
  });
});

describe('the confirm dialog (§13.3)', () => {
  it('raises the question and resolves to the button that was pressed', async () => {
    const { store, controller } = harness();
    const answer = controller.confirmDialog('Title', 'Body', ['Yes', 'No']);
    expect(store.getState().dialog).toBe('confirm');
    expect(store.getState().confirm?.buttons).toEqual(['Yes', 'No']);

    controller.resolveConfirm(1);
    await expect(answer).resolves.toBe(1);
    expect(store.getState().dialog).toBe('none');
    expect(store.getState().confirm).toBeNull();
  });

  it('cancels a question that a second one replaced, so nothing waits forever', async () => {
    const { controller } = harness();
    const first = controller.confirmDialog('One', '…', ['Ok', 'Cancel']);
    const second = controller.confirmDialog('Two', '…', ['Ok', 'Cancel']);
    // The replaced question resolves as its own cancelling (last) button.
    await expect(first).resolves.toBe(1);
    controller.resolveConfirm(0);
    await expect(second).resolves.toBe(0);
  });

  it('ignores an answer that belongs to a different question, and leaves this one standing', async () => {
    const { store, controller } = harness();
    const answer = controller.confirmDialog('One', '…', ['Ok', 'Cancel']);
    const asked = store.getState().confirm;
    // Something else replaced what is on screen: the stale answer must neither resolve this question
    // nor dismiss it, or the guard awaiting it would hang with no dialog to answer.
    store.setState({ confirm: { id: 999, title: 'x', body: 'y', buttons: ['a', 'b'] } });
    controller.resolveConfirm(0);
    expect(store.getState().dialog).toBe('confirm');

    store.setState({ confirm: asked });
    controller.resolveConfirm(1);
    await expect(answer).resolves.toBe(1);
  });
});

describe('the discard guard (§13.3)', () => {
  async function dirtyHarness(): Promise<ReturnType<typeof harness>> {
    const h = harness();
    await h.controller.activateModule(HELLO);
    await h.controller.moduleCommand(HELLO, 'ping');
    return h;
  }

  it('does not ask when no module has unsaved work', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    await expect(controller.confirmDiscardModuleEdits('Testing')).resolves.toBe(true);
    expect(store.getState().dialog).toBe('none');
  });

  it('asks before New, and Cancel really cancels it', async () => {
    const { store, controller } = await dirtyHarness();
    const pending = controller.requestNewScene();
    expect(store.getState().dialog).toBe('confirm');
    expect(store.getState().confirm?.title).toContain('Hello');
    // Two buttons, because the fixture declares no `save` command: a three-button question whose
    // first button did nothing would be worse than a two-button one.
    expect(store.getState().confirm?.buttons).toEqual(['Discard', 'Cancel']);

    controller.resolveConfirm(1);
    await pending;
    expect(store.getState().moduleDirty[HELLO]).toBe(true);
    expect(store.getState().activeModule).toBe(HELLO);
  });

  it('discards when the user says so', async () => {
    const { store, controller } = await dirtyHarness();
    const pending = controller.requestNewScene();
    controller.resolveConfirm(0);
    await pending;
    expect(store.getState().activeModule).toBeNull();
    expect(store.getState().moduleBlocks).toEqual({});
  });

  it('asks before a scene is opened over the top of unsaved work', async () => {
    fakeBridge({ '/scenes/s.tetravox.json': '{"version":1,"datasets":[],"layers":[]}' });
    const { store, controller } = await dirtyHarness();
    const pending = controller.openScenePath('/scenes/s.tetravox.json');
    expect(store.getState().dialog).toBe('confirm');
    controller.resolveConfirm(1);
    await expect(pending).resolves.toBe(false);
  });

  it('offers Save… only when the dirty module declares a `save` command', async () => {
    const { store, controller } = await dirtyHarness();
    // The fixture's manifest has none, so two buttons; a module that declares one gets three. The
    // manifest is data, so the branch is checkable without inventing a second module.
    expect(helloManifest.commands.some((c) => c.id === 'save')).toBe(false);
    const pending = controller.requestNewScene();
    expect(store.getState().confirm?.buttons).toHaveLength(2);
    controller.resolveConfirm(1);
    await pending;
  });

  it('warns on ⌘S that the scene is saved and the module is not', async () => {
    const fs = fakeBridge({ '/data/T1.nii.gz': '' });
    const { store, controller } = await dirtyHarness();
    fs.savePath = '/scenes/s.tetravox.json';
    await controller.saveSceneAs();
    const toast = store.getState().toasts.at(-1);
    expect(toast?.title).toBe('Scene saved');
    expect(toast?.detail).toContain('Hello');
  });
});

describe('the host’s unwired members', () => {
  function host() {
    const { store, controller } = harness();
    return createModuleHost({ controller, store }, helloManifest);
  }

  it('throws `ModuleHostError` for the point tool rather than answering "nothing selected"', () => {
    const h = host();
    expect(() => h.tool.selection()).toThrow(ModuleHostError);
    expect(() => h.tool.pointTool()).toThrow(/not available in this build/);
    expect(() => h.tool.setPointTool(null)).toThrow(ModuleHostError);
    expect(() => h.tool.select('layer-1', null)).toThrow(ModuleHostError);
  });

  it('rejects for files, so an `await` sees the same error', async () => {
    const h = host();
    await expect(h.files.readText('/x.tsv')).rejects.toBeInstanceOf(ModuleHostError);
    await expect(h.files.siblings('/x.tsv')).rejects.toBeInstanceOf(ModuleHostError);
    await expect(h.files.openDialog('r')).rejects.toBeInstanceOf(ModuleHostError);
    await expect(h.files.saveDialog('w', null)).rejects.toBeInstanceOf(ModuleHostError);
    await expect(h.files.writeText('/x.tsv', 'x')).rejects.toBeInstanceOf(ModuleHostError);
  });

  it('throws for `peakCentroid`, and takes the real one when it is injected', () => {
    const { store, controller } = harness();
    expect(() =>
      createModuleHost({ controller, store }, helloManifest).scene.peakCentroid('d', [0, 0, 0], 1.5)
    ).toThrow(ModuleHostError);
    const wired = createModuleHost(
      { controller, store, peakCentroid: () => [1, 2, 3] },
      helloManifest
    );
    expect(wired.scene.peakCentroid('d', [0, 0, 0], 1.5)).toEqual([1, 2, 3]);
  });

  it('takes an injected tool and files surface verbatim', async () => {
    const { store, controller } = harness();
    const wired = createModuleHost(
      {
        controller,
        store,
        tool: {
          setPointTool: () => {},
          pointTool: () => null,
          select: () => {},
          selection: () => ({ layerId: 'l', pointId: 'p1', index: 0 }),
        },
        files: {
          readText: async () => 'text',
          siblings: async () => ({}),
          openDialog: async () => null,
          saveDialog: async () => null,
          writeText: async () => ({ ok: true as const, backupPath: null }),
        },
      },
      helloManifest
    );
    expect(wired.tool.selection()?.pointId).toBe('p1');
    await expect(wired.files.readText('/x')).resolves.toBe('text');
  });
});

describe('the host’s scene surface', () => {
  it('reads the cursor and moves it through the engine', () => {
    const { store, controller } = harness();
    const h = createModuleHost({ controller, store }, helloManifest);
    expect(h.scene.cursor()).toEqual([0, 0, 0]);
    h.scene.setCursor([1, 2, 3]);
    expect(h.scene.cursor()).toEqual([1, 2, 3]);
  });

  it('fires `cursor` only when the cursor really moved', () => {
    const { store, controller } = harness();
    const h = createModuleHost({ controller, store }, helloManifest);
    const seen: number[][] = [];
    const off = h.scene.on('cursor', (world) => seen.push([...world]));
    h.scene.setCursor([1, 2, 3]);
    // A store write that touches something else must not look like a cursor event.
    store.setState({ tick: 1 });
    off();
    h.scene.setCursor([4, 5, 6]);
    expect(seen).toEqual([[1, 2, 3]]);
  });

  it('runs the disposers a module registered, once', () => {
    const { store, controller } = harness();
    const h = createModuleHost({ controller, store }, helloManifest);
    let runs = 0;
    h.subscribe(() => runs++);
    h.subscribe(() => {
      throw new Error('a module teardown that throws must not strand the rest');
    });
    h.subscribe(() => runs++);
    // `disposeModuleHost` is the shell's, not the module's — see `hostImpl.ts`.
    controller.deactivateModule();
    expect(runs).toBe(0);
  });

  it('refuses a block from a manifest that declares none, and one over 256 KiB', () => {
    const { store, controller } = harness();
    const noBlock: ModuleManifest = { ...helloManifest, sceneBlock: undefined };
    expect(() => createModuleHost({ controller, store }, noBlock).scene.setBlock({ a: 1 })).toThrow(
      /declares no sceneBlock/
    );

    const h = createModuleHost({ controller, store }, helloManifest);
    const big = { pad: 'x'.repeat(MAX_BLOCK_BYTES) };
    expect(blockBytes(big)).toBeGreaterThan(MAX_BLOCK_BYTES);
    expect(() => h.scene.setBlock(big)).toThrow(/§13.2/);
    // …and the cap really is on **bytes**, not on characters: a two-byte character costs two.
    expect(blockBytes({ a: 'é' })).toBe((blockBytes({ a: 'e' }) as number) + 1);
    expect(blockBytes('é')).toBe(4);
    // A block that cannot be serialised at all is refused rather than written as `undefined`.
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(blockBytes(cyclic)).toBeNull();
    expect(() => h.scene.setBlock(cyclic)).toThrow(/not JSON/);
  });

  it('drops the block entirely when a module sets it to null', () => {
    const { store, controller } = harness();
    const h = createModuleHost({ controller, store }, helloManifest);
    h.scene.setBlock({ count: 1 });
    expect(store.getState().moduleBlocks[HELLO]).toBeDefined();
    h.scene.setBlock(null);
    expect(store.getState().moduleBlocks[HELLO]).toBeUndefined();
  });
});

describe('the history stack', () => {
  it('walks back and forward, and a push after an undo starts a new branch', () => {
    const history = createHistory<number>(3);
    expect(history.canUndo()).toBe(false);
    history.push(1);
    history.push(2);
    expect(history.undo()).toBe(2);
    expect(history.canRedo()).toBe(true);
    expect(history.redo()).toBe(2);
    history.push(3);
    expect(history.canRedo()).toBe(false);
  });

  it('is bounded, so a long session does not keep every snapshot alive', () => {
    const history = createHistory<number>(2);
    history.push(1);
    history.push(2);
    history.push(3);
    expect(history.undo()).toBe(3);
    expect(history.undo()).toBe(2);
    expect(history.undo()).toBeNull();
  });
});

describe('readerClaim (§13.1’s onReader)', () => {
  const tsv: ModuleManifest = {
    ...helloManifest,
    id: 'lab.tables',
    readers: [{ id: 'electrodes', title: 'Electrode tables', extensions: ['tsv', 'csv'] }],
  };
  const narrow: ModuleManifest = {
    ...helloManifest,
    id: 'lab.narrow',
    readers: [
      {
        id: 'electrodes',
        title: 'Electrodes',
        extensions: ['tsv'],
        match: '_electrodes\\.tsv$',
      },
    ],
  };

  it('claims by extension, case-insensitively', () => {
    expect(readerClaim([tsv], '/d/x.TSV')?.readerId).toBe('electrodes');
    expect(readerClaim([tsv], '/d/x.csv')?.manifest.id).toBe('lab.tables');
    expect(readerClaim([tsv], '/d/x.nii.gz')).toBeNull();
  });

  it('applies `match` to the basename, never to the whole path', () => {
    expect(readerClaim([narrow], '/d/sub-01_electrodes.tsv')?.readerId).toBe('electrodes');
    expect(readerClaim([narrow], '/d/sub-01_events.tsv')).toBeNull();
    // A directory that happens to be named like the pattern must not make every file inside it a hit.
    expect(readerClaim([narrow], '/d/sub-01_electrodes.tsv/other.tsv')).toBeNull();
  });

  it('resolves two claimants in registration order, which is visible in one file', () => {
    expect(readerClaim([tsv, narrow], '/d/sub-01_electrodes.tsv')?.manifest.id).toBe('lab.tables');
    expect(readerClaim([narrow, tsv], '/d/sub-01_electrodes.tsv')?.manifest.id).toBe('lab.narrow');
  });

  it('claims nothing for a `match` that is not a regexp', () => {
    const broken: ModuleManifest = {
      ...helloManifest,
      readers: [{ id: 'r', title: 'r', extensions: ['tsv'], match: '(' }],
    };
    expect(readerClaim([broken], '/d/x.tsv')).toBeNull();
  });

  it('is what the controller asks, so the fixture claims nothing at all', () => {
    const { controller } = harness();
    expect(controller.readerFor('/d/x.tsv')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// The wired host: the three members that were stubs until the phases they need landed
// ------------------------------------------------------------------------------------------------

/**
 * A volume with one bright voxel, for `peakCentroid`.
 *
 * Spacing 1 mm and the origin at the world origin, so the affine and its inverse are the identity
 * and voxel `(i, j, k)` **is** world `(i, j, k)` — the arithmetic a reader can redo on the page. The
 * weights are `clip(v − (max − ½(max − min)), 0)`, so with one voxel at 100 among zeros the
 * threshold is 50 and the only voxel with any weight is the bright one: the centroid is exactly it.
 */
function brightVoxelVolume(id: string, at: [number, number, number]): Dataset {
  const dims: [number, number, number] = [5, 5, 5];
  const values = new Float32Array(dims[0] * dims[1] * dims[2]);
  values[at[0] + dims[0] * (at[1] + dims[1] * at[2])] = 100;
  const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    kind: 'volume',
    id,
    name: 'bright.nii.gz',
    dims,
    nvols: 1,
    spacing: [1, 1, 1],
    affine: identity,
    inverseAffine: identity,
    data: values,
    sclSlope: 1,
    sclInter: 0,
    dtype: 'f32',
    isLabel: false,
  } as unknown as Dataset;
}

describe('the wired host (§13.1)', () => {
  it('arms the engine’s point tool through `host.tool` and hears the event back', async () => {
    const { engine, controller } = harness();
    await controller.activateModule(HELLO);
    const host = controller.moduleHost();
    expect(host).not.toBeNull();
    const h = host as ModuleHost;

    // The pane the stand-in measures in: 200×200 at 0.5 mm/px with the cursor at the origin, so
    // world `(x, y, ·)` is at `(100 + x / 0.5 − 0.5, 100 − y / 0.5 − 0.5)` — `mockEngine.test.ts`'s
    // own ruler, restated here because a placement's `world` is asserted below.
    const dataset = await engine.addDataset({ kind: 'path', path: '/tmp/t1.nii.gz' });
    const layer = h.scene.addLayer({
      datasetId: dataset.id,
      kind: 'points',
      points: [],
      shape: 'dot',
      radiusMm: 1.5,
      color: [1, 0, 0, 1],
      showLabels: false,
    } as unknown as Parameters<ModuleHost['scene']['addLayer']>[0]);
    // The stamp §4.4 declares, so the layer panel shows a summary instead of the core editor.
    expect(layer.module).toBe(HELLO);

    engine.pointPane = { width: 200, height: 200 };
    engine.setCursor([0, 0, 0]);
    engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.5 } });

    const events: PointToolEvent[] = [];
    const off = h.scene.on('pointTool', (event) => events.push(event));

    h.tool.setPointTool({ layerId: layer.id, mode: 'place' });
    expect(h.tool.pointTool()?.mode).toBe('place');
    // Arming is not an event: `setPointTool` emits nothing until something happens with the tool.
    expect(events).toEqual([]);

    engine.pointToolClick('axial', 100 + 6 / 0.5 - 0.5, 100 - 4 / 0.5 - 0.5);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('placed');
    expect(events[0]?.layerId).toBe(layer.id);
    expect(events[0]?.world?.[0]).toBeCloseTo(6, 6);
    expect(events[0]?.world?.[1]).toBeCloseTo(4, 6);

    // A placement is also the selection, which is what `when: 'selection'` gates on — so the key
    // that stayed unclaimed with nothing selected is claimed now.
    const placed = events[0]?.pointId as string;
    expect(h.tool.selection()?.pointId).toBe(placed);
    expect(
      controller.handleModuleKey({
        key: 's',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        editable: false,
      })
    ).toBe(true);

    // `select(layerId, null)` clears it; disarming emits one `cleared` whatever was selected.
    h.tool.select(layer.id, null);
    expect(h.tool.selection()).toBeNull();
    expect(events.at(-1)?.kind).toBe('cleared');
    const before = events.length;
    h.tool.setPointTool(null);
    expect(h.tool.pointTool()).toBeNull();
    expect(events.slice(before).map((e) => e.kind)).toEqual(['cleared']);

    // The subscription is the module's to drop, and dropping it stops the fan-out.
    off();
    h.tool.setPointTool({ layerId: layer.id, mode: 'select' });
    h.tool.setPointTool(null);
    expect(events.slice(before)).toHaveLength(1);
  });

  it('reads a peak centroid out of the dataset the module names, and null for anything else', async () => {
    const { engine, controller } = harness();
    await controller.activateModule(HELLO);
    const h = controller.moduleHost() as ModuleHost;

    engine.scene.datasets.set('ds-bright', brightVoxelVolume('ds-bright', [2, 2, 2]));
    // A 1.5 mm radius on 1 mm spacing is a 3³ box around the query, which reaches the bright voxel
    // from a millimetre away — and answers with the voxel, not with the query.
    expect(h.scene.peakCentroid('ds-bright', [1, 2, 2], 1.5)).toEqual([2, 2, 2]);
    // Far enough away that the box holds nothing but zeros: no peak, rather than a made-up one.
    expect(h.scene.peakCentroid('ds-bright', [0, 0, 0], 0.5)).toBeNull();
    // A dataset that is not there, and one that is not a volume, are the same `null`.
    expect(h.scene.peakCentroid('ds-nope', [2, 2, 2], 1.5)).toBeNull();
    const mesh = await engine.addDataset({ kind: 'path', path: '/tmp/head.msh' });
    expect(h.scene.peakCentroid(mesh.id, [2, 2, 2], 1.5)).toBeNull();
  });

  it('gives the module a real files surface, over the module channels', async () => {
    const { controller } = harness();
    await controller.activateModule(HELLO);
    const h = controller.moduleHost() as ModuleHost;
    // The fixture declares no readers, writers or sibling rules, so what is asserted is that the
    // surface is `createHostFiles` over the bridge and not the stub that rejects: an undeclared
    // reader answers null, and the manifest with no sibling rules answers nothing at all.
    await expect(h.files.openDialog('nope')).resolves.toBeNull();
    await expect(h.files.saveDialog('nope', null)).resolves.toBeNull();
    await expect(h.files.siblings('/data/T1.nii.gz')).resolves.toEqual({});
  });
});

// ------------------------------------------------------------------------------------------------
// Pop-out and concurrency (§13.10, 2026-08-31)
// ------------------------------------------------------------------------------------------------

/**
 * A second module, injected the way an installed extension is.
 *
 * The registry ships exactly one fixture, and concurrency is not a claim one module can support: the
 * assertions below are all about *two* live sessions not being one another's. `setInstalledModules`
 * is the same door a downloaded extension comes through, so this is the real path rather than a
 * reach into the map.
 */
function secondModule(): ModuleManifest {
  return {
    ...helloManifest,
    id: 'vendor.second',
    title: 'Second',
    commands: [{ id: 'noop', title: 'No-op' }],
  };
}

async function withSecond(controller: ShellController): Promise<ModuleManifest> {
  // `attach()` kicks off `refreshInstalledModules`, which *replaces* the installed set with what
  // main reports (nothing, here). Let it land first, or it wipes the module this helper just added
  // and the test reads as "concurrency is broken" when the registry is simply empty.
  await controller.refreshInstalledModules([]);
  const manifest = secondModule();
  setInstalledModules([
    {
      manifest,
      load: async () => ({
        activate: (host: ModuleHost) => ({
          Panel: () => null,
          runCommand: () => {
            host.ui.status('ran');
          },
          dirty: () => false,
          dispose: () => {},
        }),
      }),
    },
  ]);
  return manifest;
}

describe('placement and concurrency (§13.10)', () => {
  afterEach(() => setInstalledModules([]));

  it('reports a freshly activated module as docked, and mirrors it into the store', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    expect(controller.modulePlacement(HELLO)).toBe('docked');
    expect(store.getState().modulePlacement).toEqual({ [HELLO]: 'docked' });
    expect(store.getState().activeModule).toBe(HELLO);
  });

  it('a launch with no module has an empty placement map, not a placeholder entry', () => {
    // The whole no-module DOM has to stay byte-identical: a default entry here would be a component
    // rendering something where nothing rendered before.
    const { store } = harness();
    expect(store.getState().modulePlacement).toEqual({});
  });

  it('popping out keeps the very same instance — nothing is re-activated', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    const instance = controller.moduleInstance(HELLO);
    const host = controller.moduleHost(HELLO);

    controller.setModulePlacement(HELLO, 'window');
    expect(controller.moduleInstance(HELLO)).toBe(instance);
    expect(controller.moduleHost(HELLO)).toBe(host);
    // Out of the slot, still live: `activeModule` is the *slot*, and this is the one distinction the
    // whole feature rests on.
    expect(store.getState().activeModule).toBeNull();
    expect(store.getState().modulePlacement).toEqual({ [HELLO]: 'window' });
    expect(controller.modulePanelFor(HELLO)).not.toBeNull();
    expect(controller.modulePanel()).toBeNull();
  });

  it('re-docking is the same move backwards, and neither direction disposes anything', async () => {
    const { store, controller } = harness();
    await controller.activateModule(HELLO);
    const instance = controller.moduleInstance(HELLO);
    controller.setModulePlacement(HELLO, 'window');
    controller.setModulePlacement(HELLO, 'docked');
    expect(controller.moduleInstance(HELLO)).toBe(instance);
    expect(store.getState().activeModule).toBe(HELLO);
  });

  it('the host reports and can ask for its own placement', async () => {
    const { controller } = harness();
    await controller.activateModule(HELLO);
    const host = controller.moduleHost(HELLO);
    expect(host?.ui.placement()).toBe('docked');

    const seen: string[] = [];
    const off = host?.ui.onPlacement((placement) => seen.push(placement));
    host?.ui.setPlacement('window');
    expect(host?.ui.placement()).toBe('window');
    expect(seen).toEqual(['window']);
    // `isActive` deliberately still means "in the slot", so a panel gating its docked chrome on it
    // does not draw slot chrome inside a window.
    expect(host?.ui.isActive()).toBe(false);
    off?.();
    host?.ui.setPlacement('docked');
    expect(seen).toEqual(['window']);
  });

  it('holds two modules at once, and docking the second pops the first out rather than closing it', async () => {
    const { store, controller } = harness();
    const second = await withSecond(controller);
    await controller.activateModule(HELLO);
    const helloInstance = controller.moduleInstance(HELLO);

    await controller.activateModule(second.id);
    expect(store.getState().activeModule).toBe(second.id);
    // Not unloaded — moved. A gesture that means "show me this one too" must never be the gesture
    // that throws the other one's unsaved edits away.
    expect(controller.moduleInstance(HELLO)).toBe(helloInstance);
    expect(controller.modulePlacement(HELLO)).toBe('window');
    expect(
      controller
        .moduleSessionsInfo()
        .map((s) => s.manifest.id)
        .sort()
    ).toEqual([HELLO, second.id].sort());
  });

  it('activating straight into a window leaves the slot alone', async () => {
    const { store, controller } = harness();
    const second = await withSecond(controller);
    await controller.activateModule(HELLO);
    await controller.activateModule(second.id, 'window');
    expect(store.getState().activeModule).toBe(HELLO);
    expect(controller.modulePlacement(second.id)).toBe('window');
  });

  it('closes exactly the module it is asked to close', async () => {
    const { store, controller } = harness();
    const second = await withSecond(controller);
    await controller.activateModule(HELLO);
    await controller.activateModule(second.id, 'window');

    controller.deactivateModule(second.id);
    expect(controller.modulePlacement(second.id)).toBeNull();
    expect(controller.modulePlacement(HELLO)).toBe('docked');
    expect(store.getState().activeModule).toBe(HELLO);

    // No id is still "the one in the slot", which is what the slot's ✕ and every pre-§13.10 caller
    // means by it.
    controller.deactivateModule();
    expect(store.getState().activeModule).toBeNull();
    expect(controller.moduleSessionsInfo()).toEqual([]);
  });

  it('sends a key to the module whose window it came from, not to the one in the slot', async () => {
    const { store, controller } = harness();
    const second = await withSecond(controller);
    await controller.activateModule(second.id);
    await controller.activateModule(HELLO, 'window');
    // `g` is the fixture's own unconditional binding; the docked `Second` binds nothing.
    const key = {
      key: 'g',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      editable: false,
    };
    expect(controller.handleModuleKey(key)).toBe(false);
    expect(controller.handleModuleKey(key, HELLO)).toBe(true);
    expect(store.getState().activeModule).toBe(second.id);
  });

  it('detaching disposes the popped-out modules too', async () => {
    const { store, controller } = harness();
    const second = await withSecond(controller);
    await controller.activateModule(HELLO, 'window');
    await controller.activateModule(second.id, 'window');
    controller.detach();
    open.length = 0;
    expect(store.getState().modulePlacement).toEqual({});
  });
});
