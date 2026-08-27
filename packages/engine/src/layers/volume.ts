/**
 * The `volume` layer runtime — §7.3's side of the scene.
 *
 * Phase 1's scope: enumerate one slice draw per (layer, plane), resolve probe values on the UI
 * thread from the retained typed array, and let the slice quad participate in picking.
 *
 * **Phase 2 (owner: E-SLICE) extends this file**, not `engine.ts`: `Scale` including `heat`,
 * threshold with `softEdge`, label fill/outline/both over the dense index remap, `visibleLabels` /
 * `labelOpacity`, `showIn3D` planes, and the 4D index over the `volumeFrame` op — which is the one
 * that needs new state here, because `volumeKey` selects a texture per `volumeIndex` and today only
 * index 0 is ever uploaded.
 */

import { volumeKey } from '../render/gpu';
import { visibleIn } from './runtime';
import type {
  DrawItem,
  LayerRuntime,
  LayerRuntimeContext,
  PickItem,
  VolumeDrawItem,
  VolumePickItem,
} from './runtime';
import { isSliceView } from '../scene/store';
import { worldToVoxel } from '../view/geometry';
import type { ProbeRow } from '../api';
import type { DatasetId, LayerId, vec3, View, VolumeDataset, VolumeLayer } from '../scene/types';

export class VolumeLayerRuntime implements LayerRuntime {
  readonly kind = 'volume' as const;
  readonly id: LayerId;
  readonly datasetId: DatasetId;

  #layer: VolumeLayer;
  readonly #ds: VolumeDataset;
  readonly #ctx: LayerRuntimeContext;

  constructor(layer: VolumeLayer, ds: VolumeDataset, ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.#ds = ds;
    this.#ctx = ctx;
    this.id = layer.id;
    this.datasetId = ds.id;
  }

  get layer(): VolumeLayer {
    return this.#layer;
  }

  applyPatch(next: VolumeLayer): void {
    this.#layer = next;
    // PHASE 2 (E-SLICE): a changed `volumeIndex` is a `volumeFrame` op plus an upload under the new
    // `volumeKey`, and a changed 4D frame brings new `Stats` for the colour bar and the histogram.
  }

  /**
   * §8's "volume values resolve on the UI thread from the retained typed array (zero latency)".
   *
   * `VolumeDataset.data` is the array §4.3 keeps here for exactly this, and §5 rule 2 is why it is
   * never put in a transfer list: detaching it breaks every probe after the first.
   */
  probeRow(world: vec3): ProbeRow {
    const layer = this.#layer;
    const ds = this.#ds;
    const base: ProbeRow = { layerId: layer.id, layerName: layer.name, kind: 'volume' };
    const v = worldToVoxel(ds, world);
    const i = Math.round(v[0]);
    const j = Math.round(v[1]);
    const k = Math.round(v[2]);
    if (i < 0 || j < 0 || k < 0 || i >= ds.dims[0] || j >= ds.dims[1] || k >= ds.dims[2]) {
      return base;
    }
    const idx =
      (k * ds.dims[1] + j) * ds.dims[0] +
      i +
      layer.volumeIndex * ds.dims[0] * ds.dims[1] * ds.dims[2];
    const raw = Number(ds.data[idx] ?? 0);
    const value = raw * ds.sclSlope + ds.sclInter;
    const row: ProbeRow = { ...base, voxel: [i, j, k], value };
    if (ds.isLabel) {
      row.labelId = Math.round(value);
      row.labelName = ds.labelTable?.byId.get(row.labelId)?.name;
    }
    return row;
  }

  /** Nothing asynchronous to refresh: {@link probeRow} is already exact and synchronous. */
  refreshProbe(): void {}

  /** The slice quad needs no extra geometry — the pick pass draws the same quad the frame did. */
  ensurePickGeometry(): void {}

  drawItems(view: View): DrawItem[] {
    // §7.3's `showIn3D` planes are Phase 2's; in Phase 1 a volume layer draws only in 2D panes.
    if (!isSliceView(view) || !visibleIn(this.#layer, view)) return [];
    const gpu = this.#ctx.gpu.volume(volumeKey(this.#layer));
    if (gpu === undefined) return [];
    const item: VolumeDrawItem = { kind: 'volume', layer: this.#layer, ds: this.#ds, gpu };
    return [item];
  }

  /**
   * §7.2.3: "Volume slice quads participate (`elementKind: 'slice'`, `elementId` = plane index)".
   *
   * The visibility rule here is the **pick** one, not the draw one — the pass applies
   * `pickableIn` before asking, and `layerVisibility` deliberately does not gate picking, exactly as
   * Phase 1 behaved.
   */
  pickItems(view: View): PickItem[] {
    if (!isSliceView(view)) return [];
    if (this.#ctx.gpu.volume(volumeKey(this.#layer)) === undefined) return [];
    const item: VolumePickItem = { kind: 'volume', layer: this.#layer, ds: this.#ds };
    return [item];
  }

  /** Volume textures are keyed by dataset and released by `GpuStore.dropVolume`. */
  dispose(): void {}
}

/**
 * §7.3's label palette: an `N × 1 RGBA8` texture indexed by the **dense** index.
 *
 * `labelIds` is §6.1's `LabelIndex.ids` — the remap in dense order — so `palette[k]` is the colour of
 * `ids[k]`, with **no offset**. An off-by-one here paints every region with its neighbour's colour,
 * which looks plausible and is wrong.
 *
 * Background is decided by **alpha**, not by index: SimNIBS and FreeSurfer LUTs give id 0
 * ("Unknown") `A = 0`, and the shader discards a zero-alpha palette entry. Only when there is no
 * table at all does the engine impose the convention that id 0 is background.
 *
 * Returns `null` for a non-label volume, which is what tells `GpuStore` there is no palette texture.
 */
export function buildLabelPalette(
  ds: VolumeDataset,
  labelIds: Uint32Array | undefined
): Uint8Array | null {
  if (!ds.isLabel || labelIds === undefined) return null;
  const palette = new Uint8Array(labelIds.length * 4);
  for (let k = 0; k < labelIds.length; k += 1) {
    const labelId = labelIds[k] ?? 0;
    const entry = ds.labelTable?.byId.get(labelId);
    const c = entry?.color ?? (labelId === 0 ? ([0, 0, 0, 0] as const) : fallbackLabelColor(k));
    palette[k * 4] = Math.round(c[0] * 255);
    palette[k * 4 + 1] = Math.round(c[1] * 255);
    palette[k * 4 + 2] = Math.round(c[2] * 255);
    palette[k * 4 + 3] = Math.round(c[3] * 255);
  }
  return palette;
}

/** Deterministic fallback colour for a label the LUT does not name (§7.6's glasbey-like palette). */
export function fallbackLabelColor(i: number): [number, number, number, number] {
  // Golden-ratio hue rotation: maximally separated hues for any prefix length, no table, no RNG.
  const h = (i * 0.618033988749895) % 1;
  const s = 0.55 + (i % 3) * 0.15;
  const v = 0.75 + (i % 2) * 0.2;
  const k = (n: number): number => (n + h * 6) % 6;
  const f = (n: number): number => v - v * s * Math.max(0, Math.min(Math.min(k(n), 4 - k(n)), 1));
  return [f(5), f(3), f(1), 1];
}
