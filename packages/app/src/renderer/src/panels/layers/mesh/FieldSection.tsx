/**
 * The mesh **field selector** and the surface's appearance: colour source, node/element field and
 * component, `Scale` + colormap + `Threshold`, flat/smooth shading, and the masked-barycentric edges
 * (§7.4).
 *
 * Three of these controls are **async loads with a progress state, not instant checkboxes** (§7.4):
 * the first `edges.surface`, the first switch to an element field, and the first `colorMode:'label'`
 * each make the worker build the de-indexed geometry variant. They go through
 * `ShellController.patchLayerAsync`, which shows the pending badge until the engine has settled.
 */

import type { ColormapName, MeshDataset, MeshLayer } from '@tetravox/engine';
import { useController, useUi } from '../../../ui/context';
import { NumberField, Pending, Row, Section, Select, Slider, Swatch, Toggle } from './controls';
import {
  componentsOf,
  fieldKey,
  findField,
  hexToVec4,
  patchHeat,
  patchThreshold,
  selectField,
  setColorMode,
  setColormap,
  setEdgeColor,
  setEdgeWidth,
  setEdges,
  setScaleBounds,
  setScaleKind,
  vec4ToHex,
} from './state';

/** §4.1's `ColormapName`, as a value. The `satisfies` keeps it in step with the frozen union. */
const COLORMAPS = [
  'gray',
  'viridis',
  'plasma',
  'inferno',
  'magma',
  'cividis',
  'turbo',
  'jet',
  'hot',
  'cool',
  'bone',
  'coolwarm',
  'bwr',
  'freesurfer-heat',
  'blue-cyan',
] as const satisfies readonly ColormapName[];

const COLORMAP_OPTIONS = COLORMAPS.map((c) => ({ value: c, label: c }));

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
  const span = hi - lo === 0 ? 1 : hi - lo;

  const colorModes: { value: MeshLayer['colorMode']; label: string }[] = [
    { value: 'tag', label: 'tissue tag' },
    { value: 'field', label: 'field' },
    { value: 'solid', label: 'solid' },
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
            patch(setColorMode(layer, mode));
          }}
        />
        {pending.includes('label') ? (
          <Pending testId={`mesh-pending-label-${layer.id}`} label="label" />
        ) : null}
      </Row>

      {/* The solid colour lived on the bottom of the old `TissueTable`; it belongs beside the
          colour-source selector it feeds, not under a list of tissues it has nothing to do with. */}
      <Row label="Solid colour">
        <Swatch
          testId={`mesh-solid-color-${layer.id}`}
          hex={vec4ToHex(layer.solidColor)}
          title="The colour used by colorMode 'solid' and by any tag the file left uncoloured"
          onChange={(hex) => patch({ solidColor: hexToVec4(hex, layer.solidColor[3]) })}
        />
        <span className="flex-1" />
        <span className="shrink-0 text-[10px] text-tvx-dim">alpha</span>
        <NumberField
          testId={`mesh-solid-alpha-${layer.id}`}
          value={layer.solidColor[3]}
          step={0.05}
          min={0}
          max={1}
          onCommit={(a) =>
            patch({
              solidColor: [layer.solidColor[0], layer.solidColor[1], layer.solidColor[2], a],
            })
          }
        />
      </Row>

      {dataset.fields.length === 0 ? (
        <p className="text-[10px] text-tvx-dim">
          This mesh carries no fields — <code>ernie.msh</code> is the reference case.
        </p>
      ) : (
        <>
          <Row label="Field">
            <Select
              testId={`mesh-fieldname-${layer.id}`}
              value={layer.field === undefined ? '' : fieldKey(layer.field)}
              options={[
                { value: '', label: '—' },
                ...dataset.fields.map((f) => ({
                  value: fieldKey(f),
                  label: `${f.name} (${f.source}${f.ncomp > 1 ? `, ${f.ncomp}c` : ''})`,
                })),
              ]}
              onChange={(key) => {
                if (key === '') return;
                const next = selectField(dataset, layer, key);
                // §7.4: the first element field builds the de-indexed variant in the worker.
                if (next.field?.source === 'elm' && layer.field?.source !== 'elm') {
                  void controller.patchLayerAsync<MeshLayer>(layer.id, next, 'elmField');
                  return;
                }
                patch(next);
              }}
            />
            {pending.includes('elmField') ? (
              <Pending testId={`mesh-pending-field-${layer.id}`} label="field" />
            ) : null}
          </Row>

          {field !== null ? (
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
                  patch({ field: { ...layer.field, component } });
                }}
              />
              <span
                data-testid={`mesh-field-units-${layer.id}`}
                className="shrink-0 font-mono text-[10px] text-tvx-dim"
              >
                {field.units ?? ''}
              </span>
            </Row>
          ) : null}
        </>
      )}

      <Row label="Colormap">
        <Select
          testId={`mesh-colormap-${layer.id}`}
          value={(typeof layer.colormap === 'string' ? layer.colormap : 'viridis') as ColormapName}
          options={COLORMAP_OPTIONS}
          onChange={(c) => patch(setColormap(layer, c))}
        />
      </Row>

      <Row label="Scale">
        <Select
          testId={`mesh-scalekind-${layer.id}`}
          value={scale.kind}
          options={[
            { value: 'linear', label: 'linear' },
            { value: 'heat', label: 'heat' },
          ]}
          onChange={(kind) => patch(setScaleKind(layer, kind))}
        />
        {stats === null ? null : (
          <button
            type="button"
            data-testid={`mesh-scale-reset-${layer.id}`}
            className="tvx-btn tvx-btn-sm"
            title="Back to the field's own min…max"
            onClick={(e) => {
              e.stopPropagation();
              patch(setScaleBounds(layer, stats.min, stats.max));
            }}
          >
            min–max
          </button>
        )}
      </Row>

      <Row label={scale.kind === 'heat' ? 'min' : 'lo'}>
        <NumberField
          testId={`mesh-scale-lo-${layer.id}`}
          value={lo}
          step={span / 100}
          width="w-24"
          onCommit={(v) => patch(setScaleBounds(layer, v, hi))}
        />
      </Row>
      {scale.kind === 'heat' ? (
        <Row label="mid">
          <NumberField
            testId={`mesh-scale-mid-${layer.id}`}
            value={scale.mid}
            step={span / 100}
            width="w-24"
            onCommit={(v) => patch(patchHeat(layer, { mid: v }))}
          />
        </Row>
      ) : null}
      <Row label={scale.kind === 'heat' ? 'max' : 'hi'}>
        <NumberField
          testId={`mesh-scale-hi-${layer.id}`}
          value={hi}
          step={span / 100}
          width="w-24"
          onCommit={(v) => patch(setScaleBounds(layer, lo, v))}
        />
      </Row>
      {scale.kind === 'heat' ? (
        <Row label="heat">
          <Toggle
            testId={`mesh-heat-truncate-${layer.id}`}
            label="truncate"
            on={scale.truncate}
            onChange={(v) => patch(patchHeat(layer, { truncate: v }))}
          />
          <Toggle
            testId={`mesh-heat-inverse-${layer.id}`}
            label="inverse"
            on={scale.inverse}
            onChange={(v) => patch(patchHeat(layer, { inverse: v }))}
          />
          <Select
            testId={`mesh-heat-negative-${layer.id}`}
            value={scale.negative}
            options={[
              { value: 'mirror', label: 'mirror −' },
              { value: 'hide', label: 'hide −' },
              { value: 'separate', label: 'separate −' },
            ]}
            onChange={(n) => patch(patchHeat(layer, { negative: n }))}
          />
        </Row>
      ) : null}

      <Row label="Threshold">
        <NumberField
          testId={`mesh-threshold-lo-${layer.id}`}
          value={layer.threshold.lo}
          step={span / 100}
          onCommit={(v) => patch(patchThreshold(layer, { lo: v }))}
        />
        <NumberField
          testId={`mesh-threshold-hi-${layer.id}`}
          value={layer.threshold.hi}
          step={span / 100}
          onCommit={(v) => patch(patchThreshold(layer, { hi: v }))}
        />
        <Toggle
          testId={`mesh-threshold-symmetric-${layer.id}`}
          label="|v|"
          title="Compare the absolute value (§4.2)"
          on={layer.threshold.symmetric}
          onChange={(v) => patch(patchThreshold(layer, { symmetric: v }))}
        />
      </Row>
      <Row label="Soft edge">
        <Slider
          testId={`mesh-threshold-soft-${layer.id}`}
          value={layer.threshold.softEdge}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patch(patchThreshold(layer, { softEdge: v }))}
        />
      </Row>

      <Row label="Shading">
        <Toggle
          testId={`mesh-flat-${layer.id}`}
          label={layer.flatShading ? 'flat' : 'smooth'}
          on={layer.flatShading}
          onChange={(v) => patch({ flatShading: v })}
        />
        <Toggle
          testId={`mesh-facemode-${layer.id}`}
          label={layer.faceMode === 'both' ? 'two-sided' : 'cull back'}
          on={layer.faceMode === 'both'}
          disabled={dataset.orient.openComponents > 0}
          title={
            dataset.orient.openComponents > 0
              ? `Forced two-sided: ${dataset.orient.openComponents} open components (§7.4)`
              : 'Face culling'
          }
          onChange={(v) => patch({ faceMode: v ? 'both' : 'cull' })}
        />
      </Row>

      <Row label="Edges">
        <Toggle
          testId={`mesh-edges-surface-${layer.id}`}
          label="surface"
          on={layer.edges.surface}
          title="Element edges on the surface — the first switch builds the de-indexed variant (§7.4)"
          onChange={(v) => {
            const next = setEdges(layer, { surface: v });
            if (v && !layer.edges.surface) {
              void controller.patchLayerAsync<MeshLayer>(layer.id, next, 'edges');
              return;
            }
            patch(next);
          }}
        />
        <Toggle
          testId={`mesh-edges-caps-${layer.id}`}
          label="caps"
          on={layer.edges.caps}
          onChange={(v) => patch(setEdges(layer, { caps: v }))}
        />
        {pending.includes('edges') ? (
          <Pending testId={`mesh-pending-edges-${layer.id}`} label="edges" />
        ) : null}
      </Row>
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
    </Section>
  );
}
