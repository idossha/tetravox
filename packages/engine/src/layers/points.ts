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
 * with the rest of them, keyed by layer id; this file owns the two **pure** functions that decide
 * what goes in it and what a probe row says, which is what lets both be tested without a context.
 */

import { visibleIn } from './runtime';
import type {
  DrawItem,
  LayerRuntime,
  LayerRuntimeContext,
  PickItem,
  PointsDrawItem,
} from './runtime';
import type { ProbeRow } from '../api';
import type { Dataset, DatasetId, LayerId, PointsLayer, vec3, View } from '../scene/types';

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
    const c = p.color ?? layer.color;
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
