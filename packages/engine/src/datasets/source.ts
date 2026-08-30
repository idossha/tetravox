/**
 * `DatasetSource` (§4.7) → protocol `LoadSource` (§6.5.1), and the sniff that decides which loader.
 *
 * The whole file is pure and testable without a worker, which matters because it is the enforcement
 * point for **§5 rule 3**: raw file bytes never touch the UI thread. A `DatasetSource` becomes a URL
 * the worker fetches itself, or a `File` it streams, and the `kind: 'bytes'` branch exists only for
 * tests and for a caller that already holds bytes — it is not the drop path (§8).
 */

import type { LoadSource, MeshFormatSel } from '@tetravox/protocol';
import type { DatasetSource } from '../api';

/**
 * A volume by name — NIfTI (`.nii`, `.nii.gz`), FreeSurfer (`.mgh`, `.mgz`), NRRD (`.nrrd`, `.nhdr`)
 * or MetaImage (`.mha`, `.mhd`) — goes to `loadVolume`, whose reader sniffs the bytes (§6.1); everything
 * else goes to the mesh loader (§6.2's `sniff`). The detached-header spellings (`.nhdr`, `.mhd`) are
 * routed here on purpose: the volume reader is the one that can say *why* they are unsupported.
 */
export function looksLikeVolume(name: string): boolean {
  return /\.(nii(\.gz)?|mgh|mgz|nrrd|nhdr|mha|mhd)$/i.test(name);
}

/**
 * `.geo` / `.pos` — a Gmsh **parsed post-processing** view (§6.2), which loads through `loadMesh`
 * with an explicit `format: 'geo'` rather than `'auto'`.
 *
 * Explicit on purpose. `sniff` would recognise a parsed view from its leading `View` token anyway,
 * but a `.geo` that turns out to be a *geometry script* would then fall out of `sniff` as
 * "unrecognised mesh format", burying the one message that tells the user what is actually wrong
 * with their file. Naming the format routes it to `read_geo_view`, whose rejection names the
 * command that gave the script away.
 */
export function looksLikeGeoView(name: string): boolean {
  return /\.(geo|pos)$/i.test(name);
}

/** The `loadMesh` format for a file name: explicit for a parsed view, `'auto'` for everything else. */
export function meshFormatFor(name: string): MeshFormatSel {
  return looksLikeGeoView(name) ? 'geo' : 'auto';
}

export function sourceName(src: DatasetSource): string {
  if (src.kind === 'path') return src.path.split(/[/\\]/).pop() ?? src.path;
  if (src.kind === 'file') return src.file.name;
  return src.name;
}

/**
 * `tetravox://file/<percent-encoded path>` (§5 directive A2).
 *
 * A `path` that is **already** a URL is passed through unchanged. Two things need that: a scene file
 * (§4.6) may legitimately reference one, and the §11 harness serves the reference dataset over
 * Vite's `/@fs/<abs path>` because `TETRAVOX_TESTDATA` lives outside the repo. Either way the worker
 * sees a `LoadSource.url` it can stream, and no byte reaches the UI thread (§5 rule 3).
 */
export function fileUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('/@fs/')) return path;
  return `tetravox://file/${encodeURIComponent(path)}`;
}

export function toLoadSource(src: DatasetSource): LoadSource {
  switch (src.kind) {
    case 'path':
      return {
        kind: 'url',
        url: fileUrl(src.path),
        sidecars: {
          lut: src.sidecars?.lut !== undefined ? fileUrl(src.sidecars.lut) : undefined,
          opt: src.sidecars?.opt !== undefined ? fileUrl(src.sidecars.opt) : undefined,
        },
      };
    case 'file':
      return { kind: 'file', file: src.file, sidecars: src.sidecars };
    case 'bytes':
      return { kind: 'bytes', name: src.name, bytes: src.bytes, sidecars: src.sidecars };
  }
}
