import { test, expect } from '@playwright/test';
import { readCanvasRect } from '../helpers/pixels';
const root = process.env.TETRAVOX_TESTDATA;
test('@angle near-opaque grey matter converges to the opaque surface', async ({ page }) => {
  test.skip(!root, 'TETRAVOX_TESTDATA is unset');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => !!window.__tvxEngine);
  const id = await page.evaluate(async (path) => {
    const e = window.__tvxEngine!;
    const ds = await e.addDataset({ kind: 'path', path });
    const l = e.addLayer({ kind: 'mesh', datasetId: ds.id });
    if (ds.kind !== 'mesh') throw Error('mesh required');
    e.updateLayer(l.id, {
      tagStyle: Object.fromEntries(
        ds.tags.map((t) => [t.id, { visible: t.id === 1002, opacity: 1 }])
      ),
      colorMode: 'solid',
      solidColor: [0.2, 0.4, 0.6, 1],
    });
    e.setLayout({ kind: '3d-only', cells: ['view3d'] });
    e.resetView('view3d');
    e.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
    await e.whenSettled();
    return l.id;
  }, `/@fs${root}/m2m_ernie/ernie.msh`);
  const a = await readCanvasRect(page, 100, 100, 568, 568);
  await page.evaluate(async (id) => {
    const e = window.__tvxEngine!;
    e.updateLayer(id, { opacity: 0.999 });
    await e.whenSettled();
  }, id);
  const b = await readCanvasRect(page, 100, 100, 568, 568);
  let changed = 0,
    covered = 0,
    max = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 2]! < 70) continue;
    covered++;
    const d = Math.max(...[0, 1, 2].map((k) => Math.abs(a[i + k]! - b[i + k]!)));
    if (d > 3) changed++;
    max = Math.max(max, d);
  }
  console.log({ covered, changed, max, fraction: changed / covered });
  expect(covered).toBeGreaterThan(10000);
  expect(changed / covered).toBeLessThan(0.005);
  expect(errors).toEqual([]);
});
