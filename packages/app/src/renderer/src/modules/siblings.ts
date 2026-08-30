/**
 * Turning a manifest's `siblings` patterns into paths to probe (§13.1's `onSibling`).
 *
 * BIDS-shaped data is discovered **by name**: the electrodes table beside a CT is
 * `../ieeg/sub-P076_space-T1w_electrodes.tsv`, and the only thing that knows the pattern is the
 * module. So the manifest declares a regexp over the anchor's basename with named groups, plus
 * candidates written in terms of those groups, and this file instantiates them.
 *
 * **Static patterns, renderer-side probing, no new capability.** The candidates are then handed to
 * `bridge().allowPath` — the app's existing sidecar discovery (`open/sources.ts`'s `firstAllowed`),
 * which already admits any existing absolute path and doubles as the existence check. There is no
 * directory listing and no glob: a module can only ask about names it declared before the build.
 *
 * Pure and unit-tested. `ShellController.dispatchSiblings` is the caller.
 *
 * INTEGRATION(P3): `renderer/src/modules/hostFiles.ts` needs exactly this for `host.files.siblings`
 * and should import it rather than growing a second copy of the token rules.
 */

import type { ModuleSibling } from '../../../modules/manifest-types';

export interface SiblingCandidate {
  /** The manifest's template, verbatim — the key `ModuleInstance.onSibling` receives. */
  template: string;
  /** The instantiated path, relative to the anchor's directory and normalised. */
  path: string;
}

/** POSIX and Windows separators both: a scene written on either has to open on the other. */
const SEPARATOR = /[/\\]/;

/** At most three ascents (§13.1). Four would leave a subject directory entirely. */
const MAX_ASCENTS = 3;

/**
 * Each substituted segment must look like a filename. It is a **path** rule, not the writer-sibling
 * rule of §13.6: a candidate legitimately contains separators and `..`, a writer sibling never does.
 */
const SEGMENT = /^[A-Za-z0-9_.+-]{1,96}$/;

export function directoryOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at <= 0 ? path.slice(0, Math.max(at, 0)) : path.slice(0, at);
}

export function baseNameOf(path: string): string {
  return path.split(SEPARATOR).pop() ?? '';
}

/**
 * The basename without its last extension chain: `sub-01_electrodes.tsv` → `sub-01_electrodes`,
 * `sub-01_ct.nii.gz` → `sub-01_ct`.
 *
 * "Chain", not "extension", because the files this exists for are `.nii.gz` — stripping one
 * extension would leave `sub-01_ct.nii` and the sibling would never be found.
 */
export function stemOf(name: string): string {
  return name.replace(/(\.[A-Za-z0-9]+)+$/, '');
}

/**
 * `a/b/../c` → `a/c`, with the leading `/` of an absolute path kept.
 *
 * A leading `..` that has nothing left to pop is kept too: dropping it would silently turn
 * `../T1.nii.gz` into `T1.nii.gz` and probe the wrong file.
 */
function normalise(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}

function joinFromDirectory(directory: string, relative: string): string {
  if (directory === '') return normalise(relative);
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const joined = normalise(`${directory.split(SEPARATOR).join('/')}/${relative}`);
  return separator === '\\' ? joined.split('/').join('\\') : joined;
}

/**
 * Every candidate this pattern produces for `anchor`, or `[]` when the anchor's name does not match.
 *
 * A candidate is dropped — not the whole pattern — when it names a token the match did not capture,
 * ascends more than three directories, is absolute, or substitutes something that is not a filename.
 * Dropping one bad candidate rather than refusing the pattern is what keeps a typo in a module's
 * fourth candidate from silently disabling its first three.
 */
export function instantiateSiblings(spec: ModuleSibling, anchor: string): SiblingCandidate[] {
  const name = baseNameOf(anchor);
  let match: RegExpExecArray | null;
  try {
    match = new RegExp(spec.from).exec(name);
  } catch {
    return [];
  }
  if (match === null) return [];

  const tokens: Record<string, string> = { ...(match.groups ?? {}), stem: stemOf(name), name };
  const directory = directoryOf(anchor);
  const out: SiblingCandidate[] = [];

  for (const template of spec.candidates) {
    if (template.startsWith('/') || /^[A-Za-z]:/.test(template)) continue;
    let bad = false;
    const substituted = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_all, token: string) => {
      const value = tokens[token];
      if (value === undefined) bad = true;
      return value ?? '';
    });
    if (bad) continue;
    const segments = substituted.split('/');
    if (segments.filter((s) => s === '..').length > MAX_ASCENTS) continue;
    if (!segments.every((s) => s === '..' || SEGMENT.test(s))) continue;
    const path = joinFromDirectory(directory, substituted);
    if (path === '' || out.some((c) => c.path === path)) continue;
    out.push({ template, path });
  }
  return out;
}
