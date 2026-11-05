/* eslint-disable no-empty-pattern */

/**
 * The tractogram path through the real app: every way of opening a file, the panel's controls, and a
 * scene that reproduces. What the pixels mean is `packages/engine/test/e2e/tracts.spec.ts`.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, clickAppMenu, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const DATA = resolve(APP_ROOT, '../../testdata');
const TRX = join(DATA, 'tract_f32_stored.trx');
const SCALAR = join(DATA, 'tract_sample_scalar.nii');

test.beforeEach(({}, info) => {
  const blocked = info.project.name === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');
});

async function ready(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  return page;
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__tetravox?.engine?.whenSettled();
  });
}

async function openFiles(app: ElectronApplication, page: Page, files: string[]): Promise<void> {
  await app.evaluate(async ({ dialog }, list) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: list,
    })) as typeof dialog.showOpenDialog;
  }, files);
  await clickAppMenu(page, 'open');
  await page.waitForFunction(
    (n) => (window.__tetravox?.store.getState().layers ?? []).length >= n,
    files.length,
    { timeout: 60_000 }
  );
  await settled(page);
}

test('File ▸ Open: a tractogram gets a panel, and sampling from it colours the layer', async ({}, info) => {
  const app = await launchApp(info.project.name as LaunchTarget, { search: 'engine=real' });
  try {
    const page = await ready(app);
    await openFiles(app, page, [SCALAR, TRX]);
    const id = await page.evaluate(() => {
      const state = window.__tetravox!.store.getState();
      const layer = state.layers.find((l) => l.kind === 'tracts')!;
      window.__tetravox!.engine!.setActiveLayer(layer.id);
      return layer.id;
    });
    await settled(page);
    const displayed = page.locator('[data-testid^="tracts-displayed-"]');
    await expect(displayed).toHaveText('4 streamlines · 44 points');

    await page.getByTestId(`tracts-mode-${id}`).selectOption('streamline');
    await page.getByTestId(`tracts-field-${id}`).selectOption('weight');
    await settled(page);
    const mode = await page.evaluate(
      (l) => window.__tetravox!.store.getState().layers.find((x) => x.id === l),
      id
    );
    expect(mode).toMatchObject({ colorMode: 'streamline', field: 'weight' });

    await page.getByTestId(`tracts-sample-${id}`).locator('button, summary').first().click();
    await page.getByTestId(`tracts-sample-run-${id}`).click();
    await page.waitForFunction(
      (l) =>
        (
          window.__tetravox!.store.getState().layers.find((x) => x.id === l) as
            { field?: string } | undefined
        )?.field === 'tract_sample_scalar:vol0:value',
      id
    );
    await settled(page);
    await expect(page.getByTestId(`tracts-nan-${id}`)).toContainText('9 samples');

    await page.evaluate(async () => {
      const engine = window.__tetravox!.engine!;
      engine.setCursor([5, 0.2, 0]);
      await engine.whenSettled();
    });
    await expect(page.getByTestId('probe-streamline').first()).toHaveText(/0/);
    await expect(page.getByTestId('probe-groups').first()).toContainText('left');
  } finally {
    await app.close();
  }
});

test('sampling a vector volume asks what frame it is stored in, and the answer changes the name', async ({}, info) => {
  const app = await launchApp(info.project.name as LaunchTarget, { search: 'engine=real' });
  try {
    const page = await ready(app);
    await openFiles(app, page, [join(DATA, 'tract_sample_plus_x.nii'), TRX]);
    const id = await page.evaluate(() => {
      const state = window.__tetravox!.store.getState();
      const layer = state.layers.find((l) => l.kind === 'tracts')!;
      window.__tetravox!.engine!.setActiveLayer(layer.id);
      return layer.id;
    });
    await settled(page);
    await page.getByTestId(`tracts-sample-${id}`).locator('button, summary').first().click();
    const field = page.getByTestId(`tracts-sample-field-${id}`);
    const basis = page.getByTestId(`tracts-sample-basis-${id}`);
    await field.selectOption('vec-magnitude');
    await expect(basis).toHaveCount(0);
    await field.selectOption('vec-dot');
    await basis.selectOption('fsl');
    await page.getByTestId(`tracts-sample-run-${id}`).click();
    await page.waitForFunction(
      (l) =>
        (
          window.__tetravox!.store.getState().layers.find((x) => x.id === l) as
            { field?: string } | undefined
        )?.field === 'tract_sample_plus_x:vector-fsl:dot',
      id
    );
  } finally {
    await app.close();
  }
});

test('the command line opens a tractogram, and the capability is advertised', async ({}, info) => {
  const app = await launchApp(info.project.name as LaunchTarget, {
    search: 'engine=real',
    args: [TRX],
  });
  try {
    const page = await ready(app);
    await page.waitForFunction(
      () => (window.__tetravox?.store.getState().layers ?? []).some((l) => l.kind === 'tracts'),
      undefined,
      { timeout: 60_000 }
    );
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      tractLayerProtocol?: number;
    };
    expect(pkg.tractLayerProtocol).toBe(1);
  } finally {
    await app.close();
  }
});

test('a scene with a tractogram, a volume and a sample step opens from disk', async ({}, info) => {
  const dir = mkdtempSync(join(tmpdir(), 'tvx-tract-scene-'));
  const scene = join(dir, 'tracts.tetravox.json');
  const first = await launchApp(info.project.name as LaunchTarget, { search: 'engine=real' });
  try {
    const page = await ready(first);
    await openFiles(first, page, [SCALAR, TRX]);
    const spec = await page.evaluate(async () => {
      const engine = window.__tetravox!.engine!;
      const ds = [...engine.scene.datasets.values()];
      const tract = ds.find((d) => d.kind === 'tractogram')!;
      const vol = ds.find((d) => d.kind === 'volume')!;
      const field = await engine.sampleTracts({
        tractogramId: tract.id,
        sourceId: vol.id,
        op: 'value',
      });
      const layer = engine.scene.layers.find((l) => l.kind === 'tracts')!;
      engine.updateLayer(layer.id, { colorMode: 'vertex', field: field.name } as never);
      await engine.whenSettled();
      return engine.serialize();
    });
    writeFileSync(scene, JSON.stringify(spec));
  } finally {
    await first.close();
  }
  const second = await launchApp(info.project.name as LaunchTarget, {
    search: 'engine=real',
    args: [scene],
  });
  try {
    const page = await ready(second);
    await page.waitForFunction(
      () =>
        (window.__tetravox?.store.getState().layers ?? []).some(
          (l) => l.kind === 'tracts' && (l as { field?: string }).field !== undefined
        ),
      undefined,
      { timeout: 60_000 }
    );
    await settled(page);
    const got = await page.evaluate(() => {
      const engine = window.__tetravox!.engine!;
      const tract = [...engine.scene.datasets.values()].find((d) => d.kind === 'tractogram');
      return tract?.kind === 'tractogram'
        ? { samples: tract.samples.length, fields: tract.vertexFields.map((f) => f.name) }
        : null;
    });
    expect(got?.samples).toBe(1);
    expect(got?.fields).toContain('tract_sample_scalar:vol0:value');
  } finally {
    await second.close();
  }
});
