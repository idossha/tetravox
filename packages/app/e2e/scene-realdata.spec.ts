/**
 * **A-SHELL's real-data gate item**: save a scene with `T1.nii.gz` + `ernie.msh`, relaunch, load it,
 * and assert the layers, the cursor and the layout came back.
 *
 * This runs against the **real** engine (`?engine=real`) on the reference dataset, and it relaunches
 * the app between the save and the load rather than reopening in the same window: a session that
 * still holds the datasets could restore a scene by doing nothing at all, which is exactly the bug
 * this is meant to catch.
 *
 * `docs/PHASE2-OWNERSHIP.md`, E-SCENE's real-data list, also asks for "a scene saved with
 * `ernie.msh` + `T1.nii.gz`, reopened from a **moved** directory, resolving through the relocate
 * dialog (A-SHELL's half) and reproducing the same three slice indices". The second test here is
 * that one, with the scene file moved rather than the 184 MB mesh — moving the scene is the same
 * §4.6 question (does the recorded pair still resolve?) at a thousandth of the IO, and it is the
 * direction a user actually hits when they mail a `.tetravox.json` to a colleague.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 */

/* eslint-disable no-empty-pattern */

import {
  existsSync,
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

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const ERNIE = join(ROOT, 'm2m_ernie', 'ernie.msh');

/** `T1.nii.gz`'s affine (AGENTS.md) says voxel (128, 128, 104) is this world point. */
const CURSOR: [number, number, number] = [-99.737457 + 104, 154.1875 - 128, -143.642273 + 128];

async function boot(
  target: LaunchTarget,
  args: string[] = []
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, { search: 'engine=real', args });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const grid = document.querySelector('[data-testid="view-grid"]');
      const rect = grid?.getBoundingClientRect();
      return rect !== undefined && rect.width > 0 && rect.height > 0;
    },
    undefined,
    { timeout: 30_000 }
  );
  return { app, page };
}

async function stubDialogs(
  app: ElectronApplication,
  paths: { save?: string; open?: string }
): Promise<void> {
  await app.evaluate(async ({ dialog }, { save, open }) => {
    dialog.showSaveDialog = (async () => ({
      canceled: save === undefined,
      filePath: save,
    })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({
      canceled: open === undefined,
      filePaths: open === undefined ? [] : [open],
    })) as typeof dialog.showOpenDialog;
  }, paths);
}

async function waitForLayers(page: Page, count: number, timeout = 180_000): Promise<void> {
  await page.waitForFunction(
    (n) => (window.__tetravox?.store.getState().layers.length ?? 0) >= n,
    count,
    { timeout }
  );
}

/** The state the restore is judged on, plus the three slice indices §11's Pick test uses. */
async function sceneState(page: Page) {
  return page.evaluate(() => {
    const tv = window.__tetravox;
    const state = tv?.store.getState();
    if (state === undefined || tv?.engine == null) throw new Error('__tetravox missing');
    const engine = tv.engine;
    // The slice index of the topmost volume layer, per pane — derived from the engine's own scene,
    // not from the DOM, so this asserts the restored *state* rather than a rendered label.
    const slices = engine.scene.slices.map((view) => ({
      id: view.id,
      mmPerPx: view.camera.mmPerPx,
      // `dot(normal, cursor)` is the plane offset §4.5 derives; equal offsets mean equal slices.
      offset: Number(
        (
          view.normal[0] * state.cursor[0] +
          view.normal[1] * state.cursor[1] +
          view.normal[2] * state.cursor[2]
        ).toFixed(4)
      ),
    }));
    return {
      // `Dataset.name` is `VolumeMeta.name`, which the loader derives from the source URL and which
      // is the whole absolute path on real data `[DATA]`. The basename is what a user calls the file.
      datasets: state.datasets.map((d) => ({
        name: (d.name.split(/[/\\]/).pop() ?? d.name) as string,
        kind: d.kind,
        path: d.path ?? null,
      })),
      layers: state.layers.map((l) => ({ kind: l.kind, name: l.name, visible: l.visible })),
      cursor: state.cursor.map((c) => Number(c.toFixed(4))),
      layoutKind: state.layoutKind,
      radiological: state.radiological,
      slices,
      sceneFile: state.sceneFile,
      sceneError: state.sceneError,
      dialog: state.dialog,
      relocateMissing:
        state.relocate?.missing.map(
          (m) => (m.ref.name.split(/[/\\]/).pop() ?? m.ref.name) as string
        ) ?? [],
    };
  });
}

test.describe('scene save/load on ernie (§4.6, §8)', () => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  let dir = '';
  let scenePath = '';

  test.beforeAll(() => {
    // `realpathSync` because macOS's `/var` is a symlink to `/private/var`. `main/paths.ts`
    // canonicalises every path it admits, so the app reports the resolved form; comparing against
    // the symlinked one `mkdtempSync` returns would fail on a difference the product is right to
    // make. Resolving here keeps the assertion about persistence rather than about `/var`.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tetravox-ernie-scene-')));
    scenePath = join(dir, 'ernie.tetravox.json');
  });

  test.afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('saves a T1 + ernie scene as a §4.6 ViewSpec', async ({}, info) => {
    test.setTimeout(300_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    const { app, page } = await boot(target, [T1, ERNIE]);
    try {
      await waitForLayers(page, 2);
      await stubDialogs(app, { save: scenePath });

      // Give the scene something to restore that is not a default: a layout, a convention and a
      // cursor at a named voxel of the real affine.
      await page.click('[data-testid="layout-1x3"]');
      await page.click('[data-testid="radiological-toggle"]');
      const input = page.locator('[data-testid="coord-input"]');
      await input.click();
      await input.fill(CURSOR.map((c) => c.toFixed(4)).join(' '));
      await input.press('Enter');

      const before = await sceneState(page);
      expect(before.datasets.map((d) => d.name)).toEqual(['T1.nii.gz', 'ernie.msh']);
      expect(before.layers.map((l) => l.kind)).toEqual(['volume', 'mesh']);
      expect(before.radiological).toBe(true);
      expect(before.layoutKind).toBe('1x3');

      await page.click('[data-testid="scene-save-as"]');
      await expect
        .poll(async () => (await sceneState(page)).sceneFile?.name, { timeout: 20_000 })
        .toBe('ernie.tetravox.json');
      expect(existsSync(scenePath)).toBe(true);

      // §4.6 on disk: version 1, two refs, each with a relative path and an absolute fallback.
      const spec = JSON.parse(readFileSync(scenePath, 'utf8')) as {
        version: number;
        datasets: { name: string; path: string; absPath?: string; fingerprint: string }[];
        layers: { kind: string }[];
        cursor: number[];
      };
      expect(spec.version).toBe(1);
      expect(spec.datasets.map((d) => (d.name.split('/').pop() ?? d.name) as string)).toEqual([
        'T1.nii.gz',
        'ernie.msh',
      ]);
      expect(spec.datasets[0]?.absPath).toBe(T1);
      expect(spec.datasets[1]?.absPath).toBe(ERNIE);
      // The temp dir and the dataset share `/`, so the relative form really is relative.
      expect(spec.datasets[0]?.path.startsWith('/')).toBe(false);
      expect(spec.layers.map((l) => l.kind)).toEqual(['volume', 'mesh']);
      // §4.6's fingerprint has no producer yet (W-WASM Gap 1) — recorded as empty, not invented.
      expect(spec.datasets[0]?.fingerprint).toBe('');
      // A ViewSpec is small JSON: the whole point of letting it cross IPC (`main/scene-io.ts`).
      expect(readFileSync(scenePath).length).toBeLessThan(64 * 1024);
    } finally {
      await app.close();
    }
  });

  test('a relaunched app loads it back with the same layers, cursor and layout', async ({}, info) => {
    test.setTimeout(300_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    expect(existsSync(scenePath)).toBe(true);

    // A **fresh process**, with no datasets: nothing here can be restored by having never left.
    const { app, page } = await boot(target);
    try {
      const empty = await sceneState(page);
      expect(empty.datasets).toHaveLength(0);
      expect(empty.layers).toHaveLength(0);

      await stubDialogs(app, { open: scenePath });
      await page.click('[data-testid="scene-open"]');
      await waitForLayers(page, 2);

      const after = await sceneState(page);
      expect(after.datasets.map((d) => d.name)).toEqual(['T1.nii.gz', 'ernie.msh']);
      expect(after.datasets.map((d) => d.path)).toEqual([T1, ERNIE]);
      // Layers are back in order, bottom → top (§4.4). `Engine.load` does not restore them yet
      // (audit P2-07, E-SCENE's); the shell reconciled them against the remapped dataset ids.
      expect(after.layers.map((l) => l.kind)).toEqual(['volume', 'mesh']);
      expect(after.cursor).toEqual(CURSOR.map((c) => Number(c.toFixed(4))));
      expect(after.layoutKind).toBe('1x3');
      expect(after.radiological).toBe(true);
      expect(after.sceneError).toBeNull();
      expect(after.sceneFile?.path).toBe(scenePath);

      // The three panes are on the same slices they were saved on: the plane offset §4.5 derives
      // from `(normal, cursor)` is what a slice index is, so equal offsets are equal slices.
      const offsets = Object.fromEntries(after.slices.map((s) => [s.id, s.offset]));
      expect(offsets['axial']).toBeCloseTo(CURSOR[2], 3);
      expect(offsets['coronal']).toBeCloseTo(-CURSOR[1], 3);
      expect(offsets['sagittal']).toBeCloseTo(-CURSOR[0], 3);

      // The header panel is on real data now: §6.1 reads the raw 348-byte header, so `scl_slope`
      // is the **on-disk 1.0** and not the NaN `nib.load(p).header` reports (AGENTS.md).
      await expect(page.locator('[data-testid="header-value-scl_slope"]')).toHaveText('1');
      // A SimNIBS m2m T1 is `sform_code = 2`, not 4, so nothing here is in a template space and
      // the MNI column says so rather than disappearing.
      await expect(page.locator('[data-testid="coord-bar"]')).toHaveAttribute(
        'data-has-template',
        'false'
      );
      await expect(page.locator('[data-testid="coord-mni-absent"]')).toBeVisible();
      await expect(page.locator('[data-testid="coord-space-mni"]')).toBeDisabled();
    } finally {
      await app.close();
    }
  });

  test('a scene moved away from its data resolves through the relocate dialog', async ({}, info) => {
    test.setTimeout(300_000);
    const target = info.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    // Break both §4.6 candidates for the **mesh** only, by rewriting its recorded pair to a path
    // that does not exist. The volume still resolves, so this also proves a partial failure raises
    // the dialog for one ref rather than failing the whole scene.
    const moved = join(dir, 'moved.tetravox.json');
    const text = readFileSync(scenePath, 'utf8').replace(/ernie\.msh/g, 'ernie-gone.msh');
    writeFileSync(moved, text, 'utf8');

    const { app, page } = await boot(target);
    try {
      await stubDialogs(app, { open: moved });
      await page.click('[data-testid="scene-open"]');

      await expect(page.locator('[data-testid="relocate-dialog"]')).toBeVisible({
        timeout: 60_000,
      });
      const pending = await sceneState(page);
      expect(pending.relocateMissing).toEqual(['ernie-gone.msh']);
      await expect(page.locator('[data-testid="relocate-summary"]')).toHaveText('0 of 1 located');

      // Point it back at the real mesh.
      await stubDialogs(app, { open: ERNIE });
      await page.click('[data-testid^="relocate-pick-"]');
      await expect(page.locator('[data-testid^="relocate-picked-"]')).toHaveText(ERNIE);
      await page.click('[data-testid="relocate-confirm"]');

      await waitForLayers(page, 2);
      const after = await sceneState(page);
      expect(after.datasets.map((d) => d.path)).toEqual([T1, ERNIE]);
      expect(after.layers.map((l) => l.kind)).toEqual(['volume', 'mesh']);
      expect(after.cursor).toEqual(CURSOR.map((c) => Number(c.toFixed(4))));
      expect(after.dialog).toBe('none');
      expect(after.sceneError).toBeNull();
    } finally {
      await app.close();
    }
  });
});
