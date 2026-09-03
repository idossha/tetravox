/**
 * **Embed mode** — the renderer running as a plain browser page inside a host's `<iframe>`
 * (`packages/embed`, `docs/EMBED.md`).
 *
 * The same React shell, the same `ShellController`, the same `Engine`. There is no second UI and no
 * embed-only code path into the scene: everything the host protocol does is a call a user can make
 * with the mouse, which is the property `automation/run.ts` already keeps for `--job` and the reason
 * a picture the embed produces is a picture the product produces.
 *
 * This file is the whole seam, and it is two things:
 *
 *  * {@link embedMode} — `?embed=1` on the page URL. **False everywhere else**, so every branch that
 *    reads it reproduces the previous behaviour when it is absent (§12.3's rule for additive change).
 *    It is read from `location.search` and not from a store field because the chrome it hides is
 *    decided before the first commit and never changes for the life of the page.
 *  * {@link onShellReady} / {@link emitShellReady} — a single-slot callback carrying the
 *    `{ controller, engine, store }` triple at the moment `Shell` has built them. `packages/embed`'s
 *    entry registers it *before* `createRoot`, so the postMessage channel is wired by the time the
 *    engine's first event can fire. This is the same triple `maybeRunJob` receives, deliberately:
 *    a host driving the viewer over a message port and a `--job` script driving it from argv are
 *    the same kind of caller, and neither one is allowed a private door into the scene.
 *
 * Nothing here imports from `packages/embed`. The dependency points one way — the embed build
 * imports the renderer, never the reverse — so a plain `pnpm --filter @tetravox/app build` neither
 * knows nor cares that the embed exists.
 */

import type { Engine } from '@tetravox/engine';
import type { ShellController } from '../store/controller';
import type { UiStore } from '../store/store';

/** What `Shell` hands whoever asked to be told the viewer is live. */
export interface ShellReady {
  controller: ShellController;
  engine: Engine;
  store: UiStore;
}

/** `?embed=1`. Anything else — including `?embed=0` — is a normal window. */
export function embedMode(search = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).get('embed') === '1';
}

let ready: ((r: ShellReady) => void) | null = null;

/**
 * Register the callback. One slot, not a list: there is exactly one host per page, and a second
 * registration is a bug (two channels writing the same scene) rather than a second subscriber.
 */
export function onShellReady(fn: ((r: ShellReady) => void) | null): void {
  ready = fn;
}

/** Called by `Shell` once the engine and the controller exist. A no-op with nobody registered. */
export function emitShellReady(r: ShellReady): void {
  ready?.(r);
}
