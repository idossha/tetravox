/**
 * The interface pictures for `docs/screenshots/gallery-2026-08-28/` — the states a `--job` cannot
 * reach because they are UI, not engine: the measurement overlay drawn by clicks, the histogram
 * editor, the info / header / region panels, the keyboard sheet, the settings and screenshot
 * dialogs, the app menu, collapsed sidebars, and the whole window in both themes.
 *
 * A capture spec, not a gate: it asserts only what it needs to know a picture is of the right thing
 * (the measurement exists, the dialog is open) and that every PNG stays under 1.5 MB. Offscreen
 * (AGENTS rule 8 — never set `TETRAVOX_E2E_HEADED`). Skips, never fails, when `TETRAVOX_TESTDATA`
 * is unset (AGENTS rule 2). Run it alone:
 *
 *   export TETRAVOX_TESTDATA=…/derivatives/SimNIBS/sub-ernie
 *   pnpm --filter @tetravox/app exec playwright test e2e/ui-tour-gallery.spec.ts --project=dev
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const LABELS = join(ROOT, 'm2m_ernie', 'segmentation', 'labeling.nii.gz');
const OUT = resolve(APP_ROOT, '..', '..', 'docs', 'screenshots', 'gallery-2026-08-28');
const MAX_BYTES = 1.5 * 1024 * 1024;

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

async function shot(name: string, target: Page | Locator = page): Promise<void> {
  const file = join(OUT, `${name}.png`);
  mkdirSync(OUT, { recursive: true });
  await settled(page);
  await target.screenshot({ path: file });
  expect(statSync(file).size, `${name}.png over 1.5 MB`).toBeLessThanOrEqual(MAX_BYTES);
}

async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  if ((await page.locator('[data-testid="settings-panel-appearance"]').count()) === 0) {
    await page.click('[data-testid="settings-button"]');
  }
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
    async ([t1, labels]: string[]) => {
      const tv = window.__tetravox;
      if (tv?.controller == null) throw new Error('no shell');
      for (const path of [t1, labels] as string[]) {
        const allowed = await window.tetravox.allowPath(path);
        if (allowed === null) throw new Error(`main refused ${path}`);
        let lut: string | null = null;
        if (path.endsWith('labeling.nii.gz')) {
          const cand = allowed.path.replace(/labeling\.nii\.gz$/, 'labeling_LUT.txt');
          lut = (await window.tetravox.allowPath(cand))?.path ?? null;
        }
        tv.controller.open([
          {
            name: allowed.path.split('/').pop() ?? allowed.path,
            path: allowed.path,
            source: {
              kind: 'path',
              path: allowed.path,
              ...(lut === null ? {} : { sidecars: { lut } }),
            },
          },
        ]);
      }
    },
    [T1, LABELS]
  );
  await page.waitForFunction(
    () => {
      const s = window.__tetravox?.store.getState();
      return (
        (s?.layers ?? []).length >= 2 &&
        (s?.loads ?? []).every((c) => c.state !== 'queued' && c.state !== 'loading')
      );
    },
    undefined,
    { timeout: 280_000 }
  );
  // Both sidebars open, 2×2, dark, a mid-brain cursor.
  await page.evaluate(() => {
    const s = window.__tetravox!.store.getState();
    if (s.leftPanelCollapsed) window.__tetravox!.store.setState({ leftPanelCollapsed: false });
    if (s.rightPanelCollapsed) window.__tetravox!.store.setState({ rightPanelCollapsed: false });
    window.__tetravox!.engine?.setCursor([0, -18, 8]);
  });
  await setTheme('dark');
});

test.afterAll(async () => {
  await app?.close();
});

test('the whole window, dark', async () => {
  await shot('ui-window-dark');
});

test('a length and an angle drawn on a slice', async () => {
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
  await shot('ui-measure-length-and-angle');
  await shot('ui-measure-panel', page.locator('[data-testid="measure-panel"]'));
  await page.locator('[data-testid="measure-toggle"]').click();
});

test('the histogram editor of the T1 layer', async () => {
  const t1 = (await layerIds()).find((l) => l.name.startsWith('T1'))!;
  await page.evaluate((id) => window.__tetravox!.engine!.setActiveLayer(id), t1.id);
  const body = page.locator(`[data-testid="layer-body-${t1.id}"]`);
  if ((await body.count()) === 0) await page.click(`[data-testid="layer-disclosure-${t1.id}"]`);
  await expect(page.locator(`[data-testid="volume-histogram-${t1.id}-plot"]`)).toBeVisible();
  await shot('ui-histogram-panel', page.locator(`[data-testid="layer-row-${t1.id}"]`));
});

test('the region panel of the label volume', async () => {
  const labels = (await layerIds()).find((l) => l.name.startsWith('labeling'))!;
  await page.evaluate((id) => window.__tetravox!.engine!.setActiveLayer(id), labels.id);
  const body = page.locator(`[data-testid="layer-body-${labels.id}"]`);
  if ((await body.count()) === 0) await page.click(`[data-testid="layer-disclosure-${labels.id}"]`);
  const region = page.locator(`[data-testid="region-panel-${labels.id}"]`);
  await expect(region).toBeVisible();
  await region.scrollIntoViewIfNeeded();
  await shot('ui-region-panel', region);
  await shot('ui-layer-panel', page.locator('[data-testid="layer-panel"]'));
});

test('the info and header panels', async () => {
  await shot('ui-info-panel', page.locator('[data-testid="info-panel"]'));
  await shot('ui-header-panel', page.locator('[data-testid="header-panel"]'));
  await shot('ui-coordinate-bar', page.locator('[data-testid="coord-bar"]'));
});

test('the keyboard help sheet', async () => {
  await page.click('[data-testid="keyboard-help-button"]');
  await expect(page.locator('[data-testid="keyboard-help"]')).toBeVisible();
  await shot('ui-keyboard-help');
  await page.click('[data-testid="keyboard-help-close"]');
});

test('the settings dialog', async () => {
  await page.click('[data-testid="settings-button"]');
  await expect(page.locator('[data-testid="settings-panel-appearance"]')).toBeVisible();
  await shot('ui-settings-dialog');
  await page.click('[data-testid="settings-close"]');
});

test('the screenshot dialog', async () => {
  await page.click('[data-testid="screenshot-menu"]');
  await expect(page.locator('[data-testid="screenshot-save"]')).toBeVisible();
  await page.waitForTimeout(1500); // the preview renders asynchronously
  await shot('ui-screenshot-dialog');
  await page.click('[data-testid="screenshot-cancel"]');
});

test('the app menu, open', async () => {
  await page.click('[data-testid="app-menu"]');
  await expect(page.locator('[data-testid="app-menu-list"]')).toBeVisible();
  await shot('ui-app-menu-open');
  await page.keyboard.press('Escape');
});

test('both sidebars collapsed', async () => {
  await page.click('[data-testid="left-panel-collapse"]');
  await page.click('[data-testid="right-panel-collapse"]');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__tetravox!.store.getState();
        return s.leftPanelCollapsed && s.rightPanelCollapsed;
      })
    )
    .toBe(true);
  await shot('ui-sidebars-collapsed');
  await page.evaluate(() =>
    window.__tetravox!.store.setState({ leftPanelCollapsed: false, rightPanelCollapsed: false })
  );
});

test('the whole window, light — and a few layouts', async () => {
  await setTheme('light');
  await shot('ui-window-light');
  await page.click('[data-testid="layout-1+3"]');
  await shot('ui-window-light-layout-1plus3');
  await page.click('[data-testid="layout-3d-only"]');
  await shot('ui-window-light-layout-3d-only');
  await page.click('[data-testid="keyboard-help-button"]');
  await shot('ui-keyboard-help-light');
  await page.click('[data-testid="keyboard-help-close"]');
  await page.click('[data-testid="layout-2x2"]');
  await shot('ui-layer-panel-light', page.locator('[data-testid="layer-panel"]'));
  await shot('ui-info-panel-light', page.locator('[data-testid="info-panel"]'));
  await setTheme('dark');
});
