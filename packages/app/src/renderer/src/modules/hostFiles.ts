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
 * The candidate arithmetic is not here. `modules/siblings.ts` owns the manifest's token rules, its
 * segment rule, its ascent limit and `resolveSibling` — the same pure functions
 * `ShellController.dispatchSiblings` instantiates the `onSibling` route with — so "which paths does
 * this pattern name" has one answer whether a module asks or the app does.
 */

import { bridge } from '../bridge';
import type { ModuleManifest } from '../../../modules/manifest-types';
import type { ModuleHost } from './host';
import { anchorMatches, instantiateSiblings } from './siblings';

/** `bridge().allowPath`, structurally: admit a path and say whether it exists. */
export type AllowPath = (path: string) => Promise<{ path: string } | null>;

/**
 * The part of a manifest this file reads.
 *
 * A `ModuleManifest` satisfies it, and so does the partial literal a test builds: `createHostFiles`
 * needs three optional arrays and an id, and asking for a whole manifest to test a Save sheet would
 * make every fixture carry a `docs` heading and an activation list it has no use for.
 */
export interface HostFilesManifest extends Pick<
  ModuleManifest,
  'readers' | 'siblings' | 'writers'
> {
  id: string;
}

/**
 * Build the `files` half of a module's host.
 *
 * `allowPath` is injected rather than reached for so the sibling probe is testable without a bridge;
 * `ShellController.activateModule` passes `bridge().allowPath`.
 */
export function createHostFiles(
  manifest: HostFilesManifest,
  allowPath: AllowPath
): ModuleHost['files'] {
  const id = manifest.id;

  return {
    async readText(path) {
      const result = await bridge().moduleReadText(id, path);
      // A module asked for a file; "you may not read that" and "it is not there" are the same
      // answer to it, and main has already logged which one it was.
      return result.ok ? result.text : null;
    },

    async siblings(anchor) {
      const found: Record<string, string | null> = {};
      for (const rule of manifest.siblings ?? []) {
        // A rule that does not claim this anchor says **nothing** — not even a `null` per candidate.
        // The two are different answers: "no rule for this file" and "declared, probed, not there".
        if (!anchorMatches(rule, anchor)) continue;
        const resolved = new Map(
          instantiateSiblings(rule, anchor).map((candidate) => [candidate.template, candidate.path])
        );
        for (const template of rule.candidates) {
          // First rule to find a file wins; a later rule may still fill a candidate that missed.
          const already = found[template];
          if (already !== undefined && already !== null) continue;
          const path = resolved.get(template);
          // Refused by the token, segment or ascent rules — declared, so it is reported, and never
          // probed, so a manifest cannot name a file outside the tree it was pointed at.
          if (path === undefined) {
            found[template] = null;
            continue;
          }
          // `allowPath` doubles as the existence check (§5 rule 9's sidecar consequence), which is
          // why nothing here stats a file — the renderer cannot.
          const admitted = await allowPath(path);
          found[template] = admitted === null ? null : admitted.path;
        }
      }
      return found;
    },

    async openDialog(readerId) {
      const reader = (manifest.readers ?? []).find((r) => r.id === readerId);
      if (reader === undefined) return null;
      // `readerId` is what main looks the reader up by in `MANIFESTS`; the title and filters below
      // are the fallback for a build whose barrel does not carry this module, and main sanitises
      // them either way. Sending both is how one signature serves both cases.
      const opened = await bridge().moduleOpenDialog(id, {
        readerId,
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
        writerId,
        title: writer.title,
        filters: writer.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
        siblings: [...writer.siblings],
        defaultPath,
      });
    },

    async writeText(path, text, opts) {
      return bridge().moduleWriteText(id, path, text, { backup: opts?.backup === true });
    },

    // The PNG twin (2026-09-03). One line, like the four above, and deliberately a **separate**
    // channel rather than a `writeText` that accepts bytes: the extension allow-list and the size
    // cap differ (`.png` and 32 MiB against five text extensions and 8 MiB), and main decides which
    // set applies from the channel it was called on rather than from the shape of an argument.
    async writeBinary(path, bytes, opts) {
      return bridge().moduleWriteBinary(id, path, bytes, { backup: opts?.backup === true });
    },
  };
}
