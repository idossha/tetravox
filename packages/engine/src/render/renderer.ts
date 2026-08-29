/**
 * Pass **orchestration** — §7.2's order, per view. Order, viewports, framebuffers; nothing else.
 *
 * 1. **Opaque** — volume base slices (`passes/slice.ts`), opaque meshes (`passes/mesh.ts`), and from
 *    Phase 2 the `showIn3D` planes, isosurfaces, points and the cut caps of opaque layers.
 * 2. **Transparent, two phases** — 2a back faces, 2b front faces, both depth-tested with depth
 *    writes off, sorted back-to-front by the sheet each phase draws (`passes/mesh.ts`).
 * 3. **Overlay** — `passes/overlay.ts`.
 * 4. **Pick** — on demand, `passes/pick.ts`.
 *
 * Programs and buffers belong to the pass modules; the **GL state** they run in belongs to
 * `gl/state.ts`, and this file owns the one {@link GlState} they share. A pass never issues a raw
 * depth / blend / cull call — it enters a complete named block — so an appended fifth or sixth pass
 * cannot inherit whatever the fourth left enabled. Beyond that this file knows the order and the
 * pane rectangle, and deliberately nothing else: §7.2's order is a contract, and a file that also
 * drew would let a feature change it by accident.
 *
 * **Shared-file rule: additive only.** A new pass is appended to the
 * sequence in {@link Renderer.renderView}; existing entries are never reordered.
 */

import type { Capabilities } from '../gl/caps';
import { GL_STATE, GlState } from '../gl/state';
import { DerivedPass } from './passes/derived';
import { MeshPass } from './passes/mesh';
import { OverlayPass } from './passes/overlay';
import { PickPass } from './passes/pick';
import { SlicePass, sliceCamera } from './passes/slice';
import type { SliceQuad } from './passes/slice';
import type { DrawInput, PassContext } from './passes/pass';
import { isSliceView } from '../scene/store';
import { camera3dMatrices } from '../view/geometry';
import type { ViewportRect } from '../view/layout';
import type { mat4, Scene, vec3, View, View3D } from '../scene/types';
import type { PickResult } from '../api';

export class Renderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #caps: Capabilities;
  /** One tracker per context, shared by every pass — GL state is global (`gl/state.ts`). */
  readonly #state: GlState;
  readonly #slice: SlicePass;
  readonly #mesh: MeshPass;
  /**
   * E-DERIVED's pass. §7.2 puts `fillIn2D`, points and isosurfaces in pass 1 and contours in pass 3,
   * so it runs **after** `mesh` and **before** `overlay`: the mesh fill sits over the base volume and
   * under the crosshair (R4). Appending it at the end of the sequence would draw it over the chrome,
   * which §7.2 forbids. No existing entry moves.
   */
  readonly #derived: DerivedPass;
  readonly #overlay: OverlayPass;
  readonly #pick: PickPass;

  constructor(gl: WebGL2RenderingContext, caps: Capabilities) {
    this.#gl = gl;
    this.#caps = caps;
    this.#state = new GlState(gl);
    this.#slice = new SlicePass(gl, this.#state);
    this.#mesh = new MeshPass(gl, this.#state);
    this.#derived = new DerivedPass(gl, this.#state);
    this.#overlay = new OverlayPass(gl, this.#state);
    this.#pick = new PickPass(gl, this.#state);
  }

  get caps(): Capabilities {
    return this.#caps;
  }

  /** The shared slice quad (§7.3), so the pick pass draws the geometry the frame drew. */
  get quad(): SliceQuad {
    return this.#slice.quad;
  }

  /** The half-extent the slice quad is written at — one formula, shared with the pick pass. */
  quadHalfFor(view: View, rect: ViewportRect, scene: Scene): number {
    return this.#slice.quadHalfFor(view, rect, scene);
  }

  /** Render one pane. Returns the view-projection used, for the pick pass to reuse. */
  renderView(view: View, rect: ViewportRect, input: DrawInput): mat4 {
    const gl = this.#gl;
    gl.viewport(rect.x, rect.y, rect.width, rect.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect.x, rect.y, rect.width, rect.height);
    const bg = input.scene.background;
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clearDepth(1);
    // `gl.clear(DEPTH_BUFFER_BIT)` is masked by `depthMask`, so the clear gets a named state block
    // too rather than trusting the last pass of the previous pane to have restored depth writes.
    this.#state.apply(GL_STATE.opaque3d);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const camera = this.#camera(view, rect, input.scene);
    const ctx: PassContext = { gl, view, rect, viewProj: camera.viewProj, eye: camera.eye, input };

    if (isSliceView(view)) {
      // §7.3: a 2D pane composites in **layer order, bottom → top, across kinds** — a volume slice
      // and a mesh fill are two sheets in one order, so the layer the panel shows on top is the one
      // on top of the picture. Running the slice pass and then the derived pass put every mesh
      // fill over every volume regardless of the panel (2026-08-29). Contours and points stay
      // above everything (`DerivedPass.finish2D`), and pass 3 is unchanged.
      this.#slice.begin2D(ctx);
      this.#derived.begin2D(ctx);
      const volumes = SlicePass.volumeItems(input, view);
      for (const layer of input.scene.layers) {
        if (layer.kind === 'volume') {
          for (const item of volumes) if (item.layer.id === layer.id) this.#slice.draw2D(ctx, item);
        } else if (layer.kind === 'mesh') {
          this.#derived.drawFill2D(ctx, layer.id);
        }
      }
      this.#derived.finish2D(ctx);
      this.#overlay.run(ctx);
    } else {
      // §7.2's order. Each pass is a no-op in the pane kind it does not apply to.
      this.#slice.run(ctx);
      this.#mesh.run(ctx);
      this.#derived.run(ctx);
      this.#overlay.run(ctx);
    }

    gl.disable(gl.SCISSOR_TEST);
    return camera.viewProj;
  }

  /**
   * §7.2.3, on demand. `px, py` are **device pixels within the pane**, origin bottom-left, matching
   * `gl.scissor`; `viewProj` is the matrix that pane last rendered with.
   */
  pick(
    view: View,
    rect: ViewportRect,
    viewProj: mat4,
    input: DrawInput,
    px: number,
    py: number
  ): PickResult | null {
    return this.#pick.run({
      gl: this.#gl,
      view,
      rect,
      viewProj,
      input,
      px,
      py,
      quad: this.#slice.quad,
      quadHalf: this.#slice.quadHalfFor(view, rect, input.scene),
    });
  }

  /**
   * The camera for one pane.
   *
   * A 2D pane's depth range runs `±(2 × the quad's half-extent)` so the quad is never clipped by the
   * near or far plane at any pan or zoom; `eye` is meaningless there and is zero.
   */
  #camera(view: View, rect: ViewportRect, scene: Scene): { viewProj: mat4; eye: vec3 } {
    if (isSliceView(view)) {
      const halfDepth = this.#slice.quadHalfFor(view, rect, scene) * 2;
      return { viewProj: sliceCamera(view, scene, rect, halfDepth), eye: [0, 0, 0] };
    }
    const cam = camera3dMatrices((view as View3D).camera, rect.width, rect.height);
    return { viewProj: cam.viewProj, eye: cam.eye };
  }

  dispose(): void {
    this.#slice.dispose();
    this.#mesh.dispose();
    this.#derived.dispose();
    this.#overlay.dispose();
    this.#pick.dispose();
  }
}

export type { DrawInput };
