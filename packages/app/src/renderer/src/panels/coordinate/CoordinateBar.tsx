/**
 * §8 coordinate bar, above the info panel: "editable `x y z` with a space selector (`World RAS` |
 * `Voxel (active layer)` | `MNI`), Enter jumps the cursor, a copy button yields `-42.0 18.0 6.0`,
 * paste accepts comma- or space-separated triples."
 *
 * The MNI column "appears when the dataset has `toTemplate`" — Phase 2 populates `toTemplate`, so the
 * option is offered only when a dataset actually carries one, which today is never. The parsing and
 * formatting are in `lib/coords.ts`, tested without a DOM.
 */

import { useCallback, useState } from 'react';
import { useController, useUi } from '../../ui/context';

export function CoordinateBar(): React.JSX.Element {
  const controller = useController();
  const space = useUi((s) => s.coordSpace);
  const draft = useUi((s) => s.coordDraft);
  const cursor = useUi((s) => s.cursor);
  const activeLayerId = useUi((s) => s.activeLayerId);
  const hasVoxelSpace = useUi((s) => {
    const layer = s.layers.find((l) => l.id === s.activeLayerId);
    if (layer === undefined) return false;
    return s.datasets.find((d) => d.id === layer.datasetId)?.kind === 'volume';
  });
  const [rejected, setRejected] = useState(false);

  // `cursor` and `activeLayerId` are read so the field re-renders when either moves; the text itself
  // comes from the controller, which owns the voxel conversion.
  void cursor;
  void activeLayerId;
  const text = controller.coordText();

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
      className="flex items-center gap-1.5 border-b border-tvx-line bg-tvx-panel/60 px-3 py-1.5"
    >
      <select
        data-testid="coord-space"
        aria-label="Coordinate space"
        value={space}
        onChange={(e) => controller.setCoordSpace(e.currentTarget.value as 'ras' | 'voxel')}
        className="tvx-input w-[8.5rem] text-[11px]"
      >
        <option value="ras">World RAS</option>
        <option value="voxel" disabled={!hasVoxelSpace}>
          Voxel (active)
        </option>
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
          'tvx-input flex-1 font-mono text-[11px] ' + (rejected ? 'border-tvx-danger' : '')
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
    </div>
  );
}
