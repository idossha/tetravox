/**
 * Error toasts (§8). A `parse` or `unsupported` failure has to be visible: the load card records it
 * for that one file, but a user who dropped six files and got one dialog-free silence would not know
 * which. `cancelled` is never toasted — the user asked for it (`lib/toasts.ts`).
 */

import { useController, useUi } from './context';

export function Toasts(): React.JSX.Element | null {
  const controller = useController();
  const toasts = useUi((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      data-testid="toasts"
      className="pointer-events-none absolute bottom-3 right-3 z-10 flex w-96 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid={`toast-${toast.id}`}
          data-tone={toast.tone}
          role="alert"
          className={
            'pointer-events-auto rounded border p-2 text-xs shadow-lg ' +
            (toast.tone === 'error'
              ? 'border-tvx-danger/60 bg-tvx-danger/15'
              : 'border-tvx-line bg-tvx-panel')
          }
        >
          <div className="flex items-baseline gap-2">
            <strong data-testid="toast-title" className="font-semibold">
              {toast.title}
            </strong>
            <button
              type="button"
              data-testid={`toast-dismiss-${toast.id}`}
              aria-label="Dismiss"
              className="tvx-btn tvx-btn-sm ml-auto"
              onClick={() => controller.dismissToast(toast.id)}
            >
              ✕
            </button>
          </div>
          <p data-testid="toast-detail" className="mt-0.5 break-words text-[10px] text-tvx-dim">
            {toast.detail}
          </p>
        </div>
      ))}
    </div>
  );
}
