/**
 * The page the §6.5 e2e drives: one `ComputeClient` over one real module `Worker`, plus just enough
 * of a bridge for a Playwright spec to assert **numbers**.
 *
 * Playwright's `evaluate` serialises with structured clone through JSON-ish rules, and a
 * `Float32Array` does not survive it intact. So the bridge keeps the raw result in the page and
 * hands the spec two things: a JSON-safe *shape* (lengths, sums, exact min/max) and `sample()`, an
 * element read by dotted path. Every assertion in the spec is then a number the spec can compare
 * against `testdata/manifest.json` or AGENTS.md, never a picture and never a shape check (§11).
 */

import type { OpArgs, OpName, OpResult, Phase } from '@tetravox/protocol';

import { ComputeClient } from '../../src/compute-client';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface ProgressRecord {
  id: number;
  phase: Phase;
  done: number;
  total: number;
}

interface CallOutcome {
  ok: boolean;
  result?: Json;
  error?: { code: string; message: string };
  heapBytes: number;
  progress: ProgressRecord[];
  /** Wall-clock ms from `call()` to the first `Progress` — §9.1 row 6's "visible within 200 ms". */
  firstProgressMs: number;
  /** Wall-clock ms from `call()` to the settled promise. */
  elapsedMs: number;
}

const TYPED = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
] as const;

function typedName(v: object): string | null {
  const name = v.constructor.name;
  return (TYPED as readonly string[]).includes(name) ? name : null;
}

/** A typed array as numbers a spec can assert: exact length, exact ends, exact extrema and sum. */
function summarise(v: ArrayLike<number> & { length: number }, kind: string): Json {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let nonFinite = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] as number;
    if (Number.isFinite(x)) {
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x;
    } else {
      nonFinite += 1;
    }
  }
  const head: number[] = [];
  for (let i = 0; i < Math.min(8, v.length); i += 1) head.push(v[i] as number);
  return {
    kind,
    length: v.length,
    head,
    min: v.length > 0 && min !== Number.POSITIVE_INFINITY ? min : 0,
    max: v.length > 0 && max !== Number.NEGATIVE_INFINITY ? max : 0,
    sum,
    nonFinite,
  };
}

function jsonSafe(value: unknown, depth = 0): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value !== 'object' || depth > 8) return String(value);
  if (value instanceof ArrayBuffer) return { kind: 'ArrayBuffer', byteLength: value.byteLength };
  const name = typedName(value);
  if (name !== null) return summarise(value as unknown as Uint8Array, name);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1));
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v, depth + 1);
  return out;
}

/** `a.b.0.c` into the last raw result. */
function at(root: unknown, path: string): unknown {
  if (path === '') return root;
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const DTYPE_VIEW: Record<string, (b: ArrayBuffer) => ArrayLike<number>> = {
  u8: (b) => new Uint8Array(b),
  i8: (b) => new Int8Array(b),
  u16: (b) => new Uint16Array(b),
  i16: (b) => new Int16Array(b),
  u32: (b) => new Uint32Array(b),
  i32: (b) => new Int32Array(b),
  f32: (b) => new Float32Array(b),
  f64: (b) => new Float64Array(b),
  rgb24: (b) => new Uint8Array(b),
  rgba32: (b) => new Uint8Array(b),
};

class Harness {
  #client: ComputeClient | null = null;
  #last: unknown = null;
  #progress: ProgressRecord[] = [];
  #heap = 0;
  #t0 = 0;
  #firstProgressMs = -1;

  open(): void {
    this.close();
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    this.#client = new ComputeClient({
      worker,
      onProgress: (id, phase, done, total) => {
        if (this.#firstProgressMs < 0) this.#firstProgressMs = performance.now() - this.#t0;
        this.#progress.push({ id, phase, done, total });
      },
      onHeapBytes: (b) => {
        this.#heap = b;
      },
    });
  }

  close(): void {
    this.#client?.terminate();
    this.#client = null;
    this.#last = null;
    this.#progress = [];
  }

  async call<K extends OpName>(op: K, args: OpArgs[K], key = 'e2e'): Promise<CallOutcome> {
    if (this.#client === null) this.open();
    this.#progress = [];
    this.#firstProgressMs = -1;
    this.#t0 = performance.now();
    const client = this.#client as ComputeClient;
    try {
      const result = (await client.call(key, op, args)) as OpResult[K];
      this.#last = result;
      return {
        ok: true,
        result: jsonSafe(result),
        heapBytes: this.#heap,
        progress: this.#progress,
        firstProgressMs: this.#firstProgressMs,
        elapsedMs: performance.now() - this.#t0,
      };
    } catch (cause) {
      const code = (cause as { code?: string }).code ?? 'panic';
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        error: { code, message },
        heapBytes: this.#heap,
        progress: this.#progress,
        firstProgressMs: this.#firstProgressMs,
        elapsedMs: performance.now() - this.#t0,
      };
    }
  }

  /** Elements of a typed array in the last result, by dotted path. */
  sample(path: string, indices: number[]): number[] {
    const target = at(this.#last, path);
    if (target === null || typeof target !== 'object') return [];
    const array = target as unknown as ArrayLike<number>;
    return indices.map((i) => array[i] as number);
  }

  /** Elements of the last `loadVolume`'s raw `data` buffer, read through the meta's dtype. */
  sampleData(dtype: string, indices: number[]): number[] {
    const buffer = at(this.#last, 'data');
    const make = DTYPE_VIEW[dtype];
    if (!(buffer instanceof ArrayBuffer) || make === undefined) return [];
    const view = make(buffer);
    return indices.map((i) => view[i] as number);
  }

  /** `true` when the last result's `data`/`gpuBytes` arrived as real (non-detached) buffers. */
  buffersAttached(): boolean {
    for (const path of ['data', 'gpuBytes']) {
      const b = at(this.#last, path);
      if (b instanceof ArrayBuffer && b.byteLength === 0) return false;
    }
    return true;
  }

  heapBytes(): number {
    return this.#heap;
  }

  /** Buffers the last successful `Res` moved rather than copied (§6.4). */
  transfers(): number {
    return this.#client?.lastTransfers ?? -1;
  }

  /** Start a request without awaiting it, so a spec can cancel it. Returns the request id. */
  start<K extends OpName>(op: K, args: OpArgs[K], key = 'e2e'): number {
    if (this.#client === null) this.open();
    this.#progress = [];
    this.#firstProgressMs = -1;
    this.#t0 = performance.now();
    const client = this.#client as ComputeClient;
    const pending = client.start(key, op, args);
    pending.promise.catch(() => {
      /* the spec asserts through `settled` */
    });
    (this as unknown as { pending: typeof pending }).pending = pending;
    return pending.id;
  }

  async settle(): Promise<{ ok: boolean; code?: string; elapsedMs: number }> {
    const pending = (this as unknown as { pending?: { promise: Promise<unknown> } }).pending;
    if (pending === undefined) return { ok: false, code: 'none', elapsedMs: 0 };
    try {
      await pending.promise;
      return { ok: true, elapsedMs: performance.now() - this.#t0 };
    } catch (cause) {
      return {
        ok: false,
        code: (cause as { code?: string }).code ?? 'panic',
        elapsedMs: performance.now() - this.#t0,
      };
    }
  }

  /** Resolve once at least one `Progress` has arrived, or after `timeoutMs`. */
  async waitForProgress(timeoutMs = 5000): Promise<number> {
    const until = performance.now() + timeoutMs;
    while (this.#firstProgressMs < 0 && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.#firstProgressMs;
  }

  cancel(id: number): void {
    this.#client?.cancel(id);
  }

  progress(): ProgressRecord[] {
    return this.#progress;
  }

  alive(): boolean {
    return this.#client?.alive ?? false;
  }
}

// The global declaration lives in `e2e/global.d.ts`, so a spec sees the same shape without
// importing this module into the test runner.
window.__tvx = new Harness() as unknown as TvxHarness;
