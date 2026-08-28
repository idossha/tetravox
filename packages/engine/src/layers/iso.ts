/**
 * The `iso` layer runtime — §4.4's `IsosurfaceLayer`, the engine half of marching cubes / tets.
 *
 * The `tvx-geom` half landed in Phase 1 with an analytic-sphere test, and §6.5.2 already exposes it
 * as two ops. This runtime's whole job is therefore **owning the op and its cache**:
 *
 * * a volume source issues `marchingCubes` on `(volumeIndex, iso, smooth)`;
 * * a mesh source issues `marchingTets` on `(field, component, iso)`;
 * * both come back as a `SurfacePayload` — the same shape `surface` / `boundary` return — so the
 *   result uploads through `GpuStore.uploadSurface` and draws through the §7.4 mesh program with no
 *   new geometry path at all.
 *
 * **Latest-wins on `iso:<layerId>`** (§5 rule 6): dragging an isovalue slider replaces its own
 * pending request rather than queueing one surface per pixel of travel. The request is `track`ed, so
 * `whenSettled()` — and therefore every golden — waits for it (§7.2).
 *
 * `source.datasetId` is the dataset the surface is computed *from*; `layer.datasetId` is the one the
 * layer hangs off. They are the same by construction (`scene/defaults.ts` seeds them together), and
 * this runtime uses the layer's, because that is the handle the registry gave it.
 */

import { visibleIn } from './runtime';
import type { DrawItem, IsoDrawItem, LayerRuntime, LayerRuntimeContext, PickItem } from './runtime';
import type { ProbeRow } from '../api';
import type { ComponentSel } from '@tetravox/protocol';
import type {
  Dataset,
  DatasetId,
  IsosurfaceLayer,
  LayerId,
  MeshDataset,
  vec3,
  View,
  VolumeDataset,
} from '../scene/types';

/** The `GpuStore` key of one isosurface: its inputs, so a changed isovalue is a different surface. */
export function isoKey(layer: IsosurfaceLayer): string {
  const f = layer.source.field;
  const field = f === undefined ? '' : `${f.source}:${f.name}:${String(f.component)}`;
  // `label` is part of the key, and `iso` is not read when it is present: two regions of one label
  // volume differ only by it, and sharing a cache entry would paint the second in the first's shape.
  const label = layer.source.label === undefined ? '' : `L${layer.source.label}`;
  return `${layer.datasetId}|iso|${layer.source.volumeIndex ?? 0}|${field}|${label}|${layer.iso}|${layer.smooth ? 1 : 0}`;
}

export class IsoLayerRuntime implements LayerRuntime {
  readonly kind = 'iso' as const;
  readonly id: LayerId;
  readonly datasetId: DatasetId;

  #layer: IsosurfaceLayer;
  readonly #ds: Dataset;
  readonly #ctx: LayerRuntimeContext;
  /** The key currently being computed, so a re-render does not re-issue the same op. */
  #inFlight: string | null = null;

  constructor(layer: IsosurfaceLayer, ds: Dataset, ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.#ds = ds;
    this.#ctx = ctx;
    this.id = layer.id;
    this.datasetId = layer.datasetId;
  }

  get layer(): IsosurfaceLayer {
    return this.#layer;
  }

  /**
   * True while this surface's `marchingCubes` / `marchingTets` is in flight.
   *
   * §8 gives a mesh layer's async switches a progress state (`Engine.meshLayerLoading`); a volume's
   * **3D surface** (§4.4's `iso3d`) needs the same, because marching cubes over 256×256×208 is not
   * instant and a switch that does nothing visible for a second reads as broken.
   */
  get loading(): boolean {
    return this.#inFlight !== null;
  }

  applyPatch(next: IsosurfaceLayer): void {
    this.#layer = next;
    // A changed `iso` / `source` / `smooth` is a different `isoKey`, so the next frame asks for the
    // new surface and the old one stays cached until the dataset goes.
  }

  probeRow(_world: vec3): ProbeRow {
    return { layerId: this.#layer.id, layerName: this.#layer.name, kind: 'iso' };
  }

  refreshProbe(): void {}
  ensurePickGeometry(): void {}

  drawItems(view: View): DrawItem[] {
    if (!visibleIn(this.#layer, view)) return [];
    const key = isoKey(this.#layer);
    const geom = this.#ctx.gpu.surface(key);
    if (geom === undefined) {
      this.#request(key);
      return [];
    }
    const item: IsoDrawItem = { kind: 'iso', layer: this.#layer, geom };
    return [item];
  }

  pickItems(): PickItem[] {
    // §7.2.3 wants the pick pass to reproduce every discard of the main pass; an isosurface has none
    // of its own, but it also has no element identity to report, so it stays out of the pick target
    // rather than returning a meaningless `elementId`.
    return [];
  }

  dispose(): void {
    this.#inFlight = null;
  }

  #request(key: string): void {
    if (this.#inFlight === key) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    const layer = this.#layer;
    const field = layer.source.field;
    this.#inFlight = key;
    const label = layer.source.label;
    const promise =
      this.#ds.kind === 'volume'
        ? label !== undefined
          ? // One region of a label volume, isolated at the sample (§6.5.2's `marchingCubesLabel`).
            // `marchingCubes` at `label - 0.5` would return the union of every id at or above it.
            client.call(`iso:${layer.id}`, 'marchingCubesLabel', {
              handle: (this.#ds as VolumeDataset).handle,
              volumeIndex: layer.source.volumeIndex ?? 0,
              label,
              smooth: layer.smooth,
            })
          : client.call(`iso:${layer.id}`, 'marchingCubes', {
              handle: (this.#ds as VolumeDataset).handle,
              volumeIndex: layer.source.volumeIndex ?? 0,
              iso: layer.iso,
              smooth: layer.smooth,
            })
        : field === undefined
          ? null
          : client.call(`iso:${layer.id}`, 'marchingTets', {
              handle: (this.#ds as MeshDataset).handle,
              source: field.source,
              name: field.name,
              component: field.component as ComponentSel,
              iso: layer.iso,
            });
    if (promise === null) {
      this.#inFlight = null;
      return;
    }
    void this.#ctx
      .track(promise)
      .then((payload) => {
        this.#ctx.gpu.uploadSurface(key, payload);
        if (this.#inFlight === key) this.#inFlight = null;
        this.#ctx.requestRender();
      })
      .catch(() => {
        // A superseded or cancelled build is not an error under latest-wins.
        if (this.#inFlight === key) this.#inFlight = null;
      });
  }
}
