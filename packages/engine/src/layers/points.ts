/**
 * The `points` layer runtime — **Phase 2** (owner: E-DERIVED).
 *
 * §4.4's `PointsLayer` carries electrodes, ROI spheres from JSON/CSV, and SimNIBS
 * `eeg_positions/*.csv`. Unlike every other layer kind it is **not backed by a dataset worker**: the
 * points are a small array that arrives with the layer, so there is no parse to keep off the UI
 * thread and nothing for §5's worker-per-dataset rule to own.
 *
 * §7.4 fixes how it draws when it does: "one instanced draw of a shared cone+shaft VAO with
 * per-instance origin/direction/magnitude, in the opaque pass. No new geometry from WASM." Points
 * follow the same shape with a shared sphere/dot VAO, which is why this runtime will own an
 * instance buffer rather than geometry.
 */

import type { DrawItem, LayerRuntime, LayerRuntimeContext, PickItem } from './runtime';
import type { ProbeRow } from '../api';
import type { Dataset, DatasetId, LayerId, PointsLayer, vec3 } from '../scene/types';

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
    // PHASE 2 (E-DERIVED): a changed `points` array rewrites the per-instance buffer; `showLabels`
    // adds glyph labels to the overlay pass.
  }

  /**
   * The nearest point within its own radius, once this is implemented — §8's probe rows carry a
   * name for a points layer, not a voxel or an element.
   */
  probeRow(_world: vec3): ProbeRow {
    return { layerId: this.#layer.id, layerName: this.#layer.name, kind: 'points' };
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
