/** The `tracts` layer's editor (§4.4): colour, window, filter, groups, sampling and the budget. */

import { useMemo, useState } from 'react';
import type { Dataset, TractogramDataset, TractsLayer } from '@tetravox/engine';
import { TRACT_FULL_MAX_POINTS } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';
import { useController, useUi } from '../../../ui/context';
import { NumberField, Row, Section, Select, Slider, Swatch, Toggle } from '../mesh/controls';
import { hexToVec4, vec4ToHex } from '../mesh/state';
import { ScalarDisplayControls } from '../../histogram/ScalarDisplayControls';
import {
  displayedText,
  fieldsFor,
  groupSources,
  sampleChoices,
  selectField,
  selectMode,
  toggleGroup,
  tractsSummary,
} from './state';

export { tractsSummary };

const MODES: { value: TractsLayer['colorMode']; label: string }[] = [
  { value: 'direction', label: 'direction' },
  { value: 'solid', label: 'solid' },
  { value: 'vertex', label: 'per vertex' },
  { value: 'streamline', label: 'per streamline' },
  { value: 'group', label: 'group' },
];

export function TractsProperties({
  layer,
  dataset,
}: LayerPropertiesProps): React.JSX.Element | null {
  if (layer.kind !== 'tracts' || dataset.kind !== 'tractogram') return null;
  return <TractsEditor layer={layer} dataset={dataset} />;
}

function TractsEditor({
  layer,
  dataset,
}: {
  layer: TractsLayer;
  dataset: TractogramDataset;
}): React.JSX.Element {
  const controller = useController();
  const id = layer.id;
  const patch = (p: Partial<TractsLayer>): void => controller.patchLayer<TractsLayer>(id, p);
  const fields = fieldsFor(dataset, layer.colorMode);
  const active = fields.find((f) => f.name === layer.field) ?? null;
  const scalar = layer.colorMode === 'vertex' || layer.colorMode === 'streamline';
  const window =
    layer.scale.kind === 'linear'
      ? { lo: layer.scale.lo, hi: layer.scale.hi }
      : { lo: layer.scale.min, hi: layer.scale.max };

  return (
    <div data-testid={`tracts-properties-${id}`} className="mt-1 flex flex-col">
      <Section testId={`tracts-section-${id}`} title="Tracts" defaultOpen>
        <BudgetLine dataset={dataset} />
        {dataset.notes.map((note) => (
          <p key={note} className="text-[9px] text-tvx-dim" data-testid={`tracts-note-${id}`}>
            {note}
          </p>
        ))}
        <Row label="Colour">
          <Select
            testId={`tracts-mode-${id}`}
            value={layer.colorMode}
            options={MODES}
            onChange={(mode) => patch(selectMode(layer, dataset, mode))}
          />
          {layer.colorMode === 'solid' && (
            <Swatch
              testId={`tracts-solid-${id}`}
              hex={vec4ToHex(layer.solidColor)}
              title="Line colour"
              onChange={(hex) => patch({ solidColor: hexToVec4(hex, layer.solidColor[3]) })}
            />
          )}
        </Row>
        {scalar && (
          <Row label="Field">
            {fields.length === 0 ? (
              <span className="text-[10px] text-tvx-dim">this file has none</span>
            ) : (
              <Select
                testId={`tracts-field-${id}`}
                value={layer.field ?? ''}
                options={fields.map((f) => ({ value: f.name, label: f.name }))}
                onChange={(name) => {
                  const f = fields.find((x) => x.name === name);
                  if (f !== undefined) patch(selectField(layer.colorMode, f));
                }}
              />
            )}
          </Row>
        )}
        {scalar && active !== null && active.nanCount > 0 && (
          <p className="text-[9px] text-tvx-dim" data-testid={`tracts-nan-${id}`}>
            {active.nanCount.toLocaleString()} samples have no value and draw neutral grey
          </p>
        )}
        <Row label="Width px">
          <Slider
            testId={`tracts-width-${id}`}
            value={layer.lineWidthPx}
            min={1}
            max={6}
            step={0.5}
            format={(v) => v.toFixed(1)}
            onChange={(lineWidthPx) => patch({ lineWidthPx })}
          />
        </Row>
        <Row label="2D slab mm">
          <Slider
            testId={`tracts-slab-${id}`}
            value={layer.slabMm}
            min={0}
            max={10}
            step={0.5}
            format={(v) => v.toFixed(1)}
            onChange={(slabMm) => patch({ slabMm })}
          />
        </Row>
      </Section>

      {scalar && active !== null && (
        <Section testId={`tracts-window-${id}`} title="Window" defaultOpen>
          <ScalarDisplayControls
            kind="mesh"
            id={id}
            colormap={layer.colormap}
            stats={active.stats}
            window={window}
            threshold={layer.threshold}
            onColormap={(colormap) => patch({ colormap })}
            onWindow={(lo, hi) => patch({ scale: { kind: 'linear', lo, hi } })}
            onThreshold={(p) => patch({ threshold: { ...layer.threshold, ...p } })}
          />
        </Section>
      )}

      <FilterSection layer={layer} dataset={dataset} patch={patch} />
      <GroupSection layer={layer} dataset={dataset} patch={patch} />
      <SampleSection layer={layer} dataset={dataset} />
    </div>
  );
}

function BudgetLine({ dataset }: { dataset: TractogramDataset }): React.JSX.Element {
  const controller = useController();
  const [busy, setBusy] = useState(false);
  const partial = dataset.nStreamlines < dataset.sourceStreamlines;
  const canGrow = partial && dataset.budget.maxPoints !== null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <p
        data-testid={`tracts-displayed-${dataset.id}`}
        className="min-w-0 flex-1 basis-full font-mono text-[9px] text-tvx-dim"
      >
        {displayedText(dataset)}
      </p>
      {canGrow && (
        <button
          type="button"
          data-testid={`tracts-load-full-${dataset.id}`}
          disabled={busy}
          title={`Read up to ${TRACT_FULL_MAX_POINTS.toLocaleString()} points`}
          className="shrink-0 rounded border border-tvx-line px-1.5 text-[10px] disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            void controller.setTractBudget(dataset.id, null).finally(() => setBusy(false));
          }}
        >
          {busy ? 'Loading…' : 'Load full'}
        </button>
      )}
    </div>
  );
}

function FilterSection({
  layer,
  dataset,
  patch,
}: {
  layer: TractsLayer;
  dataset: TractogramDataset;
  patch: (p: Partial<TractsLayer>) => void;
}): React.JSX.Element {
  const id = layer.id;
  const filter = layer.streamlineFilter;
  const on = filter !== undefined;
  const field = dataset.streamlineFields.find((f) => f.name === filter?.field);
  return (
    <Section testId={`tracts-filter-${id}`} title="Filter streamlines">
      <Row label="By">
        <Toggle
          testId={`tracts-filter-on-${id}`}
          label="on"
          on={on}
          onChange={(v) => {
            const first =
              dataset.streamlineFields.find((f) => f.builtin === true) ??
              dataset.streamlineFields[0];
            if (!v || first === undefined) patch({ streamlineFilter: undefined });
            else patch({ streamlineFilter: { field: first.name, lo: null, hi: null } });
          }}
        />
        {on && (
          <Select
            testId={`tracts-filter-field-${id}`}
            value={filter.field}
            options={dataset.streamlineFields.map((f) => ({ value: f.name, label: f.name }))}
            onChange={(name) => patch({ streamlineFilter: { field: name, lo: null, hi: null } })}
          />
        )}
      </Row>
      {on && (
        <Row label="Range">
          <NumberField
            testId={`tracts-filter-lo-${id}`}
            value={filter.lo ?? field?.stats.min ?? 0}
            step={0.1}
            onCommit={(lo) => patch({ streamlineFilter: { ...filter, lo } })}
          />
          <NumberField
            testId={`tracts-filter-hi-${id}`}
            value={filter.hi ?? field?.stats.max ?? 0}
            step={0.1}
            onCommit={(hi) => patch({ streamlineFilter: { ...filter, hi } })}
          />
        </Row>
      )}
    </Section>
  );
}

function GroupSection({
  layer,
  dataset,
  patch,
}: {
  layer: TractsLayer;
  dataset: TractogramDataset;
  patch: (p: Partial<TractsLayer>) => void;
}): React.JSX.Element | null {
  const controller = useController();
  // Re-read on every layers event, which is when a style landed.
  useUi((s) => s.layers);
  const [query, setQuery] = useState('');
  const sources = useMemo(() => groupSources(dataset), [dataset]);
  if (sources.length === 0) return null;
  const id = layer.id;
  const rows = controller.tractStyleInfo(id)?.groups ?? [];
  const shown = rows
    .filter((g) => g.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 200);
  const all = rows.map((g) => g.id);
  return (
    <Section testId={`tracts-groups-${id}`} title="Groups">
      <Row label="From">
        <Select
          testId={`tracts-group-field-${id}`}
          value={layer.groupField ?? sources[0]?.value ?? ''}
          options={sources}
          onChange={(v) =>
            patch({ groupField: v === '' ? undefined : v, visibleGroups: undefined })
          }
        />
      </Row>
      {rows.length > 8 && (
        <input
          aria-label="Search groups"
          data-testid={`tracts-group-search-${id}`}
          className="w-full rounded border border-tvx-line bg-transparent px-1 text-[10px]"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      )}
      <ul className="max-h-40 overflow-y-auto">
        {shown.map((g) => {
          const visible = layer.visibleGroups === undefined || layer.visibleGroups.includes(g.id);
          return (
            <li key={g.id} className="flex items-center gap-1 text-[10px]">
              <input
                type="checkbox"
                data-testid={`tracts-group-${id}-${g.id}`}
                aria-label={`Show ${g.name}`}
                checked={visible}
                onChange={() =>
                  patch({ visibleGroups: toggleGroup(all, layer.visibleGroups, g.id) })
                }
              />
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-sm"
                style={{ background: `rgb(${g.color.join(',')})` }}
              />
              <span className="min-w-0 flex-1 truncate">{g.name}</span>
              <span className="text-tvx-dim">{g.count.toLocaleString()}</span>
              <button
                type="button"
                className="text-tvx-dim underline"
                onClick={() => patch({ visibleGroups: [g.id] })}
              >
                only
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function SampleSection({
  layer,
  dataset,
}: {
  layer: TractsLayer;
  dataset: TractogramDataset;
}): React.JSX.Element {
  const controller = useController();
  const datasets = useUi((s) => s.datasets);
  const sources = useMemo(
    () => datasets.filter((d: Dataset) => d.kind !== 'tractogram' && sampleChoices(d).length > 0),
    [datasets]
  );
  const [sourceId, setSourceId] = useState<string>('');
  const source = sources.find((d: Dataset) => d.id === sourceId) ?? sources[0];
  const choices = useMemo(() => (source === undefined ? [] : sampleChoices(source)), [source]);
  const [key, setKey] = useState<string>('');
  const choice = choices.find((c) => c.key === key) ?? choices[0];
  const [progress, setProgress] = useState<string | null>(null);
  const id = layer.id;
  return (
    <Section testId={`tracts-sample-${id}`} title="Sample onto tracts">
      {source === undefined || choice === undefined ? (
        <p className="text-[10px] text-tvx-dim">Open a volume or a tet mesh to sample from.</p>
      ) : (
        <>
          <Row label="From">
            <Select
              testId={`tracts-sample-source-${id}`}
              value={source.id}
              options={sources.map((d: Dataset) => ({ value: d.id, label: d.name }))}
              onChange={setSourceId}
            />
          </Row>
          <Row label="Field">
            <Select
              testId={`tracts-sample-field-${id}`}
              value={choice.key}
              options={choices.map((c) => ({ value: c.key, label: c.label }))}
              onChange={setKey}
            />
          </Row>
          <button
            type="button"
            data-testid={`tracts-sample-run-${id}`}
            disabled={progress !== null}
            className="mt-1 rounded border border-tvx-line px-1.5 text-[10px] disabled:opacity-50"
            onClick={() => {
              setProgress('0 %');
              void controller
                .sampleTracts(
                  { ...choice.spec, tractogramId: dataset.id },
                  layer.id,
                  (done, total) => setProgress(`${Math.round((100 * done) / Math.max(1, total))} %`)
                )
                .finally(() => setProgress(null));
            }}
          >
            {progress === null ? 'Sample' : `Sampling… ${progress}`}
          </button>
        </>
      )}
    </Section>
  );
}
