/**
 * `CutManager` against a **fake worker client** — no GL, no wasm, no `Worker`.
 *
 * What is worth testing here is the lifecycle, because that is what leaks or races: latest-wins
 * dropping a superseded result (§5 rule 6), the `CutOut` recycle protocol of §6.4 (`truncated` ⇒
 * *nothing was written* and `counts` are required sizes), and the "no planes is not an empty cut"
 * rule that decides whether the consumers keep drawing yesterday's caps.
 */

import { describe, expect, it } from 'vitest';
import type { CutPayload, OpArgs, OpResult, PlaneT } from '@tetravox/protocol';
import { CutManager, MAX_CUT_PLANES } from './cut-manager';
import type { CutClient, CutState } from './cut-manager';

const AXIAL: PlaneT = { normal: [0, 0, 1], offset: -10 };
const OBLIQUE: PlaneT = { normal: [0.577, 0.577, 0.577], offset: 0 };

function payload(plane: number, triangles: number): CutPayload {
  return {
    plane,
    positions: new Float32Array(triangles * 9),
    interpNodes: new Uint32Array(triangles * 6),
    interpT: new Float32Array(triangles * 3),
    ownerTet: new Uint32Array(triangles),
    tag: new Int32Array(triangles),
    edgeMask: new Uint8Array(triangles),
    edgeSegments: new Float32Array(triangles * 6),
    boundarySegments: new Float32Array(6),
  };
}

/** A client whose every call is resolved by hand, so ordering is the test's to choose. */
class FakeCutClient implements CutClient {
  readonly calls: { key: string; args: OpArgs['cut'] }[] = [];
  readonly #pending: ((r: OpResult['cut']) => void)[] = [];
  readonly #reject: ((e: unknown) => void)[] = [];

  call(key: string, _op: 'cut', args: OpArgs['cut']): Promise<OpResult['cut']> {
    this.calls.push({ key, args });
    return new Promise<OpResult['cut']>((resolve, reject) => {
      this.#pending.push(resolve);
      this.#reject.push(reject);
    });
  }

  /** Resolve call `i` (0-based) and let the microtask queue drain. */
  async settle(i: number, result: OpResult['cut']): Promise<void> {
    (this.#pending[i] as (r: OpResult['cut']) => void)(result);
    await Promise.resolve();
    await Promise.resolve();
  }

  async fail(i: number, error: unknown): Promise<void> {
    (this.#reject[i] as (e: unknown) => void)(error);
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('CutManager', () => {
  it('issues one `cut` per distinct plane set, on its own latest-wins key', async () => {
    const client = new FakeCutClient();
    const m = new CutManager(client, 7, 'ds1:cut');

    m.request([AXIAL]);
    m.request([AXIAL]); // identical — must not re-cut geometry that has not moved
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.key).toBe('ds1:cut');
    expect(client.calls[0]?.args.handle).toBe(7);
    expect(client.calls[0]?.args.recycle).toBe(true);

    m.request([OBLIQUE]);
    expect(client.calls).toHaveLength(2);

    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 3)] });
    expect(m.current()?.planes).toEqual([OBLIQUE]);
  });

  it('drops a superseded result rather than applying it (§5 rule 6)', async () => {
    const client = new FakeCutClient();
    const m = new CutManager(client, 1, 'k');
    m.request([AXIAL]);
    m.request([OBLIQUE]);

    // The first call runs to completion — WASM is not preemptible — and lands *after* the second.
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 2)] });
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 99)] });

    expect(m.current()?.planes).toEqual([OBLIQUE]);
    expect(m.current()?.cuts[0]?.ownerTet).toHaveLength(2);
    expect(m.current()?.generation).toBe(1);
  });

  it('a truncated recycled reply re-issues without the pool and records the required sizes (§6.4)', async () => {
    const client = new FakeCutClient();
    const m = new CutManager(client, 1, 'k');
    m.request([AXIAL]);
    expect(client.calls[0]?.args.recycle).toBe(true);

    await client.settle(0, {
      mode: 'recycled',
      truncated: true,
      counts: [{ plane: 0, vertices: 120, triangles: 40, edgeSegments: 10, boundarySegments: 4 }],
    });

    // Nothing was written, so nothing may be published yet.
    expect(m.current()).toBeNull();
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.args.recycle).toBe(false);
    expect(m.recycling).toBe(false);
    expect(m.requiredCounts()[0]?.triangles).toBe(40);

    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 40)] });
    expect(m.current()?.cuts[0]?.ownerTet).toHaveLength(40);
  });

  it('no planes means **no cut**, not an empty one', async () => {
    const client = new FakeCutClient();
    const m = new CutManager(client, 1, 'k');
    m.request([AXIAL]);
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 5)] });
    expect(m.capPolygons()).toHaveLength(1);

    m.request([]);
    expect(m.current()).toBeNull();
    expect(m.capPolygons()).toEqual([]);
    expect(m.edgeSegments()).toEqual([]);
    // A late result for the superseded plane set must not resurrect the caps.
    expect(client.calls).toHaveLength(1);
  });

  it('serves both consumers from one request — 3D caps and the 2D overlay (§7.4)', async () => {
    const client = new FakeCutClient();
    const m = new CutManager(client, 1, 'k');
    const seen: (CutState | null)[] = [];
    const off = m.subscribe((s) => seen.push(s));

    m.request([AXIAL]);
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 3)] });

    // `capPolygons` is what §7.4's cap draw reads; `edgeSegments` is what `contoursIn2D` reads, and
    // §7.4 is explicit that the latter is "not used in the 3D passes".
    expect(m.capPolygons()[0]?.positions).toHaveLength(27);
    expect(m.edgeSegments()[0]).toHaveLength(18);
    expect(seen).toHaveLength(1);
    expect(client.calls).toHaveLength(1);

    off();
    m.request([OBLIQUE]);
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 1)] });
    expect(seen).toHaveLength(1);
  });

  it('refuses more than the six planes §7.4 allows', () => {
    const m = new CutManager(new FakeCutClient(), 1, 'k');
    const seven = Array.from({ length: MAX_CUT_PLANES + 1 }, (_, i) => ({
      normal: [0, 0, 1] as [number, number, number],
      offset: i,
    }));
    expect(() => m.request(seven)).toThrow(/at most 6/);
  });

  it('a rejected cut is not an error, and dispose stops everything', async () => {
    const client = new FakeCutClient();
    const m = new CutManager(client, 1, 'k');
    m.request([AXIAL]);
    await client.fail(0, new Error('cancelled'));
    expect(m.current()).toBeNull();

    m.request([OBLIQUE]);
    m.dispose();
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 3)] });
    expect(m.current()).toBeNull();
    m.request([AXIAL]);
    expect(client.calls).toHaveLength(2);
  });
});
