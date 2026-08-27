/**
 * The relocate dialog — **Phase 2** (owner: A-SHELL).
 *
 * §8: "Scene save/load: `*.tetravox.json` (`ViewSpec`, §4.6). Paths are stored relative to the scene
 * file with an absolute fallback; **a missing dataset opens a 'relocate' dialog**."
 *
 * It is the app's half of `Engine.load(spec, resolve)` (§4.7): the engine calls `resolve(ref)` for
 * every `DatasetRef` and takes `null` to mean "skip". This dialog is what turns a `null` into a path
 * the user picked, and the `fingerprint` on the ref is what tells the user whether the file they
 * picked is the one the scene was saved against.
 */

import type { DatasetRef } from '@tetravox/engine';

export interface RelocateDialogProps {
  /** The datasets `Engine.load`'s `resolve` could not find. */
  missing: readonly DatasetRef[];
  /** Resolves with one path per ref, or `null` for the ones the user chose to skip. */
  onResolved(paths: readonly (string | null)[]): void;
  onCancel(): void;
}

export function RelocateDialog(_props: RelocateDialogProps): React.JSX.Element | null {
  return null;
}
