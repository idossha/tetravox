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

import type { ModuleManifest } from './manifest-types';
import { helloManifest } from './hello/manifest';
// §13.7's "one line in MANIFESTS", 2026-08-30: the sEEG contact editor.
import { seegManifest } from './seeg/manifest';

export const MANIFESTS: readonly ModuleManifest[] = [helloManifest, seegManifest];

/** The manifest with this id, or null. Ids are unique — `modules.test.ts` proves it. */
export function manifestFor(id: string): ModuleManifest | null {
  return MANIFESTS.find((m) => m.id === id) ?? null;
}
