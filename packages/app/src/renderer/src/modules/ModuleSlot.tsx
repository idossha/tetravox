/**
 * The module slot — one docked section in the right column, above the Info panel (§13.3).
 *
 * **Why here and not floating.** The shell has no floating, draggable or popover primitive; pane
 * overlays are `pointer-events: none` by contract, so a palette over the canvas would fight the
 * WebGL grid for pointer capture; and at 1512 px the two sidebars already take 608 px, so a floating
 * editor would cover the very pane it asks the user to click in. **Why a section and not a tab.**
 * The feedback most module actions are judged by is the Info panel's Cursor block — the value under
 * the crosshair — and a tab would hide it at the moment it matters.
 *
 * Two structural details carry the layout, and both are load-bearing:
 *
 *  * it renders `null` with no module active — `MeasurePanel.tsx`'s idiom — so the DOM is
 *    byte-identical while the slot is idle and no existing E2E or golden moves;
 *  * it sits **outside** the Info panel's `min-h-0 flex-1 overflow-y-auto` container, which is what
 *    makes `max-h-[55%]` plus its own scroller a hard cap rather than a suggestion. Inside that
 *    container a tall module would squeeze the Info panel to zero.
 *
 * Nothing here knows any module: the title comes from the manifest and the body is whatever
 * component `activate` returned.
 */

import { useState } from 'react';

import { useController, useUi } from '../ui/context';

export function ModuleSlot(): React.JSX.Element | null {
  const controller = useController();
  const activeModule = useUi((s) => s.activeModule);
  const dirty = useUi((s) => (s.activeModule === null ? false : s.moduleDirty[s.activeModule]));
  // Re-read through the controller rather than caching: `activeModule` is set only once `activate`
  // resolved, so this is non-null exactly when the id is.
  const manifest = controller.activeModuleManifest();
  const Panel = controller.modulePanel();
  // Folded is view state and nothing else: the module stays activated, its layers stay in the scene
  // and its edits stay in its history — only the body is hidden, so the panes get the column back
  // without the user having to close (and re-open, and re-load) the editor.
  const [folded, setFolded] = useState(false);
  if (activeModule === null || manifest === null || Panel === null) return null;

  return (
    <section
      data-testid="module-slot"
      data-module={manifest.id}
      data-folded={folded}
      // `max-h-[55%]` of the aside, with the scroller inside: the module never pushes the Info panel
      // out of the column, however many rows it has. Folded there is no body to cap, so the section
      // is just its header — one line the user can click to get the editor back.
      className={`flex min-h-0 flex-col border-t border-tvx-line ${folded ? '' : 'max-h-[55%]'}`}
    >
      <header className="flex items-center justify-between px-2 pb-1 pt-1.5">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-wide text-tvx-dim">
          {manifest.title}
          {dirty === true && (
            <span
              data-testid="module-dirty"
              title="Unsaved edits in this extension"
              className="ml-1"
            >
              •
            </span>
          )}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {/* §13.10's pop-out. `'never'` is a module saying its panel is meaningless away from the
          Info panel's Cursor block — it gets no button rather than a disabled one. */}
          {manifest.ui?.popout !== 'never' && (
            <button
              type="button"
              data-testid="module-slot-popout"
              aria-label={`Open ${manifest.title} in its own window`}
              title={`Open ${manifest.title} in its own window. It keeps running — nothing is unloaded, and closing the window brings it back here.`}
              className="tvx-btn tvx-btn-sm"
              onClick={(event) => {
                event.currentTarget.blur();
                controller.setModulePlacement(manifest.id, 'window');
              }}
            >
              ⧉
            </button>
          )}
          <button
            type="button"
            data-testid="module-slot-fold"
            aria-expanded={!folded}
            aria-label={folded ? `Expand ${manifest.title}` : `Collapse ${manifest.title}`}
            title={
              folded
                ? `Expand ${manifest.title}`
                : `Collapse ${manifest.title}. It stays active — nothing is unloaded.`
            }
            className="tvx-btn tvx-btn-sm"
            onClick={(event) => {
              event.currentTarget.blur();
              setFolded((value) => !value);
            }}
          >
            {folded ? '▸' : '▾'}
          </button>
          <button
            type="button"
            data-testid="module-slot-close"
            aria-label={`Close ${manifest.title}`}
            title={`Close ${manifest.title}. Its layers stay in the scene; closing their dataset closes them.`}
            className="tvx-btn tvx-btn-sm"
            onClick={() => controller.deactivateModule()}
          >
            ✕
          </button>
        </div>
      </header>
      {!folded && (
        <div data-testid="module-slot-body" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <Panel />
        </div>
      )}
    </section>
  );
}
