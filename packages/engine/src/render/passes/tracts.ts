/**
 * §7.4.1's draws. Opaque tracts run before `MeshPass` with depth writes on, so any mesh composites
 * correctly around them; `opacity < 1` runs after the derived pass, depth-tested with writes off; in a
 * 2D pane the layer takes its place in §7.3's order and a fragment outside the slab is discarded.
 */

import { GL_STATE, type GlState } from '../../gl/state';
import { ProgramVariants, type Program, type ShaderDefines } from '../../gl/program';
import { VertexArray } from '../../gl/buffer';
import type { TractsDrawItem } from '../../layers/runtime';
import { isSliceView } from '../../scene/store';
import type { Scale, Threshold, TractsLayer } from '../../scene/types';
import { TRACT_MODE, TRACTS_FS, TRACTS_VS } from '../../shaders/tracts';
import { slicePlane } from '../../view/geometry';
import { thresholdUniforms } from './mesh';
import type { DrawInput, Pass, PassContext } from './pass';

const UNIT = { lut: 0, style: 1 } as const;
const UNBOUNDED = 3.4e38;

/** 0 off, 1 hide, 2 hide on |v|. Clamp and two open bounds gate nothing. */
export function tractThresholdMode(t: Threshold): 0 | 1 | 2 {
  if (t.mode !== 'hide') return 0;
  if (!Number.isFinite(t.lo) && !Number.isFinite(t.hi)) return 0;
  return t.symmetric ? 2 : 1;
}

/** The program a draw needs (`shaders/tracts.ts`). */
export function tractDefines(item: TractsDrawItem, pick: 0 | 1, slab: 0 | 1): ShaderDefines {
  const scalar = usesScalar(item.layer) && item.gpu.hasScalar;
  return {
    TRACT_QUADS: item.layer.lineWidthPx > 1 ? 1 : 0,
    TRACT_PICK: pick,
    TRACT_SLAB: slab,
    TRACT_SCALAR: scalar ? 1 : 0,
    // A heat scale's LUT can carry alpha 0 and a `truncate` clip, so it gates like a threshold does.
    TRACT_GATE:
      scalar && (tractThresholdMode(item.layer.threshold) !== 0 || item.layer.scale.kind === 'heat')
        ? 1
        : 0,
  };
}

export function usesScalar(layer: TractsLayer): boolean {
  return (
    (layer.colorMode === 'vertex' || layer.colorMode === 'streamline') && layer.field !== undefined
  );
}

/** Everything a tract draw and its pick share, so the two cannot disagree (§7.2.3). */
export function bindTractUniforms(
  gl: WebGL2RenderingContext,
  prog: Program,
  item: TractsDrawItem,
  input: DrawInput,
  viewProj: Float32Array
): void {
  const { layer, gpu } = item;
  const g = gpu.geometry;
  prog.mat4('uViewProj', viewProj);
  prog.vec3('uOrigin', g.origin);
  prog.float('uQuantum', g.quantum);
  const waiting = usesScalar(layer) && !gpu.hasScalar;
  const mode =
    layer.colorMode === 'direction'
      ? TRACT_MODE.direction
      : layer.colorMode === 'group'
        ? TRACT_MODE.group
        : TRACT_MODE.solid;
  prog.int('uMode', mode);
  const solid = waiting ? [0.5, 0.5, 0.5, 1] : layer.solidColor;
  prog.vec4('uSolid', new Float32Array(solid));
  prog.float('uSolidAlpha', layer.colorMode === 'solid' ? (layer.solidColor[3] ?? 1) : 1);
  prog.float('uScalarLo', gpu.scalarLo);
  prog.float('uScalarHi', gpu.scalarHi);
  prog.float('uOpacity', layer.opacity);
  prog.int('uStyleWidth', gpu.styleWidth);
  gl.activeTexture(gl.TEXTURE0 + UNIT.style);
  gl.bindTexture(gl.TEXTURE_2D, gpu.style);
  prog.int('uStyle', UNIT.style);

  const lut = input.store.lut(layer.scale, layer.colormap, layer.colormapNegative);
  gl.activeTexture(gl.TEXTURE0 + UNIT.lut);
  gl.bindTexture(gl.TEXTURE_2D, lut.texture);
  prog.int('uLut', UNIT.lut);
  prog.float('uLutLo', lut.lo);
  prog.float('uLutHi', lut.hi === lut.lo ? lut.lo + 1 : lut.hi);
  prog.float('uClipMax', Number.isFinite(lut.clipMax) ? lut.clipMax : UNBOUNDED);
  const t = thresholdUniforms(layer.threshold, layer.scale as Scale);
  prog.int('uThreshMode', tractThresholdMode(layer.threshold));
  prog.float('uThreshLo', t.lo);
  prog.float('uThreshHi', t.hi);
  prog.float('uThreshSoft', t.soft);
}

export function drawTractGeometry(
  gl: WebGL2RenderingContext,
  prog: Program,
  item: TractsDrawItem,
  rect: { width: number; height: number },
  uiScale: number
): void {
  const { layer, gpu } = item;
  if (layer.lineWidthPx > 1) {
    prog.vec2('uViewportPx', [rect.width, rect.height]);
    prog.float('uWidthPx', layer.lineWidthPx * uiScale);
    gpu.quads.bind();
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.max(0, gpu.geometry.nPoints - 1));
  } else {
    gpu.lines.bind();
    gl.drawElements(gl.LINE_STRIP, gpu.geometry.indexCount, gl.UNSIGNED_INT, 0);
  }
  VertexArray.unbind(gl);
}

export class TractsPass implements Pass {
  readonly name = 'tracts' as const;
  readonly #gl: WebGL2RenderingContext;
  readonly #state: GlState;
  readonly #programs: ProgramVariants;

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.#gl = gl;
    this.#state = state;
    this.#programs = new ProgramVariants(gl, TRACTS_VS, TRACTS_FS);
  }

  #draw(
    ctx: PassContext,
    item: TractsDrawItem,
    plane: [number, number, number, number],
    slab: number
  ): void {
    const gl = this.#gl;
    const prog = this.#programs.get(tractDefines(item, 0, slab >= 0 ? 1 : 0));
    prog.use();
    bindTractUniforms(gl, prog, item, ctx.input, ctx.viewProj);
    if (slab >= 0) {
      prog.vec4('uPlane', new Float32Array(plane));
      prog.float('uSlab', slab);
    }
    drawTractGeometry(gl, prog, item, ctx.rect, ctx.input.uiScale);
  }

  #items(ctx: PassContext): TractsDrawItem[] {
    const out: TractsDrawItem[] = [];
    for (const layer of ctx.input.scene.layers) {
      if (layer.kind !== 'tracts') continue;
      for (const d of ctx.input.runtimes.get(layer.id)?.drawItems(ctx.view) ?? []) {
        if (d.kind === 'tracts') out.push(d);
      }
    }
    return out;
  }

  /** The 3D pane's opaque draws, before the meshes. */
  runOpaque(ctx: PassContext): void {
    if (isSliceView(ctx.view)) return;
    const items = this.#items(ctx).filter((d) => d.layer.opacity >= 1);
    if (items.length === 0) return;
    this.#state.apply(GL_STATE.opaque3d);
    for (const d of items) this.#draw(ctx, d, [0, 0, 0, 0], -1);
  }

  /** The 3D pane's translucent draws, after the derived pass. */
  runTranslucent(ctx: PassContext): void {
    if (isSliceView(ctx.view)) return;
    const items = this.#items(ctx).filter((d) => d.layer.opacity < 1);
    if (items.length === 0) return;
    this.#state.apply(GL_STATE.transparentFront);
    this.#state.cull('none');
    for (const d of items) this.#draw(ctx, d, [0, 0, 0, 0], -1);
    this.#state.apply(GL_STATE.opaque3d);
  }

  /** One layer in a 2D pane, at its place in §7.3's order. */
  draw2D(ctx: PassContext, layerId: string): void {
    const view = ctx.view;
    if (!isSliceView(view)) return;
    const items = ctx.input.runtimes.get(layerId)?.drawItems(view) ?? [];
    for (const d of items) {
      if (d.kind !== 'tracts' || d.layer.slabMm <= 0) continue;
      this.#state.apply(GL_STATE.blend2d);
      const p = slicePlane(view, ctx.input.scene.cursor);
      this.#draw(ctx, d, [p.normal[0], p.normal[1], p.normal[2], p.offset], d.layer.slabMm);
    }
  }

  dispose(): void {
    this.#programs.dispose();
  }
}
