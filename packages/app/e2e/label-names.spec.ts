/**
 * §7.6's names by default, in the running app with the real engine: FreeSurfer ids get names and
 * colours, a mask does not, and the Regions section says which.
 *
 * Fixtures are written here, 3D `uint16` NIfTI with the ids known by construction. Expected names and
 * colours are `FreeSurferColorLUT.txt`'s. The guard's cases are `labelNames.test.ts`; this pins that
 * the panel, Inspect, the scene and a loaded file all follow it.
 */

/* eslint-disable no-empty-pattern */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

/** A 4×4×4 volume whose voxels cycle through `ids`, identity sform, so voxel = mm. */
function niftiOf(ids: number[]): Buffer {
  const head = Buffer.alloc(352);
  head.writeInt32LE(348, 0);
  [3, 4, 4, 4, 1, 1, 1, 1].forEach((v, i) => head.writeInt16LE(v, 40 + i * 2));
  head.writeInt16LE(512, 70); // uint16
  head.writeInt16LE(16, 72);
  [1, 1, 1, 1].forEach((v, i) => head.writeFloatLE(v, 76 + i * 4));
  head.writeFloatLE(352, 108);
  head.writeFloatLE(1, 112);
  head.writeInt16LE(1, 254); // sform_code
  [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ].forEach((row, r) => row.forEach((v, c) => head.writeFloatLE(v, 280 + r * 16 + c * 4)));
  head.write('n+1\0', 344, 'latin1');
  const data = Buffer.alloc(64 * 2);
  for (let i = 0; i < 64; i += 1) data.writeUInt16LE(ids[i % ids.length] as number, i * 2);
  return Buffer.concat([head, data]);
}

const dir = mkdtempSync(join(tmpdir(), 'tvx-names-'));
const ASEG = join(dir, 'aseg.nii');
const MASK = join(dir, 'mask.nii');
const LUT = join(dir, 'mine_table.txt');
writeFileSync(ASEG, niftiOf([0, 2, 41, 10, 49]));
writeFileSync(MASK, niftiOf([0, 1]));
writeFileSync(LUT, '10 MyThalamus 1 2 3 255\n41 MyWhite 4 5 6 255\n');

test.describe('names by default (real engine)', () => {
  let app: ElectronApplication;
  let page: Page;
  let aseg: string;
  let mask: string;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real', args: [ASEG, MASK] });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForFunction(
      () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 2,
      undefined,
      { timeout: 60_000 }
    );
    const found = await page.evaluate(() => {
      const s = window.__tetravox!.store.getState();
      const of = (n: string): string =>
        s.layers.find((l) => s.datasets.find((d) => d.id === l.datasetId)?.name === n)?.id ?? '';
      return { aseg: of('aseg.nii'), mask: of('mask.nii') };
    });
    aseg = found.aseg;
    mask = found.mask;
    await page.click(`[data-testid="layer-name-${aseg}"]`);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('an aseg gets FreeSurfer’s names and colours, and says so', async () => {
    await expect(page.getByTestId(`region-names-${aseg}`)).toContainText(
      'Names: FreeSurfer, assumed from label ids'
    );
    await expect(page.getByTestId(`region-name-${aseg}-10`)).toHaveText('Left-Thalamus');
    await expect(page.getByTestId(`region-name-${aseg}-41`)).toHaveText(
      'Right-Cerebral-White-Matter'
    );
    // FreeSurferColorLUT.txt: `10 Left-Thalamus 0 118 14 0`.
    expect(await page.getByTestId(`region-color-${aseg}-10`).inputValue()).toBe('#00760e');
    await expect(page.getByTestId(`region-name-${aseg}-0`)).toHaveText('Background');
  });

  test('search finds a name, and Inspect reads it at the cursor', async () => {
    const search = page.getByTestId(`region-search-${aseg}`);
    await search.fill('thal');
    await expect(page.getByTestId(`region-list-${aseg}`)).toHaveAttribute('data-rows', '2');
    await search.fill('');
    // The third voxel along x, id 41 by construction.
    await page.evaluate(() => window.__tetravox?.engine?.setCursor([2, 0, 0]));
    await expect(page.getByTestId('probe-label').first()).toContainText(
      '41 · Right-Cerebral-White-Matter'
    );
  });

  test('a binary mask keeps its number, and says that too', async () => {
    await page.click(`[data-testid="layer-name-${mask}"]`);
    await expect(page.getByTestId(`region-names-${mask}`)).toContainText('No names in this file');
    await expect(page.getByTestId(`region-names-toggle-${mask}`)).toHaveCount(0);
    await expect(page.getByTestId(`region-name-${mask}-1`)).toHaveText('Label 1');
    await page.click(`[data-testid="layer-name-${aseg}"]`);
  });

  test('Use numbers takes them away everywhere, is saved in the scene, and comes back', async () => {
    await page.click(`[data-testid="region-names-toggle-${aseg}"]`);
    await expect(page.getByTestId(`region-name-${aseg}-10`)).toHaveText('Label 10');
    await expect(page.getByTestId(`region-names-${aseg}`)).toContainText('Names: numbers');
    await expect(page.getByTestId('probe-label').first()).toContainText('41 · —');
    const saved = await page.evaluate(
      (id) => window.__tetravox?.engine?.serialize().layers.find((l) => l.id === id),
      aseg
    );
    expect((saved as { labelNames?: string }).labelNames).toBe('numbers');

    await page.click(`[data-testid="region-names-toggle-${aseg}"]`);
    await expect(page.getByTestId(`region-name-${aseg}-10`)).toHaveText('Left-Thalamus');
  });

  test('a scene saved with numbers opens with numbers', async () => {
    await page.click(`[data-testid="region-names-toggle-${aseg}"]`);
    const restored = await page.evaluate(async (id) => {
      const engine = window.__tetravox!.engine!;
      const spec = engine.serialize();
      await engine.updateLayer(id, { labelNames: undefined } as never);
      const named = engine.scene.datasets.values().next().value as { labelTable?: unknown };
      const before = named.labelTable !== undefined;
      await engine.load(spec, (r) => r.absPath ?? r.path);
      const asegLayer = engine.scene.layers.find(
        (l) => engine.scene.datasets.get(l.datasetId)?.name === 'aseg.nii'
      );
      return { before, layer: asegLayer?.id ?? '' };
    }, aseg);
    expect(restored.before).toBe(true);
    aseg = restored.layer;
    await page.click(`[data-testid="layer-name-${aseg}"]`);
    await expect(page.getByTestId(`region-name-${aseg}-10`)).toHaveText('Label 10');
    await page.click(`[data-testid="region-names-toggle-${aseg}"]`);
    await expect(page.getByTestId(`region-name-${aseg}-10`)).toHaveText('Left-Thalamus');
  });

  test('a loaded table wins and is remembered as the lookup sidecar', async () => {
    await app.evaluate(
      async ({ dialog }, list) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: list,
        })) as typeof dialog.showOpenDialog;
      },
      [LUT]
    );
    await page.click(`[data-testid="region-names-load-${aseg}"]`);
    await expect(page.getByTestId(`region-names-${aseg}`)).toContainText('Names: mine_table.txt');
    await expect(page.getByTestId(`region-name-${aseg}-10`)).toHaveText('MyThalamus');
    expect(await page.getByTestId(`region-color-${aseg}-10`).inputValue()).toBe('#010203');
    const refs = await page.evaluate(() => window.__tetravox?.engine?.serialize().datasets);
    expect(JSON.stringify(refs)).toContain('mine_table.txt');
  });
});
