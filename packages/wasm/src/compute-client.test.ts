/**
 * The §6.5 client scheduler, against a fake worker.
 *
 * Everything asserted here is a rule from §5 rule 6 / §6.5's lifecycle list that no type can
 * enforce: which request a latest-wins key drops, what `cancel` does to an in-flight call depending
 * on its op, that `Req.args` never ride a transfer list, and that a poisoned module is never called
 * into again. The fake worker records the exact `postMessage` argument count, because "no transfer
 * list" is the difference between a probe array that still works and one that is detached (§5
 * rule 2).
 */

import type { Cancel, FromWorker, OpArgs, OpName, Req, Res, ToWorker } from '@tetravox/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ComputeClient } from './compute-client';

interface Post {
  message: ToWorker;
  /** How many arguments `postMessage` was called with. 2 means a transfer list was passed. */
  argCount: number;
}

class FakeWorker {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  readonly posts: Post[] = [];
  terminated = 0;

  postMessage(message: ToWorker, ...rest: unknown[]): void {
    this.posts.push({ message, argCount: rest.length + 1 });
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Deliver a message from the worker, the way a real `MessageEvent` would. */
  deliver(message: FromWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }

  ok<K extends OpName>(id: number, op: K, result: unknown, heapBytes = 1024): void {
    this.deliver({
      id,
      op,
      ok: true,
      result,
      transfer: [],
      heapBytes,
    } as unknown as Res<K>);
  }

  fail(id: number, op: OpName, code: Res extends never ? never : string, message = 'x'): void {
    this.deliver({
      id,
      op,
      ok: false,
      error: { code, message },
    } as unknown as Res);
  }

  requests(): Req[] {
    return this.posts.map((p) => p.message).filter((m): m is Req => !('kind' in m));
  }

  cancels(): Cancel[] {
    return this.posts
      .map((p) => p.message)
      .filter((m): m is Cancel => 'kind' in m && m.kind === 'cancel');
  }
}

function field(name = 'E'): OpArgs['field'] {
  return { handle: 1, source: 'elm', name, component: 'mag' };
}
function contours(offset = 0): OpArgs['contours'] {
  return { handle: 1, plane: { normal: [0, 0, 1], offset } };
}
function loadMesh(): OpArgs['loadMesh'] {
  return { source: { kind: 'bytes', name: 'm.msh', bytes: new ArrayBuffer(4) }, format: 'auto' };
}

function make(): { fake: FakeWorker; client: ComputeClient; poisoned: ReturnType<typeof vi.fn> } {
  const fake = new FakeWorker();
  const poisoned = vi.fn();
  const client = new ComputeClient({
    worker: fake as unknown as Worker,
    onPoisoned: poisoned,
  });
  return { fake, client, poisoned };
}

describe('latest-wins (§5 rule 6)', () => {
  let fake: FakeWorker;
  let client: ComputeClient;

  beforeEach(() => {
    ({ fake, client } = make());
  });

  it('drops the QUEUED request with the same key and keeps the newest', async () => {
    const inFlight = client.start('layer:field', 'field', field());
    const stale = client.start('layer:field', 'field', field('stale'));
    const fresh = client.start('layer:field', 'field', field('fresh'));

    await expect(stale.promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.cancels().map((c) => c.id)).toEqual([stale.id]);

    // Only the in-flight request has been posted so far: the client holds the queue itself, which
    // is the only way "queued" and "in flight" are distinguishable at all.
    expect(fake.requests().map((r) => r.id)).toEqual([inFlight.id]);

    fake.ok(inFlight.id, 'field', { values: new Float32Array(0), n: 0, partial: false });
    await inFlight.promise;
    expect(fake.requests().map((r) => r.id)).toEqual([inFlight.id, fresh.id]);
  });

  it('never drops the in-flight request, whatever arrives behind it', async () => {
    const inFlight = client.start('layer:cut', 'contours', contours());
    client.start('layer:cut', 'contours', contours(1));
    expect(fake.cancels()).toEqual([]);
    fake.ok(inFlight.id, 'contours', { segments: new Float32Array(6) });
    await expect(inFlight.promise).resolves.toMatchObject({ segments: expect.anything() });
  });

  it('leaves a different key alone', async () => {
    const a = client.start('a', 'contours', contours());
    const b = client.start('b', 'contours', contours());
    const c = client.start('c', 'contours', contours());
    expect(fake.cancels()).toEqual([]);
    expect(client.queuedCount).toBe(2);
    fake.ok(a.id, 'contours', { segments: new Float32Array(0) });
    await a.promise;
    fake.ok(b.id, 'contours', { segments: new Float32Array(0) });
    await b.promise;
    fake.ok(c.id, 'contours', { segments: new Float32Array(0) });
    await c.promise;
    expect(fake.requests().map((r) => r.id)).toEqual([a.id, b.id, c.id]);
  });

  it('serialises: exactly one request is outstanding in the worker at a time', async () => {
    const ids = ['a', 'b', 'c', 'd'].map((k) => client.start(k, 'contours', contours()));
    expect(fake.requests()).toHaveLength(1);
    for (const p of ids) {
      expect(fake.requests()).toHaveLength(ids.indexOf(p) + 1);
      fake.ok(p.id, 'contours', { segments: new Float32Array(0) });
      await p.promise;
    }
  });
});

describe('cancel (§5 rule 6, §6.5 lifecycle)', () => {
  it('drops a queued request without touching the worker', async () => {
    const { fake, client } = make();
    const inFlight = client.start('a', 'contours', contours());
    const queued = client.start('b', 'contours', contours());
    client.cancel(queued.id);
    await expect(queued.promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.terminated).toBe(0);
    expect(fake.cancels().map((c) => c.id)).toEqual([queued.id]);
    fake.ok(inFlight.id, 'contours', { segments: new Float32Array(0) });
    await expect(inFlight.promise).resolves.toBeTruthy();
  });

  it('terminates the worker for an in-flight loadMesh, and never for anything else', async () => {
    const { fake, client } = make();
    const load = client.start('ds', 'loadMesh', loadMesh());
    client.cancel(load.id);
    expect(fake.terminated).toBe(1);
    expect(client.alive).toBe(false);
    await expect(load.promise).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('lets an in-flight non-load op run to completion and discards its result', async () => {
    const { fake, client } = make();
    const p = client.start('a', 'contours', contours());
    client.cancel(p.id);
    expect(fake.terminated).toBe(0);
    expect(fake.cancels().map((c) => c.id)).toEqual([p.id]);

    // The worker answers anyway — WASM is not preemptible — and the answer is thrown away.
    fake.ok(p.id, 'contours', { segments: new Float32Array(6) }, 4096);
    await expect(p.promise).rejects.toMatchObject({ code: 'cancelled' });
    // …but its heapBytes still counted: the memory really did move (§9.2).
    expect(client.heapBytes).toBe(4096);
  });

  it('settles everything still outstanding when the worker is torn down', async () => {
    const { client } = make();
    const load = client.start('ds', 'loadVolume', {
      source: { kind: 'bytes', name: 'v.nii', bytes: new ArrayBuffer(4) },
      caps: { floatLinear: true, norm16: true, max3d: 2048 },
      wantLinear: true,
    });
    const behind = client.start('other', 'contours', contours());
    client.cancel(load.id);
    await expect(load.promise).rejects.toMatchObject({ code: 'cancelled' });
    await expect(behind.promise).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects a call made after the worker is gone rather than hanging', async () => {
    const { client } = make();
    client.terminate();
    await expect(client.call('a', 'contours', contours())).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});

describe('transfer bookkeeping (§5 rule 2)', () => {
  it('posts every Req with no transfer list at all', () => {
    const { fake, client } = make();
    const label = new ArrayBuffer(64);
    client
      .call('m:isolate', 'isolate', {
        handle: 3,
        criteria: { tags: [2], combine: 'all' },
        labelVolume: label,
      })
      .catch(() => {
        /* never answered by this fake worker */
      });
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]?.argCount).toBe(1);
    // Structured-cloned, not transferred: the UI thread's `VolumeDataset.data` is still readable.
    expect(label.byteLength).toBe(64);
  });

  it('posts a Cancel with no transfer list either', async () => {
    const { fake, client } = make();
    client.start('a', 'contours', contours());
    const queued = client.start('b', 'contours', contours());
    client.cancel(queued.id);
    await expect(queued.promise).rejects.toMatchObject({ code: 'cancelled' });
    for (const p of fake.posts) expect(p.argCount).toBe(1);
  });
});

describe('poisoning (§5 rule 8) and heapBytes (§6.5)', () => {
  it('tears the worker down on a panic and never calls into it again', async () => {
    const { fake, client, poisoned } = make();
    const p = client.start('a', 'contours', contours());
    const behind = client.start('b', 'contours', contours());
    fake.fail(p.id, 'contours', 'panic', 'unreachable');
    await expect(p.promise).rejects.toMatchObject({ code: 'panic' });
    await expect(behind.promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.terminated).toBe(1);
    expect(client.alive).toBe(false);
    expect(poisoned).toHaveBeenCalledWith({ code: 'panic', message: 'unreachable' });
  });

  it('tears down on out-of-memory too', async () => {
    const { fake, client, poisoned } = make();
    const p = client.start('a', 'contours', contours());
    fake.fail(p.id, 'contours', 'oom', 'wasm heap');
    await expect(p.promise).rejects.toMatchObject({ code: 'oom' });
    expect(fake.terminated).toBe(1);
    expect(poisoned).toHaveBeenCalledTimes(1);
  });

  it('keeps going after an ordinary parse error', async () => {
    const { fake, client } = make();
    const bad = client.start('a', 'contours', contours());
    const good = client.start('b', 'contours', contours());
    fake.fail(bad.id, 'contours', 'parse', 'no such handle');
    await expect(bad.promise).rejects.toMatchObject({ code: 'parse' });
    expect(fake.terminated).toBe(0);
    fake.ok(good.id, 'contours', { segments: new Float32Array(0) });
    await expect(good.promise).resolves.toBeTruthy();
  });

  it('stamps heapBytes from the last successful Res', async () => {
    const { fake, client } = make();
    const seen: number[] = [];
    const worker = fake as unknown as Worker;
    const c2 = new ComputeClient({ worker, onHeapBytes: (b) => seen.push(b) });
    const p = c2.start('a', 'contours', contours());
    fake.ok(p.id, 'contours', { segments: new Float32Array(0) }, 17_301_504);
    await p.promise;
    expect(c2.heapBytes).toBe(17_301_504);
    expect(seen).toEqual([17_301_504]);
    expect(client.heapBytes).toBe(0);
  });
});

describe('progress (§6.5)', () => {
  it('forwards every Progress with its request id', () => {
    const fake = new FakeWorker();
    const seen: Array<[number, string, number, number]> = [];
    const client = new ComputeClient({
      worker: fake as unknown as Worker,
      onProgress: (id, phase, done, total) => seen.push([id, phase, done, total]),
    });
    const p = client.start('a', 'loadMesh', loadMesh());
    fake.deliver({ kind: 'progress', id: p.id, phase: 'read', done: 10, total: 100 });
    fake.deliver({ kind: 'progress', id: p.id, phase: 'parse', done: 50, total: 100 });
    expect(seen).toEqual([
      [p.id, 'read', 10, 100],
      [p.id, 'parse', 50, 100],
    ]);
  });

  it('ignores an answer whose id nothing is waiting for', async () => {
    const { fake, client } = make();
    const p = client.start('a', 'contours', contours());
    fake.ok(999, 'contours', { segments: new Float32Array(0) });
    fake.ok(p.id, 'contours', { segments: new Float32Array(3) });
    await expect(p.promise).resolves.toMatchObject({ segments: expect.anything() });
  });
});
