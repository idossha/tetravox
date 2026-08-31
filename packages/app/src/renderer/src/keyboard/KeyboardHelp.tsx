/**
 * The keyboard-map help sheet (ROADMAP Phase 2, "keyboard map"; §7.5's bindings).
 *
 * The rows come from `bindings.ts`, which **derives** them by asking `keymap.ts`'s resolver, so a
 * sheet can never list a binding the resolver does not implement. Nothing about the layout is
 * clever: it is a modal over the shell, dismissed with Escape or a click outside, and its body is a
 * `Tabs` strip (the same component and styling `SettingsDialog` uses) grouping the generated key
 * sections and §7.5's pointer gestures — which live on the canvas and therefore cannot be derived
 * (see `bindings.ts` for why that split is honest rather than a shortcut) — into three tabs so the
 * sheet reads in one screen at 1280×860 instead of one long two-column scroll.
 *
 * The grouping: **View** (View, Camera presets, Panels — everything about what's on screen),
 * **Cursor & Layers** (Cursor, Layers, Measure — everything about picking and manipulating data),
 * **Mouse** (the 2D-pane and 3D-pane pointer gestures, which are the engine's, not the map's).
 *
 * The last tab opened is remembered for the session in a module-level variable, not the store — it
 * is a UI convenience, not scene or machine state, so it does not belong in `settings.json` or a
 * scene file, and does not need to survive a relaunch.
 */

import { useEffect, useRef, useState } from 'react';
import { Tabs } from '../ui/Tabs';
import type { TabItem } from '../ui/Tabs';
import { POINTER_GESTURES, keyBindingSections, moduleKeyRows } from './bindings';
import type { KeySection, ModuleKeyRow } from './bindings';
// Modules (2026-08-30, §13.5): a fourth tab, present only while a module is active.
import { useController, useUi } from '../ui/context';

export interface KeyboardHelpProps {
  open: boolean;
  onClose(): void;
}

type KeymapTab = 'view' | 'cursor-layers' | 'mouse' | 'modules';

const TABS: readonly TabItem<KeymapTab>[] = [
  { id: 'view', label: 'View' },
  { id: 'cursor-layers', label: 'Cursor & Layers' },
  { id: 'mouse', label: 'Mouse' },
];

/**
 * §13.5's tab, added only while a module is active — its keys are live only then, and a permanent
 * tab that was empty most of the time would be worse than no tab at all.
 */
const MODULES_TAB: TabItem<KeymapTab> = { id: 'modules', label: 'Extensions' };

/** Which generated `KeySection` titles (from `bindings.ts`) belong to which tab. */
const SECTION_GROUPS: Record<KeymapTab, readonly string[]> = {
  view: ['View', 'Camera presets', 'Panels'],
  'cursor-layers': ['Cursor', 'Layers', 'Measure'],
  mouse: [],
  modules: [],
};

/** Which `POINTER_GESTURES` group titles belong to which tab. Only Mouse has any. */
const GESTURE_GROUPS: Record<KeymapTab, readonly string[]> = {
  view: [],
  'cursor-layers': [],
  mouse: ['2D panes', '3D pane'],
  modules: [],
};

/** Remembered for the session only — see the file header. */
let lastTab: KeymapTab = 'view';

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-tvx-line bg-tvx-bg/70 px-1.5 py-0.5 font-mono text-[10px] text-tvx-accent">
      {children}
    </kbd>
  );
}

function SectionBlock({ section }: { section: KeySection }): React.JSX.Element {
  return (
    <section data-testid={`keyhelp-section-${section.title}`}>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
        {section.title}
      </h3>
      <dl className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-2 gap-y-1">
        {section.bindings.map((binding) => (
          <div key={`${binding.chord}-${binding.kind}`} className="contents">
            <dt data-testid="keyhelp-chord">
              <Kbd>{binding.chord}</Kbd>
            </dt>
            <dd data-testid="keyhelp-description" className="text-[11px] text-tvx-text">
              {binding.description}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function KeyboardHelp({ open, onClose }: KeyboardHelpProps): React.JSX.Element | null {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [tab, setTab] = useState<KeymapTab>(lastTab);
  // §13.5. Read here rather than passed in: the sheet is mounted by `ShellDialogs`, which has no
  // reason to know about modules, and these rows change with whatever is in the slot.
  const controller = useController();
  const activeModule = useUi((s) => s.activeModule);
  const moduleManifest = activeModule === null ? null : controller.activeModuleManifest();
  const moduleRows: ModuleKeyRow[] = moduleKeyRows(moduleManifest);

  const onTab = (id: KeymapTab): void => {
    lastTab = id;
    setTab(id);
  };

  // Escape closes it. Bound on the window rather than inside the dialog so it works before focus
  // lands, and **captured** so it never reaches the §7.5 resolver underneath — otherwise dismissing
  // the sheet would also run whatever command that key is bound to.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!open) return null;
  const tabs = moduleRows.length > 0 ? [...TABS, MODULES_TAB] : TABS;
  // A module closed while its tab was open leaves `tab` pointing at a tab that is gone; fall back to
  // the first rather than rendering an empty panel.
  const activeTab: KeymapTab = tabs.some((t) => t.id === tab) ? tab : 'view';
  const sections = keyBindingSections();
  const visibleSections = sections.filter((s) => SECTION_GROUPS[activeTab].includes(s.title));
  const visibleGestureGroups = POINTER_GESTURES.filter((g) =>
    GESTURE_GROUPS[activeTab].includes(g.title)
  );

  return (
    <div
      data-testid="keyboard-help"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="absolute inset-0 z-40 grid place-items-center bg-tvx-bg/70 p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-[46rem] max-w-full flex-col overflow-hidden rounded border border-tvx-line bg-tvx-panel shadow-xl">
        <header className="flex items-baseline gap-2 border-b border-tvx-line px-4 py-2">
          <h2 className="text-sm font-semibold text-tvx-text">Keyboard &amp; mouse</h2>
          <span className="text-[10px] text-tvx-dim">
            generated from the §7.5 key map — a row exists only if the resolver answers that chord
          </span>
          <button
            type="button"
            data-testid="keyboard-help-close"
            className="tvx-btn tvx-btn-sm ml-auto"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <div className="flex flex-col overflow-y-auto px-4 py-3">
          <Tabs
            tabs={tabs}
            active={activeTab}
            onChange={onTab}
            testIdPrefix="keymap-tab"
            aria-label="Keyboard help sections"
          />

          <div className="grid grid-cols-2 gap-x-6 gap-y-4" role="tabpanel">
            {visibleSections.map((section) => (
              <SectionBlock key={section.title} section={section} />
            ))}

            {activeTab === 'modules' && moduleManifest !== null && (
              <section data-testid="keyhelp-section-Modules">
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
                  {moduleManifest.title}
                </h3>
                <dl className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-2 gap-y-1">
                  {moduleRows.map((row) => (
                    <div key={row.chord} className="contents">
                      <dt data-testid="keyhelp-module-chord">
                        <Kbd>{row.chord}</Kbd>
                      </dt>
                      <dd className="text-[11px] text-tvx-text">{row.description}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {visibleGestureGroups.map((group) => (
              <section key={group.title} data-testid={`keyhelp-section-${group.title}`}>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
                  {group.title}
                </h3>
                <dl className="grid grid-cols-[9rem_1fr] items-baseline gap-x-2 gap-y-1">
                  {group.gestures.map((gesture) => (
                    <div key={gesture.chord} className="contents">
                      <dt data-testid="keyhelp-gesture">
                        <Kbd>{gesture.chord}</Kbd>
                      </dt>
                      <dd className="text-[11px] text-tvx-text">{gesture.description}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>

        {activeTab === 'modules' && (
          <footer className="border-t border-tvx-line px-4 py-1.5 text-[10px] text-tvx-dim">
            Extension keys are live only while that extension is active, and resolve after the map
            above — so an extension can never shadow a binding on the other tabs (§13.5).
          </footer>
        )}

        {activeTab === 'mouse' && (
          <footer className="border-t border-tvx-line px-4 py-1.5 text-[10px] text-tvx-dim">
            Pointer gestures are bound by the engine on the canvas (§7.5), not by the key map, so
            they are listed rather than generated.
          </footer>
        )}
      </div>
    </div>
  );
}
