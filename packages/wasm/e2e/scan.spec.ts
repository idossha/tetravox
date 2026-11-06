/**
 * §6.3.1's scan through the real worker: every streamline of a thinned dataset, other ops answering
 * between chunks, and a session that closing frees. Expected totals come from a raw float32 read of
 * the `.tck` here, not from the parser. Real data, gated on `TETRAVOX_TRACT_TESTDATA=<Dataset 000>`:
 * `scripts/refvalues/tract_refvalues.json`, and the wall time and heap the handoff asks for.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { ArraySummary, CallOutcome } from './fixtures';
import { call, fixtureUrl, fsUrl, must, open } from './fixtures';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SMALL = `${REPO}testdata/mrtrix_small.tck`;

function rawTck(path: string): { streamlines: number; points: number; sumXyz: number } {
  const bytes = readFileSync(path);
  const head = bytes.subarray(0, 4096).toString('latin1');
  const offset = Number(/^file: \. (\d+)$/m.exec(head)?.[1]);
  let streamlines = 0;
  let points = 0;
  let sumXyz = 0;
  for (let at = offset; at + 12 <= bytes.length; at += 12) {
    const x = bytes.readFloatLE(at);
    if (!Number.isFinite(x)) {
      if (Number.isNaN(x)) streamlines += 1;
      else break;
    } else {
      points += 1;
      sumXyz += x + bytes.readFloatLE(at + 4) + bytes.readFloatLE(at + 8);
    }
  }
  return { streamlines, points, sumXyz };
}

interface Chunk {
  firstSource: number;
  offsets: ArraySummary;
  positions: ArraySummary;
  streamlineFields: Record<string, ArraySummary>;
  vertexFields: Record<string, ArraySummary>;
}

async function load(page: Page, url: string, maxPoints: number | null): Promise<number> {
  const out = await must(page, 'loadTractogram', {
    source: { kind: 'url', url },
    format: 'tck',
    maxPoints,
    seed: 1,
  });
  return (out.result?.meta as { handle: number }).handle;
}

test.beforeEach(async ({ page }) => {
  await open(page);
});

test('a thinned dataset scans whole, and probe, style and points answer between chunks', async ({
  page,
}) => {
  const want = rawTck(SMALL);
  expect(want.streamlines, 'scripts/reference/make_mrtrix_fixtures.sh asks for 40').toBe(40);
  const handle = await load(page, fixtureUrl('mrtrix_small.tck'), 20);
  const opened = await must(page, 'tractScanOpen', {
    handle,
    source: { kind: 'url', url: fixtureUrl('mrtrix_small.tck') },
    format: 'tck',
    fields: ['length_mm', 'mrtrix_small_fa_mean'],
    sidecars: [{ kind: 'url', url: fixtureUrl('mrtrix_small_fa_mean.txt') }],
    chunkPoints: 200,
  });
  const scan = (opened.result as { scan: number }).scan;

  let streamlines = 0;
  let points = 0;
  let sumXyz = 0;
  let chunks = 0;
  let done: { streamlines: number; points: number } | undefined;
  while (done === undefined) {
    const next = await must(page, 'tractScanNext', { scan });
    done = next.result?.['done'] as typeof done;
    const chunk = next.result?.['chunk'] as Chunk | undefined;
    if (chunk === undefined) continue;
    chunks += 1;
    expect(chunk.firstSource).toBe(streamlines);
    streamlines += chunk.offsets.length - 1;
    points += chunk.positions.length / 3;
    sumXyz += chunk.positions.sum;
    expect(chunk.streamlineFields['length_mm']?.length).toBe(chunk.offsets.length - 1);
    expect(chunk.streamlineFields['mrtrix_small_fa_mean']?.length).toBe(chunk.offsets.length - 1);
    // Interleaved on the same worker, each between two chunks.
    const probe = await must(page, 'tractProbe', { handle, world: [0, 0, 0], radiusMm: 1000 });
    expect(probe.result?.['hit']).not.toBeNull();
    await must(page, 'tractStyle', { handle, spec: {} });
    await must(page, 'tractPoints', { handle, first: 0, count: 1, tangents: false });
  }
  expect(chunks).toBeGreaterThan(1);
  expect(done).toEqual({ streamlines: want.streamlines, points: want.points });
  expect(streamlines).toBe(want.streamlines);
  expect(points).toBe(want.points);
  // The harness's `sum` adds every coordinate.
  expect(sumXyz).toBeCloseTo(want.sumXyz, 0);
  const after = await call(page, 'tractScanNext', { scan });
  expect(after.ok, 'a finished session is gone').toBe(false);
});

const openScan = async (page: Page, handle: number, fields: string[] = []): Promise<CallOutcome> =>
  call(page, 'tractScanOpen', {
    handle,
    source: { kind: 'url', url: fixtureUrl('mrtrix_small.tck') },
    format: 'tck',
    fields,
    sidecars: [],
    chunkPoints: 200,
  });

test('closing frees the session, freeing the dataset closes it, and neither kills the worker', async ({
  page,
}) => {
  const handle = await load(page, fixtureUrl('mrtrix_small.tck'), null);
  const closed = (await openScan(page, handle)).result as { scan: number };
  await must(page, 'tractScanNext', { scan: closed.scan });
  await must(page, 'tractScanClose', { scan: closed.scan });
  const gone = await call(page, 'tractScanNext', { scan: closed.scan });
  expect(gone.error?.code).toBe('cancelled');
  await must(page, 'tractProbe', { handle, world: [0, 0, 0], radiusMm: 1000 });

  const freed = (await openScan(page, handle)).result as { scan: number };
  await must(page, 'free', { handle });
  const after = await call(page, 'tractScanNext', { scan: freed.scan });
  expect(after.error?.code).toBe('cancelled');
  await load(page, fixtureUrl('mrtrix_small.tck'), null);
});

test('a gzipped file in memory scans whole, in bounded pieces of its one big chunk', async ({
  page,
}) => {
  const want = rawTck(SMALL);
  const got = await page.evaluate(async (url) => {
    const raw = await (await fetch(url)).blob();
    const gz = raw.stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = await new Response(gz).arrayBuffer();
    const source = { kind: 'bytes' as const, name: 'small.tck.gz', bytes };
    const loaded = await window.__tvx.call('loadTractogram', {
      source,
      format: 'tck',
      maxPoints: 20,
      seed: 1,
    });
    const handle = (loaded.result?.['meta'] as { handle: number }).handle;
    const opened = await window.__tvx.call('tractScanOpen', {
      handle,
      source,
      format: 'tck',
      fields: [],
      sidecars: [],
      chunkPoints: 200,
    });
    const scan = (opened.result as { scan: number }).scan;
    for (;;) {
      const next = await window.__tvx.call('tractScanNext', { scan });
      if (next.result?.['done'] !== undefined) return next.result['done'];
    }
  }, fixtureUrl('mrtrix_small.tck'));
  expect(got).toEqual({ streamlines: want.streamlines, points: want.points });
});

test('a requested field that cannot be delivered rejects by name, and the worker lives', async ({
  page,
}) => {
  const handle = await load(page, fixtureUrl('mrtrix_small.tck'), null);
  const { scan } = (await openScan(page, handle, ['nope'])).result as { scan: number };
  const refused = await call(page, 'tractScanNext', { scan });
  expect(refused.ok).toBe(false);
  expect(refused.error?.code).toBe('parse');
  expect(refused.error?.message).toContain('nope');
  await must(page, 'tractScanClose', { scan });
  await must(page, 'tractProbe', { handle, world: [0, 0, 0], radiusMm: 1000 });
});

// The low budget is what lets the heap show the scan's own working set: a default load's freed
// memory could hide it.
for (const budget of [8_000_000, 100_000]) {
  test(`the real 200k TCK at budget ${budget}: every streamline, heap independent of the file`, async ({
    page,
  }) => {
    const root = process.env['TETRAVOX_TRACT_TESTDATA'];
    test.skip(root === undefined, 'TETRAVOX_TRACT_TESTDATA is unset');
    const refs = JSON.parse(
      readFileSync(`${REPO}scripts/refvalues/tract_refvalues.json`, 'utf8')
    ) as {
      tck_200k: { streamlines: number; points: number };
    };
    const mr = `${root!}/derivatives/ti-toolbox/tract_validation/mrtrix_ref`;
    const url = fsUrl(`${mr}/tracks_ifod2_200k.tck`);
    const handle = await load(page, url, budget);
    const before = await must(page, 'tractProbe', { handle, world: [0, 0, 0], radiusMm: 1 });
    const started = Date.now();
    const opened = await must(page, 'tractScanOpen', {
      handle,
      source: { kind: 'url', url },
      format: 'tck',
      fields: ['sift2_weights'],
      sidecars: [{ kind: 'url', url: fsUrl(`${mr}/sift2_weights.txt`) }],
      chunkPoints: 1_000_000,
    });
    const scan = (opened.result as { scan: number }).scan;
    let heap = opened.heapBytes;
    let peakChunk = 0;
    let done: { streamlines: number; points: number } | undefined;
    while (done === undefined) {
      const next = await must(page, 'tractScanNext', { scan });
      heap = Math.max(heap, next.heapBytes);
      done = next.result?.['done'] as typeof done;
      const chunk = next.result?.['chunk'] as Chunk | undefined;
      if (chunk !== undefined) peakChunk = Math.max(peakChunk, chunk.positions.length / 3);
    }
    const elapsedMs = Date.now() - started;
    console.log(
      `scan 200k, budget ${budget}: ${elapsedMs} ms, wasm heap ${(before.heapBytes / 2 ** 20).toFixed(0)} MiB loaded, ` +
        `${(heap / 2 ** 20).toFixed(0)} MiB peak, largest chunk ${peakChunk} points`
    );
    expect(done).toEqual({ streamlines: refs.tck_200k.streamlines, points: refs.tck_200k.points });
    expect(peakChunk).toBeLessThan(1_100_000);
    // One chunk's working set and 4 MB of weights, against the 394 MB the whole file would need.
    expect(heap - before.heapBytes).toBeLessThan(64 * 2 ** 20);
  });
}
