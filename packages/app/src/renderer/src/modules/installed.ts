/**
 * The loader for **installed** extensions (§13.8, downloadable extensions, 2026-08-30).
 *
 * `registry.ts` pairs each compiled-in manifest with `() => import('./<id>')`, a *literal* specifier
 * the bundler owns end to end — in the built bundle it becomes `__vitePreload(() => import(
 * "./index-<hash>.js"), …)`. That is exactly right for a module inside the build and exactly useless
 * for one that arrived afterwards: a literal cannot name a runtime URL.
 *
 * This file is the other half. Each registration's `load()` **hoists the URL into a local `const`**
 * and imports the identifier:
 *
 *     const url = moduleUrl(id, version, MODULE_ENTRY);
 *     const loaded: unknown = await import(<the @vite-ignore comment> url);
 *
 * (spelled out rather than shown, because the comment that makes it work cannot be nested inside
 * this one — read `load()` below for the real thing.)
 *
 * All three details are load-bearing, and were measured against this repository's own Vite (7.3.6):
 *
 *  * **the identifier form**, not an inline template. `import(\`tetravox://module/${id}/…\`)` is a
 *    *partially analysable* specifier and Vite rewrites it into a glob helper; the identifier is
 *    opaque and ships verbatim;
 *  * **`@vite-ignore`**. Without it the same identifier form is silently rewritten to
 *    `__variableDynamicImportRuntimeHelper` over an **empty** glob — which rejects every URL at
 *    runtime, with no build warning to say so;
 *  * **no `__vitePreload` wrapper**, which is what we want: the preload helper injects a
 *    `<link rel=modulepreload>`, and a `tetravox://module` URL is a real ESM import at runtime under
 *    an origin the CSP admits by host source.
 *
 * `scripts/check-module-loader.mjs` re-proves all of that against the **built** chunk, because every
 * word above is a claim about a bundler we do not control.
 *
 * **What this file does not do.** It never sees bytes and never names a path. The renderer cannot
 * make a module reachable: `main/module-store.ts#enableModule()` re-hashes every file against the
 * install receipt and only then puts it on `protocol.ts`'s map, so an installed module the user has
 * not consented to 404s from the scheme. A registration built here for a module that is not enabled
 * would therefore fail at `import()` — which is why one is not built at all.
 */

import { installedManifests } from '../../../modules/manifests';
import type { InstalledManifest, ModuleManifest } from '../../../modules/manifest-types';
import { MODULE_HOST_VERSION } from '../../../modules/manifest-types';
import type { ModuleStatus } from '../../../preload/index';
import type { ModuleActivate } from './host';
import type { ModuleRegistration } from './registry';

/** The one file the loader imports. `enableModule` serves `.js` and `.css`; this is the entry. */
export const MODULE_ENTRY = 'index.js';

/**
 * `main/protocol.ts#moduleUrl`, duplicated rather than imported.
 *
 * The renderer must not import from `main` — that file reaches `electron` — for the same reason
 * `preload/index.ts` re-declares `main/module-store.ts`'s types instead of importing them. The two
 * definitions are compared by `installed.test.ts`, which reads `protocol.ts` off disk and asserts
 * the template still matches: a contract nothing compares is a contract that has already drifted.
 */
export function moduleUrl(id: string, version: string, file: string): string {
  return `tetravox://module/${id}/${version}/${file}`;
}

/**
 * What a module's entry file must export.
 *
 * A downloaded chunk is **not typechecked by our build** — that is the whole difference between an
 * installed module and a compiled-in one — so the namespace is checked before it is handed to
 * `activateModule`, where a missing `activate` would be a `TypeError` deep inside the host wiring
 * instead of a sentence naming the module.
 */
export function checkLoadedShape(
  loaded: unknown,
  id: string
): { ok: true; activate: ModuleActivate } | { ok: false; error: string } {
  if (loaded === null || typeof loaded !== 'object') {
    return { ok: false, error: `${id}: ${MODULE_ENTRY} is not an ES module` };
  }
  const activate = (loaded as { activate?: unknown }).activate;
  if (typeof activate !== 'function') {
    return {
      ok: false,
      error: `${id}: ${MODULE_ENTRY} exports no \`activate\` function — it is not a Tetravox module`,
    };
  }
  return { ok: true, activate: activate as ModuleActivate };
}

/**
 * Which installed manifests this build may offer, and why each of the others may not.
 *
 * Three gates, in the order a user would ask them:
 *
 *  1. **enabled** — `moduleStatuses()` says consent is recorded for the installed version. Without
 *     it the module is not on the protocol map and `import()` would 404;
 *  2. **compatible** — `hostApi` is the integer this build implements. `InstalledManifest.hostApi`
 *     is a `number` precisely so a stale one can be *held* and refused rather than being a compile
 *     error nobody can reach;
 *  3. **not shadowing a compiled-in id** — `manifests.ts#allManifests()` already gives a compiled-in
 *     module precedence, and `registry.ts` merges installed registrations *after* `MODULES`, so this
 *     only keeps a duplicate row out of the switcher.
 */
export function eligibleInstalled(
  manifests: readonly InstalledManifest[],
  statuses: readonly ModuleStatus[],
  compiledInIds: readonly string[]
): ModuleManifest[] {
  const enabled = new Set(statuses.filter((s) => s.enabled).map((s) => s.id));
  const shadowed = new Set(compiledInIds);
  const out: ModuleManifest[] = [];
  for (const m of manifests) {
    if (!enabled.has(m.id) || shadowed.has(m.id)) continue;
    if (m.hostApi !== MODULE_HOST_VERSION) continue;
    // The gate above is exactly the proof that this is a `ModuleManifest`: `hostApi` is the only
    // field `InstalledManifest` widens, and it has just been checked against the literal this build
    // implements. Rebuilding the object rather than casting keeps that an inference rather than an
    // assertion — a cast here would be the one place the version gate could be undone by a typo.
    out.push({ ...m, hostApi: MODULE_HOST_VERSION });
  }
  return out;
}

/** Reported when a module's own file fails to load or is not shaped like a module. */
export type ModuleLoadError = (id: string, reason: string) => void;

/**
 * Build the registrations for a set of installed manifests.
 *
 * `onError` is called *before* the rejection propagates, so the Extensions dialog's card can be
 * marked failed while `ShellController.activateModule`'s existing catch raises the toast and leaves
 * the slot empty. A module that will not load must never leave a half-built switcher behind — and it
 * does not, because the row is a manifest and the failure is in `load()`.
 */
export function installedRegistrations(
  manifests: readonly ModuleManifest[],
  onError: ModuleLoadError
): ModuleRegistration[] {
  return manifests.map((manifest) => ({
    manifest,
    load: async (): Promise<{ activate: ModuleActivate }> => {
      // HOISTED, and `@vite-ignore`d. See this file's header — both are load-bearing, and
      // `scripts/check-module-loader.mjs` asserts the built chunk still carries this shape.
      const url = moduleUrl(manifest.id, manifest.version, MODULE_ENTRY);
      let loaded: unknown;
      try {
        loaded = await import(/* @vite-ignore */ url);
      } catch (error: unknown) {
        const reason = `${manifest.id}: ${MODULE_ENTRY} did not load (${String(error)})`;
        onError(manifest.id, reason);
        throw new Error(reason, { cause: error });
      }
      const shape = checkLoadedShape(loaded, manifest.id);
      if (!shape.ok) {
        onError(manifest.id, shape.error);
        throw new Error(shape.error);
      }
      return { activate: shape.activate };
    },
  }));
}

/**
 * The whole boot step: what `manifests.ts` was told at boot, filtered by what main says is enabled.
 *
 * `installedBoot.ts` already registered the manifests before the first render (they are *data*, and
 * `manifestFor` is called synchronously while rendering); this is the second half, and it is the
 * controller's rather than `main.tsx`'s because a failed load has to reach a toast and a card.
 */
export function registrationsFor(
  statuses: readonly ModuleStatus[],
  compiledInIds: readonly string[],
  onError: ModuleLoadError
): ModuleRegistration[] {
  return installedRegistrations(
    eligibleInstalled(installedManifests(), statuses, compiledInIds),
    onError
  );
}
