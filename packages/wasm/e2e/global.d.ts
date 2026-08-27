/**
 * The harness bridge, as a spec sees it inside `page.evaluate`.
 *
 * Declared structurally rather than imported from `pages/harness.ts`: the spec runs in Node and the
 * harness runs in the page, and importing the page module into the spec would pull `ComputeClient`
 * and the wasm glue into the test runner for no reason.
 */

import type { OpArgs, OpName, Phase } from '@tetravox/protocol';

declare global {
  interface TvxProgressRecord {
    id: number;
    phase: Phase;
    done: number;
    total: number;
  }

  interface TvxCallOutcome {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
    heapBytes: number;
    progress: TvxProgressRecord[];
    firstProgressMs: number;
    elapsedMs: number;
  }

  interface TvxHarness {
    open(): void;
    close(): void;
    call<K extends OpName>(op: K, args: OpArgs[K], key?: string): Promise<TvxCallOutcome>;
    sample(path: string, indices: number[]): number[];
    sampleData(dtype: string, indices: number[]): number[];
    buffersAttached(): boolean;
    heapBytes(): number;
    transfers(): number;
    start<K extends OpName>(op: K, args: OpArgs[K], key?: string): number;
    settle(): Promise<{ ok: boolean; code?: string; elapsedMs: number }>;
    waitForProgress(timeoutMs?: number): Promise<number>;
    cancel(id: number): void;
    progress(): TvxProgressRecord[];
    alive(): boolean;
  }

  interface Window {
    __tvx: TvxHarness;
  }
}

export {};
