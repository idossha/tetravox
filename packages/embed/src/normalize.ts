/**
 * A host's partial `ViewSpec` → the complete §4.6 one `Engine.load` needs, plus the URL each
 * `DatasetRef` resolved to.
 *
 * Four gaps between what a host can write and what the engine requires, and this file is all of
 * them:
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
 *  3. **A points layer's host vocabulary.** Protocol 2 lets a host write `points[].state` and one
 *     `labelMode` instead of §4.4's colour-per-point and `showLabels`/`labelSource` pair; `points.ts`
 *     spends both here, before the engine sees the layer. Every other layer kind passes through
 *     untouched.
 *
 *  4. **`kind: 'surface'`, in both places it appears** (protocol 3). On a *layer* it is §4.4's own
 *     word and rides through untouched — the engine has had a `SurfaceLayer` since 0.4.0. On a
 *     *dataset ref* it is a host-facing spelling the engine does not have, and `datasetKind` maps
 *     it down to `'mesh'`; a surface is a mesh dataset with no tetrahedra, and which of the two
 *     words the host used changes nothing about the load. The third sidecar role, `fields`, is
 *     resolved against the dataset like the other two.
 *
 *     This is also the one file that **rejects** a spec rather than passing it on. `checkLayerKinds`
 *     refuses a `kind` this build does not know, because `Engine.load` would drop such a layer in
 *     silence and answer `loaded`.
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
import { EMBED_LAYER_KINDS } from './protocol';
import { isPointsLayer, resolvePointsLayer } from './points';

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

/**
 * A host's dataset kind → §4.6's.
 *
 * `'surface'` is protocol 3's host-facing spelling and the engine has no such dataset kind: a
 * surface is a `MeshDataset` whose `nTets` is 0, decided from the bytes by `isSurfaceMesh` and not
 * from anything a ref can say. Mapping it here rather than passing it through is what keeps that
 * true — the engine never sees a kind it does not have, and a host still gets to write the word it
 * means. Which of the two spellings was used changes nothing about the load.
 */
function datasetKind(kind: EmbedDatasetRef['kind']): DatasetRef['kind'] {
  return kind === 'surface' ? 'mesh' : kind;
}

function normalizeRef(ref: EmbedDatasetRef, base: string): { ref: DatasetRef; url: string } {
  const url = resolveUrl(ref.path, base);
  const out: DatasetRef = {
    id: ref.id,
    kind: datasetKind(ref.kind),
    name: ref.name,
    path: url,
    // §4.6's fingerprint is computed in the worker over the file's own bytes; a host has never seen
    // them. It identifies a file for the relocate dialog, of which an embed has none, so the empty
    // string is the exact answer and not a placeholder.
    fingerprint: ref.fingerprint ?? '',
  };
  const lut = ref.sidecars?.lut;
  const opt = ref.sidecars?.opt;
  // Protocol 3's third role: the per-vertex files attached to a surface. An ARRAY, and the order is
  // the attach order the engine replays — so it is mapped rather than reduced, and an empty one is
  // left off entirely rather than written as `fields: []`.
  const fields = ref.sidecars?.fields ?? [];
  if (lut !== undefined || opt !== undefined || fields.length > 0) {
    out.sidecars = {};
    if (lut !== undefined) out.sidecars.lut = { path: '', absPath: resolveUrl(lut.path, url) };
    if (opt !== undefined) out.sidecars.opt = { path: '', absPath: resolveUrl(opt.path, url) };
    if (fields.length > 0) {
      out.sidecars.fields = fields.map((f) => ({ path: '', absPath: resolveUrl(f.path, url) }));
    }
  }
  return { ref: out, url };
}

/**
 * Refuse a layer kind this build cannot draw — protocol 3's one guard, and the reason its number
 * moved.
 *
 * Everything else in this file is permissive on purpose: unknown *fields* ride through to the
 * engine untouched, because §4.4 is the complete layer model and this package is a subset of it
 * that is allowed to be behind. A `kind` is the exception, and the difference is what the silence
 * costs. `Engine.load` filters its layers through `isRestorableKind` and **skips** the ones it does
 * not know — no throw, no event — so a spec written against a later protocol loaded here as a
 * successful `loaded` reply carrying a scene with the layer missing. That is the worst answer
 * available: the host is told it worked.
 *
 * So the kinds are checked here, before anything is fetched, and an unknown one throws with the
 * layer's index, the kind it sent and the four that exist. `host.ts` turns that into
 * `status: 'error'` and an `error` reply naming it, exactly as a bad URL is handled.
 */
function checkLayerKinds(layers: Record<string, unknown>[]): void {
  const known = new Set<string>(EMBED_LAYER_KINDS);
  layers.forEach((layer, index) => {
    const kind = layer['kind'];
    if (typeof kind !== 'string' || !known.has(kind)) {
      throw new Error(
        `layers[${index}]: unknown layer kind ${JSON.stringify(kind)} — ` +
          `this build understands ${EMBED_LAYER_KINDS.join(', ')}. ` +
          `A tetrahedral FEM .msh is 'mesh'; a triangular surface (FreeSurfer or GIfTI) is 'surface'.`
      );
    }
  });
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
  // FIRST, before a single URL is resolved: a spec naming a kind this build cannot draw is refused
  // outright, and refusing it here means the host hears about the typo instead of the malformed URL
  // three lines down, and no dataset is queued for fetching on the way to finding out.
  checkLayerKinds(scene.layers ?? []);

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
  // Protocol 2: a points layer's `state` and `labelMode` are this protocol's vocabulary, spent here
  // so the engine only ever sees §4.4's. Every other layer kind rides through untouched, which is
  // what keeps a protocol-1 scene byte-identical on its way to `Engine.load`.
  spec['layers'] = (scene.layers ?? []).map((layer) =>
    isPointsLayer(layer) ? resolvePointsLayer(layer) : layer
  );
  spec['activeLayerId'] = scene.activeLayerId ?? null;
  spec['version'] = scene.version ?? template.version;
  for (const field of VIEW_FIELDS) {
    if (spec[field] === undefined)
      spec[field] = (template as unknown as Record<string, unknown>)[field];
  }

  return { spec: spec as unknown as ViewSpec, resolved };
}
