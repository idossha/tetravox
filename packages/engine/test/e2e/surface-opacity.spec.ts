import { expect, test } from '@playwright/test';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';

// Three sheets of one open surface overlap in projection. Their triangle edges differ:
// blending them in buffer order exposes the buried tessellation through the front sheet.
const sheets = [0, -1, -2];
const obj = sheets
  .map((z, i) => {
    const n = i * 4;
    return `v -4 -4 ${z}\nv 4 -4 ${z}\nv 4 4 ${z}\nv -4 4 ${z}\nf ${n + 1} ${n + 2} ${n + 3}\nf ${n + 1} ${n + 3} ${n + 4}`;
  })
  .join('\n');
const background = [16, 24, 32] as const;
const probes = [
  [300, 330],
  [430, 330],
  [300, 440],
  [430, 440],
] as const;

for (const aa of ['off', 'on']) {
  test(`@angle overlapping surface blends its nearest two sheets, with edges opt-in (aa=${aa}, §7.2)`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.route('**/folded.obj', (route) =>
      route.fulfill({ body: obj, contentType: 'text/plain' })
    );
    await page.goto(`/test/pages/scene.html?aa=${aa}`);
    await page.waitForFunction(() => window.__tvxEngine !== undefined);
    const id = await page.evaluate(async (bg) => {
      const e = window.__tvxEngine!;
      const ds = await e.addDataset({
        kind: 'path',
        path: new URL('/folded.obj', location.href).href,
      });
      const layer = e.addLayer({ kind: 'mesh', datasetId: ds.id });
      e.updateLayer(layer.id, {
        colorMode: 'solid',
        solidColor: [0.2, 0.4, 0.6, 1],
        faceMode: 'both',
        flatShading: false,
      });
      e.setLayout({ kind: '3d-only', cells: ['view3d'] });
      e.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      e.setTheme({ background: [bg[0] / 255, bg[1] / 255, bg[2] / 255, 1] });
      e.setView('view3d', {
        camera: {
          target: [0, 0, 0],
          distance: 20,
          rotation: [0, 0, 0, 1],
          fovYDeg: 45,
          orthographic: true,
          near: 1,
          far: 100,
        },
      });
      await e.whenSettled();
      return layer.id;
    }, background);
    const opaque = await readCanvasPixels(page, probes);
    for (const alpha of [0.2, 0.5, 0.99]) {
      await page.evaluate(
        async ({ id, alpha }) => {
          const e = window.__tvxEngine!;
          e.updateLayer(id, { opacity: alpha });
          await e.whenSettled();
        },
        { id, alpha }
      );
      const faded = await readCanvasPixels(page, probes);
      faded.forEach((pixel, i) => {
        for (let k = 0; k < 3; k++) {
          // Two retained sheets: A over (A over background). The third must not accumulate.
          const coverage = 1 - (1 - alpha) ** 2;
          const expected = opaque[i]![k]! * coverage + background[k]! * (1 - coverage);
          expect(
            Math.abs(pixel[k]! - expected),
            `sheet ${i}, channel ${k}, alpha ${alpha}`
          ).toBeLessThanOrEqual(2);
        }
        expect(opaque[i]![2]).toBeGreaterThan(background[2] + 50);
      });
    }
    const [outside] = await readCanvasPixels(page, [[100, 100]]);
    expect(outside!.slice(0, 3)).toEqual(background);
    await page.evaluate(async (id) => {
      const e = window.__tvxEngine!;
      e.updateLayer(id, { opacity: 0.5 });
      await e.whenSettled();
    }, id);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__tvxErrors)).toEqual([]);
    expect(
      await page.evaluate(() => document.querySelector('canvas')!.getContext('webgl2')!.getError())
    ).toBe(0);
    if (aa === 'off' && test.info().project.name === 'chromium-swiftshader') {
      await expectGolden(page, 'surface-opacity-folded');
    }
    await page.evaluate(async (id) => {
      const e = window.__tvxEngine!;
      e.updateLayer(id, {
        edges: { surface: true, caps: false },
        edgeColor: [1, 0, 0, 1],
        edgeWidthPx: 4,
      });
      await e.whenSettled();
    }, id);
    await expect
      .poll(async () => {
        const [edge] = await readCanvasPixels(page, [[350, 417]]);
        return Math.max(
          ...[255, 0, 0].map((c, k) => Math.abs(edge![k]! - (c * 0.75 + background[k]! * 0.25)))
        );
      })
      .toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });
}
