/**
 * The Phase-0 module Worker (ROADMAP Phase-0 gate 3).
 *
 * It runs under the `tetravox://app` origin, instantiates the wasm-pack module by **streaming fetch**
 * of a `application/wasm` response, calls real `tvx-wasm` exports, fetches a file over
 * `tetravox://file/…` and hands those bytes to WASM. Raw bytes never reach the UI thread.
 *
 * Phase 1 replaces this with `@tetravox/wasm`'s `startComputeWorker` and the §6.5 envelope; the shape
 * of the round-trip — spawn, fetch, instantiate, call, post back — is the same.
 */

/// <reference lib="webworker" />

import init, { tvx_ping, tvx_ping_bytes, tvx_version } from '@tetravox/wasm/pkg';
import type { WorkerRequest, WorkerResponse } from '../src/phase0';

declare const self: DedicatedWorkerGlobalScope;

let wasmContentType: string | null = null;
let streamed = false;

/**
 * wasm-pack's `--target web` glue calls `WebAssembly.instantiateStreaming` and *silently* falls back
 * to `arrayBuffer()` when the MIME type is wrong. Wrapping it is the only way to observe which path
 * ran, and observing it is the point: the gate is that `protocol.handle` serves `application/wasm`.
 */
function observeStreaming(): void {
  const native = WebAssembly.instantiateStreaming;
  if (typeof native !== 'function') return;
  WebAssembly.instantiateStreaming = async (source, imports) => {
    const response = await source;
    wasmContentType = response.headers.get('content-type');
    const result = await native.call(WebAssembly, response, imports);
    streamed = true;
    return result;
  };
}

async function run(request: WorkerRequest): Promise<WorkerResponse> {
  observeStreaming();
  await init();

  let fileBytes: number | null = null;
  let fileDigest: number | null = null;
  if (request.fileUrl !== null) {
    const response = await fetch(request.fileUrl);
    if (!response.ok) throw new Error(`${request.fileUrl} -> ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    fileBytes = bytes.byteLength;
    fileDigest = tvx_ping_bytes(bytes);
  }

  return {
    kind: 'ready',
    ping: tvx_ping(request.seed),
    version: tvx_version(),
    wasmContentType,
    streamed,
    origin: self.location.origin,
    crossOriginIsolated: self.crossOriginIsolated,
    fileBytes,
    fileDigest,
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  void run(event.data).then(
    (message) => self.postMessage(message),
    (error: unknown) =>
      self.postMessage({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse)
  );
};
