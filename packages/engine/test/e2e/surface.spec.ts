/**
 * §4.4's **surface** layer (2026-09-06, `docs/requirements/2026-09-06-idohaber-surfaces.md`
 * R1/R2): a triangle-only file opens as `kind: 'surface'`, in one colour from the surface palette,
 * with its 2D outline on — and renders through the same triangle passes as before.
 *
 * The pixel assertion is the one every mesh test here uses: the pick pass names the triangle under
 * a probe, and an interior fragment of a solid-coloured surface must be that colour lit
 * (`solveShading`) and no other palette entry lit. The fixture is `lh.fixture.surf`, the 4×4
 * FreeSurfer patch.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import { PANE, isBackground, solveShading } from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const SURFACE = fixture('lh.fixture.surf');
const LATTICE = fixture('mesh_v2_binary.msh');

/** `SURFACE_CONTOUR_PALETTE[0..2]` (`scene/defaults.ts`), as 0..255 triples. */
const PALETTE_255: readonly (readonly [number, number, number])[] = [
  [255, 230, 38],
  [115, 199, 107],
  [242, 128, 77],
];

const TOP_DOWN_CAMERA = {
  target: [0, 0, 0.866] as [number, number, number],
  distance: 120,
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  fovYDeg: 30,
  orthographic: true,
  near: 1,
  far: 400,
};

async function openDefault(page: Page, url: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([u, camera]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: u as string });
      // No `kind`: the dataset's own default decides (R1).
      const layer = engine.addLayer({ datasetId: ds.id } as never);
      window.__tvxGateLayer = layer.id;
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.setView('view3d', { camera: camera as never });
      for (let i = 0; i < 20; i += 1) {
        await engine.whenSettled();
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    [url, TOP_DOWN_CAMERA] as const
  );
  return errors;
}

test('a triangle-only file opens as a surface layer; a tet mesh stays a mesh (R1)', async ({
  page,
}) => {
  const errors = await openDefault(page, SURFACE);
  const surface = await page.evaluate(() => {
    const l = window.__tvxEngine!.scene.layers[0] as unknown as Record<string, unknown>;
    return {
      kind: l.kind,
      colorMode: l.colorMode,
      solidColor: l.solidColor,
      contourColor: l.contourColor,
      contoursIn2D: l.contoursIn2D,
      contourWidthPx: l.contourWidthPx,
      hasTagStyle: 'tagStyle' in l,
      hasIsolate: 'isolate' in l,
      hasGlyphs: 'glyphs' in l,
      hasFill: 'fillIn2D' in l,
      clip: l.clip,
    };
  });
  expect(surface.kind).toBe('surface');
  expect(surface.colorMode).toBe('solid');
  expect(surface.solidColor).toEqual([1, 0.9, 0.15, 1]);
  expect(surface.contourColor).toEqual([1, 0.9, 0.15, 1]);
  expect(surface.contoursIn2D).toBe(true);
  expect(surface.contourWidthPx).toBe(1.5);
  expect(surface.hasTagStyle).toBe(false);
  expect(surface.hasIsolate).toBe(false);
  expect(surface.hasGlyphs).toBe(false);
  expect(surface.hasFill).toBe(false);
  expect(surface.clip).toEqual({ planes: [] });

  const mesh = await page.evaluate(async (u) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: u });
    const layer = engine.addLayer({ datasetId: ds.id } as never);
    return { kind: layer.kind, colorMode: (layer as { colorMode: string }).colorMode };
  }, LATTICE);
  expect(mesh).toEqual({ kind: 'mesh', colorMode: 'tag' });
  expect(errors).toEqual([]);
});

test('a second surface takes the next palette entry, for its face and its outline', async ({
  page,
}) => {
  const errors = await openDefault(page, SURFACE);
  const second = await page.evaluate(async (u) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: u });
    const layer = engine.addLayer({ datasetId: ds.id } as never) as unknown as Record<
      string,
      unknown
    >;
    return { solidColor: layer.solidColor, contourColor: layer.contourColor };
  }, SURFACE);
  expect(second.solidColor).toEqual([0.45, 0.78, 0.42, 1]);
  expect(second.contourColor).toEqual([0.45, 0.78, 0.42, 1]);
  expect(errors).toEqual([]);
});

test('the surface is drawn in its solid colour — every interior pixel is that colour lit (R2)', async ({
  page,
}) => {
  const errors = await openDefault(page, SURFACE);
  const step = 24;
  const probes: [number, number][] = [];
  for (let y = step; y < PANE; y += step)
    for (let x = step; x < PANE; x += step) probes.push([x, y]);
  const picked = await page.evaluate(async (ps) => {
    const engine = window.__tvxEngine!;
    let ready = null as ReturnType<typeof engine.pick>;
    for (let i = 0; i < 60 && ready === null; i += 1) {
      ready = engine.pick('view3d', 384, 384);
      if (ready === null) {
        await engine.whenSettled();
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const at = (x: number, y: number): number | null => {
      const hit = engine.pick('view3d', x, y);
      return hit === null || hit.elementKind !== 'tri' ? null : hit.elementId;
    };
    return (ps as [number, number][]).map((p) => {
      const id = at(p[0], p[1]);
      if (id === null) return null;
      for (const [dx, dy] of [
        [-6, 0],
        [6, 0],
        [0, -6],
        [0, 6],
      ]) {
        if (at(p[0] + dx!, p[1] + dy!) !== id) return null;
      }
      return id;
    });
  }, probes);
  const pixels = await readCanvasPixels(page, probes);
  let asserted = 0;
  for (const [i, id] of picked.entries()) {
    if (id === null) continue;
    const px = pixels[i]!;
    if (isBackground(px)) continue;
    expect(
      solveShading(PALETTE_255[0]!, px).feasible,
      `pixel ${probes[i]!.join(',')} on triangle ${id} must be the first palette entry lit — got ${px.slice(0, 3).join(',')}`
    ).toBe(true);
    for (const other of PALETTE_255.slice(1)) {
      expect(solveShading(other, px).feasible, `…and not ${other.join(',')}`).toBe(false);
    }
    asserted += 1;
  }
  expect(asserted).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('golden: surface-default', async ({ page }) => {
  const errors = await openDefault(page, SURFACE);
  expect(errors).toEqual([]);
  await expectGolden(page, 'surface-default');
});
