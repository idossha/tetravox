/**
 * UI-thread half of the §6.5 worker protocol.
 *
 * Owns one `Worker` per dataset (§5 rule 1) and speaks `Req` / `Res` / `Progress` / `Cancel` to it.
 *
 * * **Latest-wins** is keyed on the caller-supplied opaque `key` (`` `${layerId}:cut` ``) and drops
 *   *queued* requests only. The client keeps the queue itself and posts one request at a time, which
 *   is the only way the distinction is observable: once a `Req` is in the worker it is in flight.
 * * An in-flight WASM call **runs to completion** — WASM is not preemptible, and the app is not
 *   cross-origin isolated (§1), so `SharedArrayBuffer` is `undefined` in the worker and there is no
 *   buffer a second thread could write for the running call to poll.
 * * **The only cancellation mechanism is `worker.terminate()`.** `cancel()` on an in-flight
 *   `loadVolume` / `loadMesh` terminates the worker and synthesises
 *   `{ ok: false, error: { code: 'cancelled' } }`; every other op runs to completion and its result
 *   is discarded.
 * * A wasm `panic!` or `Error::OutOfMemory` **poisons the module**: tear the worker down, mark the
 *   dataset failed, emit `error`. Never retry into the same instance (§5 rule 8).
 * * `Req.args` buffers are **never** added to a transfer list unless the §6.5.2 op table marks the
 *   argument as donated. No op currently does — `isolate`'s `labelVolume` is structured-cloned,
 *   because transferring it would detach `VolumeDataset.data` and break every subsequent probe
 *   (§5 rule 2).
 * * Every successful `Res` carries `heapBytes` from `wasm_heap_bytes()`.
 *
 * A dropped or cancelled request **rejects** with its `WorkerError`, rather than hanging: a stale
 * latest-wins loser is a settled promise the caller can ignore, and a promise that never settles is
 * a leak in every `await` that holds it.
 */

import type {
  Cancel,
  FromWorker,
  OpArgs,
  OpName,
  OpResult,
  Phase,
  Progress,
  Req,
  Res,
  WorkerError,
} from '@tetravox/protocol';
import { isProgress } from '@tetravox/protocol';

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

/** A rejected §6.5 op, carrying the `WorkerError` verbatim so callers can switch on `code`. */
export class ComputeError extends Error {
  readonly code: WorkerError['code'];
  readonly op: OpName;

  constructor(op: OpName, error: WorkerError) {
    super(`${op}: ${error.message}`);
    this.name = 'ComputeError';
    this.code = error.code;
    this.op = op;
  }
}

/** The ops whose in-flight cancellation is a `worker.terminate()` (§5 rule 6). */
const TERMINATE_ON_CANCEL: ReadonlySet<OpName> = new Set<OpName>(['loadVolume', 'loadMesh']);

interface Entry {
  id: number;
  key: string;
  op: OpName;
  args: OpArgs[OpName];
  settle: (value: unknown) => void;
  fail: (error: ComputeError) => void;
  /** Cancelled while in flight: run to completion, then throw the result away (§6.5). */
  discard: boolean;
}

export class ComputeClient {
  readonly #worker: Worker;
  readonly #opts: ComputeClientOptions;
  readonly #queued: Entry[] = [];
  #inFlight: Entry | null = null;
  #nextId = 1;
  #heapBytes = 0;
  #lastTransfers = 0;
  #dead = false;

  constructor(opts: ComputeClientOptions) {
    this.#worker = opts.worker;
    this.#opts = opts;
    this.#worker.onmessage = (event: MessageEvent<FromWorker>): void => {
      this.#receive(event.data);
    };
  }

  /** Send an op. Latest-wins on `key`: a queued request with the same key is dropped. */
  call<K extends OpName>(key: string, op: K, args: OpArgs[K]): Promise<OpResult[K]> {
    return this.start(key, op, args).promise;
  }

  /**
   * Send an op and get its `id` alongside the promise, so it can be `cancel()`ed. `call` is this
   * without the bookkeeping.
   */
  start<K extends OpName>(key: string, op: K, args: OpArgs[K]): PendingRequest<K> {
    const id = this.#nextId;
    this.#nextId += 1;

    // Latest-wins: drop the *queued* request with the same key. The in-flight one, whatever its key,
    // runs to completion (§5 rule 6).
    for (let i = this.#queued.length - 1; i >= 0; i -= 1) {
      const q = this.#queued[i];
      if (q !== undefined && q.key === key) {
        this.#queued.splice(i, 1);
        this.#post({ kind: 'cancel', id: q.id } satisfies Cancel);
        q.fail(
          new ComputeError(q.op, {
            code: 'cancelled',
            message: `superseded on key ${JSON.stringify(key)}`,
          })
        );
      }
    }

    let settle: (value: unknown) => void = () => {};
    let fail: (error: ComputeError) => void = () => {};
    const promise = new Promise<OpResult[K]>((resolve, reject) => {
      settle = resolve as (value: unknown) => void;
      fail = reject;
    });
    const entry: Entry = { id, key, op, args, settle, fail, discard: false };

    if (this.#dead) {
      entry.fail(
        new ComputeError(op, { code: 'cancelled', message: 'the dataset worker is gone' })
      );
      return { id, key, op, promise };
    }

    this.#queued.push(entry);
    this.#pump();
    return { id, key, op, promise };
  }

  /**
   * Drop the queued request `id`, or — for an in-flight `loadVolume` / `loadMesh` — terminate the
   * worker and settle it as `{ code: 'cancelled' }` (§5 rule 6).
   */
  cancel(id: number): void {
    const at = this.#queued.findIndex((e) => e.id === id);
    if (at >= 0) {
      const entry = this.#queued.splice(at, 1)[0];
      this.#post({ kind: 'cancel', id } satisfies Cancel);
      if (entry !== undefined) {
        entry.fail(new ComputeError(entry.op, { code: 'cancelled', message: 'cancelled' }));
      }
      return;
    }
    const flight = this.#inFlight;
    if (flight === null || flight.id !== id) return;

    if (TERMINATE_ON_CANCEL.has(flight.op)) {
      // A load has nothing worth keeping, so terminating is free — and it is the same primitive that
      // reclaims the worker's linear memory (§5 rule 1).
      this.#tearDown({ code: 'cancelled', message: 'cancelled' });
      return;
    }
    // Everything else runs to completion; the result is discarded when it lands.
    flight.discard = true;
    this.#post({ kind: 'cancel', id } satisfies Cancel);
  }

  /** The last `heapBytes` stamped onto a successful `Res`; backs the §9 memory bar. */
  get heapBytes(): number {
    return this.#heapBytes;
  }

  /**
   * How many `ArrayBuffer`s the last successful `Res` moved rather than copied. Zero is correct for
   * a result with no bulk arrays and for the recycled `cut` path, whose pool stays in the worker
   * (§6.4); anything carrying geometry or samples should be non-zero.
   */
  get lastTransfers(): number {
    return this.#lastTransfers;
  }

  /** False once the worker has been terminated — by `cancel`, by poisoning, or by `terminate`. */
  get alive(): boolean {
    return !this.#dead;
  }

  /** Requests neither settled nor in flight yet. */
  get queuedCount(): number {
    return this.#queued.length;
  }

  /** `worker.terminate()`. The only way to give wasm linear memory back (§5 rule 1). */
  terminate(): void {
    this.#tearDown({ code: 'cancelled', message: 'the dataset worker was terminated' });
  }

  // -------------------------------------------------------------------------------------------
  // The 18 ops (§6.5.2), one typed method each. Every one is `call` with the op name filled in.
  // -------------------------------------------------------------------------------------------

  loadVolume(key: string, a: OpArgs['loadVolume']): Promise<OpResult['loadVolume']> {
    return this.call(key, 'loadVolume', a);
  }
  loadMesh(key: string, a: OpArgs['loadMesh']): Promise<OpResult['loadMesh']> {
    return this.call(key, 'loadMesh', a);
  }
  volumeFrame(key: string, a: OpArgs['volumeFrame']): Promise<OpResult['volumeFrame']> {
    return this.call(key, 'volumeFrame', a);
  }
  surface(key: string, a: OpArgs['surface']): Promise<OpResult['surface']> {
    return this.call(key, 'surface', a);
  }
  boundary(key: string, a: OpArgs['boundary']): Promise<OpResult['boundary']> {
    return this.call(key, 'boundary', a);
  }
  buildTopology(key: string, a: OpArgs['buildTopology']): Promise<OpResult['buildTopology']> {
    return this.call(key, 'buildTopology', a);
  }
  cut(key: string, a: OpArgs['cut']): Promise<OpResult['cut']> {
    return this.call(key, 'cut', a);
  }
  isolate(key: string, a: OpArgs['isolate']): Promise<OpResult['isolate']> {
    return this.call(key, 'isolate', a);
  }
  field(key: string, a: OpArgs['field']): Promise<OpResult['field']> {
    return this.call(key, 'field', a);
  }
  elmToNode(key: string, a: OpArgs['elmToNode']): Promise<OpResult['elmToNode']> {
    return this.call(key, 'elmToNode', a);
  }
  locate(key: string, a: OpArgs['locate']): Promise<OpResult['locate']> {
    return this.call(key, 'locate', a);
  }
  marchingCubes(key: string, a: OpArgs['marchingCubes']): Promise<OpResult['marchingCubes']> {
    return this.call(key, 'marchingCubes', a);
  }
  marchingTets(key: string, a: OpArgs['marchingTets']): Promise<OpResult['marchingTets']> {
    return this.call(key, 'marchingTets', a);
  }
  contours(key: string, a: OpArgs['contours']): Promise<OpResult['contours']> {
    return this.call(key, 'contours', a);
  }
  labelCentroids(key: string, a: OpArgs['labelCentroids']): Promise<OpResult['labelCentroids']> {
    return this.call(key, 'labelCentroids', a);
  }
  meshCentroids(key: string, a: OpArgs['meshCentroids']): Promise<OpResult['meshCentroids']> {
    return this.call(key, 'meshCentroids', a);
  }
  free(key: string, a: OpArgs['free']): Promise<OpResult['free']> {
    return this.call(key, 'free', a);
  }
  freeMask(key: string, a: OpArgs['freeMask']): Promise<OpResult['freeMask']> {
    return this.call(key, 'freeMask', a);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  #post(message: Req | Cancel): void {
    if (this.#dead) return;
    // No transfer list, ever: §5 rule 2 — no §6.5.2 op marks an argument as donated, and
    // transferring `isolate`'s `labelVolume` would detach the UI thread's probe array.
    this.#worker.postMessage(message);
  }

  #pump(): void {
    if (this.#dead || this.#inFlight !== null) return;
    const next = this.#queued.shift();
    if (next === undefined) return;
    this.#inFlight = next;
    this.#post({ id: next.id, key: next.key, op: next.op, args: next.args } satisfies Req);
  }

  #receive(message: FromWorker): void {
    if (isProgress(message)) {
      const p: Progress = message;
      this.#opts.onProgress?.(p.id, p.phase, p.done, p.total);
      return;
    }
    const res: Res = message;
    const flight = this.#inFlight;
    if (flight === null || flight.id !== res.id) {
      // A late answer to something already settled — a queued request the worker dropped after the
      // client had already rejected it, or the tail of a terminated load.
      return;
    }
    this.#inFlight = null;

    if (!res.ok) {
      const error = res.error;
      if (error.code === 'panic' || error.code === 'oom') {
        // §5 rule 8: the instance is poisoned. Never call into it again.
        flight.fail(new ComputeError(flight.op, error));
        this.#tearDown({ code: 'cancelled', message: 'the module was poisoned' }, flight);
        this.#opts.onPoisoned?.(error);
        return;
      }
      flight.fail(new ComputeError(flight.op, error));
      this.#pump();
      return;
    }

    this.#heapBytes = res.heapBytes;
    this.#lastTransfers = res.transfer.length;
    this.#opts.onHeapBytes?.(res.heapBytes);
    if (flight.discard) {
      flight.fail(new ComputeError(flight.op, { code: 'cancelled', message: 'cancelled' }));
    } else {
      flight.settle(res.result);
    }
    this.#pump();
  }

  #tearDown(error: WorkerError, alreadySettled?: Entry): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#worker.terminate();
    const flight = this.#inFlight;
    this.#inFlight = null;
    if (flight !== null && flight !== alreadySettled) {
      flight.fail(new ComputeError(flight.op, error));
    }
    while (this.#queued.length > 0) {
      const q = this.#queued.shift();
      if (q !== undefined) q.fail(new ComputeError(q.op, error));
    }
  }
}
