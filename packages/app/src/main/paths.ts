/**
 * The `tetravox://file/…` allow-list (§5, directive A2).
 *
 * A privileged scheme with `supportFetchAPI` is reachable from every module Worker under the origin,
 * so `tetravox://file/<path>` would otherwise be an arbitrary-file-read primitive for anything that
 * gets script into the renderer. Only paths the *user* named — the Open dialog, a drop,
 * `open-file`, CLI argv — are readable, and main is the only process that can add one.
 *
 * Paths are stored resolved and symlink-flattened, and a request is checked against the resolved form
 * of what it asked for, so neither `..` nor a symlink can walk out of the set.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const allowed = new Set<string>();

/** Canonical form: absolute, `..`-free, symlinks flattened. Returns null for a path we cannot resolve. */
function canonical(candidate: string): string | null {
  if (!candidate || !isAbsolute(candidate)) return null;
  try {
    return realpathSync(resolve(candidate));
  } catch {
    return null;
  }
}

/** Add a user-named path. Returns the canonical form that was added, or null when it does not exist. */
export function allowPath(candidate: string): string | null {
  const real = canonical(candidate);
  if (real === null) return null;
  allowed.add(real);
  return real;
}

export function allowPaths(candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    const real = allowPath(candidate);
    if (real !== null) out.push(real);
  }
  return out;
}

/** The resolved path to read, or null when the request is not on the allow-list. */
export function resolveAllowed(candidate: string): string | null {
  const real = canonical(candidate);
  if (real === null) return null;
  return allowed.has(real) ? real : null;
}

/** Test seam only. */
export function clearAllowList(): void {
  allowed.clear();
}
