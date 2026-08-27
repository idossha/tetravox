/**
 * The region panel — **Phase 2** (owner: A-PROPS).
 *
 * §8, in full: "for label volumes and `.annot` layers: search-as-you-type over the `LabelTable`,
 * per-row eye + colour swatch + voxel count, `Alt+click` to solo, double-click to jump the cursor to
 * that label's centroid (`labelCentroids`). The same selection wires into
 * `MeshLayer.isolate.labelVolume.labels`."
 *
 * Two things the implementation inherits rather than rediscovers:
 *
 * * The centroid jump is the `labelCentroids` op (§6.5.2), whose `tvx-geom` half landed in Phase 1.
 * * The selection is the **same** selection as the mesh isolation's, which is why one panel drives
 *   both and why `IsolateManager` in the engine owns the mask (§6.5.2: the client must `freeMask`).
 *
 * Typed and inert: it renders nothing, so mounting it early costs nothing.
 */

import type { LayerId } from '@tetravox/engine';

export interface RegionPanelProps {
  /** The label volume or `.annot` layer whose table is being browsed. */
  layerId: LayerId;
}

export function RegionPanel(_props: RegionPanelProps): React.JSX.Element | null {
  return null;
}
