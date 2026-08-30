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

import { useController, useUi } from '../ui/context';

export function ModuleSlot(): React.JSX.Element | null {
  const controller = useController();
  const activeModule = useUi((s) => s.activeModule);
  const dirty = useUi((s) => (s.activeModule === null ? false : s.moduleDirty[s.activeModule]));
  // Re-read through the controller rather than caching: `activeModule` is set only once `activate`
  // resolved, so this is non-null exactly when the id is.
  const manifest = controller.activeModuleManifest();
  const Panel = controller.modulePanel();
  if (activeModule === null || manifest === null || Panel === null) return null;

  return (
    <section
      data-testid="module-slot"
      data-module={manifest.id}
      // `max-h-[55%]` of the aside, with the scroller inside: the module never pushes the Info panel
      // out of the column, however many rows it has.
      className="flex max-h-[55%] min-h-0 flex-col border-t border-tvx-line"
    >
      <header className="flex items-center justify-between px-2 pb-1 pt-1.5">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-wide text-tvx-dim">
          {manifest.title}
          {dirty === true && (
            <span data-testid="module-dirty" title="Unsaved edits in this module" className="ml-1">
              •
            </span>
          )}
        </h2>
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
      </header>
      <div data-testid="module-slot-body" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <Panel />
      </div>
    </section>
  );
}
