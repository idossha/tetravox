/**
 * `CutManager` against a **fake worker client** — no GL, no wasm, no `Worker`.
 *
 * What is worth testing here is the lifecycle, because that is what leaks or races, plus the four
 * sentences the Phase-2 API contract is made of:
 *
 * * *latest-wins per `(datasetId, key)`* — sweeping the axial pane must not starve the coronal
 *   pane's cut, and dragging the 3D clip gizmo must not cancel either (R4);
 * * *snapshots are immutable and a stale generation is never delivered* (§5 rule 6);
 * * *the manager recycles arenas per key* — one buffer backs two consecutive cuts of a key and
 *   never backs two different keys (§7.4's "grown by doubling, never shrunk during a drag");
 * * *fields land per vertex for a node field and per triangle for an elm field*, with `ownerTet`
 *   read as the **1-based Gmsh element number** §6.2 says it is.
 *
 * The geometry is hand-built so every expected number is arithmetic rather than a recording.
 */

import { describe, expect, it } from 'vitest';
import type { CutPayload, OpArgs, OpResult, PlaneT } from '@tetravox/protocol';
import { CutManager, CUT_KEY_3D_CLIP, cutKeyForPane, MAX_CUT_PLANES } from './cut-manager';
import type { CutClient, CutSnapshot } from './cut-manager';

const AXIAL: PlaneT = { normal: [0, 0, 1], offset: -10 };
const OBLIQUE: PlaneT = { normal: [0.577, 0.577, 0.577], offset: 0 };

/**
 * One plane's worth of geometry, built from arithmetic:
 *
 * * vertex `i` sits at `(i, i + 0.5, plane)`, is interpolated between nodes `(i, i + 1)` at
 *   `t = (i mod 4) / 4`;
 * * triangle `t` is owned by **Gmsh element `t + 1`** and carries `edgeMask` `0b011` when `t` is
 *   even — a 2-2-split quad's suppressed diagonal (§7.4) — and `0b111` otherwise;
 * * one edge segment and two boundary segments, so the two `want*` flags are distinguishable.
 */
function payload(plane: number, triangles: number, tagBase = 100): CutPayload {
  const verts = triangles * 3;
  const positions = new Float32Array(verts * 3);
  const interpNodes = new Uint32Array(verts * 2);
  const interpT = new Float32Array(verts);
  for (let i = 0; i < verts; i += 1) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i + 0.5;
    positions[i * 3 + 2] = plane;
    interpNodes[i * 2] = i;
    interpNodes[i * 2 + 1] = i + 1;
    interpT[i] = (i % 4) / 4;
  }
  const ownerTet = new Uint32Array(triangles);
  const tag = new Int32Array(triangles);
  const edgeMask = new Uint8Array(triangles);
  for (let t = 0; t < triangles; t += 1) {
    ownerTet[t] = t + 1;
    tag[t] = tagBase + (t % 2);
    edgeMask[t] = t % 2 === 0 ? 0b011 : 0b111;
  }
  return {
    plane,
    positions,
    interpNodes,
    interpT,
    ownerTet,
    tag,
    edgeMask,
    edgeSegments: new Float32Array([0, 0, 0, 1, 1, 1]),
    boundarySegments: new Float32Array([2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]),
  };
}

const NO_STATS = {
  min: 0,
  max: 0,
  mean: 0,
  percentiles: [0, 0, 0, 0, 0, 0, 0, 0, 0] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
  histogram: new Uint32Array(256),
  histogramLo: 0,
  histogramHi: 1,
};

/** A client whose every `cut` is resolved by hand, so ordering is the test's to choose. */
class FakeCutClient implements CutClient {
  readonly calls: { key: string; op: 'cut' | 'field'; args: unknown }[] = [];
  readonly #pending: ((r: OpResult['cut']) => void)[] = [];
  readonly #reject: ((e: unknown) => void)[] = [];
  /** Field values answer synchronously: a field is a load-once cache, not a drag path. */
  fieldValues: Record<string, Float32Array> = {};

  call(key: string, op: 'cut', args: OpArgs['cut']): Promise<OpResult['cut']>;
  call(key: string, op: 'field', args: OpArgs['field']): Promise<OpResult['field']>;
  call(
    key: string,
    op: 'cut' | 'field',
    args: OpArgs['cut'] | OpArgs['field']
  ): Promise<OpResult['cut'] | OpResult['field']> {
    this.calls.push({ key, op, args });
    if (op === 'field') {
      const a = args as OpArgs['field'];
      const values = this.fieldValues[a.name] ?? new Float32Array(0);
      return Promise.resolve({ values, stats: NO_STATS, n: values.length, partial: false });
    }
    return new Promise<OpResult['cut']>((resolve, reject) => {
      this.#pending.push(resolve);
      this.#reject.push(reject);
    });
  }

  get cuts(): { key: string; args: OpArgs['cut'] }[] {
    return this.calls
      .filter((c) => c.op === 'cut')
      .map((c) => ({ key: c.key, args: c.args as OpArgs['cut'] }));
  }

  get fields(): OpArgs['field'][] {
    return this.calls.filter((c) => c.op === 'field').map((c) => c.args as OpArgs['field']);
  }

  get pending(): number {
    return this.#pending.length;
  }

  /** Resolve `cut` call `i` (0-based) and let the microtask queue drain. */
  async settle(i: number, result: OpResult['cut']): Promise<void> {
    const resolve = this.#pending[i];
    if (resolve === undefined) throw new Error(`no cut request #${i}`);
    resolve(result);
    await drain();
  }

  async fail(i: number, error: unknown): Promise<void> {
    const reject = this.#reject[i];
    if (reject === undefined) throw new Error(`no cut request #${i}`);
    reject(error);
    await drain();
  }
}

/** The request path awaits the fields before the cut, so a few turns are needed either way. */
async function drain(): Promise<void> {
  for (let k = 0; k < 6; k += 1) await Promise.resolve();
}

function manager(client: CutClient, handle = 7): CutManager {
  return new CutManager((id) => (id === 'ds1' ? { client, handle } : undefined));
}

describe('CutManager — request lifecycle', () => {
  it('issues one `cut` per distinct request, on that key’s own latest-wins key', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };

    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [{ normal: [0, 0, 1], offset: -10 }], { ...opts });
    await drain();
    // Identical — must not re-cut geometry that has not moved.
    expect(client.cuts).toHaveLength(1);
    expect(client.cuts[0]?.key).toBe('cut:3d-clip');
    expect(client.cuts[0]?.args.handle).toBe(7);

    m.requestCut('ds1', CUT_KEY_3D_CLIP, [OBLIQUE], opts);
    await drain();
    expect(client.cuts).toHaveLength(2);

    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 3)] });
    expect(m.current('ds1', CUT_KEY_3D_CLIP)?.planes).toEqual([OBLIQUE]);
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.triangleCount).toBe(3);
  });

  it('asks for `recycle: false` — a recycled reply carries no arrays the engine could read', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], { wantEdges: false, wantBoundary: false });
    await drain();
    expect(client.cuts[0]?.args.recycle).toBe(false);
    expect(m.recycling('ds1', CUT_KEY_3D_CLIP)).toBe(false);
  });

  it('no planes means **no cut**, not an empty one', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: true, wantBoundary: true };
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 5)] });
    expect(m.capPolygons('ds1', CUT_KEY_3D_CLIP)).toHaveLength(1);

    const seen: (CutSnapshot | null)[] = [];
    m.onCut('ds1', CUT_KEY_3D_CLIP, (s) => seen.push(s));
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [], opts);
    expect(m.current('ds1', CUT_KEY_3D_CLIP)).toBeNull();
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)).toBeNull();
    expect(m.capPolygons('ds1', CUT_KEY_3D_CLIP)).toEqual([]);
    expect(m.edgeSegments('ds1', CUT_KEY_3D_CLIP)).toEqual([]);
    expect(seen).toEqual([null]);
    // A late result for the superseded plane set must not resurrect the caps.
    expect(client.cuts).toHaveLength(1);
  });

  it('refuses more than the six planes §7.4 allows', () => {
    const m = manager(new FakeCutClient());
    const seven = Array.from({ length: MAX_CUT_PLANES + 1 }, (_, i) => ({
      normal: [0, 0, 1] as [number, number, number],
      offset: i,
    }));
    expect(() =>
      m.requestCut('ds1', CUT_KEY_3D_CLIP, seven, { wantEdges: false, wantBoundary: false })
    ).toThrow(/at most 6/);
  });

  it('an unknown dataset is a silent no-op, not a throw', () => {
    const m = manager(new FakeCutClient());
    expect(() =>
      m.requestCut('nope', CUT_KEY_3D_CLIP, [AXIAL], { wantEdges: false, wantBoundary: false })
    ).not.toThrow();
    expect(m.getCut('nope', CUT_KEY_3D_CLIP)).toBeNull();
    expect(m.onCut('nope', CUT_KEY_3D_CLIP, () => undefined)).toBeInstanceOf(Function);
  });

  it('a rejected cut is not an error, and dispose stops everything', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    await client.fail(0, new Error('cancelled'));
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)).toBeNull();

    m.requestCut('ds1', CUT_KEY_3D_CLIP, [OBLIQUE], opts);
    await drain();
    m.dispose();
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 3)] });
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)).toBeNull();
    expect(m.keys()).toEqual([]);
  });
});

describe('CutManager — latest-wins is per key (R4)', () => {
  it('drops a superseded result for the same key rather than applying it (§5 rule 6)', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [OBLIQUE], opts);
    await drain();
    expect(client.pending).toBe(2);

    // The first call runs to completion — WASM is not preemptible — and lands *after* the second.
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 2)] });
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 99)] });

    const snap = m.getCut('ds1', CUT_KEY_3D_CLIP);
    expect(snap?.planes).toEqual([OBLIQUE]);
    expect(snap?.triangleCount).toBe(2);
    expect(snap?.generation).toBe(1);
  });

  it('three panes plus the 3D clip are four keys that never starve each other', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: true, wantBoundary: true };
    const keys = [
      CUT_KEY_3D_CLIP,
      cutKeyForPane('axial'),
      cutKeyForPane('coronal'),
      cutKeyForPane('sagittal'),
    ];
    keys.forEach((k, i) => {
      m.requestCut('ds1', k, [{ normal: [0, 0, 1], offset: i }], opts);
    });
    await drain();
    expect(client.cuts).toHaveLength(4);
    // The `ComputeClient` latest-wins key is distinct per consumer, or three of these four would be
    // dropped from the queue before they were ever posted (§5 rule 6).
    expect(client.cuts.map((c) => c.key)).toEqual([
      'cut:3d-clip',
      'cut:pane:axial',
      'cut:pane:coronal',
      'cut:pane:sagittal',
    ]);

    // Sweeping the axial pane supersedes only its own key.
    m.requestCut('ds1', cutKeyForPane('axial'), [{ normal: [0, 0, 1], offset: 42 }], opts);
    await drain();
    expect(client.cuts).toHaveLength(5);

    for (let i = 0; i < 4; i += 1) {
      await client.settle(i, { mode: 'buffers', cuts: [payload(i, i + 1)] });
    }
    await client.settle(4, { mode: 'buffers', cuts: [payload(9, 8)] });

    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.triangleCount).toBe(1);
    expect(m.getCut('ds1', cutKeyForPane('axial'))?.triangleCount).toBe(8);
    expect(m.getCut('ds1', cutKeyForPane('coronal'))?.triangleCount).toBe(3);
    expect(m.getCut('ds1', cutKeyForPane('sagittal'))?.triangleCount).toBe(4);
    expect(m.keys()).toHaveLength(4);
  });

  it('`onCut` fires per key; `releaseCut` drops one key and `releaseDataset` all of them', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    const clip: number[] = [];
    const pane: number[] = [];
    m.onCut('ds1', CUT_KEY_3D_CLIP, (s) => clip.push(s?.triangleCount ?? -1));
    m.onCut('ds1', cutKeyForPane('axial'), (s) => pane.push(s?.triangleCount ?? -1));

    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    m.requestCut('ds1', cutKeyForPane('axial'), [OBLIQUE], opts);
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 2)] });
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 3)] });
    expect(clip).toEqual([2]);
    expect(pane).toEqual([3]);

    m.releaseCut('ds1', CUT_KEY_3D_CLIP);
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)).toBeNull();
    expect(m.getCut('ds1', cutKeyForPane('axial'))?.triangleCount).toBe(3);
    expect(m.keys().map((k) => k.key)).toEqual(['pane:axial']);

    m.releaseDataset('ds1');
    expect(m.keys()).toEqual([]);
  });

  it('an unsubscribe stops delivery without disturbing the other listeners', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    const a: number[] = [];
    const b: number[] = [];
    const off = m.onCut('ds1', CUT_KEY_3D_CLIP, (s) => a.push(s?.generation ?? -1));
    m.onCut('ds1', CUT_KEY_3D_CLIP, (s) => b.push(s?.generation ?? -1));
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 1)] });
    off();
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [OBLIQUE], opts);
    await drain();
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 1)] });
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});

describe('CutManager — snapshots and arenas', () => {
  it('packs planes plane-major and gives each plane its range', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL, OBLIQUE], {
      wantEdges: true,
      wantBoundary: true,
    });
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 2), payload(1, 3)] });

    const snap = m.getCut('ds1', CUT_KEY_3D_CLIP);
    expect(snap).not.toBeNull();
    if (snap === null) return;
    expect(snap.triangleCount).toBe(5);
    expect(snap.vertexCount).toBe(15);
    expect(snap.positions.length).toBe(45);
    expect(snap.planeRanges).toEqual([
      {
        plane: 0,
        firstVertex: 0,
        vertexCount: 6,
        firstTriangle: 0,
        triangleCount: 2,
        firstEdgeSegment: 0,
        edgeSegmentCount: 1,
        firstBoundarySegment: 0,
        boundarySegmentCount: 2,
      },
      {
        plane: 1,
        firstVertex: 6,
        vertexCount: 9,
        firstTriangle: 2,
        triangleCount: 3,
        firstEdgeSegment: 1,
        edgeSegmentCount: 1,
        firstBoundarySegment: 2,
        boundarySegmentCount: 2,
      },
    ]);
    // Plane 1's first vertex is that payload's vertex 0, whose z is the plane index.
    expect(snap.positions[6 * 3 + 2]).toBe(1);
    expect(snap.edgeSegments.length).toBe(12);
    expect(snap.boundarySegments.length).toBe(24);
    // §7.4's suppressed diagonal survives the pack unchanged.
    expect([...snap.edgeMask]).toEqual([0b011, 0b111, 0b011, 0b111, 0b011]);
    expect([...snap.ownerTet]).toEqual([1, 2, 1, 2, 3]);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('`wantEdges` / `wantBoundary` false leave those arrays empty (§7.4: 2D overlay only)', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], { wantEdges: false, wantBoundary: false });
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 2)] });
    const snap = m.getCut('ds1', CUT_KEY_3D_CLIP);
    expect(snap?.edgeSegments.length).toBe(0);
    expect(snap?.boundarySegments.length).toBe(0);
    // The 3D geometry is unaffected.
    expect(snap?.triangleCount).toBe(2);
  });

  it('recycles one arena per key: one buffer for two cuts of a key, never for two keys', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    m.requestCut('ds1', cutKeyForPane('axial'), [OBLIQUE], opts);
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 4)] });
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 4)] });
    const clipBuffer = m.getCut('ds1', CUT_KEY_3D_CLIP)?.positions.buffer;
    const paneBuffer = m.getCut('ds1', cutKeyForPane('axial'))?.positions.buffer;
    expect(clipBuffer).toBeDefined();
    expect(clipBuffer).not.toBe(paneBuffer);

    // A second, smaller cut of the same key reuses the arena rather than allocating: §7.4's buffers
    // "grow by doubling and never shrink during a drag".
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [{ normal: [0, 0, 1], offset: 3 }], opts);
    await drain();
    await client.settle(2, { mode: 'buffers', cuts: [payload(0, 2)] });
    const next = m.getCut('ds1', CUT_KEY_3D_CLIP);
    expect(next?.positions.buffer).toBe(clipBuffer);
    expect(next?.triangleCount).toBe(2);
    expect(next?.positions.length).toBe(18);
  });

  it('grows the arena for a bigger cut and keeps every view exactly the used length', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 2)] });
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [OBLIQUE], opts);
    await drain();
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 40)] });
    const snap = m.getCut('ds1', CUT_KEY_3D_CLIP);
    expect(snap?.triangleCount).toBe(40);
    expect(snap?.positions.length).toBe(40 * 9);
    expect(snap?.interpNodes.length).toBe(40 * 6);
    expect(snap?.interpT.length).toBe(40 * 3);
    expect(snap?.ownerTet.length).toBe(40);
    expect(snap?.tag.length).toBe(40);
    expect(snap?.edgeMask.length).toBe(40);
  });
});

describe('CutManager — fields on the cut', () => {
  it('asks for a node field once and interpolates it per vertex by `interpT`', async () => {
    const client = new FakeCutClient();
    // f[n] = 10n, so mix(f[i], f[i+1], t) = 10i + 10t — arithmetic, not a recording.
    client.fieldValues.TI_max = Float32Array.from({ length: 64 }, (_, i) => 10 * i);
    const m = manager(client);
    const opts = {
      wantEdges: false,
      wantBoundary: false,
      fields: [{ source: 'node' as const, name: 'TI_max' }],
    };
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 2)] });

    const snap = m.getCut('ds1', CUT_KEY_3D_CLIP);
    expect(snap?.fields.TI_max?.length).toBe(6);
    expect([...(snap?.fields.TI_max ?? [])]).toEqual(
      Array.from({ length: 6 }, (_, i) => 10 * i + 10 * ((i % 4) / 4))
    );
    expect(client.fields).toEqual([
      { handle: 7, source: 'node', name: 'TI_max', component: 'mag' },
    ]);

    // A second cut of the same key reuses the cached field — a whole drag pays for it once.
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [OBLIQUE], opts);
    await drain();
    await client.settle(1, { mode: 'buffers', cuts: [payload(0, 2)] });
    expect(client.fields).toHaveLength(1);
  });

  it('lands an elm field per triangle, reading `ownerTet` as the 1-based Gmsh number (§6.2)', async () => {
    const client = new FakeCutClient();
    // f[e] = 100 + e over the 0-based element rows; triangle t is owned by Gmsh element t + 1.
    client.fieldValues.magnE = Float32Array.from({ length: 16 }, (_, i) => 100 + i);
    const m = manager(client);
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], {
      wantEdges: false,
      wantBoundary: false,
      fields: [{ source: 'elm', name: 'magnE' }],
    });
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 4)] });
    expect([...(m.getCut('ds1', CUT_KEY_3D_CLIP)?.fields.magnE ?? [])]).toEqual([
      100, 101, 102, 103,
    ]);
  });

  it('carries no fields at all when none were asked for', async () => {
    const client = new FakeCutClient();
    client.fieldValues.TI_max = new Float32Array(64);
    const m = manager(client);
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], { wantEdges: false, wantBoundary: false });
    await drain();
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 2)] });
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.fields).toEqual({});
    expect(client.fields).toHaveLength(0);
  });

  it('a changed field list re-issues the cut', async () => {
    const client = new FakeCutClient();
    client.fieldValues.TI_max = new Float32Array(64);
    const m = manager(client);
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], { wantEdges: false, wantBoundary: false });
    await drain();
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], {
      wantEdges: false,
      wantBoundary: false,
      fields: [{ source: 'node', name: 'TI_max' }],
    });
    await drain();
    expect(client.cuts).toHaveLength(2);
  });
});

describe('CutManager — the recycled reply (§6.4)', () => {
  it('records the required sizes and publishes nothing: nothing was written', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], { wantEdges: false, wantBoundary: false });
    await drain();
    await client.settle(0, {
      mode: 'recycled',
      truncated: true,
      counts: [{ plane: 0, vertices: 120, triangles: 40, edgeSegments: 10, boundarySegments: 4 }],
    });
    expect(m.requiredCounts('ds1', CUT_KEY_3D_CLIP)[0]?.triangles).toBe(40);
    // The request already asked for `recycle: false`, so there is nothing to retry without — and a
    // pool the engine cannot read must never become a snapshot.
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)).toBeNull();
    expect(client.cuts).toHaveLength(1);
  });
});

describe('CutManager — a drag is not starved by its own newest request', () => {
  it('applies a result that is still the newest **seen**, not only the newest **issued**', async () => {
    // The bug this pins is the one a real drag hits and no earlier test could: `ComputeClient`
    // keeps one request in flight and one queued per key, and an in-flight request "has no abort
    // flag" — it runs to completion and its result arrives. If the manager drops that result
    // because newer requests have since been *issued*, a drag that moves the plane every frame
    // never lands a single cut. Measured on ernie at 120 fps against a ~150 ms cut: zero
    // cross-sections in two seconds, the cap frozen where the drag began.
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    const seen: (CutSnapshot | null)[] = [];
    m.onCut('ds1', CUT_KEY_3D_CLIP, (s) => seen.push(s));

    // Ten frames of a drag, none of them settled yet.
    for (let i = 0; i < 10; i += 1) {
      m.requestCut('ds1', CUT_KEY_3D_CLIP, [{ normal: [0, 0, 1], offset: -i }], opts);
      await drain();
    }
    expect(client.cuts).toHaveLength(10);
    expect(seen).toEqual([]);

    // The first one — the one that was actually in flight — comes back.
    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 4)] });
    expect(seen).toHaveLength(1);
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.triangleCount).toBe(4);
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.generation).toBe(1);

    // …and then a later one, which supersedes it.
    await client.settle(7, { mode: 'buffers', cuts: [payload(0, 6)] });
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.triangleCount).toBe(6);
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.generation).toBe(2);

    // …while one that started before it must still be refused, however late it arrives: the
    // guarantee is that a snapshot is never replaced by an older one.
    await client.settle(3, { mode: 'buffers', cuts: [payload(0, 99)] });
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.triangleCount).toBe(6);
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)?.generation).toBe(2);
  });

  it('removing the last plane refuses an in-flight cut rather than resurrecting the caps', async () => {
    const client = new FakeCutClient();
    const m = manager(client);
    const opts = { wantEdges: false, wantBoundary: false };
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [AXIAL], opts);
    await drain();
    m.requestCut('ds1', CUT_KEY_3D_CLIP, [], opts);
    expect(m.getCut('ds1', CUT_KEY_3D_CLIP)).toBeNull();

    await client.settle(0, { mode: 'buffers', cuts: [payload(0, 5)] });
    expect(
      m.getCut('ds1', CUT_KEY_3D_CLIP),
      'no planes means no cut, late result or not'
    ).toBeNull();
  });
});
