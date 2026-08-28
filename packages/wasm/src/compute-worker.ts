/**
 * Worker-thread half of the §6.5 protocol: a module `Worker` under the `tetravox://` origin, owning
 * exactly one wasm instance and one parsed dataset by handle (§5).
 *
 * What this file is responsible for:
 * * `fetch('tetravox://file/…')` → `DecompressionStream('gzip')` when `.gz` → `Uint8Array` → WASM
 *   (`./sources`). **Raw file bytes never touch the UI thread and never cross IPC** (§5 rule 3,
 *   AGENTS rule 7).
 * * The **sidecars**, keyed by role: `sidecars.lut` → `lut_bytes`, `sidecars.opt` → `opt_bytes`
 *   (§6.5.1). The crates never touch the filesystem.
 * * Input bytes are copied into WASM **once**; the parser frees its own copy before returning and
 *   drops the inflate output too (§5 rule 5).
 * * Results are **owned buffers, never views** onto `wasm.memory.buffer`: `memory.grow` detaches
 *   every outstanding view (§6.4). Every array `tvx-wasm` returns is a freshly allocated JS typed
 *   array, so its `.buffer` is transferred as-is with no second copy.
 * * The `CutOut` pool for the recycled `cut` path, grown by doubling on `truncated: true` and
 *   re-called (§6.4). A partially-filled pool is never returned, so grow-and-retry is always safe.
 * * `wasm_heap_bytes()` is read after every call and stamped onto the `Res`.
 * * One request runs at a time, so a `Cancel` can still drop a **queued** one. There is no abort
 *   flag: `SharedArrayBuffer` is `undefined` here (not cross-origin isolated, §1), and while a
 *   synchronous wasm call runs the worker's event loop cannot process a `Cancel` anyway — an
 *   in-flight `loadVolume`/`loadMesh` is cancelled by `worker.terminate()` on the client side
 *   (§5 rule 6).
 *
 * Op dispatch goes through the protocol's frozen `OP_TO_EXPORT` table (§6.5): op → export name is
 * the one seam TypeScript cannot check, so it is looked up as data and a missing export is a named
 * error rather than `undefined is not a function`.
 */

/// <reference lib="webworker" />

import type {
  Cancel,
  FromWorker,
  GpuCapsT,
  MeshMeta,
  OpArgs,
  OpName,
  OpResult,
  Progress,
  Req,
  Res,
  ToWorker,
  VolumeMeta,
} from '@tetravox/protocol';
import { OP_TO_EXPORT, isCancel } from '@tetravox/protocol';

import init, { CutOut } from '../pkg/tvx_wasm.js';
import * as tvx from '../pkg/tvx_wasm.js';
import type { Pool } from './dispatch';
import { collectTransfers, grownPool, makePool, requiredFrom, toWorkerError } from './dispatch';
import { ioError, loadSource } from './sources';

export { collectTransfers, makePool, requiredFrom, toWorkerError } from './dispatch';

/** Narrowed `self.onmessage` payload type. */
export type IncomingMessage = MessageEvent<ToWorker>;

type AnyExport = (...args: unknown[]) => unknown;

const exportsByName = tvx as unknown as Record<string, AnyExport>;

function wasmExport(op: OpName): AnyExport {
  const name = OP_TO_EXPORT[op];
  const fn = exportsByName[name];
  if (typeof fn !== 'function') {
    throw new Error(`§6.5.2 maps op ${op} to wasm export ${name}, which this module does not have`);
  }
  return fn;
}

// ---------------------------------------------------------------------------------------------
// The CutOut pool (§6.4)
// ---------------------------------------------------------------------------------------------

const POOL_MIN_VERTICES = 1 << 12;
const POOL_MIN_SEGMENTS = 1 << 12;

function asCutOut(p: Pool): CutOut {
  // wasm-bindgen consumes a `CutOut` passed by value, so a fresh wrapper is built per call. It only
  // holds references to the nine arrays — the pool itself is what persists (§6.4).
  return new CutOut(
    p.positions,
    p.interpN,
    p.interpT,
    p.ownerTet,
    p.tag,
    p.edgeMask,
    p.edgeSegments,
    p.boundarySegments,
    p.planeOffsets
  );
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

let ready: Promise<unknown> | null = null;
let pool: Pool | null = null;

function ensureWasm(): Promise<unknown> {
  ready ??= init();
  return ready;
}

function capsOf(caps: GpuCapsT): [boolean, boolean, number] {
  return [caps.floatLinear, caps.norm16, caps.max3d];
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

async function runOp<K extends OpName>(
  req: Req<K>,
  emit: (m: Progress) => void
): Promise<OpResult[K]> {
  await ensureWasm();
  const call = wasmExport(req.op);
  const onProgress = (phase: string, done: number, total: number): void => {
    emit({ kind: 'progress', id: req.id, phase: phase as Progress['phase'], done, total });
  };
  const read = (phase: Progress['phase'], done: number, total: number): void => {
    emit({ kind: 'progress', id: req.id, phase, done, total });
  };
  const args: OpArgs[OpName] = req.args;

  switch (req.op) {
    case 'loadVolume': {
      const a = args as OpArgs['loadVolume'];
      const loaded = await loadSource(a.source, read);
      const [floatLinear, norm16, max3d] = capsOf(a.caps);
      const result = call(
        loaded.bytes,
        loaded.lut,
        floatLinear,
        norm16,
        max3d,
        a.wantLinear,
        onProgress
      ) as OpResult['loadVolume'];
      (result.meta as VolumeMeta).name = loaded.name;
      return result as OpResult[K];
    }
    case 'loadMesh': {
      const a = args as OpArgs['loadMesh'];
      const loaded = await loadSource(a.source, read);
      const result = call(
        loaded.bytes,
        a.format,
        loaded.opt,
        loaded.lut,
        onProgress
      ) as OpResult['loadMesh'];
      (result.meta as MeshMeta).name = loaded.name;
      return result as OpResult[K];
    }
    case 'volumeFrame': {
      const a = args as OpArgs['volumeFrame'];
      const [floatLinear, norm16, max3d] = capsOf(a.caps);
      return call(a.handle, a.volumeIndex, floatLinear, norm16, max3d, a.wantLinear) as OpResult[K];
    }
    case 'surface': {
      const a = args as OpArgs['surface'];
      return call(a.handle, a.maskId, a.variant, onProgress) as OpResult[K];
    }
    case 'boundary': {
      const a = args as OpArgs['boundary'];
      return call(a.handle, a.maskId, a.variant, onProgress) as OpResult[K];
    }
    case 'buildTopology': {
      const a = args as OpArgs['buildTopology'];
      return call(a.handle, onProgress) as OpResult[K];
    }
    case 'cut': {
      const a = args as OpArgs['cut'];
      const planes = new Float32Array(a.planes.length * 4);
      a.planes.forEach((p, i) => {
        planes.set([p.normal[0], p.normal[1], p.normal[2], p.offset], i * 4);
      });
      if (a.recycle !== true) {
        return call(a.handle, planes, a.maskId, undefined) as OpResult[K];
      }
      pool ??= makePool(POOL_MIN_VERTICES, POOL_MIN_VERTICES, POOL_MIN_SEGMENTS, a.planes.length);
      // §6.4: on `truncated` nothing was written and `counts` are the REQUIRED capacities. Double,
      // or jump straight to what was asked for when that is larger, and re-call.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const out = call(a.handle, planes, a.maskId, asCutOut(pool)) as OpResult['cut'];
        if (out.mode !== 'recycled' || !out.truncated) return out as OpResult[K];
        pool = grownPool(pool, requiredFrom(out.counts), a.planes.length);
      }
      throw ioError('the CutOut pool did not converge after 8 growth attempts');
    }
    case 'isolate': {
      const a = args as OpArgs['isolate'];
      // §5 rule 2: `labelVolume` arrived structured-CLONED, so reading it here cannot detach the UI
      // thread's `VolumeDataset.data`.
      const label = a.labelVolume === undefined ? undefined : new Uint8Array(a.labelVolume);
      return call(a.handle, JSON.stringify(a.criteria), label, onProgress) as OpResult[K];
    }
    case 'field': {
      const a = args as OpArgs['field'];
      return call(a.handle, a.source, a.name, String(a.component)) as OpResult[K];
    }
    case 'elmToNode': {
      const a = args as OpArgs['elmToNode'];
      return call(a.handle, a.direction, a.name) as OpResult[K];
    }
    case 'locate': {
      const a = args as OpArgs['locate'];
      return call(a.handle, a.world[0], a.world[1], a.world[2]) as OpResult[K];
    }
    case 'marchingCubes': {
      const a = args as OpArgs['marchingCubes'];
      return call(a.handle, a.volumeIndex, a.iso, a.smooth, onProgress) as OpResult[K];
    }
    case 'marchingCubesLabel': {
      const a = args as OpArgs['marchingCubesLabel'];
      return call(a.handle, a.volumeIndex, a.label, a.smooth, onProgress) as OpResult[K];
    }
    case 'marchingTets': {
      const a = args as OpArgs['marchingTets'];
      return call(
        a.handle,
        a.source,
        a.name,
        String(a.component),
        a.iso,
        a.maskId,
        onProgress
      ) as OpResult[K];
    }
    case 'contours': {
      const a = args as OpArgs['contours'];
      const plane = new Float32Array([
        a.plane.normal[0],
        a.plane.normal[1],
        a.plane.normal[2],
        a.plane.offset,
      ]);
      return call(a.handle, plane, a.maskId) as OpResult[K];
    }
    case 'labelCentroids': {
      const a = args as OpArgs['labelCentroids'];
      return call(a.handle, a.volumeIndex) as OpResult[K];
    }
    case 'meshCentroids': {
      const a = args as OpArgs['meshCentroids'];
      // `tags` crosses as an `Int32Array`, like `cut`'s planes cross as a `Float32Array`:
      // wasm-bindgen's `Option<Vec<i32>>` reads a typed array, not a plain JS array.
      const tags = a.tags === undefined ? undefined : Int32Array.from(a.tags);
      return call(a.handle, a.maskId, a.stride, tags) as OpResult[K];
    }
    case 'free': {
      const a = args as OpArgs['free'];
      call(a.handle);
      return {} as OpResult[K];
    }
    case 'freeMask': {
      const a = args as OpArgs['freeMask'];
      call(a.handle, a.maskId);
      return {} as OpResult[K];
    }
    default: {
      const never: never = req.op;
      throw new Error(`unknown op ${String(never)}`);
    }
  }
}

/** Dispatch one request to its §6.4 wasm export and shape the `Res`, transfer list included. */
export async function handleRequest<K extends OpName>(
  req: Req<K>,
  emit: (m: Progress) => void = () => {}
): Promise<Res<K>> {
  try {
    const result = await runOp(req, emit);
    return {
      id: req.id,
      op: req.op,
      ok: true,
      result,
      transfer: collectTransfers(req.op, result),
      heapBytes: tvx.wasm_heap_bytes(),
    };
  } catch (cause) {
    return { id: req.id, op: req.op, ok: false, error: toWorkerError(cause) };
  }
}

// ---------------------------------------------------------------------------------------------
// The message pump
// ---------------------------------------------------------------------------------------------

/**
 * Install the `message` handler on `self`.
 *
 * One request runs at a time and the rest wait in `queued`, which is what makes "a `Cancel` drops a
 * request that is still **queued**" (§6.5) implementable at all: the in-flight one is not
 * interruptible.
 */
export function startComputeWorker(scope: DedicatedWorkerGlobalScope): void {
  const queued: Req[] = [];
  let running = false;

  const emit = (message: FromWorker, transfer?: ArrayBuffer[]): void => {
    if (transfer !== undefined && transfer.length > 0) scope.postMessage(message, transfer);
    else scope.postMessage(message);
  };

  const pump = (): void => {
    if (running) return;
    const next = queued.shift();
    if (next === undefined) return;
    running = true;
    void handleRequest(next, (p) => {
      emit(p);
    }).then((res) => {
      running = false;
      if (res.ok) emit(res, res.transfer);
      else emit(res);
      pump();
    });
  };

  scope.onmessage = (event: IncomingMessage): void => {
    const message = event.data;
    if (isCancel(message)) {
      const at = queued.findIndex((r) => r.id === (message as Cancel).id);
      if (at >= 0) {
        const dropped = queued.splice(at, 1)[0];
        if (dropped !== undefined) {
          emit({
            id: dropped.id,
            op: dropped.op,
            ok: false,
            error: { code: 'cancelled', message: 'dropped from the queue' },
          });
        }
      }
      // An in-flight request has no abort flag (§5 rule 6). `loadVolume`/`loadMesh` are cancelled by
      // `worker.terminate()` on the client side; everything else runs to completion and the client
      // discards the result.
      return;
    }
    queued.push(message);
    pump();
  };
}
