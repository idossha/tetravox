/**
 * `ModuleHost['files']` over the §5 rule 11 channels — the module surface's whole filesystem.
 *
 * Two halves, and the split is the interesting part:
 *
 *  * **Reading, opening, saving and writing are main's**, because main owns the allow-list, the
 *    write list, the caps and the OS sheets. This file is four one-line calls onto the bridge, with
 *    the module's own id attached to each so the write list stays per module.
 *  * **Sibling discovery is the renderer's**, because the app already discovers sidecars by name
 *    that way: `open/sources.ts#firstAllowed` probes derived candidates through
 *    `bridge().allowPath`, where a null return *is* the existence check and nothing ever stats a
 *    file. A resolver in main would need a listing IPC this app does not have and would add no
 *    admission-policy gain (DECISIONS 2026-08-30).
 *
 * The candidate arithmetic is pure string work — `resolveSibling` — so it is unit-testable with no
 * disk, no bridge and no Electron, exactly like `lib/sidecars.ts`.
 */

import { bridge } from '../bridge';
import { baseName } from '../lib/sidecars';

// ------------------------------------------------------------------------------------------------
// Manifest shapes
// ------------------------------------------------------------------------------------------------

// INTEGRATION(P0): local structural copies of the three IO members of
// `packages/app/src/modules/manifest-types.ts`, so this file compiles and is tested before that
// module lands. When it does, the integrator deletes these four declarations and imports
// `ModuleReader`, `ModuleSibling`, `ModuleWriter` and `ModuleManifest` from
// `../../../modules/manifest-types` — they are structurally identical, so nothing else here moves.

/** A format the module claims by extension (and optionally by a name pattern). */
export interface ModuleReader {
  id: string;
  title: string;
  extensions: string[];
  /** RegExp source over the basename. */
  match?: string;
}

/**
 * A rule for finding files that belong with an anchor the user opened.
 *
 * `from` is a RegExp source matched against the anchor's **basename**; its **named groups** are the
 * tokens a candidate may use. `candidates` are relative to the anchor's directory, use `/` as their
 * separator whatever the platform, and may climb at most three `..` — a BIDS `ct/` to `ieeg/` hop is
 * one, and three is already further than any layout this app opens.
 */
export interface ModuleSibling {
  from: string;
  candidates: string[];
}

/** A file the module writes, with the same-directory siblings its Save sheet should admit. */
export interface ModuleWriter {
  id: string;
  title: string;
  filters: { name: string; extensions: string[] }[];
  /** Templates over the chosen path: `{name}.{stamp}.bak`, `{stem}_editlog.json`. */
  siblings: string[];
  backup?: 'timestamped';
}

/** The part of `ModuleManifest` this file needs. */
export interface HostFilesManifest {
  id: string;
  readers?: ModuleReader[];
  siblings?: ModuleSibling[];
  writers?: ModuleWriter[];
}

/** `ModuleHost['files']` (P0's `host.ts`), declared here for the same reason as the types above. */
export interface HostFiles {
  readText(path: string): Promise<string | null>;
  siblings(anchor: string): Promise<Record<string, string | null>>;
  openDialog(readerId: string): Promise<string[] | null>;
  saveDialog(
    writerId: string,
    defaultPath: string | null
  ): Promise<{ path: string; siblings: Record<string, string> } | null>;
  writeText(
    path: string,
    text: string,
    opts?: { backup?: boolean }
  ): Promise<{ ok: true; backupPath: string | null } | { ok: false; error: string }>;
}

/** `bridge().allowPath`, structurally: admit a path and say whether it exists. */
export type AllowPath = (path: string) => Promise<{ path: string } | null>;

/** How far a candidate may climb. Three is a BIDS hop and then some. */
export const MAX_SIBLING_ASCENTS = 3;

// ------------------------------------------------------------------------------------------------
// Candidate paths, as pure string work
// ------------------------------------------------------------------------------------------------

/** The separator the anchor is written with, so a Windows path stays a Windows path. */
function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/**
 * The anchor's directory, keeping its own separator, or null when the anchor names no directory at
 * all. `''` is a real answer — a file at the root — and joins back to `/sibling`.
 */
function dirNameOf(path: string): string | null {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash < 0 ? null : path.slice(0, slash);
}

/**
 * `candidate`, resolved against the directory `anchor` lives in — or null when it is not a relative
 * sibling path this host will probe.
 *
 * Refused: an absolute candidate (POSIX, UNC or drive-lettered), a backslash (candidates are written
 * with `/` so one manifest reads the same on every platform), more than {@link MAX_SIBLING_ASCENTS}
 * `..` segments, and a climb past the root. `.` segments are dropped.
 */
export function resolveSibling(anchor: string, candidate: string): string | null {
  if (candidate === '' || candidate.includes('\\')) return null;
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return null;
  const parts = candidate.split('/');
  if (parts.some((part) => part === '')) return null;

  const separator = separatorOf(anchor);
  const parent = dirNameOf(anchor);
  const dir = parent === null ? [] : parent.split(separator);
  let ascents = 0;
  const tail: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part !== '..') {
      tail.push(part);
      continue;
    }
    // A `..` after a name would be a re-descent the manifest could have written directly, and
    // allowing it would make the ascent count a lie.
    if (tail.length > 0) return null;
    ascents += 1;
    if (ascents > MAX_SIBLING_ASCENTS) return null;
    // `['', 'data']` is `/data`: the leading empty segment is the root and may not be popped.
    if (dir.length <= 1) return null;
    dir.pop();
  }
  return tail.length === 0 ? null : [...dir, ...tail].join(separator);
}

/**
 * Substitute `{group}` for each of the pattern's **named groups**, or null when a token is left
 * over. An unknown token is a manifest that named a group it did not capture, and guessing what it
 * meant would be worse than not probing.
 */
export function substituteCandidate(
  candidate: string,
  groups: Record<string, string | undefined>
): string | null {
  const filled = candidate.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, token: string) => {
    const value = groups[token];
    return value === undefined ? whole : value;
  });
  return filled.includes('{') || filled.includes('}') ? null : filled;
}

/** `new RegExp(source)` without letting a malformed manifest take the renderer down. */
function compile(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// The host member
// ------------------------------------------------------------------------------------------------

/**
 * Build the `files` half of a module's host.
 *
 * `allowPath` is injected rather than reached for so the sibling probe is testable without a bridge;
 * `hostImpl.ts` passes `bridge().allowPath`.
 */
export function createHostFiles(manifest: HostFilesManifest, allowPath: AllowPath): HostFiles {
  const id = manifest.id;

  return {
    async readText(path) {
      const result = await bridge().moduleReadText(id, path);
      // A module asked for a file; "you may not read that" and "it is not there" are the same
      // answer to it, and main has already logged which one it was.
      return result.ok ? result.text : null;
    },

    async siblings(anchor) {
      const name = baseName(anchor);
      const found: Record<string, string | null> = {};
      for (const rule of manifest.siblings ?? []) {
        const pattern = compile(rule.from);
        if (pattern === null) continue;
        const match = pattern.exec(name);
        if (match === null) continue;
        const groups = match.groups ?? {};
        for (const candidate of rule.candidates) {
          // First rule to find a file wins; a later rule may still fill a candidate that missed.
          const already = found[candidate];
          if (already !== undefined && already !== null) continue;
          const filled = substituteCandidate(candidate, groups);
          const path = filled === null ? null : resolveSibling(anchor, filled);
          if (path === null) {
            found[candidate] = null;
            continue;
          }
          // `allowPath` doubles as the existence check (§5 rule 9's sidecar consequence), which is
          // why nothing here stats a file — the renderer cannot.
          const admitted = await allowPath(path);
          found[candidate] = admitted === null ? null : admitted.path;
        }
      }
      return found;
    },

    async openDialog(readerId) {
      const reader = (manifest.readers ?? []).find((r) => r.id === readerId);
      if (reader === undefined) return null;
      const opened = await bridge().moduleOpenDialog(id, {
        title: reader.title,
        filters: [
          { name: reader.title, extensions: [...reader.extensions] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      // Cancelled and "chose nothing" are the same gesture; null is what the host API says for it.
      return opened.length === 0 ? null : opened.map((o) => o.path);
    },

    async saveDialog(writerId, defaultPath) {
      const writer = (manifest.writers ?? []).find((w) => w.id === writerId);
      if (writer === undefined) return null;
      return bridge().moduleSaveDialog(id, {
        title: writer.title,
        filters: writer.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
        siblings: [...writer.siblings],
        defaultPath,
      });
    },

    async writeText(path, text, opts) {
      return bridge().moduleWriteText(id, path, text, { backup: opts?.backup === true });
    },
  };
}
