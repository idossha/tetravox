/**
 * §7.1's load-bearing rule is not "read some limits" — it is **`getExtension` is a request, not a
 * query: it must be called, or the feature is unavailable even where the driver has it.** A probe that
 * used `getSupportedExtensions()` would report the same booleans and leave every optional path dead.
 *
 * So this test drives `probeContextCapabilities` with a recording stub and asserts *which calls it
 * made*, not only what it returned. It also pins `isSoftware` and the golden-directory mapping, which
 * decide where every §11 golden is stored.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_ATTRIBUTES,
  isSoftwareRenderer,
  probeContextCapabilities,
  probeGlLimits,
  rendererClass,
} from '../../src/gl/context';

/** WebGL/WebGL2 enum values the probe reads, spelled out so the stub is self-describing. */
const GL = {
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_SAMPLES: 0x8d57,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VARYING_VECTORS: 0x8dfc,
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246,
  MAX_CLIP_DISTANCES_WEBGL: 0x0d32,
} as const;

/** Every optional extension §7.1 names, with its documented fallback. */
const OPTIONAL_EXTENSIONS = [
  'OES_texture_float_linear',
  'EXT_texture_norm16',
  'WEBGL_clip_cull_distance',
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'EXT_float_blend',
  'OES_draw_buffers_indexed',
  'EXT_disjoint_timer_query_webgl2',
] as const;

interface StubOptions {
  granted?: readonly string[];
  renderer?: string;
  vendor?: string;
  params?: Readonly<Record<number, number>>;
}

interface Stub {
  gl: WebGL2RenderingContext;
  requested: string[];
}

function makeStub(opts: StubOptions = {}): Stub {
  const granted = new Set<string>(
    opts.granted ?? [...OPTIONAL_EXTENSIONS, 'WEBGL_debug_renderer_info']
  );
  const requested: string[] = [];
  const params: Record<number, number | string> = {
    [GL.MAX_TEXTURE_SIZE]: 16384,
    [GL.MAX_3D_TEXTURE_SIZE]: 2048,
    [GL.MAX_ARRAY_TEXTURE_LAYERS]: 2048,
    [GL.MAX_RENDERBUFFER_SIZE]: 16384,
    [GL.MAX_SAMPLES]: 4,
    [GL.MAX_DRAW_BUFFERS]: 8,
    [GL.MAX_TEXTURE_IMAGE_UNITS]: 16,
    [GL.MAX_VARYING_VECTORS]: 31,
    [GL.MAX_CLIP_DISTANCES_WEBGL]: 8,
    ...(opts.params ?? {}),
  };
  const renderer = opts.renderer ?? 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)';
  const vendor = opts.vendor ?? 'Google Inc. (Apple)';
  params[GL.RENDERER] = renderer;
  params[GL.VENDOR] = vendor;
  params[GL.UNMASKED_RENDERER_WEBGL] = renderer;
  params[GL.UNMASKED_VENDOR_WEBGL] = vendor;

  const gl = {
    ...GL,
    getExtension(name: string): object | null {
      requested.push(name);
      return granted.has(name) ? {} : null;
    },
    getParameter(pname: number): number | string | null {
      return params[pname] ?? null;
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, requested };
}

describe('§7.1 probeContextCapabilities', () => {
  it('requests every optional extension by calling getExtension', () => {
    const { gl, requested } = makeStub();
    probeContextCapabilities(gl);
    for (const name of OPTIONAL_EXTENSIONS) {
      expect(requested, `${name} was never requested; §7.1 says a query is not enough`).toContain(
        name
      );
    }
    // Exactly once each: a second request is a sign the probe is being re-run per frame.
    for (const name of requested) {
      expect(requested.filter((n) => n === name)).toHaveLength(1);
    }
  });

  it('reports a capability as present only when the request was granted', () => {
    const caps = probeContextCapabilities(makeStub().gl);
    expect(caps.floatLinear).toBe(true);
    expect(caps.norm16).toBe(true);
    expect(caps.clipDistance).toBe(true);
    expect(caps.colorBufferFloat).toBe(true);
    expect(caps.colorBufferHalfFloat).toBe(true);
    expect(caps.floatBlend).toBe(true);
    expect(caps.drawBuffersIndexed).toBe(true);
    expect(caps.timerQuery).toBe(true);

    const none = probeContextCapabilities(makeStub({ granted: [] }).gl);
    expect(none.floatLinear).toBe(false);
    expect(none.norm16).toBe(false);
    expect(none.clipDistance).toBe(false);
    expect(none.colorBufferFloat).toBe(false);
    expect(none.timerQuery).toBe(false);
    // Without the extension there are no clip planes, whatever the driver would answer.
    expect(none.maxClipDistances).toBe(0);
    // …and the renderer string still has to come from somewhere (§7.1: never an empty renderer).
    expect(none.renderer).toBe('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)');
  });

  it('reads maxClipDistances only from the clip half of WEBGL_clip_cull_distance', () => {
    const caps = probeContextCapabilities(makeStub().gl);
    // §7.1 forbids the cull half outright: MAX_CULL_DISTANCES_WEBGL is 0 on ANGLE/Metal and 8 under
    // SwiftShader, so a CI golden would pass while every real Mac failed.
    expect(caps.maxClipDistances).toBe(8);
  });

  it('classifies the two renderer classes §11 stores goldens under', () => {
    const swiftshader =
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)';
    const angleMetal = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)';

    expect(isSoftwareRenderer(swiftshader)).toBe(true);
    expect(isSoftwareRenderer('Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('softpipe')).toBe(true);
    expect(isSoftwareRenderer(angleMetal)).toBe(false);

    expect(rendererClass(probeContextCapabilities(makeStub({ renderer: swiftshader }).gl))).toBe(
      'swiftshader'
    );
    expect(rendererClass(probeContextCapabilities(makeStub({ renderer: angleMetal }).gl))).toBe(
      'angle-metal'
    );
  });

  it('falls back to RENDERER/VENDOR when WEBGL_debug_renderer_info is not granted', () => {
    const caps = probeContextCapabilities(
      makeStub({ granted: [...OPTIONAL_EXTENSIONS], renderer: 'Some Driver' }).gl
    );
    expect(caps.renderer).toBe('Some Driver');
    expect(caps.vendor).toBe('Google Inc. (Apple)');
  });

  it('never reports a non-finite limit', () => {
    // getParameter returns null for anything the driver does not know; a NaN limit would poison every
    // ladder comparison in §6.1 silently.
    const { gl } = makeStub({ params: {} });
    const caps = probeContextCapabilities(gl);
    const limits = probeGlLimits(gl);
    for (const v of [
      caps.max3d,
      caps.maxSamples,
      caps.maxDrawBuffers,
      caps.maxTextureImageUnits,
      caps.maxVaryingVectors,
      limits.maxTextureSize,
      limits.maxArrayTextureLayers,
      limits.maxRenderbufferSize,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('§7.0 default context attributes', () => {
  it('asks for canvas MSAA and no preserved drawing buffer', () => {
    // §7.0 item 2: v1 renders passes 1-3 straight to the default framebuffer and relies on the free
    // canvas MSAA; item 3 forbids building an FBO chain yet.
    expect(DEFAULT_CONTEXT_ATTRIBUTES.antialias).toBe(true);
    expect(DEFAULT_CONTEXT_ATTRIBUTES.preserveDrawingBuffer).toBe(false);
    expect(DEFAULT_CONTEXT_ATTRIBUTES.depth).toBe(true);
  });
});
