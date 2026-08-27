/**
 * §4.4's `IsolateSpec`, as a panel: tags, a field range, a sphere taken **from the cursor**, a box,
 * and a label-volume selection — combined with `all` (∩) or `any` (∪).
 *
 * The field range is a pair of numbers rather than a histogram: `docs/PHASE2-OWNERSHIP.md` gives the
 * histogram widget to the other half of A-PROPS and tells this half to use it "if half 1's widget
 * exists on main, else a simple range input". On `main`, `panels/histogram/Histogram.tsx` returns
 * `null`, so this is the range input — and it is a two-line change to swap it later, because the
 * value the widget would produce is exactly the `(lo, hi)` these two fields commit.
 *
 * The label-volume clause reads the label volumes already open in the scene (§4.3's `labelTable`),
 * which is the same selection §8 says wires into `MeshLayer.isolate.labelVolume.labels`.
 */

import { useMemo, useState } from 'react';
import type { MeshDataset, MeshLayer, VolumeDataset } from '@tetravox/engine';
import { useController, useUi } from '../../../ui/context';
import { NumberField, Row, Section, Select, Toggle } from './controls';
import {
  clearIsolate,
  clearIsolateClause,
  fieldKey,
  findField,
  isolateOf,
  setIsolateBox,
  setIsolateCombine,
  setIsolateField,
  setIsolateFieldRange,
  setIsolateSphere,
  toggleIsolateLabel,
  toggleIsolateTag,
} from './state';

export function Isolation({
  dataset,
  layer,
}: {
  dataset: MeshDataset;
  layer: MeshLayer;
}): React.JSX.Element {
  const controller = useController();
  const cursor = useUi((s) => s.cursor);
  const datasets = useUi((s) => s.datasets);
  const [radius, setRadius] = useState(10);
  const spec = isolateOf(layer);
  const patch = (p: Partial<MeshLayer>): void => controller.patchLayer(layer.id, p);

  const labelVolumes = useMemo(
    () =>
      datasets.filter(
        (d): d is VolumeDataset => d.kind === 'volume' && d.isLabel && d.labelTable !== undefined
      ),
    [datasets]
  );
  const chosenVolume =
    labelVolumes.find((d) => d.id === spec.labelVolume?.datasetId) ?? labelVolumes[0] ?? null;

  const active =
    (spec.tags?.length ?? 0) > 0 ||
    spec.field !== undefined ||
    spec.sphere !== undefined ||
    spec.box !== undefined ||
    (spec.labelVolume?.labels.length ?? 0) > 0;

  return (
    <Section
      testId={`mesh-isolate-${layer.id}`}
      title="Isolation"
      right={
        <span
          data-testid={`mesh-isolate-state-${layer.id}`}
          className="shrink-0 font-mono text-[9px] text-tvx-dim"
        >
          {active ? spec.combine : 'off'}
        </span>
      }
    >
      <Row label="Combine">
        <Select
          testId={`mesh-isolate-combine-${layer.id}`}
          value={spec.combine}
          options={[
            { value: 'all', label: 'all (∩)' },
            { value: 'any', label: 'any (∪)' },
          ]}
          disabled={!active}
          onChange={(c) => patch(setIsolateCombine(layer, c))}
        />
        <button
          type="button"
          data-testid={`mesh-isolate-clear-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          disabled={!active}
          onClick={(e) => {
            e.stopPropagation();
            patch(clearIsolate(layer));
          }}
        >
          clear
        </button>
      </Row>

      <p className="text-[9px] uppercase tracking-wider text-tvx-dim">Tags</p>
      <div
        data-testid={`mesh-isolate-tags-${layer.id}`}
        className="flex flex-wrap gap-1"
        data-selected={(spec.tags ?? []).join(',')}
      >
        {dataset.tags.map((t) => (
          <Toggle
            key={t.id}
            testId={`mesh-isolate-tag-${layer.id}-${t.id}`}
            label={`${t.name ?? t.id}`}
            on={(spec.tags ?? []).includes(t.id)}
            title={`tag ${t.id} · ${t.kind} · ${t.count.toLocaleString()}`}
            onChange={() => patch(toggleIsolateTag(layer, t.id))}
          />
        ))}
      </div>

      {dataset.fields.length === 0 ? null : (
        <>
          <p className="text-[9px] uppercase tracking-wider text-tvx-dim">Field range</p>
          <Row label="Field">
            <Select
              testId={`mesh-isolate-field-${layer.id}`}
              value={spec.field === undefined ? '' : fieldKey(spec.field)}
              options={[
                { value: '', label: '—' },
                ...dataset.fields.map((f) => ({
                  value: fieldKey(f),
                  label: `${f.name} (${f.source})`,
                })),
              ]}
              onChange={(key) =>
                patch(
                  key === ''
                    ? clearIsolateClause(layer, 'field')
                    : setIsolateField(dataset, layer, key)
                )
              }
            />
          </Row>
          {spec.field === undefined ? null : (
            <Row label="lo / hi">
              <NumberField
                testId={`mesh-isolate-field-lo-${layer.id}`}
                value={spec.field.lo}
                step={rangeStep(dataset, spec.field.name, spec.field.source)}
                width="w-20"
                onCommit={(v) => patch(setIsolateFieldRange(layer, v, spec.field?.hi ?? v))}
              />
              <NumberField
                testId={`mesh-isolate-field-hi-${layer.id}`}
                value={spec.field.hi}
                step={rangeStep(dataset, spec.field.name, spec.field.source)}
                width="w-20"
                onCommit={(v) => patch(setIsolateFieldRange(layer, spec.field?.lo ?? v, v))}
              />
            </Row>
          )}
        </>
      )}

      <p className="text-[9px] uppercase tracking-wider text-tvx-dim">Sphere</p>
      <Row label="Radius mm">
        <NumberField
          testId={`mesh-isolate-radius-${layer.id}`}
          value={spec.sphere?.radius ?? radius}
          step={1}
          min={0}
          onCommit={(v) => {
            setRadius(v);
            if (spec.sphere !== undefined) patch(setIsolateSphere(layer, spec.sphere.center, v));
          }}
        />
        <button
          type="button"
          data-testid={`mesh-isolate-sphere-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          title="Centre the sphere on the cursor (§8)"
          onClick={(e) => {
            e.stopPropagation();
            patch(setIsolateSphere(layer, cursor, spec.sphere?.radius ?? radius));
          }}
        >
          at cursor
        </button>
        {spec.sphere === undefined ? null : (
          <button
            type="button"
            data-testid={`mesh-isolate-sphere-clear-${layer.id}`}
            className="tvx-btn tvx-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              patch(clearIsolateClause(layer, 'sphere'));
            }}
          >
            ✕
          </button>
        )}
      </Row>
      {spec.sphere === undefined ? null : (
        <p
          data-testid={`mesh-isolate-sphere-centre-${layer.id}`}
          className="font-mono text-[9px] text-tvx-dim"
        >
          centre {spec.sphere.center.map((c) => c.toFixed(1)).join(' ')}
        </p>
      )}

      <p className="text-[9px] uppercase tracking-wider text-tvx-dim">Box</p>
      <Row label="Around cursor">
        <NumberField
          testId={`mesh-isolate-box-half-${layer.id}`}
          value={radius}
          step={1}
          min={0}
          onCommit={setRadius}
        />
        <button
          type="button"
          data-testid={`mesh-isolate-box-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            patch(
              setIsolateBox(
                layer,
                [cursor[0] - radius, cursor[1] - radius, cursor[2] - radius],
                [cursor[0] + radius, cursor[1] + radius, cursor[2] + radius]
              )
            );
          }}
        >
          set
        </button>
        <button
          type="button"
          data-testid={`mesh-isolate-box-all-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          title="The whole mesh bounding box"
          onClick={(e) => {
            e.stopPropagation();
            patch(setIsolateBox(layer, dataset.bounds.min, dataset.bounds.max));
          }}
        >
          bbox
        </button>
        {spec.box === undefined ? null : (
          <button
            type="button"
            data-testid={`mesh-isolate-box-clear-${layer.id}`}
            className="tvx-btn tvx-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              patch(clearIsolateClause(layer, 'box'));
            }}
          >
            ✕
          </button>
        )}
      </Row>

      <p className="text-[9px] uppercase tracking-wider text-tvx-dim">Label volume</p>
      {chosenVolume === null ? (
        <p data-testid={`mesh-isolate-nolabels-${layer.id}`} className="text-[10px] text-tvx-dim">
          Open a label volume (<code>final_tissues.nii.gz</code>, <code>labeling.nii.gz</code>) to
          isolate by region.
        </p>
      ) : (
        <div
          data-testid={`mesh-isolate-labels-${layer.id}`}
          data-volume={chosenVolume.id}
          data-selected={(spec.labelVolume?.labels ?? []).join(',')}
          className="flex max-h-24 flex-wrap gap-1 overflow-y-auto"
        >
          {(chosenVolume.labelTable?.entries ?? []).map((entry) => (
            <Toggle
              key={entry.id}
              testId={`mesh-isolate-label-${layer.id}-${entry.id}`}
              label={entry.name}
              on={(spec.labelVolume?.labels ?? []).includes(entry.id)}
              onChange={() => patch(toggleIsolateLabel(layer, chosenVolume, 0, entry.id))}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

/** A step the user can actually use: a hundredth of the field's own range. */
function rangeStep(dataset: MeshDataset, name: string, source: 'node' | 'elm'): number {
  const field = findField(dataset, fieldKey({ source, name }));
  if (field === null) return 0.01;
  const span = field.stats.max - field.stats.min;
  return span > 0 ? span / 100 : 0.01;
}
