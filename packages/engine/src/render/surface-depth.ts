import { GL_STATE } from '../gl/state';
import type { GlState, StateBlock } from '../gl/state';

/** §7.2: resolve the nearest (or second-nearest) sheet before blending, independent of winding. */
export class SurfaceDepth {
  readonly #gl: WebGL2RenderingContext;
  readonly #state: GlState;
  #fbo: WebGLFramebuffer | null = null;
  #texture: WebGLTexture | null = null;
  #peeled: WebGLTexture | null = null;
  #width = 0;
  #height = 0;

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.#gl = gl;
    this.#state = state;
  }

  draw(
    block: StateBlock,
    draw: (depth?: WebGLTexture, peel?: WebGLTexture) => void,
    second = false
  ): void {
    const gl = this.#gl;
    const target = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    try {
      this.#ensure();
      // The prepass uses the same material, clipping and alpha discard as the colour draw.
      // A separate depth attachment preserves opaque occlusion and canvas MSAA.
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.#fbo);
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.TEXTURE_2D,
        this.#texture,
        0
      );
      this.#state.apply({ ...GL_STATE.opaque3d, cull: block.cull });
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      draw();
      if (second) {
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.TEXTURE_2D,
          this.#peeled,
          0
        );
        gl.clear(gl.DEPTH_BUFFER_BIT);
        draw(undefined, this.#texture!);
      }
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
      this.#state.apply(block);
      draw((second ? this.#peeled : this.#texture)!);
    } finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
      this.#state.apply(block);
    }
  }

  #ensure(): void {
    const gl = this.#gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (this.#texture !== null && width === this.#width && height === this.#height) return;
    this.dispose();
    this.#fbo = gl.createFramebuffer();
    this.#texture = gl.createTexture();
    this.#peeled = gl.createTexture();
    if (this.#fbo === null || this.#texture === null || this.#peeled === null) {
      this.dispose();
      throw new Error('surface depth allocation failed');
    }
    gl.activeTexture(gl.TEXTURE5);
    for (const texture of [this.#texture, this.#peeled]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.#fbo);
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      this.#texture,
      0
    );
    gl.drawBuffers([gl.NONE]);
    if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.dispose();
      throw new Error('surface depth framebuffer incomplete');
    }
    this.#width = width;
    this.#height = height;
  }

  dispose(): void {
    this.#gl.deleteTexture(this.#texture);
    this.#gl.deleteTexture(this.#peeled);
    this.#gl.deleteFramebuffer(this.#fbo);
    this.#texture = null;
    this.#peeled = null;
    this.#fbo = null;
  }
}
