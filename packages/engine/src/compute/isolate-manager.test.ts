/**
 * `IsolateManager` against a **fake worker client**.
 *
 * §6.5.2: "The client owns `maskId` and must `freeMask`." Every test here is about that sentence —
 * who frees which mask, and when. A leaked mask is invisible until a long session runs out of
 * worker memory, and a mask freed too early is a frame with no geometry.
 */

import { describe, expect, it } from 'vitest';
import type { IsolateCriteriaT, OpArgs, OpResult } from '@tetravox/protocol';
import { IsolateManager } from './isolate-manager';
import type { IsolateClient, IsolateState } from './isolate-manager';

const GREY: IsolateCriteriaT = { tags: [2], combine: 'all' } as IsolateCriteriaT;
const WHITE: IsolateCriteriaT = { tags: [1], combine: 'all' } as IsolateCriteriaT;

type Call =
  { op: 'isolate'; args: OpArgs['isolate'] } | { op: 'freeMask'; args: OpArgs['freeMask'] };

class FakeIsolateClient implements IsolateClient {
  readonly calls: Call[] = [];
  readonly #pending: ((r: OpResult['isolate']) => void)[] = [];

  call(key: string, op: 'isolate', args: OpArgs['isolate']): Promise<OpResult['isolate']>;
  call(key: string, op: 'freeMask', args: OpArgs['freeMask']): Promise<OpResult['freeMask']>;
  call(
    _key: string,
    op: 'isolate' | 'freeMask',
    args: OpArgs['isolate'] | OpArgs['freeMask']
  ): Promise<OpResult['isolate'] | OpResult['freeMask']> {
    if (op === 'freeMask') {
      this.calls.push({ op, args: args as OpArgs['freeMask'] });
      return Promise.resolve({});
    }
    this.calls.push({ op, args: args as OpArgs['isolate'] });
    return new Promise<OpResult['isolate']>((resolve) => this.#pending.push(resolve));
  }

  async settle(i: number, result: OpResult['isolate']): Promise<void> {
    (this.#pending[i] as (r: OpResult['isolate']) => void)(result);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  get freed(): number[] {
    return this.calls.filter((c) => c.op === 'freeMask').map((c) => c.args.maskId);
  }
}

describe('IsolateManager', () => {
  it('carries `maskId` and `generation` into the §7.4 cache key', async () => {
    const client = new FakeIsolateClient();
    const m = new IsolateManager(client, 3, 'ds1:isolate');
    expect(m.maskId()).toBeUndefined();
    expect(m.cacheKey()).toBe('');

    const done = m.isolate(GREY);
    await client.settle(0, { maskId: 11, visibleTets: 1_340_029, generation: 1 });
    await done;

    expect(m.maskId()).toBe(11);
    expect(m.current()?.visibleTets).toBe(1_340_029);
    // §6.5.2's `generation` is in the key so "a re-isolation to a numerically identical mask still
    // invalidates cached geometry".
    expect(m.cacheKey()).toBe('11|1');
  });

  it('frees the previous mask **after** the new one lands, never before', async () => {
    const client = new FakeIsolateClient();
    const m = new IsolateManager(client, 3, 'k');

    const first = m.isolate(GREY);
    await client.settle(0, { maskId: 11, visibleTets: 10, generation: 1 });
    await first;
    expect(client.freed).toEqual([]);

    const second = m.isolate(WHITE);
    // Still nothing freed while the second is in flight: the old geometry is what is on screen.
    expect(client.freed).toEqual([]);
    await client.settle(1, { maskId: 12, visibleTets: 20, generation: 2 });
    await second;

    expect(client.freed).toEqual([11]);
    expect(m.maskId()).toBe(12);
  });

  it('frees the mask of a superseded isolation rather than leaking it', async () => {
    const client = new FakeIsolateClient();
    const m = new IsolateManager(client, 3, 'k');

    const stale = m.isolate(GREY);
    const fresh = m.isolate(WHITE);
    // The newer call lands first; the older one then returns a mask nobody will ever use.
    await client.settle(1, { maskId: 22, visibleTets: 5, generation: 2 });
    await fresh;
    await client.settle(0, { maskId: 21, visibleTets: 9, generation: 1 });
    await stale;

    expect(m.maskId()).toBe(22);
    expect(client.freed).toEqual([21]);
  });

  it('`clear` drops the isolation and frees its mask', async () => {
    const client = new FakeIsolateClient();
    const m = new IsolateManager(client, 3, 'k');
    const seen: (IsolateState | null)[] = [];
    m.subscribe((s) => seen.push(s));

    const done = m.isolate(GREY);
    await client.settle(0, { maskId: 11, visibleTets: 10, generation: 1 });
    await done;
    await m.clear();

    expect(m.current()).toBeNull();
    expect(m.maskId()).toBeUndefined();
    expect(client.freed).toEqual([11]);
    expect(seen.map((s) => s?.maskId ?? null)).toEqual([11, null]);
  });

  it('passes `labelVolume` through as a plain argument — §5 rule 2 forbids transferring it', async () => {
    const client = new FakeIsolateClient();
    const m = new IsolateManager(client, 3, 'k');
    const samples = new ArrayBuffer(64);
    void m.isolate(
      {
        ...GREY,
        labelVolume: {
          dims: [4, 4, 4],
          worldToVoxel: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          dtype: 'u8',
          volumeIndex: 0,
          labels: [2],
        },
      },
      samples
    );
    const call = client.calls[0];
    expect(call?.op).toBe('isolate');
    expect(call?.op === 'isolate' && call.args.labelVolume).toBe(samples);
    // The buffer must still be usable afterwards: a transfer would have detached it and broken every
    // subsequent probe on that volume.
    expect(samples.byteLength).toBe(64);
  });

  it('dispose stops applying results and gives back every mask it owns', async () => {
    const client = new FakeIsolateClient();
    const m = new IsolateManager(client, 3, 'k');
    const first = m.isolate(GREY);
    await client.settle(0, { maskId: 11, visibleTets: 10, generation: 1 });
    await first;

    const late = m.isolate(WHITE);
    m.dispose();
    await client.settle(1, { maskId: 12, visibleTets: 20, generation: 2 });
    await late;

    expect(m.current()).toBeNull();
    // Both: the one that was in force, and the one that landed after dispose. `dispose` also runs
    // from `removeLayer`, which leaves the worker alive — not freeing would leak there.
    expect(client.freed.sort()).toEqual([11, 12]);
  });
});
