/**
 * §7.3's volume-slice pass, and the shared plane geometry it owns.
 *
 * **Slice geometry is owned by the plane, not by any volume.** One quad per plane, in the
 * `(right, up)` basis, centred on the cursor and sized to cover the pane; every volume layer on that
 * plane draws from that same VAO through the same vertex shader. Two coplanar quads with different
 * vertex data do **not** produce identical interpolated depth — measured 1.6 %–11.8 % overlay-pixel
 * dropout on ANGLE/Metal at scene scale `[M2Max]` — so identical geometry is the correctness
 * mechanism, not an optimisation.
 *
 * 2D panes render with `DEPTH_TEST` **disabled for the whole slice-layer pass**; compositing order is
 * layer order, bottom → top, with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. There is nothing else in a 2D
 * view to depth-test against.
 *
 * **Phase 2 (owner: E-SLICE)**: `showIn3D` planes join pass 1 of a 3D pane with `DEPTH_TEST` on and
 * `depthFunc(LEQUAL)` — never a separate full-plane depth prepass, which would occlude meshes behind
 * the plane where no volume layer draws.
 */

import { Buffer, VertexArray } from '../../gl/buffer';
import { ProgramVariants } from '../../gl/program';
import { collectDrawItems } from './pass';
import type { DrawInput, FramePass, PassContext } from './pass';
import { SLICE_FS, SLICE_VS } from '../../shaders';
import { isSliceView } from '../../scene/store';
import { sliceBasis, sliceViewProj } from '../../view/geometry';
import type { ViewportRect } from '../../view/layout';
import type { mat4, Scene, SliceView, vec3, View } from '../../scene/types';

/** The shared quad, exposed so the pick pass can draw the very same geometry (§7.2.3). */
export interface SliceQuad {
  vao: VertexArray;
  write: (center: vec3, right: vec3, up: vec3, half: number) => void;
}

export class SlicePass implements FramePass {
  readonly name = 'slice' as const;

  readonly #gl: WebGL2RenderingContext;
  readonly #program: ProgramVariants;
  readonly #quadBuf: Buffer;
  readonly #quadVao: VertexArray;
  readonly #quadData = new Float32Array(18);

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#program = new ProgramVariants(gl, SLICE_VS, SLICE_FS);
    this.#quadBuf = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    this.#quadVao = new VertexArray(gl);
    this.#quadVao.attrib(0, this.#quadBuf, 3, gl.FLOAT);
    VertexArray.unbind(gl);
  }

  /** The shared quad's VAO plus the writer that positions it. */
  get quad(): SliceQuad {
    return {
      vao: this.#quadVao,
      write: (c, r, u, h) => {
        this.#writeQuad(c, r, u, h);
      },
    };
  }

  /**
   * The half-extent that guarantees the quad covers the pane at this zoom, for any view.
   *
   * **One formula.** The pick pass draws the same quad, and a second formula for it let a panned
   * pane hand picking a quad narrower than the one on screen, so a click near the edge returned
   * `null` over a slice the user could see.
   */
  quadHalfFor(view: View, rect: ViewportRect, scene: Scene): number {
    if (!isSliceView(view)) return 1;
    const paneHalf = 0.5 * Math.hypot(rect.width, rect.height) * view.camera.mmPerPx;
    const panned = Math.hypot(view.camera.center[0], view.camera.center[1]);
    let sceneHalf = 1;
    for (const ds of scene.datasets.values()) {
      const b = ds.bounds;
      sceneHalf = Math.max(
        sceneHalf,
        0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
      );
    }
    return Math.max(paneHalf + panned, sceneHalf) * 1.05;
  }

  #writeQuad(center: vec3, right: vec3, up: vec3, half: number): void {
    const d = this.#quadData;
    const corner = (sx: number, sy: number, at: number): void => {
      d[at] = center[0] + right[0] * sx * half + up[0] * sy * half;
      d[at + 1] = center[1] + right[1] * sx * half + up[1] * sy * half;
      d[at + 2] = center[2] + right[2] * sx * half + up[2] * sy * half;
    };
    corner(-1, -1, 0);
    corner(1, -1, 3);
    corner(1, 1, 6);
    corner(-1, -1, 9);
    corner(1, 1, 12);
    corner(-1, 1, 15);
    this.#quadBuf.update(d);
  }

  run(ctx: PassContext): void {
    const { view, rect, viewProj, input } = ctx;
    if (!isSliceView(view)) return;
    const gl = this.#gl;
    const { scene } = input;
    // §7.3: depth test OFF for the whole 2D slice-layer pass; order is layer order, bottom -> top.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const basis = sliceBasis(view, scene.radiological);
    this.#writeQuad(scene.cursor, basis.right, basis.up, this.quadHalfFor(view, rect, scene));
    this.#quadVao.bind();

    for (const item of collectDrawItems(input, view)) {
      if (item.kind !== 'volume') continue;
      const { layer, ds, gpu } = item;

      const prog = this.#program.get({ IS_LABEL: gpu.integer ? 1 : 0 });
      prog.use();
      prog.mat4('uViewProj', viewProj);
      prog.mat4('uInvAffine', ds.inverseAffine);
      prog.vec3('uDims', ds.dims);
      prog.float('uOpacity', layer.opacity);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, gpu.texture);
      prog.int('uVol', 0);
      // §4.4's `interpolation`, applied per draw rather than baked at upload — it is a *reading*,
      // and §7.2 forbids ever degrading it as a quality knob. The §7.1 invariant still rules:
      // LINEAR on a format `caps` says is not filterable makes the texture incomplete and it
      // samples 0 with **no GL error**, so `filterable` and `integer` veto the layer's preference.
      const wantLinear = layer.interpolation === 'linear' && !gpu.integer && gpu.filterable;
      const filter = wantLinear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);

      if (gpu.integer) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, gpu.palette);
        prog.int('uPalette', 1);
        prog.float('uPaletteSize', Math.max(1, gpu.paletteSize));
        prog.vec2('uLutRange', [0, 1]);
      } else {
        const lut = input.store.lut(layer.scale, layer.colormap, layer.colormapNegative);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, lut.texture);
        prog.int('uLut', 1);
        prog.vec2('uLutRange', [lut.lo, lut.hi]);
        prog.float('uValueScale', gpu.valueScale);
        prog.float('uValueOffset', gpu.valueOffset);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    VertexArray.unbind(gl);
  }

  dispose(): void {
    this.#program.dispose();
    this.#quadBuf.dispose();
    this.#quadVao.dispose();
  }
}

/**
 * The orthographic view-projection of a 2D pane.
 *
 * Depth runs `-halfDepth .. +halfDepth` along the normal, so a 2D pane and a `showIn3D` plane share
 * one sign convention.
 */
export function sliceCamera(
  view: SliceView,
  scene: Scene,
  rect: ViewportRect,
  halfDepth: number
): mat4 {
  return sliceViewProj(view, scene.cursor, rect.width, rect.height, scene.radiological, halfDepth)
    .viewProj;
}

/** Re-exported so the renderer can build a `DrawInput` without importing the pass module twice. */
export type { DrawInput };
