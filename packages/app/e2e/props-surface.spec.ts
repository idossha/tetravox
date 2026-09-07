/**
 * R4 of `docs/requirements/2026-09-06-idohaber-surfaces.md`: the **surface** editor is its own
 * panel — five sections, and none of the tet mesh's.
 *
 * Against the stand-in engine (`?engine=mock`), which reports a `.gii` with no tets exactly as the
 * real loader does, so the app opens it as a `surface` layer (R1) and mounts `SurfaceProperties`.
 * The assertions are DOM presence by test id: the five surface sections exist, the four mesh-only
 * ones do not, and the row reads `surface` with a hemisphere-first summary.
 */

/* eslint-disable no-empty-pattern */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const SURFACE = resolve(APP_ROOT, '..', '..', 'testdata', 'surf_ascii.surf.gii');

let app: ElectronApplication | undefined;
let page: Page;
let userDataDir: string | null = null;

test.describe('the surface editor', () => {
  test.beforeEach(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? undefined);
    userDataDir = mkdtempSync(join(tmpdir(), 'tvx-props-surface-'));
    app = await launchApp(target, {
      search: 'engine=mock&mockStepMs=5',
      args: [`--user-data-dir=${userDataDir}`, SURFACE],
    });
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
    await page.waitForFunction(
      () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
      undefined,
      { timeout: 60_000 }
    );
  });

  test.afterEach(async () => {
    // The packaged project skips in `beforeEach` when no artefact is built; nothing to close then.
    if (app !== undefined) await app.close();
    if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = null;
  });

  test('a .gii opens as a surface layer with the five surface sections and no mesh-only one', async () => {
    const { id, kind, colorMode } = await page.evaluate(() => {
      const layer = window.__tetravox!.store.getState().layers[0]!;
      return {
        id: layer.id,
        kind: layer.kind,
        colorMode: (layer as { colorMode: string }).colorMode,
      };
    });
    expect(kind).toBe('surface');
    expect(colorMode).toBe('solid');
    await expect(page.locator(`[data-testid="layer-row-${id}"]`)).toContainText('surface');

    await page.click(`[data-testid="layer-row-${id}"]`);
    await expect(page.locator(`[data-testid="surface-properties-${id}"]`)).toBeVisible();
    for (const section of ['color', 'appearance', 'outline', 'clip']) {
      await expect(page.locator(`[data-testid="surface-${section}-${id}"]`), section).toBeVisible();
    }
    // Regions only while an annotation is shown; none is, so none.
    await expect(page.locator(`[data-testid="surface-regions-${id}"]`)).toHaveCount(0);
    for (const mesh of [
      'mesh-isolation',
      'mesh-glyphs',
      'mesh-cut2d',
      'mesh-clip-caps',
      'mesh-properties',
      'mesh-field',
    ]) {
      await expect(page.locator(`[data-testid="${mesh}-${id}"]`), mesh).toHaveCount(0);
    }
    await expect(page.locator(`[data-testid="surface-attach-${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="surface-solid-color-${id}"]`)).toBeVisible();
  });

  test('an attached annotation becomes the colour source and brings the Regions section', async () => {
    const id = await page.evaluate(async () => {
      const t = window.__tetravox!;
      const layer = t.store.getState().layers[0]!;
      const annot = '/m2m/segmentation/lh.ernie_DK40.annot';
      t.controller!.open([
        { name: 'lh.ernie_DK40.annot', path: annot, source: { kind: 'path', path: annot } },
      ]);
      return layer.id;
    });
    await page.waitForFunction(
      () =>
        (window.__tetravox!.store.getState().layers[0] as { colorMode?: string }).colorMode ===
        'annotation'
    );
    await page.click(`[data-testid="layer-row-${id}"]`);
    await expect(page.locator(`[data-testid="surface-regions-${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="surface-annotation-${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="region-panel-${id}"]`)).toHaveAttribute(
      'data-kind',
      'annot'
    );
    // Back to solid, and the annotation is kept for the way back.
    await page.selectOption(`[data-testid="surface-colormode-${id}"]`, 'solid');
    await expect(page.locator(`[data-testid="surface-regions-${id}"]`)).toHaveCount(0);
    const kept = await page.evaluate(() => {
      const l = window.__tetravox!.store.getState().layers[0] as {
        colorMode: string;
        annotation?: { name: string };
      };
      return { colorMode: l.colorMode, annotation: l.annotation?.name ?? null };
    });
    expect(kept).toEqual({ colorMode: 'solid', annotation: 'lh.ernie_DK40.annot' });
  });
});
