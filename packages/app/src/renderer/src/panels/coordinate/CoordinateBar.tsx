/**
 * §8 coordinate bar, above the info panel: "editable `x y z` with a space selector (`World RAS` |
 * `Voxel (active layer)` | `MNI`), Enter jumps the cursor, a copy button yields `-42.0 18.0 6.0`,
 * paste accepts comma- or space-separated triples."
 *
 * **The MNI column is Phase 2's** (audit P2-10): §8 says it "appears when the dataset has
 * `toTemplate`", and E-SCENE derives that field in `scene/fromMeta.ts` from the NIfTI header
 * (`sform_code`/`qform_code` = 4 is MNI152). Absent is the *common* case on subject data — a SimNIBS
 * `m2m` T1 is `sform_code = 2` — so the option is rendered **greyed, with the reason on it**, rather
 * than hidden: a column that silently disappears reads as a bug, while one that says "not in a
 * template space" is telling the user something true about their data.
 *
 * A live read-out in the template's space sits under the field whenever a `toTemplate` exists, so
 * the value is visible without switching space to see it.
 */

import { useCallback, useState } from 'react';
import { formatTriple, worldToTemplate } from '../../lib/coords';
import type { CoordSpace } from '../../store/store';
import { templateSource } from '../../store/store';
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
  const template = useUi(templateSource);
  const [rejected, setRejected] = useState(false);

  // `cursor` and `activeLayerId` are read so the field re-renders when either moves; the text itself
  // comes from the controller, which owns every space conversion (§8: no logic in React).
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
      data-has-template={template !== null}
      className="flex flex-wrap items-center gap-1.5 border-b border-tvx-line bg-tvx-panel/60 px-3 py-1.5"
    >
      <select
        data-testid="coord-space"
        aria-label="Coordinate space"
        value={space}
        onChange={(e) => controller.setCoordSpace(e.currentTarget.value as CoordSpace)}
        className="tvx-input w-[8.5rem] text-[11px]"
      >
        <option value="ras">World RAS</option>
        <option value="voxel" disabled={!hasVoxelSpace}>
          Voxel (active)
        </option>
        <option
          value="mni"
          data-testid="coord-space-mni"
          disabled={template === null}
          title={
            template === null
              ? 'No loaded volume carries a toTemplate (§4.3) — nothing here is in a template space'
              : `${template.toTemplate.name} via ${template.name}`
          }
        >
          {template === null ? 'MNI (none)' : template.toTemplate.name}
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

      <div className="flex w-full items-baseline gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-tvx-dim">
          {template === null ? 'MNI' : template.toTemplate.name}
        </span>
        {template === null ? (
          <span
            data-testid="coord-mni-absent"
            className="font-mono text-[11px] text-tvx-dim/60"
            title="No loaded volume carries a toTemplate (§4.3, audit P2-10)"
          >
            — not in a template space
          </span>
        ) : (
          <span data-testid="coord-mni" className="font-mono text-[11px] text-tvx-text">
            {formatTriple(worldToTemplate(template.toTemplate.matrix, cursor))}
          </span>
        )}
      </div>
    </div>
  );
}
