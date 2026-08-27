/**
 * The §11 rule-0 proof: one raw-WebGL2 triangle whose every asserted pixel is computed from first
 * principles, never from a previous run. The geometry and the colours live in `./triangle-scene`, which
 * the spec imports too.
 *
 * `antialias: false` (§11 goldens use `aa: 'off'`), so every fragment is fully covered or not drawn and
 * no blend of the two colours exists anywhere in the image. `alpha: false`, so the drawing buffer has no
 * alpha channel to read back as anything but 255.
 */

import { createContext } from '../../src/gl/context';
import { CANVAS_SIZE, CLEAR_RGBA, TRIANGLE_CLIP, TRIANGLE_RGBA } from './triangle-scene';

const VERT = `#version 300 es
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = u_color;
}
`;

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('createShader returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader) ?? ''}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const program = gl.createProgram();
  if (program === null) throw new Error('createProgram returned null');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? ''}`);
  }
  return program;
}

function main(): void {
  const canvas = document.getElementById('gl');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no #gl canvas in the page');

  // preserveDrawingBuffer keeps the frame alive for the golden screenshot; the analytic reads go
  // through window.__tvxRender() in the same task as readPixels and do not depend on it.
  const { gl } = createContext(canvas, {
    antialias: false,
    alpha: false,
    depth: false,
    preserveDrawingBuffer: true,
  });

  const program = link(gl, VERT, FRAG);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(TRIANGLE_CLIP.flat()), gl.STATIC_DRAW);

  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const colorLoc = gl.getUniformLocation(program, 'u_color');

  const render = (): void => {
    gl.viewport(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(
      CLEAR_RGBA[0] / 255,
      CLEAR_RGBA[1] / 255,
      CLEAR_RGBA[2] / 255,
      CLEAR_RGBA[3] / 255
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniform4f(
      colorLoc,
      TRIANGLE_RGBA[0] / 255,
      TRIANGLE_RGBA[1] / 255,
      TRIANGLE_RGBA[2] / 255,
      TRIANGLE_RGBA[3] / 255
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  window.__tvxRender = render;
  render();
  gl.finish();
}

main();
