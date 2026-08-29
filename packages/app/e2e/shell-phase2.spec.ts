/**
 * The Phase-2 shell, end to end: the toolbar's scene controls, all three dialogs, the coordinate
 * bar's MNI column, the header panel, the `.msh.opt` chip and the status bar's quality readout.
 *
 * Like `shell.spec.ts`, it runs against the **stand-in** engine (`?engine=mock`), because none of
 * these are rendering features — every assertion is about what the DOM says and what the store
 * holds, which is §11's rule 0 applied to the app half. Real ernie data has its own spec
 * (`scene-realdata.spec.ts`), where the whole persistence path runs against the real engine.
 *
 * **The native dialogs are stubbed in main**, not clicked. `dialog.showSaveDialog` and
 * `showOpenDialog` are OS-modal and a Playwright click cannot reach them; `app.evaluate` runs in the
 * main process, so replacing the two functions there leaves every layer below them — the write
 * allow-list, the size cap, the IPC round trip, the parse, the candidate order — genuinely under
 * test. Stubbing the *renderer's* bridge instead would have skipped all of that.
 */

/* eslint-disable no-empty-pattern */

import {
  copyFileSync,
  realpathSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, clickAppMenu, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchOptions, LaunchTarget } from './fixtures';
import { decodePng, readPngDpi } from './png';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = join(TESTDATA, 'vol_u8.nii.gz');
/** The one committed mesh with a `.msh.opt` beside it — §7.6's chip needs a real sidecar. */
const MESH_WITH_OPT = join(TESTDATA, 'mesh_v2_binary.msh');

async function boot(
  target: LaunchTarget,
  options: LaunchOptions = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, { search: 'engine=mock&mockStepMs=0', ...options });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const grid = document.querySelector('[data-testid="view-grid"]');
      const rect = grid?.getBoundingClientRect();
      return rect !== undefined && rect.width > 0 && rect.height > 0;
    },
    undefined,
    { timeout: 15_000 }
  );
  return { app, page };
}

/**
 * Point `showSaveDialog` / `showOpenDialog` at fixed paths, in **main**.
 *
 * Everything under them stays real: `scene-io.ts` still allow-lists the write, still caps the size,
 * and the renderer still crosses IPC for both directions.
 */
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

async function ui(page: Page) {
  return page.evaluate(() => {
    const state = window.__tetravox?.store.getState();
    if (state === undefined) throw new Error('__tetravox missing');
    return {
      layers: state.layers.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
      datasets: state.datasets.map((d) => ({ id: d.id, name: d.name, path: d.path ?? null })),
      cursor: state.cursor,
      cells: [...state.cells],
      layoutKind: state.layoutKind,
      radiological: state.radiological,
      colorbars: state.colorbars,
      dialog: state.dialog,
      sceneFile: state.sceneFile,
      sceneError: state.sceneError,
      relocateMissing: state.relocate?.missing.map((m) => m.ref.name) ?? [],
      lastScreenshot: state.lastScreenshot,
      coordSpace: state.coordSpace,
    };
  });
}

async function waitForLayers(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (n) => (window.__tetravox?.store.getState().layers.length ?? 0) >= n,
    count,
    { timeout: 30_000 }
  );
}

/** Drop real, path-backed `File`s — the mechanism `shell.spec.ts` established works. */
async function dropFiles(page: Page, paths: readonly string[]): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'tvx-drop-probe';
    document.body.appendChild(input);
  });
  await page.setInputFiles('#tvx-drop-probe', [...paths]);
  await page.evaluate(() => {
    const input = document.getElementById('tvx-drop-probe') as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
    document
      .querySelector('[data-testid="shell"]')
      ?.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
      );
    input.remove();
  });
}

function skipUnlessAvailable(target: LaunchTarget): void {
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');
}

// ================================================================================================

test.describe('the Phase-2 toolbar and dialogs (§8)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    skipUnlessAvailable(target);
    ({ app, page } = await boot(target, {
      // `mockTemplate=1` gives loaded volumes a `toTemplate`, which is what the MNI column needs.
      search: 'engine=mock&mockStepMs=0&mockTemplate=1',
      args: [VOLUME],
    }));
    await waitForLayers(page, 1);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the app menu carries the four scene verbs the audit found absent', async () => {
    await page.click('[data-testid="app-menu"]');
    for (const id of ['app-menu-new', 'app-menu-open-scene', 'app-menu-save', 'app-menu-save-as']) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
    // With a layer open they are live; the emptiness case is asserted after New, below.
    await expect(page.locator('[data-testid="app-menu-save"]')).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('the keyboard sheet is generated, and `?` opens it', async () => {
    await page.locator('[data-testid="view-grid"]').click();
    await page.keyboard.press('?');
    const sheet = page.locator('[data-testid="keyboard-help"]');
    await expect(sheet).toBeVisible();

    // The sheet is tabbed (View / Cursor & Layers / Mouse); only the active tab's rows render.
    await expect(page.locator('[data-testid="keymap-tab-view"]')).toBeVisible();

    // Generated rows: the six §7.5 camera presets are one section, and the two arrow meanings
    // §7.5 lists separately appear as separate rows.
    await expect(page.locator('[data-testid="keyhelp-section-Camera presets"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="keyhelp-section-Camera presets"] [data-testid="keyhelp-chord"]')
    ).toHaveCount(6);

    await page.click('[data-testid="keymap-tab-cursor-layers"]');
    const cursorChords = await page
      .locator('[data-testid="keyhelp-section-Cursor"] [data-testid="keyhelp-chord"]')
      .allInnerTexts();
    expect(cursorChords).toEqual(['PgUp', 'PgDn', '↑', '↓', '→', '←']);

    // §7.5's pointer gestures are listed, and labelled as the engine's rather than the map's.
    await page.click('[data-testid="keymap-tab-mouse"]');
    await expect(page.locator('[data-testid="keyhelp-section-2D panes"]')).toBeVisible();
    await expect(page.locator('[data-testid="keyhelp-section-3D pane"]')).toBeVisible();

    // Escape closes it, and does **not** reach the §7.5 resolver underneath.
    const layout = (await ui(page)).layoutKind;
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect((await ui(page)).layoutKind).toBe(layout);
  });

  test('a click in the view grid takes the keyboard back from a text field (§7.5)', async () => {
    // The defect this pins: the engine's pointer layer `preventDefault()`s `pointerdown` (§7.5
    // needs it for capture), which suppresses the browser's own focus change, so after typing in
    // any field the whole §7.5 key map was dead and every shortcut was typed into that field.
    const search = page.locator('[data-testid="header-search"]');
    await search.click();
    await search.fill('scl');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
    ).toBe('header-search');

    await page.locator('[data-testid="view-grid"]').click();
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null),
      'the click left the field'
    ).not.toBe('header-search');

    // …and the map is live again: `?` opens the sheet rather than typing into the box.
    await page.keyboard.press('?');
    await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
    await expect(search).toHaveValue('scl');
    await page.keyboard.press('Escape');
    await search.fill('');
  });

  test('the layout buttons rebuild the panes in the engine’s own order', async () => {
    // Clicking the highlighted 2×2 used to swap axial and sagittal: `scene/defaults.ts` boots
    // `[axial, coronal, sagittal, view3d]` and `lib/layout.ts` sorted sagittal-first, so the
    // engine-drawn pane label read AXIAL before the click and SAGITTAL after — and the swapped
    // order was then written into a saved scene.
    await page.click('[data-testid="layout-2x2"]');
    const boot = (await ui(page)).cells;
    expect(boot).toEqual(['axial', 'coronal', 'sagittal', 'view3d']);
    await page.click('[data-testid="layout-2x2"]');
    expect((await ui(page)).cells, 'clicking the highlighted button changes nothing').toEqual(boot);
    await page.click('[data-testid="layout-3d-only"]');
    await page.click('[data-testid="layout-2x2"]');
    expect((await ui(page)).cells, 'and neither does a round trip through 3D').toEqual(boot);
  });

  test('colour bars are reachable, and on by default (§8)', async () => {
    // `Scene.annotations.colorbars` defaults to false and `setAnnotations` had exactly one call
    // site in the whole app (`toggleCrosshair`), so a colour bar could never be seen in the running
    // product — layers carried `showColorbar: true` that could not draw.
    const toggle = page.locator('[data-testid="colorbars-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect((await ui(page)).colorbars).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect((await ui(page)).colorbars).toBe(false);
    await toggle.click();
    expect((await ui(page)).colorbars).toBe(true);
  });

  test('the screenshot dialog edits the whole §4.7 option set, and the preview parses pHYs', async () => {
    await page.click('[data-testid="screenshot-menu"]');
    const dialog = page.locator('[data-testid="screenshot-dialog"]');
    await expect(dialog).toBeVisible();

    // Every §4.7 knob has a control.
    for (const id of [
      'screenshot-target',
      'screenshot-width',
      'screenshot-height',
      'screenshot-scale',
      'screenshot-dpi',
      'screenshot-background',
      'screenshot-autotrim',
    ]) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
    for (const key of ['colorbar', 'orientationLabels', 'crosshair', 'cornerInfo', 'scaleBar']) {
      await expect(page.locator(`[data-testid="screenshot-include-${key}"]`)).toBeVisible();
    }

    // `target: 'view'` reveals the pane selector, and only then.
    await expect(page.locator('[data-testid="screenshot-view"]')).toHaveCount(0);
    await page.selectOption('[data-testid="screenshot-target"]', 'view');
    await expect(page.locator('[data-testid="screenshot-view"]')).toBeVisible();
    await page.selectOption('[data-testid="screenshot-target"]', 'grid');

    await page.fill('[data-testid="screenshot-width"]', '96');
    await page.fill('[data-testid="screenshot-height"]', '64');
    await page.fill('[data-testid="screenshot-dpi"]', '300');
    await page.selectOption('[data-testid="screenshot-background"]', 'white');

    await expect(page.locator('[data-testid="screenshot-preview-empty"]')).toBeVisible();
    await page.click('[data-testid="screenshot-preview"]');
    await expect(page.locator('[data-testid="screenshot-preview-image"]')).toBeVisible();
    await expect(page.locator('[data-testid="screenshot-preview-size"]')).toHaveText('96 × 64 px');
    // §11: the DPI is read out of the PNG's own chunk, in the product, not just in a test.
    await expect(page.locator('[data-testid="screenshot-preview-dpi"]')).toHaveText(
      'pHYs carries 300 dpi'
    );

    await page.click('[data-testid="screenshot-cancel"]');
    await expect(dialog).toHaveCount(0);
  });

  test('the coordinate bar’s MNI column is live when a dataset carries a toTemplate', async () => {
    // Directed task 8: the selector is `Engine.coordinateSpaces()`, so entries are picked by their
    // label — a `CoordSpaceRef`'s value carries a generated `DatasetId`, which no spec can predict.
    const select = page.locator('[data-testid="coord-space"]');
    await expect(select.locator('option', { hasText: 'MNI152 (affine)' })).not.toBeDisabled();

    const input = page.locator('[data-testid="coord-input"]');
    await input.click();
    await input.fill('-42 18 6');
    await input.press('Enter');
    // The read-out is the cursor through `toTemplate.matrix`: a 12 mm anterior shift.
    await expect(
      page.locator('[data-testid="coord-readout"] [data-space="mni-affine"]')
    ).toHaveText('-42.0 30.0 6.0');

    // Switching space edits in the template's frame and jumps back through the inverse.
    await select.selectOption({ label: 'MNI152 (affine)' });
    await expect(input).toHaveValue('-42.0 30.0 6.0');
    await input.click();
    await input.fill('0 42 0');
    await input.press('Enter');
    expect((await ui(page)).cursor).toEqual([0, 30, 0]);
    await select.selectOption({ label: 'World RAS' });
  });

  test('the header panel shows the raw header, including the on-disk scl_slope', async () => {
    await expect(page.locator('[data-testid="header-panel"]')).toBeVisible();
    // The gate item, on the stand-in's shaped header: `scl_slope` is **1**, never NaN (AGENTS.md).
    await expect(page.locator('[data-testid="header-value-scl_slope"]')).toHaveText('1');
    await expect(page.locator('[data-testid="header-value-sizeof_hdr"]')).toHaveText('348');

    // Search narrows, and says so when nothing matches rather than showing an empty table.
    await page.fill('[data-testid="header-search"]', 'qform');
    await expect(page.locator('[data-testid="header-rows"] dt')).toHaveCount(1);
    await page.fill('[data-testid="header-search"]', 'zzz');
    await expect(page.locator('[data-testid="header-no-match"]')).toBeVisible();
    await page.fill('[data-testid="header-search"]', '');

    // Raw is the JSON verbatim, which is what "§8's header panel, `headerJson` verbatim" means.
    await page.click('[data-testid="header-raw-toggle"]');
    await expect(page.locator('[data-testid="header-raw"]')).toContainText('"scl_slope":1');
    await page.click('[data-testid="header-raw-toggle"]');
  });

  test('the status bar names `interacting` separately from `reduced` (§7.2)', async () => {
    await expect(page.locator('[data-testid="status-interacting"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="status-quality"]')).toHaveCount(0);

    // A synthetic engine event, not a store write: this is the `quality` event §7.2 requires the
    // engine to emit rather than degrading silently.
    await page.evaluate(() =>
      window.__tetravox?.engine?.emit?.('quality', {
        name: 'interacting',
        dprScale: 1,
        msaa: 0,
        capDecimation: 4,
        oit: false,
      })
    );
    await expect(page.locator('[data-testid="status-interacting"]')).toBeVisible();
    await expect(page.locator('[data-testid="status-quality"]')).toHaveText('interacting');

    await page.evaluate(() =>
      window.__tetravox?.engine?.emit?.('quality', {
        name: 'reduced',
        dprScale: 0.5,
        msaa: 0,
        capDecimation: 8,
        oit: false,
      })
    );
    // `reduced` is a permanent degradation and must not wear the transient label.
    await expect(page.locator('[data-testid="status-interacting"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="status-quality"]')).toHaveText('reduced');
  });

  test('the `.msh.opt` chip appears only for a mesh that had a sidecar, and Reset re-seeds it', async () => {
    // A volume is active: no chip.
    await expect(page.locator('[data-testid="mshopt-chip"]')).toHaveCount(0);

    await dropFiles(page, [MESH_WITH_OPT]);
    await waitForLayers(page, 2);
    const chip = page.locator('[data-testid="mshopt-chip"]');
    await expect(chip).toBeVisible();
    await expect(page.locator('[data-testid="mshopt-chip-label"]')).toHaveText(
      'defaults from mesh_v2_binary.msh.opt'
    );

    // Reset writes `tagStyle` from `MeshDataset.opt` — tag 3 is the hidden one the sidecar names.
    await page.click('[data-testid="mshopt-reset"]');
    await expect(page.locator('[data-testid="mshopt-reset-done"]')).toBeVisible();
    const tagStyle = await page.evaluate(() => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.kind === 'mesh');
      return layer?.kind === 'mesh' ? layer.tagStyle : null;
    });
    expect(tagStyle).not.toBeNull();
    expect(tagStyle?.[3]?.visible).toBe(false);
    expect(tagStyle?.[1]?.visible).toBe(true);

    // Back to a volume-only scene for the tests that follow.
    await clickAppMenu(page, 'new');
    await expect(page.locator('[data-testid="mshopt-chip"]')).toHaveCount(0);
  });

  test('New empties the scene, and the empty states say what to do next', async () => {
    const state = await ui(page);
    expect(state.datasets).toHaveLength(0);
    expect(state.layers).toHaveLength(0);
    expect(state.sceneFile).toBeNull();
    await page.click('[data-testid="app-menu"]');
    await expect(page.locator('[data-testid="app-menu-save"]')).toBeDisabled();
    await expect(page.locator('[data-testid="app-menu-new"]')).toBeDisabled();
    await page.keyboard.press('Escape');
    // Empty states, not blank boxes.
    await expect(page.locator('[data-testid="header-panel-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="info-cursor-empty"]')).toBeVisible();
    // The Mouse block starts collapsed; its empty state is behind the disclosure.
    await page.click('[data-testid="info-mouse-toggle"]');
    await expect(page.locator('[data-testid="info-mouse-empty"]')).toBeVisible();
    // With no volume left there are no per-volume spaces at all: the selector collapses to the one
    // space that always exists (directed task 8), and the derived readout rows disappear with the
    // volumes they belonged to.
    await expect(page.locator('[data-testid="coord-space"] option')).toHaveCount(1);
    await expect(page.locator('[data-testid="coord-space"] option')).toHaveText('World RAS');
    await expect(page.locator('[data-testid="coord-readout"]')).toHaveCount(0);
  });
});

// ================================================================================================

test.describe('scene save/load and relocate (§4.6, §8)', () => {
  test('a saved scene reopens with its datasets, layers, cursor and layout', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    skipUnlessAvailable(target);
    const dir = mkdtempSync(join(tmpdir(), 'tetravox-scene-'));
    const scenePath = join(dir, 'study.tetravox.json');
    const { app, page } = await boot(target, {
      search: 'engine=mock&mockStepMs=0',
      args: [VOLUME],
    });
    try {
      await waitForLayers(page, 1);
      await stubDialogs(app, { save: scenePath });

      // A scene worth restoring: a moved cursor and a non-default layout.
      await page.click('[data-testid="layout-1+3"]');
      const input = page.locator('[data-testid="coord-input"]');
      await input.click();
      await input.fill('-42 18 6');
      await input.press('Enter');

      await clickAppMenu(page, 'save-as');
      await expect.poll(async () => (await ui(page)).sceneFile?.name).toBe('study.tetravox.json');
      expect(existsSync(scenePath)).toBe(true);

      // §4.6 on disk: version 1, a relative path, an absolute fallback.
      const spec = JSON.parse(readFileSync(scenePath, 'utf8')) as {
        version: number;
        datasets: { path: string; absPath?: string }[];
        layers: unknown[];
      };
      expect(spec.version).toBe(1);
      expect(spec.datasets[0]?.path.endsWith('vol_u8.nii.gz')).toBe(true);
      expect(spec.datasets[0]?.absPath).toBe(VOLUME);
      expect(spec.layers).toHaveLength(1);

      // Reopen it in the same window, from an empty scene.
      await clickAppMenu(page, 'new');
      expect((await ui(page)).layers).toHaveLength(0);
      await stubDialogs(app, { open: scenePath });
      await clickAppMenu(page, 'open-scene');
      await waitForLayers(page, 1);

      const restored = await ui(page);
      expect(restored.datasets.map((d) => d.name)).toEqual(['vol_u8.nii.gz']);
      // The layer is back even though `Engine.load` does not restore layers (audit P2-07): the
      // shell reconciled it against the remapped dataset id.
      expect(restored.layers.map((l) => l.kind)).toEqual(['volume']);
      expect(restored.cursor).toEqual([-42, 18, 6]);
      expect(restored.layoutKind).toBe('1+3');
      expect(restored.sceneError).toBeNull();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dataset that moved opens the relocate dialog, and the pick restores the scene', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    skipUnlessAvailable(target);
    // The dataset is a **copy** under a temp directory, never `testdata/` itself: this test deletes
    // the file it opened, and a crash between the delete and the restore would leave the repo's
    // committed fixture missing for every other suite.
    const dir = mkdtempSync(join(tmpdir(), 'tetravox-relocate-'));
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    // `realpathSync` because macOS's `/var` is a symlink to `/private/var`: `mkdtempSync` hands back
    // the symlinked form and `paths.ts` allow-lists the resolved one, so a raw comparison would
    // fail on a difference the product is right to make.
    const original = realpathSync(join(dir, 'data'));
    const originalFile = join(original, 'vol_u8.nii.gz');
    const moved = join(realpathSync(join(dir, 'elsewhere')), 'vol_u8.nii.gz');
    copyFileSync(VOLUME, originalFile);
    const scenePath = join(dir, 'study.tetravox.json');

    const { app, page } = await boot(target, {
      search: 'engine=mock&mockStepMs=0',
      args: [originalFile],
    });
    try {
      await waitForLayers(page, 1);
      await stubDialogs(app, { save: scenePath });
      await clickAppMenu(page, 'save-as');
      await expect.poll(async () => (await ui(page)).sceneFile?.name).toBe('study.tetravox.json');

      // The data moves and the scene does not: neither `data/vol_u8.nii.gz` relative to the scene
      // nor the recorded absolute path resolves any more. That is what the dialog is for.
      renameSync(originalFile, moved);

      await clickAppMenu(page, 'new');
      await stubDialogs(app, { open: scenePath });
      await clickAppMenu(page, 'open-scene');

      const dialog = page.locator('[data-testid="relocate-dialog"]');
      await expect(dialog).toBeVisible();
      expect((await ui(page)).relocateMissing).toEqual(['vol_u8.nii.gz']);
      // The user is told what was looked for, and that the fingerprint cannot be checked yet —
      // it has no producer (W-WASM Gap 1), and a green tick meaning nothing would be worse.
      await expect(page.locator('[data-testid^="relocate-tried-"]')).toContainText(originalFile);
      await expect(page.locator('[data-testid^="relocate-fingerprint-"]')).toContainText(
        'no fingerprint recorded'
      );
      await expect(page.locator('[data-testid="relocate-confirm"]')).toBeDisabled();

      // Point it at the real file; the picker is the stubbed native Open dialog.
      await stubDialogs(app, { open: moved });
      await page.click('[data-testid^="relocate-pick-"]');
      await expect(page.locator('[data-testid^="relocate-picked-"]')).toHaveText(moved);
      await expect(page.locator('[data-testid="relocate-summary"]')).toHaveText('1 of 1 located');

      await page.click('[data-testid="relocate-confirm"]');
      await waitForLayers(page, 1);
      const restored = await ui(page);
      expect(restored.datasets[0]?.path).toBe(moved);
      expect(restored.layers).toHaveLength(1);
      expect(restored.dialog).toBe('none');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('"Open without them" opens the rest rather than failing the whole scene', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    skipUnlessAvailable(target);
    const dir = mkdtempSync(join(tmpdir(), 'tetravox-skip-'));
    const scenePath = join(dir, 'study.tetravox.json');
    const { app, page } = await boot(target, {
      search: 'engine=mock&mockStepMs=0',
      args: [VOLUME],
    });
    try {
      await waitForLayers(page, 1);
      await stubDialogs(app, { save: scenePath });
      await clickAppMenu(page, 'save-as');
      await expect.poll(async () => (await ui(page)).sceneFile?.name).toBe('study.tetravox.json');

      writeFileSync(
        scenePath,
        readFileSync(scenePath, 'utf8').replace(/vol_u8\.nii\.gz/g, 'gone.nii.gz'),
        'utf8'
      );

      await clickAppMenu(page, 'new');
      await stubDialogs(app, { open: scenePath });
      await clickAppMenu(page, 'open-scene');
      await expect(page.locator('[data-testid="relocate-dialog"]')).toBeVisible();
      await page.click('[data-testid="relocate-skip-all"]');

      await expect.poll(async () => (await ui(page)).dialog).toBe('none');
      const state = await ui(page);
      expect(state.datasets).toHaveLength(0);
      // The presentation half of the spec still applied — a skipped dataset is not a failed load.
      expect(state.sceneError).toBeNull();
      expect(state.sceneFile?.name).toBe('study.tetravox.json');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file that is not a scene is refused with a reason, not a broken window', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    skipUnlessAvailable(target);
    const { app, page } = await boot(target, { args: [VOLUME] });
    try {
      await waitForLayers(page, 1);
      // The volume itself is gzip, not JSON. It is on the allow-list (argv opened it), so this
      // reaches the parse rather than the allow-list.
      await stubDialogs(app, { open: VOLUME });
      await clickAppMenu(page, 'open-scene');
      await expect(page.locator('[data-testid="scene-error"]')).toBeVisible();
      await expect(page.locator('[data-testid="toasts"] [role="alert"]')).toHaveCount(1);
      // The scene that was open is untouched.
      expect((await ui(page)).layers).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

// ================================================================================================

test.describe('the screenshot dialog writes the PNG it promised (§4.7, §11)', () => {
  test('Save PNG lands a file whose pHYs chunk carries the requested DPI', async ({}, info) => {
    const target = info.project.name as LaunchTarget;
    skipUnlessAvailable(target);
    const downloads = mkdtempSync(join(tmpdir(), 'tetravox-shot2-'));
    const { app, page } = await boot(target, {
      args: [VOLUME],
      env: { TETRAVOX_DOWNLOAD_DIR: downloads },
    });
    try {
      await waitForLayers(page, 1);
      await page.click('[data-testid="screenshot-menu"]');
      await page.fill('[data-testid="screenshot-width"]', '120');
      await page.fill('[data-testid="screenshot-height"]', '90');
      await page.fill('[data-testid="screenshot-dpi"]', '600');
      await page.click('[data-testid="screenshot-save"]');

      // The dialog closes on Save: a modal still up after the file is written is a modal the user
      // has to guess about.
      await expect(page.locator('[data-testid="screenshot-dialog"]')).toHaveCount(0);
      await expect
        .poll(() => readdirSync(downloads).filter((f) => f.endsWith('.png')), { timeout: 15_000 })
        .toHaveLength(1);

      const file = join(downloads, readdirSync(downloads)[0] as string);
      const bytes = readFileSync(file);
      const png = decodePng(bytes);
      expect(png.width).toBe(120);
      expect(png.height).toBe(90);
      // §11: parse the chunk. This reader is the E2E's own, so it can disagree with `lib/png.ts`.
      expect(readPngDpi(bytes)).toBe(600);

      // And the status bar reports what is in the file, not what was asked for.
      await expect(page.locator('[data-testid="status-screenshot-dpi"]')).toContainText('600 dpi');
      const record = (await ui(page)).lastScreenshot;
      expect(record?.dpi).toBe(600);
      expect(record?.requestedDpi).toBe(600);
    } finally {
      await app.close();
      rmSync(downloads, { recursive: true, force: true });
    }
  });
});
