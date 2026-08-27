/**
 * Pass orchestration — §7.2's pass order, per view.
 *
 * 1. **Opaque** — meshes, and (Phase 2) `showIn3D` slice planes.
 * 2. **Transparent, two phases** — 2a back faces, 2b front faces, both depth-tested with depth
 *    writes off, sorted back-to-front by the sheet each phase draws.
 * 3. **Overlay** — crosshair, orientation letters, corner info, RAD/NEU badge.
 * 4. **Pick** — on demand, §7.2.3.
 *
 * 2D slice views are a special case §7.3 fixes: `DEPTH_TEST` **disabled for the whole slice-layer
 * pass**, compositing order is layer order bottom→top with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. There
 * is nothing else in a 2D view to depth-test against.
 */

import { Buffer, VertexArray } from '../gl/buffer';
import type { Capabilities } from '../gl/caps';
import { Program, ProgramVariants } from '../gl/program';
import type { GpuStore, SurfaceGeometry } from './gpu';
import { FLOATS_PER_VERTEX, OverlayBuilder, buildChrome } from './overlay';
import {
  MESH_FS,
  MESH_PICK_VS,
  MESH_VS,
  OVERLAY_FS,
  OVERLAY_VS,
  PICK_FS,
  SLICE_FS,
  SLICE_PICK_FS,
  SLICE_PICK_VS,
  SLICE_VS,
} from './shaders';
import type { ViewportRect } from '../view/layout';
import { camera3dMatrices, edgeLetters, sliceBasis, sliceViewProj } from '../view/geometry';
import type {
  Layer,
  mat4,
  MeshDataset,
  MeshLayer,
  Scene,
  SliceView,
  vec3,
  vec4,
  View,
  View3D,
  VolumeDataset,
  VolumeLayer,
} from '../scene/types';

const TEXT_COLOR: vec4 = [0.92, 0.94, 0.98, 1];
const CROSSHAIR_COLOR: vec4 = [1, 0.85, 0.2, 0.9];
const ACTIVE_BORDER: vec4 = [0.35, 0.62, 1, 1];

export interface DrawInput {
  scene: Scene;
  store: GpuStore;
  /** Device pixels of the whole canvas. */
  canvasWidth: number;
  canvasHeight: number;
  activeViewId: string | null;
  /** Bitmap-font magnification; 1 at DPR 1. */
  uiScale: number;
  /** Chrome is skipped entirely when `annotations` says so; the badge is never optional (§8). */
  showChrome: boolean;
}

export function volumeKey(layer: VolumeLayer): string {
  return `${layer.datasetId}|${layer.volumeIndex}`;
}
export function surfaceKey(
  datasetId: string,
  variant: 'indexed' | 'deindexed',
  maskId?: number
): string {
  return `${datasetId}|${variant}|${maskId ?? ''}`;
}

function isSlice(v: View): v is SliceView {
  return (v as SliceView).mode !== undefined;
}

export class Renderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #caps: Capabilities;
  readonly #slice: ProgramVariants;
  readonly #mesh: Program;
  readonly #overlay: Program;
  readonly #meshPick: Program;
  readonly #slicePick: Program;

  readonly #quadBuf: Buffer;
  readonly #quadVao: VertexArray;
  readonly #overlayBuf: Buffer;
  readonly #overlayVao: VertexArray;
  readonly #builder = new OverlayBuilder();
  readonly #quadData = new Float32Array(18);

  constructor(gl: WebGL2RenderingContext, caps: Capabilities) {
    this.#gl = gl;
    this.#caps = caps;
    this.#slice = new ProgramVariants(gl, SLICE_VS, SLICE_FS);
    this.#mesh = new Program(gl, MESH_VS, MESH_FS);
    this.#overlay = new Program(gl, OVERLAY_VS, OVERLAY_FS);
    this.#meshPick = new Program(gl, MESH_PICK_VS, PICK_FS);
    this.#slicePick = new Program(gl, SLICE_PICK_VS, SLICE_PICK_FS);

    this.#quadBuf = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    this.#quadVao = new VertexArray(gl);
    this.#quadVao.attrib(0, this.#quadBuf, 3, gl.FLOAT);
    VertexArray.unbind(gl);

    this.#overlayBuf = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    this.#overlayVao = new VertexArray(gl);
    const stride = FLOATS_PER_VERTEX * 4;
    this.#overlayVao.attrib(0, this.#overlayBuf, 2, gl.FLOAT, false, stride, 0);
    this.#overlayVao.attrib(1, this.#overlayBuf, 2, gl.FLOAT, false, stride, 8);
    this.#overlayVao.attrib(2, this.#overlayBuf, 4, gl.FLOAT, false, stride, 16);
    VertexArray.unbind(gl);
  }

  get caps(): Capabilities {
    return this.#caps;
  }

  /**
   * The shared slice quad (§7.3): **owned by the plane, not by any volume**. One quad in the
   * `(right, up)` basis centred on the cursor, sized to cover the pane, written into one buffer that
   * every layer on that plane draws from — which is what makes their interpolated depth identical.
   */
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

  /** Half-extent that guarantees the quad covers the pane at this zoom. */
  #quadHalf(view: SliceView, rect: ViewportRect, scene: Scene): number {
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

  #layersFor(scene: Scene, view: View): Layer[] {
    const vis = isSlice(view) ? view.layerVisibility : (view as View3D).layerVisibility;
    return scene.layers.filter((l) => l.visible && (vis?.[l.id] ?? true));
  }

  // -----------------------------------------------------------------------------------------
  // 2D slice pass
  // -----------------------------------------------------------------------------------------

  #drawSliceLayers(view: SliceView, rect: ViewportRect, input: DrawInput, viewProj: mat4): void {
    const gl = this.#gl;
    const { scene, store } = input;
    // §7.3: depth test OFF for the whole 2D slice-layer pass; order is layer order, bottom -> top.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const basis = sliceBasis(view, scene.radiological);
    this.#writeQuad(scene.cursor, basis.right, basis.up, this.#quadHalf(view, rect, scene));
    this.#quadVao.bind();

    for (const layer of this.#layersFor(scene, view)) {
      if (layer.kind !== 'volume') continue;
      const ds = scene.datasets.get(layer.datasetId);
      if (ds === undefined || ds.kind !== 'volume') continue;
      const gpu = store.volume(volumeKey(layer));
      if (gpu === undefined) continue;

      const prog = this.#slice.get({ IS_LABEL: gpu.integer ? 1 : 0 });
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
        const lut = store.lut(layer.scale, layer.colormap, layer.colormapNegative);
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

  // -----------------------------------------------------------------------------------------
  // 3D mesh passes
  // -----------------------------------------------------------------------------------------

  #meshDraws(
    scene: Scene,
    view: View,
    store: GpuStore
  ): { layer: MeshLayer; ds: MeshDataset; geom: SurfaceGeometry }[] {
    const out: { layer: MeshLayer; ds: MeshDataset; geom: SurfaceGeometry }[] = [];
    for (const layer of this.#layersFor(scene, view)) {
      if (layer.kind !== 'mesh') continue;
      const ds = scene.datasets.get(layer.datasetId);
      if (ds === undefined || ds.kind !== 'mesh') continue;
      const geom =
        store.surface(surfaceKey(layer.datasetId, 'indexed')) ??
        store.surface(surfaceKey(layer.datasetId, 'deindexed'));
      if (geom === undefined) continue;
      out.push({ layer, ds, geom });
    }
    return out;
  }

  #tagColor(layer: MeshLayer, ds: MeshDataset, tag: number): vec4 {
    if (layer.colorMode === 'solid') return layer.solidColor;
    const style = layer.tagStyle[tag];
    if (style?.color !== undefined) return style.color;
    const t = ds.tags.find((x) => x.id === tag);
    return t?.color ?? layer.solidColor;
  }

  #drawMesh(
    entry: { layer: MeshLayer; ds: MeshDataset; geom: SurfaceGeometry },
    prog: Program,
    opacityScale: number
  ): void {
    const gl = this.#gl;
    const { layer, ds, geom } = entry;
    prog.mat4('uModel', ds.transform);
    geom.vao.bind();
    for (const range of geom.perTag) {
      const style = layer.tagStyle[range.tag];
      if (style !== undefined && !style.visible) continue;
      const alpha = (style?.opacity ?? 1) * layer.opacity * opacityScale;
      if (alpha <= 0) continue;
      const c = this.#tagColor(layer, ds, range.tag);
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

  #draw3d(view: View3D, rect: ViewportRect, input: DrawInput): { viewProj: mat4; eye: vec3 } {
    const gl = this.#gl;
    const { scene, store } = input;
    const cam = camera3dMatrices(view.camera, rect.width, rect.height);
    const draws = this.#meshDraws(scene, view, store);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);

    const prog = this.#mesh;
    prog.use();
    prog.mat4('uViewProj', cam.viewProj);
    prog.vec3('uEye', cam.eye);
    prog.float('uAmbient', scene.lighting.ambient);

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
      this.#drawMesh(d, prog, 1);
    }

    // Pass 2 — transparent, two phases (§7.2). Sorted back-to-front by the depth of the sheet each
    // phase draws; with one shell per layer the centre depth is that ordering.
    if (translucent.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      const depthOf = (d: (typeof translucent)[number]): number => {
        const b = d.ds.bounds;
        const c: vec3 = [
          (b.min[0] + b.max[0]) / 2,
          (b.min[1] + b.max[1]) / 2,
          (b.min[2] + b.max[2]) / 2,
        ];
        return Math.hypot(c[0] - cam.eye[0], c[1] - cam.eye[1], c[2] - cam.eye[2]);
      };
      const sorted = [...translucent].sort((a, b) => depthOf(b) - depthOf(a));
      const split = sorted.filter((d) => d.layer.faceMode === 'cull');
      const both = sorted.filter((d) => d.layer.faceMode !== 'cull');
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT); // 2a — back faces
      for (const d of split) this.#drawMesh(d, prog, 1);
      gl.cullFace(gl.BACK); // 2b — front faces
      for (const d of split) this.#drawMesh(d, prog, 1);
      // Layers with faceMode 'both' are excluded from the split and drawn last in 2b (§7.2).
      gl.disable(gl.CULL_FACE);
      for (const d of both) this.#drawMesh(d, prog, 1);
      gl.depthMask(true);
    }
    gl.disable(gl.CULL_FACE);
    return { viewProj: cam.viewProj, eye: cam.eye };
  }

  // -----------------------------------------------------------------------------------------
  // Overlay
  // -----------------------------------------------------------------------------------------

  #drawOverlay(rect: ViewportRect, input: DrawInput, view: View, viewProj: mat4): void {
    if (!input.showChrome) return;
    const { scene } = input;
    const a = scene.annotations;
    const b = this.#builder;
    b.begin(rect.width, rect.height);

    let letters: { left: string; right: string; top: string; bottom: string } | undefined;
    let crosshair: { x: number; y: number } | null = null;
    const cornerLines: string[] = [];

    if (isSlice(view)) {
      const basis = sliceBasis(view, scene.radiological);
      if (a.orientationLabels) letters = edgeLetters(basis);
      if (a.crosshair) {
        // The cursor is the plane's origin, so its pane position is the pan offset alone.
        const cx = rect.width / 2 - view.camera.center[0] / view.camera.mmPerPx;
        const cy = rect.height / 2 - view.camera.center[1] / view.camera.mmPerPx;
        crosshair = { x: cx, y: cy };
      }
      if (a.cornerInfo) {
        cornerLines.push(view.mode.toUpperCase());
        const c = scene.cursor;
        cornerLines.push(`RAS ${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`);
        const top = topVolume(scene);
        if (top !== null) {
          const v = worldToVoxel(top.ds, c);
          cornerLines.push(`SLICE ${Math.round(sliceIndex(view, v))}`);
        }
      }
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
      badge: scene.radiological ? 'RAD' : 'NEU',
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
    this.#overlayBuf.update(b.build());
    this.#overlay.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input.store.fontAtlas());
    this.#overlay.int('uAtlas', 0);
    this.#overlayVao.bind();
    gl.drawArrays(gl.TRIANGLES, 0, b.vertexCount);
    VertexArray.unbind(gl);
  }

  // -----------------------------------------------------------------------------------------

  /** Render one pane. Returns the view-projection used, for the pick pass to reuse. */
  renderView(view: View, rect: ViewportRect, input: DrawInput): mat4 {
    const gl = this.#gl;
    gl.viewport(rect.x, rect.y, rect.width, rect.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect.x, rect.y, rect.width, rect.height);
    const bg = input.scene.background;
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let viewProj: mat4;
    if (isSlice(view)) {
      const half = this.#quadHalf(view, rect, input.scene) * 2;
      const r = sliceViewProjFor(view, input.scene, rect, half);
      viewProj = r;
      this.#drawSliceLayers(view, rect, input, viewProj);
    } else {
      viewProj = this.#draw3d(view as View3D, rect, input).viewProj;
    }
    this.#drawOverlay(rect, input, view, viewProj);
    gl.disable(gl.SCISSOR_TEST);
    return viewProj;
  }

  /** The pick programs, exposed so `pick.ts` can drive the same geometry. */
  get pickPrograms(): { mesh: Program; slice: Program } {
    return { mesh: this.#meshPick, slice: this.#slicePick };
  }

  get quad(): { vao: VertexArray; write: (c: vec3, r: vec3, u: vec3, h: number) => void } {
    return {
      vao: this.#quadVao,
      write: (c, r, u, h) => {
        this.#writeQuad(c, r, u, h);
      },
    };
  }

  dispose(): void {
    this.#slice.dispose();
    this.#mesh.dispose();
    this.#overlay.dispose();
    this.#meshPick.dispose();
    this.#slicePick.dispose();
    this.#quadBuf.dispose();
    this.#quadVao.dispose();
    this.#overlayBuf.dispose();
    this.#overlayVao.dispose();
  }
}

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

function topVolume(scene: Scene): { layer: VolumeLayer; ds: VolumeDataset } | null {
  for (let i = scene.layers.length - 1; i >= 0; i -= 1) {
    const l = scene.layers[i];
    if (l === undefined || l.kind !== 'volume' || !l.visible) continue;
    const ds = scene.datasets.get(l.datasetId);
    if (ds !== undefined && ds.kind === 'volume') return { layer: l, ds };
  }
  return null;
}

export function worldToVoxel(ds: VolumeDataset, w: vec3): vec3 {
  const m = ds.inverseAffine;
  return [
    (m[0] ?? 0) * w[0] + (m[4] ?? 0) * w[1] + (m[8] ?? 0) * w[2] + (m[12] ?? 0),
    (m[1] ?? 0) * w[0] + (m[5] ?? 0) * w[1] + (m[9] ?? 0) * w[2] + (m[13] ?? 0),
    (m[2] ?? 0) * w[0] + (m[6] ?? 0) * w[1] + (m[10] ?? 0) * w[2] + (m[14] ?? 0),
  ];
}

/** Which voxel axis a canonical view steps along; oblique reports the dominant one. */
function sliceIndex(view: SliceView, voxel: vec3): number {
  switch (view.mode) {
    case 'sagittal':
      return voxel[0];
    case 'coronal':
      return voxel[1];
    default:
      return voxel[2];
  }
}

function sliceViewProjFor(
  view: SliceView,
  scene: Scene,
  rect: ViewportRect,
  halfDepth: number
): mat4 {
  return sliceViewProj(view, scene.cursor, rect.width, rect.height, scene.radiological, halfDepth)
    .viewProj;
}
