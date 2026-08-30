/**
 * File ▸ Sample Data… (`main/sample-data.ts`, `dialogs/SampleDataDialog.tsx`).
 *
 * What is asserted is the part that needs a real Electron: the catalogue crosses the preload bridge
 * from main, the cache directory main reports is the one `TETRAVOX_SAMPLE_DIR` named, every sample
 * renders a card with its licence, and a sample whose files are already in that directory (with
 * the right sizes) is offered as **Open**, not **Download & open**. No download runs here — that
 * would need the network — the download path itself is unit-tested with an injected fetch.
 */

/* eslint-disable no-empty-pattern */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { APP_ROOT, clickAppMenu, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

interface CatalogFile {
  name: string;
  bytes: number;
}
interface CatalogFileHashed extends CatalogFile {
  sha256: string;
}
interface CatalogSample {
  id: string;
  licence: string;
  scene: string;
  files: CatalogFileHashed[];
}
const catalog = JSON.parse(
  readFileSync(resolve(APP_ROOT, 'src', 'shared', 'sample-catalog.json'), 'utf8')
) as { samples: CatalogSample[] };

const SMALLEST = 'totalseg-ct';

test('the Sample Data dialog lists the catalogue from main, with the cache and each licence', async ({}, testInfo) => {
  const target = testInfo.project.name as LaunchTarget;
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');

  const cache = mkdtempSync(join(tmpdir(), 'tvx-sample-e2e-'));
  // Pretend the smallest sample is already downloaded: right names, right sizes. The status check
  // is size-based (hashes are checked on open), so this is enough to flip the button.
  const sample = catalog.samples.find((s) => s.id === SMALLEST);
  if (sample === undefined) throw new Error(`catalogue lost ${SMALLEST}`);
  mkdirSync(join(cache, sample.id), { recursive: true });
  for (const f of sample.files)
    writeFileSync(join(cache, sample.id, f.name), Buffer.alloc(f.bytes));

  try {
    const app = await launchApp(target, {
      search: 'engine=mock',
      env: { TETRAVOX_SAMPLE_DIR: cache },
    });
    const page = await app.firstWindow();
    await expect(page.locator('[data-testid="layer-panel-empty"]')).toContainText('Sample Data');

    await clickAppMenu(page, 'sample-data');
    const dialog = page.locator('[data-testid="sample-data-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="sample-cache-dir"]')).toContainText(resolve(cache));

    for (const s of catalog.samples) {
      const card = page.locator(`[data-testid="sample-card-${s.id}"]`);
      await expect(card, s.id).toBeVisible();
      await expect(card, `${s.id} licence`).toContainText(s.licence);
    }
    await expect(page.locator(`[data-testid="sample-open-${SMALLEST}"]`)).toHaveText('Open');
    await expect(page.locator(`[data-testid="sample-remove-${SMALLEST}"]`)).toBeVisible();
    await expect(page.locator('[data-testid="sample-open-ernie-t1"]')).toHaveText(
      'Download & open'
    );

    // Remove deletes the fake files and the button reverts — through main and back.
    await page.click(`[data-testid="sample-remove-${SMALLEST}"]`);
    await expect(page.locator(`[data-testid="sample-open-${SMALLEST}"]`)).toHaveText(
      'Download & open'
    );

    await page.click('[data-testid="sample-close"]');
    await expect(dialog).toBeHidden();
    await app.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

/**
 * Opening a cached sample goes through the **scene** route: main writes the shipped scene beside
 * the files and the renderer loads it, so the layers, layout and camera arrive configured. The
 * files must be the real ones — main re-hashes a cached file before it trusts it, and a
 * placeholder would send it to the network — so this leg needs the staged store
 * (`scripts/sample-data/stage.py` → `data/sample-store/<sha256>`) and skips without it.
 */
test('opening a cached sample loads its ready-made scene', async ({}, testInfo) => {
  const target = testInfo.project.name as LaunchTarget;
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');

  const sample = catalog.samples.find((s) => s.id === SMALLEST);
  if (sample === undefined) throw new Error(`catalogue lost ${SMALLEST}`);
  const store = resolve(APP_ROOT, '..', '..', 'data', 'sample-store');
  test.skip(
    !sample.files.every((f) => existsSync(join(store, f.sha256))),
    'data/sample-store is not staged on this machine'
  );

  const cache = mkdtempSync(join(tmpdir(), 'tvx-sample-e2e-'));
  mkdirSync(join(cache, sample.id), { recursive: true });
  for (const f of sample.files) copyFileSync(join(store, f.sha256), join(cache, sample.id, f.name));

  try {
    const app = await launchApp(target, {
      search: 'engine=mock',
      env: { TETRAVOX_SAMPLE_DIR: cache },
    });
    const page = await app.firstWindow();
    await clickAppMenu(page, 'sample-data');
    await page.click(`[data-testid="sample-open-${SMALLEST}"]`);
    await expect(page.locator('[data-testid="sample-data-dialog"]')).toBeHidden();

    // The scene, not just the files: one row per dataset in the shipped scene, and its layout.
    const scene = JSON.parse(
      readFileSync(resolve(APP_ROOT, 'src', 'shared', 'scenes', sample.scene), 'utf8')
    ) as { layers: unknown[]; layout: { kind: string } };
    await expect(page.locator('[data-testid^="layer-row-"]')).toHaveCount(scene.layers.length);
    const layout = await page.evaluate(() => window.__tetravox?.store.getState().layoutKind);
    expect(layout).toBe(scene.layout.kind);
    expect(existsSync(join(cache, sample.id, sample.scene))).toBe(true);
    await app.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
