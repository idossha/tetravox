/**
 * The dataset worker, one per dataset (§5 rule 1).
 *
 * Its whole body is `startComputeWorker(self)`: the §6.5 protocol implementation lives in
 * `@tetravox/wasm`, and this file exists only so the engine has a module URL to hand `new Worker`.
 * It is the same entry `packages/wasm`'s own e2e boots, so the two exercise one code path.
 */

/// <reference lib="webworker" />

import { startComputeWorker } from '@tetravox/wasm/worker';

declare const self: DedicatedWorkerGlobalScope;

startComputeWorker(self);
