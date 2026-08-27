/**
 * WebGL2 context creation and the §7.1 capability probe.
 *
 * `docs/ARCHITECTURE.md` §7.1 rules encoded here:
 * * The probe runs **once, at context creation, before any texture exists**. `createContext` is the only
 *   place that calls it, and it hands the result back so the engine can cache it.
 * * `getExtension` is a *request*, not a query — it must be **called**, or the feature is unavailable even
 *   where the driver has it. Every optional extension below is therefore `getExtension`ed exactly once,
 *   here, and never re-queried by feature code.
 * * `getContext('webgl2') === null` ⇒ a real error naming `chrome://gpu`, never a white window. That is
 *   `WebGL2UnavailableError`; §8's shell turns it into the error screen.
 * * **Never use the cull-distance builtin**; a lint forbids the identifier (§7.1). Only the *clip* half of
 *   `WEBGL_clip_cull_distance` is probed, because `MAX_CULL_DISTANCES_WEBGL` is 0 on ANGLE/Metal `[M2Max]`
 *   and 8 under headless SwiftShader `[SwS]` — CI goldens would pass while every real Mac failed.
 *
 * Phase 0 scope: this file is the capability probe only. `probeCapabilities` in `./caps` is the frozen
 * §7.1 signature and is still `unimplemented` — when Phase 1 fills it in it should call
 * {@link probeContextCapabilities}, not duplicate it.
 */

import type { Capabilities } from './caps';

/** `WEBGL_debug_renderer_info.UNMASKED_VENDOR_WEBGL`. */
const UNMASKED_VENDOR_WEBGL = 0x9245;
/** `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL`. */
const UNMASKED_RENDERER_WEBGL = 0x9246;
/** `WEBGL_clip_cull_distance.MAX_CLIP_DISTANCES_WEBGL`. */
const MAX_CLIP_DISTANCES_WEBGL = 0x0d32;

/** §7.1: `isSoftware` is exactly this test, against the renderer (and vendor) string. */
const SOFTWARE_RENDERER_RE = /SwiftShader|llvmpipe|softpipe/i;

/**
 * The two renderer classes §11 distinguishes. Goldens are stored per class under
 * `packages/engine/test/golden/<class>/` because the classes disagree on `EXT_texture_norm16`, so they
 * quantise the same volume differently (§7.1, §11).
 */
export type RendererClass = 'swiftshader' | 'angle-metal';

export interface GlContext {
  gl: WebGL2RenderingContext;
  caps: Capabilities;
}

/**
 * Limits §7.1's `Capabilities` does not carry but the harness reports, so every CI run records the
 * texture ceilings the §6.1 payload ladder is measured against. Kept out of `Capabilities`, which is
 * frozen with `api.ts` (§12.3 item 3).
 */
export interface GlLimits {
  maxTextureSize: number;
  max3dTextureSize: number;
  maxArrayTextureLayers: number;
  maxRenderbufferSize: number;
  maxSamples: number;
}

/** `getContext('webgl2')` returned null — §7.1 requires a real error, never a white window. */
export class WebGL2UnavailableError extends Error {
  override readonly name = 'WebGL2UnavailableError';
  constructor() {
    super(
      'WebGL2 is unavailable: getContext("webgl2") returned null. ' +
        'Check chrome://gpu — a blocklisted driver yields a null context because Chromium M137 removed ' +
        'the automatic SwiftShader WebGL fallback (ARCHITECTURE.md §1).'
    );
  }
}

/**
 * Context attributes for the engine's single shared context (§7.0 item 2: v1 renders passes 1–3 straight
 * to the default framebuffer and relies on canvas MSAA). Tests override `antialias` and
 * `preserveDrawingBuffer`; goldens run with `aa: 'off'` (§11).
 */
export const DEFAULT_CONTEXT_ATTRIBUTES: Readonly<WebGLContextAttributes> = Object.freeze({
  alpha: false,
  antialias: true,
  depth: true,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  desynchronized: false,
  failIfMajorPerformanceCaveat: false,
});

/** §7.1: `isSoftware` — `/SwiftShader|llvmpipe|softpipe/i` over the renderer string. */
export function isSoftwareRenderer(renderer: string, vendor = ''): boolean {
  return SOFTWARE_RENDERER_RE.test(renderer) || SOFTWARE_RENDERER_RE.test(vendor);
}

/**
 * Which §11 golden directory a run's pixels belong in. Software ⇒ `swiftshader` (the golden authority,
 * §12.1); everything else ⇒ `angle-metal`, whose goldens are compared with a looser ratio.
 */
export function rendererClass(caps: Pick<Capabilities, 'isSoftware'>): RendererClass {
  return caps.isSoftware ? 'swiftshader' : 'angle-metal';
}

function getNumber(gl: WebGL2RenderingContext, pname: GLenum, fallback = 0): number {
  const v: unknown = gl.getParameter(pname);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function getString(gl: WebGL2RenderingContext, pname: GLenum): string {
  const v: unknown = gl.getParameter(pname);
  return typeof v === 'string' ? v : '';
}

/** The §7.1 limits that are not part of the frozen `Capabilities`. */
export function probeGlLimits(gl: WebGL2RenderingContext): GlLimits {
  return {
    maxTextureSize: getNumber(gl, gl.MAX_TEXTURE_SIZE),
    max3dTextureSize: getNumber(gl, gl.MAX_3D_TEXTURE_SIZE),
    maxArrayTextureLayers: getNumber(gl, gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxRenderbufferSize: getNumber(gl, gl.MAX_RENDERBUFFER_SIZE),
    maxSamples: getNumber(gl, gl.MAX_SAMPLES),
  };
}

/**
 * The §7.1 probe. Every optional extension is **requested** (`getExtension`), not merely looked up in
 * `getSupportedExtensions()`, because a driver that has an extension still does not expose it until it is
 * asked for.
 *
 * Call this exactly once per context, before any texture exists.
 */
export function probeContextCapabilities(gl: WebGL2RenderingContext): Capabilities {
  // WEBGL_debug_renderer_info is the documented source of the unmasked strings; modern Chromium also
  // returns them from RENDERER/VENDOR, so fall back rather than reporting an empty renderer.
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer =
    (dbg ? getString(gl, UNMASKED_RENDERER_WEBGL) : '') || getString(gl, gl.RENDERER) || 'unknown';
  const vendor =
    (dbg ? getString(gl, UNMASKED_VENDOR_WEBGL) : '') || getString(gl, gl.VENDOR) || 'unknown';

  // Optional extensions — requested here and nowhere else (§7.1). Each has a named fallback:
  //   OES_texture_float_linear absent ⇒ force interpolation:'nearest' on R32F layers;
  //   EXT_texture_norm16       absent ⇒ the §6.1 ladder steps to R32F or R8;
  //   WEBGL_clip_cull_distance absent ⇒ the `discard` clip path (§7.4);
  //   EXT_disjoint_timer_query_webgl2 absent ⇒ wall-clock frame time only.
  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
  const norm16 = gl.getExtension('EXT_texture_norm16') !== null;
  const clip = gl.getExtension('WEBGL_clip_cull_distance');
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  const colorBufferHalfFloat = gl.getExtension('EXT_color_buffer_half_float') !== null;
  const floatBlend = gl.getExtension('EXT_float_blend') !== null;
  const drawBuffersIndexed = gl.getExtension('OES_draw_buffers_indexed') !== null;
  const timerQuery = gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null;

  return {
    renderer,
    vendor,
    isSoftware: isSoftwareRenderer(renderer, vendor),
    floatLinear,
    norm16,
    clipDistance: clip !== null,
    // Only the clip half is read; the cull half is forbidden by §7.1 and by the lint.
    maxClipDistances: clip !== null ? getNumber(gl, MAX_CLIP_DISTANCES_WEBGL) : 0,
    colorBufferFloat,
    colorBufferHalfFloat,
    floatBlend,
    drawBuffersIndexed,
    timerQuery,
    max3d: getNumber(gl, gl.MAX_3D_TEXTURE_SIZE),
    maxSamples: getNumber(gl, gl.MAX_SAMPLES),
    maxDrawBuffers: getNumber(gl, gl.MAX_DRAW_BUFFERS),
    maxTextureImageUnits: getNumber(gl, gl.MAX_TEXTURE_IMAGE_UNITS),
    maxVaryingVectors: getNumber(gl, gl.MAX_VARYING_VECTORS),
  };
}

/**
 * Create the engine's WebGL2 context and probe it once, before any texture exists (§7.1).
 *
 * @throws {WebGL2UnavailableError} when `getContext('webgl2')` returns null.
 */
export function createContext(
  canvas: HTMLCanvasElement,
  attributes: WebGLContextAttributes = {}
): GlContext {
  const gl = canvas.getContext('webgl2', { ...DEFAULT_CONTEXT_ATTRIBUTES, ...attributes });
  if (gl === null) throw new WebGL2UnavailableError();
  return { gl, caps: probeContextCapabilities(gl) };
}
