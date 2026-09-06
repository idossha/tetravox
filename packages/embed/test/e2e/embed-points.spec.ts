/**
 * Protocol 2, end to end: a points layer written inline, the point tool, `pick`, and the camera.
 *
 * **§11 rule 0 — an agent cannot judge a PNG, it can judge a number** — so the rendering half of
 * this file is an analytic pixel assertion first and a golden second, and every expected value is
 * computed here from first principles:
 *
 *  * the layer draws at `opacity: 1` and every point at alpha 1, and §7.2's 2-D cross-section is
 *    **unshaded**, so the pixel at a point's centre is that point's colour and nothing else — the
 *    blend `src·1 + dst·0` is the source, whatever is behind it;
 *  * `state: 'selected'` and `state: 'disabled'` resolve to `points.ts`'s defaults, whose channels
 *    are whole multiples of `1/255` on purpose: `[1, 0.8, 0.2, 1]` is `rgb(255, 204, 51)` and
 *    `[0.6, 0.6, 0.6, 1]` is `rgb(153, 153, 153)`, with no rounding to argue about;
 *  * an explicit per-point `color` beats its `state`, which is the rule `points.test.ts` asserts on
 *    the object and this file asserts on the framebuffer;
 *  * `testdata/manifest.json` reports `mesh_v2_binary.msh`'s bbox as exactly ±10 mm on every axis —
 *    a number from nibabel and Gmsh reading the fixture back, never from a render — so the scene
 *    bounds centre is the world origin. §4.5's 2-D camera is *relative to the bounds centre*, so
 *    `center: [0, 0]` at `mmPerPx: 0.05` makes the coronal pane a 20 px/mm ruler around it: world
 *    `(x, ·, z)` is pane pixel `(CX + x/0.05, CY − z/0.05)`.
 *
 * **Why the pixels come from `screenshot` rather than from `readPixels`.** §11's harness reads the
 * drawing buffer through `window.__tvxRender()`, which re-renders in the *same task* — the engine's
 * context is `preserveDrawingBuffer: false`, so a read after compositing sees undefined content.
 * The embed has no such hook and must not grow one: `Engine.screenshot` already renders and reads
 * back synchronously, it is the documented `screenshot` message, and the PNG round-trip is lossless
 * RGBA8. So the numbers below are the product's own output, decoded in the page. Nothing is measured
 * off a picture; the picture is only where the numbers are read from.
 *
 * The scene carries **no mesh layer**, only the mesh dataset the points hang off. The pane is
 * therefore the authored `background` everywhere the discs are not, which is a second number rather
 * than a measurement.
 *
 * The fixture is committed (`testdata/`), so unlike `embed.spec.ts`'s scene tests nothing here is
 * gated on `TETRAVOX_TESTDATA`.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, type Rgba } from '../../../engine/test/helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
/** The 20 mm lattice of `testdata/`, over Vite's `/@fs/` mount — a ROOT-relative URL. */
const LATTICE = `/@fs${REPO}testdata/mesh_v2_binary.msh`;

/** The canvas inside the iframe. One context, one canvas, every pane (§1). */
const CANVAS = '[data-testid="engine-canvas"]';

const MM_PER_PX = 0.05;
/** `[0, 0, 0, 1]`, authored into the scene below, is the pane's clear colour in wire bytes. */
const BG: Rgba = [0, 0, 0, 255];
/** The layer colour, for the point that carries neither a `color` nor a resolved `state`. */
const IDLE: Rgba = [255, 0, 0, 255];
/** `points.ts`'s `DEFAULT_STATE_COLORS.selected` = `[1, 0.8, 0.2, 1]`. */
const SELECTED: Rgba = [255, 204, 51, 255];
/** `points.ts`'s `DEFAULT_STATE_COLORS.disabled` = `[0.6, 0.6, 0.6, 1]`. */
const DISABLED: Rgba = [153, 153, 153, 255];
/** An explicit per-point colour, which must beat the `state` beside it. */
const EXPLICIT: Rgba = [0, 255, 0, 255];

interface HostWindow {
  __host: {
    send(message: Record<string, unknown>, expectReply?: boolean): Promise<Record<string, unknown>>;
    events: Record<string, unknown>[];
  };
  __shot?: { w: number; h: number; data: Uint8ClampedArray };
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

async function openHost(page: Page): Promise<void> {
  await page.goto('/example/host.html?data=/none');
  await page.waitForFunction(
    () => (window as unknown as HostWindow).__host?.events.some((e) => e['type'] === 'ready'),
    undefined,
    { timeout: 60_000 }
  );
}

const canvas = (page: Page): Locator => page.frameLocator('#viewer').locator(CANVAS);

/**
 * Take a `screenshot` and keep it **in the page**, so sampling costs four numbers per pixel rather
 * than 2.2 million across the CDP boundary. Returns the image's size, which is the pane's — the
 * layout below is a single pane, so the grid is that pane.
 */
async function capture(page: Page): Promise<{ w: number; h: number }> {
  const reply = await send(page, { type: 'screenshot', target: 'grid' });
  expect(reply['type'], `screenshot failed: ${String(reply['message'] ?? '')}`).toBe('screenshot');
  return page.evaluate(async (dataUrl) => {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = surface.getContext('2d');
    if (ctx === null) throw new Error('no 2d context to decode the screenshot into');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    (window as unknown as HostWindow).__shot = {
      w: bitmap.width,
      h: bitmap.height,
      data: image.data,
    };
    return { w: bitmap.width, h: bitmap.height };
  }, reply['dataUrl'] as string);
}

/** RGBA at several top-left-origin pixels of the captured image, in one round trip. */
async function samples(
  page: Page,
  points: readonly (readonly [number, number])[]
): Promise<Rgba[]> {
  return page.evaluate(
    (pts) => {
      const shot = (window as unknown as HostWindow).__shot;
      if (shot === undefined) throw new Error('nothing captured');
      return pts.map(([x, y]) => {
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= shot.w || py >= shot.h) {
          throw new Error(`pixel (${px}, ${py}) is outside the ${shot.w}x${shot.h} image`);
        }
        const i = (py * shot.w + px) * 4;
        return [
          shot.data[i] ?? 0,
          shot.data[i + 1] ?? 0,
          shot.data[i + 2] ?? 0,
          shot.data[i + 3] ?? 0,
        ];
      });
    },
    points as (readonly [number, number])[]
  ) as Promise<Rgba[]>;
}

/** §11 (1), against the captured image. The expected value is always computed, never read back. */
async function expectPixels(
  page: Page,
  cases: readonly (readonly [readonly [number, number], Rgba, string])[],
  tol = 1
): Promise<void> {
  const got = await samples(
    page,
    cases.map(([xy]) => xy)
  );
  cases.forEach(([xy, want, what], i) => {
    const actual = got[i]!;
    const worst = Math.max(...actual.map((v, c) => Math.abs(v - (want[c] ?? 0))));
    expect(
      worst,
      `${what} at (${xy[0]}, ${xy[1]}): expected rgba(${want.join(', ')}) ±${tol}, got rgba(${actual.join(', ')})`
    ).toBeLessThanOrEqual(tol);
  });
}

/**
 * Load the scene, and put a single coronal pane on the canvas.
 *
 * The camera is sent in the `ViewSpec` (nothing the host sends is ever overridden) and the layout is
 * sent as a `setLayout` message — the load's own `layout` is reconciled by the shell, and the
 * message is what a host has for this. `setLayout { kind: 'coronal' }` is protocol 1's own spelling,
 * made to work by `layout.ts`.
 */
async function loadPointsScene(page: Page): Promise<{ layerId: string }> {
  const template = (await send(page, { type: 'serialize' }))['spec'] as {
    slices: { id: string; camera: { center: [number, number]; mmPerPx: number } }[];
    annotations: Record<string, unknown>;
  };
  const slices = template.slices.map((view) =>
    view.id === 'coronal' ? { ...view, camera: { center: [0, 0], mmPerPx: MM_PER_PX } } : view
  );
  const loaded = await page.evaluate(
    async ([path, slicesJson, annotationsJson]) => {
      const host = (window as unknown as HostWindow).__host;
      return host.send(
        {
          type: 'load',
          scene: {
            version: 2,
            datasets: [{ id: 'd1', kind: 'mesh', name: 'lattice.msh', path }],
            layers: [
              {
                id: 'l1',
                datasetId: 'd1',
                kind: 'points',
                name: 'contacts',
                points: [
                  { id: 'IDLE', name: 'a', position: [-5, 2.5, 5] },
                  { id: 'SEL', name: 'b', position: [5, 2.5, 5], state: 'selected' },
                  { id: 'DIS', name: 'c', position: [-5, 2.5, -5], state: 'disabled' },
                  {
                    id: 'OWN',
                    name: 'd',
                    position: [5, 2.5, -5],
                    state: 'selected',
                    color: [0, 1, 0, 1],
                  },
                ],
                color: [1, 0, 0, 1],
                radiusMm: 2,
                labelMode: 'none',
              },
            ],
            activeLayerId: 'l1',
            cursor: [0, 2.5, 0],
            background: [0, 0, 0, 1],
            slices: JSON.parse(slicesJson as string),
            annotations: {
              ...(JSON.parse(annotationsJson as string) as Record<string, unknown>),
              crosshair: false,
              orientationLabels: false,
              cornerInfo: false,
              scaleBar: false,
              colorbars: false,
              orientationCube: false,
            },
          },
        },
        true
      );
    },
    [LATTICE, JSON.stringify(slices), JSON.stringify(template.annotations)] as const
  );
  expect(loaded['type'], String(loaded['message'] ?? '')).toBe('loaded');
  await send(page, { type: 'setLayout', kind: 'coronal' }, false);
  await page.waitForTimeout(300);
  const layers = loaded['layers'] as { id: string; kind: string }[];
  const points = layers.find((l) => l.kind === 'points');
  expect(points, 'the load produced a points layer').toBeDefined();
  return { layerId: points!.id };
}

/** World `(x, ·, z)` → the coronal pane pixel, by §3 and the camera the scene declared. */
const at = (size: { w: number; h: number }, x: number, z: number): [number, number] => [
  size.w / 2 + x / MM_PER_PX,
  size.h / 2 - z / MM_PER_PX,
];

test.describe('a points layer written inline', () => {
  test('every state is its own colour, exactly, on the ruler the scene declared', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openHost(page);
    await loadPointsScene(page);

    // The camera the load was given is the camera the scene has — `applyViewSpec` assigns the nine
    // view fields unconditionally, so a host that sends one gets exactly it. Asserted rather than
    // assumed, because every pixel below is derived from these two numbers.
    const spec = (await send(page, { type: 'serialize' }))['spec'] as {
      slices: { id: string; camera: { center: [number, number]; mmPerPx: number } }[];
      layout: { kind: string };
    };
    expect(spec.slices.find((v) => v.id === 'coronal')?.camera).toEqual({
      center: [0, 0],
      mmPerPx: MM_PER_PX,
    });
    // One pane, so the grid IS the coronal pane and its centre is the camera's.
    expect(spec.layout.kind).toBe('1x1');

    const size = await capture(page);
    await expectPixels(page, [
      // Four discs, four colours, each computed from `points.ts` and §4.1's 0..255 round-trip.
      [at(size, -5, 5), IDLE, 'the point with no state is the layer colour'],
      [at(size, 5, 5), SELECTED, "state 'selected'"],
      [at(size, -5, -5), DISABLED, "state 'disabled'"],
      [at(size, 5, -5), EXPLICIT, 'an explicit colour beats the state beside it'],
      // The radius is the layer's 2 mm and not a screen constant: 1.5 mm out is inside the disc,
      // 2.5 mm out is the authored background. A `shape: 'dot'` marker would fail both.
      [
        [at(size, -5, 5)[0] + 1.5 / MM_PER_PX, at(size, -5, 5)[1]],
        IDLE,
        '1.5 mm out, inside the 2 mm disc',
      ],
      [[at(size, -5, 5)[0] + 2.5 / MM_PER_PX, at(size, -5, 5)[1]], BG, '2.5 mm out, outside it'],
      // …and the pane really is empty elsewhere: this scene has no mesh layer at all. Off both
      // crosshair axes, because the `screenshot` message renders with the app's own capture
      // settings (§8's `DEFAULT_SCREENSHOT_OPTIONS` include the crosshair) rather than with the
      // scene annotations the live pane uses.
      [at(size, 8, 8), BG, 'the authored background'],
    ]);

    expect(errors).toEqual([]);
  });

  test('setPoints repaints a state without the host restating the colour', async ({ page }) => {
    await openHost(page);
    const { layerId } = await loadPointsScene(page);
    const size = await capture(page);
    await expectPixels(page, [[at(size, -5, 5), IDLE, 'before']]);

    // The same layer, the same ids, two states swapped. `setPoints` is what runs the resolution —
    // this is the assertion that makes it worth having beside `updateLayer`.
    await send(
      page,
      {
        type: 'setPoints',
        layerId,
        points: [
          { id: 'IDLE', name: 'a', position: [-5, 2.5, 5], state: 'selected' },
          { id: 'SEL', name: 'b', position: [5, 2.5, 5] },
          { id: 'DIS', name: 'c', position: [-5, 2.5, -5], state: 'disabled' },
          { id: 'OWN', name: 'd', position: [5, 2.5, -5], color: [0, 1, 0, 1] },
        ],
      },
      false
    );
    await page.waitForTimeout(300);
    await capture(page);
    await expectPixels(page, [
      [at(size, -5, 5), SELECTED, 'idle → selected'],
      [at(size, 5, 5), IDLE, 'selected → the layer colour'],
      [at(size, -5, -5), DISABLED, 'unchanged'],
      [at(size, 5, -5), EXPLICIT, 'unchanged'],
    ]);
  });

  test("a host's own stateColors are the ones painted, on load and on every setPoints", async ({
    page,
  }) => {
    await openHost(page);
    const { layerId } = await loadPointsScene(page);
    const size = await capture(page);

    // The palette rides on the layer, which is the only place a later `setPoints` can read it back
    // from. `[0, 0.4, 1, 1]` is rgb(0, 102, 255) — byte-exact, like the defaults.
    await send(
      page,
      { type: 'updateLayer', layerId, patch: { stateColors: { selected: [0, 0.4, 1, 1] } } },
      false
    );
    await send(
      page,
      {
        type: 'setPoints',
        layerId,
        points: [{ id: 'IDLE', name: 'a', position: [-5, 2.5, 5], state: 'selected' }],
      },
      false
    );
    await page.waitForTimeout(300);
    await capture(page);
    await expectPixels(page, [
      [at(size, -5, 5), [0, 102, 255, 255], "the host's own 'selected'"],
      // The other three went with the replaced array, which is how a points layer deletes.
      [at(size, 5, 5), BG, 'a point that is no longer in the array'],
    ]);
  });

  test('golden: four states over an authored background', async ({ page }) => {
    await openHost(page);
    await loadPointsScene(page);
    // §11 (2), regression only. Every number this picture contains is asserted above; what the
    // golden adds is that nothing *else* moved.
    await expectGolden(canvas(page), 'embed-points', CANVAS);
  });
});

test.describe('the point tool over postMessage', () => {
  test('a click selects the point under it, and the pick says what it hit', async ({ page }) => {
    await openHost(page);
    const { layerId } = await loadPointsScene(page);
    const size = await capture(page);

    await send(page, { type: 'setPointTool', layerId, mode: 'select' }, false);
    await send(page, { type: 'setPickEvents', enabled: true }, false);

    // A real click in the pane, at the pixel the ruler puts the point at.
    const [px, py] = at(size, 5, 5);
    const box = await canvas(page).boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + px, box!.y + py);

    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) => e['type'] === 'pick' && e['kind'] === 'point'
        ),
      undefined,
      { timeout: 10_000 }
    );
    const all = await events(page);
    const pick = all.filter((e) => e['type'] === 'pick').at(-1)!;
    // The four things E5 asked a pick to carry: the layer, the point id when a point was hit, the
    // world position, and what the probe resolved there.
    expect(pick['kind']).toBe('point');
    expect(pick['layerId']).toBe(layerId);
    expect(pick['pointId']).toBe('SEL');
    const world = pick['world'] as number[];
    expect(world[0]).toBeCloseTo(5, 1);
    expect(world[2]).toBeCloseTo(5, 1);
    expect((pick['probe'] as { world: number[] }).world).toEqual(world);
    expect(pick['modifiers']).toEqual({ shift: false, ctrl: false, alt: false, meta: false });

    // **Exactly one pick per press.** The ranking is not decoration: a press can produce a cursor
    // change, an id-pass answer and a point in one dispatch, and a host that received three would
    // have to work out which one it meant.
    expect(all.filter((e) => e['type'] === 'pick')).toHaveLength(1);

    // And the tool said so in its own words, which is what a host editing points listens to.
    const tool = all.filter((e) => e['type'] === 'pointTool');
    const selected = tool.find((e) => (e['event'] as { kind: string }).kind === 'selected');
    expect(selected).toBeDefined();
    expect((selected!['event'] as { pointId: string }).pointId).toBe('SEL');
  });

  test('a click on nothing is a cursor pick, with the world point under it', async ({ page }) => {
    await openHost(page);
    await loadPointsScene(page);
    const size = await capture(page);
    await send(page, { type: 'setPickEvents', enabled: true }, false);

    // 8 mm above the origin: inside the pane, outside every 2 mm disc.
    const [px, py] = at(size, 0, 8);
    const box = await canvas(page).boundingBox();
    await page.mouse.click(box!.x + px, box!.y + py);

    await page.waitForFunction(
      () => (window as unknown as HostWindow).__host.events.some((e) => e['type'] === 'pick'),
      undefined,
      { timeout: 10_000 }
    );
    const pick = (await events(page)).filter((e) => e['type'] === 'pick').at(-1)!;
    expect(pick['kind']).toBe('cursor');
    expect(pick['pointId']).toBeUndefined();
    const world = pick['world'] as number[];
    // The §3 identity from the other side: the click's world point is the one the ruler predicts.
    expect(world[0]).toBeCloseTo(0, 1);
    expect(world[2]).toBeCloseTo(8, 1);
  });

  test('the host can set and clear the selection by id', async ({ page }) => {
    await openHost(page);
    const { layerId } = await loadPointsScene(page);
    await send(page, { type: 'setPointTool', layerId, mode: 'select' }, false);

    await send(page, { type: 'setPointSelection', layerId, pointId: 'DIS' }, false);
    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) =>
            e['type'] === 'pointTool' &&
            (e['event'] as { kind: string }).kind === 'selected' &&
            (e['event'] as { pointId: string | null }).pointId === 'DIS'
        ),
      undefined,
      { timeout: 10_000 }
    );

    await send(page, { type: 'setPointSelection', layerId, pointId: null }, false);
    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) =>
            e['type'] === 'pointTool' &&
            (e['event'] as { kind: string }).kind === 'cleared' &&
            // §4.7: only the selection went, the tool is still armed. A host that read this as a
            // disarm would stop re-arming after the next load for no reason a user could see.
            (e['event'] as { reason?: string }).reason === 'selection'
        ),
      undefined,
      { timeout: 10_000 }
    );
  });

  test('the three point messages answer, so a host can await them', async ({ page }) => {
    // The bug: they acted and replied with nothing, and `postMessage` cannot tell silence from a
    // dropped message — so `await send({type:'setPoints'}, true)` never settled. The host helper's
    // `expectReply` resolves on the matching `id`, which is exactly the host shape that hung, so a
    // test that finishes at all is the assertion. The 5 s cap makes a regression a failure rather
    // than a 60 s timeout with no message.
    test.setTimeout(60_000);
    await openHost(page);
    const { layerId } = await loadPointsScene(page);

    const awaited = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const reply: Record<string, unknown> = await Promise.race([
        send(page, message, true),
        page.waitForTimeout(5000).then(() => ({ type: 'TIMED OUT' }) as Record<string, unknown>),
      ]);
      expect(reply['type'], `no reply to ${String(message['type'])} within 5 s`).toBe('ack');
      expect(reply['of']).toBe(message['type']);
      expect(typeof reply['id']).toBe('string');
      return reply;
    };

    await awaited({ type: 'setPointTool', layerId, mode: 'select' });
    await awaited({ type: 'setPointSelection', layerId, pointId: 'DIS' });
    await awaited({
      type: 'setPoints',
      layerId,
      points: [{ id: 'IDLE', name: 'a', position: [-5, 2.5, 5], state: 'selected' }],
    });
    await awaited({ type: 'setPointTool', layerId: null });

    // The ack lands AFTER the work — the whole reason to await one. The scene has already been
    // replaced by the time the third reply resolved, with no settling wait of any kind here.
    const spec = (await send(page, { type: 'serialize' }))['spec'] as {
      layers: { id: string; kind: string; points?: unknown[] }[];
    };
    const layer = spec.layers.find((l) => l.kind === 'points');
    expect(layer?.points).toHaveLength(1);

    // And an id-less send is still answered with nothing, which is `withId`'s rule everywhere else:
    // a protocol-1-shaped host receives exactly the stream it received before.
    const before = (await events(page)).filter((e) => e['type'] === 'ack').length;
    await send(page, { type: 'setPointSelection', layerId, pointId: null }, false);
    await page.waitForTimeout(300);
    expect((await events(page)).filter((e) => e['type'] === 'ack')).toHaveLength(before);
  });

  test('place mode appends a point at the click, with no hit test', async ({ page }) => {
    await openHost(page);
    const { layerId } = await loadPointsScene(page);
    const size = await capture(page);
    await send(page, { type: 'setPointTool', layerId, mode: 'place' }, false);

    const [px, py] = at(size, 0, 0);
    const box = await canvas(page).boundingBox();
    await page.mouse.click(box!.x + px, box!.y + py);

    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) => e['type'] === 'pointTool' && (e['event'] as { kind: string }).kind === 'placed'
        ),
      undefined,
      { timeout: 10_000 }
    );
    const layers = (await events(page)).filter((e) => e['type'] === 'layers').at(-1)!;
    const layer = (layers['layers'] as { id: string; points?: unknown[] }[]).find(
      (l) => l.id === layerId
    );
    expect(layer?.points).toHaveLength(5);
    // The engine mints `p<n>` for a point it placed; the four the host sent keep their own ids,
    // which is the whole reason a host sends them.
    const ids = (layer?.points as { id: string }[]).map((p) => p.id);
    expect(ids.slice(0, 4)).toEqual(['IDLE', 'SEL', 'DIS', 'OWN']);
    expect(ids[4]).toMatch(/^p\d+$/);
  });

  test('disarming says who asked, so a host knows not to re-arm', async ({ page }) => {
    await openHost(page);
    const { layerId } = await loadPointsScene(page);
    await send(page, { type: 'setPointTool', layerId, mode: 'select' }, false);
    await send(page, { type: 'setPointTool', layerId: null }, false);
    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) =>
            e['type'] === 'pointTool' &&
            (e['event'] as { kind: string }).kind === 'cleared' &&
            (e['event'] as { reason?: string }).reason === 'host'
        ),
      undefined,
      { timeout: 10_000 }
    );
  });
});

test.describe('the camera', () => {
  test('round-trips through getCamera and setCamera', async ({ page }) => {
    await openHost(page);
    await loadPointsScene(page);

    const before = (await send(page, { type: 'getCamera' }))['camera'] as {
      distance: number;
      target: number[];
      near: number;
      far: number;
    };
    expect(typeof before.distance).toBe('number');
    expect(before.target).toHaveLength(3);

    // A patch, not a whole camera: `near`/`far` stay the engine's, which is the whole reason the
    // message takes one (§7.2 derives them from the fit radius, and a restored pose that carried a
    // stale clip range back with it would clip the head away).
    const after = (
      await send(page, { type: 'setCamera', patch: { distance: before.distance * 2 } })
    )['camera'] as { distance: number; near: number; far: number };
    expect(after.distance).toBeCloseTo(before.distance * 2, 5);
    expect(after.near).toBe(before.near);
    expect(after.far).toBe(before.far);

    // Put it back exactly, which is the use the pair exists for.
    const restored = (
      await send(page, { type: 'setCamera', patch: { distance: before.distance } })
    )['camera'] as { distance: number };
    expect(restored.distance).toBeCloseTo(before.distance, 5);
  });

  test('a preset is the same six the keyboard offers', async ({ page }) => {
    await openHost(page);
    await loadPointsScene(page);
    const left = (await send(page, { type: 'setCamera', preset: 'L' }))['camera'] as {
      rotation: number[];
    };
    const superior = (await send(page, { type: 'setCamera', preset: 'S' }))['camera'] as {
      rotation: number[];
    };
    expect(left.rotation).toHaveLength(4);
    // Two different presets are two different poses — a preset that silently did nothing would
    // otherwise pass every other assertion here.
    expect(superior.rotation).not.toEqual(left.rotation);
  });

  test('never posts a camera nobody asked for', async ({ page }) => {
    await openHost(page);
    await loadPointsScene(page);
    await send(page, { type: 'setCamera', preset: 'A' }, false);
    await page.waitForTimeout(300);
    // An orbit is a camera change per frame; a `camera` event per frame is a message storm. The
    // camera is answered, never announced.
    expect((await events(page)).filter((e) => e['type'] === 'camera')).toHaveLength(0);
  });
});
