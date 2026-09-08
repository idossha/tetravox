/**
 * **A protocol-1 host must keep working against this build, with no change whatsoever.**
 *
 * That is the point of protocol 2 and it is the one claim that cannot be established by reading the
 * diff, so it is asserted here from the outside — as a protocol-1 host, sending only protocol-1
 * messages, and reading only protocol-1 types.
 *
 * The proof has two halves.
 *
 * 1. **Nothing it sends behaves differently.** A protocol-1 `ViewSpec` — no points layer, no camera,
 *    no tool — loads to the same layer array, the same live-id rule, the same `serialize` round trip
 *    and the same screenshot it did at 0.3.x. These are `embed.spec.ts`'s own assertions restated
 *    against a spec built here rather than fetched from the example page's scene list, so a change
 *    to the example cannot quietly change what "protocol 1" means.
 *
 * 2. **Nothing it receives is new.** Every message the embed posts during a whole session — boot,
 *    load, click, layer patch, screenshot, serialize, reset — is one of protocol 1's **ten** types.
 *    That is stronger than "a host ignores what it does not know", and it is what makes the
 *    guarantee structural: `pick` is off until `setPickEvents` turns it on, `pointTool` only fires
 *    while a tool is armed, and `camera` is only ever a reply. A protocol-1 host cannot do any of
 *    those three things, so it never sees any of them.
 *
 * The fixture is committed, so this suite runs everywhere — including the CI legs where
 * `TETRAVOX_TESTDATA` is unset by design.
 */

import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const LATTICE = `/@fs${REPO}testdata/mesh_v2_binary.msh`;
const LATTICE_OPT = 'mesh_v2_binary.msh.opt';

/**
 * The ten embed→host types protocol 1 defined, written out rather than imported.
 *
 * Imported from `src/protocol.ts` this assertion would pass by construction the day someone appends
 * to that array. A protocol-1 host has its own hard-coded copy of this list — the TI-Toolbox viewer
 * does, in `desktop/src/renderer/viewer/protocol.ts` — and this is that copy.
 */
const V1_EMBED_TYPES = [
  'ready',
  'status',
  'progress',
  'loaded',
  'layers',
  'cursor',
  'probe',
  'screenshot',
  'scene',
  'error',
] as const;

/** A scene a host written in August 2026 could have sent, and nothing more. */
const V1_SCENE = {
  version: 2,
  datasets: [
    {
      id: 'd1',
      kind: 'mesh',
      name: 'mesh_v2_binary.msh',
      path: LATTICE,
      sidecars: { opt: { path: LATTICE_OPT } },
    },
  ],
  layers: [
    {
      id: 'l1',
      datasetId: 'd1',
      kind: 'mesh',
      name: 'lattice',
      visible: true,
      colorMode: 'tag',
    },
  ],
  activeLayerId: 'l1',
};

interface HostWindow {
  __host: {
    send(message: Record<string, unknown>, expectReply?: boolean): Promise<Record<string, unknown>>;
    events: Record<string, unknown>[];
  };
}

const send = (
  page: Page,
  message: Record<string, unknown>,
  reply = true
): Promise<Record<string, unknown>> =>
  page.evaluate(
    ([m, r]) =>
      (window as unknown as HostWindow).__host.send(m as Record<string, unknown>, r as boolean),
    [message, reply] as const
  );

const events = (page: Page): Promise<Record<string, unknown>[]> =>
  page.evaluate(() => (window as unknown as HostWindow).__host.events);

async function openHost(page: Page): Promise<Record<string, unknown>> {
  await page.goto('/example/host.html?data=/none');
  await page.waitForFunction(
    () => (window as unknown as HostWindow).__host?.events.some((e) => e['type'] === 'ready'),
    undefined,
    { timeout: 60_000 }
  );
  return page.evaluate(
    () =>
      (window as unknown as HostWindow).__host.events.find((e) => e['type'] === 'ready') as Record<
        string,
        unknown
      >
  );
}

const load = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(
    (scene) =>
      (window as unknown as HostWindow).__host.send(
        { type: 'load', scene: scene as Record<string, unknown> },
        true
      ),
    V1_SCENE as unknown as Record<string, unknown>
  );

test.describe('a protocol-1 host, unchanged', () => {
  test('the envelope it filters on is still 1, and only the feature level moved', async ({
    page,
  }) => {
    const ready = await openHost(page);
    // A protocol-1 host drops anything whose `tvx` is not 1. If this were 2 it would drop `ready`
    // itself and never load a thing — which is why the envelope and the feature level are two
    // numbers.
    expect(ready['tvx']).toBe(1);
    // The feature level has moved twice now (1 → 2 → 3) and `tvx` has not moved once. That is the
    // entire compatibility story: this host reads a number it does not recognise, ignores it, and
    // keeps working, because nothing it sends or receives changed shape.
    expect(ready['version']).toBe(3);
    expect((ready['caps'] as { webgl2: boolean }).webgl2).toBe(true);
  });

  test('a protocol-1 ViewSpec loads exactly as it did', async ({ page }) => {
    await openHost(page);
    const loaded = await load(page);

    expect(loaded['type']).toBe('loaded');
    const datasets = loaded['datasets'] as { id: string; name: string; kind: string }[];
    expect(datasets).toHaveLength(1);
    expect(datasets[0]?.kind).toBe('mesh');
    expect(datasets[0]?.name).toBe('mesh_v2_binary.msh');

    const layers = loaded['layers'] as { id: string; kind: string; visible: boolean }[];
    expect(layers).toHaveLength(1);
    expect(layers[0]?.kind).toBe('mesh');
    expect(layers[0]?.visible).toBe(true);
    // The live-id rule, which is the one thing a v1 host had to be told: `Engine.load` re-adds every
    // dataset, so the ids in the reply are not the ids that were sent.
    expect(layers[0]?.id).not.toBe('l1');

    // Everything a v1 host does with those ids still does it.
    const id = layers[0]!.id;
    await send(page, { type: 'setLayerVisible', layerId: id, visible: false }, false);
    await send(page, { type: 'setLayerOpacity', layerId: id, opacity: 0.5 }, false);
    await send(page, { type: 'updateLayer', layerId: id, patch: { colormap: 'viridis' } }, false);
    await page.waitForFunction(
      (layerId) => {
        const last = (window as unknown as HostWindow).__host.events
          .filter((e) => e['type'] === 'layers')
          .at(-1);
        const l = (last?.['layers'] as { id: string; visible: boolean }[] | undefined)?.find(
          (x) => x.id === layerId
        );
        return l?.visible === false;
      },
      id,
      { timeout: 10_000 }
    );

    const spec = (await send(page, { type: 'serialize' }))['spec'] as {
      version: number;
      datasets: unknown[];
      layers: unknown[];
      view3d: unknown;
    };
    expect(spec.version).toBe(2);
    expect(spec.datasets).toHaveLength(1);
    expect(spec.layers).toHaveLength(1);
    expect(spec.view3d).toBeTruthy();

    const shot = (await send(page, { type: 'screenshot', target: 'grid' }))['dataUrl'] as string;
    expect(shot.startsWith('data:image/png;base64,')).toBe(true);
    expect(shot.length).toBeGreaterThan(10_000);

    const probe = await send(page, { type: 'probe', world: [0, 0, 0] });
    expect(probe['type']).toBe('probe');
    expect((probe['result'] as { world: number[] }).world).toEqual([0, 0, 0]);
  });

  test('never receives a message type protocol 1 does not define', async ({ page }) => {
    await openHost(page);
    await load(page);

    // A whole session, including the two things that would produce a protocol-2 event if they were
    // on: a real click in a pane (which is what `pick` would answer) and the cursor moving.
    const canvas = page.frameLocator('#viewer').locator('[data-testid="engine-canvas"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    // A quarter in, which is inside the **first** pane of the default 2x2 — a slice pane, where
    // §7.5's R1 makes a left click set the cursor. The canvas centre is where all four panes meet,
    // and the one below it is the 3-D pane, whose left click is an orbit and not a cursor at all.
    await page.mouse.click(box!.x + box!.width / 4, box!.y + box!.height / 4);
    await send(page, { type: 'setCursor', world: [1, 2, 3] }, false);
    await send(page, { type: 'setLayout', kind: 'axial' }, false);
    await send(page, { type: 'setTheme', theme: 'light' }, false);
    await send(page, { type: 'serialize' });
    await send(page, { type: 'reset' }, false);
    await page.waitForTimeout(500);

    const seen = [...new Set((await events(page)).map((e) => e['type'] as string))].sort();
    // Every type, against a v1 host's own list. `pick`, `pointTool` and `camera` are absent because
    // nothing here could have asked for one — not because a v1 host would have ignored them.
    for (const type of seen) {
      expect(V1_EMBED_TYPES as readonly string[], `unexpected message type '${type}'`).toContain(
        type
      );
    }
    expect(seen).toContain('cursor');
    expect(seen).toContain('loaded');
  });

  test('a click emits no pick until a host turns pick events on', async ({ page }) => {
    await openHost(page);
    await load(page);
    const canvas = page.frameLocator('#viewer').locator('[data-testid="engine-canvas"]');
    const box = await canvas.boundingBox();

    // In the first pane of the default 2x2 — a slice pane, where a left click sets the cursor.
    const inPane = (dx: number, dy: number): [number, number] => [
      box!.x + box!.width / 4 + dx,
      box!.y + box!.height / 4 + dy,
    ];
    await page.mouse.click(...inPane(0, 0));
    await page.waitForTimeout(300);
    expect((await events(page)).filter((e) => e['type'] === 'pick')).toHaveLength(0);
    // The click did land: the cursor moved. Without this the test would pass on a click that missed.
    expect((await events(page)).filter((e) => e['type'] === 'cursor').length).toBeGreaterThan(0);

    // The same click, after one message. This is the whole difference between the two protocols on
    // this path, and it is a message a v1 host never sends.
    await send(page, { type: 'setPickEvents', enabled: true }, false);
    await page.mouse.click(...inPane(10, 10));
    await page.waitForFunction(
      () => (window as unknown as HostWindow).__host.events.some((e) => e['type'] === 'pick'),
      undefined,
      { timeout: 10_000 }
    );

    // …and off again, which must be as complete as never having asked.
    await send(page, { type: 'setPickEvents', enabled: false }, false);
    const before = (await events(page)).filter((e) => e['type'] === 'pick').length;
    await page.mouse.click(...inPane(20, 20));
    await page.waitForTimeout(300);
    expect((await events(page)).filter((e) => e['type'] === 'pick')).toHaveLength(before);
  });

  test('a protocol-2 message a v1 build never had is answered, not fatal', async ({ page }) => {
    // The other direction of forward compatibility, and the reason `HOST_MESSAGE_TYPES` may only be
    // appended to: a message this build does not know is still dropped in silence, and one it does
    // know cannot break the session that follows it.
    await openHost(page);
    await page.evaluate(() => {
      const frame = document.querySelector('iframe') as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ tvx: 1, type: 'setPointTool', layerId: 'nope' }, '*');
      frame.contentWindow?.postMessage({ tvx: 1, type: 'somethingFromProtocol9' }, '*');
    });
    await page.waitForTimeout(300);
    const loaded = await load(page);
    expect(loaded['type']).toBe('loaded');
  });
});
