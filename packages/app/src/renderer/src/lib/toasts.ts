/**
 * Error toasts (§8: the app has to say something when a file will not open).
 *
 * The codes are protocol `ErrorCode` (§6.5): `parse` | `unsupported` | `io` | `oom` | `cancelled` |
 * `panic`. `cancelled` is never a toast — the user asked for it, and the load card already says so.
 */

export type ToastTone = 'error' | 'warn' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail: string;
  at: number;
}

/** At most this many at once; the oldest fall off the top. */
export const MAX_TOASTS = 4;

const TITLES: Record<string, string> = {
  parse: 'Could not parse the file',
  unsupported: 'Unsupported file',
  io: 'Could not read the file',
  oom: 'Out of memory',
  panic: 'The loader crashed',
};

/** The human title for a protocol `ErrorCode`, falling back to the code itself. */
export function titleForCode(code: string): string {
  return TITLES[code] ?? `Load failed (${code})`;
}

/** `cancelled` is the user's own doing — the load card reports it, a toast would be nagging. */
export function isToastWorthy(code: string): boolean {
  return code !== 'cancelled';
}

export function pushToast(toasts: readonly Toast[], toast: Toast, max = MAX_TOASTS): Toast[] {
  return [...toasts, toast].slice(-max);
}

export function dismissToast(toasts: readonly Toast[], id: number): Toast[] {
  return toasts.filter((t) => t.id !== id);
}

/** Errors stay until dismissed; anything softer ages out. */
export const TOAST_TTL_MS = 8000;

export function pruneToasts(toasts: readonly Toast[], now: number, ttlMs = TOAST_TTL_MS): Toast[] {
  return toasts.filter((t) => t.tone === 'error' || now - t.at < ttlMs);
}
