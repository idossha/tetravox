/**
 * Turning what the user opened into a `DatasetSource` (§4.7, §8).
 *
 * §8 is explicit about the two branches and about what must **not** happen between them:
 *
 * * a path — from the Open dialog, CLI argv, macOS `open-file`, or a drop whose `File` carries one —
 *   becomes `{ kind: 'path' }`, which the engine maps onto protocol `LoadSource.kind: 'url'` and the
 *   dataset worker fetches over `tetravox://file/…` (§6.5.1). The renderer never sees the bytes.
 * * a `File` with no path becomes `{ kind: 'file' }` and is structured-cloned to the worker whole.
 *   **The renderer must never call `file.arrayBuffer()`** — that is a 492 MB allocation on the thread
 *   §5 rule 3 and AGENTS rule 7 keep away from raw file bytes. There is no `arrayBuffer` in this file
 *   and there must never be one.
 *
 * Sidecars are the §5 rule 9 "Phase 1 consequence": derived sibling paths are not user-named, so they
 * have to be admitted to the allow-list alongside the dataset. `allowPath` returning `null` doubles as
 * the existence check, which is why nothing here stats a file.
 */

import type { DatasetSource } from '@tetravox/engine';
import { bridge } from '../bridge';
import { baseName, deriveSidecarCandidates } from '../lib/sidecars';

export interface OpenRequest {
  /** What the load card is called before a `Dataset` exists. */
  name: string;
  path: string | null;
  source: DatasetSource;
}

/** The first candidate the main process would admit, or null when none of them exists. */
async function firstAllowed(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const allowed = await bridge().allowPath(candidate);
    if (allowed !== null) return allowed.path;
  }
  return null;
}

/**
 * A path the user named. It is re-`allowPath`ed even when it came from the menu (which already
 * allow-listed it): the call is idempotent, and it is what makes a path from *any* origin — argv,
 * `open-file`, a drop — take one code path here.
 */
export async function requestFromPath(path: string): Promise<OpenRequest | null> {
  const allowed = await bridge().allowPath(path);
  if (allowed === null) return null;
  const candidates = deriveSidecarCandidates(allowed.path);
  const lut = await firstAllowed(candidates.lut);
  const opt = await firstAllowed(candidates.opt);
  const sidecars: { lut?: string; opt?: string } = {};
  if (lut !== null) sidecars.lut = lut;
  if (opt !== null) sidecars.opt = opt;
  return {
    name: baseName(allowed.path),
    path: allowed.path,
    source: {
      kind: 'path',
      path: allowed.path,
      ...(Object.keys(sidecars).length > 0 ? { sidecars } : {}),
    },
  };
}

/**
 * A dropped `File`. `webUtils.getPathForFile` first (§8); the `File` itself only when it answers `''`,
 * which is exactly the case where there is no path to allow-list.
 */
export async function requestFromDroppedFile(file: File): Promise<OpenRequest | null> {
  const path = bridge().getDroppedFilePath(file);
  if (path !== '') {
    const request = await requestFromPath(path);
    if (request !== null) return request;
    // A path that main refuses (deleted between the drop and the IPC round trip) still has a `File`.
  }
  return { name: file.name, path: null, source: { kind: 'file', file } };
}
