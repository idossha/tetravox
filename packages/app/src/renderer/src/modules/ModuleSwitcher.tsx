/**
 * The module switcher — one control in the toolbar's **right** column (§13.3).
 *
 * One switcher from the first module, and never a button per module. Two modules' worth of buttons
 * after `Cube` wrap the toolbar's centre cluster at 1440 px (`Toolbar.tsx` is `flex-wrap`), which
 * grows the header and shrinks the view grid — the same canvas-resize class the status bar was
 * pinned against. An E2E asserts the toolbar's height is unchanged after an activation.
 *
 * It sits directly above the column it opens, like Slicer's module selector, and before `?` and `⚙`
 * so the gear stays the right-most control on the rail whatever is added to its left.
 *
 * Nothing here names a module: the list is `controller.modules()`, which is the registry filtered by
 * the launch query and — since 2026-08-30 — extended with the installed extensions main says are
 * enabled. A disabled or uninstalled extension is not in that list at all, so it behaves exactly
 * like a module this build does not carry.
 *
 * **The switcher stays load/unload** (§13.3). The one row that is not a module is `Manage
 * extensions…`, which opens the dialog that *is* the place to install, consent to and remove one —
 * it is a door, not a second management surface, and it is the reason no toolbar button was added.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useController, useUi } from '../ui/context';

export function ModuleSwitcher(): React.JSX.Element | null {
  const controller = useController();
  const activeModule = useUi((s) => s.activeModule);
  // §13.10: every live module and where it is showing. The rows read this rather than `activeModule`
  // alone, because a popped-out module is live and must not read as "off" in the menu that loaded it.
  const placements = useUi((s) => s.modulePlacement);
  // Boot-time reactivity (2026-08-31): `controller.modules()` below reads the installed-extension
  // set that `refreshInstalledModules` fills **asynchronously** — an extension a previous session
  // enabled lands after first paint. That refresh sets
  // `extensionStatuses` immediately after the set, so subscribing to it here is what re-renders the
  // switcher when a boot-enabled extension appears; without it the control stays absent (a build
  // with only installed modules) until an unrelated state change forces a paint.
  useUi((s) => s.extensionStatuses);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const modules = controller.modules();
  // A build with no module offers no control at all, rather than a menu with nothing in it. This is
  // also what keeps the toolbar byte-identical in a default launch, where the fixture is hidden.
  if (modules.length === 0) return null;

  const active = modules.find((m) => m.manifest.id === activeModule) ?? null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="module-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        // `aria-pressed` while one is active, like every other toolbar toggle.
        aria-pressed={active !== null}
        title="Extensions — one in the panel, any number in their own windows (§13, §13.10)"
        className={active === null ? 'tvx-btn' : 'tvx-btn tvx-btn-on'}
        onClick={() => setOpen((v) => !v)}
      >
        {active === null ? 'Extensions' : active.manifest.title} ▾
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Extensions"
          data-testid="module-switcher-list"
          className="absolute right-0 top-full z-20 mt-1 flex min-w-[10rem] flex-col gap-0.5 rounded border border-tvx-line bg-tvx-panel p-1 shadow-lg"
        >
          {modules.map((registration) => {
            const id = registration.manifest.id;
            const placement = placements[id] ?? null;
            const on = placement !== null;
            // The row is still the load/unload toggle it always was — a click loads into the slot
            // and a second click unloads, wherever the module is showing. The ⧉ beside it is the
            // *placement*, and it is a separate button rather than a second meaning for the row
            // because "open this" and "move this" must not be the same click.
            return (
              <div key={id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  data-testid={`module-switcher-${id}`}
                  className={
                    on
                      ? 'tvx-btn tvx-btn-on min-w-0 flex-1 justify-start'
                      : 'tvx-btn min-w-0 flex-1 justify-start'
                  }
                  title={`${registration.manifest.title} ${registration.manifest.version}${
                    placement === 'window' ? ' — showing in its own window' : ''
                  }`}
                  onClick={() => {
                    close();
                    void controller.toggleModule(id);
                  }}
                >
                  <span className="truncate">{registration.manifest.title}</span>
                  {placement === 'window' && <span className="ml-1 shrink-0 text-tvx-dim">⧉</span>}
                </button>
                {registration.manifest.ui?.popout !== 'never' && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`module-switcher-popout-${id}`}
                    aria-label={
                      placement === 'window'
                        ? `Bring ${registration.manifest.title} back into the panel`
                        : `Open ${registration.manifest.title} in its own window`
                    }
                    title={
                      placement === 'window'
                        ? 'Bring it back into the panel'
                        : 'Open it in its own window — several modules can be open at once'
                    }
                    className="tvx-btn tvx-btn-sm shrink-0"
                    onClick={() => {
                      close();
                      // Not yet live: load it straight into a window, so "open this one too" is one
                      // click and never disturbs the module already in the slot.
                      void controller.activateModule(
                        id,
                        placement === 'window' ? 'docked' : 'window'
                      );
                    }}
                  >
                    {placement === 'window' ? '⇱' : '⧉'}
                  </button>
                )}
              </div>
            );
          })}
          {/* The one non-module row, below a rule so it reads as a different kind of thing. */}
          <div className="my-0.5 border-t border-tvx-line" />
          <button
            type="button"
            role="menuitem"
            data-testid="module-switcher-manage"
            className="tvx-btn justify-start text-tvx-dim"
            title="Install, enable and remove downloadable extensions (File ▸ Extensions…)"
            onClick={() => {
              close();
              void controller.openExtensions();
            }}
          >
            Manage extensions…
          </button>
        </div>
      )}
    </div>
  );
}
