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

/**
 * Load the same scene with `shape: 'dot'` — a screen-space disc — and the given `dotRadiusPx`.
 *
 * Everything else is `loadPointsScene`'s: the same four points at the same world positions, the
 * same colours, the same 20 px/mm coronal ruler. What changes is the branch `point-ring.ts` takes,
 * which is the point of the comparison — the sphere test above reads the disc at `radiusMm / mmPerPx`
 * = 40 px, and a dot at `dotRadiusPx · uiScale` is a different number at the same camera.
 */
async function loadDotScene(page: Page, dotRadiusPx: number): Promise<{ layerId: string }> {
  const loaded = await loadPointsScene(page);
  await send(
    page,
    { type: 'updateLayer', layerId: loaded.layerId, patch: { shape: 'dot', dotRadiusPx } },
    false
  );
  await page.waitForTimeout(300);
  return loaded;
}

/** The pane's CSS-pixel scale — `derived.ts` sends `uDotPx = dotRadiusPx · uiScale`. */
const uiScale = (page: Page): Promise<number> =>
  page
    .frameLocator('#viewer')
    .locator(CANVAS)
    .evaluate(() => window.devicePixelRatio);

/** Every pixel on a circle of radius `r` around a centre, as pane coordinates. */
const circle = ([cx, cy]: readonly [number, number], r: number, n = 24): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });

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

  test('pointHover names the point under the pointer, on the edge only', async ({ page }) => {
    await openHost(page);
    const { layerId } = await loadPointsScene(page);
    const size = await capture(page);
    const box = await canvas(page).boundingBox();
    expect(box).not.toBeNull();

    const hovers = async (): Promise<Record<string, unknown>[]> =>
      (await events(page)).filter((e) => e['type'] === 'pointHover');

    // Off by default: moving across a point says nothing at all, which is the guarantee a
    // protocol-1 host's message stream depends on.
    await page.mouse.move(box!.x + at(size, 5, 5)[0], box!.y + at(size, 5, 5)[1]);
    await page.waitForTimeout(200);
    expect(await hovers()).toEqual([]);

    await send(page, { type: 'setHoverEvents', enabled: true }, true);

    // Onto a point: one event naming it, and the layer it is in.
    await page.mouse.move(box!.x + at(size, -5, 5)[0], box!.y + at(size, -5, 5)[1]);
    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) => e['type'] === 'pointHover' && e['pointId'] === 'IDLE'
        ),
      undefined,
      { timeout: 10_000 }
    );
    const onPoint = (await hovers()).at(-1)!;
    expect(onPoint['layerId']).toBe(layerId);

    // The EDGE, not the move: several more moves within the same disc add nothing. Without this a
    // host repainting on every event would repaint a 185-electrode net at pointer rate.
    const before = (await hovers()).length;
    for (const dx of [1, -1, 2]) {
      await page.mouse.move(box!.x + at(size, -5, 5)[0] + dx, box!.y + at(size, -5, 5)[1]);
    }
    await page.waitForTimeout(200);
    expect(await hovers()).toHaveLength(before);

    // Off every point: one event with both fields null, which is what paints a hover off.
    await page.mouse.move(box!.x + at(size, 0, 8)[0], box!.y + at(size, 0, 8)[1]);
    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) => e['type'] === 'pointHover' && e['pointId'] === null
        ),
      undefined,
      { timeout: 10_000 }
    );
    const off = (await hovers()).at(-1)!;
    expect(off['layerId']).toBeNull();

    // And the id it reports is the id a CLICK would select — the same engine hit test, so a host
    // never highlights one electrode and selects another.
    await send(page, { type: 'setPointTool', layerId, mode: 'select' }, true);
    await send(page, { type: 'setPickEvents', enabled: true }, false);
    await page.mouse.click(box!.x + at(size, -5, 5)[0], box!.y + at(size, -5, 5)[1]);
    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) => e['type'] === 'pick' && e['kind'] === 'point'
        ),
      undefined,
      { timeout: 10_000 }
    );
    const pick = (await events(page)).filter((e) => e['type'] === 'pick').at(-1)!;
    expect(pick['pointId']).toBe(onPoint['pointId']);
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

test.describe("shape: 'dot' — a screen-space marker, and no ring around it", () => {
  const DOT_PX = 10;

  test('the disc is dotRadiusPx on screen, and its centre is the point colour', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openHost(page);
    await loadDotScene(page, DOT_PX);
    const scale = await uiScale(page);
    // `dotRadiusPxOf` clamps to 0.5..64 and 10 is inside that, so the drawn radius is exactly this.
    const radius = DOT_PX * scale;
    const size = await capture(page);

    const centre = at(size, -5, 5);
    await expectPixels(page, [
      // The assertion the whole branch exists for: the sampled centre pixel IS the point's colour.
      // Unshaded 2-D cross-section, alpha 1, layer opacity 1 — `src·1 + dst·0` is the source.
      [centre, IDLE, "the dot's centre is the point colour"],
      [at(size, 5, 5), SELECTED, "state 'selected', as a dot"],
      [at(size, -5, -5), DISABLED, "state 'disabled', as a dot"],
      [at(size, 5, -5), EXPLICIT, 'an explicit colour, as a dot'],
      // Inside and outside the SCREEN radius, which is where a dot differs from a sphere. 2 px of
      // slack at each edge for the shader's antialiased rim; the two samples are 5 px apart.
      [[centre[0] + radius - 2, centre[1]], IDLE, `${radius - 2} px out, inside the disc`],
      [[centre[0] + radius + 3, centre[1]], BG, `${radius + 3} px out, past it`],
      // And it really is screen-space: the sphere branch draws `radiusMm / mmPerPx` = 2 / 0.05 =
      // 40 px at this camera, and the test above reads the layer colour 30 px out. Here 30 px out is
      // the background, because `dotRadiusPx · uiScale` replaced that radius entirely.
      [[centre[0] + 1.5 / MM_PER_PX, centre[1]], BG, '30 px out — the sphere radius, not the dot'],
    ]);
    expect(errors).toEqual([]);
  });

  test('no ring is drawn while no tool is armed — and one is, the moment it is', async ({
    page,
  }) => {
    await openHost(page);
    const { layerId } = await loadDotScene(page, DOT_PX);
    const scale = await uiScale(page);
    const size = await capture(page);
    const centre = at(size, 5, 5);

    // `ringRadiusPx(disc, scale) = max(4·scale, disc + 2·scale)` at `POINT_RING_WIDTH_PX = 2`, so a
    // ring for this disc lives between `disc + scale` and `disc + 3·scale` pixels out. Sampling that
    // band on 24 spokes at 1 px steps crosses it wherever it is.
    const band: [number, number][] = [];
    for (let r = DOT_PX * scale + scale; r <= DOT_PX * scale + 3 * scale; r += 1) {
      band.push(...circle(centre, r));
    }

    const isBackground = (px: Rgba): boolean => px.every((v, c) => Math.abs(v - (BG[c] ?? 0)) <= 1);

    // No `setPointTool` has been sent, so nothing is armed and nothing may be drawn around the disc.
    // This is the assertion B2 asks for: the absence of a ring is measured, not assumed.
    const quiet = await samples(page, band);
    const drawn = quiet.filter((px) => !isBackground(px));
    expect(
      drawn,
      `${drawn.length} non-background pixels in the ring band with no tool armed`
    ).toEqual([]);

    // …and the check is not vacuous: arm the tool, select that very point, and the same band fills.
    // A test that only ever asserted "background" would pass just as well if the band were in the
    // wrong place, or if the layer had not rendered at all.
    await send(page, { type: 'setPointTool', layerId, mode: 'select' }, true);
    await send(page, { type: 'setPointSelection', layerId, pointId: 'SEL' }, true);
    await page.waitForTimeout(300);
    await capture(page);
    const ringed = await samples(page, band);
    expect(
      ringed.filter((px) => !isBackground(px)).length,
      'the same band, with the tool armed and that point selected'
    ).toBeGreaterThan(0);

    // The disc underneath is untouched by the ring — the marker is still its own colour.
    await expectPixels(page, [[centre, SELECTED, 'the dot under the ring']]);
  });
});

// ------------------------------------------------------------------------------------------------
// The 3-D pane (2026-09-05)
// ------------------------------------------------------------------------------------------------

/**
 * Find the one green marker in the captured image: how many pixels it covers, its bounding box, and
 * the colour at that box's centre.
 *
 * A 3-D pane has no ruler to predict a pixel position with — `mmPerPx` is a slice camera's field and
 * the 3-D projection is a matrix the host never sees — so the marker is *found* rather than located,
 * and every assertion below is about its measured extent. That is still analytic: the expected
 * extent is `2 · dotRadiusPx · devicePixelRatio`, computed from what the host asked for, and the
 * expected centre colour is the one the host sent. Nothing is read off a picture and blessed.
 *
 * **Green-dominant, not "not the background".** The `screenshot` message renders with the app's own
 * capture settings (§8's `DEFAULT_SCREENSHOT_OPTIONS` include the crosshair) rather than with the
 * scene annotations, so the 3-D crosshair is drawn whatever the scene says — three achromatic lines
 * spanning the pane, which would make "not the background" span it too. The marker is the only green
 * thing, and the test scene gives it `[0, 1, 0, 1]` for exactly that reason. The threshold admits a
 * SHADED green as well as a flat one, because the `sphere` control below is shaded: its rim is
 * `green · ambient`, still green-dominant and still well above the floor.
 */
async function marker(
  page: Page
): Promise<{ count: number; w: number; h: number; centre: Rgba; cx: number; cy: number }> {
  return page.evaluate(() => {
    const shot = (window as unknown as HostWindow).__shot;
    if (shot === undefined) throw new Error('nothing captured');
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (let y = 0; y < shot.h; y += 1) {
      for (let x = 0; x < shot.w; x += 1) {
        const i = (y * shot.w + x) * 4;
        const r = shot.data[i] ?? 0;
        const g = shot.data[i + 1] ?? 0;
        const b = shot.data[i + 2] ?? 0;
        if (!(g > 40 && g > r + 20 && g > b + 20)) continue;
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (count === 0) return { count: 0, w: 0, h: 0, centre: [0, 0, 0, 0], cx: 0, cy: 0 };
    const cx = Math.round((minX + maxX) / 2);
    const cy = Math.round((minY + maxY) / 2);
    const j = (cy * shot.w + cx) * 4;
    return {
      count,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      centre: [
        shot.data[j] ?? 0,
        shot.data[j + 1] ?? 0,
        shot.data[j + 2] ?? 0,
        shot.data[j + 3] ?? 0,
      ],
      cx,
      cy,
    };
  }) as Promise<{ count: number; w: number; h: number; centre: Rgba; cx: number; cy: number }>;
}

/** How many pixels within `r` of `(cx, cy)` are not the authored background. */
async function nonBackgroundNear(page: Page, cx: number, cy: number, r: number): Promise<number> {
  return page.evaluate(
    ([x0, y0, radius, bg]) => {
      const shot = (window as unknown as HostWindow).__shot;
      if (shot === undefined) throw new Error('nothing captured');
      const back = bg as number[];
      let n = 0;
      for (let y = Math.max(0, y0 - radius); y <= Math.min(shot.h - 1, y0 + radius); y += 1) {
        for (let x = Math.max(0, x0 - radius); x <= Math.min(shot.w - 1, x0 + radius); x += 1) {
          if ((x - x0) ** 2 + (y - y0) ** 2 > radius * radius) continue;
          const i = (y * shot.w + x) * 4;
          if ([0, 1, 2, 3].some((c) => Math.abs((shot.data[i + c] ?? 0) - (back[c] ?? 0)) > 1)) {
            n += 1;
          }
        }
      }
      return n;
    },
    [cx, cy, Math.round(r), BG as unknown as number[]] as const
  );
}

/** One point at the world origin, in a 3-D-only pane, with `shape` and its size as given. */
async function loadOne3DPoint(
  page: Page,
  layer: Record<string, unknown>
): Promise<{ layerId: string }> {
  const template = (await send(page, { type: 'serialize' }))['spec'] as {
    annotations: Record<string, unknown>;
  };
  const loaded = await page.evaluate(
    async ([path, layerJson, annotationsJson]) => {
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
                // ONE point, at the world origin — which is the bounds centre of `testdata`'s
                // ±10 mm lattice (`testdata/manifest.json`, read back by nibabel and Gmsh), and so
                // the point every anatomical camera preset is aimed at.
                points: [{ id: 'ONE', position: [0, 0, 0], color: [0, 1, 0, 1] }],
                ...(JSON.parse(layerJson as string) as Record<string, unknown>),
              },
            ],
            activeLayerId: 'l1',
            // Away from the origin, so the 3-D crosshair the screenshot draws is not on the marker.
            cursor: [9, 9, 9],
            background: [0, 0, 0, 1],
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
    [LATTICE, JSON.stringify(layer), JSON.stringify(template.annotations)] as const
  );
  expect(loaded['type'], String(loaded['message'] ?? '')).toBe('loaded');
  await send(page, { type: 'setLayout', kind: '3d' }, false);
  // A known camera: superior, so the pane looks down -Z at the XY plane and the origin is centred.
  await send(page, { type: 'setCamera', preset: 'S' }, true);
  await page.waitForTimeout(300);
  const layers = loaded['layers'] as { id: string; kind: string }[];
  const points = layers.find((l) => l.kind === 'points');
  expect(points, 'the load produced a points layer').toBeDefined();
  return { layerId: points!.id };
}

test.describe("shape: 'dot' in the 3-D pane", () => {
  test('the disc is dotRadiusPx on screen, and its centre is the point colour', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openHost(page);
    const { layerId } = await loadOne3DPoint(page, { shape: 'dot', dotRadiusPx: 20, radiusMm: 4 });
    const scale = await uiScale(page);
    await capture(page);
    const got = await marker(page);

    // The assertion the whole change exists for. `dotRadiusPxOf` clamps to 0.5..64 and 20 is inside
    // it, so the drawn diameter is `2 · 20 · uiScale` device pixels, ±2 for the antialiased rim.
    //
    // 20 and not 10, deliberately: at this camera a `radiusMm: 4` SPHERE measures about 18 px, so a
    // 10 px dot would have been indistinguishable from the bug — which is precisely how the defect
    // survived (`209 px` for `dotRadiusPx` 5, 15 and `radiusMm: 4` alike, TI-Toolbox's measurement).
    // The sphere's own width is measured below rather than assumed, so the separation is a number.
    const diameter = 2 * 20 * scale;
    expect(got.count, 'nothing was drawn at all').toBeGreaterThan(0);
    expect(Math.abs(got.w - diameter), `width ${got.w}, expected ${diameter}`).toBeLessThanOrEqual(
      2
    );
    expect(Math.abs(got.h - diameter), `height ${got.h}, expected ${diameter}`).toBeLessThanOrEqual(
      2
    );
    // Flat, not a shaded hemisphere: the centre pixel is the colour the host sent, exactly.
    expect(got.centre).toEqual(EXPLICIT);

    // The same layer as a `sphere`, at the same camera, is a visibly different size — so the number
    // above is `dotRadiusPx` and not a coincidence of this scene's scale.
    await send(page, { type: 'updateLayer', layerId, patch: { shape: 'sphere' } }, false);
    await page.waitForTimeout(300);
    await capture(page);
    const asSphere = await marker(page);
    expect(
      Math.abs(asSphere.w - got.w),
      `dot ${got.w} px, sphere ${asSphere.w} px`
    ).toBeGreaterThan(10);
    expect(errors).toEqual([]);
  });

  test('dotRadiusPx drives the size — the defect this fixes, inverted', async ({ page }) => {
    // The TI-Toolbox electrode pane measured 5 and 15 producing a BYTE-IDENTICAL 209-pixel marker
    // in a `3d-only` pane, equal to what `radiusMm: 4` drew, because the 3-D pass set `uDotPx` to 0
    // and drew a millimetre sphere whatever `shape` said. This is that measurement, now separating.
    await openHost(page);
    // The LIVE id, not the `l1` the scene was written with: `Engine.load` reassigns every id, which
    // is what `loaded.layers` is for — an `updateLayer` naming the sent id is answered and does
    // nothing, and a test that used it would measure an unchanged layer twice and pass.
    const { layerId } = await loadOne3DPoint(page, { shape: 'dot', dotRadiusPx: 5, radiusMm: 4 });
    const scale = await uiScale(page);
    await capture(page);
    const small = await marker(page);

    await send(page, { type: 'updateLayer', layerId, patch: { dotRadiusPx: 15 } }, false);
    await page.waitForTimeout(300);
    await capture(page);
    const large = await marker(page);

    expect(Math.abs(small.w - 2 * 5 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(large.w - 2 * 15 * scale)).toBeLessThanOrEqual(2);
    // Three times the radius is nine times the area, and neither number came from a previous run.
    expect(large.count / small.count).toBeGreaterThan(6);
  });

  test("the radius does not change with camera distance, and a sphere's does", async ({ page }) => {
    await openHost(page);
    const { layerId } = await loadOne3DPoint(page, { shape: 'dot', dotRadiusPx: 20, radiusMm: 4 });
    await capture(page);
    const near = await marker(page);

    const camera = (await send(page, { type: 'getCamera' }))['camera'] as { distance: number };
    await send(page, { type: 'setCamera', patch: { distance: camera.distance * 2 } }, true);
    await page.waitForTimeout(300);
    await capture(page);
    const far = await marker(page);

    // A screen-space marker is the same size at any depth. This is the assertion that would fail if
    // the disc were expanded in world units and merely looked right at one distance.
    expect(Math.abs(far.w - near.w), `${near.w} px near, ${far.w} px far`).toBeLessThanOrEqual(1);

    // The control: the same layer as a sphere halves when the camera doubles its distance. Without
    // it, a `dot` test that measured the same number twice could be measuring a marker that ignores
    // the camera because it ignores everything.
    await send(page, { type: 'updateLayer', layerId, patch: { shape: 'sphere' } }, false);
    await send(page, { type: 'setCamera', patch: { distance: camera.distance } }, true);
    await page.waitForTimeout(300);
    await capture(page);
    const sphereNear = await marker(page);
    await send(page, { type: 'setCamera', patch: { distance: camera.distance * 2 } }, true);
    await page.waitForTimeout(300);
    await capture(page);
    const sphereFar = await marker(page);
    expect(sphereFar.w, `sphere: ${sphereNear.w} px near, ${sphereFar.w} px far`).toBeLessThan(
      sphereNear.w - 1
    );
  });

  test('no ring is drawn around a 3-D dot while no tool is armed', async ({ page }) => {
    await openHost(page);
    await loadOne3DPoint(page, { shape: 'dot', dotRadiusPx: 20, radiusMm: 4 });
    const scale = await uiScale(page);
    await capture(page);
    const got = await marker(page);

    // The marker is the ONLY green thing drawn: `count` is the disc's own area and nothing else. A ring
    // would add an annulus outside it, so its absence is the bounding box being the disc's.
    const radius = 20 * scale;
    const area = Math.PI * radius * radius;
    expect(
      got.count / area,
      `${got.count} px drawn for a disc of area ${Math.round(area)}`
    ).toBeLessThan(1.1);
    expect(got.count / area).toBeGreaterThan(0.9);

    // And explicitly, against the analytic area rather than against the previous count: inside a
    // neighbourhood three ring-widths wider than the disc, the pixels that are not the background
    // are the disc's own π·r². `ringRadiusPx` puts a ring at `disc + 2 · uiScale` with a 2 px
    // stroke, so a ring would add about `2π · 22 · 2` ≈ 280 px — 22 % on top of 1256, which this
    // 10 % bound cannot absorb. The slack that IS allowed is the antialiased rim, one pixel deep
    // around a 126 px circumference.
    const near = await nonBackgroundNear(page, got.cx, got.cy, radius + 6 * scale);
    expect(
      near / area,
      `${near} px are not the background near a disc of area ${Math.round(area)}`
    ).toBeLessThan(1.1);
  });

  test('golden: a flat screen-space dot in a 3-D pane', async ({ page }) => {
    await openHost(page);
    await loadOne3DPoint(page, { shape: 'dot', dotRadiusPx: 20, radiusMm: 4 });
    // §11 (2), regression only. Every number this picture contains is asserted above — the diameter,
    // the centre colour, the absence of a ring; what the golden adds is that nothing *else* moved,
    // and in particular that the disc is flat where the sphere it replaced was shaded.
    await expectGolden(canvas(page), 'embed-points-3d-dot', CANVAS);
  });
});
