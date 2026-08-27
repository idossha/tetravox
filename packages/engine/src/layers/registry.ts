/**
 * The layer-runtime registry: `Layer['kind']` → the runtime that owns it.
 *
 * One table, exhaustive over §4.4's four kinds by construction — `Record<Layer['kind'], …>` means a
 * fifth kind added to the frozen `scene/types.ts` fails to compile here until someone writes its
 * runtime, which is the property the six scattered `if (layer.kind === …)` branches never had.
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** Append a registration; never
 * reorder or repoint an existing one.
 */

import { IsoLayerRuntime } from './iso';
import { MeshLayerRuntime } from './mesh';
import { PointsLayerRuntime } from './points';
import type { LayerRuntime, LayerRuntimeContext } from './runtime';
import { VolumeLayerRuntime } from './volume';
import type {
  Dataset,
  IsosurfaceLayer,
  Layer,
  MeshDataset,
  MeshLayer,
  PointsLayer,
  VolumeDataset,
  VolumeLayer,
} from '../scene/types';

type Factory = (layer: Layer, ds: Dataset, ctx: LayerRuntimeContext) => LayerRuntime;

const REGISTRY: Record<Layer['kind'], Factory> = {
  volume: (layer, ds, ctx) =>
    new VolumeLayerRuntime(layer as VolumeLayer, ds as VolumeDataset, ctx),
  mesh: (layer, ds, ctx) => new MeshLayerRuntime(layer as MeshLayer, ds as MeshDataset, ctx),
  iso: (layer, ds, ctx) => new IsoLayerRuntime(layer as IsosurfaceLayer, ds, ctx),
  points: (layer, ds, ctx) => new PointsLayerRuntime(layer as PointsLayer, ds, ctx),
};

/** Every layer kind the engine can instantiate — §4.4's four, in declaration order. */
export const LAYER_KINDS = Object.keys(REGISTRY) as readonly Layer['kind'][];

/**
 * Build the runtime for one layer.
 *
 * The `layer.kind` / `dataset.kind` pairing is checked by the caller (`Engine.addLayer` derives the
 * layer from the dataset via `defaultLayerFor`), so the casts above are narrowing what the registry
 * key already decided, not guessing.
 */
export function createLayerRuntime(
  layer: Layer,
  ds: Dataset,
  ctx: LayerRuntimeContext
): LayerRuntime {
  return REGISTRY[layer.kind](layer, ds, ctx);
}
