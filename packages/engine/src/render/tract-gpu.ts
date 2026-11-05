/**
 * §7.4.1's GPU resources. The buffers arrive from the dataset's worker as transferables and are only
 * uploaded here (AGENTS rule 6). Geometry is per dataset and shared; a layer owns its VAOs, its one
 * active scalar and its style table, so switching a field or a filter re-uploads no vertex.
 */

import type { OpResult } from '@tetravox/protocol';
import { Buffer, VertexArray } from '../gl/buffer';

const STYLE_WIDTH = 2048;

export class TractGeometry {
  readonly vertices: Buffer;
  readonly ids: Buffer;
  readonly indices: Buffer;
  readonly origin: [number, number, number];
  readonly quantum: number;
  readonly nPoints: number;
  readonly indexCount: number;

  constructor(gl: WebGL2RenderingContext, p: OpResult['tractGeometry']) {
    this.vertices = new Buffer(gl, gl.ARRAY_BUFFER);
    this.vertices.set(p.vertices);
    this.ids = new Buffer(gl, gl.ARRAY_BUFFER);
    this.ids.set(p.streamlineIds);
    this.indices = new Buffer(gl, gl.ELEMENT_ARRAY_BUFFER);
    this.indices.set(p.indices);
    this.origin = p.origin;
    this.quantum = p.quantum;
    this.nPoints = p.vertices.length / 8;
    this.indexCount = p.indices.length;
  }

  dispose(): void {
    this.vertices.dispose();
    this.ids.dispose();
    this.indices.dispose();
  }
}

/** Bind the point at `base` (0 for this point, 1 for the next) to the four attributes from `at`. */
function bindPoint(
  gl: WebGL2RenderingContext,
  vao: VertexArray,
  g: TractGeometry,
  at: number,
  base: 0 | 1,
  divisor: 0 | 1
): void {
  vao.attrib(at, g.vertices, 3, gl.SHORT, false, 8, base * 8);
  vao.attrib(at + 1, g.vertices, 2, gl.BYTE, true, 8, base * 8 + 6);
  vao.attribI(at + 2, g.ids, 1, gl.UNSIGNED_INT, 4, base * 4);
  gl.bindVertexArray(vao.vao);
  gl.vertexAttribDivisor(at, divisor);
  gl.vertexAttribDivisor(at + 1, divisor);
  gl.vertexAttribDivisor(at + 2, divisor);
}

export class TractLayerGpu {
  readonly #gl: WebGL2RenderingContext;
  readonly geometry: TractGeometry;
  readonly lines: VertexArray;
  readonly quads: VertexArray;
  readonly style: WebGLTexture;
  readonly styleWidth = STYLE_WIDTH;
  #scalar: Buffer | null = null;
  scalarLo = 0;
  scalarHi = 1;
  hasStyle = false;

  constructor(gl: WebGL2RenderingContext, geometry: TractGeometry) {
    this.#gl = gl;
    this.geometry = geometry;
    this.lines = new VertexArray(gl);
    this.quads = new VertexArray(gl);
    bindPoint(gl, this.lines, geometry, 0, 0, 0);
    this.lines.elements(geometry.indices);
    bindPoint(gl, this.quads, geometry, 0, 0, 1);
    bindPoint(gl, this.quads, geometry, 4, 1, 1);
    gl.bindVertexArray(null);
    gl.vertexAttrib1f(3, 0);
    gl.vertexAttrib1f(7, 0);
    this.style = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.style);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  get hasScalar(): boolean {
    return this.#scalar !== null;
  }

  setScalar(p: OpResult['tractScalar'] | null): void {
    const gl = this.#gl;
    if (p === null) {
      this.#scalar?.dispose();
      this.#scalar = null;
      this.lines.disable(3);
      this.quads.disable(3);
      this.quads.disable(7);
      gl.bindVertexArray(null);
      return;
    }
    this.#scalar ??= new Buffer(gl, gl.ARRAY_BUFFER);
    this.#scalar.set(p.values);
    this.scalarLo = p.lo;
    this.scalarHi = p.hi;
    this.lines.attrib(3, this.#scalar, 1, gl.UNSIGNED_SHORT, false, 2, 0);
    this.quads.attrib(3, this.#scalar, 1, gl.UNSIGNED_SHORT, false, 2, 0);
    this.quads.attrib(7, this.#scalar, 1, gl.UNSIGNED_SHORT, false, 2, 2);
    gl.bindVertexArray(this.quads.vao);
    gl.vertexAttribDivisor(3, 1);
    gl.vertexAttribDivisor(7, 1);
    gl.bindVertexArray(null);
  }

  /** 4 bytes per streamline; padded so the table is whole rows. */
  setStyle(rgba: Uint8Array): void {
    const gl = this.#gl;
    const count = Math.max(1, rgba.length / 4);
    const rows = Math.ceil(count / STYLE_WIDTH);
    const data = new Uint8Array(STYLE_WIDTH * rows * 4);
    data.set(rgba);
    gl.bindTexture(gl.TEXTURE_2D, this.style);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      STYLE_WIDTH,
      rows,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.hasStyle = true;
  }

  dispose(): void {
    this.lines.dispose();
    this.quads.dispose();
    this.#scalar?.dispose();
    this.#gl.deleteTexture(this.style);
  }
}
