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

export type WorkerRequest = { kind: 'start'; seed: number; fileUrl: string | null };
export type WorkerResponse =
  ({ kind: 'ready' } & Phase0Result) | { kind: 'failed'; message: string };

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
}
