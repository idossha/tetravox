/**
 * The Phase-0 contract between the worker, the renderer and the e2e (ROADMAP Phase-0 gate 2 & 3).
 *
 * Shared by the worker, the React shell and `e2e/`, so the seed and the colour derivation have exactly
 * one definition and the test can compute the expected pixel from first principles (§11 rule 0).
 */

/** ASCII `TVX0`. Any u32 would do; a fixed one keeps the expected pixel a constant. */
export const PING_SEED = 0x54565830;

export interface Phase0Result {
  /** `tvx_ping(PING_SEED)` from the wasm module. */
  ping: number;
  /** `tvx_version()` — proves the instantiated module is this crate. */
  version: string;
  /** `content-type` of the `*_bg.wasm` response. Must be `application/wasm` (§5, directive A2). */
  wasmContentType: string | null;
  /** True when `WebAssembly.instantiateStreaming` actually consumed the response. */
  streamed: boolean;
  /** `self.location.origin` inside the module Worker: `tetravox://app`. */
  origin: string;
  /** §1: not cross-origin isolated, so this is false and `SharedArrayBuffer` is undefined. */
  crossOriginIsolated: boolean;
  /** Bytes read from `tetravox://file/…` as a streaming response, or null when unavailable. */
  fileBytes: number | null;
  /** `tvx_ping_bytes()` over those bytes — the gate's "hands the bytes to WASM" leg. */
  fileDigest: number | null;
}

/**
 * Where a dropped file's bytes come from (§8, ROADMAP Phase-0 gate 8).
 *
 * `url` is the allow-listed `tetravox://file/…` for a path `webUtils.getPathForFile` returned; `file`
 * is the §8 fallback — a `File` with no backing path, structured-cloned to the worker whole. Neither
 * puts bytes on the UI thread: the worker is what calls `fetch` / `File.arrayBuffer` (§5 rule 3).
 */
export type DropSource = { kind: 'url'; url: string } | { kind: 'file'; file: File };

export type WorkerRequest =
  { kind: 'start'; seed: number; fileUrl: string | null } | { kind: 'digest'; source: DropSource };

export type WorkerResponse =
  | ({ kind: 'ready' } & Phase0Result)
  | { kind: 'digested'; bytes: number; digest: number }
  | { kind: 'failed'; message: string };

/** One dropped file and which §8 branch carried its bytes to WASM. */
export interface DropRecord {
  name: string;
  /** `'path'` — `getPathForFile` answered; `'file'` — it returned `''` and the `File` itself went. */
  branch: 'path' | 'file';
  /** The absolute path, on the `'path'` branch only. */
  path: string | null;
  /** Its allow-listed `tetravox://file/…` URL, on the `'path'` branch only. */
  url: string | null;
  /** Bytes the *worker* read. Phase 1 parses them; Phase 0 proves they arrived. */
  bytes: number | null;
  /** `tvx_ping_bytes()` over exactly those bytes — the same digest either branch takes. */
  digest: number | null;
  error: string | null;
}

/**
 * The triangle's colour, byte-exact. The framebuffer is plain RGBA8 with no sRGB encode, so these
 * bytes are what `readPixels` returns and what the screenshot contains.
 */
export function colorFromPing(ping: number): [number, number, number] {
  return [(ping >>> 16) & 0xff, (ping >>> 8) & 0xff, ping & 0xff];
}

/** The clear colour, so "the triangle drew" is a second, different, exact assertion. */
export const BACKGROUND: [number, number, number] = [11, 11, 15];

/** Fixed, DPR-independent drawing-buffer size, so pixel coordinates are the same everywhere (§11). */
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

/**
 * What the renderer hangs on `window.__tetravox_phase0` once the first frame is on screen. The e2e
 * waits for it, then recomputes every number in it from first principles.
 */
export interface Phase0Report {
  ok: boolean;
  error: string | null;
  /** Everything the worker reported, or null when the round-trip failed. */
  wasm: Phase0Result | null;
  /** `colorFromPing(wasm.ping)` — what was written to the uniform. */
  color: [number, number, number] | null;
  /** `readPixels` at the centre of the drawing buffer: the triangle. */
  centerPixel: [number, number, number, number] | null;
  /** `readPixels` at (0, 0): background, so "the triangle drew" is its own assertion. */
  cornerPixel: [number, number, number, number] | null;
  renderer: string | null;
  vendor: string | null;
  isSoftware: boolean | null;
  drawingBuffer: { width: number; height: number } | null;
  /** §5: `tetravox:` in the packaged app, always. `http:` only under `electron-vite dev`. */
  locationProtocol: string;
  origin: string;
  /** Paths captured from the menu, CLI argv, `open-file` or a drop — logged, not loaded (Phase 0). */
  openedPaths: string[];
  /** One entry per file of every drop the window has seen, in drop order (gate 8). */
  drops: DropRecord[];
}
