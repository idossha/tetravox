/**
 * The Phase-1 app shell, end to end (ARCHITECTURE.md §8, §7.5).
 *
 * It runs against the **stand-in** engine (`?engine=mock`), which is the point: the shell is
 * finished and asserted before the WebGL2 engine exists, and `engine/factory.ts` is the one line the
 * integrator flips. Nothing here asserts a pixel — that is §11's job and the engine's; these
 * assertions are about what the panels say, which is `window.__tetravox.store`.
 *
 * Runs in both projects (`dev` and `packaged`), like `phase0.spec.ts`.
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchOptions, LaunchTarget } from './fixtures';
import { decodePng } from './png';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const VOLUME = join(TESTDATA, 'vol_u8.nii.gz');
const MESH = join(TESTDATA, 'mesh_v2_ascii.msh');

/** Slow enough that a load card is observable and Cancel is reachable; six phases at this rate. */
const SLOW_LOAD = 'engine=mock&mockStepMs=220';

/**
 * Launch and wait for a shell whose view grid actually has a box.
 *
 * The window size is not ours to assume: a tiling window manager on the developer machine snaps the
 * window to half the screen the moment it is shown, and `setBounds` from main does not survive it.
 * The app defends itself with `minWidth: 960` (`src/main/index.ts`) so the two side panels can never
 * squeeze the viewport to nothing; the test asserts that outcome — a grid wider than zero — rather
 * than a particular window size, so it passes under a tiling WM and on a bare CI runner alike.
 */
async function boot(
  target: LaunchTarget,
  options: LaunchOptions = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, { search: 'engine=mock', ...options });
  const page = await app.firstWindow();
  // After `firstWindow()`, never before it: `getAllWindows()` is empty until `whenReady` built it.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860);
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

/** The whole rendered state, as the store holds it (§8's panels are projections of exactly this). */
async function ui(page: Page) {
  return page.evaluate(() => {
    const state = window.__tetravox?.store.getState();
    if (state === undefined) throw new Error('__tetravox missing');
    return {
      layers: state.layers.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        visible: l.visible,
        opacity: l.opacity,
      })),
      activeLayerId: state.activeLayerId,
      datasets: state.datasets.map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
      loads: state.loads.map((c) => ({
        ticket: c.ticket,
        name: c.name,
        state: c.state,
        phase: c.phase,
        datasetId: c.datasetId,
      })),
      toasts: state.toasts.map((t) => ({ title: t.title, detail: t.detail })),
      cursor: state.cursor,
      cursorRows: state.cursorProbe?.rows.length ?? 0,
      hoverRows: state.hoverProbe?.rows.length ?? 0,
      layoutKind: state.layoutKind,
      cells: state.cells,
      radiological: state.radiological,
      lastScreenshot: state.lastScreenshot,
      heapBytes: state.heapBytes,
      renderer: state.caps?.renderer ?? null,
    };
  });
}

/** Drop real, path-backed `File`s, the way `phase0.spec.ts` established it works. */
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

async function waitForLayers(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (n) => (window.__tetravox?.store.getState().layers.length ?? 0) >= n,
    count,
    { timeout: 30_000 }
  );
}

// ------------------------------------------------------------------------------------------------

test.describe('the §8 shell', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    ({ app, page } = await boot(target, { args: [VOLUME] }));
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('lays out the five §8 regions', async () => {
    for (const id of [
      'toolbar',
      'layer-panel',
      'view-grid',
      'right-panel',
      'coord-bar',
      'info-panel',
      'status-bar',
    ]) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
    // One canvas, one context (§1) — the engine's, adopted by the grid rather than re-rendered.
    await expect(page.locator('[data-testid="view-grid"] > canvas')).toHaveCount(1);
    // The default layout is 2x2, so all three slice panes and the 3D pane have a cell.
    await expect(page.locator('[data-testid="view-grid"]')).toHaveAttribute('data-layout', '2x2');
    await expect(page.locator('[data-testid^="view-cell-"]')).toHaveCount(4);
  });

  test('a CLI argument opens a dataset and a layer (§8)', async () => {
    // `tetravox file1.nii.gz` — main captured argv, the renderer pulled it, the controller opened it.
    await waitForLayers(page, 1);
    const state = await ui(page);
    expect(state.datasets.map((d) => d.name)).toEqual(['vol_u8.nii.gz']);
    expect(state.layers.map((l) => l.kind)).toEqual(['volume']);
    expect(state.loads[0]?.state).toBe('done');
    await expect(page.locator('[data-testid="layer-list"] li')).toHaveCount(1);
    // The status bar owes a wasm heap figure per dataset (§8).
    expect(Object.keys(state.heapBytes)).toHaveLength(1);
    await expect(page.locator('[data-testid="status-renderer"]')).not.toBeEmpty();
  });

  test('dropping a mesh adds a second layer, and the panel shows it top-first', async () => {
    await dropFiles(page, [MESH]);
    await waitForLayers(page, 2);
    const state = await ui(page);
    expect(state.layers.map((l) => l.name)).toEqual(['vol_u8.nii.gz', 'mesh_v2_ascii.msh']);
    // `Scene.layers` is bottom → top (§4.4); the list is shown top first.
    const rows = page.locator('[data-testid="layer-list"] li');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute('data-testid', `layer-row-${state.layers[1]?.id}`);
    // The newest layer is the active one, with the §8 accent border.
    await expect(rows.first()).toHaveAttribute('data-active', 'true');
  });

  test('the eye and the opacity slider go through the Engine', async () => {
    const before = await ui(page);
    const id = before.layers[1]?.id as string;
    await page.click(`[data-testid="layer-eye-${id}"]`);
    await expect(page.locator(`[data-testid="layer-row-${id}"]`)).toHaveAttribute(
      'data-visible',
      'false'
    );
    expect((await ui(page)).layers[1]?.visible).toBe(false);
    await page.click(`[data-testid="layer-eye-${id}"]`);
    expect((await ui(page)).layers[1]?.visible).toBe(true);
  });

  test('the reorder buttons reorder the scene, not just the list', async () => {
    const before = await ui(page);
    const top = before.layers[1]?.id as string;
    await page.click(`[data-testid="layer-down-${top}"]`);
    const after = await ui(page);
    expect(after.layers.map((l) => l.name)).toEqual(['mesh_v2_ascii.msh', 'vol_u8.nii.gz']);
    await page.click(`[data-testid="layer-up-${top}"]`);
    expect((await ui(page)).layers.map((l) => l.name)).toEqual([
      'vol_u8.nii.gz',
      'mesh_v2_ascii.msh',
    ]);
  });

  test('the info panel fills from cursor and hover events (§8)', async () => {
    // A **synthetic engine event**, not a fabricated store write: this is the same `cursor` the
    // engine raises from its own pointer handling, and the panel is downstream of it.
    await page.evaluate(() => window.__tetravox?.engine?.emit?.('cursor', [12, -8, 20]));
    await expect(page.locator('[data-testid="info-cursor-ras"]')).toHaveText('12.0 -8.0 20.0');
    // Two layers ⇒ two rows, one per layer, with per-layer voxel/value and element/tag/field.
    await expect(
      page.locator('[data-testid="info-cursor"] [data-testid^="probe-row-"]')
    ).toHaveCount(2);
    await expect(
      page.locator('[data-testid="info-cursor"] [data-testid="probe-voxel"]').first()
    ).not.toBeEmpty();
    await expect(
      page.locator('[data-testid="info-cursor"] [data-testid="probe-element"]').first()
    ).not.toBeEmpty();

    // The Mouse block is live, and blank when the pointer leaves a view (§8).
    await expect(page.locator('[data-testid="info-mouse-empty"]')).toBeVisible();
    await page.evaluate(() => window.__tetravox?.engine?.emit?.('hover', [1, 2, 3]));
    await expect(page.locator('[data-testid="info-mouse-ras"]')).toHaveText('1.0 2.0 3.0');
    expect((await ui(page)).hoverRows).toBe(2);
    await page.evaluate(() => window.__tetravox?.engine?.emit?.('hover', null));
    await expect(page.locator('[data-testid="info-mouse-empty"]')).toBeVisible();
  });

  test('typing a coordinate and pressing Enter jumps the cursor (§8)', async () => {
    const input = page.locator('[data-testid="coord-input"]');
    await input.click();
    await input.fill('-42, 18, 6');
    await input.press('Enter');
    expect((await ui(page)).cursor).toEqual([-42, 18, 6]);
    // The field snaps back to the §8 copy format once the cursor has moved.
    await expect(input).toHaveValue('-42.0 18.0 6.0');
    await expect(page.locator('[data-testid="info-cursor-ras"]')).toHaveText('-42.0 18.0 6.0');

    // A non-triple is refused and the cursor does not move.
    await input.fill('nonsense');
    await input.press('Enter');
    await expect(page.locator('[data-testid="coord-error"]')).toBeVisible();
    expect((await ui(page)).cursor).toEqual([-42, 18, 6]);
  });

  test('voxel space converts through the active layer’s affine', async () => {
    // The volume layer is the active one after clicking its row.
    const state = await ui(page);
    // The row's centre is the opacity slider, which stops propagation — click the name.
    await page.click(`[data-testid="layer-name-${state.layers[0]?.id}"]`);
    await page.selectOption('[data-testid="coord-space"]', 'voxel');
    const input = page.locator('[data-testid="coord-input"]');
    await input.click();
    await input.fill('128 128 104');
    await input.press('Enter');
    await expect(input).toHaveValue('128 128 104');
    // Voxel → world → voxel is the round trip; the world value is the stand-in's own affine.
    expect((await ui(page)).cursor[0]).toBeCloseTo(-99.737457 + 128, 3);
    await page.selectOption('[data-testid="coord-space"]', 'ras');
  });

  test('the keyboard map is live (§7.5)', async () => {
    await page.locator('[data-testid="view-grid"]').click();

    // `x` cycles the layout.
    await page.keyboard.press('x');
    await expect(page.locator('[data-testid="view-grid"]')).toHaveAttribute('data-layout', '1x1');
    await page.keyboard.press('x');
    await expect(page.locator('[data-testid="view-grid"]')).toHaveAttribute('data-layout', '1x3');
    await page.keyboard.press('x');
    await expect(page.locator('[data-testid="view-grid"]')).toHaveAttribute(
      'data-layout',
      '3d-only'
    );
    await page.keyboard.press('x');
    await expect(page.locator('[data-testid="view-grid"]')).toHaveAttribute('data-layout', '2x2');

    // `[` / `]` cycle the active layer.
    const layers = (await ui(page)).layers;
    const active = (await ui(page)).activeLayerId;
    await page.keyboard.press(']');
    expect((await ui(page)).activeLayerId).not.toBe(active);
    await page.keyboard.press('[');
    expect((await ui(page)).activeLayerId).toBe(active);

    // `v` toggles the active layer's visibility, and only that layer's.
    const before = (await ui(page)).layers.find((l) => l.id === active)?.visible;
    await page.keyboard.press('v');
    expect((await ui(page)).layers.find((l) => l.id === active)?.visible).toBe(!before);
    await page.keyboard.press('v');
    expect((await ui(page)).layers.find((l) => l.id === active)?.visible).toBe(before);

    // Ctrl+↑/↓ reorders the active layer; §7.5 reserves that pair and nothing else modified acts.
    // The active layer is the bottom one here, so ↑ is the move that can happen — and ↓ is asserted
    // as the no-op it must be, rather than as a wrap that would silently reverse the stack.
    const order = layers.map((l) => l.name);
    await page.keyboard.press('Control+ArrowDown');
    expect((await ui(page)).layers.map((l) => l.name)).toEqual(order);
    await page.keyboard.press('Control+ArrowUp');
    expect((await ui(page)).layers.map((l) => l.name)).toEqual([...order].reverse());
    await page.keyboard.press('Control+ArrowDown');
    expect((await ui(page)).layers.map((l) => l.name)).toEqual(order);

    // A shortcut must not fire while a coordinate is being typed.
    const layout = (await ui(page)).layoutKind;
    await page.locator('[data-testid="coord-input"]').click();
    await page.keyboard.press('x');
    expect((await ui(page)).layoutKind).toBe(layout);
    await page.locator('[data-testid="view-grid"]').click();
  });

  test('the layout switcher and the radiological toggle (§8 toolbar)', async () => {
    await page.click('[data-testid="layout-1x3"]');
    await expect(page.locator('[data-testid^="view-cell-"]')).toHaveCount(3);
    expect((await ui(page)).cells).toEqual(['sagittal', 'coronal', 'axial']);
    await page.click('[data-testid="layout-2x2"]');
    await expect(page.locator('[data-testid^="view-cell-"]')).toHaveCount(4);

    const toggle = page.locator('[data-testid="radiological-toggle"]');
    await expect(toggle).toHaveText('NEU');
    await toggle.click();
    await expect(toggle).toHaveText('RAD');
    expect((await ui(page)).radiological).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveText('NEU');
  });

  test('clicking a pane moves the active-view border', async () => {
    const box = await page.locator('[data-testid="view-grid"]').boundingBox();
    if (box === null) throw new Error('no view grid');
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75);
    // Bottom-right of a 2x2 is cell 3 — the 3D view.
    await expect(page.locator('[data-testid="view-cell-view3d"]')).toHaveAttribute(
      'data-active',
      'true'
    );
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await expect(page.locator('[data-testid="view-cell-sagittal"]')).toHaveAttribute(
      'data-active',
      'true'
    );
  });
});

// ------------------------------------------------------------------------------------------------

test.describe('load cards and cancellation (§8, §5 rule 6)', () => {
  test('a slow load shows phase, percent and elapsed, and Cancel stops it', async ({}, testInfo) => {
    const target = testInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target, { search: SLOW_LOAD });
    try {
      await dropFiles(page, [MESH]);

      const card = page.locator('[data-testid^="load-card-"]');
      await expect(card).toHaveCount(1);
      await expect(card).toHaveAttribute('data-state', 'loading');
      // §8: phase + percent + elapsed, all three, while it runs.
      await expect(card.locator('[data-testid="load-phase"]')).not.toBeEmpty();
      await expect(card.locator('[data-testid="load-percent"]')).toContainText('%');
      await expect(card.locator('[data-testid="load-elapsed"]')).toContainText('ms');

      // The phase advances — a bar that never moves is the failure this catches.
      await expect
        .poll(async () => (await ui(page)).loads[0]?.phase, { timeout: 10_000 })
        .not.toBe('read');

      await card.locator('[data-testid="load-cancel"]').click();
      await expect(card).toHaveAttribute('data-state', 'cancelled', { timeout: 10_000 });

      const state = await ui(page);
      // Nothing was kept: cancel is `worker.terminate()`, and a half-parsed dataset is not a dataset.
      expect(state.layers).toHaveLength(0);
      expect(state.datasets).toHaveLength(0);
      // The user asked for it, so it is not an error toast (§8).
      expect(state.toasts).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  test('a file the loader will not take raises an error toast (§8)', async ({}, testInfo) => {
    const target = testInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const { app, page } = await boot(target, {
      // The stand-in fails `parse` for anything whose name contains this, so both §8 toast paths —
      // "Unsupported" from the extension and "Parse" from the loader — are exercised in one run.
      search: 'engine=mock&mockStepMs=0&mockParseFail=vol_u8',
    });
    try {
      await dropFiles(page, [join(TESTDATA, 'mesh_v2_binary_LUT.txt'), VOLUME]);
      await page.waitForFunction(
        () => (window.__tetravox?.store.getState().toasts.length ?? 0) >= 2,
        undefined,
        { timeout: 20_000 }
      );
      const titles = (await ui(page)).toasts.map((t) => t.title);
      expect(titles).toEqual([
        'Unsupported file: mesh_v2_binary_LUT.txt',
        'Could not parse the file: vol_u8.nii.gz',
      ]);
      await expect(page.locator('[data-testid="toasts"] [role="alert"]')).toHaveCount(2);
      expect((await ui(page)).layers).toHaveLength(0);

      // Dismissing is the user's, not a timer's: an error stays until it is read.
      const first = (await ui(page)).toasts.length;
      await page.locator('[data-testid^="toast-dismiss-"]').first().click();
      await expect(page.locator('[data-testid="toasts"] [role="alert"]')).toHaveCount(first - 1);
    } finally {
      await app.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------

test.describe('screenshot (§4.7, §8)', () => {
  test('the button writes a real PNG', async ({}, testInfo) => {
    const target = testInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const downloads = mkdtempSync(join(tmpdir(), 'tetravox-shot-'));
    const { app, page } = await boot(target, { env: { TETRAVOX_DOWNLOAD_DIR: downloads } });
    try {
      await page.click('[data-testid="screenshot-button"]');
      // The store records what came back; the file records that it was actually saved.
      await expect
        .poll(async () => (await ui(page)).lastScreenshot?.isPng, { timeout: 15_000 })
        .toBe(true);
      await expect
        .poll(() => readdirSync(downloads).filter((f) => f.endsWith('.png')), { timeout: 15_000 })
        .toHaveLength(1);

      const file = join(downloads, readdirSync(downloads)[0] as string);
      expect(existsSync(file)).toBe(true);
      // Decoded, not sniffed: §11 rule 0 — an agent cannot judge a PNG, but it can judge its IHDR.
      const png = decodePng(readFileSync(file));
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
      expect(png.pixels).toHaveLength(png.width * png.height * 4);
    } finally {
      await app.close();
      rmSync(downloads, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------

test.describe('the webgl2-null screen (§1, §8)', () => {
  test('replaces the viewport when there is no WebGL2 context', async ({}, testInfo) => {
    const target = testInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    const app = await launchApp(target, { search: 'forceWebgl2Null=1' });
    try {
      const page = await app.firstWindow();
      await expect(page.locator('[data-testid="webgl2-error"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-testid="webgl2-error"]')).toContainText('chrome://gpu');
      // No half-drawn shell behind it: the viewport is replaced, not overlaid.
      await expect(page.locator('[data-testid="view-grid"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="toolbar"]')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
