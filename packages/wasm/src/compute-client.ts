/**
 * UI-thread half of the §6.5 worker protocol.
 *
 * Owns one `Worker` per dataset (§5 rule 1) and speaks `Req` / `Res` / `Progress` / `Cancel` to it.
 *
 * Phase-1 behaviour this shape exists to carry (§5 rule 6, §6.5 lifecycle rules):
 * * **Latest-wins** is keyed on the caller-supplied opaque `key` (`` `${layerId}:cut` ``) and drops
 *   *queued* requests only.
 * * An in-flight WASM call **runs to completion** — WASM is not preemptible, and the app is not
 *   cross-origin isolated (§1), so `SharedArrayBuffer` is `undefined` in the worker and there is no
 *   buffer a second thread could write for the running call to poll.
 * * **The only cancellation mechanism is `worker.terminate()`.** `cancel()` on an in-flight
 *   `loadVolume` / `loadMesh` terminates the worker and synthesises
 *   `{ ok: false, error: { code: 'cancelled' } }`; every other op runs to completion and its result is
 *   discarded.
 * * A wasm `panic!` or `Error::OutOfMemory` **poisons the module**: tear the worker down, mark the
 *   dataset failed, emit `error`. Never retry into the same instance (§5 rule 8).
 * * `Req.args` buffers are **never** added to a transfer list unless the §6.5.2 op table marks the
 *   argument as donated. No op currently does — `isolate`'s `labelVolume` is structured-cloned, because
 *   transferring it would detach `VolumeDataset.data` and break every subsequent probe (§5 rule 2).
 * * Every successful `Res` carries `heapBytes` from `wasm_heap_bytes()`.
 */

import type { OpArgs, OpName, OpResult, Phase, WorkerError } from '@tetravox/protocol';

export interface ComputeClientOptions {
  /** Module `Worker` under the `tetravox://` origin (§5). */
  worker: Worker;
  onProgress?: (id: number, phase: Phase, done: number, total: number) => void;
  onHeapBytes?: (bytes: number) => void;
  /** Called when the module is poisoned (panic / OOM) and the worker has been torn down. */
  onPoisoned?: (error: WorkerError) => void;
}

export interface PendingRequest<K extends OpName = OpName> {
  id: number;
  key: string;
  op: K;
  promise: Promise<OpResult[K]>;
}

export class ComputeClient {
  constructor(opts: ComputeClientOptions) {
    void opts;
    throw new Error('phase 1');
  }

  /** Send an op. Latest-wins on `key`: a queued request with the same key is dropped. */
  call<K extends OpName>(key: string, op: K, args: OpArgs[K]): Promise<OpResult[K]> {
    void key;
    void op;
    void args;
    throw new Error('phase 1');
  }

  /**
   * Drop the queued request `id`, or — for an in-flight `loadVolume` / `loadMesh` — terminate the
   * worker and settle it as `{ code: 'cancelled' }` (§5 rule 6).
   */
  cancel(id: number): void {
    void id;
    throw new Error('phase 1');
  }

  /** The last `heapBytes` stamped onto a successful `Res`; backs the §9 memory bar. */
  get heapBytes(): number {
    throw new Error('phase 1');
  }

  /** `worker.terminate()`. The only way to give wasm linear memory back (§5 rule 1). */
  terminate(): void {
    throw new Error('phase 1');
  }
}
