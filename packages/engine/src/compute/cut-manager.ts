/**
 * `CutManager` — the single owner of one mesh dataset's `cut` op (§6.5.2, `mesh_cut` in §6.4).
 *
 * **Why one owner rather than two callers.** The exact per-element cut polygons `plane_cut` returns
 * feed *two* unrelated consumers:
 *
 * * the **3D caps** of §7.4 (positions / `ownerTet` / `tag` / `edgeMask` / `interpNodes` / `interpT`),
 *   drawn in the same pass as their owning layer, with that layer's opacity; and
 * * the **2D overlay** of §7.4's last bullet — `Cut.edge_segments` for `contoursIn2D`, and the cut
 *   polygons themselves for `fillIn2D`.
 *
 * §7.4 says so explicitly: "`Cut.edge_segments` is **not** used in the 3D passes — it exists for the
 * 2D overlay". Two consumers issuing their own `cut` for the same planes would double the 2.7 ms
 * (12.9 ms in wasm `[M2Max]`) per drag frame and could disagree about which cut is current. So they
 * both read {@link CutManager.current}, and only this class asks.
 *
 * **Latest-wins is the only drag mechanism** (§5 rule 6, §7.4). `plane_cut` stays *exact, always* —
 * there is no coarse-while-held proxy, because it would add a visible pop on release and a second
 * code path to the feature the product is judged on.
 *
 * **Phase 2 (owner: E-MESH) fills in the GPU side**: the double-buffered, `bufferSubData`-after-
 * orphaning VBO set of §7.4's "Cap upload", grown by doubling and never shrunk during a drag. This
 * class already owns the request lifecycle, the `CutOut` recycle protocol and the current arrays,
 * which is everything that decides *when* those buffers are written.
 */

import type { CutCounts, CutPayload, OpArgs, OpResult, PlaneT } from '@tetravox/protocol';

/**
 * The slice of `ComputeClient` a cut needs.
 *
 * Narrow on purpose: it is what lets the unit tests drive this class with a fake worker, and it
 * documents that a manager may issue exactly one op.
 */
export interface CutClient {
  call(key: string, op: 'cut', args: OpArgs['cut']): Promise<OpResult['cut']>;
}

/** The cut currently on screen. `generation` increments once per landed result. */
export interface CutState {
  generation: number;
  /** The planes this cut was computed for — §7.4 allows at most 6. */
  planes: PlaneT[];
  maskId: number | undefined;
  /** One entry per plane that produced geometry. */
  cuts: CutPayload[];
}

/** §7.4: "up to 6 world-space planes". */
export const MAX_CUT_PLANES = 6;

function samePlanes(a: readonly PlaneT[], b: readonly PlaneT[]): boolean {
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

export class CutManager {
  readonly #client: CutClient;
  readonly #handle: number;
  /** §5 rule 6's latest-wins key, `"${datasetId}:cut"`. */
  readonly #key: string;

  /** Monotonic; a result whose ticket is not the newest is dropped, never applied. */
  #ticket = 0;
  #latest = 0;
  #requested: { planes: PlaneT[]; maskId: number | undefined } | null = null;
  #state: CutState | null = null;
  #generation = 0;
  #disposed = false;
  readonly #listeners = new Set<(state: CutState | null) => void>();

  /**
   * The `CutOut` pool (§6.4) lives in the **worker**; `recycle: true` is how a request asks for it.
   * The pool is per mesh dataset because the worker is, and this flag is the client's half of the
   * contract: a `mode: 'recycled'` reply with `truncated: true` means the pool was too small,
   * **nothing was written**, and `counts` are the required sizes.
   */
  #recycle = true;

  constructor(client: CutClient, handle: number, key: string) {
    this.#client = client;
    this.#handle = handle;
    this.#key = key;
  }

  /** The cut the consumers should draw, or `null` before the first result lands. */
  current(): CutState | null {
    return this.#state;
  }

  /** `Cut.edge_segments` for every plane — the 2D `contoursIn2D` consumer's input (§7.4). */
  edgeSegments(): Float32Array[] {
    return (this.#state?.cuts ?? []).map((c) => c.edgeSegments);
  }

  /** The cut polygons themselves — the `fillIn2D` consumer's input (§7.4). */
  capPolygons(): CutPayload[] {
    return this.#state?.cuts ?? [];
  }

  /** Called whenever {@link current} changes. Returns an unsubscribe. */
  subscribe(cb: (state: CutState | null) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /**
   * Ask for a cut. Latest-wins: a request that arrives while one is in flight supersedes it, and the
   * superseded result is **dropped rather than applied** — the in-flight WASM call itself runs to
   * completion, because WASM is not preemptible (§5 rule 6).
   *
   * Re-requesting the identical plane set is a no-op, which is what keeps a re-render during a drag
   * from re-cutting geometry that has not moved.
   */
  request(planes: readonly PlaneT[], maskId?: number): void {
    if (this.#disposed) return;
    if (planes.length > MAX_CUT_PLANES) {
      throw new Error(`§7.4 allows at most ${MAX_CUT_PLANES} clip planes, got ${planes.length}`);
    }
    if (
      this.#requested !== null &&
      this.#requested.maskId === maskId &&
      samePlanes(this.#requested.planes, planes)
    ) {
      return;
    }
    const next = { planes: [...planes], maskId };
    this.#requested = next;
    if (planes.length === 0) {
      // No planes is not a cut with zero triangles; it is *no cut*, and the consumers must stop
      // drawing caps rather than keep the last ones.
      this.#latest = ++this.#ticket;
      this.#publish(null);
      return;
    }
    void this.#issue(next, this.#recycle);
  }

  async #issue(
    req: { planes: PlaneT[]; maskId: number | undefined },
    recycle: boolean
  ): Promise<void> {
    const ticket = ++this.#ticket;
    this.#latest = ticket;
    let res: OpResult['cut'];
    try {
      res = await this.#client.call(this.#key, 'cut', {
        handle: this.#handle,
        planes: req.planes,
        maskId: req.maskId,
        recycle,
      });
    } catch {
      // A superseded or cancelled cut is normal under latest-wins; it is not an error (§5 rule 6).
      return;
    }
    if (this.#disposed || ticket !== this.#latest) return;

    if (res.mode === 'buffers') {
      this.#publish({
        generation: ++this.#generation,
        planes: req.planes,
        maskId: req.maskId,
        cuts: res.cuts,
      });
      return;
    }
    // `mode: 'recycled'` (§6.4). `truncated` means the worker's `CutOut` pool was too small and
    // **nothing was written** — `counts` are the required sizes, so the only correct response is to
    // ask again without recycling and let the worker return owned buffers.
    if (res.truncated) {
      this.#recycle = false;
      this.#growHint(res.counts);
      await this.#issue(req, false);
      return;
    }
    // A non-truncated recycled reply means the pool holds the geometry; the GPU-side reader takes it
    // from the worker's pool rather than from a payload.
    // PHASE 2 (E-MESH): read the pooled arrays into the double-buffered cap VBO set (§7.4).
    this.#publish({
      generation: ++this.#generation,
      planes: req.planes,
      maskId: req.maskId,
      cuts: [],
    });
  }

  /**
   * Record the sizes a truncated recycle reported.
   *
   * §7.4's buffers "grow by doubling and never shrink during a drag", so the required counts are a
   * floor for the next allocation rather than an exact size.
   */
  #growHint(counts: readonly CutCounts[]): void {
    this.#required = counts.map((c) => ({ ...c }));
  }

  #required: CutCounts[] = [];

  /** The sizes the last truncated recycle asked for — the floor for the Phase-2 cap VBO set. */
  requiredCounts(): readonly CutCounts[] {
    return this.#required;
  }

  /** True while requests still ask the worker to use its `CutOut` pool (§6.4). */
  get recycling(): boolean {
    return this.#recycle;
  }

  #publish(state: CutState | null): void {
    this.#state = state;
    for (const cb of [...this.#listeners]) cb(state);
  }

  /**
   * Drop the current cut and stop applying results.
   *
   * The worker's pool goes with the worker (§5 rule 1: closing a dataset is `worker.terminate()`),
   * so there is nothing to free here.
   */
  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    this.#state = null;
    this.#requested = null;
  }
}
