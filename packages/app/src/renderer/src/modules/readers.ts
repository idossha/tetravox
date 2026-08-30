/**
 * Which module claims a path (§13.1's `onReader`).
 *
 * `open/sources.ts` routes nothing by extension: every path becomes a `DatasetSource` and the engine
 * decides, so a `.tsv` reaches `loadMesh 'auto'` and comes back "unsupported". A module's reader is
 * the one place where a filename means something before the loader sees it, so it is deliberately
 * narrow — an extension list, plus an optional regexp over the **basename**.
 *
 * Over the basename and never the whole path: a reader for `_electrodes\.tsv$` matched against a
 * path would claim every file inside a directory called `..._electrodes.tsv`, which is a directory
 * name a BIDS derivative could plausibly have.
 *
 * Pure, so the precedence between two modules that both claim `.tsv` is a unit test rather than a
 * question about load order.
 */

import type { ModuleManifest } from '../../../modules/manifest-types';

export interface ReaderClaim {
  manifest: ModuleManifest;
  /** The manifest's own reader id; the host namespaces it as `<moduleId>/<id>`. */
  readerId: string;
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? '';
}

function matchesName(source: string, name: string): boolean {
  try {
    return new RegExp(source).test(name);
  } catch {
    return false;
  }
}

/**
 * The first module whose reader claims this path, in registration order, or null.
 *
 * Registration order rather than "most specific wins": the registry is a hand-written list in one
 * file, so the order is visible and editable, whereas a specificity rule would make which module
 * opened a file depend on how each of them happened to spell its pattern.
 */
export function readerClaim(
  manifests: readonly ModuleManifest[],
  path: string
): ReaderClaim | null {
  const name = baseName(path);
  const lower = name.toLowerCase();
  for (const manifest of manifests) {
    for (const reader of manifest.readers ?? []) {
      if (!reader.extensions.some((e) => lower.endsWith(`.${e.toLowerCase()}`))) continue;
      // A manifest whose `match` is not a regexp claims nothing rather than throwing on every open.
      // `modules.test.ts` fails the build for it separately, which is where that belongs.
      if (reader.match !== undefined && !matchesName(reader.match, name)) continue;
      return { manifest, readerId: reader.id };
    }
  }
  return null;
}
