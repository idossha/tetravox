/**
 * **R4 — mesh cross-sections in the 2D panes.** The panel half of it: the `fillIn2D` and
 * `contoursIn2D` toggles, the contour width, and **which field colours the cut**.
 *
 * The engine halves are E-MESH's (the cut manager) and E-DERIVED's (the fill polygons and the
 * instanced contour renderer); R4's "default when a mesh is opened: fill **and** contours on" is
 * `scene/defaults.ts`, which is theirs too. What is A-PROPS's is exactly this: two toggles, a width
 * and a colour source, each one `Engine.updateLayer` call.
 *
 * **On "which field colours the cut":** the frozen §4.4 `MeshLayer` has no separate cut-colour field,
 * and it does not need one — §7.4 draws the cut polygons "with tag/field colour", i.e. through the
 * layer's own `colorMode` / `field` / `colormap` / `scale`, which is what R4 asks for. So this
 * selector drives `colorMode` and `field`, the same pair the appearance section drives, surfaced
 * where the cross-section lives because that is where the user is looking when they ask the question.
 */

import type { MeshDataset, MeshLayer } from '@tetravox/engine';
import { useController } from '../../../ui/context';
import { Row, Section, Select, Slider, Toggle } from './controls';
import {
  cutColorSource,
  fieldKey,
  setContourWidth,
  setContoursIn2D,
  setCutColorSource,
  setFillIn2D,
} from './state';

export function CrossSection({
  dataset,
  layer,
}: {
  dataset: MeshDataset;
  layer: MeshLayer;
}): React.JSX.Element {
  const controller = useController();
  const patch = (p: Partial<MeshLayer>): void => controller.patchLayer(layer.id, p);
  const on = layer.fillIn2D || layer.contoursIn2D;

  return (
    <Section
      testId={`mesh-cut2d-${layer.id}`}
      title="2D cross-section"
      defaultOpen
      right={
        <span
          data-testid={`mesh-cut2d-state-${layer.id}`}
          className="shrink-0 font-mono text-[9px] text-tvx-dim"
        >
          {on ? 'on' : 'off'}
        </span>
      }
    >
      <Row label="Draw">
        <Toggle
          testId={`mesh-fill2d-${layer.id}`}
          label="fill"
          on={layer.fillIn2D}
          title="Filled per-element cut polygons in every 2D pane (R4)"
          onChange={(v) => patch(setFillIn2D(layer, v))}
        />
        <Toggle
          testId={`mesh-contours2d-${layer.id}`}
          label="contours"
          on={layer.contoursIn2D}
          title="Tissue-boundary contour lines in every 2D pane (R4)"
          onChange={(v) => patch(setContoursIn2D(layer, v))}
        />
      </Row>

      <Row label="Contour width">
        <Slider
          testId={`mesh-contour-width-${layer.id}`}
          value={layer.contourWidthPx}
          min={0.5}
          max={6}
          step={0.5}
          format={(v) => `${v.toFixed(1)} px`}
          onChange={(v) => patch(setContourWidth(layer, v))}
        />
      </Row>

      <Row label="Cut colour">
        <Select
          testId={`mesh-cut-color-${layer.id}`}
          value={cutColorSource(layer)}
          options={[
            { value: 'tag', label: 'tissue tag' },
            { value: 'solid', label: 'solid colour' },
            ...dataset.fields.map((f) => ({
              value: fieldKey(f),
              label: `${f.name} (${f.source})`,
            })),
          ]}
          onChange={(source) => {
            const next = setCutColorSource(dataset, layer, source);
            // Same §7.4 async switch as the appearance section: an element field builds the
            // de-indexed variant the first time it is asked for.
            if (next.field?.source === 'elm' && layer.field?.source !== 'elm') {
              void controller.patchLayerAsync<MeshLayer>(layer.id, next, 'elmField');
              return;
            }
            patch(next);
          }}
        />
      </Row>
      <p className="text-[9px] leading-tight text-tvx-dim">
        The cut honours <code>tagStyle</code> visibility/opacity and any isolation mask, and follows
        the cursor as the slice sweeps (R4).
      </p>
    </Section>
  );
}
