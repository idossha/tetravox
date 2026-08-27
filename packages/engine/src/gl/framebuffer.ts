/**
 * `Framebuffer` (§7.1) — colour + depth, MRT-ready, with `samples` **from day one**.
 *
 * §7.0 item 3: the field exists even while unused, because Phase-3 OIT forces the main render
 * offscreen and the free canvas MSAA disappears there; without the field that is a breaking rewrite.
 *
 * §7.0 item 4, encoded as the `samples > 0` guard on the integer path: **integer formats support
 * zero sample counts.** `getInternalformatParameter(..., R32UI, SAMPLES)` returns `[]` and
 * `renderbufferStorageMultisample(..., 4, RGBA32UI, ...)` is `INVALID_OPERATION` `[M2Max]` — so the
 * pick target is allocated with `texStorage2D`, never the multisample entry point.
 */

export interface FramebufferOptions {
  width: number;
  height: number;
  /** One entry per colour attachment. */
  colorFormats: GLenum[];
  depth: boolean;
  /** 0 = single-sample. Integer colour formats force 0 (§7.0.4). */
  samples: number;
}

export class Framebuffer {
  readonly fbo: WebGLFramebuffer;
  readonly textures: WebGLTexture[] = [];
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  #depth: WebGLRenderbuffer | null = null;
  readonly #gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext, o: FramebufferOptions) {
    this.#gl = gl;
    this.width = o.width;
    this.height = o.height;
    this.samples = o.samples;
    const fbo = gl.createFramebuffer();
    if (fbo === null) throw new Error('createFramebuffer returned null');
    this.fbo = fbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    o.colorFormats.forEach((fmt, i) => {
      const tex = gl.createTexture();
      if (tex === null) throw new Error('createTexture returned null');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, o.width, o.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      this.textures.push(tex);
    });

    if (o.depth) {
      const rb = gl.createRenderbuffer();
      if (rb === null) throw new Error('createRenderbuffer returned null');
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      if (o.samples > 0) {
        gl.renderbufferStorageMultisample(
          gl.RENDERBUFFER,
          o.samples,
          gl.DEPTH_COMPONENT24,
          o.width,
          o.height
        );
      } else {
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, o.width, o.height);
      }
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      this.#depth = rb;
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    this.#gl.bindFramebuffer(this.#gl.FRAMEBUFFER, this.fbo);
  }

  dispose(): void {
    const gl = this.#gl;
    for (const t of this.textures) gl.deleteTexture(t);
    if (this.#depth !== null) gl.deleteRenderbuffer(this.#depth);
    gl.deleteFramebuffer(this.fbo);
  }
}
