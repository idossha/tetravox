/**
 * §7.4's minimum mesh shader on the committed lattice fixture, and §6.3's headline rule:
 *
 * > **The default 3D representation of a mesh that has surface elements is its own tagged
 * > triangles.** `tag_surfaces` therefore takes **no topology**.
 *
 * The evidence is the worker op log — every `Req.op` the engine sent — which must contain `surface`
 * and must **not** contain `buildTopology`. That is the same assertion Phase-1 gate item 2 makes on
 * `ernie.msh`, at a size a human can check by hand.
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readCanvasPixels } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const PANE = 768;

test('tag surfaces render in 3D without any topology build', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const info = await page.evaluate(
    async ([url, optUrl]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: optUrl as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      (engine as unknown as { resetView(v: string): void }).resetView('view3d');
      (engine as unknown as { setAnnotations(p: object): void }).setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      await engine.whenSettled();
      return {
        nTris: 'nTris' in ds ? ds.nTris : null,
        nTets: 'nTets' in ds ? ds.nTets : null,
        hasTris: 'hasTris' in ds ? ds.hasTris : null,
        tags:
          'tags' in ds ? ds.tags.map((t) => ({ id: t.id, kind: t.kind, count: t.count })) : null,
        orient: 'orient' in ds ? ds.orient : null,
        ops: window.__tvxOps ?? [],
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture('mesh_v2_binary.msh'), fixture('mesh_v2_binary.msh.opt')] as const
  );

  expect(pageErrors).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.nTris).toBe(56);
  expect(info.nTets).toBe(48);
  expect(info.hasTris).toBe(true);
  // §6.3, and the whole point of gate item 2: the first frame runs `surface`, never `buildTopology`.
  expect(info.ops).toEqual(['loadMesh', 'surface']);
  expect(info.ops).not.toContain('buildTopology');
  expect(info.ops).not.toContain('boundary');

  // The tag surface is the 8 tri tags of the fixture, and the 3D pane must not be empty.
  const pts: [number, number][] = [];
  for (let y = 100; y < PANE - 100; y += 23)
    for (let x = 100; x < PANE - 100; x += 23) pts.push([x, y]);
  const px = await readCanvasPixels(page, pts);
  const lit = px.filter((p) => p[0] > 30 || p[1] > 30 || p[2] > 35).length;
  expect(lit, 'the orbiting tag surface must cover a real part of the pane').toBeGreaterThan(
    pts.length * 0.15
  );
});
