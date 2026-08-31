/**
 * The renderer's half of `registerInstalledManifests()` (§13.1, downloadable extensions, 2026-08-30).
 *
 * The same array has to be registered in **both** processes. Main reads it off disk before
 * `prepareJob` so a job file can be validated against a module that arrived from outside the build;
 * the renderer needs it because `manifestFor` is called *synchronously while rendering* — a layer's
 * owner badge, the module status cells, the layer summary, a toast naming a module — and none of
 * those callers is in a position to await anything. So the array is fetched once, before the first
 * commit, and everything downstream stays synchronous.
 *
 * It reads `window.tetravox` directly rather than going through `bridge()`: this file runs before
 * React exists, it needs exactly one member, and the null-object in `bridge.ts` would have to grow a
 * stub for a call whose honest answer here is simply "no bridge, no installed modules".
 *
 * Manifests are **data** — no DOM type, no `node:` import, nothing to execute (§13.1) — so this is
 * one small JSON round trip and not a capability. Knowing a module's title admits nothing; what
 * admits something is the `tetravox://module` map, which only main fills and only after consent.
 */

import { registerInstalledManifests } from '../../../modules/manifests';
import { validateManifest } from '../../../modules/manifest-schema';
import type { InstalledManifest } from '../../../modules/manifest-types';
import type { TetravoxBridge } from '../../../preload/index';

/** How long the first paint may wait on main. Main answers from an array it read at startup. */
const TIMEOUT_MS = 3000;

function preload(): TetravoxBridge | undefined {
  return (globalThis as { tetravox?: TetravoxBridge }).tetravox;
}

/**
 * Ask main for the installed manifests and register them. Resolves with what was registered.
 *
 * **Never rejects and never hangs.** A boot path that could fail on this would turn "an extension
 * directory is unreadable" into "the app does not start", and the app has to open with no modules at
 * all — which is exactly what an empty array means here.
 *
 * Every manifest is re-validated on arrival even though main validated it before sending: main is
 * trusted, but `validateManifest` is cheap, this is the boundary where a `hostApi` the renderer
 * cannot run has to be *held* rather than assumed away, and one shape check keeps the two processes
 * from disagreeing about what a manifest is.
 */
export async function loadInstalledManifests(): Promise<readonly InstalledManifest[]> {
  const fetchManifests = preload()?.moduleManifests;
  if (fetchManifests === undefined) {
    registerInstalledManifests([]);
    return [];
  }
  let raw: unknown;
  try {
    raw = await Promise.race([
      fetchManifests(),
      new Promise<unknown[]>((resolve) => setTimeout(() => resolve([]), TIMEOUT_MS)),
    ]);
  } catch {
    raw = [];
  }
  const list: InstalledManifest[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const validated = validateManifest(entry);
      if (validated.ok) list.push(validated.manifest);
    }
  }
  registerInstalledManifests(list);
  return list;
}
