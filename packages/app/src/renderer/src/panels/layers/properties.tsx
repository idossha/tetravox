/**
 * The per-kind property-editor registry — the app's mirror of the engine's `layers/registry.ts`.
 *
 * §8: "layer panel (ordered list, eye, opacity slider, **per-kind property editor**, …)". Four kinds
 * means four editors, and `Record<Layer['kind'], …>` means a fifth kind added to the frozen
 * `scene/types.ts` fails to compile here until someone writes its editor.
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** Append a registration; never
 * reorder or repoint an existing one. The editors themselves live in `volume/`, `mesh/`, `iso/` and
 * `points/`, which is what lets A-PROPS build four of them without four merge conflicts.
 */

import type { Dataset, Layer } from '@tetravox/engine';
import { IsoProperties, isoSummary } from './iso/IsoProperties';
import { MeshProperties, meshSummary } from './mesh/MeshProperties';
import { PointsProperties, pointsSummary } from './points/PointsProperties';
import { VolumeProperties, volumeSummary } from './volume/VolumeProperties';

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
  if (dataset === undefined) return layer.kind;
  return SUMMARY[layer.kind](dataset, layer);
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
  const Editor = EDITOR[layer.kind];
  return <Editor layer={layer} dataset={dataset} />;
}
