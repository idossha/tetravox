/**
 * The §7.2.3 pick pass.
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
 */

import { Framebuffer } from '../gl/framebuffer';
import { VertexArray } from '../gl/buffer';
import type { Program } from '../gl/program';
import type { GpuStore } from './gpu';
import { surfaceKey, volumeKey } from './renderer';
import type { ViewportRect } from '../view/layout';
import type { mat4, Scene, vec3, View, ViewId } from '../scene/types';
import type { PickResult } from '../api';
import { invert4, transformPoint } from '../view/m4';
import { sliceBasis } from '../view/geometry';

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

export class PickPass {
  readonly #gl: WebGL2RenderingContext;
  #fbo: Framebuffer | null = null;
  #readFormat: GLenum;
  #readType: GLenum;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
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

  /**
   * Render the pick pass for one view and resolve the hit under `(px, py)`.
   *
   * `px, py` are **device pixels within the pane**, origin bottom-left, matching `gl.scissor`.
   */
  pick(
    view: View,
    rect: ViewportRect,
    viewProj: mat4,
    scene: Scene,
    store: GpuStore,
    programs: { mesh: Program; slice: Program },
    quad: { vao: VertexArray; write: (c: vec3, r: vec3, u: vec3, h: number) => void },
    quadHalf: number,
    px: number,
    py: number
  ): PickResult | null {
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
    // 0 means miss.
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferuiv(gl.COLOR, 1, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    const isSliceView = (view as { mode?: string }).mode !== undefined;

    scene.layers.forEach((layer, layerIndex) => {
      // §7.2.3: only layers with `visible && pickable && opacity >= pickOpacityMin` (default 0.25).
      if (!layer.visible || !layer.pickable || layer.opacity < 0.25) return;
      if (layer.kind === 'mesh' && !isSliceView) {
        const geom = store.surface(surfaceKey(layer.datasetId, 'deindexed'));
        const ds = scene.datasets.get(layer.datasetId);
        if (
          geom === undefined ||
          geom.ownerTexture === null ||
          ds === undefined ||
          ds.kind !== 'mesh'
        )
          return;
        const prog = programs.mesh;
        prog.use();
        prog.mat4('uViewProj', viewProj);
        prog.mat4('uModel', ds.transform);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, geom.ownerTexture);
        prog.int('uOwnerTex', 0);
        prog.int('uOwnerWidth', geom.ownerWidth);
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
      } else if (layer.kind === 'volume' && isSliceView) {
        // Slice quads participate: `elementKind:'slice'`, `elementId` = plane index, kindBit 0.
        const ds = scene.datasets.get(layer.datasetId);
        const gpu = store.volume(volumeKey(layer));
        if (ds === undefined || ds.kind !== 'volume' || gpu === undefined) return;
        const basis = sliceBasis(view as never, scene.radiological);
        quad.write(scene.cursor, basis.right, basis.up, quadHalf);
        const prog = programs.slice;
        prog.use();
        prog.mat4('uViewProj', viewProj);
        prog.mat4('uInvAffine', ds.inverseAffine);
        prog.vec3('uDims', ds.dims);
        const planeIndex = scene.slices.findIndex((s) => s.id === (view as { id: ViewId }).id);
        const loc = prog.loc('uId');
        if (loc !== null) gl.uniform1ui(loc, packId(layerIndex, 0, Math.max(0, planeIndex)) >>> 0);
        quad.vao.bind();
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        VertexArray.unbind(gl);
      }
    });

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
    const layer = scene.layers[un.layerIndex];
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

  dispose(): void {
    this.#fbo?.dispose();
    this.#fbo = null;
  }
}
