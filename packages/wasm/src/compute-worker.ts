/**
 * Worker-thread half of the §6.5 protocol: a module `Worker` under the `tetravox://` origin, owning
 * exactly one wasm instance and one parsed dataset by handle (§5).
 *
 * Phase-1 behaviour this shape exists to carry:
 * * `fetch('tetravox://file/…')` → `DecompressionStream('gzip')` when `.gz` → `Uint8Array` → WASM.
 *   **Raw file bytes never touch the UI thread and never cross IPC** (§5 rule 3, AGENTS rule 7).
 * * The worker also fetches the **sidecars**, keyed by role: `sidecars.lut` → `lut_bytes`,
 *   `sidecars.opt` → `opt_bytes` (§6.5.1). The crates never touch the filesystem.
 * * Input bytes are copied into WASM **once** and the input buffer is dropped before the parser
 *   returns; the inflate output is dropped too (§5 rule 5).
 * * Results are **owned buffers, never views** onto `wasm.memory.buffer`: `memory.grow` detaches every
 *   outstanding view (§6.4). `Vec<T>` results come back already `.slice()`d, so `result.buffer` is
 *   transferred as-is with no second copy.
 * * The worker owns the `CutOut` pool for the recycled `cut` path and grows it by doubling on
 *   `truncated: true`, then re-calls (§6.4). A partially-filled pool is never returned.
 * * `wasm_heap_bytes()` is read after every call and stamped onto the `Res`.
 * * There is no abort flag: `SharedArrayBuffer` is `undefined` here (not cross-origin isolated, §1), and
 *   while a synchronous wasm call runs the worker's event loop cannot process a `Cancel` anyway.
 */

import type { FromWorker, OpName, Req, ToWorker } from '@tetravox/protocol';

/** Install the `message` handler on `self`. Phase 1 wires it to the §6.4 exports via `OP_TO_EXPORT`. */
export function startComputeWorker(scope: DedicatedWorkerGlobalScope): void {
  void scope;
  throw new Error('phase 1');
}

/** Dispatch one request to its §6.4 wasm export and post the `Res` with its transfer list. */
export function handleRequest<K extends OpName>(req: Req<K>): Promise<FromWorker> {
  void req;
  throw new Error('phase 1');
}

/** Narrowed `self.onmessage` payload type, for the Phase-1 implementation to reuse. */
export type IncomingMessage = MessageEvent<ToWorker>;
