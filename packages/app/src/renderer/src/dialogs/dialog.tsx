/**
 * The one modal frame the shell's dialogs share.
 *
 * Two dialogs and a help sheet is enough repetition to be worth one component and not enough to be
 * worth a library (§12.3 freezes the dependency list anyway). It carries the three behaviours that
 * are easy to leave out of a hand-rolled modal and annoying to hit as a user: Escape closes it,
 * clicking the backdrop closes it, and the shell's §7.5 key resolver does **not** see keystrokes
 * typed into it — the last one matters because a dialog full of number inputs sits above a window
 * where `x` cycles the layout and `v` hides a layer.
 */

import { useEffect, useRef } from 'react';

export interface DialogFrameProps {
  testId: string;
  title: string;
  /** A short line under the title, usually the contract clause the dialog implements. */
  subtitle?: string;
  width?: string;
  onCancel(): void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function DialogFrame({
  testId,
  title,
  subtitle,
  width = '34rem',
  onCancel,
  children,
  footer,
}: DialogFrameProps): React.JSX.Element {
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelRef.current();
    };
    // Capture: the shell's §7.5 resolver is bound on `window` in the bubble phase, so without this
    // an Escape (or any bound key typed into a field that is not an <input>) would run a command.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="absolute inset-0 z-50 grid place-items-center bg-black/60 p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        style={{ width }}
        className="flex max-h-full max-w-full flex-col overflow-hidden rounded border border-tvx-line bg-tvx-panel shadow-xl"
      >
        <header className="border-b border-tvx-line px-4 py-2">
          <h2 className="text-sm font-semibold text-tvx-text">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-[10px] text-tvx-dim">{subtitle}</p>}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer !== undefined && (
          <footer className="flex items-center gap-2 border-t border-tvx-line px-4 py-2">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/** A labelled control row, so every dialog field lines up without repeating the grid classes. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="mb-2 grid grid-cols-[8.5rem_1fr] items-center gap-x-3 text-[11px]">
      <span className="text-tvx-dim" title={hint}>
        {label}
      </span>
      <span className="flex items-center gap-2">{children}</span>
    </label>
  );
}
