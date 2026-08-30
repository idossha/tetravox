/**
 * File ▸ Sample Data… (§8): public datasets a user can download and open without leaving the app.
 *
 * Modelled on 3D Slicer's `SampleData` module and its `SlicerDataStore`: the catalogue
 * (`shared/sample-catalog.json`) names every file by its **sha256**, the data store is a GitHub
 * release whose assets are named by that hash, and nothing is opened until the bytes on disk hash to
 * the name. A sample is a *set* of files — a volume with its `_LUT.txt`, a T1 with two surfaces —
 * because the sidecar rules (§7.6) need them next to each other, so a sample downloads into its own
 * directory under the cache and every file keeps its catalogue name.
 *
 * Main owns this end to end (§5): the network, the cache directory, the hashing and the
 * allow-listing all happen here, and the renderer only ever sees ids, progress numbers and — through
 * the same `sendOpened` the Open dialog uses — paths. Dataset bytes never cross IPC.
 *
 * The cache is `<userData>/sample-data/<sample id>/<file name>`, or `TETRAVOX_SAMPLE_DIR` when set
 * (how the E2E keeps it out of the real profile). A file already there is re-verified, not trusted:
 * hashing 60 MB is far cheaper than a corrupt mesh that parses.
 */

import { app, net, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import catalogJson from '../shared/sample-catalog.json';

export interface SampleFile {
  /** The name the file gets on disk — sidecar discovery (§7.6) depends on it. */
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

export interface Sample {
  id: string;
  title: string;
  group: string;
  description: string;
  /** Key into the renderer's `assets/samples/*.jpg`. */
  thumbnail: string;
  source: string;
  sourceUrl: string;
  licence: string;
  files: SampleFile[];
}

/** What the dialog shows per sample without touching the network. */
export interface SampleStatus {
  id: string;
  /** Every file is present with its catalogue size. Hashes are checked on open, not here. */
  cached: boolean;
  /** Sum of the catalogue sizes, for the "42 MB" label. */
  bytes: number;
}

export type SampleProgressState = 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface SampleProgress {
  id: string;
  /** The file being worked on. */
  file: string;
  /** Bytes received across the whole sample so far, against `total`. */
  received: number;
  total: number;
  state: SampleProgressState;
  error?: string;
}

export interface SampleOpenResult {
  ok: boolean;
  paths?: string[];
  error?: string;
}

const CATALOG = catalogJson as { store: string; samples: Sample[] };

export function catalogue(): readonly Sample[] {
  return CATALOG.samples;
}

export function sampleById(id: string): Sample | undefined {
  return CATALOG.samples.find((s) => s.id === id);
}

export function sampleCacheDir(): string {
  return process.env['TETRAVOX_SAMPLE_DIR'] ?? join(app.getPath('userData'), 'sample-data');
}

export function samplePath(sample: Sample, file: SampleFile): string {
  return join(sampleCacheDir(), sample.id, file.name);
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function sampleStatuses(): SampleStatus[] {
  return CATALOG.samples.map((sample) => ({
    id: sample.id,
    cached: sample.files.every((f) => sizeOf(samplePath(sample, f)) === f.bytes),
    bytes: sample.files.reduce((n, f) => n + f.bytes, 0),
  }));
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The one network call, injectable so the download path is unit-tested without a server. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => net.fetch(url, init);

/**
 * Download `file` for `sample` into the cache, verifying the hash, or keep what is already there
 * when it verifies. Returns the path. Throws on a hash mismatch (after deleting the bad file), a
 * non-2xx response, or an abort.
 */
export async function ensureFile(
  sample: Sample,
  file: SampleFile,
  opts: {
    fetchImpl?: FetchLike;
    signal: AbortSignal;
    onBytes?: (received: number) => void;
    onVerify?: () => void;
  }
): Promise<string> {
  const target = samplePath(sample, file);
  mkdirSync(join(sampleCacheDir(), sample.id), { recursive: true });

  if (sizeOf(target) === file.bytes) {
    opts.onVerify?.();
    if (sha256File(target) === file.sha256) return target;
    rmSync(target, { force: true });
  }

  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const res = await fetchImpl(file.url, { signal: opts.signal });
  if (!res.ok || res.body === null) {
    throw new Error(`${file.name}: HTTP ${res.status} from ${file.url}`);
  }

  const part = `${target}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      opts.onBytes?.(received);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      tap,
      createWriteStream(part),
      { signal: opts.signal }
    );
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }

  opts.onVerify?.();
  const got = hash.digest('hex');
  if (got !== file.sha256 || received !== file.bytes) {
    rmSync(part, { force: true });
    throw new Error(
      `${file.name}: downloaded ${received} B with sha256 ${got.slice(0, 12)}…, the catalogue says ` +
        `${file.bytes} B / ${file.sha256.slice(0, 12)}… — refusing to open it`
    );
  }
  renameSync(part, target);
  return target;
}

/** Download every file of a sample (skipping what already verifies) and return their paths, in catalogue order. */
export async function fetchSample(
  sample: Sample,
  opts: { fetchImpl?: FetchLike; signal: AbortSignal; onProgress?: (p: SampleProgress) => void }
): Promise<string[]> {
  const total = sample.files.reduce((n, f) => n + f.bytes, 0);
  let before = 0;
  const paths: string[] = [];
  for (const file of sample.files) {
    const report = (state: SampleProgressState, received: number, error?: string): void =>
      opts.onProgress?.({
        id: sample.id,
        file: file.name,
        received: before + received,
        total,
        state,
        ...(error === undefined ? {} : { error }),
      });
    report('downloading', 0);
    try {
      const path = await ensureFile(sample, file, {
        signal: opts.signal,
        onBytes: (n) => report('downloading', n),
        onVerify: () => report('verifying', file.bytes),
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      });
      paths.push(path);
    } catch (err) {
      const aborted = opts.signal.aborted;
      report(aborted ? 'cancelled' : 'error', 0, aborted ? undefined : String(err));
      throw err;
    }
    before += file.bytes;
  }
  opts.onProgress?.({
    id: sample.id,
    file: '',
    received: total,
    total,
    state: 'done',
  });
  return paths;
}

/** Delete a sample's directory from the cache. */
export function removeSample(sample: Sample): void {
  rmSync(join(sampleCacheDir(), sample.id), { recursive: true, force: true });
}

export function revealSampleCache(): void {
  mkdirSync(sampleCacheDir(), { recursive: true });
  void shell.openPath(sampleCacheDir());
}

/** One in-flight download per sample; a second request for the same id joins it. */
const inflight = new Map<string, { controller: AbortController; done: Promise<string[]> }>();

export function startSample(
  sample: Sample,
  onProgress: (p: SampleProgress) => void,
  fetchImpl?: FetchLike
): Promise<string[]> {
  const existing = inflight.get(sample.id);
  if (existing !== undefined) return existing.done;
  const controller = new AbortController();
  const done = fetchSample(sample, {
    signal: controller.signal,
    onProgress,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }).finally(() => inflight.delete(sample.id));
  inflight.set(sample.id, { controller, done });
  return done;
}

export function cancelSample(id: string): boolean {
  const entry = inflight.get(id);
  if (entry === undefined) return false;
  entry.controller.abort();
  return true;
}
