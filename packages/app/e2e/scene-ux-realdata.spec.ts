/**
 * **Directed task 13's gate**: a rich scene, saved with ⌘S, reopened in a *new process* by
 * **dropping the file on the window**, and judged twice — once on `serialize()` and once on the
 * pixels.
 *
 * Why both. A `ViewSpec` comparison proves the state came back; it does not prove the state is what
 * the renderer is drawing from, and every field this task added (a clip plane, an isolation, hidden
 * tissues, a recoloured region, an electrode net, a camera) is a field whose *only* visible effect
 * is in the pane. A screenshot comparison proves the picture; on its own it cannot say which of
 * fifty fields is wrong. Together they are the assertion the maintainer asked for: "the whole scene
 * comes back".
 *
 * The drop is a **real** drop, not a call to `openScenePath`: the file is loaded into a throw-away
 * `<input type="file">` so that the `File` the test dispatches has a path on disk behind it — which
 * is exactly what `webUtils.getPathForFile` reads, and what a synthesised `new File([…])` does not
 * have. Nothing in `src/` knows this test exists.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 */

/* eslint-disable no-empty-pattern */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const M2M = join(ROOT, 'm2m_ernie');
const T1 = join(M2M, 'T1.nii.gz');
/** The 57-value float32 label volume of AGENTS.md, with its SimNIBS LUT beside it. */
const ATLAS = join(M2M, 'segmentation', 'labeling.nii.gz');
const ERNIE = join(M2M, 'ernie.msh');
/** SimNIBS's electrode positions: 187 `SP` points and 187 `T3` labels (§6.2, directed task 6). */
const GEO = join(M2M, 'eeg_positions', 'GSN-HydroCel-185.geo');

/** `T1.nii.gz`'s affine (AGENTS.md) says voxel (128, 128, 104) is this world point. */
const CURSOR: [number, number, number] = [-99.737457 + 104, 154.1875 - 128, -143.642273 + 128];

/** Every dataset a rich scene needs, in the order the layers come out. */
const INPUTS = [T1, ATLAS, ERNIE, GEO];

async function boot(
  target: LaunchTarget,
  opts: { args?: string[]; userDataDir?: string } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, {
    search: 'engine=real',
    ...(opts.args !== undefined ? { args: opts.args } : {}),
    ...(opts.userDataDir !== undefined ? { userDataDir: opts.userDataDir } : {}),
  });
  const page = await app.firstWindow();
  // A fixed content size, because the screenshot leg compares two launches pixel for pixel.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const rect = document.querySelector('[data-testid="view-grid"]')?.getBoundingClientRect();
      return rect !== undefined && rect.width > 0 && rect.height > 0;
    },
    undefined,
    { timeout: 30_000 }
  );
  return { app, page };
}

async function waitForLayers(page: Page, count: number, timeout = 240_000): Promise<void> {
  await page.waitForFunction(
    (n) => (window.__tetravox?.store.getState().layers.length ?? 0) >= n,
    count,
    { timeout }
  );
}

/** Let every pending build (caps, isosurfaces, the 3D pane) settle before a screenshot. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__tetravox?.engine?.whenSettled();
  });
  await page.waitForTimeout(500);
}

/**
 * The scene as a comparable value: `serialize()` with everything a reload is *allowed* to change
 * stripped out.
 *
 * Ids are re-issued by `addDataset` / `addLayer` on every load (§4.6's whole remap exists because of
 * it), so they are replaced by their **position**, which carries the same information and is stable.
 * Dataset paths keep their basename only, so the relocated run — which reads the same bytes from a
 * different directory — compares equal to the original by design. Nothing else is touched: a field
 * that differs after this is a field the round trip lost.
 */
async function canonicalScene(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const engine = window.__tetravox?.engine;
    if (engine == null) throw new Error('__tetravox.engine missing');
    const spec = engine.serialize() as unknown as {
      datasets: { id: string; name: string; path: string; absPath?: string; fingerprint: string }[];
      layers: Record<string, unknown>[];
      activeLayerId: string | null;
      slices: Record<string, unknown>[];
      view3d: Record<string, unknown>;
      layout: { kind: string; cells: string[] };
      cursor: number[];
      radiological: boolean;
      background: number[];
      lighting: unknown;
      annotations: unknown;
      transparency: unknown;
      version: number;
    };
    const base = (p: string): string => p.split(/[/\\]/).pop() ?? p;
    const layerIndex = new Map(spec.layers.map((l, i) => [l['id'] as string, i]));
    const datasetIndex = new Map(spec.datasets.map((d, i) => [d.id, i]));
    const round = (v: unknown): unknown =>
      typeof v === 'number' ? Number(v.toFixed(4)) : Array.isArray(v) ? v.map(round) : v;
    const remapVisibility = (t: unknown): unknown => {
      if (t === undefined || t === null) return t;
      const out: Record<string, boolean> = {};
      for (const [id, on] of Object.entries(t as Record<string, boolean>)) {
        out[String(layerIndex.get(id) ?? id)] = on;
      }
      return out;
    };
    return {
      version: spec.version,
      datasets: spec.datasets.map((d) => ({
        // The **name** as the loader derived it, and the file it points at. The directory is not
        // compared: the relocated leg reads the same bytes from somewhere else on purpose.
        name: base(d.name),
        file: base(d.absPath ?? d.path),
        // The fingerprint IS compared: it is the same bytes, so it must be the same digest.
        fingerprint: d.fingerprint,
      })),
      layers: spec.layers.map((l) => {
        const { id: _id, datasetId, ...rest } = l as { id: string; datasetId: string };
        return {
          dataset: datasetIndex.get(datasetId) ?? null,
          ...(round(rest) as Record<string, unknown>),
        };
      }),
      activeLayer:
        spec.activeLayerId === null ? null : (layerIndex.get(spec.activeLayerId) ?? null),
      slices: spec.slices.map((s) => ({
        ...(round(s) as Record<string, unknown>),
        layerVisibility: remapVisibility(s['layerVisibility']),
      })),
      view3d: {
        ...(round(spec.view3d) as Record<string, unknown>),
        layerVisibility: remapVisibility(spec.view3d['layerVisibility']),
      },
      layout: spec.layout,
      cursor: round(spec.cursor),
      radiological: spec.radiological,
      background: spec.background,
      lighting: spec.lighting,
      annotations: spec.annotations,
      transparency: spec.transparency,
    };
  });
}

/** Mean absolute RGB difference per channel, 0…255. */
function meanDifference(a: Buffer, b: Buffer): number {
  const left = decodePng(a);
  const right = decodePng(b);
  expect([left.width, left.height], 'the two screenshots are the same size').toEqual([
    right.width,
    right.height,
  ]);
  let total = 0;
  for (let i = 0; i < left.pixels.length; i += 4) {
    total +=
      Math.abs((left.pixels[i] ?? 0) - (right.pixels[i] ?? 0)) +
      Math.abs((left.pixels[i + 1] ?? 0) - (right.pixels[i + 1] ?? 0)) +
      Math.abs((left.pixels[i + 2] ?? 0) - (right.pixels[i + 2] ?? 0));
  }
  return total / (left.pixels.length / 4) / 3;
}

/**
 * Build the scene the task names: a hidden and a recoloured atlas region, a clipped and isolated
 * head with two tissues hidden, the electrode net, the `1+3` layout, a zoom and a cursor.
 *
 * Driven through the engine facade rather than through the property editors: which control sets
 * `tagStyle[5].visible` is `props-*.spec.ts`'s question, and clicking forty of them here would make
 * a scene test fail for a reason that has nothing to do with scenes.
 */
async function buildRichScene(page: Page): Promise<void> {
  await page.evaluate((cursor) => {
    const tv = window.__tetravox;
    const engine = tv?.engine;
    if (engine == null || tv?.controller == null) throw new Error('__tetravox missing');
    const layers = engine.scene.layers;
    const atlas = layers.find(
      (l) => l.kind === 'volume' && l.name.includes('labeling')
    ) as (typeof layers)[number] & { kind: 'volume' };
    const mesh = layers.find((l) => l.kind === 'mesh') as (typeof layers)[number] & {
      kind: 'mesh';
    };
    const points = layers.find((l) => l.kind === 'points');

    // R5's per-region edits, both kinds: one region hidden, one recoloured. `visibleLabels` is a
    // `Uint32Array` at runtime and a plain array on disk — the one asymmetry of §4.6.
    const ids = (
      (engine.scene.datasets.get(atlas.datasetId) as { labelIds?: number[] }).labelIds ?? []
    ).filter((v) => v !== 0);
    engine.updateLayer(atlas.id, {
      opacity: 0.65,
      labelMode: 'both',
      outlineWidthPx: 2,
      visibleLabels: Uint32Array.from(ids.filter((v) => v !== ids[0])),
      labelColors: { [ids[1] as number]: [0.95, 0.2, 0.15, 1] },
      selectedLabels: [ids[1] as number],
    });

    // The mesh: a clip plane, an isolation, two tissues hidden, edges on.
    engine.updateLayer(mesh.id, {
      opacity: 0.85,
      clip: {
        planes: [{ plane: { normal: [1, 0, 0], offset: 0 }, enabled: true, followCursor: false }],
        caps: true,
        capColorMode: 'tag',
      },
      isolate: { tags: [1, 2, 3, 5], combine: 'any' },
      tagStyle: {
        ...(mesh as { tagStyle: Record<number, unknown> }).tagStyle,
        5: { visible: false, opacity: 1 },
        1005: { visible: false, opacity: 1 },
      },
      edges: { surface: true, caps: false },
    });

    if (points !== undefined) {
      engine.updateLayer(points.id, { showLabels: false, radiusMm: 4 });
    }

    tv.controller.setLayout('1+3');
    tv.controller.setCursorWorld(cursor as [number, number, number]);
    // A camera that is not the reset one, in the pane the layout makes large.
    const camera = engine.scene.view3d.camera;
    engine.setView(engine.scene.view3d.id, {
      camera: { ...camera, distance: camera.distance * 0.7 },
    });
    for (const view of engine.scene.slices) {
      engine.setView(view.id, { camera: { ...view.camera, mmPerPx: view.camera.mmPerPx * 0.6 } });
    }
    engine.requestRender();
  }, CURSOR);
}

/** Click a File-menu item by label, which is how ⌘S reaches the renderer (`main/menu.ts`). */
async function fileMenu(app: ElectronApplication, label: string): Promise<string> {
  return app.evaluate(({ Menu }, wanted) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File');
    const item = file?.submenu?.items.find((i) => i.label === wanted);
    if (item === undefined) throw new Error(`no File ▸ ${wanted}`);
    item.click();
    return item.accelerator ?? '';
  }, label);
}

/** Drop a real file on the shell, the way a user does (`webUtils.getPathForFile`, §8). */
async function dropFile(page: Page, path: string): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'e2e-drop-source';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);
  });
  // A `File` from an `<input>` has the OS path behind it, which is what the preload's
  // `webUtils.getPathForFile` reads. A `new File([bytes], name)` does not, and the app is right to
  // refuse one — so a test that synthesised its `File` would be testing the error branch.
  await page.setInputFiles('#e2e-drop-source', path);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#e2e-drop-source');
    const file = input?.files?.[0];
    if (file === undefined) throw new Error('the drop source has no file');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const shell = document.querySelector('[data-testid="shell"]');
    shell?.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
    );
    input?.remove();
  });
}

test.describe('scenes that just work (directed task 13)', () => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  let dir = '';
  let profile = '';
  let scenePath = '';
  let saved: unknown = null;
  let savedShot: Buffer | null = null;

  test.beforeAll(() => {
    // `realpathSync` because macOS's `/var` is a symlink to `/private/var`, and `main/paths.ts`
    // canonicalises everything it admits.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tetravox-scene-ux-')));
    profile = realpathSync(mkdtempSync(join(tmpdir(), 'tetravox-scene-ux-profile-')));
    scenePath = join(dir, 'rich.tetravox.json');
  });

  test.afterAll(() => {
    for (const path of [dir, profile])
      if (path !== '') rmSync(path, { recursive: true, force: true });
  });

  test('⌘S saves a rich scene beside the data, and the title bar says so', async ({}, info) => {
    test.setTimeout(600_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    const { app, page } = await boot(target, { args: INPUTS, userDataDir: profile });
    try {
      await waitForLayers(page, INPUTS.length);
      await buildRichScene(page);
      await settle(page);

      // The title bar before the save: no scene, but changes made — §8's dirty marker.
      await expect.poll(() => page.title(), { timeout: 10_000 }).toBe('Tetravox •');

      // What the Save sheet is offered. §8's ask is "default name next to the data": the directory
      // of the **first** dataset, not the last directory the OS remembers.
      const offered = await page.evaluate(() => {
        const engine = window.__tetravox?.engine;
        return engine == null ? '' : (engine.serialize().datasets[0]?.absPath ?? '');
      });
      expect(offered).toBe(T1);

      let requested = '';
      await app.evaluate(async ({ dialog }, target2) => {
        dialog.showSaveDialog = (async (_win: unknown, options: { defaultPath?: string } = {}) => {
          (globalThis as { __defaultPath?: string }).__defaultPath = options.defaultPath;
          return { canceled: false, filePath: target2 };
        }) as unknown as typeof dialog.showSaveDialog;
      }, scenePath);

      // ⌘S with no file attached is Save As — and it is the *menu* that runs it, accelerator and
      // all, which is what makes this an assertion about ⌘S rather than about a button.
      const accelerator = await fileMenu(app, 'Save Scene');
      expect(accelerator, '⌘S is Save Scene').toBe('CmdOrCtrl+S');
      expect(await fileMenu(app, 'Save Scene As…'), '⇧⌘S is Save As').toBe('CmdOrCtrl+Shift+S');

      await expect.poll(async () => existsSync(scenePath), { timeout: 60_000 }).toBe(true);
      requested = (await app.evaluate(
        () => (globalThis as { __defaultPath?: string }).__defaultPath ?? ''
      )) as string;
      expect(requested, 'the sheet opened beside the first dataset').toBe(
        join(M2M, 'T1.tetravox.json')
      );

      // The title bar after: the scene's name, and the dirty marker gone.
      await expect
        .poll(() => page.title(), { timeout: 10_000 })
        .toBe('rich.tetravox.json — Tetravox');

      // §4.6 on disk, at the version this branch writes, with the theme it was saved in.
      const onDisk = JSON.parse(readFileSync(scenePath, 'utf8')) as {
        version: number;
        theme?: string;
        datasets: { name: string; path: string; absPath?: string }[];
        layers: { kind: string }[];
      };
      expect(onDisk.version).toBe(2);
      expect(onDisk.theme).toBeDefined();
      expect(onDisk.layers.map((l) => l.kind)).toEqual(['volume', 'volume', 'mesh', 'points']);
      // Relative to the scene file, absolute fallback beside it (§4.6).
      expect(onDisk.datasets.every((d) => !d.path.startsWith('/'))).toBe(true);
      expect(onDisk.datasets.map((d) => d.absPath)).toEqual(INPUTS);

      saved = await canonicalScene(page);
      savedShot = await page.locator('[data-testid="view-grid"]').screenshot();

      // Saving is also what puts the scene at the head of File ▸ Open Recent.
      await expect
        .poll(
          async () => page.evaluate(() => window.__tetravox?.store.getState().recentScenes ?? []),
          { timeout: 20_000 }
        )
        .toEqual([scenePath]);
    } finally {
      await app.close();
    }
  });

  test('dropping the file on a fresh window brings the whole scene back', async ({}, info) => {
    test.setTimeout(600_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    expect(existsSync(scenePath), 'the save leg ran').toBe(true);
    expect(saved).not.toBeNull();

    // A **fresh process** against the same profile, so File ▸ Open Recent is the one the save wrote.
    const { app, page } = await boot(target, { userDataDir: profile });
    try {
      expect(
        await page.evaluate(() => window.__tetravox?.store.getState().layers.length ?? -1)
      ).toBe(0);

      // File ▸ Open Recent lists it, from `settings.json` and not from this session.
      const recent = await app.evaluate(({ Menu }) => {
        const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File');
        const item = file?.submenu?.items.find((i) => i.label === 'Open Recent');
        return item?.submenu?.items.map((i) => i.label) ?? [];
      });
      expect(recent[0]).toBe('rich.tetravox.json');

      await dropFile(page, scenePath);
      await waitForLayers(page, INPUTS.length);
      await settle(page);

      const restored = await canonicalScene(page);
      expect(restored, 'every field of the scene came back').toEqual(saved);
      await expect
        .poll(() => page.title(), { timeout: 10_000 })
        .toBe('rich.tetravox.json — Tetravox');

      const shot = await page.locator('[data-testid="view-grid"]').screenshot();
      // Two processes, two GPU contexts, one picture. The tolerance is for the compositor, not for
      // the scene: a single wrong field — a hidden tissue back, a clip plane gone, a region in the
      // wrong colour — moves thousands of pixels by tens of counts and lands far outside it.
      expect(meanDifference(savedShot as Buffer, shot)).toBeLessThan(2);
    } finally {
      await app.close();
    }
  });

  test('a scene whose data has moved relocates, and completes', async ({}, info) => {
    test.setTimeout(600_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    // Move the **data**, not the scene: copy the two small files somewhere else and write a scene
    // that points at where they used to be. The mesh is 184 MB and is left where it is — the
    // question §4.6 asks is per-ref, and one ref that cannot be found is the whole of the dialog.
    const moved = join(dir, 'moved-data');
    mkdirSync(moved, { recursive: true });
    cpSync(T1, join(moved, 'T1.nii.gz'));
    const brokenScene = join(dir, 'broken.tetravox.json');
    const text = readFileSync(scenePath, 'utf8')
      .replace(/T1\.nii\.gz/g, 'T1-moved.nii.gz')
      .replace(new RegExp(M2M.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), M2M);
    writeFileSync(brokenScene, text, 'utf8');

    const { app, page } = await boot(target, { userDataDir: profile });
    try {
      await dropFile(page, brokenScene);

      await expect(page.locator('[data-testid="relocate-dialog"]')).toBeVisible({
        timeout: 120_000,
      });
      const missing = await page.evaluate(
        () => window.__tetravox?.store.getState().relocate?.missing.map((m) => m.ref.name) ?? []
      );
      expect(missing).toEqual(['T1-moved.nii.gz']);

      // Point it at the copy that really is on disk, and let the load finish.
      await app.evaluate(
        async ({ dialog }, picked) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [picked],
          })) as typeof dialog.showOpenDialog;
        },
        join(moved, 'T1.nii.gz')
      );
      await page.click('[data-testid^="relocate-pick-"]');
      await page.click('[data-testid="relocate-confirm"]');

      await waitForLayers(page, INPUTS.length);
      const state = await page.evaluate(() => {
        const s = window.__tetravox?.store.getState();
        return {
          dialog: s?.dialog,
          error: s?.sceneError,
          paths: (s?.datasets ?? []).map((d) => d.path ?? null),
          kinds: (s?.layers ?? []).map((l) => l.kind),
        };
      });
      expect(state.dialog).toBe('none');
      expect(state.error).toBeNull();
      expect(state.paths[0]).toBe(join(moved, 'T1.nii.gz'));
      expect(state.kinds).toEqual(['volume', 'volume', 'mesh', 'points']);
    } finally {
      await app.close();
    }
  });
});
