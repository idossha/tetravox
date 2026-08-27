/**
 * The parts of the §6.5 worker that are pure functions of a message: error mapping, transfer lists,
 * and the `CutOut` pool arithmetic.
 *
 * They live apart from `compute-worker.ts` so a unit test can reach them without importing the
 * wasm-pack glue, and so the rules they encode read as rules rather than as branches inside a
 * dispatch switch.
 */

import type { CutCounts, OpName, WorkerError } from '@tetravox/protocol';

const ERROR_CODES = ['parse', 'unsupported', 'io', 'oom', 'cancelled', 'panic'] as const;

function isWorkerError(v: unknown): v is WorkerError {
  if (typeof v !== 'object' || v === null) return false;
  const code = (v as { code?: unknown }).code;
  return typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Anything a §6.4 export can reject with, as a §6.5 `WorkerError`.
 *
 * `tvx-wasm` rejects with `{ code, message }` for every `tvx_core::Error`. Anything else got here by
 * trapping the module — a Rust `panic!` on `wasm32-unknown-unknown` aborts and surfaces as a
 * `WebAssembly.RuntimeError` — so it is `'panic'`, and the client tears the worker down rather than
 * calling into the poisoned instance again (§5 rule 8).
 */
export function toWorkerError(cause: unknown): WorkerError {
  if (isWorkerError(cause)) {
    const message = (cause as { message?: unknown }).message;
    return { code: cause.code, message: typeof message === 'string' ? message : cause.code };
  }
  return { code: 'panic', message: cause instanceof Error ? cause.message : String(cause) };
}

function walkBuffers(value: unknown, into: Set<ArrayBuffer>, depth: number): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (value instanceof ArrayBuffer) {
    into.add(value);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (buffer instanceof ArrayBuffer) into.add(buffer);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkBuffers(item, into, depth + 1);
    return;
  }
  for (const item of Object.values(value)) walkBuffers(item, into, depth + 1);
}

/**
 * Every buffer in a result, so `postMessage` moves it instead of copying it.
 *
 * Safe because every array `tvx-wasm` hands back is freshly allocated for that one call — with one
 * exception: the recycled `cut` path writes into the worker's own `CutOut` pool, which must survive
 * for the next drag frame. §6.5.1's `'recycled'` variant carries counts and no arrays, so there is
 * nothing to transfer there anyway.
 */
export function collectTransfers(op: OpName, result: unknown): ArrayBuffer[] {
  if (op === 'cut' && (result as { mode?: string } | null)?.mode === 'recycled') return [];
  const found = new Set<ArrayBuffer>();
  walkBuffers(result, found, 0);
  return [...found];
}

/** The nine typed arrays a `CutOut` wraps. The pool is these; the wrapper is rebuilt per call. */
export interface Pool {
  positions: Float32Array;
  interpN: Uint32Array;
  interpT: Float32Array;
  ownerTet: Uint32Array;
  tag: Int32Array;
  edgeMask: Uint8Array;
  edgeSegments: Float32Array;
  boundarySegments: Float32Array;
  planeOffsets: Uint32Array;
}

export function makePool(
  vertices: number,
  triangles: number,
  segments: number,
  planes: number
): Pool {
  return {
    positions: new Float32Array(vertices * 3),
    interpN: new Uint32Array(vertices * 2),
    interpT: new Float32Array(vertices),
    ownerTet: new Uint32Array(triangles),
    tag: new Int32Array(triangles),
    edgeMask: new Uint8Array(triangles),
    edgeSegments: new Float32Array(segments * 6),
    boundarySegments: new Float32Array(segments * 6),
    planeOffsets: new Uint32Array((planes + 1) * 4),
  };
}

/**
 * Totals the pool has to hold, from one `truncated` call's REQUIRED per-plane counts (§6.4). The
 * arrays are packed plane-major, so vertices and triangles sum across planes; the two segment
 * arrays are separate, so each needs the larger of the two totals.
 */
export function requiredFrom(counts: CutCounts[]): {
  vertices: number;
  triangles: number;
  segments: number;
} {
  let vertices = 0;
  let triangles = 0;
  let edge = 0;
  let boundary = 0;
  for (const c of counts) {
    vertices += c.vertices;
    triangles += c.triangles;
    edge += c.edgeSegments;
    boundary += c.boundarySegments;
  }
  return { vertices, triangles, segments: Math.max(edge, boundary) };
}

/** Grow a pool for `need`, never shrinking and never less than doubling (§6.4). */
export function grownPool(
  pool: Pool,
  need: { vertices: number; triangles: number; segments: number },
  planes: number
): Pool {
  return makePool(
    Math.max(need.vertices, pool.interpT.length * 2),
    Math.max(need.triangles, pool.tag.length * 2),
    Math.max(need.segments, (pool.edgeSegments.length / 6) * 2),
    planes
  );
}
