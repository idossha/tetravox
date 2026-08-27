/**
 * GL capability probe — `docs/ARCHITECTURE.md` §7.1.
 *
 * `Capabilities` is the second (and last) thing `api.ts` imports, so it is effectively frozen with it.
 *
 * Rules (§7.1):
 * * `probeCapabilities` runs **once, at context creation, before any texture exists**, and is cached on
 *   the engine. `getExtension` is a *request*, not a query — it must be **called**, or the feature is
 *   unavailable even where the driver has it.
 * * **Invariant:** never leave `TEXTURE_MIN/MAG_FILTER = LINEAR` on a format `caps` says is not
 *   filterable. The texture becomes incomplete and samples 0 **with no GL error** `[M2Max]`.
 * * REQUIRED = WebGL2 core only. Every optional extension has a named fallback.
 * * **Never use `gl_CullDistance`; a lint forbids the identifier.** `MAX_CULL_DISTANCES_WEBGL` is 0 on
 *   ANGLE/Metal `[M2Max]` but **8 under headless SwiftShader** `[SwS]` — CI goldens would pass while
 *   every real Mac fails.
 * * The golden authority (SwiftShader) has **no `EXT_texture_norm16`**, so goldens can only ever pin the
 *   R32F branch of the §6.1 ladder; the R16 branch is covered by paired analytic pixel tests through
 *   `EngineOptions.forceCaps`.
 */

import { probeContextCapabilities } from './context';

export interface Capabilities {
  /** `WEBGL_debug_renderer_info` */
  renderer: string;
  vendor: string;
  /** `/SwiftShader|llvmpipe|softpipe/i` */
  isSoftware: boolean;
  /** `OES_texture_float_linear` */
  floatLinear: boolean;
  /** `EXT_texture_norm16` (R16 = 0x822A, R16_SNORM = 0x8F98) */
  norm16: boolean;
  /** `WEBGL_clip_cull_distance` */
  clipDistance: boolean;
  maxClipDistances: number;
  colorBufferFloat: boolean;
  colorBufferHalfFloat: boolean;
  floatBlend: boolean;
  drawBuffersIndexed: boolean;
  /** `EXT_disjoint_timer_query_webgl2` */
  timerQuery: boolean;
  max3d: number;
  maxSamples: number;
  maxDrawBuffers: number;
  maxTextureImageUnits: number;
  maxVaryingVectors: number;
}

export function probeCapabilities(gl: WebGL2RenderingContext): Capabilities {
  // §7.1: one implementation. `context.ts` holds it because that is the only place allowed to call
  // `getExtension`, and this frozen signature delegates rather than duplicating the probe.
  return probeContextCapabilities(gl);
}

/**
 * Apply `EngineOptions.forceCaps` (§7.1, §11).
 *
 * **May only ever REMOVE a capability, never add one** — a test axis that could invent
 * `norm16: true` on SwiftShader would render a texture format the driver does not have. Each field
 * is therefore ANDed with the probed value.
 */
export function applyForcedCaps(
  probed: Capabilities,
  forced?: Partial<Pick<Capabilities, 'norm16' | 'floatLinear' | 'clipDistance' | 'timerQuery'>>
): Capabilities {
  if (forced === undefined) return probed;
  const out: Capabilities = { ...probed };
  if (forced.norm16 !== undefined) out.norm16 = probed.norm16 && forced.norm16;
  if (forced.floatLinear !== undefined) out.floatLinear = probed.floatLinear && forced.floatLinear;
  if (forced.clipDistance !== undefined) {
    out.clipDistance = probed.clipDistance && forced.clipDistance;
    if (!out.clipDistance) out.maxClipDistances = 0;
  }
  if (forced.timerQuery !== undefined) out.timerQuery = probed.timerQuery && forced.timerQuery;
  return out;
}
