/**
 * §7.2's pass 3 — the overlay.
 *
 * Everything in it is drawn into the GL framebuffer, never into a DOM layer above it: §8 calls the
 * 2D chrome **a laterality-safety requirement, not decoration** and §11 requires it in every golden,
 * and a DOM overlay would be invisible to `readPixel` and to `screenshot()` — the same as not
 * testing it.
 *
 * **All clip distances are disabled in this pass**, or the gizmo gets clipped by the plane it
 * manipulates. Nothing enables one in Phase 1, so the reset set is empty today; Phase 2's six clip
 * planes make it load-bearing.
 *
 * The geometry comes from `src/overlay/*`, which is pure and unit-tested without a GL context. This
 * file owns only the program, the dynamic buffer and the single draw call.
 */

import { Buffer, VertexArray } from '../../gl/buffer';
import { Program } from '../../gl/program';
import type { FramePass, PassContext } from './pass';
import { OVERLAY_FS, OVERLAY_VS } from '../../shaders';
import { FLOATS_PER_VERTEX, OverlayBuilder, badgeFor, buildChrome } from '../../overlay';
import type { EdgeLetters } from '../../overlay';
import { isSliceView, topVolume } from '../../scene/store';
import { edgeLetters, sliceBasis, voxelAxisAlong, worldToVoxel } from '../../view/geometry';
import type { Scene, SliceView, vec3, vec4, VolumeDataset } from '../../scene/types';

const TEXT_COLOR: vec4 = [0.92, 0.94, 0.98, 1];
const CROSSHAIR_COLOR: vec4 = [1, 0.85, 0.2, 0.9];
const ACTIVE_BORDER: vec4 = [0.35, 0.62, 1, 1];

export class OverlayPass implements FramePass {
  readonly name = 'overlay' as const;

  readonly #gl: WebGL2RenderingContext;
  readonly #program: Program;
  readonly #buf: Buffer;
  readonly #vao: VertexArray;
  readonly #builder = new OverlayBuilder();

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#program = new Program(gl, OVERLAY_VS, OVERLAY_FS);
    this.#buf = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    this.#vao = new VertexArray(gl);
    const stride = FLOATS_PER_VERTEX * 4;
    this.#vao.attrib(0, this.#buf, 2, gl.FLOAT, false, stride, 0);
    this.#vao.attrib(1, this.#buf, 2, gl.FLOAT, false, stride, 8);
    this.#vao.attrib(2, this.#buf, 4, gl.FLOAT, false, stride, 16);
    VertexArray.unbind(gl);
  }

  run(ctx: PassContext): void {
    const { view, rect, viewProj, input } = ctx;
    if (!input.showChrome) return;
    const { scene } = input;
    const a = scene.annotations;
    const b = this.#builder;
    b.begin(rect.width, rect.height);

    let letters: EdgeLetters | undefined;
    let crosshair: { x: number; y: number } | null = null;
    const cornerLines: string[] = [];

    if (isSliceView(view)) {
      const basis = sliceBasis(view, scene.radiological);
      if (a.orientationLabels) letters = edgeLetters(basis);
      if (a.crosshair) {
        // The cursor is the plane's origin, so its pane position is the pan offset alone.
        const cx = rect.width / 2 - view.camera.center[0] / view.camera.mmPerPx;
        const cy = rect.height / 2 - view.camera.center[1] / view.camera.mmPerPx;
        crosshair = { x: cx, y: cy };
      }
      if (a.cornerInfo) cornerLines.push(...sliceCornerLines(view, scene));
    } else {
      // A 3D pane's letters come from the camera basis — which anatomical direction is screen-right
      // and screen-up. Same derivation, same safety property, no hardcoding.
      if (a.orientationLabels) {
        const right: vec3 = [viewProj[0] ?? 1, viewProj[4] ?? 0, viewProj[8] ?? 0];
        const up: vec3 = [viewProj[1] ?? 0, viewProj[5] ?? 1, viewProj[9] ?? 0];
        letters = edgeLetters({ right, up, normal: [0, 0, 1] });
      }
      if (a.cornerInfo) cornerLines.push('3D');
    }

    buildChrome(b, {
      widthPx: rect.width,
      heightPx: rect.height,
      uiScale: input.uiScale,
      letters,
      cornerLines: a.cornerInfo ? cornerLines : undefined,
      // §8: `Annotations.conventionBadge` is `true`, not optional — the badge is always drawn.
      badge: badgeFor(scene.radiological),
      crosshair,
      crosshairColor: CROSSHAIR_COLOR,
      textColor: TEXT_COLOR,
      activeBorder:
        input.activeViewId === view.id && input.activeViewId !== null ? ACTIVE_BORDER : undefined,
    });

    if (b.vertexCount === 0) return;
    const gl = this.#gl;
    // §7.2 pass 3: all clip distances disabled, no depth.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.#buf.update(b.build());
    this.#program.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input.store.fontAtlas());
    this.#program.int('uAtlas', 0);
    this.#vao.bind();
    gl.drawArrays(gl.TRIANGLES, 0, b.vertexCount);
    VertexArray.unbind(gl);
  }

  dispose(): void {
    this.#program.dispose();
    this.#buf.dispose();
    this.#vao.dispose();
  }
}

/** §8's corner annotation: "view name, slice index of the active volume layer, world RAS". */
function sliceCornerLines(view: SliceView, scene: Scene): string[] {
  const lines = [view.mode.toUpperCase()];
  const c = scene.cursor;
  lines.push(`RAS ${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`);
  const top = topVolume(scene);
  if (top !== null) {
    const v = worldToVoxel(top.ds, c);
    lines.push(`SLICE ${Math.round(sliceIndex(view, top.ds, v))}`);
  }
  return lines;
}

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

/**
 * §8's corner "slice index of the active volume layer": the cursor's index **along the voxel axis
 * the plane actually steps along**, derived from that volume's affine exactly the way the edge
 * letters are derived from it — never a voxel axis hardcoded per view mode.
 *
 * The reference dataset is why: `m2m_ernie/T1.nii.gz` maps `world x ← k`, `world y ← −i`,
 * `world z ← j` `[DATA]`, so an axial plane steps along voxel `j` and a sagittal one along voxel
 * `k`. A `mode === 'sagittal' ? voxel[0] : …` table reports two of the three panes' numbers swapped
 * on every SimNIBS `m2m` volume. Oblique reports the dominant axis, which is the same rule.
 */
function sliceIndex(view: SliceView, ds: VolumeDataset, voxel: vec3): number {
  return voxel[voxelAxisAlong(view.normal, ds.affine).axis];
}
