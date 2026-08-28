/**
 * §8 coordinate bar, above the info panel: "editable `x y z` with a space selector, Enter jumps the
 * cursor, a copy button yields `-42.0 18.0 6.0`, paste accepts comma- or space-separated triples."
 *
 * **Directed task 8 widened the selector.** Phase 2 offered three fixed entries — World RAS, Voxel
 * (active), MNI — with the MNI one greyed and a reason on it, because on a SimNIBS subject nothing
 * carries an MNI `sform_code`. The menu is now whatever `Engine.coordinateSpaces()` says: world RAS,
 * a voxel and a **tkr-RAS** entry per loaded volume, and — when a `toMNI/` folder was found beside
 * the subject — `MNI152 (affine)` and `MNI152 (nonlinear)` as two separate entries, because they are
 * two different answers and a readout that merged them would not say which one the user is quoting.
 *
 * Phase 2's rule survives intact and is now applied to all of them: a space that cannot be used is
 * **listed, disabled, with the reason on it**, never hidden. A column that silently disappears reads
 * as a bug; one that says "this subject has no MNI2conform_*DOF affine" is telling the user
 * something true about their data.
 *
 * No conversion happens in this file. The label, the decimals, the enabled state, the value and the
 * parse all come from the controller and the facade (§8: "no logic in React").
 */

import { useCallback, useState } from 'react';
import type { CoordSpaceOption } from '@tetravox/engine';
import { sameSpace, spaceFromKey, spaceKey } from '../../store/store';
import { useController, useUi } from '../../ui/context';

/** The live rows under the field: every derived space at once, so none of them needs a click. */
function Readout({ options }: { options: CoordSpaceOption[] }): React.JSX.Element | null {
  const controller = useController();
  const cursor = useUi((s) => s.cursor);
  // Only the *derived* spaces get a row — world RAS is already in the field above and a voxel index
  // is on every info-panel row. What earns a permanent line is what a user copies into a paper.
  const rows = options.filter((o) => o.ref.space === 'tkr' || o.ref.space.startsWith('mni'));
  if (rows.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-0.5" data-testid="coord-readout">
      {rows.map((option) => {
        const value = option.enabled ? controller.coordInSpace(option.ref) : null;
        return (
          <div key={spaceKey(option.ref)} className="flex items-baseline gap-1.5">
            <span className="min-w-[8.5rem] shrink-0 text-[10px] uppercase tracking-wider text-tvx-dim">
              {option.label}
            </span>
            <span
              data-testid={`coord-readout-${spaceKey(option.ref)}`}
              data-space={option.ref.space}
              title={option.reason}
              className={
                'truncate font-mono text-[11px] ' +
                (value === null ? 'text-tvx-dim/60' : 'text-tvx-text')
              }
            >
              {value ?? `— ${option.reason ?? 'not available'}`}
            </span>
          </div>
        );
      })}
      {/* `cursor` is read so the rows follow the crosshair; the values themselves are the engine's. */}
      <span className="hidden">{cursor.length}</span>
    </div>
  );
}

export function CoordinateBar(): React.JSX.Element {
  const controller = useController();
  const space = useUi((s) => s.coordSpace);
  const draft = useUi((s) => s.coordDraft);
  const cursor = useUi((s) => s.cursor);
  const activeLayerId = useUi((s) => s.activeLayerId);
  const datasets = useUi((s) => s.datasets);
  const [rejected, setRejected] = useState(false);

  // `cursor`, `activeLayerId` and `datasets` are read so the bar re-renders when any of them moves:
  // the menu is derived from the scene, the text from the cursor. Neither is computed here —
  // `coordinateSpaces()` and `coordText()` are the controller's (§8).
  void cursor;
  void activeLayerId;
  void datasets;
  const options = controller.coordinateSpaces();
  const text = controller.coordText();
  const current = options.find((o) => sameSpace(o.ref, space) && o.enabled) ?? options[0];

  const commit = useCallback(
    (value: string) => {
      const ok = controller.jumpToCoordinate(value);
      setRejected(!ok);
      if (ok) controller.setCoordDraft(null);
    },
    [controller]
  );

  return (
    <div
      data-testid="coord-bar"
      data-space={current === undefined ? 'world' : current.ref.space}
      className="flex flex-wrap items-center gap-1.5 border-b border-tvx-line bg-tvx-panel/60 px-3 py-1.5"
    >
      <select
        data-testid="coord-space"
        aria-label="Coordinate space"
        value={current === undefined ? 'world' : spaceKey(current.ref)}
        onChange={(e) => {
          const ref = spaceFromKey(e.currentTarget.value);
          if (ref !== null) controller.setCoordSpace(ref);
        }}
        className="tvx-input w-[11rem] text-[11px]"
      >
        {options.map((option) => (
          <option
            key={spaceKey(option.ref)}
            value={spaceKey(option.ref)}
            data-testid={`coord-space-${spaceKey(option.ref)}`}
            disabled={!option.enabled}
            title={option.reason}
          >
            {option.label}
            {option.enabled ? '' : option.loading === true ? ' — loading…' : ' — unavailable'}
          </option>
        ))}
      </select>

      <input
        data-testid="coord-input"
        aria-label="Cursor coordinate"
        aria-invalid={rejected}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setRejected(false);
          controller.setCoordDraft(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(e.currentTarget.value);
          } else if (e.key === 'Escape') {
            controller.setCoordDraft(null);
            setRejected(false);
          }
        }}
        onBlur={() => {
          controller.setCoordDraft(null);
          setRejected(false);
        }}
        className={
          'tvx-input min-w-[9rem] flex-1 font-mono text-[11px] ' +
          (rejected ? 'border-tvx-danger' : '')
        }
      />

      <button
        type="button"
        data-testid="coord-copy"
        className="tvx-btn tvx-btn-sm"
        onClick={() => void controller.copyCoordinate()}
      >
        Copy
      </button>
      <button
        type="button"
        data-testid="coord-paste"
        className="tvx-btn tvx-btn-sm"
        onClick={() => void controller.pasteCoordinate().then((ok) => setRejected(!ok))}
      >
        Paste
      </button>
      {rejected && (
        <span data-testid="coord-error" className="text-[10px] text-tvx-danger">
          need three numbers
        </span>
      )}
      {draft !== null && !rejected && (
        <span data-testid="coord-editing" className="text-[10px] text-tvx-dim">
          ⏎ to jump
        </span>
      )}

      <Readout options={options} />
    </div>
  );
}
