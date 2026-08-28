/**
 * The "Tetravox" wordmark, as a menu (directed task: toolbar consolidation, 2026-08-28).
 *
 * Five buttons that used to sit in a row (`Open…`, `New`, `Open scene…`, `Save`, `Save as…`) are
 * one accessible dropdown now: `aria-haspopup="menu"` on the trigger, `role="menu"`/`role="menuitem"`
 * on the popup, closes on Escape or a click outside, and the arrow keys walk the items. "Open Recent"
 * stays out of it — it is only ever in the native `File` menu (`main/menu.ts`), never mirrored into
 * the renderer, so there is nothing here to duplicate.
 *
 * `data-testid="app-menu"` on the trigger and `data-testid="app-menu-<action>"` on each item are the
 * seam the E2E drives, replacing the five standalone `open-button` / `scene-*` testids they used to
 * click directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AppMenuAction {
  id: 'open' | 'new' | 'open-scene' | 'save' | 'save-as';
  label: string;
  title?: string;
  disabled?: boolean;
  onSelect(): void;
}

export interface AppMenuProps {
  actions: readonly AppMenuAction[];
}

export function AppMenu({ actions }: AppMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="app-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className="mr-1 rounded px-1.5 py-1 text-sm font-semibold tracking-wide text-tvx-text transition-colors hover:text-tvx-accent-strong"
        onClick={() => setOpen((v) => !v)}
      >
        Tetravox
      </button>
      {open && (
        <div
          role="menu"
          aria-label="File"
          data-testid="app-menu-list"
          className="absolute left-0 top-full z-20 mt-1 flex min-w-[10rem] flex-col gap-0.5 rounded border border-tvx-line bg-tvx-panel p-1 shadow-lg"
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              data-testid={`app-menu-${action.id}`}
              className="tvx-btn justify-start text-left"
              disabled={action.disabled ?? false}
              title={action.title}
              onClick={() => {
                close();
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
