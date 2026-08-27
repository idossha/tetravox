/**
 * `PaneCutSource` — the latest-wins contract R4 depends on, against a fake `cut` client.
 *
 * R4's sweeping requirement is a *queueing* claim, not a rendering one: "the 2D cut is served by the
 * shared cut-manager (latest-wins), so sweeping never queues". That is testable without a GPU and it
 * is what this file asserts — one request per key in flight, a superseded result dropped rather than
 * applied, an unchanged plane costing nothing, and the three panes' keys independent of each other.
 */

import { describe, expect, it } from 'vitest';
import { PaneCutSource, samePlanes } from './cut-source';
import type { CutTarget } from './cut-source';
import type { CutPayload, OpArgs, OpResult, PlaneT } from '@tetravox/protocol';

function payload(plane: number, tris: number): CutPayload {
  return {
    plane,
    positions: new Float32Array(tris * 9),
    interpNodes: new Uint32Array(tris * 6),
    interpT: new Float32Array(tris * 3),
    ownerTet: Uint32Array.from({ length: tris }, (_, i) => i + 1),
    tag: Int32Array.from({ length: tris }, () => 2),
    edgeMask: new Uint8Array(tris).fill(0b111),
    edgeSegments: new Float32Array(6),
    boundarySegments: new Float32Array(12),
  };
}

/** A client that hands back a promise per call and lets the test settle them out of order. */
class FakeClient {
  readonly calls: { key: string; args: OpArgs['cut'] }[] = [];
  readonly #settles: ((r: OpResult['cut']) => void)[] = [];

  call(key: string, _op: 'cut', args: OpArgs['cut']): Promise<OpResult['cut']> {
    this.calls.push({ key, args });
    return new Promise<OpResult['cut']>((resolve) => this.#settles.push(resolve));
  }

  settle(index: number, tris: number): void {
    this.#settles[index]?.({ mode: 'buffers', cuts: [payload(0, tris)] });
  }
}

const AXIAL: PlaneT = { normal: [0, 0, 1], offset: -10 };
const AXIAL_NEXT: PlaneT = { normal: [0, 0, 1], offset: -11 };
const CORONAL: PlaneT = { normal: [0, -1, 0], offset: 3 };
const OPTS = { wantEdges: false, wantBoundary: true } as const;

function make(): { source: PaneCutSource; client: FakeClient } {
  const client = new FakeClient();
  const target = (): CutTarget => ({ client, handle: 7 });
  return { source: new PaneCutSource(target), client };
}

describe('samePlanes', () => {
  it('compares component-wise, not by identity', () => {
    expect(samePlanes([AXIAL], [{ normal: [0, 0, 1], offset: -10 }])).toBe(true);
    expect(samePlanes([AXIAL], [AXIAL_NEXT])).toBe(false);
    expect(samePlanes([AXIAL], [AXIAL, CORONAL])).toBe(false);
  });
});

describe('PaneCutSource', () => {
  it('issues one `cut` per changed plane and none for a repeat of the same plane', () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:axial', [{ normal: [0, 0, 1], offset: -10 }], OPTS);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.args.recycle).toBe(false);
    expect(client.calls[0]?.args.handle).toBe(7);

    source.requestCut('ds1', 'pane:axial', [AXIAL_NEXT], OPTS);
    expect(client.calls).toHaveLength(2);
  });

  it('keys latest-wins per pane, so three panes never supersede each other', () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:coronal', [CORONAL], OPTS);
    expect(client.calls.map((c) => c.key)).toEqual(['cut:ds1:pane:axial', 'cut:ds1:pane:coronal']);
  });

  it('drops a superseded result rather than applying it — the sweep case', async () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:axial', [AXIAL_NEXT], OPTS);
    expect(client.calls).toHaveLength(2);

    // The *first* cut lands last, as a slow worker would deliver it. It must not become the current
    // snapshot: it describes a plane the cursor has already left.
    client.settle(1, 4);
    await Promise.resolve();
    client.settle(0, 99);
    await Promise.resolve();

    const snap = source.getCut('ds1', 'pane:axial');
    expect(snap).not.toBeNull();
    expect(snap?.tag.length).toBe(4);
    expect(snap?.planes).toEqual([AXIAL_NEXT]);
  });

  it('notifies subscribers once per landed cut, with a rising generation', async () => {
    const { source, client } = make();
    const seen: number[] = [];
    source.onCut('ds1', 'pane:axial', (s) => seen.push(s.generation));
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    client.settle(0, 2);
    await Promise.resolve();
    source.requestCut('ds1', 'pane:axial', [AXIAL_NEXT], OPTS);
    client.settle(1, 3);
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
  });

  it('an empty plane set is *no cut*, published immediately and without a worker call', () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [], OPTS);
    expect(client.calls).toHaveLength(0);
    const snap = source.getCut('ds1', 'pane:axial');
    expect(snap?.tag.length).toBe(0);
    expect(snap?.positions.length).toBe(0);
  });

  it('refuses more than §7.4’s six planes', () => {
    const { source } = make();
    const seven = Array.from({ length: 7 }, (_, i) => ({ normal: [0, 0, 1], offset: i }) as PlaneT);
    expect(() => source.requestCut('ds1', '3d-clip', seven, OPTS)).toThrow(/at most 6/);
  });

  it('releases a key and a whole dataset', async () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    client.settle(0, 1);
    await Promise.resolve();
    expect(source.getCut('ds1', 'pane:axial')).not.toBeNull();
    source.releaseCut('ds1', 'pane:axial');
    expect(source.getCut('ds1', 'pane:axial')).toBeNull();

    source.requestCut('ds1', 'pane:coronal', [CORONAL], OPTS);
    client.settle(1, 1);
    await Promise.resolve();
    source.releaseDataset('ds1');
    expect(source.getCut('ds1', 'pane:coronal')).toBeNull();
  });

  it('concatenates a multi-plane cut into one sheet, keeping per-triangle tables aligned', async () => {
    const settles: ((r: OpResult['cut']) => void)[] = [];
    const multi = {
      call: (_k: string, _o: 'cut', _a: OpArgs['cut']): Promise<OpResult['cut']> =>
        new Promise<OpResult['cut']>((r) => settles.push(r)),
    };
    const source = new PaneCutSource(() => ({ client: multi, handle: 1 }));
    source.requestCut('ds1', '3d-clip', [AXIAL, CORONAL], OPTS);
    settles[0]?.({ mode: 'buffers', cuts: [payload(0, 2), payload(1, 3)] });
    await Promise.resolve();
    const snap = source.getCut('ds1', '3d-clip');
    expect(snap?.tag.length).toBe(5);
    expect(snap?.ownerTet.length).toBe(5);
    expect(snap?.edgeMask.length).toBe(5);
    expect(snap?.positions.length).toBe(5 * 9);
    expect(snap?.boundarySegments.length).toBe(24);
    // The second plane's owner numbers follow the first's, in order.
    expect([...(snap?.ownerTet ?? [])]).toEqual([1, 2, 1, 2, 3]);
  });
});
