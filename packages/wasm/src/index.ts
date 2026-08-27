/**
 * `@tetravox/wasm` — the compute client interface.
 *
 * FROZEN at the end of Phase 0 (§12.3 item 4). The hand-written package wraps the generated
 * `./pkg/tvx_wasm.js` (wasm-pack output, git-ignored except the committed `pkg/tvx_wasm.d.ts` stub, so
 * `tsc` works before the first wasm build).
 *
 * One worker + one wasm instance **per dataset** (§5 rule 1). Closing a dataset is
 * `worker.terminate()` — that is the only way to give wasm linear memory back, and it is also the only
 * cancellation mechanism (§5 rule 6).
 */

export type { ComputeClientOptions, PendingRequest } from './compute-client';
export { ComputeClient } from './compute-client';
