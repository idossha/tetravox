/**
 * The embed, end to end: a real host page, a real iframe, a real WebGL2 context and real files.
 *
 * The test drives `example/host.html` — the page `docs/EMBED.md` documents — rather than a harness
 * of its own. What it proves is therefore that the *example* works, and an example that rots fails
 * the build.
 *
 * Real data is skipped, never failed, when `TETRAVOX_TESTDATA` is unset (AGENTS.md rule 2).
 */

import { expect, test, type Page } from '@playwright/test';

const TESTDATA = process.env.TETRAVOX_TESTDATA;
const hasData = TESTDATA !== undefined && TESTDATA !== '';

/** The reference dataset over Vite's `/@fs/` mount — a ROOT-relative URL, resolved by the embed. */
const DATA_ROOT_RELATIVE = `/@fs/${TESTDATA}`;

interface HostWindow {
  __host: {
    send(message: Record<string, unknown>, expectReply?: boolean): Promise<Record<string, unknown>>;
    events: Record<string, unknown>[];
    SCENES: Record<string, unknown>;
  };
}

/** Open the example host with a data prefix, and wait for the embed to announce itself. */
async function openHost(page: Page, data: string): Promise<Record<string, unknown>> {
  await page.goto(`/example/host.html?data=${encodeURIComponent(data)}`);
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

test.describe('the embed announces itself', () => {
  test('posts ready with WebGL2 capabilities on boot', async ({ page }) => {
    const ready = await openHost(page, '/none');
    expect(ready['version']).toBe(1);
    const caps = ready['caps'] as { webgl2: boolean; renderer?: string };
    expect(caps.webgl2).toBe(true);
    // §11's authority is SwiftShader; a developer's Mac reports ANGLE/Metal. Either is a string.
    expect(typeof caps.renderer).toBe('string');
    expect(caps.renderer?.length).toBeGreaterThan(0);
  });

  test('answers hello with the same ready', async ({ page }) => {
    await openHost(page, '/none');
    const reply = await send(page, { type: 'hello' });
    expect(reply['type']).toBe('ready');
    expect((reply['caps'] as { webgl2: boolean }).webgl2).toBe(true);
  });

  test('echoes the request id onto a reply', async ({ page }) => {
    await openHost(page, '/none');
    const reply = await send(page, { type: 'hello' });
    expect(typeof reply['id']).toBe('string');
  });

  test('ignores a message this build does not know', async ({ page }) => {
    await openHost(page, '/none');
    const before = await page.evaluate(
      () => (window as unknown as HostWindow).__host.events.length
    );
    await page.evaluate(() => {
      const frame = document.querySelector('iframe') as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ tvx: 1, type: 'teleport' }, '*');
      frame.contentWindow?.postMessage({ type: 'not-ours' }, '*');
    });
    await page.waitForTimeout(300);
    // Silence, not an error reply: an unknown type is forward compatibility, not a fault.
    expect(await page.evaluate(() => (window as unknown as HostWindow).__host.events.length)).toBe(
      before
    );
  });

  test('reports no-webgl2 when there is no context', async ({ page }) => {
    // `?forceWebgl2Null=1` is the shell's own switch for §8's error screen — the same state a
    // blocklisted driver produces (§1), without needing one.
    await page.goto(
      '/example/host.html?data=/none&embed=' + encodeURIComponent('../index.html?forceWebgl2Null=1')
    );
    await page.waitForFunction(
      () => (window as unknown as HostWindow).__host?.events.some((e) => e['type'] === 'ready'),
      undefined,
      { timeout: 60_000 }
    );
    const events = await page.evaluate(() => (window as unknown as HostWindow).__host.events);
    const ready = events.find((e) => e['type'] === 'ready');
    expect((ready?.['caps'] as { webgl2: boolean }).webgl2).toBe(false);
    const status = events.filter((e) => e['type'] === 'status');
    expect(status.some((s) => s['phase'] === 'no-webgl2')).toBe(true);
  });
});

test.describe('scenes', () => {
  test.skip(!hasData, 'TETRAVOX_TESTDATA is unset');

  test('(a) T1 + a heat field + a hidden LUT label volume, from ROOT-relative refs', async ({
    page,
  }) => {
    await openHost(page, DATA_ROOT_RELATIVE);
    const loaded = await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).__host;
      return host.send({ type: 'load', scene: host.SCENES['a'] }, true);
    });

    expect(loaded['type']).toBe('loaded');
    const datasets = loaded['datasets'] as { id: string; name: string; kind: string }[];
    const layers = loaded['layers'] as {
      id: string;
      name: string;
      kind: string;
      visible: boolean;
    }[];
    expect(datasets).toHaveLength(3);
    expect(datasets.map((d) => d.kind).sort()).toEqual(['volume', 'volume', 'volume']);
    expect(datasets.map((d) => d.name)).toContain('T1.nii.gz');
    expect(layers).toHaveLength(3);
    // The live ids, not the ids the host sent: `Engine.load` re-adds every dataset.
    expect(layers.map((l) => l.id)).not.toEqual(['l1', 'l2', 'l3']);
    // The third layer was sent `visible: false` and must have stayed hidden.
    expect(layers.filter((l) => l.visible)).toHaveLength(2);

    // The LUT sidecar resolved against the DATASET's URL and produced a label table.
    const tissues = layers[2];
    const probe = await send(page, { type: 'probe', world: [0, 0, 0] });
    expect(probe['type']).toBe('probe');
    const rows = (probe['result'] as { rows: unknown[] }).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(tissues?.name).toBeTruthy();
  });

  test('(b) T1 + a .msh coloured by elm field TI_max, from ABSOLUTE refs', async ({ page }) => {
    // The other half of the URL rule: a fully-qualified `http://…` ref, used as-is.
    const origin = new URL(page.url() || 'http://127.0.0.1', 'http://127.0.0.1').origin;
    await openHost(page, DATA_ROOT_RELATIVE);
    const absolute = await page.evaluate(() => location.origin);
    const loaded = await page.evaluate(async (base) => {
      const host = (window as unknown as HostWindow).__host;
      const scene = JSON.parse(JSON.stringify(host.SCENES['b'])) as {
        datasets: { path: string }[];
      };
      for (const d of scene.datasets) d.path = base + d.path;
      return host.send({ type: 'load', scene }, true);
    }, absolute || origin);

    expect(loaded['type']).toBe('loaded');
    const datasets = loaded['datasets'] as { name: string; kind: string }[];
    expect(datasets.map((d) => d.kind).sort()).toEqual(['mesh', 'volume']);
    const layers = loaded['layers'] as {
      kind: string;
      colorMode?: string;
      field?: { name: string };
      scale?: { kind: string; lo: number; hi: number };
    }[];
    const mesh = layers.find((l) => l.kind === 'mesh');
    expect(mesh?.colorMode).toBe('field');
    expect(mesh?.field?.name).toBe('TI_max');

    // The window was seeded from the field's own stats, not left at the engine's placeholder
    // `0..1` — a host cannot compute it, so the embed makes the call the property editor makes.
    const scale = mesh?.scale as { kind: string; lo: number; hi: number };
    expect(scale.kind).toBe('linear');
    expect(scale.hi).toBeLessThan(1);
    expect(scale.hi).toBeGreaterThan(scale.lo);

    // The cursor-following clip plane really follows: its offset moves with `setCursor`.
    await send(page, { type: 'setCursor', world: [-30, 39, 5] }, false);
    await page.waitForTimeout(500);
    const spec = (await send(page, { type: 'serialize' }))['spec'] as {
      layers: {
        kind: string;
        clip?: { planes: { plane: { offset: number }; enabled: boolean }[] };
      }[];
    };
    const clipped = spec.layers.find((l) => l.kind === 'mesh');
    expect(clipped?.clip?.planes[0]?.enabled).toBe(true);
    expect(clipped?.clip?.planes[0]?.plane.offset).not.toBe(0);
  });

  test('setCursor moves the crosshair and the host hears about it', async ({ page }) => {
    await openHost(page, DATA_ROOT_RELATIVE);
    await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).__host;
      await host.send({ type: 'load', scene: host.SCENES['a'] }, true);
    });
    await send(page, { type: 'setCursor', world: [-30, 39, 5] }, false);
    await page.waitForFunction(
      () =>
        (window as unknown as HostWindow).__host.events.some(
          (e) => e['type'] === 'cursor' && Math.abs((e['world'] as number[])[0]! + 30) < 0.01
        ),
      undefined,
      { timeout: 20_000 }
    );
    const cursor = await page.evaluate(() =>
      (window as unknown as HostWindow).__host.events.filter((e) => e['type'] === 'cursor').at(-1)
    );
    expect(cursor?.['world']).toEqual([-30, 39, 5]);
    expect(typeof cursor?.['space']).toBe('string');
  });

  test('probe answers with rows naming the loaded layers', async ({ page }) => {
    await openHost(page, DATA_ROOT_RELATIVE);
    await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).__host;
      await host.send({ type: 'load', scene: host.SCENES['a'] }, true);
    });
    const reply = await send(page, { type: 'probe', world: [-30, 39, 5] });
    const result = reply['result'] as { world: number[]; rows: { layerName: string }[] };
    expect(result.world).toEqual([-30, 39, 5]);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => typeof r.layerName === 'string')).toBe(true);
  });

  test('screenshot replies with a PNG data URL', async ({ page }) => {
    await openHost(page, DATA_ROOT_RELATIVE);
    await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).__host;
      await host.send({ type: 'load', scene: host.SCENES['a'] }, true);
    });
    const reply = await send(page, { type: 'screenshot', target: 'grid' });
    const dataUrl = reply['dataUrl'] as string;
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    // A real picture, not an empty canvas: base64 of a 1280-wide PNG is tens of kilobytes.
    expect(dataUrl.length).toBeGreaterThan(10_000);
  });

  test('serialize returns a complete ViewSpec whose refs are the loaded URLs', async ({ page }) => {
    await openHost(page, DATA_ROOT_RELATIVE);
    await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).__host;
      await host.send({ type: 'load', scene: host.SCENES['a'] }, true);
    });
    const reply = await send(page, { type: 'serialize' });
    const spec = reply['spec'] as {
      version: number;
      datasets: { path: string; absPath?: string }[];
      layers: unknown[];
      layout: unknown;
      view3d: unknown;
    };
    expect(spec.version).toBe(2);
    expect(spec.datasets).toHaveLength(3);
    expect(spec.layers).toHaveLength(3);
    expect(spec.layout).toBeTruthy();
    expect(spec.view3d).toBeTruthy();
    // Every ref points back at something fetchable.
    expect(spec.datasets.every((d) => (d.absPath ?? d.path).includes('/@fs/'))).toBe(true);
  });

  test('layer controls reach the scene, and reset unloads it', async ({ page }) => {
    await openHost(page, DATA_ROOT_RELATIVE);
    const loaded = await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).__host;
      return host.send({ type: 'load', scene: host.SCENES['a'] }, true);
    });
    const layers = loaded['layers'] as { id: string }[];
    const top = layers[1]!.id;

    await send(page, { type: 'setLayerVisible', layerId: top, visible: false }, false);
    await send(page, { type: 'setLayerOpacity', layerId: top, opacity: 0.25 }, false);
    await send(page, { type: 'updateLayer', layerId: top, patch: { colormap: 'viridis' } }, false);
    await page.waitForFunction(
      (id) => {
        const last = (window as unknown as HostWindow).__host.events
          .filter((e) => e['type'] === 'layers')
          .at(-1);
        const l = (last?.['layers'] as { id: string; colormap?: string }[] | undefined)?.find(
          (x) => x.id === id
        );
        return l?.colormap === 'viridis';
      },
      top,
      { timeout: 10_000 }
    );
    const after = await page.evaluate(() =>
      (window as unknown as HostWindow).__host.events.filter((e) => e['type'] === 'layers').at(-1)
    );
    const patched = (after?.['layers'] as { id: string; visible: boolean; opacity: number }[]).find(
      (l) => l.id === top
    );
    expect(patched?.visible).toBe(false);
    expect(patched?.opacity).toBeCloseTo(0.25, 5);

    await send(page, { type: 'reset' }, false);
    await page.waitForFunction(
      () => {
        const last = (window as unknown as HostWindow).__host.events
          .filter((e) => e['type'] === 'layers')
          .at(-1);
        return (last?.['layers'] as unknown[] | undefined)?.length === 0;
      },
      undefined,
      { timeout: 20_000 }
    );
  });

  test('a screenshot of the mounted embed, for the record', async ({ page }, testInfo) => {
    await openHost(page, DATA_ROOT_RELATIVE);
    await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).__host;
      await host.send({ type: 'load', scene: host.SCENES['b'] }, true);
    });
    await send(page, { type: 'setCursor', world: [-30, 39, 5] }, false);
    await page.waitForTimeout(2000);
    const out = process.env.TETRAVOX_EMBED_SHOT;
    await page.screenshot({ path: out ?? testInfo.outputPath('embed-mounted.png') });
  });
});
