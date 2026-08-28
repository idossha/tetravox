/**
 * The **mesh** layer's property editor (§8), Phase 2.
 *
 * §8 is specific about the shape: it is a **tissue table** — name from `$PhysicalNames` (or the
 * `.msh.opt` sidecar, which is the only source for `ernie.msh`), colour swatch, eye, opacity slider —
 * **not a list of checkboxes**, backed by `tagStyle`. Plus the field selector, the 2D cross-section
 * toggles (**R4**), the clip-plane panel, the isolation panel and the glyph controls. The tissue
 * table is also the mesh half of **R5** (select / mute / recolour).
 *
 * Every section here is a thin renderer over `state.ts`, whose functions are pure and take the layer
 * to a `Partial<MeshLayer>`; the controller turns that into one `Engine.updateLayer` call. There is
 * no scene state in React (§8) and no arithmetic in a component that is not laid out below it.
 */

import type { Dataset, Layer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';
import { ClipPlanes } from './ClipPlanes';
import { CrossSection } from './CrossSection';
import { FieldSection } from './FieldSection';
import { Glyphs } from './Glyphs';
import { Isolation } from './Isolation';
import { RegionPanel } from '../../regions/RegionPanel';
import { TissueTable } from './TissueTable';

export function meshSummary(dataset: Dataset, layer: Layer): string {
  if (dataset.kind !== 'mesh') return layer.kind;
  const tris = dataset.hasTris ? `${dataset.nTris.toLocaleString()} tris` : 'no tris';
  return `${dataset.nNodes.toLocaleString()} nodes · ${tris} · ${dataset.nTets.toLocaleString()} tets`;
}

export function MeshProperties({ layer, dataset }: LayerPropertiesProps): React.JSX.Element | null {
  // A layer whose kind and dataset disagree is a bug elsewhere, not something to render around.
  if (layer.kind !== 'mesh' || dataset.kind !== 'mesh') return null;
  return (
    <div data-testid={`mesh-properties-${layer.id}`} className="mt-1 flex flex-col">
      <TissueTable dataset={dataset} layer={layer} />
      {/* R5: "**One** Region panel for every labelled thing … label volumes, mesh tissue tags
          (`tagStyle`), surface annotations (`.annot` / `.label.gii` via `colorMode:'label'`)."
          `panels/regions/regions.ts` has served all three since it was written — `regionSourceFor`
          returns `meshTag` and `annot` sources — and the panel was mounted from exactly one place,
          the volume editor, so two of the three were unreachable and the tissue table was the only
          UI a mesh tag had. That is how the two grew different gestures for the same action. */}
      <RegionPanel layerId={layer.id} />
      <FieldSection dataset={dataset} layer={layer} />
      <CrossSection dataset={dataset} layer={layer} />
      <ClipPlanes dataset={dataset} layer={layer} />
      <Isolation dataset={dataset} layer={layer} />
      <Glyphs dataset={dataset} layer={layer} />
    </div>
  );
}
