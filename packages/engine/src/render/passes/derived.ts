/**
 * The **derived** pass — everything that comes *out of* a mesh or a volume without being either:
 * `fillIn2D` cut polygons, `contoursIn2D` boundary lines, vector glyphs, isosurfaces and points.
 *
 * **Where it sits in §7.2's order, and why.** §7.2 puts points, isosurfaces and cut caps in pass 1
 * (opaque) and "contours on slices" in pass 3 (overlay) — so every item here belongs *before* the
 * chrome, and R4 says so in user terms: the mesh fill draws over the base volume and **under the
 * crosshair**. `render/renderer.ts` therefore calls this pass after `mesh` and before `overlay`.
 * That is additive — no existing entry in the sequence moves, and slice → mesh → overlay keep their
 * relative order — and it is the only placement §7.2 allows. See `docs/DECISIONS.md`, 2026-08-27.
 *
 * The pass enters a complete `gl/state.ts` block and inherits nothing from pass 2 (that is what
 * `gl/state.ts`'s header means by "a fifth and sixth pass get appended to the sequence and would
 * silently inherit whatever the fourth left enabled"), and it disables every clip distance: nothing
 * drawn here is clipped by the plane it depicts.
 *
 * What this file owns: the four programs, the shared template VAOs and the draw calls. What it does
 * **not** own: the geometry, which is `derived/store.ts`'s and arrives from a dataset worker, and
 * the request lifecycle, which is `derived/cut-source.ts`'s.
 */

import { VertexArray, Buffer } from '../../gl/buffer';
import { Program, ProgramVariants } from '../../gl/program';
import { GL_STATE } from '../../gl/state';
import type { GlState } from '../../gl/state';
import { collectDrawItems } from './pass';
import type { FramePass, PassContext } from './pass';
import {
  CONTOUR_FS,
  CONTOUR_VS,
  CONTOUR_STRIP_VERTICES,
  FILL2D_FS,
  FILL2D_VS,
  FILL_MODE,
  GLYPH_FS,
  GLYPH_VS,
  MESH_FS,
  MESH_VS,
  POINTS_FS,
  POINTS_VS,
  POINT_QUAD_VERTICES,
} from '../../shaders';
import { buildArrow, HEAD_LEN } from '../../derived/arrow';
import { glyphPlan } from '../../derived/glyph-plan';
import { visibleTetTags } from '../../derived/tag-lut';
import type { DerivedStore } from '../../derived/store';
import type { Table } from '../../derived/tables';
import type { IsoDrawItem, PointsDrawItem } from '../../layers/runtime';
import { visibleIn } from '../../layers/runtime';
import { isSliceView } from '../../scene/store';
import { sliceBasis, slicePlane } from '../../view/geometry';
import type { ComponentSel } from '@tetravox/protocol';
import type { MeshDataset, MeshLayer, PointsLayer, vec3, vec4 } from '../../scene/types';

/** §7.4's contour colour when the layer does not override it: the layer's own edge colour. */
const DEFAULT_CONTOUR_COLOR: vec4 = [0.05, 0.05, 0.06, 1];

export class DerivedPass implements FramePass {
  readonly name = 'derived' as const;

  readonly #gl: WebGL2RenderingContext;
  readonly #state: GlState;
  readonly #fill: ProgramVariants;
  readonly #contour: Program;
  readonly #points: ProgramVariants;
  /** `TVX_GLYPH_VOLUME` ∈ {0,1} — `GlyphSpec.origins`, a compile-time branch like every other. */
  readonly #glyph: ProgramVariants;
  readonly #iso: Program;

  /**
   * The arrow templates, keyed by `shape` and `headProportion`.
   *
   * One shared 24-triangle template was always the §7.4 design; what changed on 2026-08-28 is that
   * there is one per *shape*, because the pass built `buildArrow(true)` unconditionally and
   * `shape: 'line'` — a documented `GlyphSpec` value since §4.4 was written — drew a head anyway.
   * A template is 24 triangles of constant data and there are a handful of distinct keys in a
   * session, so caching them is still nothing like per-element geometry (AGENTS rule 7).
   */
  readonly #arrows = new Map<string, { vao: VertexArray; buffers: Buffer[]; vertices: number }>();

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.#gl = gl;
    this.#state = state;
    this.#fill = new ProgramVariants(gl, FILL2D_VS, FILL2D_FS);
    this.#contour = new Program(gl, CONTOUR_VS, CONTOUR_FS);
    this.#points = new ProgramVariants(gl, POINTS_VS, POINTS_FS);
    this.#glyph = new ProgramVariants(gl, GLYPH_VS, GLYPH_FS);
    // An isosurface is a `SurfacePayload`, so it draws through the §7.4 mesh program unchanged —
    // same attribute layout, same headlight, same two-sided lighting.
    this.#iso = new Program(gl, MESH_VS, MESH_FS);
  }

  /** The template for one `(shape, headProportion)`, built on first use and kept. */
  #arrow(withHead: boolean, headFrac: number): { vao: VertexArray; vertices: number } {
    const key = withHead ? `head:${headFrac.toFixed(3)}` : 'line';
    const have = this.#arrows.get(key);
    if (have !== undefined) return have;
    const gl = this.#gl;
    const arrow = buildArrow(withHead, headFrac);
    const vao = new VertexArray(gl);
    const ap = new Buffer(gl, gl.ARRAY_BUFFER);
    ap.set(arrow.positions);
    const an = new Buffer(gl, gl.ARRAY_BUFFER);
    an.set(arrow.normals);
    vao.attrib(0, ap, 3, gl.FLOAT);
    vao.attrib(1, an, 3, gl.FLOAT);
    VertexArray.unbind(gl);
    const entry = { vao, buffers: [ap, an], vertices: arrow.vertexCount };
    this.#arrows.set(key, entry);
    return entry;
  }

  run(ctx: PassContext): void {
    const derived = ctx.input.derived;
    if (derived === undefined) return;
    const store = derived.store;
    if (isSliceView(ctx.view)) {
      this.#run2D(ctx, store);
    } else {
      this.#run3D(ctx, store);
    }
    // Depth writes back on: `render/renderer.ts` clears the next pane's depth buffer and
    // `gl.clear(DEPTH_BUFFER_BIT)` is masked by `depthMask`.
    this.#state.apply(GL_STATE.opaque3d);
  }

  // -------------------------------------------------------------------------------------------
  // 2D panes — R4
  // -------------------------------------------------------------------------------------------

  #run2D(ctx: PassContext, store: DerivedStore): void {
    const { view, rect, viewProj, input } = ctx;
    if (!isSliceView(view)) return;
    const scene = input.scene;
    // §4.5: the plane is DERIVED from the cursor, never stored. One source of truth means an oblique
    // pane's cut is the same code path as a canonical one's.
    const p = slicePlane(view, scene.cursor);
    const plane = {
      normal: [p.normal[0], p.normal[1], p.normal[2]] as [number, number, number],
      offset: p.offset,
    };

    // §7.3: 2D panes composite in layer order with depth off; a mesh cut is one more sheet in that
    // order, above the volume slices the slice pass just drew.
    this.#state.apply(GL_STATE.blend2d);
    this.#state.clipDistances(0);

    for (const layer of scene.layers) {
      if (layer.kind !== 'mesh') continue;
      if (!visibleIn(layer, view)) continue;
      if (!layer.fillIn2D && !layer.contoursIn2D) continue;
      const ds = scene.datasets.get(layer.datasetId);
      if (ds === undefined || ds.kind !== 'mesh') continue;
      const wantField = layer.colorMode === 'field' && layer.field !== undefined;
      const geom = store.paneCut(layer, ds, view.id, plane, {
        fields: wantField && layer.field !== undefined ? [layer.field] : undefined,
        maskId: null,
        wantEdges: layer.edges.caps,
        wantBoundary: layer.contoursIn2D,
      });
      if (geom === null) continue;

      if (layer.fillIn2D && geom.triangleCount > 0) {
        this.#drawFill(ctx, store, layer, ds, geom);
      }
      if (layer.contoursIn2D && geom.contourInstances > 0) {
        this.#drawContours(
          viewProj,
          ds.transform,
          rect.width,
          rect.height,
          geom.contourVao,
          geom.contourInstances,
          layer.contourWidthPx * input.uiScale,
          contourColor(layer)
        );
      }
    }

    // Points draw on the plane they intersect, above the cut (§4.4: electrodes over anatomy).
    // A parsed view's `SL` segments go under them, like a montage's wires under its electrodes.
    for (const item of collectDrawItems(input, view)) {
      if (item.kind !== 'points') continue;
      this.#drawPointLines(ctx, item.layer, store);
      const inst = store.pointInstances(item.layer);
      if (inst !== null) this.#drawPoints2D(ctx, item, inst, plane);
    }
  }

  #drawFill(
    ctx: PassContext,
    store: DerivedStore,
    layer: MeshLayer,
    ds: MeshDataset,
    geom: NonNullable<ReturnType<DerivedStore['paneCut']>>
  ): void {
    const gl = this.#gl;
    if (geom.tagTable === null || geom.ownerTable === null) return;
    const lut = store.tagLut(layer, ds);

    let mode: number = FILL_MODE.tag;
    let fieldTable = null;
    if (layer.colorMode === 'field' && layer.field !== undefined) {
      if (layer.field.source === 'elm') {
        fieldTable = store.fieldTable(
          ds,
          'elm',
          layer.field.name,
          layer.field.component as ComponentSel
        );
        if (fieldTable !== null) mode = FILL_MODE.elmField;
      } else if (geom.values !== null) {
        mode = FILL_MODE.nodeField;
      }
    }

    const prog = this.#fill.get({ FILL_MODE: mode });
    prog.use();
    prog.mat4('uViewProj', ctx.viewProj);
    prog.mat4('uModel', ds.transform);
    prog.float('uOpacity', layer.opacity);
    prog.int('uTableW', geom.tagTable.width);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, geom.tagTable.texture);
    prog.int('uTagTex', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lut.table.texture);
    prog.int('uTagLut', 1);
    prog.int('uTagLutW', lut.table.width);
    prog.int('uTagLutN', lut.count);

    if (mode !== FILL_MODE.tag) {
      const baked = ctx.input.store.lut(layer.scale, layer.colormap, layer.colormapNegative);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, baked.texture);
      prog.int('uLut', 2);
      prog.vec2('uLutRange', [baked.lo, baked.hi]);
      if (mode === FILL_MODE.elmField && fieldTable !== null) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, geom.ownerTable.texture);
        prog.int('uOwnerTex', 3);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, fieldTable.texture);
        prog.int('uFieldTex', 4);
        prog.int('uFieldW', fieldTable.width);
      }
    }

    geom.vao.bind();
    gl.drawArrays(gl.TRIANGLES, 0, geom.vertexCount);
    VertexArray.unbind(gl);
  }

  /**
   * One instanced draw of the shared 4-vertex strip, once per segment.
   *
   * `widthPx` is in **render-target** pixels (§7.0.5), so the caller has already multiplied by the
   * DPR/SSAA factor; the shader turns it into a clip-space offset with the pane's own viewport, so
   * the drawn width is the same number of pixels at every zoom. That is the §11 obligation this
   * carries, and it is why this is not `LINES` + `lineWidth` (`ALIASED_LINE_WIDTH_RANGE` is `[1,1]`).
   */
  #drawContours(
    viewProj: Float32Array,
    model: Float32Array,
    widthPxViewport: number,
    heightPxViewport: number,
    vao: VertexArray,
    instances: number,
    widthPx: number,
    color: vec4
  ): void {
    const gl = this.#gl;
    const prog = this.#contour;
    prog.use();
    prog.mat4('uViewProj', viewProj);
    prog.mat4('uModel', model);
    prog.vec2('uViewport', [widthPxViewport, heightPxViewport]);
    prog.float('uWidthPx', Math.max(1, widthPx));
    prog.float('uCapPx', Math.max(1, widthPx) * 0.5);
    prog.vec4('uColor', color);
    vao.bind();
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, CONTOUR_STRIP_VERTICES, instances);
    VertexArray.unbind(gl);
  }

  /**
   * A points layer's `SL` segments (task 6), through the contour program.
   *
   * The same screen-space quad expansion the 2D contours use, so the segments keep a **constant
   * screen width** at every zoom — `gl.lineWidth()` is a no-op (§7.0.6). They are drawn with the
   * layer's model matrix set to identity because a parsed view's coordinates are already world mm
   * (§6.2) and a points layer has no dataset transform of its own.
   */
  #drawPointLines(ctx: PassContext, layer: PointsLayer, store: DerivedStore): void {
    const seg = store.lineSegments(layer);
    if (seg === null) return;
    const color = layer.lineColor ?? layer.color;
    this.#drawContours(
      ctx.viewProj,
      IDENTITY,
      ctx.rect.width,
      ctx.rect.height,
      seg.vao,
      seg.count,
      (layer.lineWidthPx ?? 2) * ctx.input.uiScale,
      [color[0], color[1], color[2], color[3] * layer.opacity]
    );
  }

  #drawPoints2D(
    ctx: PassContext,
    item: PointsDrawItem,
    inst: { vao: VertexArray; count: number },
    plane: { normal: [number, number, number]; offset: number }
  ): void {
    const gl = this.#gl;
    const { view, input } = ctx;
    if (!isSliceView(view)) return;
    const basis = sliceBasis(view, input.scene.radiological);
    const prog = this.#points.get({ POINTS_2D: 1 });
    prog.use();
    prog.mat4('uViewProj', ctx.viewProj);
    prog.vec3('uRight', basis.right);
    prog.vec3('uUp', basis.up);
    prog.vec3('uNormal', plane.normal);
    prog.float('uPlaneOffset', plane.offset);
    prog.float('uMmPerPx', view.camera.mmPerPx);
    prog.float('uDotPx', item.layer.shape === 'dot' ? 4 * input.uiScale : 0);
    prog.float('uAmbient', input.scene.lighting.ambient);
    prog.float('uOpacity', item.layer.opacity);
    inst.vao.bind();
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, POINT_QUAD_VERTICES, inst.count);
    VertexArray.unbind(gl);
  }

  // -------------------------------------------------------------------------------------------
  // 3D panes
  // -------------------------------------------------------------------------------------------

  #run3D(ctx: PassContext, store: DerivedStore): void {
    const gl = this.#gl;
    const { input, viewProj, eye, view } = ctx;
    const items = collectDrawItems(input, view);

    this.#state.apply(GL_STATE.opaque3d);
    this.#state.clipDistances(0);

    // Isosurfaces — §7.2 pass 1, through the mesh program.
    const isos = items.filter((d): d is IsoDrawItem => d.kind === 'iso');
    if (isos.length > 0) {
      const prog = this.#iso;
      prog.use();
      prog.mat4('uViewProj', viewProj);
      prog.vec3('uEye', eye);
      prog.float('uAmbient', input.scene.lighting.ambient);
      prog.mat4('uModel', IDENTITY);
      for (const d of isos) {
        this.#state.cull(d.layer.faceMode === 'cull' ? 'back' : 'none');
        prog.vec4('uColor', d.layer.color);
        prog.float('uOpacity', d.layer.opacity);
        d.geom.vao.bind();
        if (d.geom.indexed) {
          gl.drawElements(gl.TRIANGLES, d.geom.triangleCount * 3, gl.UNSIGNED_INT, 0);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, d.geom.vertexCount);
        }
        VertexArray.unbind(gl);
      }
      this.#state.cull('none');
    }

    // Vector glyphs — §7.4's instanced cone+shaft, opaque pass.
    for (const layer of input.scene.layers) {
      if (layer.kind !== 'mesh' || layer.glyphs === undefined) continue;
      if (!visibleIn(layer, view)) continue;
      const ds = input.scene.datasets.get(layer.datasetId);
      if (ds === undefined || ds.kind !== 'mesh') continue;
      this.#drawGlyphs(ctx, store, layer, ds);
    }

    // A parsed view's `SL` segments, under the spheres.
    for (const d of items) {
      if (d.kind === 'points') this.#drawPointLines(ctx, d.layer, store);
    }

    // Points — billboards with an analytic hemisphere (§7.4's "no new geometry from WASM").
    const points = items.filter((d): d is PointsDrawItem => d.kind === 'points');
    if (points.length > 0) {
      const prog = this.#points.get({ POINTS_2D: 0 });
      prog.use();
      prog.mat4('uViewProj', viewProj);
      // A view-aligned billboard: right and up come out of the view matrix's rows.
      const right: vec3 = [viewProj[0] ?? 1, viewProj[4] ?? 0, viewProj[8] ?? 0];
      const up: vec3 = [viewProj[1] ?? 0, viewProj[5] ?? 1, viewProj[9] ?? 0];
      prog.vec3('uRight', normalize(right));
      prog.vec3('uUp', normalize(up));
      prog.vec3('uNormal', [0, 0, 1]);
      prog.float('uPlaneOffset', 0);
      prog.float('uMmPerPx', 1);
      prog.float('uDotPx', 0);
      prog.float('uAmbient', input.scene.lighting.ambient);
      for (const d of points) {
        const inst = store.pointInstances(d.layer);
        if (inst === null) continue;
        prog.float('uOpacity', d.layer.opacity);
        inst.vao.bind();
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, POINT_QUAD_VERTICES, inst.count);
        VertexArray.unbind(gl);
      }
    }
  }

  /**
   * §7.4's glyphs, in the one of two origin sources `GlyphSpec.origins` names.
   *
   * The two paths differ only in *where the origin table comes from and how the instance indexes
   * it*; the field lookup, the arrow frame, the colouring and the draw call are one piece of code
   * because they are one feature. `'surface'` averages a de-indexed triangle and reads `ownerElm`;
   * `'volume'` reads one `meshCentroids` point and its `ownerTet`, with the stride and the visible
   * tags applied by the op instead of by the shader (§6.5.2, and `docs/DECISIONS.md`).
   */
  #drawGlyphs(ctx: PassContext, store: DerivedStore, layer: MeshLayer, ds: MeshDataset): void {
    const gl = this.#gl;
    const spec = layer.glyphs;
    if (spec === undefined) return;
    const plan = glyphPlan(layer, ds, spec, store.surfaceTables(ds)?.triangleCount ?? 0);
    const { volume, stride, scaling, slab } = plan;
    const refMag = plan.refMag;

    // The origin table, and how many instances it is worth. `null` means "not here yet" for both —
    // the op is in flight and its `.then` will dirty the frame.
    let posTable: Table;
    let ownerTable: Table;
    let tagTable: Table | null = null;
    let count: number;
    if (volume) {
      const tags = visibleTetTags(layer, ds);
      // Every tet tag hidden: an absent `tags` would mean "no filter" to the op, so do not ask.
      if (tags.length === 0) return;
      const origins = store.centroidTables(ds, stride, tags);
      if (origins === null) return;
      posTable = origins.positions;
      ownerTable = origins.owner;
      count = origins.count;
    } else {
      const surface = store.surfaceTables(ds);
      if (surface === null) return;
      posTable = surface.positions;
      ownerTable = surface.owner;
      tagTable = surface.tag;
      count = Math.max(0, Math.floor((surface.triangleCount - 1) / stride) + 1);
    }
    if (count === 0) return;

    const fx = store.fieldTable(ds, spec.field.source, spec.field.name, 0);
    const fy = store.fieldTable(ds, spec.field.source, spec.field.name, 1);
    const fz = store.fieldTable(ds, spec.field.source, spec.field.name, 2);
    if (fx === null || fy === null || fz === null) return;

    const lut = store.tagLut(layer, ds);
    // The reference magnitude is also the colour bar's top end, so an arrow at full length and an
    // arrow at the top of the ramp are the same arrow (`derived/glyph-scale.ts`).
    // The LUT is indexed by the scaling's own 0..1 position (`glyphColorT`), not by the magnitude,
    // so it is baked over the unit interval and the mapping lives in one place.
    const baked = ctx.input.store.lut(
      { kind: 'linear', lo: 0, hi: 1 },
      layer.colormap,
      layer.colormapNegative
    );

    const prog = this.#glyph.get({ TVX_GLYPH_VOLUME: volume ? 1 : 0 });
    prog.use();
    prog.mat4('uViewProj', ctx.viewProj);
    prog.mat4('uModel', ds.transform);
    prog.vec3('uEye', ctx.eye);
    prog.float('uAmbient', ctx.input.scene.lighting.ambient);
    prog.float('uOpacity', layer.opacity);
    prog.int('uFirst', 0);
    // The volume path's rows are already strided by the op; striding them twice would draw every
    // `stride`-th of a list that is one in `stride` already.
    prog.int('uStride', volume ? 1 : stride);
    prog.float('uLengthMm', scaling.lengthMm);
    prog.int('uScaleMode', SCALE_MODE[scaling.mode]);
    prog.float('uRefMag', refMag);
    prog.float('uLogFloor', scaling.logFloor);
    prog.vec4('uSlab', slab.plane);
    prog.float('uSlabHalf', slab.half);
    prog.vec4('uSolidColor', spec.color);
    prog.float('uColorByMagnitude', spec.colorBy === 'magnitude' ? 1 : 0);
    prog.int('uTableW', ownerTable.width);
    prog.int('uPosW', posTable.width);
    prog.int('uFieldW', fx.width);
    prog.int('uTagLutW', lut.table.width);
    prog.int('uTagLutN', lut.count);

    const bind = (unit: number, tex: WebGLTexture, name: string): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      prog.int(name, unit);
    };
    bind(0, posTable.texture, 'uPosTex');
    bind(1, ownerTable.texture, 'uOwnerTex');
    if (tagTable !== null) bind(2, tagTable.texture, 'uTagTex');
    bind(3, lut.table.texture, 'uTagLut');
    bind(4, fx.texture, 'uFx');
    bind(5, fy.texture, 'uFy');
    bind(6, fz.texture, 'uFz');
    bind(7, baked.texture, 'uLut');

    const template = this.#arrow(spec.shape === 'arrow', spec.headProportion ?? HEAD_LEN);
    template.vao.bind();
    gl.drawArraysInstanced(gl.TRIANGLES, 0, template.vertices, count);
    VertexArray.unbind(gl);
  }

  dispose(): void {
    this.#fill.dispose();
    this.#contour.dispose();
    this.#points.dispose();
    this.#glyph.dispose();
    this.#iso.dispose();
    for (const a of this.#arrows.values()) {
      a.vao.dispose();
      for (const b of a.buffers) b.dispose();
    }
    this.#arrows.clear();
  }
}

/** `GlyphScaling.mode` as the shader's `uScaleMode`. */
const SCALE_MODE: Record<'fixed' | 'linear' | 'sqrt' | 'log', number> = {
  fixed: 0,
  linear: 1,
  sqrt: 2,
  log: 3,
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function normalize(v: vec3): vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

/** A contour takes the layer's edge colour, which is what a user has already set for its wireframe. */
function contourColor(layer: MeshLayer): vec4 {
  const e = layer.edgeColor;
  if (e[3] > 0) return e;
  return DEFAULT_CONTOUR_COLOR;
}
