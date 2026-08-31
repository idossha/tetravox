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
import type { GizmoSpec } from '../../overlay/gizmo';
import type { OverlayTheme } from '../../overlay/theme';

/** Everything a frame needs that is not per-pane. Assembled once per frame by the engine. */
export interface DrawInput {
  scene: Scene;
  store: GpuStore;
  /** The §4.4 layer runtimes, keyed by `LayerId` — the only source of per-kind draw decisions. */
  runtimes: ReadonlyMap<LayerId, LayerRuntime>;
  /**
   * Runtimes a §4.4 layer **owns** rather than is — today, a volume layer's `iso3d` surfaces
   * (directed task 2, 2026-08-28; appended, shared-file rule: additive only).
   *
   * They are keyed by the **owning** layer's id and draw immediately above it, so §7.2's passes see
   * them in the same bottom→top order as everything else. They are deliberately *not* in
   * `scene.layers`: nothing but the volume layer that derived them may edit them, they carry no row
   * in §8's layer panel, and `collectPickItems` never reaches them (§7.2.3 keeps isosurfaces out of
   * the pick target anyway).
   */
  ownedRuntimes?: ReadonlyMap<LayerId, readonly LayerRuntime[]>;
  /** Device pixels of the whole canvas. */
  canvasWidth: number;
  canvasHeight: number;
  activeViewId: ViewId | null;
  /** Bitmap-font magnification; 1 at DPR 1. */
  uiScale: number;
  /** Chrome is skipped entirely when `annotations` says so; the badge is never optional (§8). */
  showChrome: boolean;
  /**
   * The §7.2 pass-3 chrome palette (directed task 9, 2026-08-28; appended, shared-file rule:
   * additive only).
   *
   * Optional, and absent means `DEFAULT_OVERLAY_THEME` — the exact colours the overlay pass held as
   * `const`s through Phase 1 and 2 — so a `DrawInput` assembled by a test or by the no-GL engine
   * draws what it always drew and §11's goldens do not move.
   *
   * It rides on the frame rather than on `Scene` because a theme belongs to the window looking at
   * the scene, not to the scene: §4.6 would otherwise serialise one embedder's palette into a
   * `*.tetravox.json` that another opens.
   */
  theme?: OverlayTheme;
  /**
   * The cut-plane gizmo to draw in the 3D pane, or `null` — §7.5's oblique affordances (appended by
   * E-SCENE; shared-file rule: additive only).
   *
   * It lives here rather than in `Scene` because §4.5 is frozen **and** because a gizmo is transient
   * UI state, not scene state: which plane is being manipulated and which handle is hot are things a
   * pointer knows for the length of a drag, and a saved `ViewSpec` should never carry them.
   */
  gizmo?: GizmoSpec | null;
  /**
   * The `mmPerPx` each 2D pane was last **fitted** at, for R2's corner `×zoom` readout (appended by
   * E-SCENE; shared-file rule: additive only).
   *
   * Remembered rather than recomputed per frame, and this is the whole difference between a readout
   * that means something and one that does not: recomputing the fit for the pane's *current* size
   * makes every pane claim to be zoomed the moment the layout changes, though the user did nothing.
   * "Zoom" is measured against the fit the user last asked for (`resetView`, or the auto-fit on the
   * first dataset), which is what `r` returns them to.
   */
  viewFit?: ReadonlyMap<ViewId, number>;
  /**
   * `caps.clipDistance` — whether `WEBGL_clip_cull_distance` was **requested and granted** (§7.1).
   *
   * A pass reads it here rather than off the engine's `Capabilities` so that `EngineOptions.forceCaps`
   * (which may only ever *remove* a capability) is already applied. Absent means the `discard` clip
   * path, which is the safe direction: `gl.enable(0x3000)` on a context without the extension is an
   * `INVALID_ENUM`.
   */
  clipDistance?: boolean;
  /**
   * §7.4 / §11's clip-path axis: force the `vec4`-uniform + `discard` fallback even where the
   * hardware path exists, so **both** paths run under the same goldens.
   */
  forceDiscardClip?: boolean;
  /**
   * What the **derived** pass needs and no other pass does (E-DERIVED): the GPU resources it draws
   * from and the cut source behind them.
   *
   * Optional because a `DrawInput` is also assembled by tests and by the no-GL engine, and a pass
   * that has nothing to draw from must be a no-op rather than a crash — the same shape as
   * `activeViewId: null`.
   */
  derived?: DerivedInput;
  /**
   * The measurement being placed right now — the points clicked so far, before the gesture is
   * complete (directed task 11, 2026-08-28; appended, shared-file rule: additive only).
   *
   * It rides on the frame rather than in `Scene` for the same reason `gizmo` does: a half-placed
   * measurement is transient pointer state, and a `*.tetravox.json` must never carry one. The
   * finished ones are `Scene.measurements` and are drawn from there.
   */
  measureDraft?: readonly vec3[] | null;
  /**
   * The point a tool has **selected**, and the one the pointer is **over** — §13's point editing
   * (2026-08-30; appended, shared-file rule: additive only).
   *
   * They ride the frame rather than `Scene` for the reason `gizmo` and `measureDraft` do: which
   * contact is selected and which is hot are things a pointer knows for the length of an
   * interaction, and a `*.tetravox.json` must never carry one — a scene mailed to a colleague would
   * otherwise open with a stranger's cursor state in it.
   *
   * Addressed by **array index**, not by `points[].id`: this is the frame's key into the array the
   * pass is about to walk, resolved from whatever the tool selects by at the moment the frame is
   * assembled. An `index` out of range, or a `layerId` that is not a visible points layer, draws
   * nothing — a stale highlight has to be a missing ring, never a ring around the wrong contact.
   *
   * Both are drawn as rings in `OverlayTheme.select` (§7.2). Absent or `null` means no ring, which
   * is what every frame assembled before today meant, so §11's goldens do not move.
   */
  pointSelection?: { layerId: LayerId; index: number } | null;
  pointHot?: { layerId: LayerId; index: number } | null;
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
    if (runtime !== undefined) out.push(...runtime.drawItems(view));
    const owned = input.ownedRuntimes?.get(layer.id);
    if (owned !== undefined) for (const rt of owned) out.push(...rt.drawItems(view));
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
