/**
 * The real dataset worker, as the app spawns it: a module `Worker` whose whole body is
 * `startComputeWorker(self)` (§5, §6.5).
 *
 * The e2e suite boots exactly this — not a stub, not a mock — so what it exercises is the module
 * `pnpm wasm` built, instantiated by streaming fetch, over the committed fixtures.
 */

/// <reference lib="webworker" />

import { startComputeWorker } from '../src/compute-worker';

declare const self: DedicatedWorkerGlobalScope;

startComputeWorker(self);
