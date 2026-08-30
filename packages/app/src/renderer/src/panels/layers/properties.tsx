/**
 * The per-kind property-editor registry — the app's mirror of the engine's `layers/registry.ts`.
 *
 * §8: "layer panel (ordered list, eye, opacity slider, **per-kind property editor**, …)". Four kinds
 * means four editors, and `Record<Layer['kind'], …>` means a fifth kind added to the frozen
 * `scene/types.ts` fails to compile here until someone writes its editor.
 *
 * **Shared-file rule: additive only.** Append a registration; never
 * reorder or repoint an existing one. The editors themselves live in `volume/`, `mesh/`, `iso/` and
 * `points/`, which is what lets A-PROPS build four of them without four merge conflicts.
 */

import type { Dataset, Layer } from '@tetravox/engine';
import { IsoProperties, isoSummary } from './iso/IsoProperties';
import { MeshProperties, meshSummary } from './mesh/MeshProperties';
import { PointsProperties, pointsSummary } from './points/PointsProperties';
import { VolumeProperties, volumeSummary } from './volume/VolumeProperties';
// Modules (2026-08-30, §13.3). Appended per the shared-file rule: one branch before the registry
// lookup, and no new entry in either record.
import { ModuleLayerSummary } from '../../modules/ModuleLayerSummary';
import { moduleOfLayer } from '../../modules/ownership';
import { manifestFor } from '../../../../modules/manifests';

export interface LayerPropertiesProps {
  layer: Layer;
  dataset: Dataset;
}

type Summary = (dataset: Dataset, layer: Layer) => string;
type Editor = (props: LayerPropertiesProps) => React.JSX.Element | null;

const SUMMARY: Record<Layer['kind'], Summary> = {
  volume: volumeSummary,
  mesh: meshSummary,
  iso: isoSummary,
  points: pointsSummary,
};

const EDITOR: Record<Layer['kind'], Editor> = {
  volume: VolumeProperties,
  mesh: MeshProperties,
  iso: IsoProperties,
  points: PointsProperties,
};

/**
 * The one-line summary under a layer row.
 *
 * A layer whose dataset has not arrived yet — the window between `addLayer` and the `datasets` event
 * — shows its kind rather than nothing, which is what the panel did before the split.
 */
export function layerSummary(dataset: Dataset | undefined, layer: Layer): string {
  const base = dataset === undefined ? layer.kind : SUMMARY[layer.kind](dataset, layer);
  // §13.3's badge: a module-owned layer says so on its own row, so "why does this one have no
  // editor" is answered where the question is asked.
  const owner = moduleOfLayer(layer);
  return owner === null ? base : `${manifestFor(owner)?.title ?? owner} · ${base}`;
}

/** The per-kind editor, or nothing while every editor is Phase 2's. */
export function LayerProperties({
  layer,
  dataset,
}: {
  layer: Layer;
  dataset: Dataset | undefined;
}): React.JSX.Element | null {
  if (dataset === undefined) return null;
  // §13.3: a module-owned layer gets a read-only summary instead of the core editor. See
  // `ModuleLayerSummary` for the three concrete defects the core points editor would cause on one.
  if (moduleOfLayer(layer) !== null) return <ModuleLayerSummary layer={layer} />;
  const Editor = EDITOR[layer.kind];
  return <Editor layer={layer} dataset={dataset} />;
}
