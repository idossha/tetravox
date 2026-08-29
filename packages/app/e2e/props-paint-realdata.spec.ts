/**
 * Per-tissue paint (`tagStyle[tag].colorMode`) on **real data**: `Thalamus_TI.msh` coloured by its
 * element field, with one tissue flipped back to its fixed colour from the tissue row's chip.
 *
 * The assertion is a count, not a look (AGENTS rule 1). In the axial cut the fill is unlit, so the
 * tissue's own colour is counted byte-exactly before and after the flip. In 3D the surface is lit,
 * so the count is of pixels the flip *moved*: the scalp is the whole visible head, and a flip of
 * its paint changes most of the pane, while the flip back changes nothing.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS.md).
 */

/* eslint-disable no-empty-pattern */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';
import type { DecodedPng } from './png';

const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';
const MESH = join(ROOT, 'Simulations', 'Thalamus', 'TI', 'mesh', 'Thalamus_TI.msh');
const OUT = process.env['TETRAVOX_PAINT_SHOTS'] ?? '';

/** Scalp: the one tissue a 3D view from outside can see, and the one a user would hold flat. */
const SCALP_TAG = 5;

let app: ElectronApplication;
let page: Page;
let layerId: string;

async function pane(mode: 'axial' | '3d'): Promise<DecodedPng> {
  const base64 = await page.evaluate(async (want) => {
    const engine = window.__tetravox?.engine;
    if (engine == null) throw new Error('no engine');
    const view = engine.views.find((v) =>
      want === '3d' ? !('mode' in v) : 'mode' in v && v.mode === want
    );
    if (view === undefined) throw new Error(`no ${want} view`);
    await engine.whenSettled();
    engine.renderNow();
    await engine.whenSettled();
    const blob = await engine.screenshot({
      target: 'view',
      viewId: view.id,
      background: 'scene',
      include: {
        colorbar: false,
        orientationLabels: false,
        crosshair: false,
        cornerInfo: false,
        scaleBar: false,
        orientationCube: false,
      },
      autoTrim: false,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }, mode);
  return decodePng(Buffer.from(base64, 'base64'));
}

/** Pixels within ±tol of `rgb` — a lit 3D surface shades the flat colour, a 2D fill does not. */
function countNear(png: DecodedPng, rgb: readonly number[], tol: number): number {
  let n = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (
      Math.abs((png.pixels[i] ?? 0) - (rgb[0] ?? 0)) <= tol &&
      Math.abs((png.pixels[i + 1] ?? 0) - (rgb[1] ?? 0)) <= tol &&
      Math.abs((png.pixels[i + 2] ?? 0) - (rgb[2] ?? 0)) <= tol
    ) {
      n += 1;
    }
  }
  return n;
}

/** Pixels that differ between two panes of the same size by more than `tol` in any channel. */
function changed(a: DecodedPng, b: DecodedPng, tol = 48): number {
  let n = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    if (
      Math.abs((a.pixels[i] ?? 0) - (b.pixels[i] ?? 0)) > tol ||
      Math.abs((a.pixels[i + 1] ?? 0) - (b.pixels[i + 1] ?? 0)) > tol ||
      Math.abs((a.pixels[i + 2] ?? 0) - (b.pixels[i + 2] ?? 0)) > tol
    ) {
      n += 1;
    }
  }
  return n;
}

async function scalpColorBytes(): Promise<number[]> {
  return page.evaluate((id) => {
    const s = window.__tetravox?.store.getState();
    const layer = s?.layers.find((l) => l.id === id);
    const ds = s?.datasets.find((d) => d.id === layer?.datasetId);
    if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh dataset');
    const tag = ds.tags.find((t) => t.id === 5 && t.kind === 'tet');
    if (tag === undefined) throw new Error('no Scalp tet tag');
    return tag.color.slice(0, 3).map((c) => Math.round(c * 255));
  }, layerId);
}

async function shoot(name: string): Promise<void> {
  if (OUT === '') return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, name), scale: 'css' });
}

test.describe('per-tissue paint on Thalamus_TI.msh (real data)', () => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(300_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real' });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });

    layerId = await page.evaluate(async (path: string) => {
      const tv = window.__tetravox;
      if (tv?.controller == null || tv.engine == null) throw new Error('no shell');
      const allowed = await window.tetravox.allowPath(path);
      if (allowed === null) throw new Error(`main refused ${path}`);
      const opt = await window.tetravox.allowPath(`${allowed.path}.opt`);
      const name = allowed.path.split('/').pop() ?? allowed.path;
      tv.controller.open([
        {
          name,
          path: allowed.path,
          source: {
            kind: 'path',
            path: allowed.path,
            ...(opt === null ? {} : { sidecars: { opt: opt.path } }),
          },
        },
      ]);
      const started = Date.now();
      while (Date.now() - started < 240_000) {
        const mesh = tv.store.getState().layers.find((l) => l.kind === 'mesh');
        if (mesh !== undefined) return mesh.id;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('Thalamus_TI.msh never landed');
    }, MESH);

    // Colour the whole mesh by its first element field (TI_max) so every tissue starts on the field.
    await page.evaluate(async (id) => {
      const tv = window.__tetravox;
      if (tv?.controller == null || tv.engine == null) throw new Error('no shell');
      const s = tv.store.getState();
      const layer = s.layers.find((l) => l.id === id);
      const ds = s.datasets.find((d) => d.id === layer?.datasetId);
      if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh dataset');
      const field = ds.fields.find((f) => f.source === 'elm') ?? ds.fields[0];
      if (field === undefined) throw new Error('mesh carries no field');
      tv.controller.patchLayer(id, {
        colorMode: 'field',
        field: { source: field.source, name: field.name, component: 'mag' },
      });
      await tv.engine.whenSettled();
    }, layerId);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('every tissue row carries an inherited Field chip', async () => {
    const chip = page.getByTestId(`region-paint-${layerId}-${SCALP_TAG}`);
    await expect(chip).toHaveAttribute('data-paint', 'field');
    await expect(chip).toHaveAttribute('data-overridden', 'false');
    await expect(page.getByTestId(`mesh-paint-overrides-${layerId}`)).toHaveCount(0);
    await shoot('paint-1-all-field.png');
  });

  test('flipping Scalp to Colour paints it flat in 3D and in the axial cut while the rest stays on the field', async () => {
    test.setTimeout(180_000);
    const scalp = await scalpColorBytes();
    const before3d = await pane('3d');
    const beforeAx = countNear(await pane('axial'), scalp, 2);

    await page.getByTestId(`region-paint-${layerId}-${SCALP_TAG}`).click();
    const chip = page.getByTestId(`region-paint-${layerId}-${SCALP_TAG}`);
    await expect(chip).toHaveAttribute('data-paint', 'color');
    await expect(chip).toHaveAttribute('data-overridden', 'true');
    await expect(page.getByTestId(`mesh-paint-overrides-${layerId}`)).toContainText('1 tissue');

    const style = await page.evaluate((id) => {
      const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
      if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
      return { vol: layer.tagStyle[5]?.colorMode, surf: layer.tagStyle[1005]?.colorMode };
    }, layerId);
    expect(style).toEqual({ vol: 'color', surf: 'color' });

    const after3d = await pane('3d');
    const afterAx = countNear(await pane('axial'), scalp, 2);
    await shoot('paint-2-scalp-colour.png');
    // 2D: the fill is unlit, so the scalp ring is byte-exactly its own colour once it paints flat.
    expect(afterAx, `scalp colour in axial: ${beforeAx} → ${afterAx}`).toBeGreaterThan(
      beforeAx * 4 + 500
    );
    // 3D: the whole visible head is scalp, so most of its lit pixels move off the field colours.
    const moved = changed(before3d, after3d);
    const total = after3d.width * after3d.height;
    expect(moved / total, `3D pixels changed by the flip: ${moved}/${total}`).toBeGreaterThan(0.15);

    // A second click is "follow the layer again": the override is dropped, not pinned to 'field'.
    await chip.click();
    await expect(chip).toHaveAttribute('data-paint', 'field');
    await expect(chip).toHaveAttribute('data-overridden', 'false');
    const back = await page.evaluate((id) => {
      const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
      if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
      return layer.tagStyle[5]?.colorMode;
    }, layerId);
    expect(back).toBeUndefined();
    expect(changed(before3d, await pane('3d')) / total).toBeLessThan(0.01);
  });

  test('the mirror image: a tag-coloured layer with one tissue on the field', async () => {
    test.setTimeout(180_000);
    await page.evaluate(async (id) => {
      const tv = window.__tetravox;
      if (tv?.controller == null || tv.engine == null) throw new Error('no shell');
      tv.controller.patchLayer(id, { colorMode: 'tag' });
      await tv.engine.whenSettled();
    }, layerId);
    const chip = page.getByTestId(`region-paint-${layerId}-${SCALP_TAG}`);
    await expect(chip).toHaveAttribute('data-paint', 'color');
    await expect(chip).toHaveAttribute('data-overridden', 'false');

    const before3d = await pane('3d');
    await chip.click();
    await expect(chip).toHaveAttribute('data-paint', 'field');
    await expect(chip).toHaveAttribute('data-overridden', 'true');
    const after3d = await pane('3d');
    await shoot('paint-3-scalp-field-on-tag-layer.png');
    const moved = changed(before3d, after3d);
    const total = after3d.width * after3d.height;
    expect(moved / total, `3D pixels changed by the flip: ${moved}/${total}`).toBeGreaterThan(0.15);

    // The "Colour by" row's Reset drops every override.
    await page.getByTestId(`mesh-paint-reset-${layerId}`).click();
    await expect(chip).toHaveAttribute('data-overridden', 'false');
    await expect(page.getByTestId(`mesh-paint-overrides-${layerId}`)).toHaveCount(0);
  });
});
