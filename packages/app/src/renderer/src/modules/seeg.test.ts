/**
 * `tetravox.seeg` against the shell (§13.4's middle row).
 *
 * `hostImpl.test.ts`'s idiom — `NoGlEngine` + `createUiStore` + `ShellController.attach()`, with a
 * `Map` for a filesystem behind the real bridge shape — because everything here is **state and
 * calls, never pixels**: what the layer holds after a load, what a command does to it, what a save
 * writes, what a scene file carries. The rendered panel is `packages/app/e2e/module-seeg.spec.ts`.
 *
 * It lives here rather than in `modules/seeg/` because §13.1's import wall covers every file under a
 * module's directory, and a harness has to reach the controller and the stand-in engine. That is the
 * same reason `hostImpl.test.ts` is here.
 *
 * The CT is `ct_shafts.nii.gz` — the name `NoGlEngine` answers with the sEEG phantom
 * (`engine/mockData.ts`), so `peakCentroid` has real metal to find and a snap is a measurement
 * rather than a no-op.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Layer, PointsLayer } from '@tetravox/engine';
import type { ModuleStatus, TetravoxBridge } from '../../../preload/index';
import { NoGlEngine } from '../engine/mockEngine';
import { ctPhantomContacts } from '../engine/mockData';
import { ShellController } from '../store/controller';
import { createUiStore } from '../store/store';
import type { UiStore } from '../store/store';
import type { InstalledManifest } from '../../../modules/manifest-types';
import type { ModuleActivate } from './host';
import type * as InstalledLoader from './installed';
import { installModuleSdk } from './sdk-runtime';
import { paletteColor } from './shared/contacts/palette';

const SEEG = 'tetravox.seeg';

/**
 * The **bundled** `tetravox.seeg`, reached the way the running app reaches it (§13.8, 2026-08-31),
 * not compiled in any more. The fake bridge reports it exactly as main reports a pre-consented
 * bundled module, the controller's `refreshInstalledModules` registers it through the real
 * eligibility gate, and the one step a `tetravox://module/` URL cannot take under vitest — `import()`
 * of the bundle — is the only thing mocked, and it resolves to the very bytes the release ships
 * (`resources/modules/`, populated from `modules.lock` by `scripts/fetch-locked-modules.mjs`).
 *
 * When that tree is absent — the cheap `test` CI leg runs `fetch-locked-modules --verify-only`, which
 * never downloads — every suite here **skips**, exactly as a real-data test skips without its dataset
 * (AGENTS.md rule 2). Locally, after a fetch, they run against the release's bytes, which is what
 * makes this the extraction's regression gate.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'resources',
  'modules',
  'tetravox.seeg',
  '0.1.0'
);
const haveBundle = existsSync(join(BUNDLE, 'index.js'));
const describeSeeg = haveBundle ? describe : describe.skip;

// Shared with the hoisted `vi.mock` factory: the bundle's `activate`, filled once the bundle is
// imported below. The mocked `load()` reads it at call time, which is after that import has run.
const bundle = vi.hoisted(() => ({ activate: null as ModuleActivate | null }));

// Only the loader's URL `import()` is mocked; the manifest registration, the eligibility gate and the
// status all stay the real code, driven by the bridge — so this exercises the installed-module path
// end to end, against the compiled bundle rather than the source.
vi.mock('../modules/installed', async (importOriginal) => {
  const actual = await importOriginal<typeof InstalledLoader>();
  const { installedManifests } = await import('../../../modules/manifests');
  return {
    ...actual,
    registrationsFor: (statuses: readonly ModuleStatus[], compiledInIds: readonly string[]) =>
      actual.eligibleInstalled(installedManifests(), statuses, compiledInIds).map((manifest) => ({
        manifest,
        load: async () => ({ activate: bundle.activate as ModuleActivate }),
      })),
  };
});

let bundledManifest: InstalledManifest | null = null;
if (haveBundle) {
  installModuleSdk();
  bundledManifest = JSON.parse(
    readFileSync(join(BUNDLE, 'manifest.json'), 'utf8')
  ) as InstalledManifest;
  bundle.activate = (
    (await import(pathToFileURL(join(BUNDLE, 'index.js')).href)) as { activate: ModuleActivate }
  ).activate;
}

/** The status main reports for the pre-consented, auto-enabled bundled module. */
function seegStatus(): ModuleStatus {
  return {
    id: SEEG,
    title: bundledManifest?.title ?? 'sEEG contacts',
    installed: bundledManifest?.version ?? '0.1.0',
    bundled: true,
    enabled: true,
    available: null,
    updatable: false,
    permissions: [],
  };
}
const DERIV = '/bids/derivatives/seegprep/sub-P076';
const CT = `${DERIV}/ct/sub-P076_acq-bone_space-T1w_ct.nii.gz`;
const TSV = `${DERIV}/ieeg/sub-P076_space-T1w_electrodes.tsv`;

/** The phantom's own contacts, as an electrodes table 0.6 mm off the metal on every axis. */
function phantomTable(offsetMm = 0.6): string {
  const lines = ['name\telectrode\tcontact\tcsc\tx\ty\tz\tstatus'];
  for (const [index, contact] of ctPhantomContacts().entries()) {
    const name = `${contact.group}${String(contact.ordinal).padStart(2, '0')}`;
    const x = contact.world[0] + offsetMm;
    const y = contact.world[1] - offsetMm;
    const z = contact.world[2];
    lines.push(
      `${name}\t${contact.group}\t${contact.ordinal}\t${index + 1}\t${x}\t${y}\t${z}\tlocated`
    );
  }
  return `${lines.join('\n')}\n`;
}

interface FakeFs {
  files: Map<string, string>;
  writes: { path: string; text: string; backup: boolean }[];
  savePath: string | null;
  scenePath: string | null;
  openPaths: string[];
}

function fakeBridge(files: Record<string, string>): FakeFs {
  const fs: FakeFs = {
    files: new Map(Object.entries(files)),
    writes: [],
    savePath: null,
    scenePath: null,
    openPaths: [],
  };
  const settings = {
    theme: 'system' as const,
    freesurferSubjectsDir: '',
    recentScenes: [],
    reopenLastScene: false,
    screenshotDefaults: { background: 'scene' as const, dpi: 144, autoTrim: false },
  };
  const bridge = {
    // What main reports for the bundled, pre-consented module — the discovery `refreshInstalledModules`
    // runs at attach, which is what registers `tetravox.seeg` in this window (§13.8).
    moduleManifests: async () => (haveBundle && bundledManifest !== null ? [bundledManifest] : []),
    moduleStatuses: async () => (haveBundle ? [seegStatus()] : []),
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
      fs.files.set(path, text);
      return { ok: true as const, path };
    },
    saveSceneDialog: async () => fs.scenePath,
    rememberScene: async () => null,
    configPath: async () => '/tvx-test/tetravoxrc',
    revealConfigFile: async () => {},
    startupPaths: async () => [],
    startupScene: async () => null,
    subjectSpaces: async () => null,
    surfaceSpaces: async () => null,
    setDocumentEdited: () => {},
    log: () => {},
    // §5 rule 11's four channels, as a Map.
    moduleReadText: async (_id: string, path: string) => {
      const text = fs.files.get(path);
      return text === undefined
        ? { ok: false as const, error: 'not on the allow-list' }
        : { ok: true as const, text };
    },
    moduleOpenDialog: async () =>
      fs.openPaths.map((path) => ({ path, url: `tetravox://file/${path}` })),
    moduleSaveDialog: async (_id: string, opts: { siblings: string[] }) => {
      if (fs.savePath === null) return null;
      const directory = fs.savePath.slice(0, fs.savePath.lastIndexOf('/') + 1);
      const name = fs.savePath.slice(directory.length);
      const stem = name.replace(/(\.[A-Za-z0-9]+)+$/, '');
      const siblings: Record<string, string> = {};
      for (const template of opts.siblings) {
        siblings[template] = `${directory}${template
          .replace('{name}', name)
          .replace('{stem}', stem)
          .replace('{stamp}', '20260830-101500')}`;
      }
      return { path: fs.savePath, siblings };
    },
    moduleWriteText: async (_id: string, path: string, text: string, opts: { backup: boolean }) => {
      const existed = fs.files.has(path);
      fs.writes.push({ path, text, backup: opts.backup });
      const backupPath = opts.backup && existed ? `${path}.20260830-101500.bak` : null;
      if (backupPath !== null) fs.files.set(backupPath, fs.files.get(path) as string);
      fs.files.set(path, text);
      return { ok: true as const, backupPath };
    },
  } as unknown as TetravoxBridge;
  (globalThis as { tetravox?: TetravoxBridge }).tetravox = bridge;
  return fs;
}

const open: ShellController[] = [];
afterEach(() => {
  for (const controller of open.splice(0)) controller.detach();
  delete (globalThis as { tetravox?: TetravoxBridge }).tetravox;
});

interface Harness {
  engine: NoGlEngine;
  store: UiStore;
  controller: ShellController;
  fs: FakeFs;
}

async function harness(files: Record<string, string> = {}): Promise<Harness> {
  const fs = fakeBridge(files);
  const engine = new NoGlEngine({ stepMs: 0 });
  const store = createUiStore();
  const controller = new ShellController(engine, store);
  controller.attach();
  // `attach` fires `refreshInstalledModules` fire-and-forget; await it so the bundled module is
  // registered before a file is opened, the way boot registers it before a drop in the real app.
  await controller.refreshInstalledModules();
  open.push(controller);
  return { engine, store, controller, fs };
}

/** Poll until `ready` or a deadline — the load queue and `dispatchSiblings` are fire-and-forget. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function seegLayer(h: Harness): PointsLayer | undefined {
  return h.store
    .getState()
    .layers.find((l: Layer): l is PointsLayer => l.kind === 'points' && l.module === SEEG);
}

/**
 * Open the CT the way a drop does, and let §13.1's `onSibling` find the table beside it.
 *
 * The whole activation route in one call — `runOne` loads the volume, `dispatchSiblings` probes the
 * manifest's patterns through `allowPath`, the module activates and reads the table.
 */
async function loadSubject(table = phantomTable()): Promise<Harness> {
  const h = await harness({ [TSV]: table, [CT]: 'a volume' });
  h.controller.open([{ name: 'sub-P076 CT', path: CT, source: { kind: 'path', path: CT } }]);
  await until(() => seegLayer(h) !== undefined, 'the contacts layer');
  return h;
}

function contactsLayer(h: Harness): PointsLayer {
  const layer = seegLayer(h);
  expect(layer).toBeDefined();
  return layer as PointsLayer;
}

function pointNamed(h: Harness, name: string): { id: string; position: [number, number, number] } {
  const point = (contactsLayer(h).points ?? []).find((p) => p.name === name);
  expect(point).toBeDefined();
  return {
    id: (point as { id?: string }).id as string,
    position: (point as { position: [number, number, number] }).position,
  };
}

// ------------------------------------------------------------------------------------------------

describeSeeg('the manifest and the module agree about the BIDS layout', () => {
  it('carries the seegprep sibling templates in its bundled manifest', () => {
    // The BIDS layout the reader resolves against, asserted on the manifest the release ships (the
    // module-internal `bids.ts` constants moved out with the module). `readerFor` below proves they
    // actually claim a file; this proves the release carries the pair the panel was built around.
    const [fromCt, fromTsv] = bundledManifest?.siblings ?? [];
    expect(fromCt?.candidates).toEqual([
      '../ieeg/{sub}_space-{space}_electrodes.tsv',
      '../ieeg/{sub}_space-{space}_coordsystem.json',
      '../ieeg/{sub}_space-{space}_electrodes_editlog.json',
      '../../../SimNIBS/{sub}/m2m_{id}/T1.nii.gz',
    ]);
    expect(fromTsv?.candidates).toEqual([
      '../ct/{sub}_acq-bone_space-{space}_ct.nii.gz',
      '{sub}_space-{space}_coordsystem.json',
      '{stem}_editlog.json',
    ]);
  });

  it('claims an electrodes table and nothing else', async () => {
    const h = await harness();
    expect(h.controller.readerFor(TSV)?.manifest.id).toBe(SEEG);
    expect(h.controller.readerFor('/bids/sub-P076/anat/sub-P076_T1w.nii.gz')).toBeNull();
    // A `.tsv` that is not an electrodes table is not claimed: the reader matches the basename.
    expect(h.controller.readerFor('/bids/participants.tsv')).toBeNull();
  });

  it('claims a table whose name is capitalised, the way the extension already was', async () => {
    // A site exporting `Electrodes.tsv` got the mesh loader's "unsupported" toast while
    // `electrodes.tsv` opened: the extension check lower-cased and the name pattern did not.
    const h = await harness();
    expect(h.controller.readerFor('/exports/Electrodes.tsv')?.manifest.id).toBe(SEEG);
    expect(h.controller.readerFor('/exports/SUB-01_CONTACTS.TSV')?.manifest.id).toBe(SEEG);
    // Still narrow: the basename has to say what the file is, whatever its case.
    expect(h.controller.readerFor('/exports/DIXI_locs.csv')).toBeNull();
  });

  it('offers the Open sheet the manifest declares, from the panel', async () => {
    // `load` has no key and no menu entry — §13.3 keeps module commands out of both — so the panel
    // button is the only gesture that can reach the All-files sheet a non-canonical name needs.
    const NAMED = '/exports/DIXI_locs.csv';
    const h = await loadSubject();
    h.fs.files.set(NAMED, phantomTable(0.3));
    h.fs.openPaths = [NAMED];
    await h.controller.moduleCommand(SEEG, 'load');
    await until(() => h.store.getState().moduleBlocks[SEEG] !== undefined, 'the block');
    expect(JSON.stringify(h.store.getState().moduleBlocks[SEEG]?.data)).toContain('DIXI_locs.csv');
    expect(contactsLayer(h).points).toHaveLength(15);
  });
});

/**
 * An `activate` that throws must leave nothing behind (§13.1).
 *
 * The reachable throw is a hand-edited scene: `lib/scene.ts` checks only that `layers` is an array,
 * so a points layer stamped with this module's id whose point has no `position` reaches
 * `adoptOrphanLayer` → `contactSetFromLayer`, which spreads it. By then `createModel` has registered
 * five subscriptions, and `activateModule`'s catch used to toast and return without disposing the
 * host — leaving them attached for the life of the window, with no `moduleSession` for
 * `deactivateModule` to reach them through, and another set leaked on every retry.
 */
describeSeeg('an activate that throws', () => {
  it('disposes the half-built host rather than leaking its subscriptions', async () => {
    fakeBridge({ [CT]: 'a volume' });
    const engine = new NoGlEngine({ stepMs: 0 });
    const store = createUiStore();
    // `hostImpl.ts`'s `onProjection` is an ordinary `store.subscribe`, so counting live listeners
    // is counting exactly what a leaked host holds open.
    const listeners = new Set<unknown>();
    const realSubscribe = store.subscribe.bind(store);
    store.subscribe = ((listener: never) => {
      listeners.add(listener);
      const off = realSubscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    }) as typeof store.subscribe;

    const controller = new ShellController(engine, store);
    controller.attach();
    await controller.refreshInstalledModules();
    open.push(controller);
    controller.open([{ name: 'ct', path: CT, source: { kind: 'path', path: CT } }]);
    await until(() => store.getState().datasets.length === 1, 'the CT');

    engine.addLayer({
      datasetId: store.getState().datasets[0]?.id as string,
      kind: 'points',
      module: SEEG,
      // No `position`: the malformed point a hand-edited scene file can carry.
      points: [{ id: 'c1', name: 'A01' }] as never,
    });

    const before = listeners.size;
    await expect(controller.activateModule(SEEG)).resolves.toBe(false);
    expect(store.getState().activeModule).toBeNull();
    expect(store.getState().toasts.length).toBeGreaterThan(0);
    expect(listeners.size).toBe(before);

    // And a retry does not stack a second set on top of the first.
    await expect(controller.activateModule(SEEG)).resolves.toBe(false);
    expect(listeners.size).toBe(before);
  });
});

describeSeeg('opening a subject', () => {
  it('builds one points layer with §4.4’s module fields and Slicer’s display preset', async () => {
    const h = await loadSubject();
    const layer = contactsLayer(h);
    expect(layer.name).toBe('Contacts · sub-P076_space-T1w_electrodes');
    expect(layer.shape).toBe('dot');
    expect(layer.radiusMm).toBe(1.5);
    expect(layer.showLabels).toBe(true);
    expect(layer.labelSource).toBe('names');
    expect(layer.offPlaneOpacity).toBe(0.6);
    expect(layer.points).toHaveLength(15);
    // One shaft segment per consecutive pair: 5 + 4 + 3 segments, six floats each.
    expect(layer.lineSegments).toHaveLength(12 * 6);
    expect(layer.points?.[0]).toMatchObject({ name: 'A01', group: 'A', ordinal: 1 });

    const ct = h.store.getState().layers.find((l) => l.kind === 'volume');
    expect(ct).toMatchObject({ colormap: 'gray', opacity: 1, visible: true });
    expect((ct as { threshold: { lo: number; mode: string } }).threshold).toMatchObject({
      lo: 150,
      mode: 'hide',
    });
  });

  it('arms the point tool against its own layer, in select mode', async () => {
    const h = await loadSubject();
    expect(h.engine.pointTool()).toMatchObject({ layerId: contactsLayer(h).id, mode: 'select' });
  });

  it('writes a scene block that names no layer or dataset', async () => {
    const h = await loadSubject();
    const block = h.store.getState().moduleBlocks[SEEG];
    expect(block?.module).toBe(SEEG);
    expect(block?.version).toBe(1);
    const text = JSON.stringify(block?.data);
    expect(text).toContain('sub-P076_space-T1w_electrodes.tsv');
    expect(text).not.toContain(contactsLayer(h).id);
    expect(text).not.toContain(h.store.getState().datasets[0]?.id ?? 'ds?');
  });

  it('holds a table opened before any volume, and binds it when one lands', async () => {
    const h = await harness({ [TSV]: phantomTable(), [CT]: 'a volume' });
    // The reader route, with nothing to bind to: `openPath` claims the file either way.
    h.controller.open([{ name: 'electrodes', path: TSV, source: { kind: 'path', path: TSV } }]);
    await until(() => h.store.getState().activeModule === SEEG, 'the module to activate');
    // No volume yet: nothing to hang a layer on, and the module says so rather than failing.
    expect(h.store.getState().layers).toHaveLength(0);

    h.controller.open([{ name: 'ct', path: CT, source: { kind: 'path', path: CT } }]);
    await until(() => seegLayer(h) !== undefined, 'the contacts layer');
    expect(contactsLayer(h).points).toHaveLength(15);
  });

  it('is not dirty on load — reading a file is not an edit', async () => {
    const h = await loadSubject();
    expect(h.store.getState().moduleDirty[SEEG]).toBeUndefined();
    expect(h.controller.moduleInstance()?.dirty()).toBe(false);
  });
});

describeSeeg('commands', () => {
  it('snaps the selected contact onto the metal it is beside', async () => {
    const h = await loadSubject();
    const before = pointNamed(h, 'A03');
    const truth = ctPhantomContacts().find((c) => c.group === 'A' && c.ordinal === 3);
    const missBy = Math.hypot(
      before.position[0] - (truth?.world[0] ?? 0),
      before.position[1] - (truth?.world[1] ?? 0),
      before.position[2] - (truth?.world[2] ?? 0)
    );
    expect(missBy).toBeGreaterThan(0.5);

    h.engine.setPointSelection({ layerId: contactsLayer(h).id, pointId: before.id });
    await h.controller.moduleCommand(SEEG, 'snap');

    const after = pointNamed(h, 'A03');
    const nowBy = Math.hypot(
      after.position[0] - (truth?.world[0] ?? 0),
      after.position[1] - (truth?.world[1] ?? 0),
      after.position[2] - (truth?.world[2] ?? 0)
    );
    // The peak centroid of a 1.5 mm box lands within a fifth of a millimetre of the blob's centre.
    expect(nowBy).toBeLessThan(0.2);
    expect(nowBy).toBeLessThan(missBy);
    expect(h.store.getState().moduleDirty[SEEG]).toBe(true);
  });

  it('snaps a whole electrode as ONE undo step', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    const moved = pointNamed(h, 'A01').position;
    await h.controller.moduleCommand(SEEG, 'undo');
    const back = pointNamed(h, 'A01').position;
    expect(back).not.toEqual(moved);
    // …and redo puts them all back, which a snapshot-only history could not do.
    await h.controller.moduleCommand(SEEG, 'redo');
    expect(pointNamed(h, 'A01').position).toEqual(moved);
  });

  it('re-fits a shaft onto its own line', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'refit');
    const result = (await h.controller.moduleInstance()?.runOperation?.('stats', {})) as {
      electrodes: { electrode: string; rmsMm: number }[];
    };
    const a = result.electrodes.find((e) => e.electrode === 'A');
    expect(a?.rmsMm).toBeLessThan(1e-6);
  });

  it('never renumbers implicitly, and renumbers from the tip when asked', async () => {
    const h = await loadSubject();
    const names = (): string[] =>
      (contactsLayer(h).points ?? []).filter((p) => p.group === 'A').map((p) => p.name ?? '');
    const nameOf = (id: string): string =>
      (contactsLayer(h).points ?? []).find((p) => p.id === id)?.name ?? '';
    const before = names();
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    expect(names()).toEqual(before);

    // The phantom's table numbers A from the *entry*; the tip heuristic says contact 1 is the end
    // nearer the volume's centre, so Renumber reverses it — that is the defect it exists to fix.
    await h.controller.moduleCommand(SEEG, 'renumber');
    expect(new Set(names())).toEqual(new Set(before));
    expect(nameOf('c1')).toBe('A06');

    // `t` pins the other end, and Renumber then puts the file's own numbering back.
    await h.controller.moduleCommand(SEEG, 'flip-tip');
    await h.controller.moduleCommand(SEEG, 'renumber');
    expect(nameOf('c1')).toBe('A01');
  });

  it('walks the electrode with next/prev and puts the cursor on the contact', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'next');
    const first = h.engine.pointSelection();
    expect(first).not.toBeNull();
    expect(h.store.getState().cursor).toEqual(pointNamed(h, 'A01').position);
    await h.controller.moduleCommand(SEEG, 'next');
    expect(h.engine.pointSelection()?.pointId).not.toBe(first?.pointId);
    await h.controller.moduleCommand(SEEG, 'prev');
    expect(h.engine.pointSelection()?.pointId).toBe(first?.pointId);
  });

  it('deletes the selected contact and puts it back on undo', async () => {
    const h = await loadSubject();
    const target = pointNamed(h, 'A03');
    h.engine.setPointSelection({ layerId: contactsLayer(h).id, pointId: target.id });
    await h.controller.moduleCommand(SEEG, 'delete');
    expect(contactsLayer(h).points).toHaveLength(14);
    await h.controller.moduleCommand(SEEG, 'undo');
    expect(contactsLayer(h).points).toHaveLength(15);
  });

  it('toggles the ghost between Slicer’s 0.6 and §7.2’s cull', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'ghost');
    expect(contactsLayer(h).offPlaneOpacity).toBe(0);
    await h.controller.moduleCommand(SEEG, 'ghost');
    expect(contactsLayer(h).offPlaneOpacity).toBe(0.6);
  });

  it('gives every shaft segment its own electrode’s colour, and every name too (A1)', async () => {
    const h = await loadSubject();
    const layer = contactsLayer(h);
    // Three electrodes of 6/5/4 contacts: 5 + 4 + 3 segments, four colour floats each.
    expect(layer.lineColors).toHaveLength(12 * 4);
    const colorAt = (segment: number): number[] =>
      Array.from((layer.lineColors as Float32Array).slice(segment * 4, segment * 4 + 4));
    // A's five segments are one colour, B's four are the next — and they differ.
    expect(colorAt(0)).toEqual(colorAt(4));
    expect(colorAt(5)).not.toEqual(colorAt(0));
    expect(colorAt(0).slice(0, 3)).toEqual(paletteColor(0).slice(0, 3).map(Math.fround));
    expect(colorAt(5).slice(0, 3)).toEqual(paletteColor(1).slice(0, 3).map(Math.fround));
    // The names take the point's colour, which is the same palette entry the disc is drawn in.
    expect(layer.labelColorSource).toBe('points');
    expect(layer.points?.[0]?.color).toEqual(paletteColor(0));
  });

  it('shows and hides the wire, without touching a contact (A2)', async () => {
    const h = await loadSubject();
    expect(contactsLayer(h).lineSegments).toHaveLength(12 * 6);
    await h.controller.moduleCommand(SEEG, 'wire');
    // Empty, not absent: a `Partial<PointsLayer>` merge cannot unset a field, and the engine's own
    // rule is that fewer than one segment draws nothing.
    expect(contactsLayer(h).lineSegments).toHaveLength(0);
    expect(contactsLayer(h).lineColors).toHaveLength(0);
    // A display switch is not an edit: no history entry, no dirty mark, nothing to save.
    expect(h.store.getState().moduleDirty[SEEG]).toBeFalsy();
    expect(contactsLayer(h).points).toHaveLength(15);

    await h.controller.moduleCommand(SEEG, 'wire');
    expect(contactsLayer(h).lineSegments).toHaveLength(12 * 6);
    expect(contactsLayer(h).lineColors).toHaveLength(12 * 4);
  });

  it('reverts every contact to where the table put it', async () => {
    const h = await loadSubject();
    const before = pointNamed(h, 'A01').position;
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    expect(pointNamed(h, 'A01').position).not.toEqual(before);
    await h.controller.moduleCommand(SEEG, 'revert');
    expect(pointNamed(h, 'A01').position).toEqual(before);
  });

  it('arms place mode, and a placed contact joins the current electrode', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'add');
    expect(h.engine.pointTool()?.mode).toBe('place');

    h.engine.pointToolClick('axial', 260, 260);
    const layer = contactsLayer(h);
    expect(layer.points).toHaveLength(16);
    const added = (layer.points ?? [])[15];
    expect(added?.group).toBe('A');
    expect(added?.name).toBe('A07');
    expect(h.store.getState().moduleDirty[SEEG]).toBe(true);
  });

  it('does not commit an undo step for a click that moved nothing', async () => {
    const h = await loadSubject();
    const target = pointNamed(h, 'A02');
    // A plain select-mode click: `selected`, then one zero-length `dragEnd`.
    h.engine.setPointSelection({ layerId: contactsLayer(h).id, pointId: target.id });
    h.engine.pointToolDragEnd();
    expect(h.store.getState().moduleDirty[SEEG]).toBeUndefined();
  });

  /**
   * The engine's Esc grammar is place → select → off (§4.7), and the step that matters is the first.
   *
   * The first step emits nothing at all — `setPointTool`'s non-null branch is silent — so a module
   * mirroring the mode in a flag of its own goes stale on the first press. The second emits
   * `cleared`, and what the module does with it changed on 2026-08-30: **select is the module's
   * resting state** (§13.3), so it puts the tool straight back in `select`. What Escape must never
   * do is come back in `place` — that was the bug that made every click keep dropping a contact.
   */
  it('takes Escape out of place mode and leaves select armed, never place', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'add');
    expect(h.engine.pointTool()?.mode).toBe('place');
    h.engine.pointToolClick('axial', 260, 260);
    expect(contactsLayer(h).points).toHaveLength(16);

    // Esc #1: place → select. Silent, which is exactly the step a module-local flag misses.
    expect(h.engine.cancelPointTool()).toBe(true);
    expect(h.engine.pointTool()?.mode).toBe('select');
    // Esc #2: the engine clears it and the module arms `select` again — not `place`.
    expect(h.engine.cancelPointTool()).toBe(true);
    expect(h.engine.pointTool()).toMatchObject({
      layerId: contactsLayer(h).id,
      mode: 'select',
    });

    // A click now places nothing, which is the whole point of having pressed Escape…
    h.engine.pointToolClick('axial', 240, 240);
    expect(contactsLayer(h).points).toHaveLength(16);
    // …and `a` still turns placing back on.
    await h.controller.moduleCommand(SEEG, 'add');
    expect(h.engine.pointTool()?.mode).toBe('place');
  });

  /**
   * §13.3 (2026-08-30): while the panel is open, a plain click on a contact selects it.
   *
   * The owner's report was that clicking contacts did not move the electrode dropdown. The tool is
   * armed after a load — that part was already true — but three ordinary things cleared it and
   * nothing put it back: `Esc`, deleting the selected contact (which clears the *selection* and
   * used to be read as a disarm), and a scene the module had already been through. An unarmed left
   * click is §7.5's R1 cursor-set, which never hit-tests, so the dropdown, the ring and the
   * crosshair all stop following the pointer with nothing on screen to say why.
   */
  it('answers a click on a contact after Escape, with no explicit re-arming', async () => {
    const h = await loadSubject();
    const b01 = pointNamed(h, 'B01');
    // Start on A, and press Escape to the point where the tool used to be gone for good.
    expect(h.engine.cancelPointTool()).toBe(true);
    expect(h.engine.pointTool()?.mode).toBe('select');

    // Put the crosshair on B01 so its disc is on this slice, and click where it is drawn.
    h.engine.setCursor(b01.position);
    const axial = h.engine.scene.slices.find((s) => s.mode === 'axial');
    h.engine.pointToolClick(axial?.id ?? 'axial', 256, 256);
    expect(h.engine.pointSelection()?.pointId).toBe(b01.id);

    // …and the module's own `electrode` followed it, which is what the dropdown renders. Asked
    // through `refit`, whose toast names the electrode it acted on: the module was on A a moment
    // ago, so this is the click having moved it. (The rendered `<select>` is asserted in
    // `e2e/module-seeg.spec.ts`; vitest runs under `environment: 'node'`.)
    await h.controller.moduleCommand(SEEG, 'refit');
    const toast = h.store.getState().toasts.at(-1);
    expect(toast?.detail ?? '').toContain('Re-fitted B');
  });

  it('stays armed when the selected contact is deleted', async () => {
    // Deleting the selection emits `cleared` with `reason: 'selection'` — the tool never moved. It
    // used to be read as a disarm, which left the module's intent false while the engine was still
    // armed, so the next scene load never re-armed it.
    const h = await loadSubject();
    const a03 = pointNamed(h, 'A03');
    h.engine.setPointSelection({ layerId: contactsLayer(h).id, pointId: a03.id });
    await h.controller.moduleCommand(SEEG, 'delete');
    expect(h.engine.pointTool()).toMatchObject({ mode: 'select' });

    // …and the re-arm after a layer replacement still works, which is what the flag gates.
    const gone = contactsLayer(h);
    h.engine.removeLayer(gone.id);
    const rebuilt = h.engine.addLayer({
      datasetId: gone.datasetId,
      kind: 'points',
      module: SEEG,
      points: [{ id: 'c1', name: 'A01', group: 'A', ordinal: 1, position: [0, 0, 0] }],
    });
    expect(h.engine.pointTool()).toMatchObject({ layerId: rebuilt.id, mode: 'select' });
  });

  it('lets measure mode have the click, and does not fight it back', async () => {
    // §7.5 arms one click-consuming mode at a time. A module that re-armed on every `cleared` would
    // turn measure mode straight off again — `setPointTool` disarms it — so `m` would do nothing at
    // all while this panel is open. `reason: 'measure'` is what tells the two apart.
    const h = await loadSubject();
    h.engine.setMeasureMode(true);
    expect(h.engine.measureMode()).toBe(true);
    expect(h.engine.pointTool()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(h.engine.measureMode()).toBe(true);
    expect(h.engine.pointTool()).toBeNull();
  });

  it('takes the Add toggle from the engine, not from a flag that Escape left stale', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'add');
    expect(h.engine.pointTool()?.mode).toBe('place');
    h.engine.cancelPointTool(); // place → select, with no event

    // One press of Add has to put place mode back. With a module-local `placing` still reading
    // true this pressed "off" and left the tool selecting, while the panel's `aria-pressed` — the
    // same field — showed the button held down the whole time.
    await h.controller.moduleCommand(SEEG, 'add');
    expect(h.engine.pointTool()?.mode).toBe('place');
    // The status cell is the module's own view of the flag, and it agrees with the engine.
    expect(h.store.getState().moduleStatus[SEEG]).toContain('place');
  });

  it('comes back armed when the scene puts a new layer under it', async () => {
    // The other half of `cleared`: `Engine.load` disarms at its start and removing the tool's layer
    // disarms with it. Neither is a request to stop, so the module re-arms against the layer the
    // scene put back — which is what the Escape rule above must not have cost.
    const h = await loadSubject();
    const gone = contactsLayer(h);
    h.engine.removeLayer(gone.id);
    expect(h.engine.pointTool()).toBeNull();

    const rebuilt = h.engine.addLayer({
      datasetId: gone.datasetId,
      kind: 'points',
      module: SEEG,
      points: [{ id: 'c1', name: 'A01', group: 'A', ordinal: 1, position: [0, 0, 0] }],
    });
    expect(h.engine.pointTool()).toMatchObject({ layerId: rebuilt.id, mode: 'select' });
  });
});

describeSeeg('saving', () => {
  it('writes the table, its backup and its editlog', async () => {
    const h = await loadSubject();
    h.fs.savePath = TSV;
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    await h.controller.moduleCommand(SEEG, 'save-as');

    expect(h.fs.writes.map((w) => w.path)).toEqual([
      TSV,
      `${DERIV}/ieeg/sub-P076_space-T1w_electrodes_editlog.json`,
    ]);
    // The table asks for a backup; the editlog does not — it is a new file every time.
    expect(h.fs.writes[0]?.backup).toBe(true);
    expect(h.fs.writes[1]?.backup).toBe(false);
    expect(h.fs.files.has(`${TSV}.20260830-101500.bak`)).toBe(true);

    const table = h.fs.writes[0]?.text ?? '';
    expect(table.includes('\r')).toBe(false);
    expect(table.split('\n')[0]).toBe('name\telectrode\tcontact\tcsc\tx\ty\tz\tstatus');
    // Every contact of A moved, so every one of its rows says `edited`; the others keep `located`.
    expect(table).toMatch(/\nA01\tA\t1\t1\t[-\d.]+\t[-\d.]+\t[-\d.]+\tedited\n/);
    expect(table).toContain('\tlocated\n');

    const log = JSON.parse(h.fs.writes[1]?.text ?? '{}') as {
      n_contacts: number;
      edited: number;
      contacts: { name: string; change: string }[];
      electrodes: { name: string; snapped: boolean }[];
    };
    expect(log.n_contacts).toBe(15);
    expect(log.edited).toBe(6);
    expect(log.contacts.every((c) => c.change === 'edited')).toBe(true);
    expect(log.electrodes.find((e) => e.name === 'A')?.snapped).toBe(true);
    expect(h.store.getState().moduleDirty[SEEG]).toBeUndefined();
  });

  it('reuses the admitted path on the next Save, without a second sheet', async () => {
    const h = await loadSubject();
    h.fs.savePath = TSV;
    await h.controller.moduleCommand(SEEG, 'save-as');
    h.fs.savePath = null; // a second sheet would now cancel
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    await h.controller.moduleCommand(SEEG, 'save');
    expect(h.fs.writes.filter((w) => w.path === TSV)).toHaveLength(2);
  });

  it('writes an unchanged table with the coordinates it read', async () => {
    const h = await loadSubject();
    h.fs.savePath = TSV;
    await h.controller.moduleCommand(SEEG, 'save-as');
    const written = h.fs.writes[0]?.text ?? '';
    const source = h.fs.files.get(`${TSV}.20260830-101500.bak`) ?? '';
    // Compared as numbers: the writer emits Python `repr` (`-11.0`), and the fixture above was
    // built with JavaScript's own `String` (`-11`). The property is that the VALUE survives.
    const coordinate = (text: string, name: string): number[] =>
      (text.split('\n').find((line) => line.startsWith(`${name}\t`)) ?? '')
        .split('\t')
        .slice(4, 7)
        .map(Number);
    expect(coordinate(written, 'A01')).toEqual(coordinate(source, 'A01'));
    // …and the writer really did use `repr`: an integral coordinate keeps its `.0`.
    expect(written).toContain('-11.0\t');
  });

  /**
   * Provenance is per **table**, not per window (§13.6's sidecar is a contract with `seegprep`).
   *
   * Anatomical naming means the next subject's shafts are usually called what this one's were, so a
   * session that kept the operation flags would tell a reviewer that a snap ran on electrodes it
   * never touched — in the one file whose whole purpose is answering "what was changed?".
   */
  it('does not carry one table’s operations into the next table’s editlog', async () => {
    const NEXT = `${DERIV}/ieeg/sub-P077_space-T1w_electrodes.tsv`;
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    await h.controller.moduleCommand(SEEG, 'refit');

    // The second subject's table, through the module's own reader route — the same live instance,
    // because `activateModule` early-returns for the module already in the slot.
    h.fs.files.set(NEXT, phantomTable(0.2));
    expect(await h.controller.moduleInstance()?.openPath?.('electrodes', NEXT)).toBe(true);

    h.fs.savePath = NEXT;
    await h.controller.moduleCommand(SEEG, 'save-as');
    const log = JSON.parse(h.fs.writes.at(-1)?.text ?? '{}') as {
      electrodes: { name: string; snapped: boolean; refit: boolean }[];
    };
    expect(log.electrodes.map((e) => e.name)).toContain('A');
    expect(log.electrodes.some((e) => e.snapped || e.refit)).toBe(false);
  });

  /**
   * §13.3's discard guard covered New, Open scene and Close dataset — and not the route that most
   * looks like "the next subject": opening another electrodes table.
   */
  it('asks before another table throws unsaved contact edits away', async () => {
    const NEXT = `${DERIV}/ieeg/sub-P077_space-T1w_electrodes.tsv`;
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    const edited = pointNamed(h, 'A01').position;
    expect(h.store.getState().moduleDirty[SEEG]).toBe(true);

    h.fs.files.set(NEXT, phantomTable(0.2));
    h.controller.open([{ name: 'next', path: NEXT, source: { kind: 'path', path: NEXT } }]);
    await until(() => h.store.getState().dialog === 'confirm', 'the discard question');
    // Three buttons, because the manifest declares a `save` command: Save… / Discard / Cancel.
    expect(h.store.getState().confirm?.buttons).toHaveLength(3);

    h.controller.resolveConfirm(2); // Cancel
    await until(() => h.store.getState().dialog === 'none', 'the dialog to close');
    // The edits are still there, and the table that was refused was not opened as a mesh either:
    // the reader claimed it, so `runOne` stopped rather than toasting "unsupported".
    expect(pointNamed(h, 'A01').position).toEqual(edited);
    expect(h.store.getState().moduleDirty[SEEG]).toBe(true);
    expect(h.store.getState().toasts.some((t) => /unsupported/i.test(t.detail ?? ''))).toBe(false);
  });

  it('opens the next table once the guard is answered with Discard', async () => {
    const NEXT = `${DERIV}/ieeg/sub-P077_space-T1w_electrodes.tsv`;
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'snap-electrode');

    h.fs.files.set(NEXT, phantomTable(0.2));
    h.controller.open([{ name: 'next', path: NEXT, source: { kind: 'path', path: NEXT } }]);
    await until(() => h.store.getState().dialog === 'confirm', 'the discard question');
    h.controller.resolveConfirm(1); // Discard
    await until(
      () => h.store.getState().moduleDirty[SEEG] !== true,
      'the second table to be loaded'
    );
    expect(contactsLayer(h).points).toHaveLength(15);
  });

  /**
   * A renumber is the one edit that rewires a table's `csc` / channel mapping, and it moves nothing
   * — so a diff keyed on position alone reported `added: 0, edited: 0` and no rows at all for it.
   */
  it('names every contact a renumber renamed, old name beside new', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'renumber');
    // The panel's own counter agrees: a renumber is a change, not "0 changed" beside a dirty dot.
    expect(h.store.getState().moduleStatus[SEEG]).toContain('edited');

    h.fs.savePath = TSV;
    await h.controller.moduleCommand(SEEG, 'save-as');
    const log = JSON.parse(h.fs.writes.at(-1)?.text ?? '{}') as {
      renamed: number;
      edited: number;
      contacts: { name: string; change: string; renamed_from?: string }[];
    };
    // The phantom's A is numbered from the entry, so Renumber reverses all six names.
    expect(log.renamed).toBe(6);
    expect(log.edited).toBe(0);
    const renamed = log.contacts.filter((c) => c.change === 'renamed');
    expect(renamed).toHaveLength(6);
    expect(renamed.find((c) => c.name === 'A06')?.renamed_from).toBe('A01');
  });

  /**
   * §13.2 calls leaving the slot non-destructive *because* the module restores through its block —
   * which was true of everything except the deletions, the one edit the layer cannot carry.
   */
  it('remembers the contacts it deleted across a trip through the block', async () => {
    const h = await loadSubject();
    for (const name of ['A03', 'A04']) {
      const target = pointNamed(h, name);
      h.engine.setPointSelection({ layerId: contactsLayer(h).id, pointId: target.id });
      await h.controller.moduleCommand(SEEG, 'delete');
    }
    expect(contactsLayer(h).points).toHaveLength(13);

    h.controller.deactivateModule();
    expect(await h.controller.activateModule(SEEG)).toBe(true);
    expect(contactsLayer(h).points).toHaveLength(13);

    h.fs.savePath = TSV;
    await h.controller.moduleCommand(SEEG, 'save-as');
    const log = JSON.parse(h.fs.writes.at(-1)?.text ?? '{}') as {
      deleted: number;
      contacts: { name: string; change: string }[];
    };
    expect(log.deleted).toBe(2);
    expect(log.contacts.filter((c) => c.change === 'deleted').map((c) => c.name)).toEqual([
      'A03',
      'A04',
    ]);

    // …and Revert can still keep the promise its own toast makes.
    await h.controller.moduleCommand(SEEG, 'revert');
    expect(contactsLayer(h).points).toHaveLength(15);
  });
});

describeSeeg('the scene block', () => {
  const SCENE = `${DERIV}/sub-P076.tetravox.json`;

  /** Save the scene, and hand its text back the way a second window would read it off disk. */
  async function savedScene(h: Harness): Promise<string> {
    h.fs.scenePath = SCENE;
    await expect(h.controller.saveSceneAs()).resolves.toBe(true);
    return h.fs.files.get(SCENE) as string;
  }

  it('restores provenance after a save → load round trip', async () => {
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'snap-electrode');
    const text = await savedScene(h);
    expect(JSON.parse(text).extensions[SEEG].module).toBe(SEEG);

    // A fresh window, opening the same scene.
    const second = await harness({ [SCENE]: text, [CT]: 'a volume' });
    await expect(second.controller.openScenePath(SCENE)).resolves.toBe(true);
    expect(second.store.getState().activeModule).toBe(SEEG);
    const layer = contactsLayer(second);
    expect(layer.points).toHaveLength(15);
    expect(layer.offPlaneOpacity).toBe(0.6);
    const block = second.store.getState().moduleBlocks[SEEG];
    expect(JSON.stringify(block?.data)).toContain('sub-P076_space-T1w_electrodes.tsv');
    // The module knows the contacts were edited, which only the block can have told it: every one
    // of A's rows still says `edited` rather than `kept`.
    second.fs.savePath = TSV;
    await second.controller.moduleCommand(SEEG, 'save-as');
    expect(second.fs.writes[0]?.text).toContain('\tedited\n');
  });

  it('remembers a hidden wire, which the layer alone could not (A2)', async () => {
    // §4.6 does not serialise `lineSegments`, so a scene reopened without the block puts every
    // shaft back — which is why the switch is in the block and not left to the layer.
    const h = await loadSubject();
    await h.controller.moduleCommand(SEEG, 'wire');
    expect(contactsLayer(h).lineSegments).toHaveLength(0);
    const text = await savedScene(h);
    expect(JSON.parse(text).extensions[SEEG].data.wire).toBe(false);

    const second = await harness({ [SCENE]: text, [CT]: 'a volume' });
    await expect(second.controller.openScenePath(SCENE)).resolves.toBe(true);
    expect(contactsLayer(second).lineSegments).toHaveLength(0);
    // …and turning it back on rebuilds both arrays against the restored set.
    await second.controller.moduleCommand(SEEG, 'wire');
    expect(contactsLayer(second).lineSegments).toHaveLength(12 * 6);
    expect(contactsLayer(second).lineColors).toHaveLength(12 * 4);
  });

  it('degrades honestly when a build without the module dropped the block', async () => {
    const h = await loadSubject();
    const spec = JSON.parse(await savedScene(h)) as Record<string, unknown>;
    delete spec['extensions'];
    const stripped = JSON.stringify(spec);

    const second = await harness({ [SCENE]: stripped, [CT]: 'a volume' });
    await expect(second.controller.openScenePath(SCENE)).resolves.toBe(true);
    // Nothing activates: with no block there is no `onSceneBlock` route, so the user opens it.
    await second.controller.activateModule(SEEG);
    // The contacts survive — they are core-typed layer points (§13.2) …
    expect(contactsLayer(second).points).toHaveLength(15);
    // … and the module says the provenance is gone rather than writing a table of `added` rows.
    const toasts = second.store.getState().toasts.map((t) => t.detail ?? '');
    expect(toasts.some((t) => /provenance/i.test(t))).toBe(true);
  });
});

describeSeeg('operations (§13.6)', () => {
  it('runs every declared operation through the same code as the panel', async () => {
    const h = await loadSubject();
    const instance = h.controller.moduleInstance();
    expect(instance?.runOperation).toBeDefined();

    const loaded = (await instance?.runOperation?.('load', { ct: CT, tsv: TSV })) as {
      contacts: number;
      electrodes: number;
    };
    expect(loaded).toMatchObject({ contacts: 15, electrodes: 3 });

    const snapped = (await instance?.runOperation?.('snap', { scope: 'all', radiusMm: 1.5 })) as {
      moved: number;
      meanShiftMm: number;
    };
    expect(snapped.moved).toBe(15);
    expect(snapped.meanShiftMm).toBeGreaterThan(0.5);

    const refitted = (await instance?.runOperation?.('refit', { electrode: 'B' })) as {
      electrodes: { electrode: string; rmsMm: number }[];
    };
    expect(refitted.electrodes).toHaveLength(1);
    expect(refitted.electrodes[0]?.electrode).toBe('B');

    const renumbered = (await instance?.runOperation?.('renumber', {})) as {
      electrodes: { electrode: string }[];
    };
    expect(renumbered.electrodes.map((e) => e.electrode)).toEqual(['A', 'B', 'C']);

    expect(await instance?.runOperation?.('ghost', { on: false })).toEqual({ ghost: false });
    expect(contactsLayer(h).offPlaneOpacity).toBe(0);

    expect(await instance?.runOperation?.('wire', { on: false })).toEqual({ wire: false });
    expect(contactsLayer(h).lineSegments).toHaveLength(0);
    expect(await instance?.runOperation?.('wire', { on: true })).toEqual({ wire: true });
    expect(contactsLayer(h).lineSegments).toHaveLength(12 * 6);

    // The third display switch (2026-08-30), through the stepper's own function: it writes §4.4's
    // `dotRadiusPx` and it is held to the panel's 2–12, so a job cannot ask for a marker the panel
    // could not make — and it answers with the size it settled on rather than the one it was given.
    expect(await instance?.runOperation?.('size', { px: 7 })).toEqual({ dotRadiusPx: 7 });
    expect(contactsLayer(h).dotRadiusPx).toBe(7);
    expect(await instance?.runOperation?.('size', { px: 40 })).toEqual({ dotRadiusPx: 12 });
    expect(contactsLayer(h).dotRadiusPx).toBe(12);
    expect(await instance?.runOperation?.('size', { px: 4 })).toEqual({ dotRadiusPx: 4 });

    const stats = (await instance?.runOperation?.('stats', {})) as {
      electrodes: { electrode: string; n: number }[];
    };
    expect(stats.electrodes.map((e) => e.n)).toEqual([6, 5, 4]);

    const saved = (await instance?.runOperation?.('save', {
      out: 'sub-P076_space-T1w_electrodes.tsv',
    })) as { path: string; editlog: string };
    expect(saved.path).toBe(TSV);
    expect(saved.editlog).toBe(`${DERIV}/ieeg/sub-P076_space-T1w_electrodes_editlog.json`);
  });

  /**
   * The `ct` a job **named** beats the volume the name heuristic would have guessed.
   *
   * A pre-op CT beside a post-implant one is the ordinary sEEG scene and both basenames say "ct", so
   * `chooseVolume`'s "the first volume whose name contains a standalone ct" answers the pre-op one —
   * the volume with no electrodes in it. Everything downstream rides on that binding: the layer's
   * carrier, the 150 HU display preset, and every `peakCentroid` a snap takes.
   */
  it('binds the CT the load operation named, not the first volume that looks like one', async () => {
    const PREOP = `${DERIV}/ct/sub-P076_acq-preop_space-T1w_ct.nii.gz`;
    const TABLE = `${DERIV}/ieeg/sub-P076_desc-job_electrodes.tsv`;
    const h = await harness({ [PREOP]: 'a volume', [CT]: 'a volume', [TABLE]: phantomTable() });
    // `scene.files` order: the pre-op CT lands first, exactly as a job listing it first would.
    h.controller.open([
      { name: 'preop', path: PREOP, source: { kind: 'path', path: PREOP } },
      { name: 'bone', path: CT, source: { kind: 'path', path: CT } },
    ]);
    await until(() => h.store.getState().datasets.length === 2, 'both CTs');
    expect(await h.controller.activateModule(SEEG)).toBe(true);

    const result = await h.controller
      .moduleInstance()
      ?.runOperation?.('load', { ct: CT, tsv: TABLE });
    expect(result).toMatchObject({ contacts: 15, bound: true });

    const bone = h.store.getState().datasets.find((d) => d.path === CT);
    const preop = h.store.getState().datasets.find((d) => d.path === PREOP);
    expect(bone?.id).not.toBe(preop?.id);
    expect(contactsLayer(h).datasetId).toBe(bone?.id);
    // …and the display preset went to the CT that was named, not to the other one.
    const volumeOn = (datasetId?: string): { threshold?: { lo: number } } | undefined =>
      h.store.getState().layers.find((l) => l.kind === 'volume' && l.datasetId === datasetId) as
        { threshold?: { lo: number } } | undefined;
    expect(volumeOn(bone?.id)?.threshold?.lo).toBe(150);
    expect(volumeOn(preop?.id)?.threshold?.lo).not.toBe(150);
  });

  /**
   * The three appended 2026-08-30, and the workflow that made them necessary.
   *
   * `tip: 'auto'` is a heuristic, `renumber` applies whatever the tip currently is, and a job had no
   * way to say "the other end" — so a headless load → renumber → save on a shaft the heuristic read
   * backwards numbered it tip-last with no remedy at all. That is the automation-only gap §13.6
   * says cannot exist, on the very workflow this module was written for.
   */
  it('flips a tip, reverts and deletes from a job, exactly as the panel does', async () => {
    const h = await loadSubject();
    const instance = h.controller.moduleInstance();
    const nameOf = (id: string): string =>
      (contactsLayer(h).points ?? []).find((p) => p.id === id)?.name ?? '';

    // The phantom's A is numbered from the entry, so the heuristic renumbers it in reverse …
    await instance?.runOperation?.('renumber', { electrode: 'A' });
    expect(nameOf('c1')).toBe('A06');
    // … and the flip is the remedy a panel user has with `t`, now available to a job file.
    expect(await instance?.runOperation?.('flip-tip', { electrode: 'A' })).toEqual({
      electrodes: [{ electrode: 'A', tip: expect.stringMatching(/^(low|high)$/) as unknown }],
    });
    await instance?.runOperation?.('renumber', { electrode: 'A' });
    expect(nameOf('c1')).toBe('A01');

    // Named, never "the selected one" — a job has no selection.
    expect(await instance?.runOperation?.('delete', { contact: 'A03' })).toEqual({
      deleted: 'A03',
      contacts: 14,
    });
    expect(contactsLayer(h).points).toHaveLength(14);

    // Revert brings the deletion back and puts every position where the table had it.
    expect(await instance?.runOperation?.('revert', {})).toEqual({ contacts: 15, restored: 1 });
    expect(contactsLayer(h).points).toHaveLength(15);
  });

  it('flips every electrode when the job names none, and refuses a contact it has not got', async () => {
    const h = await loadSubject();
    const instance = h.controller.moduleInstance();
    const flipped = (await instance?.runOperation?.('flip-tip', {})) as {
      electrodes: { electrode: string }[];
    };
    expect(flipped.electrodes.map((e) => e.electrode)).toEqual(['A', 'B', 'C']);
    await expect(instance?.runOperation?.('delete', { contact: 'Z99' })).rejects.toThrow(
      /no contact called/
    );
    await expect(instance?.runOperation?.('delete', {})).rejects.toThrow(/needs a `contact`/);
  });

  it('refuses an operation it does not have, and a bad snap scope', async () => {
    const h = await loadSubject();
    const instance = h.controller.moduleInstance();
    await expect(instance?.runOperation?.('fly', {})).rejects.toThrow(/no operation/);
    await expect(instance?.runOperation?.('snap', { scope: 'sideways' })).rejects.toThrow(/scope/);
  });
});

/**
 * `load`'s optional `t1` (§13.6's `t1: 'path?'`).
 *
 * The argument was declared and never read: a job could name a T1, main would allow-list it, and
 * nothing whatsoever happened. What the module can *honestly* do with it is bounded by §13.1 — it
 * has no `addDataset`, so it cannot open the file — which leaves two outcomes, and both are asserted
 * because the difference between them is the whole value of the argument. Either the volume is
 * already in the scene, and it gets the T1 half of the display preset plus a line of provenance in
 * the block, or it is not, and the operation *says so* in its result, where a job author reading
 * `job-result.json` will find it.
 */
describeSeeg('the load operation’s T1', () => {
  const T1 = '/bids/derivatives/SimNIBS/sub-P076/m2m_P076/T1.nii.gz';

  function volumeLayerFor(h: Harness, path: string): Layer | undefined {
    const dataset = h.store.getState().datasets.find((d) => d.path === path);
    if (dataset === undefined) return undefined;
    return h.store.getState().layers.find((l) => l.kind === 'volume' && l.datasetId === dataset.id);
  }

  /** `loadSubject`, plus the T1 opened as a second volume — the way a job's `scene.files` opens it. */
  async function withT1(): Promise<Harness> {
    const h = await loadSubject();
    h.controller.open([{ name: 'T1.nii.gz', path: T1, source: { kind: 'path', path: T1 } }]);
    await until(() => volumeLayerFor(h, T1) !== undefined, 'the T1 layer');
    return h;
  }

  it('shows an open T1 in plain grey and records it in the block', async () => {
    const h = await withT1();
    const before = volumeLayerFor(h, T1) as Layer;
    // Hidden and half-transparent first, so "visible, grey, opaque" is something the operation did
    // rather than something the layer already was.
    h.controller.toggleVisible(before.id);
    h.controller.setOpacity(before.id, 0.4);
    expect(volumeLayerFor(h, T1)?.visible).toBe(false);

    const result = await h.controller
      .moduleInstance()
      ?.runOperation?.('load', { ct: CT, tsv: TSV, t1: T1 });
    expect(result).toMatchObject({ contacts: 15, electrodes: 3, bound: true, t1: 'shown' });

    expect(volumeLayerFor(h, T1)).toMatchObject({ visible: true, opacity: 1, colormap: 'gray' });
    // The CT keeps its own half: the 150 HU floor is what makes the T1 underneath worth showing.
    const ct = volumeLayerFor(h, CT) as unknown as { colormap: string; threshold: { lo: number } };
    expect(ct.colormap).toBe('gray');
    expect(ct.threshold.lo).toBe(150);

    // Provenance — and §13.2's rule about what a block may name is still true with a path in it.
    const block = h.store.getState().moduleBlocks[SEEG];
    expect((block?.data as { source: { t1: string } }).source.t1).toBe(T1);
    expect(block?.version).toBe(1);
    expect(JSON.stringify(block?.data)).not.toContain(before.id);
  });

  it('reports `not-open` for a T1 the scene does not have, and loads the table anyway', async () => {
    const h = await loadSubject();
    const result = await h.controller
      .moduleInstance()
      ?.runOperation?.('load', { ct: CT, tsv: TSV, t1: T1 });
    // Everything else the operation did still stands: this is a report, not a failure.
    expect(result).toMatchObject({ contacts: 15, electrodes: 3, bound: true, t1: 'not-open' });
    // And nothing was opened, because a module cannot — which is why the answer is a message.
    expect(h.store.getState().layers.filter((l) => l.kind === 'volume')).toHaveLength(1);
    const block = h.store.getState().moduleBlocks[SEEG];
    expect((block?.data as { source: { t1: string | null } }).source.t1).toBeNull();
  });

  it('says nothing at all about a T1 the job never named', async () => {
    const h = await withT1();
    const result = (await h.controller
      .moduleInstance()
      ?.runOperation?.('load', { ct: CT, tsv: TSV })) as Record<string, unknown>;
    // Absent reproduces the previous behaviour exactly, which is what makes the field additive.
    expect(Object.keys(result)).toEqual(['contacts', 'electrodes', 'bound']);
    const block = h.store.getState().moduleBlocks[SEEG];
    expect((block?.data as { source: { t1: string | null } }).source.t1).toBeNull();
  });
});

describeSeeg('the host’s active plane', () => {
  it('is the active pane’s normal through the cursor, and null in 3D', async () => {
    const h = await loadSubject();
    h.controller.setActiveView('axial');
    h.controller.setCursorWorld([1, 2, 3]);
    expect(h.controller.activePlane()).toEqual({ normal: [0, 0, 1], point: [1, 2, 3] });
    h.controller.setActiveView('view3d');
    expect(h.controller.activePlane()).toBeNull();
  });
});
