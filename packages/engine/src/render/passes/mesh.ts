/**
 * §7.2's mesh passes — pass 1 (opaque) and pass 2 (transparent, two phases).
 *
 * The unit of work is a **sub-draw**: one tag range of one layer's surface (`SurfacePayload.perTag`)
 * with its own colour, its own opacity and its own world AABB. §7.2 says so in one line — "per-tag
 * sub-draws mean per-tag opacity sorts naturally" — and everything below follows from taking it
 * literally.
 *
 * The two-phase split, verbatim from §7.2:
 *
 * * **2a — back faces:** `cullFace(FRONT)`, depth test on, depth write off; objects sorted
 *   back-to-front by the depth of their **far** extent.
 * * **2b — front faces:** `cullFace(BACK)`, depth test on, depth write off; objects sorted
 *   back-to-front by the depth of their **near** extent.
 *
 * Unified rule: *in each phase, objects are sorted back-to-front by the depth of the sheet that phase
 * draws.* Exact for nested, individually near-convex shells (scalp, skull, CSF, blood — median 2
 * crossings `[M2Max]`); a partial improvement for GM/WM (median 4–6, p90 8–10).
 *
 * **`faceMode:'both'`, and the one place this file reads §7.2 rather than quoting it.** §7.2 excludes
 * those layers "from the split" and draws them "last in 2b". They *are* excluded from the scene-wide
 * sort and drawn after every split sub-draw — but each one is still issued as back faces **then**
 * front faces rather than as a single `CULL_FACE`-disabled draw. Every triangle is front- or
 * back-facing, so the two orderings rasterise **exactly the same fragments**; only the order differs,
 * and the two-draw order is the one §7.2's own unified rule implies. This is not a nicety:
 * `orient_surface` marks all ten of ernie's tissue tags open (§7.4's reference expectation), so §7.4
 * forces `faceMode:'both'` on every tissue layer, and a `cull none` draw would blend a shell's near
 * and far sheets in triangle-buffer order — the artefact §11's *Transparency (i)* names.
 *
 * Sorting needs a **per-tag** extent, not a per-layer one: every tag of a nested tissue complex
 * shares the dataset bbox to within its own thickness. `render/gpu.ts` measures a per-tag AABB once
 * at upload for that reason, and this file turns it into the near/far distances each phase sorts on.
 */

import { ProgramVariants } from '../../gl/program';
import type { Program, ShaderDefines } from '../../gl/program';
import { GL_STATE } from '../../gl/state';
import type { GlState } from '../../gl/state';
import { VertexArray } from '../../gl/buffer';
import { collectDrawItems } from './pass';
import type { FramePass, PassContext } from './pass';
import { MESH_COLOR_SOURCE, MESH_FS, MESH_THRESHOLD, MESH_VS } from '../../shaders';
import type { MeshDrawItem, MeshDrawStyle } from '../../layers/runtime';
import type { GpuStore, SurfaceGeometry } from '../gpu';
import { isSliceView } from '../../scene/store';
import type { Aabb, mat4, MeshDataset, MeshLayer, vec3, vec4 } from '../../scene/types';

/** Texture units, fixed so a variant switch never has to re-bind. */
const UNIT = { lut: 0, field: 1, owner: 2, palette: 3, edgeMask: 4 } as const;

/** The largest finite f32, for a threshold bound the scene left at ±Infinity. */
const F32_MAX = 3.4e38;

/** One tag range of one layer: the thing §7.2 sorts and blends. */
export interface SubDraw {
  item: MeshDrawItem;
  tag: number;
  first: number;
  count: number;
  color: vec4;
  /** `tagStyle[tag].opacity * layer.opacity`. */
  alpha: number;
  bounds: Aabb;
  /** R5: this tag is selected, so it is drawn with edge emphasis. */
  emphasised: boolean;
}

/** The compile-time key of one sub-draw's program (`shaders/mesh.ts`'s defines). */
export interface MeshVariant {
  TVX_COLOR_SOURCE: 0 | 1 | 2 | 3;
  TVX_EDGES: 0 | 1;
  TVX_EDGE_MASK: 0 | 1;
  TVX_FLAT_SHADING: 0 | 1;
  TVX_THRESHOLD: 0 | 1 | 2;
  TVX_EMPHASIS: 0 | 1;
}

/** Distance from `eye` to the farthest corner of `b` — the depth phase 2a sorts on. */
export function farExtent(b: Aabb, eye: vec3): number {
  let worst = 0;
  for (let c = 0; c < 8; c += 1) {
    const x = ((c & 1) === 0 ? b.min[0] : b.max[0]) - eye[0];
    const y = ((c & 2) === 0 ? b.min[1] : b.max[1]) - eye[1];
    const z = ((c & 4) === 0 ? b.min[2] : b.max[2]) - eye[2];
    const d = x * x + y * y + z * z;
    if (d > worst) worst = d;
  }
  return Math.sqrt(worst);
}

/** Distance from `eye` to the nearest point of `b` (0 inside it) — the depth phase 2b sorts on. */
export function nearExtent(b: Aabb, eye: vec3): number {
  let sum = 0;
  for (let c = 0; c < 3; c += 1) {
    const lo = b.min[c] ?? 0;
    const hi = b.max[c] ?? 0;
    const e = eye[c] ?? 0;
    const d = e < lo ? lo - e : e > hi ? e - hi : 0;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * §7.4's `faceMode`: `'both'` is **forced** when the surface has open components, which every tagged
 * tissue complex has — an interface triangle's winding is arbitrary.
 */
export function culls(layer: MeshLayer, ds: MeshDataset): boolean {
  return layer.faceMode === 'cull' && ds.orient.openComponents === 0;
}

/**
 * The colour of one tag: the layer's per-tag override, then the dataset's own tag colour (from
 * `$PhysicalNames` / `.msh.opt` / the §7.6 default palette), then the layer's solid colour.
 *
 * §4.1 requires the dataset's 0..255 wire value to round-trip **exactly** through the engine's 0..1
 * representation, which §11's "the cap pixel is the tag colour" test pins.
 */
export function tagColor(layer: MeshLayer, ds: MeshDataset, tag: number): vec4 {
  if (layer.colorMode === 'solid') return layer.solidColor;
  const style = layer.tagStyle[tag];
  if (style?.color !== undefined) return style.color;
  const t = ds.tags.find((x) => x.id === tag);
  return t?.color ?? layer.solidColor;
}

/**
 * §4.2's threshold, reduced to the shader's `TVX_THRESHOLD`.
 *
 * `mode:'clamp'` needs no shader branch — the CPU bake already clamps the ends of the colormap — and
 * a threshold that hides nothing compiles away entirely, which keeps the default variant identical
 * to Phase 1's.
 */
export function thresholdVariant(layer: MeshLayer, colorSource: number): 0 | 1 | 2 {
  if (colorSource !== MESH_COLOR_SOURCE.nodeField && colorSource !== MESH_COLOR_SOURCE.elmField) {
    return MESH_THRESHOLD.none;
  }
  const t = layer.threshold;
  if (t.mode !== 'hide') return MESH_THRESHOLD.none;
  if (!Number.isFinite(t.lo) && !Number.isFinite(t.hi)) return MESH_THRESHOLD.none;
  return t.symmetric ? MESH_THRESHOLD.hideSymmetric : MESH_THRESHOLD.hide;
}

/**
 * The colour source a sub-draw can actually use, given what has landed on the GPU.
 *
 * §7.4 calls the de-indexed variant, the element field and `colorMode:'label'` "async loads with a
 * progress state, not instant checkboxes". Until one lands, the geometry or the table is simply
 * absent, and the honest thing to draw is the tag colour — never a half-applied field.
 */
export function effectiveColorSource(
  style: MeshDrawStyle | undefined,
  geom: SurfaceGeometry
): 0 | 1 | 2 | 3 {
  if (style === undefined) return MESH_COLOR_SOURCE.uniform;
  switch (style.colorSource) {
    case MESH_COLOR_SOURCE.nodeField:
      return style.fieldTable !== undefined && geom.hasNodeIndex
        ? MESH_COLOR_SOURCE.nodeField
        : MESH_COLOR_SOURCE.uniform;
    case MESH_COLOR_SOURCE.elmField:
      return style.fieldTable !== undefined && geom.ownerTexture !== null
        ? MESH_COLOR_SOURCE.elmField
        : MESH_COLOR_SOURCE.uniform;
    case MESH_COLOR_SOURCE.label:
      return style.fieldTable !== undefined && style.palette !== undefined && geom.hasNodeIndex
        ? MESH_COLOR_SOURCE.label
        : MESH_COLOR_SOURCE.uniform;
    default:
      return MESH_COLOR_SOURCE.uniform;
  }
}

/** The §7.1 variant one sub-draw compiles to. */
export function variantOf(d: SubDraw): MeshVariant {
  const { layer, geom, style } = d.item;
  const colorSource = effectiveColorSource(style, geom);
  // Edges need the de-indexed variant's `corner` attribute — §7.4's masked barycentric mechanism is
  // the only one, for surfaces and caps alike, so an indexed draw simply has no edges yet.
  const wantEdges = (layer.edges.surface || d.emphasised) && geom.hasCorner;
  return {
    TVX_COLOR_SOURCE: colorSource,
    TVX_EDGES: wantEdges ? 1 : 0,
    TVX_EDGE_MASK: wantEdges && geom.edgeMaskTexture !== null ? 1 : 0,
    TVX_FLAT_SHADING: layer.flatShading ? 1 : 0,
    TVX_THRESHOLD: thresholdVariant(layer, colorSource),
    TVX_EMPHASIS: colorSource === MESH_COLOR_SOURCE.label && style?.labelEmphasis === true ? 1 : 0,
  };
}

/** Every sub-draw one layer contributes, in `perTag` order. */
export function subDraws(item: MeshDrawItem): SubDraw[] {
  const { layer, ds, geom } = item;
  const emphasis = new Set(item.style?.emphasisTags ?? []);
  const out: SubDraw[] = [];
  for (const range of geom.perTag) {
    const style = layer.tagStyle[range.tag];
    if (style !== undefined && !style.visible) continue;
    const alpha = (style?.opacity ?? 1) * layer.opacity;
    if (alpha <= 0) continue;
    out.push({
      item,
      tag: range.tag,
      first: range.first,
      count: range.count,
      color: tagColor(layer, ds, range.tag),
      alpha,
      bounds: geom.tagBounds?.get(range.tag) ?? ds.bounds,
      emphasised: emphasis.has(range.tag),
    });
  }
  return out;
}

interface FrameUniforms {
  viewProj: mat4;
  eye: vec3;
  ambient: number;
  store: GpuStore;
}

export class MeshPass implements FramePass {
  readonly name = 'mesh' as const;

  readonly #gl: WebGL2RenderingContext;
  readonly #state: GlState;
  /** §7.1's variant cache. One program per distinct set of `shaders/mesh.ts` defines. */
  readonly #programs: ProgramVariants;
  #frame: FrameUniforms | null = null;
  #bound: Program | null = null;

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.#gl = gl;
    this.#state = state;
    this.#programs = new ProgramVariants(gl, MESH_VS, MESH_FS);
  }

  run(ctx: PassContext): void {
    const { view, eye, viewProj, input } = ctx;
    // Meshes draw in 3D panes here; §7.4's 2D `contoursIn2D` / `fillIn2D` are E-DERIVED's items. The
    // runtimes already return nothing for a 2D pane, and this guard keeps the GL state changes below
    // off the 2D path entirely.
    if (isSliceView(view)) return;
    const items = collectDrawItems(input, view).filter((d): d is MeshDrawItem => d.kind === 'mesh');
    if (items.length === 0) return;

    const state = this.#state;
    this.#frame = { viewProj, eye, ambient: input.scene.lighting.ambient, store: input.store };
    this.#bound = null;

    const all = items.flatMap((item) => subDraws(item));
    const opaque = all.filter((d) => d.alpha >= 1);
    const translucent = all.filter((d) => d.alpha < 1);

    // Pass 1 — opaque.
    state.apply(GL_STATE.opaque3d);
    for (const d of opaque) {
      state.cull(culls(d.item.layer, d.item.ds) ? 'back' : 'none');
      this.#draw(d);
    }

    // Pass 2 — transparent, two phases (§7.2). Back-to-front is descending distance, and each phase
    // uses the extent of the sheet it draws.
    if (translucent.length > 0) {
      const split = translucent.filter((d) => culls(d.item.layer, d.item.ds));
      const both = translucent.filter((d) => !culls(d.item.layer, d.item.ds));
      const byFar = (xs: SubDraw[]): SubDraw[] =>
        [...xs].sort((a, b) => farExtent(b.bounds, eye) - farExtent(a.bounds, eye));
      const byNear = (xs: SubDraw[]): SubDraw[] =>
        [...xs].sort((a, b) => nearExtent(b.bounds, eye) - nearExtent(a.bounds, eye));

      state.apply(GL_STATE.transparentBack); // 2a — back faces
      for (const d of byFar(split)) this.#draw(d);
      state.apply(GL_STATE.transparentFront); // 2b — front faces
      for (const d of byNear(split)) this.#draw(d);

      // Excluded from the scene-wide split and drawn last in 2b (§7.2) — but still back sheet before
      // front sheet, which rasterises the same fragments as a `CULL_FACE`-disabled draw in the order
      // §7.2's own rule implies. See this file's header.
      if (both.length > 0) {
        state.apply(GL_STATE.transparentBack);
        for (const d of byFar(both)) this.#draw(d);
        state.apply(GL_STATE.transparentFront);
        for (const d of byNear(both)) this.#draw(d);
      }
    }
    // Depth writes back on before the pass returns: `render/renderer.ts` clears the next pane's depth
    // buffer, and `gl.clear(DEPTH_BUFFER_BIT)` is masked by `depthMask`.
    state.apply(GL_STATE.opaque3d);
    this.#frame = null;
    this.#bound = null;
  }

  /**
   * One sub-draw: one tag range, with the tag colour as a **uniform** on §7.4's indexed variant.
   *
   * `tagStyle[tag].visible` is a skipped sub-draw, which is free; there is deliberately no per-vertex
   * `tag` attribute, because 1,048,599 of ernie's 1,177,213 interface faces are shared between two
   * tissue tags `[DATA]` and a per-vertex tag is ill-defined on a shared node.
   */
  #draw(d: SubDraw): void {
    const gl = this.#gl;
    const frame = this.#frame;
    if (frame === null) return;
    const { layer, ds, geom, style } = d.item;
    const variant = variantOf(d);
    const prog = this.#programs.get(variant as unknown as ShaderDefines);

    if (prog !== this.#bound) {
      prog.use();
      prog.mat4('uViewProj', frame.viewProj);
      prog.vec3('uEye', frame.eye);
      prog.float('uAmbient', frame.ambient);
      this.#bound = prog;
    }

    const source = variant.TVX_COLOR_SOURCE;
    if (source === MESH_COLOR_SOURCE.nodeField || source === MESH_COLOR_SOURCE.elmField) {
      // §7.6's baked LUT: `kind:'heat'` "costs nothing extra in the shader — it is a different bake".
      const lut = frame.store.lut(layer.scale, layer.colormap, layer.colormapNegative);
      gl.activeTexture(gl.TEXTURE0 + UNIT.lut);
      gl.bindTexture(gl.TEXTURE_2D, lut.texture);
      prog.int('uLut', UNIT.lut);
      prog.float('uLutLo', lut.lo);
      prog.float('uLutHi', lut.hi === lut.lo ? lut.lo + 1 : lut.hi);
      const table = style?.fieldTable;
      if (table !== undefined) {
        gl.activeTexture(gl.TEXTURE0 + UNIT.field);
        gl.bindTexture(gl.TEXTURE_2D, table.texture);
        prog.int('uFieldTex', UNIT.field);
        prog.int('uFieldWidth', table.width);
      }
      if (source === MESH_COLOR_SOURCE.elmField && geom.ownerTexture !== null) {
        gl.activeTexture(gl.TEXTURE0 + UNIT.owner);
        gl.bindTexture(gl.TEXTURE_2D, geom.ownerTexture);
        prog.int('uOwnerTex', UNIT.owner);
        prog.int('uOwnerWidth', geom.ownerWidth);
      }
      if (variant.TVX_THRESHOLD !== MESH_THRESHOLD.none) {
        const t = layer.threshold;
        const lo = Number.isFinite(t.lo) ? t.lo : -F32_MAX;
        const hi = Number.isFinite(t.hi) ? t.hi : F32_MAX;
        const span = Math.abs(hi - lo);
        prog.float('uThreshLo', lo);
        prog.float('uThreshHi', hi);
        // §4.2: the ramp width is `softEdge` as a fraction of `hi - lo`. Floored just above zero, so
        // the shader's `smoothstep` never sees two equal edges — which GLSL leaves undefined.
        prog.float('uThreshSoft', Math.max(t.softEdge * span, span * 1e-6, 1e-30));
      }
    } else if (source === MESH_COLOR_SOURCE.label) {
      const table = style?.fieldTable;
      const palette = style?.palette;
      if (table !== undefined) {
        gl.activeTexture(gl.TEXTURE0 + UNIT.field);
        gl.bindTexture(gl.TEXTURE_2D, table.texture);
        prog.int('uFieldTex', UNIT.field);
        prog.int('uFieldWidth', table.width);
      }
      if (palette !== undefined) {
        gl.activeTexture(gl.TEXTURE0 + UNIT.palette);
        gl.bindTexture(gl.TEXTURE_2D, palette.texture);
        prog.int('uPalette', UNIT.palette);
        prog.int('uPaletteSize', palette.size);
      }
    }

    if (variant.TVX_EDGES === 1 || variant.TVX_EMPHASIS === 1) {
      prog.vec4('uEdgeColor', layer.edgeColor);
      prog.float('uEdgeWidthPx', Math.max(0.5, layer.edgeWidthPx));
    }
    if (variant.TVX_EDGE_MASK === 1 && geom.edgeMaskTexture !== null) {
      gl.activeTexture(gl.TEXTURE0 + UNIT.edgeMask);
      gl.bindTexture(gl.TEXTURE_2D, geom.edgeMaskTexture);
      prog.int('uEdgeMaskTex', UNIT.edgeMask);
      prog.int('uEdgeMaskWidth', geom.edgeMaskWidth);
    }

    prog.mat4('uModel', ds.transform);
    prog.vec4('uColor', d.color);
    prog.float('uOpacity', d.alpha);
    geom.vao.bind();
    if (geom.indexed) {
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, d.first * 4);
    } else {
      gl.drawArrays(gl.TRIANGLES, d.first, d.count);
    }
    VertexArray.unbind(gl);
  }

  dispose(): void {
    this.#programs.dispose();
  }
}
