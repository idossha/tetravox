/**
 * §7.2.3's pick pass — pass 4, on demand.
 *
 * Target: **two single-sample `R32UI` colour attachments** (id, depth-as-uint) plus a
 * `DEPTH_COMPONENT24` renderbuffer, at the same device-pixel size as the colour target so ids are
 * 1:1 with displayed pixels. `RGBA32UI` in one attachment would carry the same two values for
 * **2×** the memory (74.6 MB vs 37.3 MB at 2880×1620 `[M2Max]`).
 *
 * Depth comes from that second colour attachment, **never** from the depth attachment: WebGL2
 * restricts `readPixels` to RGBA / RGBA_INTEGER and the implementation-defined format, and
 * `DEPTH_COMPONENT` is not a legal read format.
 *
 * Payload: `id = (layerIndex + 1) << 25 | kindBit << 24 | (gmshElementNumber & 0x00FFFFFF)`, and
 * **0 means miss** — hence the zero clear.
 *
 * **This pass must reproduce every discard of the main pass.** In Phase 1 that is §7.3's texcoord
 * discard alone; Phase 2 adds the up-to-6 clip planes (the same enable set), the threshold and label
 * discards, and the isolation `BitMask`. Otherwise double-click lands on geometry the user cannot
 * see. Each owner appends its branch here and puts the decision itself in its own layer runtime.
 */

import { Framebuffer } from '../../gl/framebuffer';
import { VertexArray } from '../../gl/buffer';
import { Program, ProgramVariants } from '../../gl/program';
import type { ShaderDefines } from '../../gl/program';
import { GL_STATE } from '../../gl/state';
import type { GlState } from '../../gl/state';
import { activeClipPlanes, capDraws, clipVariant, culls, packClipPlanes } from './mesh';
import { collectPickItems } from './pass';
import type { DrawInput, Pass, PassContext } from './pass';
import type { SliceQuad } from './slice';
import { MESH_PICK_VS, PICK_FS, SLICE_PICK_FS, SLICE_PICK_VS } from '../../shaders';
import { invert4, transformPoint } from '../../view/m4';
import { sliceBasis } from '../../view/geometry';
import type { mat4, vec3, View, ViewId } from '../../scene/types';
import type { ViewportRect } from '../../view/layout';
import type { PickResult } from '../../api';

/** 7 bits of layer index (127 layers), 1 bit of kind, 24 bits of element number. */
export function packId(layerIndex: number, kindBit: 0 | 1, elementId: number): number {
  return (((layerIndex + 1) << 25) | (kindBit << 24) | (elementId & 0x00ffffff)) >>> 0;
}

export function unpackId(
  id: number
): { layerIndex: number; kindBit: 0 | 1; elementId: number } | null {
  if (id === 0) return null;
  return {
    layerIndex: ((id >>> 25) & 0x7f) - 1,
    kindBit: ((id >>> 24) & 1) as 0 | 1,
    elementId: id & 0x00ffffff,
  };
}

/** §7.2.3: a 9×9 scissored read, resolved by nearest non-zero within a small radius. */
const PICK_RECT = 9;

/** One pane plus the pointer, in device pixels within the pane, origin bottom-left. */
export interface PickContext extends Omit<PassContext, 'eye'> {
  px: number;
  py: number;
  /** The shared slice quad and the half-extent to write it at — the same one the frame drew. */
  quad: SliceQuad;
  quadHalf: number;
}

export class PickPass implements Pass {
  readonly name = 'pick' as const;

  readonly #gl: WebGL2RenderingContext;
  readonly #state: GlState;
  /**
   * §7.1's variant cache, because §7.2.3 makes this pass reproduce the main pass's clip: the same
   * `TVX_CLIP_PLANES` / `TVX_CLIP_DISCARD` keys, plus `TVX_CAP` for a cut cap. The all-zero variant
   * is Phase 1's program, character for character.
   */
  readonly #mesh: ProgramVariants;
  readonly #slice: Program;
  #fbo: Framebuffer | null = null;
  #readFormat: GLenum;
  #readType: GLenum;

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.#gl = gl;
    this.#state = state;
    this.#mesh = new ProgramVariants(gl, MESH_PICK_VS, PICK_FS);
    this.#slice = new Program(gl, SLICE_PICK_VS, SLICE_PICK_FS);
    // §7.2.3: "read the enum, do not hardcode". The implementation-defined pair is
    // RED_INTEGER/UNSIGNED_INT on ANGLE/Metal *and* SwiftShader, but the spec-guaranteed fallback is
    // RGBA_INTEGER/UNSIGNED_INT, which also works on an R32UI target.
    this.#readFormat = gl.RED_INTEGER;
    this.#readType = gl.UNSIGNED_INT;
  }

  #ensure(width: number, height: number): Framebuffer {
    if (this.#fbo !== null && this.#fbo.width === width && this.#fbo.height === height)
      return this.#fbo;
    this.#fbo?.dispose();
    const gl = this.#gl;
    this.#fbo = new Framebuffer(gl, {
      width,
      height,
      // Integer formats support zero sample counts (§7.0.4), so `samples: 0` is mandatory here.
      colorFormats: [gl.R32UI, gl.R32UI],
      depth: true,
      samples: 0,
    });
    this.#fbo.bind();
    const probeFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
    const probeType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
    if (probeFormat === gl.RED_INTEGER || probeFormat === gl.RGBA_INTEGER) {
      this.#readFormat = probeFormat;
      this.#readType = probeType;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.#fbo;
  }

  /** Render the pick pass for one view and resolve the hit under the pointer. */
  run(ctx: PickContext): PickResult | null {
    const { view, rect, viewProj, input, px, py, quad, quadHalf } = ctx;
    const gl = this.#gl;
    const fbo = this.#ensure(rect.width, rect.height);
    fbo.bind();
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, rect.width, rect.height);

    // The read window: a PICK_RECT box around the pointer, clamped to the pane.
    const half = (PICK_RECT - 1) / 2;
    const x0 = Math.max(0, Math.min(rect.width - PICK_RECT, Math.round(px) - half));
    const y0 = Math.max(0, Math.min(rect.height - PICK_RECT, Math.round(py) - half));

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, PICK_RECT, PICK_RECT);
    // Before the clears, not after: `clearBufferfi(DEPTH_STENCIL, …)` is masked by `depthMask`, so
    // the depth clear below only happens because this block turns depth writes on.
    this.#state.apply(GL_STATE.pick);
    // 0 means miss.
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferuiv(gl.COLOR, 1, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);

    for (const { item, layerIndex } of collectPickItems(input, view)) {
      if (item.kind === 'mesh') {
        this.#drawMesh(item, layerIndex, viewProj, input);
        this.#drawMeshCaps(item, layerIndex, viewProj, input);
      } else this.#drawSliceQuad(item, layerIndex, view, viewProj, input, quad, quadHalf);
    }
    // The enable set is global and survives this FBO: leaving it on would clip the next frame's
    // slice quad, which draws in pass 1 before any mesh pass runs (§7.4, "reset per pass").
    this.#state.clipDistances(0);

    const ids = new Uint32Array(
      PICK_RECT * PICK_RECT * (this.#readFormat === gl.RGBA_INTEGER ? 4 : 1)
    );
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x0, y0, PICK_RECT, PICK_RECT, this.#readFormat, this.#readType, ids);
    const depths = new Uint32Array(ids.length);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(x0, y0, PICK_RECT, PICK_RECT, this.#readFormat, this.#readType, depths);

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const stride = this.#readFormat === gl.RGBA_INTEGER ? 4 : 1;
    const cx = Math.round(px) - x0;
    const cy = Math.round(py) - y0;
    let best: { id: number; depth: number; dist: number } | null = null;
    for (let j = 0; j < PICK_RECT; j += 1) {
      for (let i = 0; i < PICK_RECT; i += 1) {
        const at = (j * PICK_RECT + i) * stride;
        const id = ids[at] ?? 0;
        if (id === 0) continue;
        const dist = Math.hypot(i - cx, j - cy);
        // "Resolve by taking the nearest non-zero id within a 3–5 px radius."
        if (dist > 5) continue;
        const depth = depths[at] ?? 0;
        if (best === null || dist < best.dist) best = { id, depth, dist };
      }
    }
    if (best === null) return null;
    const un = unpackId(best.id);
    if (un === null) return null;
    const layer = input.scene.layers[un.layerIndex];
    if (layer === undefined) return null;

    // Unproject: `world = inverse(viewProj) · (2(px+0.5)/w − 1, 2(py+0.5)/h − 1, 2z − 1, 1)`.
    const z = new Float32Array(new Uint32Array([best.depth]).buffer)[0] ?? 0;
    const ndc: [number, number, number] = [
      (2 * (px + 0.5)) / rect.width - 1,
      (2 * (py + 0.5)) / rect.height - 1,
      2 * z - 1,
    ];
    const world = transformPoint(invert4(viewProj), ndc);

    return {
      layerId: layer.id,
      datasetId: layer.datasetId,
      elementId: un.elementId,
      elementKind: layer.kind === 'volume' ? 'slice' : un.kindBit === 1 ? 'tet' : 'tri',
      world,
      depth: z,
    };
  }

  /**
   * De-indexed mesh geometry. The element id is a `texelFetch` at `gl_VertexID / 3` against the
   * per-triangle `ownerElm` table — WebGL2 has no `gl_PrimitiveID` (verified compile error
   * `[M2Max]`), and a per-vertex id attribute would be a UI-thread vertex-buffer expansion, which
   * §5 rule 7 forbids.
   */
  #drawMesh(
    item: Extract<ReturnType<typeof collectPickItems>[number]['item'], { kind: 'mesh' }>,
    layerIndex: number,
    viewProj: mat4,
    input: DrawInput
  ): void {
    const gl = this.#gl;
    const { layer, ds, geom } = item;
    if (geom.ownerTexture === null) return;
    const clip = clipVariant(layer, input);
    const planes = activeClipPlanes(layer);
    const hardware = input.clipDistance === true && input.forceDiscardClip !== true;
    const prog = this.#mesh.get({ ...clip, TVX_CAP: 0 } as unknown as ShaderDefines);
    prog.use();
    prog.mat4('uViewProj', viewProj);
    prog.mat4('uModel', ds.transform);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, geom.ownerTexture);
    prog.int('uOwnerTex', 0);
    prog.int('uOwnerWidth', geom.ownerWidth);
    // §7.2.3: "the up-to-6 clip planes (same enable set)". Nothing about the pick target changes
    // that — a clipped-away triangle must not answer a double-click.
    if (planes.length > 0) {
      prog.vec4('uClipPlanes', packClipPlanes(planes));
      if (!hardware) prog.int('uClipSkip', -1);
    }
    this.#state.clipDistances(hardware ? planes.length : 0);
    // …and "face culling", which the main pass applies per layer.
    this.#state.cull(culls(layer, ds) ? 'back' : 'none');
    const bits = packId(layerIndex, 0, 0);
    const loc = prog.loc('uLayerBits');
    if (loc !== null) gl.uniform1ui(loc, bits >>> 0);
    geom.vao.bind();
    for (const range of geom.perTag) {
      const style = layer.tagStyle[range.tag];
      if (style !== undefined && !style.visible) continue;
      gl.drawArrays(gl.TRIANGLES, range.first, range.count);
    }
    VertexArray.unbind(gl);
  }

  /**
   * A cut cap, with §7.2.3's `kindBit` 1 — "0 for a triangle and 1 for a tet (cut caps)".
   *
   * The cap rule applies here too: plane *i*'s own cap is drawn with `CLIP_DISTANCE(i)` off (or
   * `uClipSkip = i`), or the pick target would have a hole exactly where the visible cap is and a
   * double-click on a cross-section would fall through to whatever is behind it.
   */
  #drawMeshCaps(
    item: Extract<ReturnType<typeof collectPickItems>[number]['item'], { kind: 'mesh' }>,
    layerIndex: number,
    viewProj: mat4,
    input: DrawInput
  ): void {
    if (item.caps === undefined) return;
    const gl = this.#gl;
    const clip = clipVariant(item.layer, input);
    const planes = activeClipPlanes(item.layer);
    const hardware = input.clipDistance === true && input.forceDiscardClip !== true;
    const prog = this.#mesh.get({ ...clip, TVX_CAP: 1 } as unknown as ShaderDefines);
    prog.use();
    prog.mat4('uViewProj', viewProj);
    prog.mat4('uModel', item.ds.transform);
    const bits = packId(layerIndex, 1, 0);
    const loc = prog.loc('uLayerBits');
    if (loc !== null) gl.uniform1ui(loc, bits >>> 0);
    this.#state.cull('none');
    item.caps.vao.bind();
    for (const c of capDraws({ ...item, kind: 'mesh', geom: item.geom }, [0, 0, 0])) {
      if (planes.length > 0) {
        prog.vec4('uClipPlanes', packClipPlanes(planes));
        if (!hardware) prog.int('uClipSkip', c.plane);
      }
      this.#state.clipDistances(hardware ? planes.length : 0, hardware ? c.plane : undefined);
      gl.drawArrays(gl.TRIANGLES, c.first, c.count);
    }
    VertexArray.unbind(gl);
  }

  /**
   * §7.2.3: "Volume slice quads participate (`elementKind: 'slice'`, `elementId` = plane index,
   * `kindBit` 0) — double-clicking a slice plane in the 3D view is the primary Freeview gesture."
   */
  #drawSliceQuad(
    item: Extract<ReturnType<typeof collectPickItems>[number]['item'], { kind: 'volume' }>,
    layerIndex: number,
    view: View,
    viewProj: mat4,
    input: DrawInput,
    quad: SliceQuad,
    quadHalf: number
  ): void {
    const gl = this.#gl;
    const { ds } = item;
    const basis = sliceBasis(view as never, input.scene.radiological);
    quad.write(input.scene.cursor, basis.right, basis.up, quadHalf);
    const prog = this.#slice;
    prog.use();
    prog.mat4('uViewProj', viewProj);
    prog.mat4('uInvAffine', ds.inverseAffine);
    prog.vec3('uDims', ds.dims as vec3);
    const planeIndex = input.scene.slices.findIndex((s) => s.id === (view as { id: ViewId }).id);
    const loc = prog.loc('uId');
    if (loc !== null) gl.uniform1ui(loc, packId(layerIndex, 0, Math.max(0, planeIndex)) >>> 0);
    quad.vao.bind();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    VertexArray.unbind(gl);
  }

  dispose(): void {
    this.#mesh.dispose();
    this.#slice.dispose();
    this.#fbo?.dispose();
    this.#fbo = null;
  }
}

/** Unused by the pick pass itself; kept so `ViewportRect` stays a named import for the context. */
export type { ViewportRect };
