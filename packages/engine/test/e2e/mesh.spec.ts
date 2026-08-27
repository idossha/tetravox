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
import { readFileSync } from 'node:fs';
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
      engine.resetView('view3d');
      engine.setAnnotations({
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

/**
 * §11's second named example: *"a 4-tet mesh with tag colours from a fixture LUT ⇒ the cap pixel is
 * exactly the tag colour — the **0..255 wire value** from `MeshMeta.tags[].color`, which §4.1
 * requires to round-trip exactly through the engine's 0..1 representation"*.
 *
 * Caps need clip planes, which are Phase 2's; the Phase-1 shape of this test is the tag surface
 * itself, which is what §7.4's minimum shader draws with "the tag colour as a uniform". Phase 1
 * shipped that path with no pixel assertion at all — the only check was a coverage count.
 *
 * **The shading is cancelled rather than modelled.** §7.4's headlight Blinn-Phong gives
 * `P = C·s + spec` at a pixel, where `s` and `spec` depend only on `dot(n, v)`. The camera is set so
 * that one face of the fixture squarely faces it, and the two sampled pixels sit the same distance
 * above and below the view axis on that face — identical `dot(n, v)`, therefore identical `s` and
 * `spec`, while the tag underneath differs (the fixture's tets are tagged by the sign of z, so the
 * face's upper half is tag 1002 and its lower half 1001). Solving the two equations in the **red**
 * channel gives `s` and `spec`, and green and blue are then *predicted* for both pixels: four
 * independent predictions from two measurements. Nothing in the expectation comes from the shader's
 * ambient or specular constants, and nothing comes from a previous run.
 */
test('a tag surface is painted its own LUT colour, per tag (§7.4, §4.1)', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // The fixture LUT, parsed here rather than read back out of the engine: `#No. Name R G B A`.
  const lut = new Map<number, [number, number, number, number]>();
  for (const line of readFileSync(`${REPO}testdata/mesh_v2_binary_LUT.txt`, 'utf8').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m !== null) {
      lut.set(Number(m[1]), [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])]);
    }
  }
  expect(lut.get(1001)).toEqual([104, 163, 255, 255]);
  expect(lut.get(1002)).toEqual([255, 239, 179, 255]);

  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const info = await page.evaluate(
    async ([url, lutUrl]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      // Camera on −X looking at +X, screen-up = +Z. The quaternion is the one whose rotation matrix
      // has third column (−1,0,0) (the "back" axis §7.5 puts the eye along) and second column
      // (0,0,1) (screen-up): R = [[0,0,−1],[−1,0,0],[0,1,0]], q = (0.5, −0.5, −0.5, 0.5).
      // distance 31 mm with a 51.69° vertical field puts the fixture's 20 mm front face (x = −10,
      // 21 mm from the eye) just inside the pane: ±10.16 mm top to bottom.
      engine.setView('view3d', {
        camera: {
          target: [0, 0, 0],
          distance: 31,
          rotation: [0.5, -0.5, -0.5, 0.5],
          fovYDeg: (2 * Math.atan(15 / 31) * 180) / Math.PI,
          orthographic: false,
          near: 1,
          far: 200,
        },
      });
      await engine.whenSettled();
      return {
        tags:
          'tags' in ds
            ? ds.tags.map((t) => ({
                id: t.id,
                kind: t.kind,
                rgba: [
                  Math.round(t.color[0] * 255),
                  Math.round(t.color[1] * 255),
                  Math.round(t.color[2] * 255),
                  Math.round(t.color[3] * 255),
                ],
              }))
            : [],
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture('mesh_v2_binary.msh'), fixture('mesh_v2_binary_LUT.txt')] as const
  );

  expect(pageErrors).toEqual([]);
  expect(info.errors).toEqual([]);

  // §4.1: the wire `[u8;4]` survives the engine's 0..1 representation exactly, both ways.
  const tagColor = (id: number): number[] => info.tags.find((t) => t.id === id)!.rgba;
  expect(tagColor(1001)).toEqual(lut.get(1001));
  expect(tagColor(1002)).toEqual(lut.get(1002));

  // ±9 mm on the front face = ±340 px of the pane's 384, well inside both the face and the pane.
  const dz = Math.round((9 / 10.16) * (PANE / 2));
  const [top, bottom] = await readCanvasPixels(page, [
    [PANE / 2, PANE / 2 - dz] as const,
    [PANE / 2, PANE / 2 + dz] as const,
  ]);

  // Screen-up is +Z and the fixture's tets are tagged by the sign of z, so the upper sample is on
  // the tag-1002 half of the face and the lower one on the tag-1001 half.
  const cTop = tagColor(1002);
  const cBottom = tagColor(1001);

  // §7.4's headlight gives `P = C·s + t` at a pixel, with `s` and `t` functions of `dot(n, v)`
  // alone — the **same** for all three channels of one pixel. That is three equations in two
  // unknowns, so each pixel can be fitted against its own tag's colour and the residual is a real
  // test: it says the pixel is that colour, scaled and offset by a scalar, and nothing else. No
  // ambient or specular constant from the shader appears in the expectation.
  const fit = (
    c: readonly number[],
    p: readonly number[]
  ): { s: number; t: number; residual: number } => {
    const cm = (c[0]! + c[1]! + c[2]!) / 3;
    const pm = (p[0]! + p[1]! + p[2]!) / 3;
    let num = 0;
    let den = 0;
    for (let k = 0; k < 3; k += 1) {
      num += (c[k]! - cm) * (p[k]! - pm);
      den += (c[k]! - cm) ** 2;
    }
    const s = den > 0 ? num / den : 0;
    const t = pm - s * cm;
    let residual = 0;
    for (let k = 0; k < 3; k += 1) residual = Math.max(residual, Math.abs(p[k]! - (c[k]! * s + t)));
    return { s, t, residual };
  };

  for (const [name, px, own, other] of [
    ['tag 1002 (upper half)', top!, cTop, cBottom],
    ['tag 1001 (lower half)', bottom!, cBottom, cTop],
  ] as const) {
    const f = fit(own, px);
    console.log(
      `[tagcolour] ${name}: rgb(${px.slice(0, 3).join(',')}) vs tag rgb(${own.slice(0, 3).join(',')}) ` +
        `=> s=${f.s.toFixed(4)} t=${f.t.toFixed(2)} residual=${f.residual.toFixed(2)}`
    );
    expect(f.residual, `${name}: the pixel must be this tag's colour, scaled`).toBeLessThan(1.5);
    expect(f.s, `${name}: a diffuse term in (0, 1]`).toBeGreaterThan(0.05);
    expect(f.s).toBeLessThanOrEqual(1.02);
    expect(f.t, `${name}: the headlight adds, it does not subtract`).toBeGreaterThan(-1.5);
    expect(f.t).toBeLessThan(40);

    // The other tag's colour cannot be made to fit the same pixel: the fixture's two colours run in
    // opposite directions in red and blue (104→255 against 255→179), so the best scalar fit is a
    // *negative* one. Without this the assertion above would only say "some colour, scaled".
    const wrong = fit(other, px);
    expect(
      wrong.s < 0.05 || wrong.residual > 3,
      `${name}: the other tag's colour fits too (s=${wrong.s.toFixed(3)}, residual=${wrong.residual.toFixed(2)})`
    ).toBe(true);

    expect(px[3], 'the tag surface is opaque').toBe(255);
  }
});
