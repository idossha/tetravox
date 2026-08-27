/**
 * The `iso` layer runtime — **Phase 2** (owner: E-DERIVED).
 *
 * §4.4's `IsosurfaceLayer` is the engine/UI half of marching cubes / tets; the `tvx-geom` half
 * landed in Phase 1 (`marching_cubes`, `marching_tets`, with `marchingCubes` / `marchingTets` ops in
 * §6.5.2 and an analytic-sphere test in `crates/tvx-geom`). Nothing here calls them yet.
 *
 * Typed and inert on purpose: `addLayer({kind:'iso'})` must produce a runtime rather than crash, so
 * that the app can offer the layer kind and the registry stays exhaustive over §4.4's four kinds.
 * The isosurface arrives as a `SurfacePayload` — the same shape `surface` / `boundary` return — so
 * it will draw through the **mesh** pass, and this runtime's job is to own the op and its cache.
 */

import type { DrawItem, LayerRuntime, LayerRuntimeContext, PickItem } from './runtime';
import type { ProbeRow } from '../api';
import type { Dataset, DatasetId, IsosurfaceLayer, LayerId, vec3 } from '../scene/types';

export class IsoLayerRuntime implements LayerRuntime {
  readonly kind = 'iso' as const;
  readonly id: LayerId;
  readonly datasetId: DatasetId;

  #layer: IsosurfaceLayer;

  constructor(layer: IsosurfaceLayer, _ds: Dataset, _ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.id = layer.id;
    this.datasetId = layer.datasetId;
  }

  get layer(): IsosurfaceLayer {
    return this.#layer;
  }

  applyPatch(next: IsosurfaceLayer): void {
    this.#layer = next;
    // PHASE 2 (E-DERIVED): a changed `iso` / `source` / `smooth` re-issues `marchingCubes` or
    // `marchingTets`, latest-wins on `iso:<layerId>`, and re-uploads the returned `SurfacePayload`.
  }

  probeRow(_world: vec3): ProbeRow {
    return { layerId: this.#layer.id, layerName: this.#layer.name, kind: 'iso' };
  }

  refreshProbe(): void {}
  ensurePickGeometry(): void {}

  drawItems(): DrawItem[] {
    return [];
  }

  pickItems(): PickItem[] {
    return [];
  }

  dispose(): void {}
}
