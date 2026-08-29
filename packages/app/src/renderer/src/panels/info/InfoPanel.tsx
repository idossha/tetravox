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
import { formatNumber, formatTriple } from '../../lib/coords';
import { useController, useUi } from '../../ui/context';

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

/**
 * One `<dt>/<dd>` line. `pending` is the placeholder for a slot whose answer has not arrived — a
 * mesh row's `element`/`tag`/`vertex` come from an async `locate` a frame after the sync volume
 * values — so the line is *there* from the first paint and the block never grows under the reader.
 */
function Line({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId} className="truncate tabular-nums">
        {children}
      </dd>
    </>
  );
}

const PENDING = '—';

function Row({ row }: { row: ProbeRow }): React.JSX.Element {
  // The slot set is a function of the layer *kind*, not of which answers happen to be present, so
  // the row's height is the same before and after an async mesh answer lands, and the same for a
  // point inside the mesh as for one outside it. That is what stops the panel jittering as the
  // cursor is dragged: every move used to paint a short row, then a taller one a frame later.
  const isMesh = row.kind === 'mesh' || row.kind === 'iso';
  const isVolume = row.kind === 'volume';
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
        {(isVolume || row.voxel !== undefined) && (
          <Line label="voxel" testId="probe-voxel">
            {row.voxel === undefined ? PENDING : formatTriple(row.voxel, 0)}
          </Line>
        )}
        {(isVolume || row.value !== undefined) && (
          <Line label="value" testId="probe-value">
            {valueText(row.value)}
          </Line>
        )}
        {row.labelId !== undefined && (
          <Line label="label" testId="probe-label">
            {row.labelId} · {row.labelName ?? PENDING}
          </Line>
        )}
        {(isMesh || row.elementId !== undefined) && (
          <Line label="element" testId="probe-element">
            {row.elementId ?? PENDING}
          </Line>
        )}
        {(isMesh || row.tag !== undefined) && (
          <Line label="tag" testId="probe-tag">
            {row.tag === undefined ? PENDING : row.tag}
            {row.tagName ? ` · ${row.tagName}` : ''}
          </Line>
        )}
        {(isMesh || row.vertex !== undefined) && (
          <Line label="vertex" testId="probe-vertex">
            {row.vertex === undefined ? PENDING : row.vertex}
            {row.vertexWorld === undefined ? '' : ` · RAS ${formatTriple(row.vertexWorld)}`}
          </Line>
        )}
        {row.fsavgVertex !== undefined && (
          <Line label={row.fsavgSpace ?? 'fsaverage'} testId="probe-fsavg">
            vertex {row.fsavgVertex}
            {row.fsavgWorld === undefined ? '' : ` · ${formatTriple(row.fsavgWorld)}`}
          </Line>
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
  collapsed,
  onToggle,
  compact = false,
}: {
  title: string;
  testId: string;
  probe: ProbeResult | null;
  emptyText: string;
  /** Present ⇒ the header carries a disclosure and the body is hidden while `true`. */
  collapsed?: boolean;
  onToggle?: () => void;
  /**
   * Skip the world triple and the derived-space lines. The `Cursor` block sits directly under the
   * coordinate bar, which *is* the cursor — in the chosen space, editable, with every tkr/MNI
   * readout beneath it — so printing the same numbers a third time under a heading was noise. The
   * `Mouse` block keeps its triple: that is a different point, and the bar does not show it.
   */
  compact?: boolean;
}): React.JSX.Element {
  const collapsible = onToggle !== undefined;
  return (
    <section data-testid={testId} className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        {collapsible ? (
          <button
            type="button"
            data-testid={`${testId}-toggle`}
            aria-expanded={!collapsed}
            className="tvx-btn tvx-btn-sm w-5 shrink-0 self-center"
            onClick={onToggle}
            title={collapsed ? `Show the ${title} block` : `Hide the ${title} block`}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : null}
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">{title}</h3>
        {compact ? null : (
          <>
            <span className="ml-auto text-[10px] uppercase tracking-wider text-tvx-dim">RAS</span>
            <span
              data-testid={`${testId}-ras`}
              className="font-mono text-[11px] tabular-nums text-tvx-text"
            >
              {probe === null ? '—' : formatTriple(probe.world)}
            </span>
          </>
        )}
      </div>
      {collapsed === true ? null : (
        <>
          {/*
        Directed task 8: **every value is labelled with its space.** The world triple beside the
        heading is `RAS`, and each derived space gets its own line naming itself — `tkr-RAS · T1`
        rather than a bare triple, and `MNI152 (affine)` and `MNI152 (nonlinear)` as two lines
        rather than one merged "MNI", because they are two different numbers and a reader has to be
        able to say which one they wrote down.
      */}
          {!compact && probe !== null && probe.tkr !== undefined && (
            <div
              data-testid={`${testId}-tkr`}
              className="mt-0.5 text-right font-mono text-[10px] text-tvx-dim"
            >
              <span className="mr-1 uppercase tracking-wider">
                tkr-RAS{probe.tkrVolume === undefined ? '' : ` · ${probe.tkrVolume}`}
              </span>
              {formatTriple(probe.tkr)}
            </div>
          )}
          {!compact && probe !== null && probe.mni !== undefined && (
            <div
              data-testid={`${testId}-mni`}
              className="mt-0.5 text-right font-mono text-[10px] text-tvx-dim"
            >
              <span className="mr-1 uppercase tracking-wider">MNI (affine)</span>
              {formatTriple(probe.mni)}
            </div>
          )}
          {!compact && probe !== null && probe.mniNonlinear !== undefined && (
            <div
              data-testid={`${testId}-mni-nonlinear`}
              className="mt-0.5 text-right font-mono text-[10px] text-tvx-dim"
            >
              <span className="mr-1 uppercase tracking-wider">MNI (nonlinear)</span>
              {formatTriple(probe.mniNonlinear)}
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
        </>
      )}
    </section>
  );
}

export function InfoPanel(): React.JSX.Element {
  const cursorProbe = useUi((s) => s.cursorProbe);
  const hoverProbe = useUi((s) => s.hoverProbe);
  const hover = useUi((s) => s.hover);
  const mouseCollapsed = useUi((s) => s.mouseBlockCollapsed);
  const controller = useController();
  return (
    // The right column scrolls as a whole (`ui/Shell.tsx`), so this block does not scroll itself —
    // two nested scrollers would hide the header panel behind a second, invisible scrollbar.
    <div data-testid="info-panel" className="flex shrink-0 flex-col">
      <Block
        title="Cursor"
        testId="info-cursor"
        probe={cursorProbe}
        emptyText="Click in a view to place the cursor."
        compact
      />
      <div className="border-t border-tvx-line" />
      <Block
        title="Mouse"
        testId="info-mouse"
        // §8: blank when the pointer leaves a view. `hover === null` is that state, and it is the
        // engine's `hover` event that says so — not a React mouseleave.
        probe={hover === null ? null : hoverProbe}
        emptyText="Pointer is outside every view."
        collapsed={mouseCollapsed}
        onToggle={() => controller.toggleMouseBlock()}
      />
    </div>
  );
}
