/** §7.3 / §11: analytic tensor silhouettes/colours before a golden (2026-09-19).
 * The synthetic tensor has eigenvalues 0.003,0.001,0.0005, hence axial radii 0.42 and
 * 0.42/3 mm. Expected RGB and shaded intensity follow this ellipse, not prior renders.
 * NIfTI parsing/eigenvalues/orientation are independently checked against NumPy in Rust.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { expectGolden, expectPixel } from '../helpers/pixels';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${root}testdata/${name}`;

test('tensor ellipsoids preserve scalar frames and display anisotropic axes @angle', async ({
  page,
}, info) => {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const ids = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url });
    const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    engine.setTheme({ background: [0, 0, 0, 1] });
    engine.setLayout({ kind: '1x1', cells: ['axial'] });
    engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.005 } });
    engine.setAnnotations({
      crosshair: false,
      orientationLabels: false,
      cornerInfo: false,
      colorbars: false,
    });
    engine.setCursor([2, 2, 2]);
    engine.updateLayer(layer.id, {
      scale: { kind: 'linear', lo: 0, hi: 0.004 },
      interpolation: 'nearest',
      colormap: 'gray',
    });
    await engine.whenSettled();
    engine.renderNow();
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const before = new Uint8Array(4);
    gl.readPixels(384, 384, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, before);
    engine.updateLayer(layer.id, { tensor: { order: 'fsl', basis: 'fsl', stride: 1, minFA: 0 } });
    await engine.whenSettled();
    engine.renderNow();
    return {
      layer: layer.id,
      before: Array.from(before),
      errors: window.__tvxErrors,
      glError: gl.getError(),
    };
  }, fixture('tensor_fsl.nii.gz'));
  expect(ids.errors).toEqual([]);
  expect(ids.glError).toBe(0);
  // Pixel centres are offset by half a pixel from the cursor; derive the shader's smooth shade.
  for (const [x, y] of [
    [384, 384],
    [424, 384],
    [384, 404],
  ]) {
    const dx = (x! + 0.5 - 384) * 0.005;
    const dy = (y! + 0.5 - 384) * 0.005;
    const q = (dx / 0.42) ** 2 + (dy / 0.14) ** 2;
    const red = Math.round(255 * (0.4 + 0.6 * Math.sqrt(1 - q)));
    await expectPixel(page, x!, y!, [red, 0, 0, 255], 2);
  }
  // Outside the narrow Y radius, still inside the same voxel cell: no tensor pixel.
  const blank = await page.evaluate(() => {
    const e = window.__tvxEngine!;
    e.renderNow();
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const p = new Uint8Array(4);
    gl.readPixels(384, 344, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return Array.from(p);
  });
  expect(blank).toEqual([0, 0, 0, 255]);
  if (info.project.name === 'chromium-swiftshader') await expectGolden(page, 'tensor-ellipsoids');
  const result = await page.evaluate(async (id) => {
    const e = window.__tvxEngine!;
    const saved = e.serialize();
    const fields = e.probe([2, 2, 2]).rows[0]?.fields;
    e.updateLayer(id, { tensor: { order: 'fsl', basis: 'fsl', stride: 1, minFA: 1 } });
    await e.whenSettled();
    e.renderNow();
    const context = document.querySelector('canvas')!.getContext('webgl2')!;
    const filtered = new Uint8Array(4);
    context.readPixels(384, 384, 1, 1, context.RGBA, context.UNSIGNED_BYTE, filtered);
    e.updateLayer(id, { tensor: undefined });
    await e.whenSettled();
    e.renderNow();
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const after = new Uint8Array(4);
    gl.readPixels(384, 384, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, after);
    return {
      after: Array.from(after),
      filtered: Array.from(filtered),
      saved,
      fields,
      errors: window.__tvxErrors,
    };
  }, ids.layer);
  expect(result.filtered).toEqual([0, 0, 0, 255]);
  expect(result.after).toEqual(ids.before);
  expect(JSON.stringify(result.saved)).toContain('"tensor"');
  expect(result.fields?.map((f) => f.name)).toEqual(['Dxx', 'Dxy', 'Dxz', 'Dyy', 'Dyz', 'Dzz']);
  expect(result.errors).toEqual([]);
});

const realRoot = process.env.TETRAVOX_TESTDATA;
test('Ernie T1 and diffusion tensors load together and draw @angle', async ({ page }) => {
  test.skip(
    !realRoot || !existsSync(`${realRoot}/m2m_ernie/DTI_coregT1_tensor.nii.gz`),
    'TETRAVOX_TESTDATA with Ernie tensors is required'
  );
  test.setTimeout(120_000);
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const r = await page.evaluate(async (root) => {
    const e = window.__tvxEngine!;
    const t1 = await e.addDataset({ kind: 'path', path: `/@fs${root}/m2m_ernie/T1.nii.gz` });
    e.addLayer({ datasetId: t1.id, kind: 'volume' });
    const dti = await e.addDataset({
      kind: 'path',
      path: `/@fs${root}/m2m_ernie/DTI_coregT1_tensor.nii.gz`,
    });
    const layer = e.addLayer({ datasetId: dti.id, kind: 'volume' });
    e.setLayout({ kind: '1x1', cells: ['axial'] });
    e.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.15 } });
    // T1 and DTI share this grid; scanner RAS comes from their affine.
    if (dti.kind !== 'volume') throw Error('expected volume');
    const a = dti.affine;
    const world: [number, number, number] = [
      a[0]! * 128 + a[4]! * 128 + a[8]! * 104 + a[12]!,
      a[1]! * 128 + a[5]! * 128 + a[9]! * 104 + a[13]!,
      a[2]! * 128 + a[6]! * 128 + a[10]! * 104 + a[14]!,
    ];
    e.setCursor(world);
    e.setAnnotations({
      crosshair: false,
      orientationLabels: false,
      cornerInfo: false,
      colorbars: false,
    });
    e.updateLayer(layer.id, { tensor: { order: 'fsl', basis: 'fsl', stride: 2, minFA: 0.1 } });
    await e.whenSettled();
    e.renderNow();
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const pixels = new Uint8Array(768 * 768 * 4);
    gl.readPixels(0, 0, 768, 768, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let colour = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (
        Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) -
          Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) >
        30
      )
        colour++;
    return { colour, errors: window.__tvxErrors, glError: gl.getError(), ops: window.__tvxOps };
  }, realRoot!);
  expect(r.errors).toEqual([]);
  expect(r.glError).toBe(0);
  expect(r.colour).toBeGreaterThan(1000);
  expect(r.ops).toContain('volumeTensor');
});
