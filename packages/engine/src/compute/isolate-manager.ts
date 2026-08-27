/**
 * `IsolateManager` — the single owner of one mesh dataset's `isolate` op (§6.5.2, `mesh_isolate`).
 *
 * §6.5.2: "**The client owns `maskId` and must `freeMask`.**" That sentence is why this class
 * exists. A `maskId` is a worker-side allocation with no owner in the scene graph, and the two
 * things that consume it — §7.4's surface cache key `(dataset, maskId, clip state)` and the `cut` /
 * `contours` ops, which both take an optional `maskId` — must agree on *which* mask is current or
 * they render two different subsets of the same mesh.
 *
 * Three rules it enforces:
 *
 * 1. **Latest-wins** on `isolate:<datasetId>` (§5 rule 6). A superseded result is dropped, and its
 *    mask is freed rather than leaked.
 * 2. **The previous mask is freed when a new one lands**, never before — the old geometry stays on
 *    screen until the new mask exists.
 * 3. `generation` from the result is carried, not recomputed: §6.5.2 makes it part of the cache key
 *    so "a re-isolation to a numerically identical mask still invalidates cached geometry"
 *    (`gl/resources.ts`).
 *
 * The label-volume criterion is the one cross-dataset op in v1 (§5 rule 2). Its samples travel as
 * the separate `labelVolume` argument and are **structured-cloned, never transferred**: transferring
 * would detach `VolumeDataset.data` and break every subsequent probe on that volume.
 *
 * **Phase 2 (owner: E-MESH) fills in the consumers**: invalidating both surface variants on a mask
 * change and re-uploading the boundary of the isolated sub-mesh. This class already owns the
 * lifecycle, which is the part that leaks if it is written twice.
 */

import type { IsolateCriteriaT, OpArgs, OpResult } from '@tetravox/protocol';

/** The slice of `ComputeClient` an isolation needs — narrow, so a test can fake it. */
export interface IsolateClient {
  call(key: string, op: 'isolate', args: OpArgs['isolate']): Promise<OpResult['isolate']>;
  call(key: string, op: 'freeMask', args: OpArgs['freeMask']): Promise<OpResult['freeMask']>;
}

/** The mask currently in force. */
export interface IsolateState {
  maskId: number;
  visibleTets: number;
  /** §6.5.2's lifecycle counter — part of the §7.4 geometry cache key. */
  generation: number;
  criteria: IsolateCriteriaT;
}

export class IsolateManager {
  readonly #client: IsolateClient;
  readonly #handle: number;
  readonly #key: string;

  #ticket = 0;
  #latest = 0;
  #state: IsolateState | null = null;
  #disposed = false;
  readonly #listeners = new Set<(state: IsolateState | null) => void>();

  constructor(client: IsolateClient, handle: number, key: string) {
    this.#client = client;
    this.#handle = handle;
    this.#key = key;
  }

  /** The mask in force, or `null` when the whole mesh is visible. */
  current(): IsolateState | null {
    return this.#state;
  }

  /** The `maskId` to pass to `surface` / `boundary` / `cut` / `contours`, or `undefined` for none. */
  maskId(): number | undefined {
    return this.#state?.maskId;
  }

  /** The §7.4 cache-key suffix: `maskId` **and** `generation`, because ids are reused. */
  cacheKey(): string {
    const s = this.#state;
    return s === null ? '' : `${s.maskId}|${s.generation}`;
  }

  subscribe(cb: (state: IsolateState | null) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /**
   * Isolate by `criteria`.
   *
   * `labelVolume` is required iff `criteria.labelVolume` is set, and is passed **without** a
   * transfer list (§5 rule 2) — the engine hands over a structured clone of the volume the UI thread
   * keeps for probes, and detaching it would break every probe after the first.
   */
  async isolate(criteria: IsolateCriteriaT, labelVolume?: ArrayBuffer): Promise<void> {
    if (this.#disposed) return;
    const ticket = ++this.#ticket;
    this.#latest = ticket;
    let res: OpResult['isolate'];
    try {
      res = await this.#client.call(this.#key, 'isolate', {
        handle: this.#handle,
        criteria,
        labelVolume,
      });
    } catch {
      // A superseded or cancelled isolation is normal under latest-wins; it is not an error.
      return;
    }
    if (this.#disposed || ticket !== this.#latest) {
      // A mask this manager will never use is still a worker allocation it owns (§6.5.2).
      void this.#free(res.maskId);
      return;
    }
    const previous = this.#state;
    this.#state = {
      maskId: res.maskId,
      visibleTets: res.visibleTets,
      generation: res.generation,
      criteria,
    };
    // Freed **after** the new mask lands, so the old geometry stays on screen until it is replaced.
    if (previous !== null) void this.#free(previous.maskId);
    this.#publish(this.#state);
  }

  /** Drop the isolation and free its mask: the whole mesh becomes visible again. */
  async clear(): Promise<void> {
    this.#latest = ++this.#ticket;
    const previous = this.#state;
    this.#state = null;
    this.#publish(null);
    if (previous !== null) await this.#free(previous.maskId);
  }

  async #free(maskId: number): Promise<void> {
    try {
      await this.#client.call(this.#key, 'freeMask', { handle: this.#handle, maskId });
    } catch {
      // The worker may already be gone — closing a dataset is `worker.terminate()` (§5 rule 1), and
      // "masks are also dropped when the mesh handle is freed" (§6.5.2).
    }
  }

  #publish(state: IsolateState | null): void {
    for (const cb of [...this.#listeners]) cb(state);
  }

  /**
   * Stop applying results and give back every mask this manager owns.
   *
   * The mask **is** freed here, fire-and-forget. `dispose` runs from `removeLayer` as well as from
   * `removeDataset`: the first leaves the worker alive, so not freeing would leak a worker-side
   * allocation with no owner left to reclaim it; the second has already terminated the worker, where
   * §6.5.2's "masks are also dropped when the mesh handle is freed" applies and the rejected message
   * is swallowed by {@link IsolateManager.#free}.
   */
  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    const previous = this.#state;
    this.#state = null;
    if (previous !== null) void this.#free(previous.maskId);
  }
}
