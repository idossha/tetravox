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
import { seegManifest } from '../../../modules/seeg/manifest';
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
  // §13.7's "one line in MODULES", 2026-08-30. Not a fixture: the sEEG editor is a product feature,
  // so it is in the switcher of every build.
  { manifest: seegManifest, load: () => import('./seeg') },
];

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
 */
export function enabledModules(
  search: string = globalThis.location?.search ?? ''
): readonly ModuleRegistration[] {
  const requested = requestedFixtures(search);
  return MODULES.filter((m) => m.fixture !== true || named(requested, m.manifest.id));
}

/** The registration for an id, or null when this build does not offer it. */
export function registrationFor(
  id: string,
  search: string = globalThis.location?.search ?? ''
): ModuleRegistration | null {
  return enabledModules(search).find((m) => m.manifest.id === id) ?? null;
}
