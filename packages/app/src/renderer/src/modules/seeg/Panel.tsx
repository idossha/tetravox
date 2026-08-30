/**
 * The sEEG panel — what the module slot renders (ARCHITECTURE.md §13.3).
 *
 * Chrome only, exactly like every §8 panel: it reads `SeegView` through `useSyncExternalStore` and
 * every control is one `model` call, which is one command, which is also one job operation. There is
 * no `useController`, no `useUi` and no `Engine` here, and there cannot be — the module wall forbids
 * the imports that would make it possible.
 *
 * The layout is the design's, top to bottom: the source line, the electrode row (dropdown, count,
 * swatch, snap radius), two rows of buttons, the live shaft numbers, the contact list, and a footer
 * with Undo / Redo / Save / Save as… and the changed count. The whole thing lives inside the slot's
 * `max-h-[55%]` scroller, so the list is what scrolls and the footer is what stays.
 *
 * **Buttons blur on click**, which is not a style choice: the engine's Space-drag pan modifier is a
 * window keydown, so a focused button left focused turns the next Space into a button press
 * (`input/pointer.ts`). Every control here does it, including the ones in the list.
 */

import { useSyncExternalStore } from 'react';
import type { SeegModel, SeegRow } from './editor';

const CHORDS: Record<string, string> = {
  add: 'a',
  snap: 's',
  'snap-electrode': '⇧S',
  refit: 'f',
  'flip-tip': 't',
  ghost: 'g',
  next: 'n',
  prev: 'p',
  undo: 'z',
  redo: '⇧Z',
};

function blur(event: React.MouseEvent<HTMLElement>): void {
  event.currentTarget.blur();
}

function millimetres(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} mm`;
}

function ratio(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(0)} %`;
}

function StatusChip({ status }: { status: string }): React.JSX.Element {
  const tone =
    status === 'added' ? 'text-tvx-accent' : status === 'edited' ? 'text-tvx-warn' : 'text-tvx-dim';
  return <span className={`w-12 shrink-0 truncate ${tone}`}>{status}</span>;
}

function ContactRow({ row, model }: { row: SeegRow; model: SeegModel }): React.JSX.Element {
  return (
    <li
      data-testid={`seeg-row-${row.name}`}
      data-selected={row.selected}
      data-status={row.status}
      className={`flex items-center gap-1 text-[11px] ${row.selected ? 'text-tvx-text' : ''}`}
    >
      <button
        type="button"
        data-testid={`seeg-select-${row.name}`}
        className="w-16 shrink-0 truncate text-left tabular-nums hover:text-tvx-accent"
        title={row.tip ? `${row.name} — this electrode is numbered from here` : row.name}
        onClick={(event) => {
          blur(event);
          model.jumpTo(row.id);
        }}
      >
        {row.tip ? '▸' : ' '}
        {row.name}
      </button>
      <StatusChip status={row.status} />
      <span
        className="flex-1 text-right tabular-nums text-tvx-dim"
        title="from the active pane's plane"
      >
        {millimetres(row.offPlaneMm)}
      </span>
      <button
        type="button"
        data-testid={`seeg-jump-${row.name}`}
        className="tvx-btn tvx-btn-sm"
        title="Put the crosshair on this contact"
        onClick={(event) => {
          blur(event);
          model.jumpTo(row.id);
        }}
      >
        ↗
      </button>
      <button
        type="button"
        data-testid={`seeg-delete-${row.name}`}
        className="tvx-btn tvx-btn-sm"
        title="Delete this contact"
        onClick={(event) => {
          blur(event);
          model.deleteContact(row.id);
        }}
      >
        ✕
      </button>
    </li>
  );
}

export function SeegPanel({ model }: { model: SeegModel }): React.JSX.Element {
  const view = useSyncExternalStore(model.subscribe, model.state, model.state);

  const command =
    (id: string) =>
    (event: React.MouseEvent<HTMLElement>): void => {
      blur(event);
      void model.run(id);
    };

  const label = (id: string, text: string): string => {
    const chord = CHORDS[id];
    return chord === undefined ? text : `${text} (${chord})`;
  };

  return (
    <div data-testid="seeg-panel" className="flex flex-col gap-1.5 text-[11px]">
      <p
        data-testid="seeg-source"
        className="truncate text-tvx-dim"
        title="the files this is editing"
      >
        {view.ctName === null && view.tsvName === null ? (
          'Open a CT and its electrodes table.'
        ) : (
          <>
            {view.subject !== null && <span className="text-tvx-text">{view.subject} · </span>}
            {view.ctName ?? 'no CT'} · {view.tsvName ?? 'no table'}
          </>
        )}
      </p>

      {view.banner !== null && (
        <p data-testid="seeg-banner" className="text-tvx-warn">
          {view.banner}
        </p>
      )}
      {view.warning !== null && (
        <p data-testid="seeg-warning" className="text-tvx-warn">
          {view.warning}
        </p>
      )}
      {view.message !== null && (
        <p data-testid="seeg-message" className="text-tvx-dim">
          {view.message}
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <select
          data-testid="seeg-electrode"
          className="tvx-input min-w-0 flex-1"
          value={view.electrode ?? ''}
          disabled={view.electrodes.length === 0}
          onChange={(event) => model.setElectrode(event.target.value)}
        >
          {view.electrodes.length === 0 && <option value="">no electrodes</option>}
          {view.electrodes.map((option) => (
            <option key={option.name} value={option.name}>
              {option.name} ({option.count})
            </option>
          ))}
        </select>
        <span
          data-testid="seeg-swatch"
          className="h-3 w-3 shrink-0 rounded-sm border border-tvx-line"
          style={{
            backgroundColor:
              view.electrodes.find((e) => e.name === view.electrode)?.color ?? 'transparent',
          }}
        />
        <label className="flex shrink-0 items-center gap-1 text-tvx-dim" title="snap radius">
          r
          <input
            data-testid="seeg-radius"
            type="number"
            className="tvx-input w-14 tabular-nums"
            min={0.5}
            max={5}
            step={0.25}
            value={view.snapRadiusMm}
            onChange={(event) => model.setSnapRadius(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-testid="seeg-add"
          aria-pressed={view.placing}
          className={`tvx-btn ${view.placing ? 'tvx-btn-on' : ''}`}
          title={label('add', 'Every click in a pane drops a contact on this electrode')}
          onClick={command('add')}
        >
          Add
        </button>
        <button
          type="button"
          data-testid="seeg-snap"
          className="tvx-btn"
          disabled={view.selectedId === null}
          title={label('snap', 'Snap the selected contact to the local CT peak')}
          onClick={command('snap')}
        >
          Snap
        </button>
        <button
          type="button"
          data-testid="seeg-snap-electrode"
          className="tvx-btn"
          title={label('snap-electrode', 'Snap every contact of this electrode')}
          onClick={command('snap-electrode')}
        >
          Snap elec
        </button>
        <button
          type="button"
          data-testid="seeg-snap-all"
          className="tvx-btn"
          title="Snap every contact of every electrode (asks first)"
          onClick={command('snap-all')}
        >
          Snap all…
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-testid="seeg-refit"
          className="tvx-btn"
          title={label('refit', 'Fit a line, re-space evenly at the median gap, relabel tip-first')}
          onClick={command('refit')}
        >
          Re-fit
        </button>
        <button
          type="button"
          data-testid="seeg-renumber"
          className="tvx-btn"
          title="Number this electrode 1…n from the tip, without moving anything"
          onClick={command('renumber')}
        >
          Renumber
        </button>
        <button
          type="button"
          data-testid="seeg-flip-tip"
          className="tvx-btn"
          title={label('flip-tip', 'Use the other end of this electrode as contact 1')}
          onClick={command('flip-tip')}
        >
          Flip tip
        </button>
        <button
          type="button"
          data-testid="seeg-ghost"
          aria-pressed={view.ghost}
          className={`tvx-btn ${view.ghost ? 'tvx-btn-on' : ''}`}
          title={label('ghost', 'Draw off-slice contacts, so a shaft reads as a shaft')}
          onClick={command('ghost')}
        >
          Ghost
        </button>
        <button
          type="button"
          data-testid="seeg-revert"
          className="tvx-btn"
          title="Put every contact back where the table had it"
          onClick={command('revert')}
        >
          Revert
        </button>
      </div>

      <p data-testid="seeg-stats" className="tabular-nums text-tvx-dim">
        {view.stats === null ? (
          'no electrode selected'
        ) : (
          <>
            rms {millimetres(view.stats.rmsMm)} · spacing cv {ratio(view.stats.spacingCv)} · pitch{' '}
            {millimetres(view.stats.pitchMm)}
            {view.tipName !== null && (
              <>
                {' '}
                · tip <span data-testid="seeg-tip">{view.tipName}</span>
              </>
            )}
          </>
        )}
      </p>

      <ul data-testid="seeg-list" className="flex flex-col gap-0.5">
        {view.rows.map((row) => (
          <ContactRow key={row.id} row={row} model={model} />
        ))}
      </ul>

      <div className="flex items-center gap-1 border-t border-tvx-line pt-1">
        <button
          type="button"
          data-testid="seeg-undo"
          className="tvx-btn"
          disabled={!view.canUndo}
          title={label('undo', 'Undo the last edit')}
          onClick={command('undo')}
        >
          Undo
        </button>
        <button
          type="button"
          data-testid="seeg-redo"
          className="tvx-btn"
          disabled={!view.canRedo}
          title={label('redo', 'Redo')}
          onClick={command('redo')}
        >
          Redo
        </button>
        <button
          type="button"
          data-testid="seeg-save"
          className="tvx-btn"
          disabled={view.busy}
          title="Write the table, its backup and its editlog"
          onClick={command('save')}
        >
          Save
        </button>
        <button
          type="button"
          data-testid="seeg-save-as"
          className="tvx-btn"
          disabled={view.busy}
          title="Choose where to write the table"
          onClick={command('save-as')}
        >
          Save as…
        </button>
        <span data-testid="seeg-changed" className="ml-auto tabular-nums text-tvx-dim">
          {view.dirty && '• '}
          {view.changed} changed
        </span>
      </div>
    </div>
  );
}
