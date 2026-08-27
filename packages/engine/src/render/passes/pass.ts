/**
 * The `Pass` seam — §7.2's pass list, as an interface.
 *
 * §7.2 fixes the order and nothing may reorder it:
 *
 * 1. **Opaque** — volume base slices, opaque meshes, opaque isosurfaces, points, and the cut caps of
 *    opaque layers.
 * 2. **Transparent, scene-wide, two phases** — 2a back faces, 2b front faces, each sorted
 *    back-to-front by the depth of the sheet that phase draws.
 * 3. **Overlay** — crosshair, gizmo, contours, glyph labels, annotations, orientation letters,
 *    corner info, RAD/NEU badge, colour bars, scale bar. **All clip distances disabled.**
 *    E-DERIVED's `derived` pass runs between 2 and 3 and carries the items §7.2 puts in pass 1 that
 *    a mesh only implies — `fillIn2D`, glyphs, isosurfaces, points — plus the contour lines pass 3
 *    names, which must be under the crosshair (R4).
 * 4. **Pick** — on demand, §7.2.3. Not a frame pass: it renders to its own FBO and returns a value,
 *    so it implements {@link Pass} without {@link FramePass}.
 *
 * `render/renderer.ts` owns the order, the viewports and the framebuffers; a pass owns its program,
 * its buffers and its GL state. Nothing outside a pass calls `gl.draw*`.
 */

import type { DerivedStore } from '../../derived/store';
import type { GpuStore } from '../gpu';
import type { DrawItem, LayerRuntime, PickItem } from '../../layers/runtime';
import { pickableIn } from '../../layers/runtime';
import type { LayerId, mat4, Scene, vec3, View, ViewId } from '../../scene/types';
import type { ViewportRect } from '../../view/layout';

/** Everything a frame needs that is not per-pane. Assembled once per frame by the engine. */
export interface DrawInput {
  scene: Scene;
  store: GpuStore;
  /** The §4.4 layer runtimes, keyed by `LayerId` — the only source of per-kind draw decisions. */
  runtimes: ReadonlyMap<LayerId, LayerRuntime>;
  /** Device pixels of the whole canvas. */
  canvasWidth: number;
  canvasHeight: number;
  activeViewId: ViewId | null;
  /** Bitmap-font magnification; 1 at DPR 1. */
  uiScale: number;
  /** Chrome is skipped entirely when `annotations` says so; the badge is never optional (§8). */
  showChrome: boolean;
  /**
   * What the **derived** pass needs and no other pass does (E-DERIVED): the GPU resources it draws
   * from and the cut source behind them.
   *
   * Optional because a `DrawInput` is also assembled by tests and by the no-GL engine, and a pass
   * that has nothing to draw from must be a no-op rather than a crash — the same shape as
   * `activeViewId: null`.
   */
  derived?: DerivedInput;
}

/** The derived pass's half of a frame. See `src/derived/store.ts`. */
export interface DerivedInput {
  store: DerivedStore;
}

/** One pane, mid-frame. */
export interface PassContext {
  gl: WebGL2RenderingContext;
  view: View;
  rect: ViewportRect;
  /** The matrix this pane is being rendered with — the pick pass reuses it exactly (§7.2.3). */
  viewProj: mat4;
  /** World-space eye, for the headlight. Meaningless for a 2D pane and zero there. */
  eye: vec3;
  input: DrawInput;
}

export type PassName = 'slice' | 'mesh' | 'overlay' | 'pick' | 'derived';

export interface Pass {
  readonly name: PassName;
  dispose(): void;
}

/** A pass that runs inside the frame, in §7.2's order. */
export interface FramePass extends Pass {
  run(ctx: PassContext): void;
}

/**
 * Every draw item for one pane, in **layer order** (bottom → top, §4.4).
 *
 * Order is the compositing order for 2D slices (§7.3) and the sub-draw order everywhere else, so it
 * follows `scene.layers` and not the runtime map's iteration order.
 */
export function collectDrawItems(input: DrawInput, view: View): DrawItem[] {
  const out: DrawItem[] = [];
  for (const layer of input.scene.layers) {
    const runtime = input.runtimes.get(layer.id);
    if (runtime === undefined) continue;
    out.push(...runtime.drawItems(view));
  }
  return out;
}

/**
 * Every pick item for one pane, each with its **index in `scene.layers`**.
 *
 * The index is not decoration: §7.2.3 packs it into the pick id as
 * `(layerIndex + 1) << 25`, and `unpackId` looks the layer back up by it.
 */
export function collectPickItems(
  input: DrawInput,
  view: View
): { item: PickItem; layerIndex: number }[] {
  const out: { item: PickItem; layerIndex: number }[] = [];
  input.scene.layers.forEach((layer, layerIndex) => {
    // §7.2.3: "Pick only layers with `visible && pickable && opacity >= pickOpacityMin`."
    if (!pickableIn(layer)) return;
    const runtime = input.runtimes.get(layer.id);
    if (runtime === undefined) return;
    for (const item of runtime.pickItems(view)) out.push({ item, layerIndex });
  });
  return out;
}
