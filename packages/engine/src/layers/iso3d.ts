/**
 * **The volume layer's 3D surface** — §4.4's `VolumeLayer.iso3d` (directed task 2, 2026-08-28).
 *
 * The maintainer's ask was "render isosurfaces of NIfTI in the 3D viewer". Almost none of that is new
 * machinery: `marchingCubes` has existed since Phase 1, `layers/iso.ts` already owns that op with
 * latest-wins and a `GpuStore` cache, and §7.2 already draws an `IsoDrawItem`. What was missing was an
 * *owner*. A user who wants the surface of the T1 they are already looking at should not have to add a
 * second layer, point it back at the same dataset, and then keep the two in step by hand — and if they
 * did, nothing would keep the surface on the 4D frame the volume is showing, or on the regions the
 * region panel just hid. (One op **was** added: label volumes needed `marchingCubesLabel`, for the
 * reason below.)
 *
 * So the volume layer owns it. This module is the derivation, and it is **pure**: given the layer and
 * its dataset it returns the `IsosurfaceLayer`s that layer implies, and the engine reconciles one
 * `IsoLayerRuntime` per returned layer. Everything the ownership promises falls out of that:
 *
 * | promise | what makes it true |
 * |---|---|
 * | follows the 4D frame | `source.volumeIndex` is the volume layer's `volumeIndex` |
 * | follows visibility | `visible` is `layer.visible && iso3d.enabled` |
 * | follows region visibility / recolour | the label case reads `visibleLabels` / `selectedLabels` / `labelColors` on every derivation |
 * | removed with the volume | the runtimes are keyed by the volume layer's id and dropped with it |
 * | latest-wins on a slider drag | `IsoLayerRuntime` already is (§5 rule 6) |
 *
 * **Why a region is its own op, not a level.** A label volume's samples are the ids themselves, so
 * the level set `value ≥ k − 0.5` is the **union of every id at or above `k`** — which is region `k`
 * only if the ids nest, and SimNIBS's do not (`final_tissues` is 1 WM, 2 GM, 3 CSF, 5 scalp,
 * 7 compact bone … `[DATA]`, and 4 is absent). Levelling a label volume gives a plausible-looking
 * head that is not the tissue asked for; measured on `final_tissues`, "compact bone" at 6.5 came
 * back as the whole outer head. So a region is isolated **at the sample**: §6.5.2's
 * `marchingCubesLabel` reads the volume through `value == label ? 1 : 0` and marches at 0.5.
 * `IsosurfaceLayer.source.label` is what selects that op, and `iso` is unread when it is set.
 */

import { IsoLayerRuntime } from './iso';
import type { DrawItem, LayerRuntimeContext } from './runtime';
import { isSliceView } from '../scene/store';
import type {
  IsosurfaceLayer,
  LabelTable,
  VolumeDataset,
  VolumeIso3d,
  VolumeLayer,
  vec4,
  View,
} from '../scene/types';

/** Where the p95 default comes from, named once so the UI and the engine cannot disagree. */
export const ISO3D_DEFAULT_PERCENTILE = '95' as const;

const DEFAULT_ISO3D_COLOR: vec4 = [0.85, 0.78, 0.72, 1];

/**
 * The settings the **3D surface** switch turns on with.
 *
 * `iso` is the volume's p95 for a scalar volume (directed task 2), and is unused for a label volume,
 * where each region is its own surface.
 *
 * p95 rather than the midpoint of `[min, max]` because `m2m_ernie/T1.nii.gz` runs to exactly 65535.0
 * `[DATA]` — a midpoint default is an empty surface, and a slider anchored on it is useless. What p95
 * actually finds is worth stating plainly: measured on that file it is **15991.17**, against a median
 * of −0.78, because a head volume is mostly background — so it lands up the tissue histogram rather
 * than on the scalp rind. It is a level that reliably finds *something* on an arbitrary scalar volume,
 * not a scalp preset; a scalp preset would need the histogram's first tissue mode.
 */
export function defaultIso3d(ds: VolumeDataset): VolumeIso3d {
  const p95 = ds.stats.percentiles[ISO3D_DEFAULT_PERCENTILE];
  const iso = Number.isFinite(p95) ? p95 : (ds.stats.min + ds.stats.max) / 2;
  return {
    enabled: true,
    iso,
    color: [...DEFAULT_ISO3D_COLOR] as vec4,
    opacity: 1,
    smooth: true,
    faceMode: 'both',
  };
}

/** The id of one derived surface: the volume layer's id, and the region's when there is one. */
export function iso3dLayerId(volumeLayerId: string, label?: number): string {
  return label === undefined ? `${volumeLayerId}#iso3d` : `${volumeLayerId}#iso3d:${label}`;
}

/** The regions a label volume's 3D surface covers: the visible ones, narrowed to a selection. */
export function iso3dLabels(layer: VolumeLayer, ds: VolumeDataset): number[] {
  const ids = ds.labelIds;
  if (ids === undefined) return [];
  const visible = layer.visibleLabels;
  const visibleSet = visible === undefined ? null : new Set(visible);
  // A selection narrows; an empty selection is "no narrowing", not "nothing", because that is what
  // the region panel's own emphasis means and a cleared selection must not empty the 3D view.
  const selected = layer.selectedLabels;
  const selectedSet = selected !== undefined && selected.length > 0 ? new Set(selected) : null;
  const out: number[] = [];
  for (const id of ids) {
    // Label 0 is background in every LUT the reference data ships; its surface is the bounding box.
    if (id === 0) continue;
    if (visibleSet !== null && !visibleSet.has(id)) continue;
    if (selectedSet !== null && !selectedSet.has(id)) continue;
    out.push(id);
  }
  return out;
}

/** A region's colour: the layer's override first, then the dataset's LUT, then mid grey. */
export function iso3dLabelColor(
  layer: VolumeLayer,
  table: LabelTable | undefined,
  id: number
): vec4 {
  const override = layer.labelColors?.[id];
  if (override !== undefined) return override;
  const entry = table?.byId.get(id);
  if (entry !== undefined) return entry.color;
  return [0.6, 0.6, 0.6, 1];
}

/**
 * The `IsosurfaceLayer`s a volume layer implies — `[]` when it has no `iso3d`, or it is off.
 *
 * The returned layers are **derived, never stored**: they are not in `Scene.layers`, they are not in
 * a `ViewSpec`, and the only thing persisted is the `iso3d` block they were computed from. Deriving
 * them afresh on every reconcile is what keeps them in step with the volume for free.
 */
export function derivedIsoLayers(layer: VolumeLayer, ds: VolumeDataset): IsosurfaceLayer[] {
  const spec = layer.iso3d;
  if (spec === undefined || !spec.enabled) return [];
  const common = {
    kind: 'iso' as const,
    datasetId: layer.datasetId,
    visible: layer.visible,
    opacity: spec.opacity,
    // §7.2.3 keeps isosurfaces out of the pick target (`layers/iso.ts`), and a derived surface has
    // even less identity to report than a standalone one.
    pickable: false,
    showColorbar: false,
    smooth: spec.smooth,
    faceMode: spec.faceMode,
  };
  if (!ds.isLabel) {
    return [
      {
        ...common,
        id: iso3dLayerId(layer.id),
        name: `${layer.name} · surface`,
        source: { datasetId: layer.datasetId, volumeIndex: layer.volumeIndex },
        iso: spec.iso,
        color: spec.color,
      },
    ];
  }
  return iso3dLabels(layer, ds).map((id) => ({
    ...common,
    id: iso3dLayerId(layer.id, id),
    name: `${ds.labelTable?.byId.get(id)?.name ?? `label ${id}`} · surface`,
    // `source.label` is what makes this the region's **own** boundary rather than a level set of the
    // ids; `iso` is unread on this path and carries the level only for a reader's benefit.
    source: { datasetId: layer.datasetId, volumeIndex: layer.volumeIndex, label: id },
    iso: 0.5,
    color: iso3dLabelColor(layer, ds.labelTable, id),
  }));
}

/**
 * The runtime of one derived surface: `IsoLayerRuntime`, restricted to the **3D** panes.
 *
 * Task 2 is "isosurfaces in the 3D pane". A slice pane already draws the volume itself, and drawing
 * the surface's cross-section over it would be a second, differently-thresholded copy of the same
 * data; §7.4's `contoursIn2D` is the control that exists for that and it belongs to mesh layers.
 * Everything else — the op, latest-wins, the cache key, the draw item — is inherited unchanged.
 */
export class Iso3dLayerRuntime extends IsoLayerRuntime {
  readonly #notify: () => void;
  /**
   * The `loading` value the owner has already been told about.
   *
   * Remembered rather than sampled either side of the `super` call, because the **completion** edge
   * happens in the op's `then` — the base clears its in-flight key there and asks for a render — so
   * by the time the next `drawItems` runs, both samples read `false` and the edge is invisible. The
   * progress bar then sticks at "building" forever with the surface already on screen.
   */
  #notified = false;

  constructor(
    layer: IsosurfaceLayer,
    ds: VolumeDataset,
    ctx: LayerRuntimeContext,
    notify: () => void
  ) {
    super(layer, ds, ctx);
    this.#notify = notify;
  }

  /**
   * The 3D restriction, and the one place a `loading` edge can be observed.
   *
   * The base runtime issues its op from `drawItems` and clears the flag from the op's `then`, and
   * that `then` asks for a render — so every change of "is this surface building?" is observable
   * **here**, on the frame after it happens, by comparing against what the owner was last told
   * ({@link Iso3dLayerRuntime.#notified}). That is what lets the engine emit a `layers` event and §8
   * draw a load card, without the base runtime — which nothing else needs this for — growing a
   * callback.
   */
  override drawItems(view: View): DrawItem[] {
    if (isSliceView(view)) return [];
    const items = super.drawItems(view);
    if (this.loading !== this.#notified) {
      this.#notified = this.loading;
      this.#notify();
    }
    return items;
  }
}

/** One derived surface's runtime, ready for the engine's reconcile. */
export function createIso3dRuntime(
  layer: IsosurfaceLayer,
  ds: VolumeDataset,
  ctx: LayerRuntimeContext,
  notify: () => void
): Iso3dLayerRuntime {
  return new Iso3dLayerRuntime(layer, ds, ctx, notify);
}
