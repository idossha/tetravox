/** §5 rule 15 / §8: a host can own the controls around the unchanged rendering surface. */
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, rendererClassOf } from '../../../engine/test/helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const LATTICE = `/@fs${REPO}testdata/mesh_v2_binary.msh`;
const CANVAS = '[data-testid="engine-canvas"]';

interface HostWindow {
  __host: {
    send(message: Record<string, unknown>, expectReply?: boolean): Promise<Record<string, unknown>>;
    events: Record<string, unknown>[];
  };
}

function send(page: Page, message: Record<string, unknown>, reply = true) {
  return page.evaluate(([m, r]) => (window as unknown as HostWindow).__host.send(m, r), [
    message,
    reply,
  ] as const);
}

async function openHost(page: Page, presentation = '', extra = ''): Promise<void> {
  const query = presentation === '' ? '' : `presentation=${presentation}`;
  const embed = `../index.html?${query}${extra}`;
  await page.goto(`/example/host.html?data=/none&embed=${encodeURIComponent(embed)}`);
  await page.waitForFunction(() =>
    (window as unknown as HostWindow).__host?.events.some((event) => event['type'] === 'ready')
  );
}

/**
 * The committed lattice has a ±10 mm bounding box (testdata/manifest.json's independent reader).
 * Ambient 1 and a white opaque mesh clamp every interior channel to 255 regardless of normals;
 * outside the mesh the authored black clear colour is exact. A blank or detached canvas fails.
 */
async function loadMesh(page: Page): Promise<string> {
  const template = (await send(page, { type: 'serialize' }))['spec'] as {
    view3d: Record<string, unknown>;
  };
  const loaded = await send(page, {
    type: 'load',
    scene: {
      version: 2,
      datasets: [{ id: 'mesh', kind: 'mesh', name: 'lattice', path: LATTICE }],
      layers: [
        {
          id: 'surface',
          datasetId: 'mesh',
          kind: 'mesh',
          name: 'surface',
          visible: true,
          opacity: 1,
          colorMode: 'solid',
          solidColor: [1, 1, 1, 1],
        },
      ],
      background: [0, 0, 0, 1],
      lighting: { ambient: 1, headlight: true },
      view3d: { ...template.view3d, showSlicePlanes: false },
    },
  });
  expect(loaded['type']).toBe('loaded');
  expect(loaded['layers']).toMatchObject([
    { kind: 'mesh', colorMode: 'solid', solidColor: [1, 1, 1, 1], opacity: 1 },
  ]);
  await send(page, { type: 'setLayout', kind: '3d' }, false);
  await send(page, { type: 'setCamera', preset: 'A', patch: { distance: 80 } });
  return (loaded['layers'] as { id: string }[])[0]!.id;
}

/** The documented screenshot message reads and draws in one task; the PNG decode is lossless. */
async function meshPixels(page: Page): Promise<number[][]> {
  const shot = await send(page, { type: 'screenshot', target: 'grid', width: 512, height: 512 });
  expect(shot['type']).toBe('screenshot');
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    if (bitmap.width !== 512 || bitmap.height !== 512) {
      throw new Error(`expected 512 x 512 capture, got ${bitmap.width} x ${bitmap.height}`);
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('PNG decoder has no 2D context');
    context.drawImage(bitmap, 0, 0);
    // Both samples are well clear of the silhouette, centre crosshair and orientation annotations.
    return [
      [296, 296],
      [50, 50],
    ].map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data));
  }, shot['dataUrl'] as string);
}

test.afterEach(async ({ page }) => {
  expect(await page.pageErrors()).toEqual([]);
  expect((await page.consoleMessages()).filter((message) => message.type() === 'error')).toEqual(
    []
  );
});

for (const presentation of ['', 'unknown']) {
  test(`§8 full viewer remains the default for '${presentation}'`, async ({ page }) => {
    await openHost(page, presentation);
    const frame = page.frameLocator('#viewer');
    await expect(frame.getByTestId('toolbar')).toBeVisible();
    await expect(frame.getByTestId('left-panel-region')).toBeVisible();
    await expect(frame.getByTestId('right-panel-region')).toBeVisible();
    await expect(frame.getByTestId('status-bar')).toBeVisible();
    await loadMesh(page);
    expect(await meshPixels(page)).toEqual([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]);
    await send(page, { type: 'focus' }, false);
    await frame.getByTestId('view-grid').press('?');
    await expect(frame.getByRole('dialog')).toBeVisible();
  });
}

test('§8 viewport fills the frame and retains the 3D render and orientation', async ({ page }) => {
  await openHost(page, 'viewport');
  const frame = page.frameLocator('#viewer');
  for (const id of ['toolbar', 'left-panel-region', 'right-panel-region', 'status-bar', 'toasts']) {
    await expect(frame.getByTestId(id)).toHaveCount(0);
  }
  await expect(frame.getByRole('button')).toHaveCount(0);
  await loadMesh(page);
  const canvas = frame.locator(CANVAS);
  const iframeBox = await page.locator('#viewer').boundingBox();
  expect(await canvas.boundingBox()).toEqual(iframeBox);
  expect(await meshPixels(page)).toEqual([
    [255, 255, 255, 255],
    [0, 0, 0, 255],
  ]);
  const spec = (await send(page, { type: 'serialize' }))['spec'] as {
    annotations: { orientationCube: boolean; orientationLabels: boolean; conventionBadge: boolean };
  };
  expect(spec.annotations.orientationCube).toBe(true);
  expect(spec.annotations.orientationLabels).toBe(true);
  expect(spec.annotations.conventionBadge).toBe(true);
  if (test.info().project.name === 'chromium-angle') {
    // A local hardware verification must fail if Chromium silently fell back to software.
    expect(await rendererClassOf(canvas, CANVAS)).toBe('angle-metal');
  } else {
    await expectGolden(canvas, 'embed-viewport', CANVAS);
  }
});

test('§8 viewport gestures and host updates work without arming invisible shell tools', async ({
  page,
}) => {
  await openHost(page, 'viewport');
  const layerId = await loadMesh(page);
  const frame = page.frameLocator('#viewer');
  const canvas = frame.locator(CANVAS);
  const before = (await send(page, { type: 'serialize' }))['spec'] as Record<string, unknown>;
  await canvas.click();
  for (const key of ['?', 'F1', 'Control+[', 'Control+]', 'x', 'm', 'v']) {
    await frame.getByTestId('view-grid').press(key);
  }
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  const after = (await send(page, { type: 'serialize' }))['spec'] as Record<string, unknown>;
  expect(after['layout']).toEqual(before['layout']);
  expect(after['layers']).toEqual(before['layers']);
  expect(after['measurements']).toEqual(before['measurements']);

  const camera = (await send(page, { type: 'getCamera' }))['camera'];
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  expect((await send(page, { type: 'getCamera' }))['camera']).not.toEqual(camera);

  await send(page, { type: 'updateLayer', layerId, patch: { opacity: 0 } }, false);
  const changed = (await send(page, { type: 'serialize' }))['spec'] as {
    layers: { opacity: number }[];
  };
  expect(changed.layers[0]?.opacity).toBe(0);
  expect(await meshPixels(page)).toEqual([
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]);
});

test('§8 viewport still tells the host when WebGL2 is unavailable', async ({ page }) => {
  await openHost(page, 'viewport', '&forceWebgl2Null=1');
  const reply = await send(page, { type: 'hello' });
  expect((reply['caps'] as { webgl2: boolean }).webgl2).toBe(false);
  const events = await page.evaluate(() => (window as unknown as HostWindow).__host.events);
  expect(events.some((event) => event['type'] === 'status' && event['phase'] === 'no-webgl2')).toBe(
    true
  );
  await expect(page.frameLocator('#viewer').getByTestId('toolbar')).toHaveCount(0);
});
