/**
 * The interface pictures for `docs/screenshots/2026-08-29/` — the states a `--job` cannot reach
 * because they are UI, not engine: the whole window in both themes, the toolbar rail, the layer /
 * region / info panels, the Settings dialog (including its Capture tab), the tabbed keyboard sheet,
 * the Screenshot ▾ export flow, and the Measure panel with its Clear all.
 *
 * A capture spec, not a gate: it asserts only what it needs to know a picture is of the right thing
 * (the measurement exists, the dialog is open) and that every PNG stays under 1.5 MB. Offscreen
 * (AGENTS rule 8 — never set `TETRAVOX_E2E_HEADED`). Skips, never fails, when `TETRAVOX_TESTDATA`
 * is unset (AGENTS rule 2). Run it alone:
 *
 *   export TETRAVOX_TESTDATA=…/derivatives/SimNIBS/sub-ernie
 *   pnpm --filter @tetravox/app exec playwright test e2e/ui-tour-gallery.spec.ts --project=dev
 *
 * `ui-*` land in `docs/screenshots/2026-08-29/ui/`; `feat-measure` and `feat-coordinates` are guide
 * figures and land in `features/` beside the engine captures.
 *
 * Set `TETRAVOX_SHOT_SCALE=2` to capture at 2x — what the published set wants, since the website
 * shows these on Retina displays and the small panel crops are otherwise soft. The layout is
 * identical; only the raster doubles.
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable, shotScale } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const LABELS = join(ROOT, 'm2m_ernie', 'segmentation', 'labeling.nii.gz');
const MESH = join(ROOT, 'm2m_ernie', 'ernie.msh');
const SET_DIR = resolve(APP_ROOT, '..', '..', 'docs', 'screenshots', '2026-08-29');
const UI_DIR = join(SET_DIR, 'ui');
const FEATURES_DIR = join(SET_DIR, 'features');
// The cap is per pixel, not per file: at `TETRAVOX_SHOT_SCALE=2` a window shot legitimately carries
// four times the pixels, and a fixed 1.5 MB would fail on the sharper picture the flag exists to take.
const SCALE = shotScale();
const MAX_BYTES = 1.5 * 1024 * 1024 * SCALE * SCALE;

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

let app: ElectronApplication;
let page: Page;

async function settled(p: Page): Promise<void> {
  await p.evaluate(async () => {
    await window.__tetravox?.engine?.whenSettled();
  });
  // `.tvx-btn` carries a 150 ms colour transition (see theme.spec.ts).
  await p.waitForTimeout(400);
}

async function shot(name: string, target: Page | Locator = page, dir = UI_DIR): Promise<void> {
  const file = join(dir, `${name}.png`);
  mkdirSync(dir, { recursive: true });
  await settled(page);
  await target.screenshot({ path: file });
  expect(statSync(file).size, `${name}.png over 1.5 MB`).toBeLessThanOrEqual(MAX_BYTES);
}

async function openSettings(tab: 'appearance' | 'capture' | 'paths' | 'startup'): Promise<void> {
  if ((await page.locator('[data-testid="settings-panel-appearance"]').count()) === 0) {
    await page.click('[data-testid="settings-button"]');
  }
  await page.click(`[data-testid="settings-tab-${tab}"]`);
  await expect(page.locator(`[data-testid="settings-panel-${tab}"]`)).toBeVisible();
}

async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await openSettings('appearance');
  await page.click(`[data-testid="theme-${theme}"]`);
  await expect(page.locator('[data-testid="theme-group"]')).toHaveAttribute(
    'data-theme-resolved',
    theme
  );
  await page.click('[data-testid="settings-close"]');
  // Wait for the CSS transitions to land on the theme's real panel colour (theme.spec.ts's
  // EXPECTED table) — the first light capture otherwise catches the toolbar mid-fade.
  const panel = theme === 'light' ? 'rgb(238, 241, 245)' : 'rgb(30, 33, 38)';
  await expect
    .poll(() =>
      page.locator('[data-testid="toolbar"]').evaluate((el) => getComputedStyle(el).backgroundColor)
    )
    .toBe(panel);
  await page.waitForTimeout(300);
}

async function layerIds(): Promise<{ id: string; kind: string; name: string }[]> {
  return page.evaluate(() =>
    (window.__tetravox?.store.getState().layers ?? []).map((l) => ({
      id: l.id,
      kind: l.kind,
      name: l.name,
    }))
  );
}

test.beforeAll(async ({}, workerInfo) => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.skip(!existsSync(T1) || !existsSync(LABELS), 'ernie T1 / labeling missing');
  const target = workerInfo.project.name as LaunchTarget;
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');

  app = await launchApp(target, { search: 'engine=real' });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });

  // The same request the Open dialog builds (measure.spec.ts), plus the label volume's LUT sidecar
  // so the regions come out named.
  await page.evaluate(
    async ([t1, labels, mesh]: string[]) => {
      const tv = window.__tetravox;
      if (tv?.controller == null) throw new Error('no shell');
      for (const path of [t1, labels, mesh] as string[]) {
        const allowed = await window.tetravox.allowPath(path);
        if (allowed === null) throw new Error(`main refused ${path}`);
        let lut: string | null = null;
        let opt: string | null = null;
        if (path.endsWith('labeling.nii.gz')) {
          const cand = allowed.path.replace(/labeling\.nii\.gz$/, 'labeling_LUT.txt');
          lut = (await window.tetravox.allowPath(cand))?.path ?? null;
        }
        if (path.endsWith('.msh')) {
          // `ernie.msh` has no `$PhysicalNames`; its `.msh.opt` is the only source of tissue
          // names and colours (AGENTS.md), and the Open dialog attaches it as a sidecar.
          opt = (await window.tetravox.allowPath(`${allowed.path}.opt`))?.path ?? null;
        }
        tv.controller.open([
          {
            name: allowed.path.split('/').pop() ?? allowed.path,
            path: allowed.path,
            source: {
              kind: 'path',
              path: allowed.path,
              ...(lut === null && opt === null
                ? {}
                : {
                    sidecars: {
                      ...(lut === null ? {} : { lut }),
                      ...(opt === null ? {} : { opt }),
                    },
                  }),
            },
          },
        ]);
      }
    },
    [T1, LABELS, MESH]
  );
  await page.waitForFunction(
    () => {
      const s = window.__tetravox?.store.getState();
      return (
        (s?.layers ?? []).length >= 3 &&
        (s?.loads ?? []).every((c) => c.state !== 'queued' && c.state !== 'loading')
      );
    },
    undefined,
    { timeout: 420_000 }
  );
  // Both sidebars open, dark, a mid-brain cursor. The atlas reads better as an outline.
  await page.evaluate(() => {
    const tv = window.__tetravox!;
    const s = tv.store.getState();
    if (s.leftPanelCollapsed) tv.store.setState({ leftPanelCollapsed: false });
    if (s.rightPanelCollapsed) tv.store.setState({ rightPanelCollapsed: false });
    const labels = s.layers.find((l) => l.name.startsWith('labeling'));
    if (labels !== undefined) tv.engine?.updateLayer(labels.id, { labelMode: 'outline' });
    // A volume has no 3D presence until `showIn3D` puts its slice planes in the pane, and the
    // scalp is what makes the 3D pane of a window shot read as a head.
    const t1Layer = s.layers.find((l) => l.name.startsWith('T1'));
    if (t1Layer !== undefined) tv.engine?.updateLayer(t1Layer.id, { showIn3D: true });
    const meshLayer = s.layers.find((l) => l.kind === 'mesh');
    if (meshLayer !== undefined) {
      tv.engine?.updateLayer(meshLayer.id, {
        // The mesh's job here is the 3D pane; its 2D cross-section would paint over the T1.
        fillIn2D: false,
        contoursIn2D: false,
        tagStyle: {
          1: { visible: true, opacity: 1 },
          2: { visible: true, opacity: 1 },
          4: { visible: false, opacity: 1 },
          5: { visible: false, opacity: 1 },
          3: { visible: false, opacity: 1 },
          6: { visible: false, opacity: 1 },
          7: { visible: false, opacity: 1 },
          8: { visible: false, opacity: 1 },
          9: { visible: false, opacity: 1 },
          10: { visible: false, opacity: 1 },
        },
      });
    }
    tv.engine?.setCursor([0, -18, 8]);
    // The load cards are a transient progress list; a tour shot wants the panel, not the receipts.
    tv.store.setState({ loads: [] });
  });
  await setTheme('dark');
  await page.click('[data-testid="layout-1+3"]');
});

test.afterAll(async () => {
  await app?.close();
});

test('the whole window, dark', async () => {
  await shot('ui-window-dark');
});

test('the layer panel and the region list', async () => {
  const t1 = (await layerIds()).find((l) => l.name.startsWith('T1'))!;
  await page.evaluate((id) => window.__tetravox!.engine!.setActiveLayer(id), t1.id);
  const body = page.locator(`[data-testid="layer-body-${t1.id}"]`);
  if ((await body.count()) === 0) await page.click(`[data-testid="layer-disclosure-${t1.id}"]`);
  await expect(page.locator(`[data-testid="volume-histogram-${t1.id}-plot"]`)).toBeVisible();
  await shot('ui-layer-panel', page.locator('[data-testid="layer-panel"]'));

  const labels = (await layerIds()).find((l) => l.name.startsWith('labeling'))!;
  await page.evaluate((id) => window.__tetravox!.engine!.setActiveLayer(id), labels.id);
  const labelBody = page.locator(`[data-testid="layer-body-${labels.id}"]`);
  if ((await labelBody.count()) === 0) {
    await page.click(`[data-testid="layer-disclosure-${labels.id}"]`);
  }
  const region = page.locator(`[data-testid="region-panel-${labels.id}"]`);
  await expect(region).toBeVisible();
  await region.scrollIntoViewIfNeeded();
  await shot('ui-region-panel', region);
});

test('the info panel', async () => {
  await shot('ui-info-panel', page.locator('[data-testid="info-panel"]'));
});

test('the coordinate bar, with the template readout', async () => {
  // Selecting a template space is what loads the SimNIBS `toMNI/` warp, so the readout below the
  // bar fills in a second or two later. It stays "unavailable" on a subject without `toMNI/`.
  const options = await page.locator('[data-testid="coord-space"] option').evaluateAll((els) =>
    els.map((el) => ({
      value: (el as HTMLOptionElement).value,
      disabled: (el as HTMLOptionElement).disabled,
    }))
  );
  const mni = options.find((o) => o.value.startsWith('mni') && !o.disabled);
  if (mni !== undefined) {
    await page.selectOption('[data-testid="coord-space"]', mni.value);
    await page.waitForTimeout(4000);
  }
  await shot('feat-coordinates', page.locator('[data-testid="coord-bar"]'), FEATURES_DIR);
});

test('a length and an angle drawn on a slice', async () => {
  await page.click('[data-testid="layout-2x2"]');
  await page.locator('[data-testid="measure-toggle"]').click();
  const canvas = page.locator('[data-testid="engine-canvas"]');
  const box = (await canvas.boundingBox())!;
  const w = box.width / 2;
  const h = box.height / 2;
  // Three clicks in the axial pane (top-left cell of the 2×2): the third promotes the row to an angle.
  await page.mouse.click(box.x + w * 0.38, box.y + h * 0.35);
  await page.mouse.click(box.x + w * 0.62, box.y + h * 0.35);
  await page.mouse.click(box.x + w * 0.5, box.y + h * 0.65);
  await expect
    .poll(() => page.evaluate(() => window.__tetravox?.store.getState().measurements[0]?.kind))
    .toBe('angle');
  // A second measurement, a length, in the coronal pane (top-right cell).
  await page.mouse.click(box.x + w * 1.35, box.y + h * 0.4);
  await page.mouse.click(box.x + w * 1.65, box.y + h * 0.6);
  await expect
    .poll(() => page.evaluate(() => window.__tetravox?.store.getState().measurements.length))
    .toBe(2);
  await shot('feat-measure', page, FEATURES_DIR);
  // The panel, with its count and its Clear all.
  await expect(page.locator('[data-testid="measure-clear-all"]')).toBeVisible();
  await shot('ui-measure-panel', page.locator('[data-testid="measure-panel"]'));
  await page.locator('[data-testid="measure-toggle"]').click();
  await page.click('[data-testid="layout-1+3"]');
});

test('the settings dialog and its capture tab', async () => {
  await openSettings('appearance');
  await shot('ui-settings', page.locator('[data-testid="settings-dialog"]'));
  await openSettings('capture');
  await shot('ui-settings-capture', page.locator('[data-testid="settings-dialog"]'));
  await page.click('[data-testid="settings-close"]');
});

test('the tabbed keyboard sheet', async () => {
  await page.click('[data-testid="keyboard-help-button"]');
  await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
  await page.click('[data-testid="keymap-tab-view"]');
  await shot('ui-keymap-tabs', page.locator('[data-testid="keyboard-help"]'));
  await page.click('[data-testid="keymap-tab-mouse"]');
  await shot('ui-keymap-mouse', page.locator('[data-testid="keyboard-help"]'));
  await page.click('[data-testid="keyboard-help-close"]');
});

test('the screenshot export dialog', async () => {
  await page.click('[data-testid="screenshot-menu"]');
  await expect(page.locator('[data-testid="screenshot-save"]')).toBeVisible();
  // The preview pane is empty until asked; a tour shot should show the rendered figure.
  await page.click('[data-testid="screenshot-preview"]');
  await expect(page.locator('[data-testid="screenshot-preview-image"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(1000);
  await shot('ui-screenshot-dialog', page.locator('[data-testid="screenshot-dialog"]'));
  await page.click('[data-testid="screenshot-cancel"]');
});

test('the toolbar rail and the app menu', async () => {
  await shot('ui-toolbar-rail', page.locator('[data-testid="toolbar"]'));
  await page.click('[data-testid="app-menu"]');
  await expect(page.locator('[data-testid="app-menu-list"]')).toBeVisible();
  await shot('ui-app-menu');
  await page.keyboard.press('Escape');
});

test('the whole window, light', async () => {
  await setTheme('light');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('light');
  // The offscreen window only repaints the DOM when something reflows; an attribute-only theme
  // switch otherwise leaves the capture showing the previous theme's panels.
  await page.click('[data-testid="layout-2x2"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="layout-1+3"]');
  await page.waitForTimeout(1500);
  // Playwright's CDP screenshot keeps serving the pre-theme raster of the panels in this
  // offscreen window, so the light shot is taken through Electron's own `capturePage`.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const image = await win.capturePage();
    return image.toPNG().toString('base64');
  });
  mkdirSync(UI_DIR, { recursive: true });
  writeFileSync(join(UI_DIR, 'ui-window-light.png'), Buffer.from(png, 'base64'));
  expect(statSync(join(UI_DIR, 'ui-window-light.png')).size).toBeLessThanOrEqual(MAX_BYTES);
  await setTheme('dark');
});
