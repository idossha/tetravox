/**
 * The mesh **field selector** and the surface's appearance: colour source, node/element field and
 * component, shared contrast and threshold controls, and mesh edges
 * (§7.4).
 *
 * Three of these controls are **async loads with a progress state, not instant checkboxes** (§7.4):
 * the first `edges.surface`, the first switch to an element field, and the first `colorMode:'label'`
 * each make the worker build the de-indexed geometry variant. They go through
 * `ShellController.patchLayerAsync`, which shows the pending badge until the engine has settled.
 */

import type { ColormapName, MeshDataset, MeshLayer } from '@tetravox/engine';
import { plainLabel } from '@tetravox/engine';
import { FieldText } from '../../../ui/FieldText';
import { ScalarDisplayControls } from '../../histogram/ScalarDisplayControls';
import { useController, useUi } from '../../../ui/context';
import { Pending, Row, Section, Select, Slider, Swatch, Toggle } from './controls';
import { clearPaintOverrides, paintOverrideCount } from '../../regions/regions';
import {
  componentsOf,
  FIELD_CHIP_MAX,
  fieldKey,
  fieldLabel,
  fieldUnits,
  findField,
  hexToVec4,
  patchThreshold,
  setColorMode,
  setColormap,
  setEdgeColor,
  setEdgeWidth,
  setEdges,
  setScaleBounds,
  setFieldComponent,
  vec4ToHex,
} from './state';

/**
 * A **stable** empty array for the `meshPending` selector. `useUi` is `useSyncExternalStore`: a
 * selector that builds a fresh `[]` on every call reports a changed snapshot every render, and React
 * tears the whole tree down with "Maximum update depth exceeded" — from a fallback, not from a bug in
 * what it falls back to.
 */
const NONE: readonly string[] = [];

export function FieldSection({
  dataset,
  layer,
}: {
  dataset: MeshDataset;
  layer: MeshLayer;
}): React.JSX.Element {
  const controller = useController();
  const pending = useUi((s) => s.meshPending[layer.id] ?? NONE);
  const patch = (p: Partial<MeshLayer>): void => controller.patchLayer(layer.id, p);

  const field = layer.field === undefined ? null : findField(dataset, fieldKey(layer.field));
  const stats = field?.stats ?? null;
  const scale = layer.scale;
  const lo = scale.kind === 'linear' ? scale.lo : scale.min;
  const hi = scale.kind === 'linear' ? scale.hi : scale.max;
  const showField =
    layer.colorMode === 'field' ||
    Object.values(layer.tagStyle).some((style) => style.colorMode === 'field');

  const overrides = paintOverrideCount(layer, dataset);
  const chips = dataset.fields.length <= FIELD_CHIP_MAX;
  const units = field === null ? undefined : fieldUnits(layer, field);

  const colorModes: { value: MeshLayer['colorMode']; label: string }[] = [
    { value: 'tag', label: 'Tissue' },
    ...(dataset.fields.length ? [{ value: 'field' as const, label: 'Field' }] : []),
    { value: 'solid', label: 'Solid color' },
    // `colorMode:'label'` needs a `.annot` / `.label.gii` table on the layer; offering it without
    // one would emit a patch the engine can only ignore.
    ...(layer.label === undefined ? [] : [{ value: 'label' as const, label: 'label' }]),
  ];

  return (
    <Section testId={`mesh-field-${layer.id}`} title="Field & appearance" defaultOpen>
      <Row label="Colour by">
        <Select
          testId={`mesh-colormode-${layer.id}`}
          value={layer.colorMode}
          options={colorModes}
          onChange={(mode) => {
            if (mode === 'label') {
              void controller.patchLayerAsync<MeshLayer>(
                layer.id,
                setColorMode(layer, mode),
                'label'
              );
              return;
            }
            if (mode === 'field' && field === null && dataset.fields[0]) {
              void controller.selectMeshField(layer.id, fieldKey(dataset.fields[0]));
              return;
            }
            patch(setColorMode(layer, mode));
          }}
        />
        {pending.includes('label') ? (
          <Pending testId={`mesh-pending-label-${layer.id}`} label="label" />
        ) : null}
      </Row>
      {overrides > 0 ? (
        <div
          data-testid={`mesh-paint-overrides-${layer.id}`}
          className="-mt-0.5 mb-1 flex items-center gap-1 pl-[calc(5rem+0.375rem)] text-[10px] text-tvx-dim"
        >
          <span>{overrides} tissue color overrides</span>
          <button
            type="button"
            data-testid={`mesh-paint-reset-${layer.id}`}
            className="tvx-btn tvx-btn-sm ml-auto shrink-0"
            title="Every tissue follows “Colour by” again"
            onClick={() => patch(clearPaintOverrides(layer))}
          >
            Reset
          </button>
        </div>
      ) : null}

      {layer.colorMode === 'solid' && (
        <Row label="Color">
          <Swatch
            testId={`mesh-solid-color-${layer.id}`}
            hex={vec4ToHex(layer.solidColor)}
            title="Solid color"
            onChange={(hex) => patch({ solidColor: hexToVec4(hex, 1) })}
          />
        </Row>
      )}
      {showField && dataset.fields.length > 0 && (
        <>
          <Row label="Field">
            {chips ? (
              <span className="flex-1" />
            ) : (
              <Select
                testId={`mesh-fieldname-${layer.id}`}
                value={layer.field === undefined ? '' : fieldKey(layer.field)}
                options={[
                  { value: '', label: '—' },
                  ...dataset.fields.map((f) => ({
                    value: fieldKey(f),
                    label: `${plainLabel(fieldLabel(layer, f))} (${f.source}${f.ncomp > 1 ? `, ${f.ncomp}c` : ''})`,
                  })),
                ]}
                onChange={(key) => {
                  if (key !== '') void controller.selectMeshField(layer.id, key);
                }}
              />
            )}
            {chips && field !== null ? (
              <span
                data-testid={`mesh-field-active-${layer.id}`}
                className="min-w-0 truncate font-mono text-[10px] text-tvx-text"
              >
                <FieldText label={fieldLabel(layer, field)} />
              </span>
            ) : null}
            {units !== undefined ? (
              <span
                data-testid={`mesh-field-units-${layer.id}`}
                className="shrink-0 font-mono text-[10px] text-tvx-dim"
              >
                {units}
              </span>
            ) : null}
            {pending.includes('elmField') ? (
              <Pending testId={`mesh-pending-field-${layer.id}`} label="field" />
            ) : null}
          </Row>
          {chips ? (
            // A segmented control on its own full-width line: a handful of fields fit side by side.
            <div
              role="radiogroup"
              aria-label="Field"
              data-testid={`mesh-fieldname-${layer.id}`}
              className="-mt-0.5 flex flex-wrap gap-0.5"
            >
              {dataset.fields.map((f) => {
                const key = fieldKey(f);
                const active = layer.field !== undefined && fieldKey(layer.field) === key;
                // A node and an element field may share a name; only then does the source show.
                const twin = dataset.fields.some((g) => g !== f && g.name === f.name);
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-testid={`mesh-fieldname-${layer.id}-${key}`}
                    title={`${f.name} (${f.source}${f.ncomp > 1 ? `, ${f.ncomp}c` : ''})`}
                    className={`tvx-btn tvx-btn-sm max-w-full truncate font-mono ${
                      active ? 'tvx-btn-on' : ''
                    }`}
                    onClick={() => {
                      if (!active) void controller.selectMeshField(layer.id, key);
                    }}
                  >
                    <FieldText label={fieldLabel(layer, f)} />
                    {twin ? ` · ${f.source}` : ''}
                  </button>
                );
              })}
            </div>
          ) : null}

          {field !== null && field.ncomp > 1 ? (
            <Row label="Component">
              <Select
                testId={`mesh-component-${layer.id}`}
                value={String(layer.field?.component ?? 'mag')}
                options={componentsOf(field).map((c) => ({
                  value: String(c),
                  label: c === 'mag' ? 'magnitude' : (['x', 'y', 'z'][c] ?? String(c)),
                }))}
                onChange={(c) => {
                  if (layer.field === undefined) return;
                  const component = c === 'mag' ? 'mag' : (Number(c) as 0 | 1 | 2);
                  patch(setFieldComponent(layer, component, field.stats));
                }}
              />
            </Row>
          ) : null}
        </>
      )}

      {showField && field !== null && (
        <ScalarDisplayControls
          key={`${layer.id}-${fieldKey(field)}-${layer.field?.component ?? 'mag'}`}
          kind="mesh"
          id={layer.id}
          colormap={typeof layer.colormap === 'string' ? layer.colormap : 'viridis'}
          stats={field.ncomp === 1 || layer.field?.component === 'mag' ? stats : null}
          window={{ lo, hi }}
          threshold={layer.threshold}
          onColormap={(name) => patch(setColormap(layer, name as ColormapName))}
          onWindow={(low, high) => patch(setScaleBounds(layer, low, high))}
          onThreshold={(next) => patch(patchThreshold(layer, next))}
        />
      )}
      <Row label="Edges">
        <Toggle
          testId={`mesh-edges-surface-${layer.id}`}
          label="Show mesh edges"
          on={layer.edges.surface}
          title="Element edges on the surface — the first switch builds the de-indexed variant (§7.4)"
          onChange={(v) => {
            const next = setEdges(layer, { surface: v, caps: v });
            if (v && !layer.edges.surface) {
              void controller.patchLayerAsync<MeshLayer>(layer.id, next, 'edges');
              return;
            }
            patch(next);
          }}
        />
        {pending.includes('edges') ? (
          <Pending testId={`mesh-pending-edges-${layer.id}`} label="edges" />
        ) : null}
      </Row>
      {layer.edges.surface && (
        <Row label="Edge width">
          <Slider
            testId={`mesh-edge-width-${layer.id}`}
            value={layer.edgeWidthPx}
            min={0.5}
            max={4}
            step={0.1}
            format={(v) => `${v.toFixed(1)} px`}
            onChange={(v) => patch(setEdgeWidth(layer, v))}
          />
          <Swatch
            testId={`mesh-edge-color-${layer.id}`}
            hex={vec4ToHex(layer.edgeColor)}
            title="Edge colour"
            onChange={(hex) => patch(setEdgeColor(layer, hexToVec4(hex, layer.edgeColor[3])))}
          />
        </Row>
      )}
      {dataset.nNodes > 0 ? (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-tvx-dim">More options</summary>
          <button
            type="button"
            data-testid={`mesh-attach-data-${layer.id}`}
            className="tvx-btn tvx-btn-sm"
            title="Attach an annotation (.annot, .label.gii) or a per-vertex scalar (curv, thickness, .func.gii) to this surface"
            onClick={() => void controller.chooseSurfaceData(layer.id)}
          >
            Attach data…
          </button>
        </details>
      ) : null}
    </Section>
  );
}
