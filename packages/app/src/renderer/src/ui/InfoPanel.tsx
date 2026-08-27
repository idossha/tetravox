/**
 * §8 info panel: two blocks with identical row structure.
 *
 * * `Cursor` — last click, persistent.
 * * `Mouse` — live, updates on pointermove, **blank when the pointer leaves a view**.
 *
 * Rows carry "per-layer voxel index / value / label name / element id / tag name / field values",
 * which is exactly `ProbeRow` (§4.7). Nothing is computed here: `Engine.probe(world)` produced every
 * cell, so a volume value is the retained typed array's (zero latency, §8's ≤ 16 ms) and a mesh row is
 * the `locate` op's.
 */

import type { ProbeResult, ProbeRow } from '@tetravox/engine';
import { formatNumber, formatTriple } from '../lib/coords';
import { useUi } from './context';

function valueText(value: ProbeRow['value']): string {
  if (value === undefined) return '—';
  if (typeof value === 'number') return formatNumber(value, 4);
  return value.map((c) => formatNumber(c, 3)).join(', ');
}

function fieldText(field: { name: string; value: number | number[] }): string {
  const value = Array.isArray(field.value)
    ? field.value.map((c) => formatNumber(c, 3)).join(', ')
    : formatNumber(field.value, 4);
  return `${field.name} = ${value}`;
}

function Row({ row }: { row: ProbeRow }): React.JSX.Element {
  return (
    <div
      data-testid={`probe-row-${row.layerId}`}
      data-layer-kind={row.kind}
      className="border-t border-tvx-line/60 py-1"
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[11px] text-tvx-text">{row.layerName}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-tvx-dim">
          {row.kind}
        </span>
      </div>
      <dl className="mt-0.5 grid grid-cols-[4.5rem_1fr] gap-x-2 font-mono text-[10px] text-tvx-dim">
        {row.voxel !== undefined && (
          <>
            <dt>voxel</dt>
            <dd data-testid="probe-voxel">{formatTriple(row.voxel, 0)}</dd>
          </>
        )}
        {row.value !== undefined && (
          <>
            <dt>value</dt>
            <dd data-testid="probe-value">{valueText(row.value)}</dd>
          </>
        )}
        {row.labelId !== undefined && (
          <>
            <dt>label</dt>
            <dd data-testid="probe-label">
              {row.labelId} · {row.labelName ?? '—'}
            </dd>
          </>
        )}
        {row.elementId !== undefined && (
          <>
            <dt>element</dt>
            <dd data-testid="probe-element">{row.elementId}</dd>
          </>
        )}
        {row.tag !== undefined && (
          <>
            <dt>tag</dt>
            <dd data-testid="probe-tag">
              {row.tag}
              {row.tagName ? ` · ${row.tagName}` : ''}
            </dd>
          </>
        )}
        {row.fields !== undefined &&
          row.fields.map((field) => (
            <div key={field.name} className="col-span-2 truncate" data-testid="probe-field">
              {fieldText(field)}
            </div>
          ))}
      </dl>
    </div>
  );
}

function Block({
  title,
  testId,
  probe,
  emptyText,
}: {
  title: string;
  testId: string;
  probe: ProbeResult | null;
  emptyText: string;
}): React.JSX.Element {
  return (
    <section data-testid={testId} className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">{title}</h3>
        <span data-testid={`${testId}-ras`} className="ml-auto font-mono text-[11px] text-tvx-text">
          {probe === null ? '—' : formatTriple(probe.world)}
        </span>
      </div>
      {probe !== null && probe.mni !== undefined && (
        <div className="mt-0.5 text-right font-mono text-[10px] text-tvx-dim">
          MNI {formatTriple(probe.mni)}
        </div>
      )}
      {probe === null || probe.rows.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="mt-1 text-[10px] text-tvx-dim">
          {emptyText}
        </p>
      ) : (
        <div className="mt-1">
          {probe.rows.map((row) => (
            <Row key={row.layerId} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

export function InfoPanel(): React.JSX.Element {
  const cursorProbe = useUi((s) => s.cursorProbe);
  const hoverProbe = useUi((s) => s.hoverProbe);
  const hover = useUi((s) => s.hover);
  return (
    <div data-testid="info-panel" className="flex flex-col overflow-y-auto">
      <Block
        title="Cursor"
        testId="info-cursor"
        probe={cursorProbe}
        emptyText="Click in a view to place the cursor."
      />
      <div className="border-t border-tvx-line" />
      <Block
        title="Mouse"
        testId="info-mouse"
        // §8: blank when the pointer leaves a view. `hover === null` is that state, and it is the
        // engine's `hover` event that says so — not a React mouseleave.
        probe={hover === null ? null : hoverProbe}
        emptyText="Pointer is outside every view."
      />
    </div>
  );
}
