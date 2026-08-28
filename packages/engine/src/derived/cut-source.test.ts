/**
 * The E-DERIVED ↔ E-MESH seam: the real `CutManager` **is** the `CutSource` `derived/store.ts`
 * consumes, and it honours the four guarantees R4's 2D cuts are built on.
 *
 * This branch asserted these against `PaneCutSource`, the stand-in it shipped because Phase
 * 2's integration order lands the mesh work one stage earlier than the derived work.
 * The stand-in is gone; this file is what stops the swap from being a claim. It deliberately
 * asserts *through the narrow interface*, never through `CutManager` directly — a widening on
 * E-MESH's side is theirs to test, a narrowing of these four is a broken seam.
 *
 * R4's sweeping requirement is a *queueing* claim, not a rendering one: "the 2D cut is served by the
 * shared cut-manager (latest-wins), so sweeping never queues". That is testable without a GPU, and
 * it is what this file asserts — one request per changed plane, a superseded result dropped rather
 * than applied, the three panes' keys independent of each other, and the boundary segments
 * `contoursIn2D` draws actually surviving onto the snapshot.
 */

import { describe, expect, it } from 'vitest';
import { CutManager } from '../compute/cut-manager';
import type { CutClient } from '../compute/cut-manager';
import type { CutSource } from './cut-source';
import { MAX_CUT_PLANES } from './cut-source';
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

/** A client that hands back a promise per `cut` and lets the test settle them out of order. */
class FakeClient implements CutClient {
  readonly calls: { key: string; args: OpArgs['cut'] }[] = [];
  readonly #settles: ((r: OpResult['cut']) => void)[] = [];

  call(key: string, op: 'cut', args: OpArgs['cut']): Promise<OpResult['cut']>;
  call(key: string, op: 'field', args: OpArgs['field']): Promise<OpResult['field']>;
  call(
    key: string,
    op: 'cut' | 'field',
    args: OpArgs['cut'] | OpArgs['field']
  ): Promise<OpResult['cut'] | OpResult['field']> {
    // No test here asks for a field on the cut: `fillIn2D`'s colouring reads `tag` or an `elm`
    // field through `ownerTet`, which costs no interpolation.
    if (op !== 'cut') throw new Error('this seam test asks for no field');
    this.calls.push({ key, args: args as OpArgs['cut'] });
    return new Promise<OpResult['cut']>((resolve) => this.#settles.push(resolve));
  }

  settle(index: number, cuts: CutPayload[]): void {
    this.#settles[index]?.({ mode: 'buffers', cuts });
  }
}

const AXIAL: PlaneT = { normal: [0, 0, 1], offset: -10 };
const AXIAL_NEXT: PlaneT = { normal: [0, 0, 1], offset: -11 };
const CORONAL: PlaneT = { normal: [0, -1, 0], offset: 3 };
const OPTS = { wantEdges: false, wantBoundary: true } as const;

/**
 * The manager, seen only as a `CutSource` — the whole point of the file. `releaseDataset` is not on
 * the consumer interface (it is the facade's, on `removeDataset`), so it is reached separately.
 */
function make(): { source: CutSource; manager: CutManager; client: FakeClient } {
  const client = new FakeClient();
  const manager = new CutManager(() => ({ client, handle: 7 }));
  return { source: manager, manager, client };
}

/**
 * A `tick` deep enough for `#issue`'s two awaits — the (possibly empty) field fetch, then the `cut`
 * call. A `requestCut` therefore reaches the client **asynchronously**, which is why every
 * call-count assertion below awaits first rather than reading straight after the request.
 */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('the CutSource seam — CutManager satisfies what derived/store.ts consumes', () => {
  it('exposes the four methods and §7.4’s plane cap', () => {
    const { source } = make();
    expect(typeof source.requestCut).toBe('function');
    expect(typeof source.getCut).toBe('function');
    expect(typeof source.onCut).toBe('function');
    expect(typeof source.releaseCut).toBe('function');
    expect(MAX_CUT_PLANES).toBe(6);
  });

  it('issues one `cut` per changed plane and none for a repeat of the same plane', async () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:axial', [{ normal: [0, 0, 1], offset: -10 }], OPTS);
    await tick();
    expect(client.calls).toHaveLength(1);
    // §6.4: the recycled reply carries no arrays the engine could read, so a consumer never gets one.
    expect(client.calls[0]?.args.recycle).toBe(false);
    expect(client.calls[0]?.args.handle).toBe(7);

    source.requestCut('ds1', 'pane:axial', [AXIAL_NEXT], OPTS);
    await tick();
    expect(client.calls).toHaveLength(2);
  });

  it('keys latest-wins per pane, so three panes never supersede each other', async () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:coronal', [CORONAL], OPTS);
    source.requestCut('ds1', '3d-clip', [AXIAL], OPTS);
    await tick();
    expect(new Set(client.calls.map((c) => c.key)).size).toBe(3);
  });

  it('drops a superseded result rather than applying it — the sweep case', async () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    source.requestCut('ds1', 'pane:axial', [AXIAL_NEXT], OPTS);
    await tick();
    expect(client.calls).toHaveLength(2);

    // The *second* cut lands first; the first then arrives from a slow worker. It must not become
    // the current snapshot: it describes a plane the cursor has already left.
    client.settle(1, [payload(0, 4)]);
    await tick();
    client.settle(0, [payload(0, 99)]);
    await tick();

    const snap = source.getCut('ds1', 'pane:axial');
    expect(snap).not.toBeNull();
    expect(snap?.triangleCount).toBe(4);
    expect(snap?.planes).toEqual([AXIAL_NEXT]);
  });

  it('notifies subscribers once per landed cut, with a rising generation', async () => {
    const { source, client } = make();
    const seen: number[] = [];
    source.onCut('ds1', 'pane:axial', (s) => {
      if (s !== null) seen.push(s.generation);
    });
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    await tick();
    client.settle(0, [payload(0, 2)]);
    await tick();
    source.requestCut('ds1', 'pane:axial', [AXIAL_NEXT], OPTS);
    await tick();
    client.settle(1, [payload(0, 3)]);
    await tick();
    expect(seen).toEqual([1, 2]);
  });

  it('an empty plane set is *no cut*, published immediately and without a worker call', async () => {
    const { source, client } = make();
    source.requestCut('ds1', 'pane:axial', [], OPTS);
    await tick();
    expect(client.calls).toHaveLength(0);
    // `null`, not a zero-triangle cut: the consumer must stop drawing rather than keep the last one.
    expect(source.getCut('ds1', 'pane:axial')).toBeNull();
  });

  it('refuses more than §7.4’s six planes', () => {
    const { source } = make();
    const seven = Array.from({ length: 7 }, (_, i) => ({ normal: [0, 0, 1], offset: i }) as PlaneT);
    expect(() => source.requestCut('ds1', '3d-clip', seven, OPTS)).toThrow(/at most 6/);
  });

  it('releases a key, and the facade releases a whole dataset', async () => {
    const { source, manager, client } = make();
    source.requestCut('ds1', 'pane:axial', [AXIAL], OPTS);
    await tick();
    client.settle(0, [payload(0, 1)]);
    await tick();
    expect(source.getCut('ds1', 'pane:axial')).not.toBeNull();
    source.releaseCut('ds1', 'pane:axial');
    expect(source.getCut('ds1', 'pane:axial')).toBeNull();

    source.requestCut('ds1', 'pane:coronal', [CORONAL], OPTS);
    await tick();
    client.settle(1, [payload(0, 1)]);
    await tick();
    manager.releaseDataset('ds1');
    expect(source.getCut('ds1', 'pane:coronal')).toBeNull();
  });

  it('carries the boundary segments `contoursIn2D` draws, and packs planes plane-major', async () => {
    const { source, client } = make();
    source.requestCut('ds1', '3d-clip', [AXIAL, CORONAL], OPTS);
    await tick();
    client.settle(0, [payload(0, 2), payload(1, 3)]);
    await tick();
    const snap = source.getCut('ds1', '3d-clip');
    expect(snap?.triangleCount).toBe(5);
    expect(snap?.ownerTet.length).toBe(5);
    expect(snap?.edgeMask.length).toBe(5);
    expect(snap?.positions.length).toBe(5 * 9);
    // `wantBoundary`, so the 2D contour input survives; `wantEdges` was false, so that one does not.
    expect(snap?.boundarySegments.length).toBe(24);
    expect(snap?.edgeSegments.length).toBe(0);
    // The second plane's owner numbers follow the first's, in order.
    expect([...(snap?.ownerTet ?? [])]).toEqual([1, 2, 1, 2, 3]);
    expect(snap?.planeRanges.map((r) => r.triangleCount)).toEqual([2, 3]);
  });
});
