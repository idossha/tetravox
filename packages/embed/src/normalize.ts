/**
 * A host's partial `ViewSpec` → the complete §4.6 one `Engine.load` needs, plus the URL each
 * `DatasetRef` resolved to.
 *
 * Two gaps between what a host can write and what the engine requires, and this file is both:
 *
 *  1. **Nine mandatory view fields a host cannot know.** `applyViewSpec` assigns `slices`, `view3d`,
 *     `layout`, `cursor`, `radiological`, `background`, `lighting`, `annotations` and
 *     `transparency` unconditionally, because a saved scene is a *complete* description and merging
 *     would let a stale live scene leak into a loaded one. That rule is right for a file on disk
 *     and impossible for a host writing a scene by hand — nobody should have to invent a camera
 *     quaternion to show a T1. So an absent key is filled from a **template**, which the caller
 *     captures with `Engine.serialize()` at boot, before anything is loaded. The defaults are then
 *     the engine's own, and this package holds no second copy of them to drift.
 *
 *  2. **URLs.** `DatasetRef.path` in a file on disk is relative to the scene file. In an embed
 *     there is no scene file and no disk: a ref is a URL. An absolute `http(s)://` is used as-is;
 *     anything else — `data/T1.nii.gz`, `/api/files/raw/T1.nii.gz` — is resolved against `baseUrl`,
 *     which defaults to the embed document's own `baseURI`.
 *
 *     Resolving here rather than leaving it to the engine is **load-bearing**, not tidiness.
 *     `datasets/source.ts`'s `fileUrl` passes through exactly two shapes — a string with a
 *     `scheme://`, and Vite's `/@fs/` — and turns everything else into `tetravox://file/<encoded>`.
 *     A root-relative `/api/files/raw/…` is neither, so handed over unresolved it becomes a
 *     `tetravox://` request that no browser outside Electron can serve, and the load fails with a
 *     network error naming a scheme the host never mentioned. Absolutising every ref before it
 *     reaches the engine is what makes both spellings work.
 *
 * Sidecars get the same treatment against a different base: §4.6 anchors `SidecarRef.path` to **the
 * dataset's own directory**, because a sidecar travels with the file it describes. `new URL(path,
 * datasetUrl)` is exactly that rule, so the resolved sidecar is written into `absPath` with `path`
 * emptied — `sidecarPathsFor` prefers a non-empty relative path and falls back to `absPath`, so
 * this hands it the one answer rather than letting it redo the arithmetic on a URL with its own
 * string-splitting.
 */

import type { DatasetRef, ViewSpec } from '@tetravox/engine';
import type { EmbedDatasetRef, EmbedViewSpec } from './protocol';

/** What {@link normalizeScene} produced: the spec to load, and `Engine.load`'s resolver input. */
export interface NormalizedScene {
  spec: ViewSpec;
  /** `DatasetRef.id` → the absolute URL it resolved to. */
  resolved: Record<string, string>;
}

/** The nine §4.6 view fields a host may omit, filled from the template. */
const VIEW_FIELDS = [
  'slices',
  'view3d',
  'layout',
  'cursor',
  'radiological',
  'background',
  'lighting',
  'transparency',
  'annotations',
] as const;

/**
 * Absolutise one path.
 *
 * `URL` does the whole job — it passes an absolute URL through unchanged and resolves every
 * relative spelling against the base — so there is no scheme sniffing here and no regex to get
 * subtly wrong. A `base` that is not itself absolute makes `new URL` throw, which is why the caller
 * defaults it to `document.baseURI`.
 */
export function resolveUrl(path: string, base: string): string {
  return new URL(path, base).href;
}

function normalizeRef(ref: EmbedDatasetRef, base: string): { ref: DatasetRef; url: string } {
  const url = resolveUrl(ref.path, base);
  const out: DatasetRef = {
    id: ref.id,
    kind: ref.kind,
    name: ref.name,
    path: url,
    // §4.6's fingerprint is computed in the worker over the file's own bytes; a host has never seen
    // them. It identifies a file for the relocate dialog, of which an embed has none, so the empty
    // string is the exact answer and not a placeholder.
    fingerprint: ref.fingerprint ?? '',
  };
  const lut = ref.sidecars?.lut;
  const opt = ref.sidecars?.opt;
  if (lut !== undefined || opt !== undefined) {
    out.sidecars = {};
    if (lut !== undefined) out.sidecars.lut = { path: '', absPath: resolveUrl(lut.path, url) };
    if (opt !== undefined) out.sidecars.opt = { path: '', absPath: resolveUrl(opt.path, url) };
  }
  return { ref: out, url };
}

/**
 * Fill a host's spec and resolve its refs.
 *
 * `template` is `Engine.serialize()` on the **empty** scene. Every key the host sent wins; every
 * key it omitted comes from there. `version` is forced to the template's `SCENE_VERSION` when the
 * host omits it, because `Engine.load` refuses a version above the current one and a host that
 * says nothing means "whatever this build reads", not "version undefined".
 */
export function normalizeScene(
  scene: EmbedViewSpec,
  template: ViewSpec,
  baseUrl: string
): NormalizedScene {
  const resolved: Record<string, string> = {};
  const datasets = (scene.datasets ?? []).map((ref) => {
    const { ref: out, url } = normalizeRef(ref, baseUrl);
    resolved[out.id] = url;
    return out;
  });

  const spec = { ...template } as unknown as Record<string, unknown>;
  // Every key the host sent, including ones this build has never heard of: §4.6 guarantees
  // per-layer fields ride the spread, and the same courtesy at the top level is what lets a host
  // written against a later build send a scene to an older embed without it being silently dropped
  // on the way to `migrateViewSpec`.
  for (const [key, value] of Object.entries(scene)) {
    if (value !== undefined) spec[key] = value;
  }
  spec['datasets'] = datasets;
  spec['layers'] = scene.layers ?? [];
  spec['activeLayerId'] = scene.activeLayerId ?? null;
  spec['version'] = scene.version ?? template.version;
  for (const field of VIEW_FIELDS) {
    if (spec[field] === undefined)
      spec[field] = (template as unknown as Record<string, unknown>)[field];
  }

  return { spec: spec as unknown as ViewSpec, resolved };
}
