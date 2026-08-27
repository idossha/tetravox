/**
 * Getting a `LoadSource`'s bytes into the worker (§5, §6.5.1).
 *
 * `fetch('tetravox://file/…')` → `DecompressionStream('gzip')` when the name ends in `.gz` →
 * `Uint8Array` → WASM. **Raw file bytes never touch the UI thread and never cross IPC** (§5 rule 3):
 * this module runs only inside the dataset worker.
 *
 * The gzip decision is `.gz`-by-name, as §5 rule 4 states, but the first two bytes are checked
 * before the stream is piped: a transport that already decoded the payload (an HTTP layer answering
 * `content-encoding: gzip`, which `fetch` unwraps for us) would otherwise be fed to
 * `DecompressionStream` a second time and fail on data that is perfectly good. Peeking one chunk and
 * re-emitting it keeps the read streaming.
 */

import type { LoadSource, Phase } from '@tetravox/protocol';

/** Bytes-so-far reporter; `total` is 0 when the length is unknown. */
export type ReadProgress = (phase: Phase, done: number, total: number) => void;

/** One dataset's bytes plus whatever role-keyed sidecars came with it (§6.5.1). */
export interface LoadedBytes {
  name: string;
  bytes: Uint8Array;
  lut?: Uint8Array;
  opt?: Uint8Array;
}

/** The file name a `LoadSource` implies — what `.gz` sniffing and `MeshMeta.name` both key on. */
export function sourceName(source: LoadSource): string {
  if (source.kind === 'file') return source.file.name;
  if (source.kind === 'bytes') return source.name;
  const path = source.url.replace(/[?#].*$/, '');
  const last = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined && chunks[0].byteLength === total) {
    return chunks[0];
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  phase: Phase,
  total: number,
  onProgress?: ReadProgress
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  let reported = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    chunks.push(chunk);
    done += chunk.byteLength;
    // Throttled so a 492 MB read does not post ten thousand messages; the first chunk always
    // reports, which is what makes progress visible inside §9.1 row 6's 200 ms.
    if (onProgress && (reported === 0 || done - reported >= 4 << 20)) {
      reported = done;
      onProgress(phase, done, total);
    }
  }
  if (onProgress) onProgress(phase, done, total);
  return concat(chunks, done);
}

/**
 * Drain `body`, inflating when `name` ends in `.gz` **and** the payload really starts with the gzip
 * magic. The first chunk is peeked and re-emitted, so nothing is buffered ahead of the pipe.
 */
export async function readStream(
  name: string,
  body: ReadableStream<Uint8Array>,
  total: number,
  onProgress?: ReadProgress
): Promise<Uint8Array> {
  if (!name.toLowerCase().endsWith('.gz')) {
    return drain(body, 'read', total, onProgress);
  }
  const reader = body.getReader();
  const first = await reader.read();
  const head: Uint8Array = first.value ?? new Uint8Array(0);
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength > 0) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const step = await reader.read();
      if (step.done) controller.close();
      else controller.enqueue(step.value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  const gzipped = head.byteLength >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  if (!gzipped) return drain(rest, 'read', total, onProgress);
  // The DOM lib types `DecompressionStream.writable` as `WritableStream<BufferSource>`, which is
  // wider than the `Uint8Array` this pipe carries, so `pipeThrough` will not unify them. The cast
  // narrows the declaration, not the data — every chunk written really is a `Uint8Array`.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return drain(rest.pipeThrough(gunzip), 'inflate', 0, onProgress);
}

async function fetchBytes(url: string, onProgress?: ReadProgress): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw ioError(`${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) throw ioError(`${url} -> ${response.status} ${response.statusText}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  const body = response.body;
  if (body === null) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
  return readStream(urlName(url), body, Number.isFinite(length) ? length : 0, onProgress);
}

function urlName(url: string): string {
  const path = url.replace(/[?#].*$/, '');
  const last = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A §6.5 `io` error, thrown from the worker's own IO rather than from wasm. */
export function ioError(message: string): Error & { code: 'io' } {
  return Object.assign(new Error(message), { code: 'io' as const });
}

async function fileBytes(file: File, onProgress?: ReadProgress): Promise<Uint8Array> {
  return readStream(file.name, file.stream(), file.size, onProgress);
}

async function sidecar(source: LoadSource, role: 'lut' | 'opt'): Promise<Uint8Array | undefined> {
  const cars = source.sidecars;
  if (cars === undefined) return undefined;
  if (source.kind === 'url') {
    const url = (cars as { lut?: string; opt?: string })[role];
    return url === undefined ? undefined : fetchBytes(url);
  }
  if (source.kind === 'file') {
    const f = (cars as { lut?: File; opt?: File })[role];
    return f === undefined ? undefined : fileBytes(f);
  }
  const b = (cars as { lut?: ArrayBuffer; opt?: ArrayBuffer })[role];
  return b === undefined ? undefined : new Uint8Array(b);
}

/**
 * Read one `LoadSource` and its sidecars. Sidecars are keyed **by role**, never positional (§6.5.1),
 * and the worker fetches them itself — the crates never touch the filesystem (§6.4).
 */
export async function loadSource(
  source: LoadSource,
  onProgress?: ReadProgress
): Promise<LoadedBytes> {
  const name = sourceName(source);
  let bytes: Uint8Array;
  if (source.kind === 'url') bytes = await fetchBytes(source.url, onProgress);
  else if (source.kind === 'file') bytes = await fileBytes(source.file, onProgress);
  else
    bytes = await readStream(
      source.name,
      blobStream(source.bytes),
      source.bytes.byteLength,
      onProgress
    );

  const out: LoadedBytes = { name, bytes };
  const lut = await sidecar(source, 'lut');
  if (lut !== undefined) out.lut = lut;
  const opt = await sidecar(source, 'opt');
  if (opt !== undefined) out.opt = opt;
  return out;
}

/** An already-resident `ArrayBuffer` as a one-chunk stream, so every branch shares one reader. */
function blobStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}
