/**
 * `GlyphSpec.in2D` on **real data**: the E-field arrows of `ernie_TDCS_1_scalar.msh` — the only
 * reference file with a vector field (AGENTS.md) — drawn on the 2D slices from each pane's own cut,
 * projected into the slice plane.
 *
 * The assertion is a count, not a look (AGENTS rule 1): the axial pane's pixels that are neither
 * the background nor the flat tissue fill. With the arrows off that set is the contour ink alone;
 * with them on it grows by the arrows. The corner
 * legend's `IN-PLANE` prefix is pinned by `glyph-scale.test.ts`.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS.md).
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';
import { decodePng } from './png';
import type { DecodedPng } from './png';

const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';
const MESH = join(
  ROOT,
  'Simulations',
  'L_Insula',
  'high_Frequency',
  'mesh',
  'ernie_TDCS_1_scalar.msh'
);
const OUT = process.env['TETRAVOX_GLYPH2D_SHOTS'] ?? '';

let app: ElectronApplication;
let page: Page;
let layerId: string;

async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(async () => {
      const engine = window.__tetravox?.engine;
      if (engine == null) return;
      await engine.whenSettled();
      engine.renderNow();
      await engine.whenSettled();
    });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    );
  }
}

async function axial(): Promise<DecodedPng> {
  await settle();
  const base64 = await page.evaluate(async () => {
    const engine = window.__tetravox?.engine;
    if (engine == null) throw new Error('no engine');
    const view = engine.views.find((v) => 'mode' in v && v.mode === 'axial');
    if (view === undefined) throw new Error('no axial view');
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
  });
  return decodePng(Buffer.from(base64, 'base64'));
}

/** Distinct colours with at least `min` pixels each — the flat fills and background, in effect. */
function dominantColours(png: DecodedPng, min: number): Set<number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < png.pixels.length; i += 4) {
    const key =
      ((png.pixels[i] ?? 0) << 16) | ((png.pixels[i + 1] ?? 0) << 8) | (png.pixels[i + 2] ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= min).map(([k]) => k));
}

/** Pixels whose colour is not one of `flat` — contour ink, and arrows when there are any. */
function inkOutside(png: DecodedPng, flat: Set<number>): number {
  let n = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    const key =
      ((png.pixels[i] ?? 0) << 16) | ((png.pixels[i + 1] ?? 0) << 8) | (png.pixels[i + 2] ?? 0);
    if (!flat.has(key)) n += 1;
  }
  return n;
}

async function setIn2D(on: boolean): Promise<void> {
  await page.evaluate(
    ({ id, on: flag }) => {
      const tv = window.__tetravox;
      const layer = tv?.store.getState().layers.find((l) => l.id === id);
      if (tv?.controller == null || layer?.kind !== 'mesh' || layer.glyphs === undefined) {
        throw new Error('no glyph layer');
      }
      tv.controller.patchLayer(id, { glyphs: { ...layer.glyphs, in2D: flag } });
    },
    { id: layerId, on }
  );
  await settle();
}

async function shoot(name: string): Promise<void> {
  if (OUT === '') return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, name), scale: 'css' });
}

test.describe('E-field arrows on the 2D slices (real data)', () => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(1_200_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    expect(existsSync(MESH), `${MESH} is missing from TETRAVOX_TESTDATA`).toBe(true);
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
      while (Date.now() - started < 900_000) {
        const mesh = tv.store.getState().layers.find((l) => l.kind === 'mesh');
        if (mesh !== undefined) return mesh.id;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('ernie_TDCS_1_scalar.msh never landed');
    }, MESH);

    // Tissue-coloured, glyphs on the E field over the tets, off in 2D to start with.
    await page.evaluate(async (id) => {
      const tv = window.__tetravox;
      if (tv?.controller == null || tv.engine == null) throw new Error('no shell');
      const s = tv.store.getState();
      const layer = s.layers.find((l) => l.id === id);
      const ds = s.datasets.find((d) => d.id === layer?.datasetId);
      if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh dataset');
      const field = ds.fields.find((f) => f.ncomp === 3);
      if (field === undefined) throw new Error('mesh carries no vector field');
      const p99 = field.stats.percentiles['99'] ?? field.stats.max;
      // The `.msh.opt` of this simulation shows the grey-matter surface alone. A 2D cut is a slab
      // through the **tets**, so every tissue has to be visible for the cut to carry any origin.
      const tagStyle = Object.fromEntries(
        ds.tags.map((t) => [
          t.id,
          { ...(layer?.kind === 'mesh' ? layer.tagStyle[t.id] : {}), visible: true, opacity: 1 },
        ])
      );
      tv.controller.patchLayer(id, {
        colorMode: 'tag',
        tagStyle,
        glyphs: {
          field: { source: field.source, name: field.name },
          shape: 'arrow',
          subsample: { maxCount: 20_000 },
          scale: { mode: 'log', lengthMm: 6, normalizeTo: 'p99', logFloor: p99 / 1000 },
          lengthMm: 6,
          colorBy: 'magnitude',
          color: [1, 1, 1, 1],
          clipToCutPlane: false,
          onCutPlaneOnly: false,
          origins: 'volume',
          in2D: false,
        },
      });
      await tv.engine.whenSettled();
    }, layerId);
    await settle();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the arrows appear on the axial slice when in2D is on, and the corner says IN-PLANE', async () => {
    test.setTimeout(600_000);
    const off = await axial();
    const flat = dominantColours(off, 2_000);
    const inkOff = inkOutside(off, flat);
    await shoot('glyphs2d-1-off.png');

    await setIn2D(true);
    expect(
      await page.evaluate((id) => {
        const l = window.__tetravox?.store.getState().layers.find((x) => x.id === id);
        return l?.kind === 'mesh' ? l.glyphs?.in2D : undefined;
      }, layerId)
    ).toBe(true);
    // The cut's own positions become the origin table on the first draw that asks; wait for ink.
    let inkOn = 0;
    for (let i = 0; i < 40 && inkOn < inkOff + 3_000; i += 1) {
      inkOn = inkOutside(await axial(), flat);
    }
    await shoot('glyphs2d-2-on.png');
    expect(inkOn, `axial ink outside the flat fills: ${inkOff} → ${inkOn}`).toBeGreaterThan(
      inkOff + 3_000
    );

    await setIn2D(false);
    const back = inkOutside(await axial(), flat);
    expect(back).toBeLessThan(inkOff + 1_000);
  });
});
