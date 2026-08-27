/**
 * The §6.5 envelope itself, over the real worker: progress, cancel, latest-wins, transfer
 * bookkeeping, handle lifetime and `heapBytes`.
 *
 * `compute-client.test.ts` asserts the same rules against a fake worker, where every reply is
 * scripted. This file asserts them against the module `pnpm wasm` built, where they are not.
 */

import { expect, test } from '@playwright/test';

import { CAPS_FULL, call, fixtureUrl, must, open } from './fixtures';

const VOLUME = { kind: 'url' as const, url: fixtureUrl('vol_f32.nii.gz') };
const MESH = { kind: 'url' as const, url: fixtureUrl('mesh_v2_binary.msh') };

test.beforeEach(async ({ page }) => {
  await open(page);
});

test('a load reports progress, and its phases are §6.5 phases', async ({ page }) => {
  const out = await must(page, 'loadVolume', {
    source: VOLUME,
    caps: CAPS_FULL,
    wantLinear: true,
  });
  expect(out.progress.length).toBeGreaterThan(0);

  const phases = new Set(out.progress.map((p) => p.phase));
  const legal = new Set(['read', 'inflate', 'parse', 'topology', 'index', 'upload']);
  for (const phase of phases) expect(legal, `phase ${phase}`).toContain(phase);

  expect(phases).toContain('parse');

  // Every Progress carries its request's own id (§6.5).
  const ids = new Set(out.progress.map((p) => p.id));
  expect(ids.size).toBe(1);
  for (const p of out.progress) {
    expect(p.done).toBeGreaterThanOrEqual(0);
    if (p.total > 0) expect(p.done).toBeLessThanOrEqual(p.total);
  }
});

test('the streaming gunzip runs on real gzip bytes, and never twice (§5 rule 4)', async ({
  page,
}) => {
  // Measured on this very dev server: vite's static middleware answers a request for
  // `vol_f32.nii.gz` with `Content-Encoding: gzip`, so `fetch` inflates it before the worker sees a
  // byte. Feeding that to `DecompressionStream('gzip')` a second time would fail on perfectly good
  // data — which is why the worker peeks the gzip magic before piping. Both halves are asserted
  // here: the guard over the live transport, and the real gunzip over bytes that really are gzip.
  const outcome = await page.evaluate(async (url) => {
    window.__tvx.open();
    const caps = { floatLinear: true, norm16: true, max3d: 2048 };

    const overHttp = await window.__tvx.call('loadVolume', {
      source: { kind: 'url', url },
      caps,
      wantLinear: true,
    });

    // Re-gzip in the page, so the `bytes` source really does start with `1f 8b`.
    const plain = await (await fetch(url)).arrayBuffer();
    const gzipped = await new Response(
      new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();
    window.__tvx.open();
    const overGzip = await window.__tvx.call('loadVolume', {
      source: { kind: 'bytes', name: 'vol_f32.nii.gz', bytes: gzipped },
      caps,
      wantLinear: true,
    });
    return { overHttp, overGzip, plainBytes: plain.byteLength, gzipBytes: gzipped.byteLength };
  }, fixtureUrl('vol_f32.nii.gz'));

  expect(outcome.gzipBytes).toBeLessThan(outcome.plainBytes);
  expect(outcome.overHttp.ok).toBe(true);
  expect(outcome.overGzip.ok).toBe(true);

  const httpPhases = new Set(outcome.overHttp.progress.map((p) => p.phase));
  const gzipPhases = new Set(outcome.overGzip.progress.map((p) => p.phase));
  expect(httpPhases, 'the transport already decoded it, so nothing was inflated').not.toContain(
    'inflate'
  );
  expect(gzipPhases, 'genuine gzip bytes go through DecompressionStream').toContain('inflate');

  // Same volume either way, to the last statistic.
  const a = (outcome.overHttp.result?.meta as Record<string, unknown>).stats as Record<
    string,
    number
  >;
  const b = (outcome.overGzip.result?.meta as Record<string, unknown>).stats as Record<
    string,
    number
  >;
  expect(b.min).toBe(a.min);
  expect(b.max).toBe(a.max);
  expect(b.mean).toBe(a.mean);
});

test('a mesh load reports progress too', async ({ page }) => {
  const out = await must(page, 'loadMesh', { source: MESH, format: 'auto' });
  expect(out.progress.length).toBeGreaterThan(0);
  expect(new Set(out.progress.map((p) => p.phase))).toContain('parse');
});

test('every buffer in a result is transferred, not copied (§6.4)', async ({ page }) => {
  await must(page, 'loadVolume', { source: VOLUME, caps: CAPS_FULL, wantLinear: true });
  // `data`, `gpuBytes` and the stats histogram at the very least.
  const moved = await page.evaluate(() => window.__tvx.transfers());
  expect(moved).toBeGreaterThanOrEqual(3);
  // …and they arrived attached, which a detached (double-transferred) buffer would not be.
  expect(await page.evaluate(() => window.__tvx.buffersAttached())).toBe(true);
});

test('a result with no bulk arrays transfers nothing', async ({ page }) => {
  const load = await must(page, 'loadMesh', { source: MESH, format: 'auto' });
  const handle = (load.result?.meta as { handle: number }).handle;
  await must(page, 'free', { handle });
  expect(await page.evaluate(() => window.__tvx.transfers())).toBe(0);
});

test('latest-wins drops the queued request and the newest survives (§5 rule 6)', async ({
  page,
}) => {
  const outcome = await page.evaluate(async (url) => {
    window.__tvx.open();
    const load = await window.__tvx.call('loadMesh', {
      source: { kind: 'url', url },
      format: 'auto',
    });
    const handle = (load.result?.meta as { handle: number }).handle;

    // Three `field` calls on one key, back to back: the first goes in flight, the second is queued,
    // the third supersedes it.
    const first = window.__tvx.start(
      'field',
      { handle, source: 'elm', name: 'E', component: 'mag' },
      'k'
    );
    const stale = window.__tvx.start(
      'field',
      { handle, source: 'elm', name: 'no-such-field', component: 'mag' },
      'k'
    );
    const fresh = await window.__tvx.call(
      'field',
      { handle, source: 'elm', name: 'elm_scalar', component: 'mag' },
      'k'
    );
    return { first, stale, fresh };
  }, fixtureUrl('mesh_v2_binary.msh'));

  // The superseded request never reached the worker, so its bogus field name never produced an
  // error: it was dropped in the client's queue.
  expect(outcome.stale).toBeGreaterThan(outcome.first);
  expect(outcome.fresh.ok).toBe(true);
  expect((outcome.fresh.result?.values as { length: number }).length).toBe(104);
});

test('cancelling a queued request settles it as `cancelled` and the worker survives', async ({
  page,
}) => {
  const outcome = await page.evaluate(async (url) => {
    window.__tvx.open();
    const load = await window.__tvx.call('loadMesh', {
      source: { kind: 'url', url },
      format: 'auto',
    });
    const handle = (load.result?.meta as { handle: number }).handle;
    // Queue two behind one in-flight request and cancel the tail.
    window.__tvx.start('field', { handle, source: 'elm', name: 'E', component: 'mag' }, 'a');
    const doomed = window.__tvx.start(
      'field',
      { handle, source: 'elm', name: 'E', component: 'mag' },
      'b'
    );
    window.__tvx.cancel(doomed);
    const settled = await window.__tvx.settle();
    const after = await window.__tvx.call(
      'field',
      { handle, source: 'node', name: 'node_scalar', component: 'mag' },
      'c'
    );
    return { settled, after, alive: window.__tvx.alive() };
  }, fixtureUrl('mesh_v2_binary.msh'));

  expect(outcome.settled).toMatchObject({ ok: false, code: 'cancelled' });
  expect(outcome.alive).toBe(true);
  expect(outcome.after.ok).toBe(true);
  expect((outcome.after.result?.values as { length: number }).length).toBe(27);
});

test('cancelling an in-flight load terminates the worker (§5 rule 6)', async ({ page }) => {
  const outcome = await page.evaluate(async (url) => {
    window.__tvx.open();
    const id = window.__tvx.start('loadMesh', { source: { kind: 'url', url }, format: 'auto' });
    window.__tvx.cancel(id);
    const settled = await window.__tvx.settle();
    return { settled, alive: window.__tvx.alive() };
  }, fixtureUrl('mesh_v2_binary.msh'));

  expect(outcome.settled).toMatchObject({ ok: false, code: 'cancelled' });
  // Terminate is the only mechanism, so the client is dead afterwards and the engine must open a
  // new worker for that dataset.
  expect(outcome.alive).toBe(false);
});

test('a stale handle is `parse`, never a silent wrong answer (§6.5)', async ({ page }) => {
  const load = await must(page, 'loadVolume', {
    source: VOLUME,
    caps: CAPS_FULL,
    wantLinear: true,
  });
  const handle = (load.result?.meta as { handle: number }).handle;
  await must(page, 'free', { handle });

  const after = await call(page, 'volumeFrame', {
    handle,
    volumeIndex: 0,
    caps: CAPS_FULL,
    wantLinear: true,
  });
  expect(after.ok).toBe(false);
  expect(after.error?.code).toBe('parse');
  expect(after.error?.message).toMatch(/handle/);
});

test('a stale maskId is `parse`, and freeMask is idempotent (§6.5)', async ({ page }) => {
  const load = await must(page, 'loadMesh', { source: MESH, format: 'auto' });
  const handle = (load.result?.meta as { handle: number }).handle;

  const surface = await call(page, 'surface', { handle, variant: 'indexed', maskId: 99 });
  expect(surface.ok).toBe(false);
  expect(surface.error?.code).toBe('parse');
  expect(surface.error?.message).toMatch(/mask 99/);

  // Freeing a mask that was never live must not poison the module: the client frees eagerly on
  // every isolation change (§6.5).
  await must(page, 'freeMask', { handle, maskId: 99 });
  const still = await must(page, 'field', {
    handle,
    source: 'elm',
    name: 'elm_scalar',
    component: 'mag',
  });
  expect((still.result?.values as { length: number }).length).toBe(104);
});

test('heapBytes is stamped on every successful Res and only ever grows (§9.2)', async ({
  page,
}) => {
  const first = await must(page, 'loadVolume', {
    source: VOLUME,
    caps: CAPS_FULL,
    wantLinear: true,
  });
  expect(first.heapBytes).toBeGreaterThan(0);
  // wasm32 linear memory is a whole number of 64 KiB pages, and it grows and never shrinks.
  expect(first.heapBytes % 65_536).toBe(0);

  const handle = (first.result?.meta as { handle: number }).handle;
  const frame = await must(page, 'volumeFrame', {
    handle,
    volumeIndex: 0,
    caps: CAPS_FULL,
    wantLinear: true,
  });
  expect(frame.heapBytes).toBeGreaterThanOrEqual(first.heapBytes);

  await must(page, 'free', { handle });
  const afterFree = await page.evaluate(() => window.__tvx.heapBytes());
  // `free(handle)` does not give RSS back — that is exactly why §5 mandates worker-per-dataset
  // with `terminate()`.
  expect(afterFree).toBeGreaterThanOrEqual(first.heapBytes);
});

test('the module is instantiated once and serves many ops on one worker', async ({ page }) => {
  const load = await must(page, 'loadMesh', { source: MESH, format: 'auto' });
  const handle = (load.result?.meta as { handle: number }).handle;
  for (const component of ['mag', 0, 1, 2] as const) {
    const out = await must(page, 'field', { handle, source: 'elm', name: 'E', component });
    const v = out.result?.values as { length: number };
    expect(v.length, `component ${String(component)}`).toBe(104);
  }
  // A component past `ncomp` is a parse error, not a silently wrong column.
  const load2 = await call(page, 'field', {
    handle,
    source: 'elm',
    name: 'elm_scalar',
    component: 2,
  });
  expect(load2.ok).toBe(false);
  expect(load2.error?.code).toBe('parse');
});
