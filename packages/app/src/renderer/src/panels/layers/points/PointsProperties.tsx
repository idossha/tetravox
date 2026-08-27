/**
 * The **points** layer's property editor — **Phase 2** (owner: A-PROPS).
 *
 * §4.4's `PointsLayer` carries electrodes, ROI spheres from JSON/CSV, and SimNIBS
 * `eeg_positions/*.csv`; the editor is a shape/radius/colour block plus `showLabels`.
 */

import type { Dataset, Layer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';

export function pointsSummary(_dataset: Dataset, layer: Layer): string {
  return layer.kind;
}

export function PointsProperties(_props: LayerPropertiesProps): React.JSX.Element | null {
  return null;
}
