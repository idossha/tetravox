/**
 * `CutSource` — the shape E-DERIVED consumes a cut through, and the worker-backed implementation it
 * ships with until `compute/cut-manager.ts` grows the same four methods.
 *
 * **The contract (agreed with E-MESH, `docs/PHASE2-OWNERSHIP.md` R4).** A cut is asked for by
 * `(datasetId, key)`, latest-wins **per key**, so the three 2D panes and the 3D clip planes never
 * starve each other:
 *
 * * `'3d-clip'` — the mesh layer's own `clip.planes`, whose caps §7.4 draws in 3D.
 * * `` `pane:${viewId}` `` — one per 2D pane, at that pane's derived cursor plane (§4.5: "the plane
 *   is DERIVED, never stored"). Sweeping the cursor re-requests the same key, so a sweep replaces
 *   its own pending request instead of queueing one cut per step — which is what makes R4's
 *   "sweeping never queues" true rather than aspirational.
 *
 * Snapshots are **immutable**: a consumer may hold one across frames and compare `generation` to
 * decide whether to re-upload. A stale generation is never delivered.
 *
 * **Why this file exists at all.** `compute/cut-manager.ts` is E-MESH's, and Phase 2's integration
 * order lands E-MESH in stage 3 and E-DERIVED in stage 4 — but R4 is a gate item on *this* branch,
 * with its own real-data assertions, so it cannot wait for a merge to be runnable. {@link
 * PaneCutSource} implements the interface against the `cut` op directly, with the same latest-wins
 * and same immutability. When `CutManager` gains `requestCut` / `getCut` / `onCut` / `releaseCut`,
 * the integrator swaps the one construction site in `engine.ts`; nothing else moves, because nothing
 * else names the implementation.
 */

import type { CutPayload, OpArgs, OpResult, PlaneT } from '@tetravox/protocol';
import type { DatasetId } from '../scene/types';

/** The `ComputeClient` slice a cut needs — narrow so a unit test can drive it with a fake. */
export interface CutCallClient {
  call(key: string, op: 'cut', args: OpArgs['cut']): Promise<OpResult['cut']>;
}

/** Which mesh dataset a `datasetId` names, and on which worker. */
export interface CutTarget {
  client: CutCallClient;
  handle: number;
}

/** One field a consumer wants interpolated onto the cut, in `CutSnapshot.fields`. */
export interface CutFieldRequest {
  source: 'node' | 'elm';
  name: string;
}

export interface CutRequestOptions {
  fields?: CutFieldRequest[];
  /** The isolation mask (§6.5.2 `isolate`), or `null`/absent for the whole mesh. */
  maskId?: number | null;
  /** `edgeSegments`: the element edges of the cut, for a 2D wireframe. */
  wantEdges: boolean;
  /** `boundarySegments`: the tissue-boundary contour lines `contoursIn2D` draws. */
  wantBoundary: boolean;
}

/**
 * One cut, as the consumers read it. Every array is exactly what the worker produced — de-indexed
 * triangles, one `ownerTet` / `tag` / `edgeMask` per triangle — with **no CPU expansion** (§5 rule
 * 7).
 */
export interface CutSnapshot {
  planes: readonly PlaneT[];
  /** Monotonic per `(datasetId, key)`; bumped once per landed result. */
  generation: number;
  /** 3 floats per vertex, 3 vertices per triangle. */
  positions: Float32Array;
  /** 1 per triangle, a Gmsh element number (§6.2). */
  ownerTet: Uint32Array;
  /** 1 per triangle. */
  tag: Int32Array;
  /** 1 per triangle, low 3 bits (§7.4). */
  edgeMask: Uint8Array;
  /** 6 floats per segment. Empty unless `wantEdges`. */
  edgeSegments: Float32Array;
  /** 6 floats per segment. Empty unless `wantBoundary`. */
  boundarySegments: Float32Array;
  /**
   * Per requested field: per **vertex** for a `node` source (already interpolated), per **triangle**
   * for an `elm` source. Absent when the producer cannot supply it; an `elm` consumer then reads the
   * whole field through a texture indexed by {@link CutSnapshot.ownerTet}, which is §7.4's own
   * mechanism and costs no re-cut when the displayed field changes.
   */
  fields: Record<string, Float32Array>;
}

export interface CutSource {
  requestCut(
    datasetId: DatasetId,
    key: string,
    planes: readonly PlaneT[],
    opts: CutRequestOptions
  ): void;
  getCut(datasetId: DatasetId, key: string): CutSnapshot | null;
  onCut(datasetId: DatasetId, key: string, cb: (snap: CutSnapshot) => void): () => void;
  releaseCut(datasetId: DatasetId, key: string): void;
}

/** §7.4: "up to 6 world-space planes". */
export const MAX_CUT_PLANES = 6;

const EMPTY_F32 = new Float32Array(0);

export function samePlanes(a: readonly PlaneT[], b: readonly PlaneT[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return (
      q !== undefined &&
      p.offset === q.offset &&
      p.normal[0] === q.normal[0] &&
      p.normal[1] === q.normal[1] &&
      p.normal[2] === q.normal[2]
    );
  });
}

function sameFields(a: CutFieldRequest[] | undefined, b: CutFieldRequest[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((f, i) => f.name === y[i]?.name && f.source === y[i]?.source);
}

/**
 * Concatenate the per-plane payloads into one snapshot.
 *
 * A 2D pane asks for exactly one plane, so this is the identity there and allocates nothing beyond
 * the payload it was handed. The multi-plane case (`'3d-clip'`) concatenates, because the consumer
 * draws one sheet.
 */
function toSnapshot(
  cuts: readonly CutPayload[],
  planes: readonly PlaneT[],
  generation: number
): CutSnapshot {
  if (cuts.length === 1) {
    const c = cuts[0]!;
    return {
      planes,
      generation,
      positions: c.positions,
      ownerTet: c.ownerTet,
      tag: c.tag,
      edgeMask: c.edgeMask,
      edgeSegments: c.edgeSegments,
      boundarySegments: c.boundarySegments,
      fields: {},
    };
  }
  const sum = (pick: (c: CutPayload) => { length: number }): number =>
    cuts.reduce((n, c) => n + pick(c).length, 0);
  const positions = new Float32Array(sum((c) => c.positions));
  const ownerTet = new Uint32Array(sum((c) => c.ownerTet));
  const tag = new Int32Array(sum((c) => c.tag));
  const edgeMask = new Uint8Array(sum((c) => c.edgeMask));
  const edgeSegments = new Float32Array(sum((c) => c.edgeSegments));
  const boundarySegments = new Float32Array(sum((c) => c.boundarySegments));
  let p = 0;
  let t = 0;
  let e = 0;
  let b = 0;
  for (const c of cuts) {
    positions.set(c.positions, p);
    p += c.positions.length;
    ownerTet.set(c.ownerTet, t);
    tag.set(c.tag, t);
    edgeMask.set(c.edgeMask, t);
    t += c.ownerTet.length;
    edgeSegments.set(c.edgeSegments, e);
    e += c.edgeSegments.length;
    boundarySegments.set(c.boundarySegments, b);
    b += c.boundarySegments.length;
  }
  return {
    planes,
    generation,
    positions,
    ownerTet,
    tag,
    edgeMask,
    edgeSegments,
    boundarySegments,
    fields: {},
  };
}

const EMPTY_SNAPSHOT = (planes: readonly PlaneT[], generation: number): CutSnapshot => ({
  planes,
  generation,
  positions: EMPTY_F32,
  ownerTet: new Uint32Array(0),
  tag: new Int32Array(0),
  edgeMask: new Uint8Array(0),
  edgeSegments: EMPTY_F32,
  boundarySegments: EMPTY_F32,
  fields: {},
});

interface Entry {
  planes: PlaneT[];
  opts: CutRequestOptions;
  ticket: number;
  snapshot: CutSnapshot | null;
  generation: number;
  listeners: Set<(s: CutSnapshot) => void>;
}

/**
 * The `cut` op (§6.5.2) behind the {@link CutSource} contract.
 *
 * `recycle: false` throughout: the recycled path hands the geometry back through the worker's own
 * `CutOut` pool, which only the GPU-side cap uploader (E-MESH, §7.4) can read, and the buffers path
 * is "the correctness reference, and the only path a golden test uses" (§6.4). A pane cut is one
 * plane, so the extra allocation is one payload per landed step and never per frame.
 */
export class PaneCutSource implements CutSource {
  readonly #target: (id: DatasetId) => CutTarget | undefined;
  readonly #track: <T>(p: Promise<T>) => Promise<T>;
  readonly #entries = new Map<string, Entry>();
  #ticket = 0;
  #disposed = false;

  constructor(
    target: (id: DatasetId) => CutTarget | undefined,
    track: <T>(p: Promise<T>) => Promise<T> = (p) => p
  ) {
    this.#target = target;
    this.#track = track;
  }

  #entry(datasetId: DatasetId, key: string): Entry {
    const k = `${datasetId} ${key}`;
    let e = this.#entries.get(k);
    if (e === undefined) {
      e = {
        planes: [],
        opts: { wantEdges: false, wantBoundary: false },
        ticket: 0,
        snapshot: null,
        generation: 0,
        listeners: new Set(),
      };
      this.#entries.set(k, e);
    }
    return e;
  }

  requestCut(
    datasetId: DatasetId,
    key: string,
    planes: readonly PlaneT[],
    opts: CutRequestOptions
  ): void {
    if (this.#disposed) return;
    if (planes.length > MAX_CUT_PLANES) {
      throw new Error(`§7.4 allows at most ${MAX_CUT_PLANES} clip planes, got ${planes.length}`);
    }
    const e = this.#entry(datasetId, key);
    const maskId = opts.maskId ?? undefined;
    const already =
      e.ticket !== 0 &&
      samePlanes(e.planes, planes) &&
      (e.opts.maskId ?? undefined) === maskId &&
      e.opts.wantEdges === opts.wantEdges &&
      e.opts.wantBoundary === opts.wantBoundary &&
      sameFields(e.opts.fields, opts.fields);
    // Re-requesting the identical plane set is a no-op: a re-render during a sweep must not re-cut
    // geometry that has not moved.
    if (already) return;

    e.planes = planes.map((p) => ({ normal: [...p.normal] as PlaneT['normal'], offset: p.offset }));
    e.opts = { ...opts };
    this.#ticket += 1;
    const ticket = this.#ticket;
    e.ticket = ticket;

    if (planes.length === 0) {
      // No planes is not "a cut with zero triangles"; it is *no cut*, and the consumer must stop
      // drawing rather than keep the last one.
      e.generation += 1;
      this.#publish(e, EMPTY_SNAPSHOT(e.planes, e.generation));
      return;
    }
    const target = this.#target(datasetId);
    if (target === undefined) return;
    void this.#track(
      target.client.call(`cut:${datasetId}:${key}`, 'cut', {
        handle: target.handle,
        planes: e.planes,
        maskId,
        recycle: false,
      })
    )
      .then((res) => {
        // Latest-wins: a superseded result is dropped, never applied (§5 rule 6).
        if (this.#disposed || e.ticket !== ticket) return;
        e.generation += 1;
        const snap =
          res.mode === 'buffers'
            ? toSnapshot(res.cuts, e.planes, e.generation)
            : EMPTY_SNAPSHOT(e.planes, e.generation);
        this.#publish(e, snap);
      })
      .catch(() => {
        // A superseded or cancelled cut is normal under latest-wins; it is not an error.
      });
  }

  getCut(datasetId: DatasetId, key: string): CutSnapshot | null {
    return this.#entries.get(`${datasetId} ${key}`)?.snapshot ?? null;
  }

  onCut(datasetId: DatasetId, key: string, cb: (snap: CutSnapshot) => void): () => void {
    const e = this.#entry(datasetId, key);
    e.listeners.add(cb);
    return () => {
      e.listeners.delete(cb);
    };
  }

  releaseCut(datasetId: DatasetId, key: string): void {
    const k = `${datasetId} ${key}`;
    const e = this.#entries.get(k);
    if (e === undefined) return;
    e.listeners.clear();
    this.#entries.delete(k);
  }

  /** Drop every key of one dataset — the worker is going away with it (§5 rule 1). */
  releaseDataset(datasetId: DatasetId): void {
    for (const k of [...this.#entries.keys()]) {
      if (k.startsWith(`${datasetId} `)) this.#entries.delete(k);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const e of this.#entries.values()) e.listeners.clear();
    this.#entries.clear();
  }

  #publish(e: Entry, snap: CutSnapshot): void {
    e.snapshot = snap;
    for (const cb of [...e.listeners]) cb(snap);
  }
}
