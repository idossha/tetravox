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
 * **`showIn3D` planes** join pass 1 of a 3D pane in `GL_STATE.slice3d` — `DEPTH_TEST` on,
 * `depthFunc(LEQUAL)`, `depthMask(true)` — and never through a separate full-plane depth prepass,
 * which would occlude meshes behind the plane where no volume layer draws. The quad there is written
 * once per plane and every layer on that plane draws from it, which is the same rule as in 2D and is
 * what makes `LEQUAL` pass for the second layer.
 *
 * This file sets uniforms and issues draws. Everything about *what colour a value is* lives on the
 * CPU in `color/colormaps.ts` (§7.6: `heat` "is a different bake"), and everything about *which
 * draws exist* lives in `layers/volume.ts`.
 */

import { Buffer, VertexArray } from '../../gl/buffer';
import { ProgramVariants } from '../../gl/program';
import type { Program } from '../../gl/program';
import { GL_STATE } from '../../gl/state';
import type { GlState } from '../../gl/state';
import { collectDrawItems } from './pass';
import type { DrawInput, FramePass, PassContext } from './pass';
import { SLICE_FS, SLICE_VS } from '../../shaders';
import { isSliceView } from '../../scene/store';
import { sliceBasis, sliceViewProj } from '../../view/geometry';
import type { ViewportRect } from '../../view/layout';
import type { VolumeDrawItem } from '../../layers/runtime';
import type { mat4, Scene, SliceView, vec3, vec4, View } from '../../scene/types';

/** The shared quad, exposed so the pick pass can draw the very same geometry (§7.2.3). */
export interface SliceQuad {
  vao: VertexArray;
  write: (center: vec3, right: vec3, up: vec3, half: number) => void;
}

/**
 * `labelMode: 'both'` darkens the boundary by this much.
 *
 * `'both'` has to differ from `'fill'` somewhere, and drawing the rim in the label's own undarkened
 * colour would make the two modes pixel-identical. A multiplier on the label's own hue keeps the
 * region identifiable at the rim, which a fixed rim colour would not.
 */
export const LABEL_OUTLINE_DARKEN = 0.5;

/** R5's selected-label emphasis rim: opaque white, so it reads over any palette colour. */
export const LABEL_SELECT_COLOR: vec4 = [1, 1, 1, 1];

/** ...drawn this much wider than `outlineWidthPx`, so the selection is visible at a glance. */
export const LABEL_SELECT_WIDTH_SCALE = 2;

/**
 * The finite stand-in for `±Infinity` in a threshold uniform.
 *
 * `Threshold`'s default is `lo: -Infinity, hi: +Infinity` (`scene/defaults.ts`), and `hi - lo` is
 * then `Infinity`, which turns `softEdge * (hi - lo)` into a NaN the moment `softEdge` is 0. A
 * sentinel three orders above any imaging value keeps the arithmetic finite and the comparison
 * unchanged.
 */
const UNBOUNDED = 1e30;

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

export class SlicePass implements FramePass {
  readonly name = 'slice' as const;

  readonly #gl: WebGL2RenderingContext;
  readonly #state: GlState;
  readonly #program: ProgramVariants;
  readonly #quadBuf: Buffer;
  readonly #quadVao: VertexArray;
  readonly #quadData = new Float32Array(18);

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.#gl = gl;
    this.#state = state;
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
   *
   * In a **3D** pane there is no `mmPerPx` and no pan, and §7.3 sizes the quad to the scene's
   * bounding-sphere radius, so that term is what is left of the same expression.
   */
  quadHalfFor(view: View, rect: ViewportRect, scene: Scene): number {
    const sceneHalf = sceneHalfExtent(scene);
    if (!isSliceView(view)) return sceneHalf;
    const paneHalf = 0.5 * Math.hypot(rect.width, rect.height) * view.camera.mmPerPx;
    const panned = Math.hypot(view.camera.center[0], view.camera.center[1]);
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
    const { scene } = input;
    const items = collectDrawItems(input, view).filter(
      (i): i is VolumeDrawItem => i.kind === 'volume'
    );
    if (items.length === 0) return;
    const gl = this.#gl;

    if (isSliceView(view)) {
      // §7.3: depth test OFF for the whole 2D slice-layer pass; order is layer order, bottom -> top.
      this.#state.apply(GL_STATE.blend2d);
      const basis = sliceBasis(view, scene.radiological);
      this.#writeQuad(scene.cursor, basis.right, basis.up, this.quadHalfFor(view, rect, scene));
      this.#quadVao.bind();
      for (const item of items) this.#draw(item, viewProj, input);
      VertexArray.unbind(gl);
      return;
    }

    // §7.2 pass 1 in a 3D pane: the plane of each `SliceView` whose owning volume layer has
    // `showIn3D`. Grouped **by plane** so each plane's quad is written once and every layer on it
    // draws from bit-identical vertex data — which is what makes `LEQUAL` let the second layer
    // through instead of z-fighting it. Layer order is preserved inside each group, so compositing
    // reads the same as it does in the 2D pane.
    this.#state.apply(GL_STATE.slice3d);
    const half = this.quadHalfFor(view, rect, scene);
    this.#quadVao.bind();
    for (const plane of scene.slices) {
      const onPlane = items.filter((i) => i.plane?.id === plane.id);
      if (onPlane.length === 0) continue;
      const basis = sliceBasis(plane, scene.radiological);
      this.#writeQuad(scene.cursor, basis.right, basis.up, half);
      for (const item of onPlane) this.#draw(item, viewProj, input);
    }
    VertexArray.unbind(gl);
  }

  /** One draw per (layer, plane) — §7.3's "one draw per (layer, plane)", and the only one. */
  #draw(item: VolumeDrawItem, viewProj: mat4, input: DrawInput): void {
    const gl = this.#gl;
    const { layer, gpu } = item;

    const prog = this.#program.get({ IS_LABEL: gpu.integer ? 1 : 0 });
    prog.use();
    prog.mat4('uViewProj', viewProj);
    prog.float('uOpacity', layer.opacity);
    bindSliceSampling(gl, prog, item, input);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    this.#program.dispose();
    this.#quadBuf.dispose();
    this.#quadVao.dispose();
  }
}

/**
 * What a slice fragment samples: the volume texture, its filter, and either the label palette or the
 * baked `Scale` LUT plus §4.2's value gate.
 *
 * **Exported and shared with the pick pass.** §7.2.3 requires pass 4 to reproduce every discard pass
 * 1 made, and the discards are decided by exactly these uniforms; two call sites setting them from
 * two copies of this function is how a pick starts landing on a fragment the threshold removed. The
 * pick program is compiled from the same `SLICE_FS_HEAD` (`shaders/slice.ts`), so the uniform names
 * are the same by construction too.
 */
export function bindSliceSampling(
  gl: WebGL2RenderingContext,
  prog: Program,
  item: Pick<VolumeDrawItem, 'layer' | 'ds' | 'gpu' | 'labelStyle'>,
  input: DrawInput
): void {
  const { layer, ds, gpu, labelStyle } = item;
  prog.mat4('uInvAffine', ds.inverseAffine);
  prog.vec3('uDims', ds.dims);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, gpu.texture);
  prog.int('uVol', 0);
  // §4.4's `interpolation`, applied per draw rather than baked at upload — it is a *reading*, and
  // §7.2 forbids ever degrading it as a quality knob. The §7.1 invariant still rules: LINEAR on a
  // format `caps` says is not filterable makes the texture incomplete and it samples 0 with **no GL
  // error**, so `filterable` and `integer` veto the layer's preference.
  const wantLinear = layer.interpolation === 'linear' && !gpu.integer && gpu.filterable;
  const filter = wantLinear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);

  if (gpu.integer) {
    // The label branch. The layer's own `labelStyle` wins over the dataset's plain palette, because
    // `visibleLabels` and `labelOpacity` are per-layer (§4.4) and are baked into it.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, labelStyle?.palette ?? gpu.palette);
    prog.int('uPalette', 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, labelStyle?.attrs ?? null);
    prog.int('uLabelAttr', 2);
    prog.float('uPaletteSize', Math.max(1, labelStyle?.size ?? gpu.paletteSize));
    prog.int('uLabelMode', layer.labelMode === 'outline' ? 1 : layer.labelMode === 'both' ? 2 : 0);
    // §7.0.5: `outlineWidthPx` is in RENDER-TARGET pixels, so it carries the DPR/SSAA factor.
    prog.float('uOutlineWidthPx', Math.max(0, layer.outlineWidthPx) * input.uiScale);
    prog.float('uOutlineDarken', LABEL_OUTLINE_DARKEN);
    prog.vec4('uSelectColor', LABEL_SELECT_COLOR);
    prog.float('uSelectWidthScale', LABEL_SELECT_WIDTH_SCALE);
    return;
  }

  // The scalar branch: the baked `Scale` LUT plus §4.2's value gate.
  const lut = input.store.lut(layer.scale, layer.colormap, layer.colormapNegative);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lut.texture);
  prog.int('uLut', 1);
  prog.vec2('uLutRange', [lut.lo, lut.hi]);
  prog.float('uValueScale', gpu.valueScale);
  prog.float('uValueOffset', gpu.valueOffset);

  const t = layer.threshold;
  prog.vec2('uThreshold', [finiteOr(t.lo, -UNBOUNDED), finiteOr(t.hi, UNBOUNDED)]);
  prog.float('uSoftEdge', Math.max(0, t.softEdge));
  prog.int('uThresholdMode', t.mode === 'hide' ? 1 : 0);
  prog.int('uSymmetric', t.symmetric ? 1 : 0);
  prog.float('uClipMax', finiteOr(lut.clipMax, UNBOUNDED));
}

/** Half the diagonal of every dataset's bounds — §7.3's "scene bounding-sphere radius". */
export function sceneHalfExtent(scene: Scene): number {
  let half = 1;
  for (const ds of scene.datasets.values()) {
    const b = ds.bounds;
    half = Math.max(
      half,
      0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
    );
  }
  return half;
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
