/**
 * The `points` layer runtime — §4.4's `PointsLayer`: electrodes, ROI spheres from JSON/CSV, SimNIBS
 * `eeg_positions/*.csv`.
 *
 * Unlike every other layer kind it is **not backed by a dataset worker**: the points are a small
 * array that arrives with the layer, so there is no parse to keep off the UI thread and nothing for
 * §5's worker-per-dataset rule to own. (`derived/points-source.ts` turns a `.csv` or `.json` into
 * that array; a 256-electrode net is 256 rows, four orders of magnitude away from the file sizes §5
 * rule 3 exists for.)
 *
 * §7.4 fixes how it draws: "one instanced draw of a shared … VAO with per-instance origin … **No new
 * geometry from WASM**." The instance buffer is a GPU resource, so it lives in `derived/store.ts`
 * with the rest of them, keyed by layer id; this file owns the **pure** functions that decide what
 * goes in it, what a probe row says, and — since §13's point tool (2026-08-30) — which point a pane
 * pixel grabs, which is what lets all three be tested without a context.
 */

import { visibleIn } from './runtime';
import type {
  DrawItem,
  LayerRuntime,
  LayerRuntimeContext,
  PickItem,
  PointsDrawItem,
} from './runtime';
import { isColormapName, sampleColormap } from '../color/colormaps';
import type { ProbeRow } from '../api';
import type {
  Dataset,
  DatasetId,
  LayerId,
  mat4,
  PointsLayer,
  SliceView,
  vec3,
  vec4,
  View,
} from '../scene/types';
// §13's point tool (2026-08-30): the shader's disc rule, stated once in the overlay item that draws
// the ring (P1) and read here, so the hit test and the picture cannot disagree.
import { discRadiusPx } from '../overlay/point-ring';
import { slicePlane, worldToPane, worldToPane3D } from '../view/geometry';
import type { PaneSize } from '../view/geometry';

/** Floats per instance: `centre.xyz`, `colour.rgba`, `radiusMm`. */
export const POINT_INSTANCE_FLOATS = 8;

/**
 * Pack one layer's points into the instance array.
 *
 * Pure, so the packing is unit-tested without a GL context. The per-point colour and radius fall
 * back to the layer's, which is what makes a `.csv` of bare coordinates render at all.
 */
export function packPoints(layer: PointsLayer): Float32Array {
  const points = layer.points ?? [];
  const out = new Float32Array(points.length * POINT_INSTANCE_FLOATS);
  points.forEach((p, i) => {
    const c = p.color ?? valueColor(layer, p.value) ?? layer.color;
    const o = i * POINT_INSTANCE_FLOATS;
    out[o] = p.position[0];
    out[o + 1] = p.position[1];
    out[o + 2] = p.position[2];
    out[o + 3] = c[0];
    out[o + 4] = c[1];
    out[o + 5] = c[2];
    out[o + 6] = c[3];
    out[o + 7] = p.radiusMm ?? layer.radiusMm;
  });
  return out;
}

/**
 * `colorMode: 'value'` — the point's scalar through the layer's colormap (§7.6), or `null` when
 * the layer is in its default solid mode or the point has no value.
 *
 * On the CPU rather than in the shader on purpose. A points layer's instance buffer is eight
 * floats per point and a dense electrode net is 256 of them, so recolouring the whole layer is a
 * 8 KB upload — cheaper than the LUT texture, the extra uniform and the shader variant a GPU
 * colormap would need, and it keeps `packPoints` the single, testable definition of what a point
 * looks like.
 */
export function valueColor(layer: PointsLayer, value: number | undefined): vec4 | null {
  if (layer.valueMode !== 'value' || value === undefined) return null;
  const name = layer.colormap ?? 'viridis';
  if (!isColormapName(name)) return null;
  const lo = layer.valueRange?.lo ?? 0;
  const hi = layer.valueRange?.hi ?? 1;
  // A flat field (every SimNIBS net writes `{0}` for every electrode) has no gradient to show, so
  // it maps to the colormap's midpoint rather than dividing by zero.
  const t = hi > lo ? Math.min(1, Math.max(0, (value - lo) / (hi - lo))) : 0.5;
  const [r, g, b] = sampleColormap(name, t);
  return [r, g, b, layer.color[3]];
}

export interface NearestPoint {
  index: number;
  name?: string;
  distance: number;
}

/** The nearest point to `world` — §8's probe row for a points layer is a name, not a voxel. */
export function nearestPoint(layer: PointsLayer, world: vec3): NearestPoint | null {
  // `points` is defensive rather than trusting: a layer reaches a runtime through
  // `Engine.addLayer`'s `{ ...defaults, ...spec }` merge, and a caller may hand in a partial layer.
  const points = layer.points ?? [];
  let best: NearestPoint | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (p === undefined) continue;
    const distance = Math.hypot(
      p.position[0] - world[0],
      p.position[1] - world[1],
      p.position[2] - world[2]
    );
    if (best === null || distance < best.distance) best = { index: i, name: p.name, distance };
  }
  return best;
}

export class PointsLayerRuntime implements LayerRuntime {
  readonly kind = 'points' as const;
  readonly id: LayerId;
  readonly datasetId: DatasetId;

  #layer: PointsLayer;

  constructor(layer: PointsLayer, _ds: Dataset, _ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.id = layer.id;
    this.datasetId = layer.datasetId;
  }

  get layer(): PointsLayer {
    return this.#layer;
  }

  applyPatch(next: PointsLayer): void {
    this.#layer = next;
    // The instance buffer is keyed on the `points` array's identity in `derived/store.ts`, so a new
    // array re-uploads and the same array does not.
  }

  probeRow(world: vec3): ProbeRow {
    const row: ProbeRow = {
      layerId: this.#layer.id,
      layerName: this.#layer.name,
      kind: 'points',
    };
    const near = nearestPoint(this.#layer, world);
    // Only report a point the cursor is actually on: §8's rows describe what is under the crosshair,
    // not the nearest thing anywhere in the scene.
    if (near !== null && near.distance <= this.#layer.radiusMm) {
      row.labelName = near.name;
      row.labelId = near.index;
      row.value = near.distance;
    }
    return row;
  }

  refreshProbe(): void {}
  ensurePickGeometry(): void {}

  drawItems(view: View): DrawItem[] {
    if (!visibleIn(this.#layer, view) || (this.#layer.points ?? []).length === 0) return [];
    const item: PointsDrawItem = { kind: 'points', layer: this.#layer };
    return [item];
  }

  pickItems(): PickItem[] {
    // A points layer has no element id and no `ownerElm` texture, so it contributes nothing to the
    // §7.2.3 id target; `probeRow` is how a point is identified.
    return [];
  }

  dispose(): void {}
}

// ---------------------------------------------------------------------------------------------
// §13's point tool (2026-08-30): the CPU hit test a point-editing tool selects with.
//
// It is here, beside `packPoints` and `nearestPoint`, for the reason those two are: it is a pure
// function of a `PointsLayer` and a pane, and §11 asserts it without a GL context. The **disc rule
// it uses is not restated here** — `overlay/point-ring.ts` states the vertex shader's rule once
// (P1) and both the ring and this test read it, exactly as `gizmoHandleAt` reads the same
// `handlePoints` the gizmo is drawn from. A hit rule written twice is a hit rule that drifts away
// from the picture, and the picture is what the user is aiming at.
// ---------------------------------------------------------------------------------------------

/**
 * The shader's 2D disc rule, and the `dot` branch's constant radius — re-exported so a point tool
 * needs one import (§7.2, `overlay/point-ring.ts`).
 *
 * `discRadiusPx` is what `wave1-specs.md` calls `discRadius`; there is one function and one name.
 */
export { DOT_RADIUS_PX, discRadiusPx } from '../overlay/point-ring';
export type { DiscShape } from '../overlay/point-ring';

/**
 * The smallest grab radius in a 2D pane, in **pane pixels** — the floor under the disc's own.
 *
 * A 0.8 mm contact at 0.5 mm/px is a 3 px disc, and a 3 px target is not something a hand aims at.
 * Unscaled pane pixels rather than CSS pixels, like {@link HANDLE_HIT_PX} for the cut-plane gizmo:
 * the two grabbable things in the frame use one convention, and every §11 pane is DPR 1.
 */
export const POINT_HIT_MIN_PX = 8;
/**
 * The 3D pane's grab radius, in pane pixels — the gizmo's {@link HANDLE_HIT_PX} verbatim.
 *
 * A 3D hit is the projected centre and nothing else: a points layer contributes nothing to §7.2.3's
 * id target, and a billboard's *depth* is not something a CPU test can answer without one.
 */
export const POINT_HIT_3D_PX = 14;

/** Which point a pane pixel grabbed, and how big the disc it grabbed was (§11 asserts both). */
export interface PointPaneHit {
  index: number;
  /** Distance from the pointer to the point's projected centre, in pane pixels. */
  distancePx: number;
  /** The radius that point is actually drawn at in this pane — the disc rule's answer. */
  discPx: number;
}

/**
 * Everything a 2D hit test needs to know about the pane — `Engine.worldAtScreen`'s own inputs.
 *
 * A structural bag rather than the engine's internals so §11 builds one by hand: the whole point of
 * the function being pure is that a test can put a point at a known pane pixel and ask.
 */
export interface PanePlacement {
  view: SliceView;
  cursor: vec3;
  /** §3's in-plane origin — `planeAnchor(bounds)`, the same one `paneToWorld` is measured from. */
  anchor: vec3;
  radiological: boolean;
  rect: PaneSize;
  /** Device pixels per CSS pixel, as `DrawInput.uiScale` carries it. */
  uiScale: number;
}

/**
 * Which point of a points layer a **2D** pane pixel grabs, or `null` (§7.5's point tool).
 *
 * Three rules, and each of them is a decision:
 *
 * * **On-slice only.** The disc rule is asked with the ghost switched *off*
 *   (`offPlaneOpacity: 0`), so a point the slice does not cut is not hittable even on a layer that
 *   draws it as a ghost. A ghost is a projection of something on another slice; grabbing one and
 *   dragging it would move a contact the user cannot see, in a plane it is not in.
 * * **`max(disc, {@link POINT_HIT_MIN_PX})`.** The disc is the thing on screen, so it is the target;
 *   the floor is what makes a small contact grabbable at all.
 * * **Nearest wins.** At a 3.5 mm contact pitch two discs overlap at any useful zoom, and "the first
 *   one in the array" would hand the user whichever contact was imported first.
 *
 * `x`/`y` are pane-local **device** pixels, top-left origin — the convention every pointer event and
 * `worldAtScreen` already use.
 */
export function pointAtPane(
  layer: PointsLayer,
  place: PanePlacement,
  x: number,
  y: number,
  minHitPx = POINT_HIT_MIN_PX
): PointPaneHit | null {
  const points = layer.points ?? [];
  if (points.length === 0) return null;
  const plane = slicePlane(place.view, place.cursor);
  const mmPerPx = place.view.camera.mmPerPx;
  let best: PointPaneHit | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (p === undefined) continue;
    const radiusMm = p.radiusMm ?? layer.radiusMm;
    const d =
      plane.normal[0] * p.position[0] +
      plane.normal[1] * p.position[1] +
      plane.normal[2] * p.position[2] +
      plane.offset;
    // `offPlaneOpacity: 0` is the whole of "ghosts never hit": with it, `discRadiusPx` returns
    // `null` for exactly the points §7.2's shader culls when the layer is not ghosting.
    const discPx = discRadiusPx(
      { shape: layer.shape, radiusMm, offPlaneOpacity: 0 },
      radiusMm,
      d,
      mmPerPx,
      place.uiScale
    );
    if (discPx === null) continue;
    const [sx, sy] = worldToPane(
      place.view,
      place.cursor,
      place.anchor,
      place.radiological,
      place.rect,
      p.position
    );
    const distancePx = Math.hypot(sx - x, sy - y);
    if (distancePx > Math.max(discPx, minHitPx)) continue;
    if (best === null || distancePx < best.distancePx) best = { index: i, distancePx, discPx };
  }
  return best;
}

/**
 * The **3D** pane's half: the nearest projected centre within {@link POINT_HIT_3D_PX}, or `null`.
 *
 * No depth, deliberately — the same shape as `gizmoHandleAt`, and for the same reason. Points are
 * not in §7.2.3's id target (`pickItems()` is empty), so the only honest CPU answer is "which
 * centre is nearest on screen"; a hemisphere hidden behind the head is a v2 problem that needs a
 * points `PickItem` and a frozen `elementKind` change.
 */
export function pointAtPane3D(
  layer: PointsLayer,
  viewProj: mat4,
  rect: PaneSize,
  x: number,
  y: number,
  hitPx = POINT_HIT_3D_PX
): PointPaneHit | null {
  const points = layer.points ?? [];
  let best: PointPaneHit | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (p === undefined) continue;
    const projected = worldToPane3D(viewProj, rect, p.position);
    if (projected === null) continue;
    const distancePx = Math.hypot(projected[0] - x, projected[1] - y);
    if (distancePx > hitPx) continue;
    if (best === null || distancePx < best.distancePx) {
      best = { index: i, distancePx, discPx: hitPx };
    }
  }
  return best;
}

/**
 * The id of one point, as a tool addresses it — `points[].id`, or the `p<index>` the engine would
 * mint for a layer that has none (§4.4).
 *
 * One function so the fallback is spelled once: `Engine.setPointTool` materialises these ids into
 * the layer when it arms, and a hit test that ran before that must name the same point.
 */
export function pointIdAt(layer: PointsLayer, index: number): string {
  return layer.points?.[index]?.id ?? `p${index}`;
}
