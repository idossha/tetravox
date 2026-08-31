/**
 * Every module's manifest, in one main-safe barrel (§13.1).
 *
 * "Main-safe" is the whole point: `main/job.ts` validates a `type: "module"` job action against this
 * array **before a window exists** (§13.6), which is what keeps the automation surface's promise that
 * every problem in a job file is reported at once, before anything is loaded. So this file — and
 * everything it reaches — must stay free of DOM types, of `node:` imports and of engine imports.
 *
 * The renderer's registry (`renderer/src/modules/registry.ts`) pairs each manifest with a lazy
 * `load()`; that pairing is the renderer's, because a `() => import('./hello')` is code, not data.
 */

import type { InstalledManifest, ModuleManifest } from './manifest-types';
import { helloManifest } from './hello/manifest';

// The sEEG editor is not compiled in: it is the downloadable `tetravox.seeg` extension and reaches
// `allManifests()` through `installed` below once the user has installed and enabled it (§13.8,
// 2026-08-31). `hello` is the only compiled-in manifest — a fixture the launch query names.
export const MANIFESTS: readonly ModuleManifest[] = [helloManifest];

/**
 * The manifests of the modules **installed under `~/.tetravox/modules/`** (downloadable extensions,
 * 2026-08-30) — empty until someone registers them.
 *
 * A module-level array rather than a parameter on every consumer, because the four renderer sites
 * that call {@link manifestFor} do so *synchronously while rendering* (a layer's owner badge, the
 * status cells, the layer summary, the controller's toast) and none of them is in a position to be
 * handed a list. Registration is deliberately a call each process makes for itself: main reads the
 * files off disk at startup, and the renderer is told the same array over the bridge at boot, which
 * is what keeps `src/modules` free of a `node:` import.
 */
let installed: readonly InstalledManifest[] = [];

/**
 * Replace the installed set. Idempotent, and called in **both** processes — main from
 * `module-store.ts` at startup, the renderer from `modules/installedBoot.ts` before first paint.
 *
 * Replace rather than append: an install, a remove or a version bump changes the whole set, and a
 * function that could only add would leave a removed module answering for its own id forever.
 */
export function registerInstalledManifests(list: readonly InstalledManifest[]): void {
  installed = [...list];
}

/** What was last registered. */
export function installedManifests(): readonly InstalledManifest[] {
  return installed;
}

/**
 * Compiled-in first, then installed — the list `validateJob` validates a `type: "module"` action
 * against once installed modules exist (§13.6).
 *
 * Order is the precedence: a compiled-in module wins a duplicate id, so an installed module can
 * never shadow one the build ships.
 */
export function allManifests(): readonly InstalledManifest[] {
  return [...MANIFESTS, ...installed];
}

/**
 * The manifest with this id, or null. Ids are unique — `modules.test.ts` proves it for the
 * compiled-in half, and `module-store.ts` refuses an installed module whose id collides.
 *
 * The return type widened to {@link InstalledManifest} on 2026-08-30: every field a caller reads is
 * the same, and `hostApi` is a `number` because an installed manifest may carry a version this build
 * does not implement — which is precisely the value the version gate has to be able to see.
 */
export function manifestFor(id: string): InstalledManifest | null {
  return allManifests().find((m) => m.id === id) ?? null;
}
