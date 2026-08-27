/**
 * The keyboard-map help sheet (ROADMAP Phase 2, "keyboard map"; §7.5's bindings).
 *
 * The rows come from `bindings.ts`, which **derives** them by asking `keymap.ts`'s resolver, so a
 * sheet can never list a binding the resolver does not implement. Nothing about the layout is
 * clever: it is a modal over the shell, dismissed with Escape or a click outside, with two halves —
 * the generated key rows and §7.5's pointer gestures, which live on the canvas and therefore cannot
 * be derived (see `bindings.ts` for why that split is honest rather than a shortcut).
 */

import { useEffect, useRef } from 'react';
import { POINTER_GESTURES, keyBindingSections } from './bindings';

export interface KeyboardHelpProps {
  open: boolean;
  onClose(): void;
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-tvx-line bg-tvx-bg/70 px-1.5 py-0.5 font-mono text-[10px] text-tvx-accent">
      {children}
    </kbd>
  );
}

export function KeyboardHelp({ open, onClose }: KeyboardHelpProps): React.JSX.Element | null {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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
  const sections = keyBindingSections();

  return (
    <div
      data-testid="keyboard-help"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="absolute inset-0 z-40 grid place-items-center bg-black/60 p-6"
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

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 overflow-y-auto px-4 py-3">
          {sections.map((section) => (
            <section key={section.title} data-testid={`keyhelp-section-${section.title}`}>
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
          ))}

          {POINTER_GESTURES.map((group) => (
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

        <footer className="border-t border-tvx-line px-4 py-1.5 text-[10px] text-tvx-dim">
          Pointer gestures are bound by the engine on the canvas (§7.5), not by the key map, so they
          are listed rather than generated.
        </footer>
      </div>
    </div>
  );
}
