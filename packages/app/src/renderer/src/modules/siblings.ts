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
 * Pure and unit-tested. Two callers, one implementation: `ShellController.dispatchSiblings` (the
 * `onSibling` activation route) and `hostFiles.ts`'s `host.files.siblings` (a module asking on its
 * own). They differ only in what they do with the answer, so the token rules, the segment rule, the
 * ascent limit and the resolution live here and nowhere else.
 */

import { stemOf } from '../../../modules/manifest-types';
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
 * `{stem}` — re-exported from the module contract, never redefined here.
 *
 * A candidate this file instantiates is probed, opened and *written beside*, and `main/module-io.ts`
 * is what admits the write. Two definitions of the token meant the two halves disagreed about a
 * dotted anchor; `../../../modules/manifest-types` holds the rule and why it is the rule.
 */
export { stemOf };

/** The separator the anchor is written with, so a Windows path stays a Windows path. */
function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/**
 * `candidate`, resolved against the directory `anchor` lives in — or null when it is not a relative
 * sibling path this host will probe.
 *
 * Refused: an absolute candidate (POSIX, UNC or drive-lettered), a backslash (candidates are written
 * with `/` so one manifest reads the same on every platform), an empty segment, a `..` **after** a
 * name (a re-descent the manifest could have written directly, and one that would make the ascent
 * count a lie), more than {@link MAX_ASCENTS} ascents, and a climb past the root. `.` segments are
 * dropped, and a candidate that resolves to no filename at all is refused.
 *
 * Refusing rather than normalising is the point: `../a/../../etc/passwd` normalises to something
 * perfectly ordinary, and the only place either half of this — a manifest's template and a filename
 * on disk — can be caught is here.
 */
export function resolveSibling(anchor: string, candidate: string): string | null {
  if (candidate === '' || candidate.includes('\\')) return null;
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return null;
  const parts = candidate.split('/');
  if (parts.some((part) => part === '')) return null;

  const separator = separatorOf(anchor);
  // Not {@link directoryOf}: it answers `''` both for a file at the root and for a bare name, and
  // the two differ here — `['']` is the root and joins back to `/sibling`, `[]` is neither and
  // joins to a bare name. An ascent may not pop either.
  const slash = Math.max(anchor.lastIndexOf('/'), anchor.lastIndexOf('\\'));
  const dir = slash < 0 ? [] : anchor.slice(0, slash).split(SEPARATOR);
  let ascents = 0;
  const tail: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part !== '..') {
      tail.push(part);
      continue;
    }
    if (tail.length > 0) return null;
    ascents += 1;
    if (ascents > MAX_ASCENTS) return null;
    // `['', 'data']` is `/data`: the leading empty segment is the root and may not be popped.
    if (dir.length <= 1) return null;
    dir.pop();
  }
  return tail.length === 0 ? null : [...dir, ...tail].join(separator);
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
  const match = matchAnchor(spec, name);
  if (match === null) return [];

  const tokens: Record<string, string> = { ...(match.groups ?? {}), stem: stemOf(name), name };
  const out: SiblingCandidate[] = [];

  for (const template of spec.candidates) {
    let bad = false;
    const substituted = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_all, token: string) => {
      const value = tokens[token];
      if (value === undefined) bad = true;
      return value ?? '';
    });
    if (bad) continue;
    // The segment rule runs on the **substituted** value, because a greedy group can capture
    // anything the basename contains and `resolveSibling` has no opinion about what a filename may
    // be made of — only about where it may sit.
    const segments = substituted.split('/');
    if (!segments.every((s) => s === '..' || SEGMENT.test(s))) continue;
    const path = resolveSibling(anchor, substituted);
    if (path === null || out.some((c) => c.path === path)) continue;
    out.push({ template, path });
  }
  return out;
}

/**
 * Does this rule claim the anchor's basename at all?
 *
 * Its own question because "the rule does not apply" and "the rule applies and every candidate was
 * refused" are different answers and {@link instantiateSiblings} returns `[]` for both:
 * `host.files.siblings` reports the second as a declared-but-not-found `null` per candidate, and
 * must say nothing whatsoever about the first.
 */
export function anchorMatches(spec: ModuleSibling, anchor: string): boolean {
  return matchAnchor(spec, baseNameOf(anchor)) !== null;
}

/** `new RegExp(spec.from).exec(name)` without letting a malformed manifest take the renderer down. */
function matchAnchor(spec: ModuleSibling, name: string): RegExpExecArray | null {
  try {
    return new RegExp(spec.from).exec(name);
  } catch {
    return null;
  }
}
