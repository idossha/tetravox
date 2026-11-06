/**
 * The right panel's tab row and the docked module's body (§13.3).
 *
 * The row is the module's tabs, then the module's small buttons and the panel's chevron. Inspect is
 * the platform's and not one of them: it is a toggle in the toolbar, and while it is on, or with no
 * docked module, the row is the chevron alone. The body stays mounted behind Inspect: a tab is a view
 * of a live module, never a reason to lose whatever its panel holds. Nothing here knows any module;
 * it all comes from the manifest.
 */

import { Component, useRef } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';

import { selectedPanelTab } from '../store/store';
import { useController, useUi } from '../ui/context';

/** One module's broken render stops at its own surface instead of blanking the app. */
export class ModuleErrorBoundary extends Component<
  { title: string; onError: (message: string) => void; children: ReactNode },
  { message: string | null }
> {
  override state = { message: null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <p data-testid="module-error" className="p-2 text-[11px] text-tvx-danger">
        {this.props.title} failed to draw: {this.state.message}
      </p>
    );
  }
}

interface RowTab {
  id: string;
  label: string;
  selected: boolean;
  select: () => void;
}

function PanelCollapse({ onCollapse }: { onCollapse: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="right-panel-collapse"
      aria-label="Collapse the info panel"
      title="Collapse the info panel (⌃])"
      className="tvx-btn tvx-btn-sm shrink-0"
      onClick={onCollapse}
    >
      ›
    </button>
  );
}

export function PanelTabRow({ onCollapse }: { onCollapse: () => void }): React.JSX.Element {
  const controller = useController();
  const activeModule = useUi((s) => s.activeModule);
  const dirty = useUi((s) => (s.activeModule === null ? false : s.moduleDirty[s.activeModule]));
  const inspect = useUi((s) => s.inspectTabSelected);
  const manifest = controller.activeModuleManifest();
  const chosen = useUi((s) => (manifest === null ? null : selectedPanelTab(s, manifest)));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  if (activeModule === null || manifest === null || inspect) {
    return (
      <div className="flex shrink-0 items-center justify-end border-b border-tvx-line px-1 py-0.5">
        <PanelCollapse onCollapse={onCollapse} />
      </div>
    );
  }

  const declared = manifest.ui?.panelTabs;
  const tabs: RowTab[] =
    declared === undefined
      ? [
          {
            id: 'module',
            label: manifest.title,
            selected: true,
            select: () => controller.showDockedModule(),
          },
        ]
      : declared.map((tab) => ({
          ...tab,
          selected: chosen === tab.id,
          select: () => controller.setModulePanelTab(manifest.id, tab.id),
        }));

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    // ←/→ also nudge the cursor, from a window listener.
    event.stopPropagation();
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.select();
    buttons.current[next]?.focus();
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-tvx-line pr-1">
      <div
        role="tablist"
        aria-label="Right panel"
        data-testid="panel-tabs"
        className="flex min-w-0 flex-1 overflow-x-auto"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={tab.selected}
            tabIndex={tab.selected ? 0 : -1}
            data-testid={`panel-tab-${tab.id}`}
            className={
              'shrink-0 whitespace-nowrap border-b-2 px-2 py-1 text-[11px] ' +
              (tab.selected
                ? 'border-tvx-accent text-tvx-text'
                : 'border-transparent text-tvx-dim hover:text-tvx-text')
            }
            onClick={(event) => {
              // A mouse click must not leave focus here, where Space would press it again rather
              // than start the engine's pan. A keyboard click (`detail` 0) keeps its focus.
              if (event.detail > 0) event.currentTarget.blur();
              tab.select();
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {dirty === true && (
        <span
          data-testid="module-dirty"
          title="Unsaved edits in this extension"
          className="shrink-0 text-tvx-accent"
        >
          •
        </span>
      )}
      {/* §13.10's pop-out. `'never'` gets no button rather than a disabled one. */}
      {manifest.ui?.popout !== 'never' && (
        <button
          type="button"
          data-testid="module-slot-popout"
          aria-label={`Open ${manifest.title} in its own window`}
          title={`Open ${manifest.title} in its own window. It keeps running — nothing is unloaded, and closing the window brings it back here.`}
          className="tvx-btn tvx-btn-sm shrink-0"
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
        data-testid="module-slot-close"
        aria-label={`Close ${manifest.title}`}
        title={`Close ${manifest.title}. Its layers stay in the scene; closing their dataset closes them.`}
        className="tvx-btn tvx-btn-sm shrink-0"
        onClick={() => controller.deactivateModule()}
      >
        ✕
      </button>
      <PanelCollapse onCollapse={onCollapse} />
    </div>
  );
}

export function ModuleSlot(): React.JSX.Element | null {
  const controller = useController();
  const activeModule = useUi((s) => s.activeModule);
  const inspect = useUi((s) => s.inspectTabSelected);
  const manifest = controller.activeModuleManifest();
  // Re-read through the controller rather than caching: `activeModule` is set only once `activate`
  // resolved, so this is non-null exactly when the id is.
  const Panel: ComponentType | null = controller.modulePanel();
  if (activeModule === null || manifest === null || Panel === null) return null;

  return (
    <section
      data-testid="module-slot"
      data-module={manifest.id}
      className={`min-h-0 flex-1 flex-col ${inspect ? 'hidden' : 'flex'}`}
    >
      <div data-testid="module-slot-body" className="min-h-0 flex-1 overflow-y-auto p-2">
        <ModuleErrorBoundary
          key={manifest.id}
          title={manifest.title}
          onError={(message) => controller.moduleToast('error', manifest.title, message)}
        >
          <Panel />
        </ModuleErrorBoundary>
      </div>
    </section>
  );
}
