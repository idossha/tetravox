/**
 * The **mesh** layer's property editor (§8).
 *
 * Phase 1 ships the read-only summary: node, triangle and tet counts, and whether the mesh brought
 * its own triangles (`grey_Thalamus_TI.msh` has none — 1,340,029 tets, 0 tris `[DATA]` — and renders
 * through `extract_boundary` instead).
 *
 * **Phase 2 (owner: A-PROPS) fills in the editor.** §8 is specific about the shape: it is a **tissue
 * table** — name from `$PhysicalNames` (or the `.msh.opt` sidecar, which is the only source for
 * `ernie.msh`), colour swatch, eye, opacity slider — **not a list of checkboxes**, backed by
 * `tagStyle`. Plus the field selector, the clip-plane panel, the isolation panel and the glyph
 * controls.
 */

import type { Dataset, Layer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';

export function meshSummary(dataset: Dataset, layer: Layer): string {
  if (dataset.kind !== 'mesh') return layer.kind;
  const tris = dataset.hasTris ? `${dataset.nTris.toLocaleString()} tris` : 'no tris';
  return `${dataset.nNodes.toLocaleString()} nodes · ${tris} · ${dataset.nTets.toLocaleString()} tets`;
}

/** Phase 2's tissue table. Renders nothing today. */
export function MeshProperties(_props: LayerPropertiesProps): React.JSX.Element | null {
  return null;
}
