/**
 * Which modules this build carries, and how to load one (ARCHITECTURE.md §13.1).
 *
 * A registration is a manifest — data, shared with the main process — paired with a lazy `load()`.
 * The pairing lives here rather than in `packages/app/src/modules/` because `() => import('./hello')`
 * is *code*, and a manifest barrel main imports before a window exists must stay free of it.
 *
 * **Registration is build time; activation is lazy.** Nothing in a module's directory is fetched
 * until the switcher, a reader hit, a sibling hit or a scene block asks for it, so a module that is
 * never used costs one manifest object.
 *
 * **Adding a module is adding a directory** and one line here — that is the whole of §13.7's
 * checklist as far as the shell is concerned. Nothing module-specific belongs in `Shell.tsx`,
 * `Toolbar.tsx`, `keymap.ts` or `controller.ts`, and `modules.test.ts` is what keeps it that way.
 */

import type { ModuleId, ModuleManifest } from '../../../modules/manifest-types';
import { helloManifest } from '../../../modules/hello/manifest';
import type { ModuleActivate } from './host';

export interface ModuleRegistration {
  manifest: ModuleManifest;
  /** Imported the first time the module is activated, never at boot. */
  load: () => Promise<{ activate: ModuleActivate }>;
  /**
   * A **fixture**: compiled into every build, listed only when the launch query names it.
   *
   * It is compiled in rather than excluded because `pnpm e2e` drives the production bundle — a
   * fixture the bundle did not contain would prove nothing about the bundle users get — and it is
   * hidden by default because it is not a product feature. Same seam as `?engine=mock`
   * (`engine/factory.ts`).
   */
  fixture?: boolean;
}

export const MODULES: readonly ModuleRegistration[] = [
  { manifest: helloManifest, load: () => import('./hello'), fixture: true },
  // The sEEG editor is no longer compiled in: it ships as the **bundled** `tetravox.seeg` extension
  // (`modules.lock`, `resources/modules/`), discovered at boot and pre-consented, and reaches the
  // switcher through `installed` below exactly as a downloaded module does (§13.7, §13.8, 2026-08-31).
];

/**
 * The registrations for modules **installed under `~/.tetravox/modules/`** — empty until the
 * controller sets them (downloadable extensions, 2026-08-30).
 *
 * A module-level array, listed *after* {@link MODULES} rather than merged into it, so a compiled-in
 * module wins a duplicate id exactly as it does in `manifests.ts#allManifests()`: an installed module
 * can never shadow one the build ships. It is deliberately mutable state and not a parameter, because
 * every route into a module already goes through {@link enabledModules} — the switcher, the reader
 * hook, the sibling dispatch, the scene-block restore — and none of those callers is in a position to
 * be handed a list.
 */
let installed: readonly ModuleRegistration[] = [];

/**
 * Replace the installed set. The controller's call, after main answered `moduleStatuses()`.
 *
 * Replace rather than append, for `registerInstalledManifests`'s reason: an install, a remove or a
 * disable changes the whole set, and a function that could only add would leave a module the user has
 * just withdrawn consent from sitting in the switcher.
 */
export function setInstalledModules(list: readonly ModuleRegistration[]): void {
  installed = [...list];
}

/** What was last set — what this window is currently offering from outside the build. */
export function installedModuleRegistrations(): readonly ModuleRegistration[] {
  return installed;
}

/**
 * The modules named by `?modules=` — full ids, or the part after the dot. `?modules=all` enables
 * every fixture, which is what a developer poking at the surface wants.
 */
function requestedFixtures(search: string): Set<string> {
  const raw = new URLSearchParams(search).get('modules');
  if (raw === null) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
  );
}

/** True when `id` is named by a `?modules=` list, by full id or by short name. */
function named(requested: ReadonlySet<string>, id: ModuleId): boolean {
  if (requested.has('all') || requested.has(id)) return true;
  const short = id.slice(id.indexOf('.') + 1);
  return requested.has(short);
}

/**
 * What this window offers — the product modules, plus any fixture the launch query asked for.
 *
 * Every route into a module goes through this, not through `MODULES`: the switcher, the reader hook,
 * the sibling dispatch and the scene-block restore. So a disabled fixture behaves **exactly** like a
 * module this build does not carry, right down to its scene block being carried forward untouched
 * (§13.2) — one behaviour to reason about rather than two.
 *
 * Appended 2026-08-30: the installed set joins it here and nowhere else, which is why downloadable
 * extensions needed no edit to the switcher, the reader hook, the sibling dispatch or the scene-block
 * restore. An installed module that is not enabled is never in {@link installed} at all, so it
 * behaves exactly like a fixture the launch query did not name.
 */
export function enabledModules(
  search: string = globalThis.location?.search ?? ''
): readonly ModuleRegistration[] {
  const requested = requestedFixtures(search);
  const compiled = MODULES.filter((m) => m.fixture !== true || named(requested, m.manifest.id));
  if (installed.length === 0) return compiled;
  const ids = new Set(MODULES.map((m) => m.manifest.id));
  return [...compiled, ...installed.filter((m) => !ids.has(m.manifest.id))];
}

/** The registration for an id, or null when this build does not offer it. */
export function registrationFor(
  id: string,
  search: string = globalThis.location?.search ?? ''
): ModuleRegistration | null {
  return enabledModules(search).find((m) => m.manifest.id === id) ?? null;
}
