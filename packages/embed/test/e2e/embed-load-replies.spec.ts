import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const MESH = `/@fs${REPO}testdata/mesh_v2_binary.msh`;
const scene = (path = MESH) => ({
  datasets: [{ id: 'd1', kind: 'mesh', name: 'mesh_v2_binary.msh', path }],
  layers: [
    {
      id: 'l1',
      datasetId: 'd1',
      kind: 'mesh',
      colorMode: 'solid',
      field: null,
    },
  ],
});

interface HostWindow {
  __host: {
    send(message: Record<string, unknown>, reply?: boolean): Promise<Record<string, unknown>>;
    events: Record<string, unknown>[];
  };
}

async function openHost(page: Page): Promise<void> {
  await page.goto('/example/host.html?data=/none');
  await page.waitForFunction(() =>
    (window as unknown as HostWindow).__host?.events.some((event) => event['type'] === 'ready')
  );
}

test('a legacy solid mesh with field:null receives loaded without a host-supplied scale', async ({
  page,
}) => {
  await openHost(page);
  const reply = await page.evaluate(
    (spec) => (window as unknown as HostWindow).__host.send({ type: 'load', scene: spec }, true),
    scene()
  );
  expect(reply['type']).toBe('loaded');
  expect(reply['layers']).toMatchObject([{ kind: 'mesh', colorMode: 'solid' }]);
});

for (const replacement of ['load', 'reset'] as const) {
  test(`an in-flight load receives a cancellation reply when superseded by ${replacement}`, async ({
    page,
    context,
  }) => {
    let release!: () => void;
    let requested!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await context.route('**/mesh_v2_binary.msh?held=1', async (route) => {
      requested();
      await held;
      await route.continue();
    });
    try {
      await openHost(page);
      await page.evaluate(
        (spec) => {
          const frame = document.querySelector('iframe') as HTMLIFrameElement;
          frame.contentWindow!.postMessage(
            { tvx: 1, id: 'old-load', type: 'load', scene: spec },
            location.origin
          );
        },
        scene(`${MESH}?held=1`)
      );
      await started;
      await page.evaluate((type) => {
        const frame = document.querySelector('iframe') as HTMLIFrameElement;
        frame.contentWindow!.postMessage(
          { tvx: 1, id: 'replacement', type, scene: { datasets: [], layers: [] } },
          location.origin
        );
      }, replacement);
      release();
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (window as unknown as HostWindow).__host.events.filter(
                (event) => event['id'] === 'old-load'
              )
            ),
          { timeout: 5000 }
        )
        .toMatchObject([{ type: 'error', message: expect.stringMatching(/cancel|supersed/i) }]);
      const state = await page.evaluate(() =>
        (window as unknown as HostWindow).__host.send({ type: 'serialize' }, true)
      );
      expect(state['spec']).toMatchObject({ datasets: [], layers: [] });
      const statuses = await page.evaluate(() =>
        (window as unknown as HostWindow).__host.events.filter(
          (event) => event['type'] === 'status'
        )
      );
      expect(statuses.at(-1)?.['phase']).not.toBe('error');
    } finally {
      release();
      await context.unrouteAll({ behavior: 'wait' });
    }
  });
}
