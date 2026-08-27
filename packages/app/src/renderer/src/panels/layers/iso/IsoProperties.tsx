/**
 * The **isosurface** layer's property editor — **Phase 2** (owner: A-PROPS).
 *
 * §4.4's `IsosurfaceLayer`: a source (a volume, or a mesh field), an `iso` level, a colour, `smooth`
 * and `faceMode`. The engine half is `layers/iso.ts` in `@tetravox/engine`; the `tvx-geom` half
 * (`marching_cubes`, `marching_tets`) landed in Phase 1.
 */

import type { Dataset, Layer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';

export function isoSummary(_dataset: Dataset, layer: Layer): string {
  return layer.kind;
}

export function IsoProperties(_props: LayerPropertiesProps): React.JSX.Element | null {
  return null;
}
