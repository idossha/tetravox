/**
 * Raw WebGL2, no library (§1: the engine is hand-written; this is its smallest possible ancestor).
 *
 * One flat triangle whose colour is a uniform. The drawing buffer is plain RGBA8 — no MSAA, no sRGB
 * encode, no blending — so the bytes handed to `uColor` are exactly the bytes `readPixels` returns and
 * exactly the bytes in the screenshot. That is what makes the e2e assertion analytic rather than a
 * golden comparison (§11 rule 0).
 */

const VERTEX_SHADER = `#version 300 es
// No attributes, no buffers: three positions from gl_VertexID. Covers the centre of the viewport and
// leaves all four corners as background.
void main() {
  vec2 p = vec2(0.0);
  if (gl_VertexID == 0) p = vec2(-0.85, -0.75);
  else if (gl_VertexID == 1) p = vec2(0.85, -0.75);
  else p = vec2(0.0, 0.85);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fragColor;
void main() { fragColor = vec4(uColor, 1.0); }
`;

export class Webgl2Unavailable extends Error {
  constructor() {
    super('getContext("webgl2") returned null');
    this.name = 'Webgl2Unavailable';
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)';
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

export interface TriangleContext {
  gl: WebGL2RenderingContext;
  renderer: string;
  vendor: string;
  /** §7.1: `/SwiftShader|llvmpipe|softpipe/i` — surfaced rather than silently running at 2 fps. */
  isSoftware: boolean;
}

/**
 * `preserveDrawingBuffer` so `readPixels` and the screenshot see the same frame after the rAF that
 * drew it; `antialias: false` so the interior of the triangle is one exact colour.
 */
export function createContext(canvas: HTMLCanvasElement): TriangleContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (gl === null) throw new Webgl2Unavailable();

  // §7.1: `getExtension` is a request, not a query — it must be *called*.
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(
    (info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) ?? gl.getParameter(gl.RENDERER)
  );
  const vendor = String(
    (info && gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) ?? gl.getParameter(gl.VENDOR)
  );
  return { gl, renderer, vendor, isSoftware: /SwiftShader|llvmpipe|softpipe/i.test(renderer) };
}

export function drawTriangle(
  gl: WebGL2RenderingContext,
  color: readonly [number, number, number],
  background: readonly [number, number, number]
): void {
  const program = gl.createProgram();
  if (program === null) throw new Error('createProgram failed');
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`link failed: ${gl.getProgramInfoLog(program) ?? '(no log)'}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  // WebGL2 requires a bound VAO for a draw call, even one that reads no attributes.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(background[0] / 255, background[1] / 255, background[2] / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(program);
  gl.uniform3f(
    gl.getUniformLocation(program, 'uColor'),
    color[0] / 255,
    color[1] / 255,
    color[2] / 255
  );
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.finish();
}

/** Bottom-left-origin read, matching GL. Returns `[r, g, b, a]`. */
export function readPixel(
  gl: WebGL2RenderingContext,
  x: number,
  y: number
): [number, number, number, number] {
  const out = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0, out[3] ?? 0];
}
