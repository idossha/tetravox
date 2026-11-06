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
 * * The one exception is a tract scan (§6.3.1): a session here between `tractScanNext` calls, closed by
 *   `tractScanClose` or `free`, because the dataset it runs beside must survive its cancellation.
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
  LoadSource,
  MeshMeta,
  OpArgs,
  OpName,
  OpResult,
  Progress,
  Req,
  Res,
  ToWorker,
  TractScanChunkT,
  VolumeMeta,
} from '@tetravox/protocol';
import { OP_TO_EXPORT, isCancel } from '@tetravox/protocol';

import init, { CutOut } from '../pkg/tvx_wasm.js';
import * as tvx from '../pkg/tvx_wasm.js';
import type { Pool } from './dispatch';
import { collectTransfers, grownPool, makePool, requiredFrom, toWorkerError } from './dispatch';
import { ioError, loadSource, openStream, sourceName } from './sources';

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
// Tractogram load: bytes pass through the §6.3.1 push parser and only kept points are retained.
// ---------------------------------------------------------------------------------------------

async function readAll(
  source: OpArgs['loadTractogram']['source'],
  onChunk: (chunk: Uint8Array) => void
): Promise<number> {
  const { stream } = await openStream(source);
  const reader = stream.getReader();
  let seen = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) return seen;
    seen += step.value.byteLength;
    onChunk(step.value);
  }
}

async function loadTractogram(
  a: OpArgs['loadTractogram'],
  read: (phase: Progress['phase'], done: number, total: number) => void
): Promise<OpResult['loadTractogram']> {
  // The budget and the fingerprint both need the length, so a stream that cannot state one pays
  // one extra pass to count it.
  const opened = await openStream(a.source);
  let total = opened.length;
  await opened.stream.cancel();
  if (total === null) total = await readAll(a.source, () => {});

  const stream = tvx.tract_stream_begin(a.format, total, a.maxPoints ?? undefined, a.seed);
  let reported = 0;
  for (;;) {
    let done = 0;
    await readAll(a.source, (chunk) => {
      tvx.tract_stream_push(stream, chunk);
      done += chunk.byteLength;
      if (done - reported >= 4 << 20 || done === total) {
        reported = done;
        read('parse', done, total);
      }
    });
    reported = 0;
    if (!tvx.tract_stream_end_pass(stream)) break;
  }
  const result = tvx.tract_stream_finish(stream) as OpResult['loadTractogram'];
  result.meta.name = sourceName(a.source);
  result.meta.format = a.format;
  return result;
}

async function attachTractFile(a: OpArgs['tractAttach']): Promise<OpResult['tractAttach']> {
  const stream = tvx.tract_attach_begin(a.handle, sourceName(a.source));
  await readAll(a.source, (chunk) => {
    tvx.tract_attach_push(a.handle, stream, chunk);
  });
  return tvx.tract_attach_finish(a.handle, stream) as OpResult['tractAttach'];
}

// ---------------------------------------------------------------------------------------------
// §6.3.1's scan: a session between calls, so other ops on this dataset run between chunks.
// ---------------------------------------------------------------------------------------------

/** Most bytes into a parser between looks at it: what bounds a chunk's overshoot, and the heap's. */
const SCAN_PUSH_BYTES = 1 << 18;
/** Most bytes read in one `tractScanNext` that has no chunk to show, as on a TRX's first pass. */
const SCAN_YIELD_BYTES = 64 << 20;

/** A file read forward in pieces of at most `SCAN_PUSH_BYTES`. */
class ScanFeed {
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #rest: Uint8Array | null = null;

  constructor(readonly source: LoadSource) {}

  /** `null` at the end of the file, and the next call starts it again. */
  async next(): Promise<Uint8Array | null> {
    if (this.#rest === null) {
      try {
        this.#reader ??= (await openStream(this.source)).stream.getReader();
        const step = await this.#reader.read();
        if (step.done) {
          this.#reader = null;
          return null;
        }
        this.#rest = step.value;
      } catch (cause) {
        // A read that fails is `io`, not the `panic` that would tear this dataset's worker down.
        if ((cause as { code?: unknown }).code === 'io') throw cause;
        throw ioError(`${sourceName(this.source)}: ${String(cause)}`);
      }
    }
    const piece = this.#rest.subarray(0, SCAN_PUSH_BYTES);
    this.#rest =
      this.#rest.byteLength > SCAN_PUSH_BYTES ? this.#rest.subarray(SCAN_PUSH_BYTES) : null;
    return piece;
  }

  cancel(): void {
    void this.#reader?.cancel().catch(() => {});
    this.#reader = null;
    this.#rest = null;
  }
}

interface ScanSession {
  handle: number;
  main: ScanFeed;
  sidecars: { at: number; feed: ScanFeed }[];
  ended: boolean;
}

const scans = new Map<number, ScanSession>();

function closeScan(scan: number): void {
  const session = scans.get(scan);
  if (session === undefined) return;
  scans.delete(scan);
  session.main.cancel();
  for (const car of session.sidecars) car.feed.cancel();
  tvx.tract_scan_close(scan);
}

async function feedScanSidecars(scan: number, session: ScanSession): Promise<void> {
  for (const { at, feed } of session.sidecars) {
    while (tvx.tract_scan_attach_hungry(scan, at)) {
      const piece = await feed.next();
      if (piece === null) tvx.tract_scan_attach_end(scan, at);
      else tvx.tract_scan_attach_push(scan, at, piece);
    }
  }
}

async function openTractScan(a: OpArgs['tractScanOpen']): Promise<OpResult['tractScanOpen']> {
  // The same length rule as a load, because the same check reads it.
  const opened = await openStream(a.source);
  let total = opened.length;
  await opened.stream.cancel();
  if (total === null) total = await readAll(a.source, () => {});
  const scan = tvx.tract_scan_begin(
    a.handle,
    a.format,
    total,
    JSON.stringify(a.fields),
    a.chunkPoints
  );
  const session: ScanSession = {
    handle: a.handle,
    main: new ScanFeed(a.source),
    sidecars: [],
    ended: false,
  };
  scans.set(scan, session);
  try {
    for (const source of a.sidecars) {
      const at = tvx.tract_scan_attach_begin(scan, sourceName(source));
      session.sidecars.push({ at, feed: new ScanFeed(source) });
    }
    await feedScanSidecars(scan, session);
  } catch (cause) {
    closeScan(scan);
    throw cause;
  }
  return { scan };
}

async function nextTractScan(a: OpArgs['tractScanNext']): Promise<OpResult['tractScanNext']> {
  const session = scans.get(a.scan);
  if (session === undefined) throw toScanClosed(a.scan);
  let read = 0;
  while (read < SCAN_YIELD_BYTES) {
    if (tvx.tract_scan_ready(a.scan)) {
      await feedScanSidecars(a.scan, session);
      return { chunk: tvx.tract_scan_take(a.scan) as TractScanChunkT };
    }
    if (session.ended) {
      await feedScanSidecars(a.scan, session);
      const done = tvx.tract_scan_finish(a.scan) as { streamlines: number; points: number };
      closeScan(a.scan);
      return { done };
    }
    const piece = await session.main.next();
    if (piece === null) session.ended = !tvx.tract_scan_end_pass(a.scan);
    else {
      tvx.tract_scan_push(a.scan, piece);
      read += piece.byteLength;
    }
  }
  return {};
}

function toScanClosed(scan: number): Error & { code: 'cancelled' } {
  return Object.assign(
    new Error(`tract scan ${scan} is closed: its dataset was freed or re-read`),
    {
      code: 'cancelled' as const,
    }
  );
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
    case 'loadTractogram': {
      const a = args as OpArgs['loadTractogram'];
      return (await loadTractogram(a, read)) as OpResult[K];
    }
    case 'tractGeometry': {
      const a = args as OpArgs['tractGeometry'];
      return call(a.handle) as OpResult[K];
    }
    case 'tractScalar': {
      const a = args as OpArgs['tractScalar'];
      return call(a.handle, a.kind, a.name) as OpResult[K];
    }
    case 'tractStyle': {
      const a = args as OpArgs['tractStyle'];
      return call(a.handle, JSON.stringify(a.spec)) as OpResult[K];
    }
    case 'tractProbe': {
      const a = args as OpArgs['tractProbe'];
      const [x, y, z] = a.world;
      return call(a.handle, x, y, z, a.radiusMm, a.streamline) as OpResult[K];
    }
    case 'tractPoints': {
      const a = args as OpArgs['tractPoints'];
      return call(a.handle, a.first, a.count, a.tangents) as OpResult[K];
    }
    case 'tractFieldChunk': {
      const a = args as OpArgs['tractFieldChunk'];
      return call(a.handle, a.name, a.units, a.first, a.values, a.done) as OpResult[K];
    }
    case 'tractAttach': {
      const a = args as OpArgs['tractAttach'];
      return (await attachTractFile(a)) as OpResult[K];
    }
    case 'tractStructure': {
      const a = args as OpArgs['tractStructure'];
      return call(a.handle) as OpResult[K];
    }
    case 'tractFieldValues': {
      const a = args as OpArgs['tractFieldValues'];
      return call(a.handle, a.kind, a.name, a.first, a.count) as OpResult[K];
    }
    case 'tractSetField': {
      const a = args as OpArgs['tractSetField'];
      return call(a.handle, a.name, a.units, a.values) as OpResult[K];
    }
    case 'tractRemoveField': {
      const a = args as OpArgs['tractRemoveField'];
      return call(a.handle, a.kind, a.name) as OpResult[K];
    }
    case 'tractScanOpen': {
      return (await openTractScan(args as OpArgs['tractScanOpen'])) as OpResult[K];
    }
    case 'tractScanNext': {
      return (await nextTractScan(args as OpArgs['tractScanNext'])) as OpResult[K];
    }
    case 'tractScanClose': {
      closeScan((args as OpArgs['tractScanClose']).scan);
      return {} as OpResult[K];
    }
    case 'volumeSample': {
      const a = args as OpArgs['volumeSample'];
      return call(a.handle, a.points, a.tangents, a.volumeIndex, a.op, a.basis) as OpResult[K];
    }
    case 'meshSample': {
      const a = args as OpArgs['meshSample'];
      return call(a.handle, a.points, a.tangents, a.source, a.name, a.op) as OpResult[K];
    }
    case 'attachField': {
      // The file is fetched here for the same reason `loadMesh`'s is: its bytes stay in this worker
      // (§5 rule 3). The base name is what the reader keys on — the extension hint for a morph
      // file, and the field's name on the wire (§6.5.2).
      const a = args as OpArgs['attachField'];
      const loaded = await loadSource(a.source, read);
      return call(a.handle, loaded.bytes, loaded.name) as OpResult[K];
    }
    case 'parseLut': {
      const a = args as OpArgs['parseLut'];
      const loaded = await loadSource(a.source, read);
      return call(loaded.bytes) as OpResult[K];
    }
    case 'volumeTensor': {
      const a = args as OpArgs['volumeTensor'];
      return call(a.handle, a.order, a.basis, a.stride, a.max3d) as OpResult[K];
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
      return call(
        a.handle,
        plane,
        a.maskId,
        a.annotation,
        a.field?.name,
        a.field === undefined ? undefined : String(a.field.component)
      ) as OpResult[K];
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
    // -- §8's surface coordinate spaces (directed task 8e), appended 2026-08-28 ------------------
    case 'nearestVertex': {
      const a = args as OpArgs['nearestVertex'];
      return call(a.handle, a.world[0], a.world[1], a.world[2]) as OpResult[K];
    }
    case 'vertices': {
      const a = args as OpArgs['vertices'];
      // `Option<Vec<u32>>` reads a typed array or `undefined`, never a plain JS array — the same
      // wasm-bindgen rule `meshCentroids`'s `tags` obeys just above.
      return call(a.handle, a.indices) as OpResult[K];
    }
    case 'sphereMap': {
      const a = args as OpArgs['sphereMap'];
      return call(a.handle, a.target) as OpResult[K];
    }
    case 'free': {
      const a = args as OpArgs['free'];
      for (const [scan, session] of scans) {
        if (session.handle === a.handle) closeScan(scan);
      }
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
