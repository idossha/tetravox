/** §8 tensor controls against the real worker/renderer, in a never-shown Electron window. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

// Electron is launched explicitly; no Playwright browser fixture is needed.
// eslint-disable-next-line no-empty-pattern
test('tensor display is explicit, editable, and reversible', async ({}, info) => {
  const target = info.project.name as LaunchTarget;
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');
  const profile = mkdtempSync(join(tmpdir(), 'tvx-tensors-'));
  const app = await launchApp(target, {
    args: [`--user-data-dir=${profile}`, resolve(APP_ROOT, '../../testdata/tensor_fsl.nii.gz')],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]');
    const display = page.getByLabel('Volume display', { exact: true });
    await expect(display).toHaveValue('scalar');
    await display.selectOption('fsl');
    await expect(page.getByLabel('Tensor coordinate basis')).toHaveValue('fsl');
    await expect(page.getByLabel('Tensor glyph spacing')).toHaveValue('2');
    await page.getByLabel('Tensor glyph spacing').selectOption('4');
    await page.getByLabel('Tensor coordinate basis').selectOption('world');
    const tensor = await page.evaluate(() => {
      const layer = window.__tetravox!.store.getState().layers.find((l) => l.kind === 'volume');
      return layer?.kind === 'volume' ? layer.tensor : undefined;
    });
    expect(tensor).toEqual({ order: 'fsl', basis: 'world', stride: 4, minFA: 0 });
    await display.selectOption('scalar');
    await expect(page.getByLabel('Tensor coordinate basis')).toHaveCount(0);
    await expect(page.getByLabel('Interpolation', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Next volume', { exact: true })).toBeVisible();
    if (process.platform === 'darwin') {
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => !w.isVisible())
        )
      ).toBe(true);
    }
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
