/**
 * The **volume** layer's property editor (§8: "per-kind property editor").
 *
 * Phase 1 ships the read-only summary a user needs to tell two layers apart — dims, dtype, whether
 * it is a label volume, and the 4D index when there is more than one frame.
 *
 * **Phase 2 (owner: A-PROPS) fills in the editor**: `Scale` controls including `heat`'s min/mid/max
 * and the negative branch, threshold with `softEdge`, the label fill/outline/both selector with
 * `visibleLabels` and `labelOpacity`, interpolation, `showIn3D`, the 4D spinner, and the §8 histogram
 * widget with draggable window/threshold handles and its four presets. Every control is one §4.7
 * call — there is no scene state in React (§8).
 */

import type { Dataset, Layer, VolumeLayer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';

/** The one-line summary shown under every volume row. */
export function volumeSummary(dataset: Dataset, layer: Layer): string {
  if (dataset.kind !== 'volume') return layer.kind;
  const dims = dataset.dims.join('×');
  const four =
    dataset.nvols > 1
      ? ` · vol ${(layer as Partial<VolumeLayer>).volumeIndex ?? 0}/${dataset.nvols - 1}`
      : '';
  return `${dims} ${dataset.dtype}${dataset.isLabel ? ' · labels' : ''}${four}`;
}

/** Phase 2's editor. Renders nothing today, so the row is exactly what Phase 1 shipped. */
export function VolumeProperties(_props: LayerPropertiesProps): React.JSX.Element | null {
  return null;
}
