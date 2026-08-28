/**
 * The `volume` layer runtime — §7.3's side of the scene, **complete** (Phase 2, owner E-SLICE).
 *
 * What lives here rather than in a pass or in `engine.ts`:
 *
 * * **Which draws exist.** One per (layer, plane): the pane's own plane in a 2D view, and *every*
 *   `SliceView` plane in a 3D view when `showIn3D` is on (§7.2 pass 1).
 * * **The label palette.** `visibleLabels`, `labelOpacity` and per-label recolour are folded into an
 *   `N × 1 RGBA8` texture rather than branched on in the shader, so hiding one label changes exactly
 *   one texel and leaves every other pixel of the frame byte-identical — which is R5's gate
 *   assertion, held by construction rather than by care.
 * * **The 4D index.** Changing `volumeIndex` is a `volumeFrame` op (§6.5.2), a texture under a new
 *   `volumeKey`, and a new `Stats`. Audit P2-05: `,`/`.` was bound with no texture behind it, so a
 *   4D volume's layer silently stopped drawing at index 1.
 *
 * It never draws and never parses (`layers/runtime.ts`'s rules).
 */

import { labelStyleKey, volumeKey } from '../render/gpu';
import type { LabelStyleGpu } from '../render/gpu';
import { visibleIn } from './runtime';
import type {
  DrawItem,
  LayerRuntime,
  LayerRuntimeContext,
  PickItem,
  VolumeDrawItem,
  VolumePickItem,
} from './runtime';
import { statsFromWire } from '../scene/fromMeta';
import { isSliceView } from '../scene/store';
import { worldToVoxel } from '../view/geometry';
import type { ProbeRow } from '../api';
import type {
  DatasetId,
  LabelTable,
  LayerId,
  Stats,
  vec3,
  vec4,
  View,
  VolumeDataset,
  VolumeLayer,
} from '../scene/types';

export class VolumeLayerRuntime implements LayerRuntime {
  readonly kind = 'volume' as const;
  readonly id: LayerId;
  readonly datasetId: DatasetId;

  #layer: VolumeLayer;
  readonly #ds: VolumeDataset;
  readonly #ctx: LayerRuntimeContext;

  /**
   * Per-4D-frame state, seeded with what `loadVolume` already delivered for frame 0.
   *
   * `VolumeMeta.stats` and `VolumeMeta.gpu` are volume 0's by contract (§6.5.1), and a 4D label
   * volume's dense index remap is per frame too, so all of it is kept per index rather than read off
   * the dataset.
   */
  readonly #frameStats = new Map<number, Stats>();
  readonly #frameLabelIds = new Map<number, Uint32Array | undefined>();
  /** Frames a `volumeFrame` op is already in flight for, so a key-repeat on `.` issues one each. */
  readonly #framesRequested = new Set<number>();

  /** What the currently uploaded label style was built from; `null` when nothing is uploaded. */
  #styleSignature: string | null = null;

  constructor(layer: VolumeLayer, ds: VolumeDataset, ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.#ds = ds;
    this.#ctx = ctx;
    this.id = layer.id;
    this.datasetId = ds.id;
    this.#frameStats.set(0, ds.stats);
    this.#frameLabelIds.set(0, ds.labelIds);
    this.#refreshLabelStyle();
  }

  get layer(): VolumeLayer {
    return this.#layer;
  }

  /**
   * The `Stats` of the frame this layer currently displays (§8's colour bar and histogram).
   *
   * `VolumeDataset.stats` is volume 0's; at 4D index k it is the wrong distribution, so the colour
   * bar's ticks and the histogram's bins have to come from here.
   */
  get stats(): Stats {
    return this.#frameStats.get(this.#layer.volumeIndex) ?? this.#ds.stats;
  }

  applyPatch(next: VolumeLayer): void {
    const prev = this.#layer;
    this.#layer = next;
    if (next.volumeIndex !== prev.volumeIndex) this.#ensureFrame();
    this.#refreshLabelStyle();
  }

  // -----------------------------------------------------------------------------------------
  // R5 — region select / mute / recolour
  // -----------------------------------------------------------------------------------------

  /**
   * R5: the selected labels get the emphasis rim. Ids, not dense indices — the panel speaks ids.
   *
   * Read straight off `VolumeLayer.selectedLabels` (§4.4, added by the Phase-2 integrator) rather
   * than held here, so a selection arrives through `updateLayer` like every other layer edit and
   * survives `serialize()` / `load()`, which is R5's last gate clause.
   */
  get selectedLabels(): Uint32Array {
    return Uint32Array.from(this.#layer.selectedLabels ?? []);
  }

  /**
   * Rebuild this layer's palette because something it is built from changed.
   *
   * Called by the facade after a recolour, since label **colour** lives in the dataset's
   * `LabelTable` — it is what a LUT file holds and what §8's "Save LUT…" writes back — and is
   * therefore shared by every layer on that atlas, while visibility and opacity are per layer (§4.4).
   */
  invalidateLabelStyle(): void {
    this.#styleSignature = null;
    this.#refreshLabelStyle();
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
    const layer = this.#layer;
    if (!visibleIn(layer, view)) return [];
    const gpu = this.#ctx.gpu.volume(volumeKey(layer));
    if (gpu === undefined) {
      // The 4D frame this layer wants is not on the GPU yet. Ask for it — audit P2-05: without this
      // the layer silently stops drawing at index > 0 instead of catching up a frame later.
      this.#ensureFrame();
      return [];
    }
    const labelStyle = this.#labelStyle();
    if (isSliceView(view)) {
      const item: VolumeDrawItem = { kind: 'volume', layer, ds: this.#ds, gpu, labelStyle };
      return [item];
    }
    // §7.2 pass 1 in a 3D pane: "the plane of each `SliceView` whose owning volume layer has
    // `showIn3D`". One item per plane, all drawn from the same shared quad (§7.3), so their depth is
    // bit-identical and `LEQUAL` lets every layer of one plane through.
    if (!layer.showIn3D) return [];
    return this.#ctx.slicePlanes().map((plane): VolumeDrawItem => ({
      kind: 'volume',
      layer,
      ds: this.#ds,
      gpu,
      plane,
      labelStyle,
    }));
  }

  /**
   * §7.2.3: "Volume slice quads participate (`elementKind: 'slice'`, `elementId` = plane index)".
   *
   * The visibility rule here is the **pick** one, not the draw one — the pass applies `pickableIn`
   * before asking, and `layerVisibility` deliberately does not gate picking, exactly as Phase 1
   * behaved. The GPU handles ride along because the pick pass must reproduce every discard the frame
   * made, and for a label slice that means this layer's palette and its outline mode.
   */
  pickItems(view: View): PickItem[] {
    const gpu = this.#ctx.gpu.volume(volumeKey(this.#layer));
    if (gpu === undefined) return [];
    const labelStyle = this.#labelStyle();
    const base = { kind: 'volume', layer: this.#layer, ds: this.#ds, gpu, labelStyle } as const;
    if (isSliceView(view)) return [base satisfies VolumePickItem];
    // §7.2.3: "double-clicking a slice plane in the 3D view is the primary Freeview gesture" — which
    // only means anything once the plane is *in* the 3D view, i.e. once `showIn3D` is on. Each plane
    // is its own pick item so the returned `elementId` is that plane's index.
    if (!this.#layer.showIn3D) return [];
    return this.#ctx.slicePlanes().map((plane): VolumePickItem => ({ ...base, plane }));
  }

  /** Volume textures are keyed by dataset; the label styling is keyed by **layer** and goes here. */
  dispose(): void {
    this.#ctx.gpu.dropLabelStyles(this.id);
  }

  // -----------------------------------------------------------------------------------------
  // 4D — the `volumeFrame` op (§6.5.2), audit P2-05
  // -----------------------------------------------------------------------------------------

  /**
   * Make sure the current `volumeIndex` has a texture, fetching the frame if it does not.
   *
   * Latest-wins on `` `${layerId}:volumeFrame` ``: holding `.` down queues one request per repeat and
   * every queued loser is dropped, so a fast sweep costs one round trip per landed frame rather than
   * one per key event (§5 rule 6).
   */
  #ensureFrame(): void {
    const layer = this.#layer;
    const index = layer.volumeIndex;
    const key = volumeKey(layer);
    if (this.#ctx.gpu.hasVolume(key) || this.#framesRequested.has(index)) return;
    if (index <= 0 || index >= this.#ds.nvols) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    this.#framesRequested.add(index);
    const req = client.call(`${this.id}:volumeFrame`, 'volumeFrame', {
      handle: this.#ds.handle,
      volumeIndex: index,
      caps: this.#ctx.gpuCaps(),
      // §6.1: rows 1-2 (the NEAREST label rows) are gated on `!want_linear`, exactly as `loadVolume`
      // asks at load time. Asking for `true` here would turn a label volume's frame 1 into a
      // filterable R8 grey ramp while frame 0 stayed R8UI + palette.
      wantLinear: false,
    });
    void this.#ctx.track(
      req.then(
        (frame) => {
          this.#framesRequested.delete(index);
          // §4.1's one conversion point rule: the wire's `StatsT` (percentiles as a 9-array)
          // becomes §4.2's `Stats` in `scene/fromMeta.ts` and nowhere else.
          this.#frameStats.set(frame.volumeIndex, statsFromWire(frame.stats));
          this.#frameLabelIds.set(frame.volumeIndex, frame.labelIds);
          this.#ctx.gpu.uploadVolume(
            `${this.datasetId}|${frame.volumeIndex}`,
            this.#ds,
            frame.gpuBytes,
            frame.gpu,
            !this.#ds.isLabel,
            buildLabelPalette(this.#ds, frame.labelIds)
          );
          // A new frame is a new dense remap, so this layer's styling is rebuilt against it.
          this.#styleSignature = null;
          this.#refreshLabelStyle();
          this.#ctx.requestRender();
        },
        () => {
          // A dropped latest-wins loser rejects by design (§5 rule 6); the winner still lands.
          this.#framesRequested.delete(index);
        }
      )
    );
  }

  // -----------------------------------------------------------------------------------------
  // Label styling
  // -----------------------------------------------------------------------------------------

  #labelStyle(): LabelStyleGpu | undefined {
    return this.#ctx.gpu.labelStyle(labelStyleKey(this.id, this.#layer.volumeIndex));
  }

  /**
   * Rebuild the palette + selection textures when — and only when — their inputs changed.
   *
   * The signature is the whole input, so an `updateLayer` that touched `opacity` or `labelMode` does
   * not re-upload two textures, and one that touched `visibleLabels` does.
   */
  #refreshLabelStyle(): void {
    const ds = this.#ds;
    const layer = this.#layer;
    if (!ds.isLabel) return;
    const labelIds = this.#frameLabelIds.get(layer.volumeIndex);
    if (labelIds === undefined) return;
    const signature = labelStyleSignature(ds.labelTable, layer, this.selectedLabels);
    if (signature === this.#styleSignature) return;
    const palette = buildLabelPalette(ds, labelIds, {
      visibleLabels: layer.visibleLabels,
      labelOpacity: layer.labelOpacity,
      labelColors: layer.labelColors,
    });
    if (palette === null) return;
    this.#ctx.gpu.uploadLabelStyle(
      labelStyleKey(this.id, layer.volumeIndex),
      palette,
      buildLabelAttrs(labelIds, this.selectedLabels)
    );
    this.#styleSignature = signature;
    this.#ctx.requestRender();
  }
}

/**
 * Everything the uploaded label style is a function of, as one string.
 *
 * `labelTable` is in it because label **colour** lives on the dataset (§7.6: a LUT file describes the
 * atlas, not one view of it), so a recolour has to invalidate every layer that draws that atlas.
 */
function labelStyleSignature(
  table: LabelTable | undefined,
  layer: VolumeLayer,
  selected: Uint32Array
): string {
  const colors = table?.entries.map((e) => `${e.id}:${e.color.join(',')}`).join('|') ?? '';
  const overrides =
    layer.labelColors === undefined
      ? ''
      : Object.entries(layer.labelColors)
          .map(([k, v]) => `${k}=${v.join(',')}`)
          .sort()
          .join('|');
  const visible = layer.visibleLabels === undefined ? '*' : [...layer.visibleLabels].join(',');
  const opacity =
    layer.labelOpacity === undefined
      ? ''
      : Object.entries(layer.labelOpacity)
          .map(([k, v]) => `${k}=${v}`)
          .sort()
          .join(',');
  return `${layer.volumeIndex}#${colors}#${overrides}#${visible}#${opacity}#${[...selected].join(',')}`;
}

/** Options a layer folds into its palette rather than branching on in the shader. */
export interface LabelPaletteStyle {
  /** §4.4: `undefined` = every label visible. A hidden label becomes `A = 0`. */
  visibleLabels?: Uint32Array;
  /** §4.4: per-label multiplier on the palette's alpha, keyed by **label id**, not dense index. */
  labelOpacity?: Record<number, number>;
  /**
   * §4.4's `VolumeLayer.labelColors`: R5's colour picker, keyed by **label id**.
   *
   * It beats the dataset's `LabelTable`, and it is the *only* place an edit is written: the table
   * keeps the file's own colours, so a per-row Reset is deleting a key rather than re-reading a LUT,
   * and §4.6 round-trips the edit because the layer is serialised and the table is not.
   */
  labelColors?: Record<number, vec4>;
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
 * `style` is R5's mute half: `visibleLabels` zeroes a label's alpha and `labelOpacity` scales it, so
 * the shader needs no branch and no second texture read, and hiding one region changes exactly four
 * bytes of the frame's inputs.
 *
 * Returns `null` for a non-label volume, which is what tells `GpuStore` there is no palette texture.
 */
export function buildLabelPalette(
  ds: VolumeDataset,
  labelIds: Uint32Array | undefined,
  style: LabelPaletteStyle = {}
): Uint8Array | null {
  if (!ds.isLabel || labelIds === undefined) return null;
  const visible = style.visibleLabels === undefined ? null : new Set(style.visibleLabels);
  const palette = new Uint8Array(labelIds.length * 4);
  for (let k = 0; k < labelIds.length; k += 1) {
    const labelId = labelIds[k] ?? 0;
    const entry = ds.labelTable?.byId.get(labelId);
    const c =
      style.labelColors?.[labelId] ??
      entry?.color ??
      (labelId === 0 ? ([0, 0, 0, 0] as const) : fallbackLabelColor(k));
    const hidden = visible !== null && !visible.has(labelId);
    const opacity = hidden ? 0 : (style.labelOpacity?.[labelId] ?? 1);
    palette[k * 4] = Math.round(c[0] * 255);
    palette[k * 4 + 1] = Math.round(c[1] * 255);
    palette[k * 4 + 2] = Math.round(c[2] * 255);
    palette[k * 4 + 3] = Math.round(c[3] * 255 * Math.max(0, Math.min(1, opacity)));
  }
  return palette;
}

/**
 * R5's selection table: `N × 1 RGBA8`, `R = 255` for a selected label, indexed by dense index.
 *
 * A texture rather than a uniform array because a selection can be any subset of up to 65535 labels,
 * and ESSL 3.00 cannot index a uniform array of that size dynamically — the same reason §7.3 does not
 * put the palette in one.
 */
export function buildLabelAttrs(labelIds: Uint32Array, selected: Uint32Array): Uint8Array {
  const set = new Set(selected);
  const attrs = new Uint8Array(labelIds.length * 4);
  for (let k = 0; k < labelIds.length; k += 1) {
    attrs[k * 4] = set.has(labelIds[k] ?? 0) ? 255 : 0;
  }
  return attrs;
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
