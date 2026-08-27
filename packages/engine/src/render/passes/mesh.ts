/**
 * §7.2's mesh passes — pass 1 (opaque) and pass 2 (transparent, two phases).
 *
 * The two-phase split, verbatim from §7.2:
 *
 * * **2a — back faces:** `cullFace(FRONT)`, depth test on, depth write off; objects sorted
 *   back-to-front by the depth of their **far** extent.
 * * **2b — front faces:** `cullFace(BACK)`, depth test on, depth write off; objects sorted
 *   back-to-front by the depth of their **near** extent.
 *
 * Unified rule: *in each phase, objects are sorted back-to-front by the depth of the sheet that
 * phase draws.* Exact for nested, individually near-convex shells (scalp, skull, CSF, blood — median
 * 2 crossings `[M2Max]`); a partial improvement for GM/WM (median 4–6, p90 8–10). Layers with
 * `faceMode: 'both'` are excluded from the split and drawn **last in 2b**.
 *
 * **Phase 2 (owner: E-MESH) extends this file**: per-tag opacity sub-draws already sort naturally,
 * but cut caps join "in the same pass as their owning layer, with that layer's opacity" — a cap is a
 * single sheet in the transparent pass, `CULL_FACE` disabled, sorted by the clip plane's depth at
 * the object centre — and the clip-distance enable set is reset **per pass**, exactly this one.
 */

import { Program } from '../../gl/program';
import { VertexArray } from '../../gl/buffer';
import { collectDrawItems } from './pass';
import type { FramePass, PassContext } from './pass';
import { MESH_FS, MESH_VS } from '../../shaders';
import type { MeshDrawItem } from '../../layers/runtime';
import { isSliceView } from '../../scene/store';
import type { MeshDataset, MeshLayer, vec3, vec4 } from '../../scene/types';

export class MeshPass implements FramePass {
  readonly name = 'mesh' as const;

  readonly #gl: WebGL2RenderingContext;
  readonly #program: Program;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#program = new Program(gl, MESH_VS, MESH_FS);
  }

  run(ctx: PassContext): void {
    const { view, eye, viewProj, input } = ctx;
    // Phase 1 draws meshes in 3D panes only; the runtimes already return nothing for a 2D pane, and
    // this guard keeps the GL state changes below off the 2D path entirely.
    if (isSliceView(view)) return;
    const gl = this.#gl;
    const draws = collectDrawItems(input, view).filter((d): d is MeshDrawItem => d.kind === 'mesh');

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);

    const prog = this.#program;
    prog.use();
    prog.mat4('uViewProj', viewProj);
    prog.vec3('uEye', eye);
    prog.float('uAmbient', input.scene.lighting.ambient);

    const opaque = draws.filter((d) => d.layer.opacity >= 1);
    const translucent = draws.filter((d) => d.layer.opacity < 1);

    // Pass 1 — opaque.
    gl.disable(gl.BLEND);
    for (const d of opaque) {
      // §7.4: `faceMode` is forced to 'both' when orient.openComponents > 0, which every tagged
      // tissue surface hits — an interface triangle's winding is arbitrary.
      if (d.layer.faceMode === 'cull' && d.ds.orient.openComponents === 0) {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
      } else {
        gl.disable(gl.CULL_FACE);
      }
      this.#draw(d, prog, 1);
    }

    // Pass 2 — transparent, two phases (§7.2). Sorted back-to-front by the depth of the sheet each
    // phase draws; with one shell per layer the centre depth is that ordering.
    if (translucent.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      const depthOf = (d: MeshDrawItem): number => {
        const b = d.ds.bounds;
        const c: vec3 = [
          (b.min[0] + b.max[0]) / 2,
          (b.min[1] + b.max[1]) / 2,
          (b.min[2] + b.max[2]) / 2,
        ];
        return Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
      };
      const sorted = [...translucent].sort((a, b) => depthOf(b) - depthOf(a));
      const split = sorted.filter((d) => d.layer.faceMode === 'cull');
      const both = sorted.filter((d) => d.layer.faceMode !== 'cull');
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT); // 2a — back faces
      for (const d of split) this.#draw(d, prog, 1);
      gl.cullFace(gl.BACK); // 2b — front faces
      for (const d of split) this.#draw(d, prog, 1);
      // Layers with faceMode 'both' are excluded from the split and drawn last in 2b (§7.2).
      gl.disable(gl.CULL_FACE);
      for (const d of both) this.#draw(d, prog, 1);
      gl.depthMask(true);
    }
    gl.disable(gl.CULL_FACE);
  }

  /**
   * One layer, drawn as one sub-range per tag (`SurfacePayload.perTag`) with the tag colour as a
   * **uniform** — §7.4's indexed variant. `tagStyle[tag].visible` is a skipped sub-draw, which is
   * free; there is deliberately no per-vertex `tag` attribute, because 1,048,599 of ernie's
   * 1,177,213 interface faces are shared between two tissue tags `[DATA]` and a per-vertex tag is
   * ill-defined on a shared node.
   */
  #draw(entry: MeshDrawItem, prog: Program, opacityScale: number): void {
    const gl = this.#gl;
    const { layer, ds, geom } = entry;
    prog.mat4('uModel', ds.transform);
    geom.vao.bind();
    for (const range of geom.perTag) {
      const style = layer.tagStyle[range.tag];
      if (style !== undefined && !style.visible) continue;
      const alpha = (style?.opacity ?? 1) * layer.opacity * opacityScale;
      if (alpha <= 0) continue;
      const c = tagColor(layer, ds, range.tag);
      prog.vec4('uColor', [c[0], c[1], c[2], c[3]]);
      prog.float('uOpacity', alpha);
      if (geom.indexed) {
        gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.first * 4);
      } else {
        gl.drawArrays(gl.TRIANGLES, range.first, range.count);
      }
    }
    VertexArray.unbind(gl);
  }

  dispose(): void {
    this.#program.dispose();
  }
}

/**
 * The colour of one tag: the layer's per-tag override, then the dataset's own tag colour (from
 * `$PhysicalNames` / `.msh.opt` / the §7.6 default palette), then the layer's solid colour.
 *
 * §4.1 requires the dataset's 0..255 wire value to round-trip **exactly** through the engine's 0..1
 * representation, which §11's "cap pixel is the tag colour" test pins.
 */
export function tagColor(layer: MeshLayer, ds: MeshDataset, tag: number): vec4 {
  if (layer.colorMode === 'solid') return layer.solidColor;
  const style = layer.tagStyle[tag];
  if (style?.color !== undefined) return style.color;
  const t = ds.tags.find((x) => x.id === tag);
  return t?.color ?? layer.solidColor;
}
