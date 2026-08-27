/**
 * Two §7.5/§8 behaviours the **frozen** §4.7 facade has no member for.
 *
 * * `r` reset view and `1..6` camera presets need `fit()` and the A/P/L/R/S/I rotations, which are
 *   engine maths (§7.5). `Engine.setView(id, patch)` could carry a whole `Camera3D`, but computing
 *   one in the app would put scene-bounds fitting in React — exactly what §8's last line forbids.
 * * `c` toggle crosshair edits `Scene.annotations`, and `Scene` is exposed `Readonly` with no setter.
 * * The status bar owes "wasm `heapBytes` per dataset" (§8), and `EngineEvents` carries none: it is
 *   stamped on every worker `Res` (§6.5.2) and stops at the engine.
 *
 * Rather than edit a frozen file, the app **duck-types** these as optional members. An engine that has
 * them gets the behaviour; one that does not degrades to a disabled control, never to a crash. The
 * gap and its two possible closures are recorded in `docs/DECISIONS.md`.
 */

import type { Annotations, DatasetId, Engine, ViewId } from '@tetravox/engine';
import type { CameraPreset } from '../lib/keymap';

export interface EngineViewCommands {
  /** §7.5 `r`: refit the view to the scene bounds. */
  resetView(viewId: ViewId): void;
  /** §7.5 `1..6`: an A/P/L/R/S/I camera preset on the 3D view. */
  cameraPreset(viewId: ViewId, preset: CameraPreset): void;
  /** §7.5 `c` and the §4.5 `Annotations` block. */
  setAnnotations(patch: Partial<Annotations>): void;
}

export interface EngineHeapReporter {
  /** §8 status bar: `wasm_heap_bytes()` from that dataset's last `Res` (§6.5.2). */
  heapBytes(id: DatasetId): number | undefined;
}

type Maybe<T> = Partial<Record<keyof T, unknown>>;

function hasAll<T extends object>(value: unknown, keys: readonly (keyof T)[]): value is T {
  const candidate = value as Maybe<T>;
  return keys.every((k) => typeof candidate[k] === 'function');
}

export function viewCommands(engine: Engine): EngineViewCommands | null {
  return hasAll<EngineViewCommands>(engine, ['resetView', 'cameraPreset', 'setAnnotations'])
    ? engine
    : null;
}

export function heapReporter(engine: Engine): EngineHeapReporter | null {
  return hasAll<EngineHeapReporter>(engine, ['heapBytes']) ? engine : null;
}
