/**
 * `Buffer` / `VertexArray` (§7.1). Thin, allocation-free on the hot path.
 *
 * §7.4's cap upload rule lives here as {@link Buffer.update}: **`bufferSubData` after an orphaning
 * `bufferData(null)`, never a fresh sized `bufferData` per frame**, and buffers grow by doubling and
 * never shrink during a drag.
 */

export class Buffer {
  readonly buffer: WebGLBuffer;
  readonly target: GLenum;
  #capacity = 0;
  readonly #gl: WebGL2RenderingContext;
  readonly #usage: GLenum;

  constructor(gl: WebGL2RenderingContext, target: GLenum, usage: GLenum = gl.STATIC_DRAW) {
    const b = gl.createBuffer();
    if (b === null) throw new Error('createBuffer returned null');
    this.#gl = gl;
    this.buffer = b;
    this.target = target;
    this.#usage = usage;
  }

  bind(): void {
    this.#gl.bindBuffer(this.target, this.buffer);
  }

  /** One-shot upload; sizes the store exactly. */
  set(data: ArrayBufferView): void {
    const gl = this.#gl;
    gl.bindBuffer(this.target, this.buffer);
    gl.bufferData(this.target, data, this.#usage);
    this.#capacity = data.byteLength;
  }

  /** Grow-by-doubling + orphan + `bufferSubData` (§7.4). */
  update(data: ArrayBufferView): void {
    const gl = this.#gl;
    gl.bindBuffer(this.target, this.buffer);
    if (data.byteLength > this.#capacity) {
      let cap = Math.max(1, this.#capacity);
      while (cap < data.byteLength) cap *= 2;
      gl.bufferData(this.target, cap, this.#usage);
      this.#capacity = cap;
    } else {
      // Orphan: tells the driver the old contents are dead, so it need not stall on in-flight draws.
      gl.bufferData(this.target, this.#capacity, this.#usage);
    }
    gl.bufferSubData(this.target, 0, data);
  }

  dispose(): void {
    this.#gl.deleteBuffer(this.buffer);
  }
}

export class VertexArray {
  readonly vao: WebGLVertexArrayObject;
  readonly #gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    const v = gl.createVertexArray();
    if (v === null) throw new Error('createVertexArray returned null');
    this.#gl = gl;
    this.vao = v;
  }

  bind(): void {
    this.#gl.bindVertexArray(this.vao);
  }

  static unbind(gl: WebGL2RenderingContext): void {
    gl.bindVertexArray(null);
  }

  /** Float attribute. */
  attrib(
    index: number,
    buffer: Buffer,
    size: number,
    type: GLenum,
    normalized = false,
    stride = 0,
    offset = 0
  ): void {
    const gl = this.#gl;
    gl.bindVertexArray(this.vao);
    buffer.bind();
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, type, normalized, stride, offset);
  }

  /** Integer attribute — `vertexAttribIPointer`, required for `uint`/`ivec` inputs (§7.2.3, §7.4). */
  attribI(index: number, buffer: Buffer, size: number, type: GLenum, stride = 0, offset = 0): void {
    const gl = this.#gl;
    gl.bindVertexArray(this.vao);
    buffer.bind();
    gl.enableVertexAttribArray(index);
    gl.vertexAttribIPointer(index, size, type, stride, offset);
  }

  /**
   * Turn one attribute array off, so the shader reads its constant generic value instead.
   *
   * The other half of {@link VertexArray.attrib}, and it exists for an attribute that comes and
   * goes: §4.4's `lineColors` is optional and a layer may lose it between frames, and leaving a
   * divisor-1 array enabled over a buffer that no longer matches the instance count is exactly the
   * out-of-range read WebGL turns into a silent draw of nothing.
   */
  disable(index: number): void {
    const gl = this.#gl;
    gl.bindVertexArray(this.vao);
    gl.disableVertexAttribArray(index);
  }

  elements(buffer: Buffer): void {
    const gl = this.#gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer.buffer);
  }

  dispose(): void {
    this.#gl.deleteVertexArray(this.vao);
  }
}
