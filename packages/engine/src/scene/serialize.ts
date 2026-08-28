/**
 * `ViewSpec` in and out — §4.6's persisted form, `*.tetravox.json` (P2-07).
 *
 * Four things the audit named as missing, and how each is closed here:
 *
 * * **Relative paths.** §4.6 wants `DatasetRef.path` "relative to the scene file, with an absolute
 *   fallback". §4.7's `serialize()` takes no argument, so the engine is *told* where the scene file
 *   will live (`TetravoxEngine.setSceneDir`) and defaults to the datasets' own
 *   {@link commonDirectory} when it has not been. Either way `absPath` is always written, so a spec
 *   that moves house still resolves; {@link candidatePaths} is the resolution order a host should
 *   use before it opens a relocate dialog.
 * * **Fingerprints.** Computing one needs the file bytes, which the UI thread never sees (§5 rule 3),
 *   so it is the loader's — a `fingerprint` on `VolumeMeta` / `MeshMeta`, filed with W-WASM as gap 1
 *   of `docs/PHASE2-OWNERSHIP.md`. {@link fingerprintFromMeta} reads it **when it is there** and
 *   yields `''` until then, so the field lights up the day that lands, with no change here.
 * * **The dataset-id remap.** A load re-adds datasets and they get fresh ids (`ds1`, `ds2`, …) that
 *   do not match the spec's, which is why Phase 1 could not restore `spec.layers` at all — the
 *   missing piece was a remap, not an assignment. {@link remapLayer} rewrites `datasetId` *and* the
 *   two places a layer names a **second** dataset: `MeshLayer.isolate.labelVolume` and
 *   `IsosurfaceLayer.source`.
 * * **`activeLayerId`,** and with it `SliceView.layerVisibility` / `View3D.layerVisibility`, which are
 *   keyed by `LayerId` and need the same treatment one level up ({@link remapViews}).
 *
 * The whole file is pure and JSON-only. A `ViewSpec` that leaves here must survive
 * `JSON.parse(JSON.stringify(spec))` unchanged — §4.6's `SerializableLayer` exists precisely because
 * `Layer` does not: `visibleLabels` is a `Uint32Array` and `MeshLayer.label.table` holds a `Map`.
 */

import type { SceneStore } from './store';
import type {
  DatasetId,
  DatasetRef,
  Layer,
  LayerId,
  MeshLayer,
  Scene,
  SerializableLayer,
  SidecarRef,
  SliceView,
  Threshold,
  View3D,
  ViewSpec,
} from './types';

/** The role-keyed sidecar paths a dataset was opened with, as `Engine.addDataset` took them. */
export type SidecarPaths = { lut?: string; opt?: string };

/** The §4.6 fields {@link applyViewSpec} restores directly, without a remap. */
export const ROUND_TRIP_FIELDS = [
  'slices',
  'view3d',
  'layout',
  'cursor',
  'radiological',
  'background',
  'lighting',
  'annotations',
  'transparency',
] as const;

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Split on either separator, so a Windows path and a POSIX one take one code path. */
function segments(path: string): string[] {
  return path.split(/[/\\]/);
}

/**
 * True for a location this module must not treat as a path: a URL.
 *
 * A scene file may legitimately reference one (`datasets/source.ts` passes it to the worker
 * verbatim), and `https://host/a/b.nii` relative to `/data` is not a thing — the rewrite would
 * produce something nothing can open.
 *
 * A Vite `/@fs/<abs path>` alias, which is how the §11 harness serves the reference dataset, is
 * **not** opaque: it is structurally an absolute path with one extra leading segment, so `..` and
 * joins behave exactly as they do on the real path underneath. That is deliberate — it is what lets
 * the harness exercise this code rather than skipping past it.
 */
export function isOpaqueLocation(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

/** The directory part of a path: everything before the last separator. */
export function directoryOf(path: string): string {
  const parts = segments(path);
  parts.pop();
  return parts.join('/');
}

/**
 * The longest directory prefix every path shares, `''` when they share none.
 *
 * This is `serialize()`'s default scene directory: with no host to say where the file will be
 * written, the directory the data already sits in is the one relative paths are likeliest to survive
 * being written next to.
 */
export function commonDirectory(paths: readonly string[]): string {
  const usable = paths.filter((p) => p !== '' && !isOpaqueLocation(p)).map((p) => segments(p));
  const first = usable[0];
  if (first === undefined) return '';
  let common = first.slice(0, -1);
  for (const parts of usable.slice(1)) {
    const dir = parts.slice(0, -1);
    let i = 0;
    while (i < common.length && i < dir.length && common[i] === dir[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.join('/');
}

/**
 * `path` expressed relative to `dir`, with `..` where it has to climb.
 *
 * Returns `path` unchanged when it is a URL, when `dir` is empty, or when the two are on different
 * roots — a relative path that cannot be written is worse than an absolute one.
 */
export function relativePath(dir: string, path: string): string {
  if (path === '' || dir === '' || isOpaqueLocation(path)) return path;
  const from = segments(dir).filter((s) => s !== '');
  const to = segments(path).filter((s) => s !== '');
  const absoluteFrom = /^[/\\]/.test(dir);
  const absoluteTo = /^[/\\]/.test(path);
  if (absoluteFrom !== absoluteTo) return path;
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i += 1;
  // Different drive, or nothing at all in common below the root: nothing relative expresses it.
  if (i === 0 && absoluteFrom) return path;
  const up = new Array<string>(from.length - i).fill('..');
  return [...up, ...to.slice(i)].join('/');
}

/** `dir` + `rel`, resolving `.` and `..`. The inverse of {@link relativePath}. */
export function joinPath(dir: string, rel: string): string {
  if (rel === '' || dir === '' || isOpaqueLocation(rel) || /^[/\\]/.test(rel)) return rel;
  const absolute = /^[/\\]/.test(dir);
  const parts = [...segments(dir), ...segments(rel)].filter((s) => s !== '' && s !== '.');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (absolute ? '/' : '') + out.join('/');
}

/**
 * Where a `DatasetRef` might be found, in the order §4.6 gives: the scene-relative path first, the
 * absolute fallback second.
 *
 * Exported for the host, because §4.7's `load(spec, resolve)` makes the **caller** the resolver —
 * this is the policy it should apply before opening §8's relocate dialog, so that "relative first,
 * absolute fallback" is one implementation rather than one per host.
 */
export function candidatePaths(ref: DatasetRef, sceneDir: string | null): string[] {
  const out: string[] = [];
  if (ref.path !== '') out.push(sceneDir !== null ? joinPath(sceneDir, ref.path) : ref.path);
  if (ref.absPath !== undefined && ref.absPath !== '' && !out.includes(ref.absPath)) {
    out.push(ref.absPath);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------------------------

export interface SerializeOptions {
  /**
   * Directory the scene file will be written to. `null` (the default) uses
   * {@link commonDirectory} of the datasets' own paths.
   */
  sceneDir?: string | null;
  /** Per-dataset fingerprints from the loader's meta (see {@link fingerprintFromMeta}). */
  fingerprints?: ReadonlyMap<DatasetId, string>;
  /**
   * Per-dataset §6.5.1 sidecar paths, as the host handed them to `addDataset`.
   *
   * They are not on `Dataset` and cannot be re-derived: the app's `lib/sidecars.ts` *guesses*
   * candidates from the dataset's name and checks which exist, and a user who picked a LUT the
   * guesser would not have found must still get it back. The engine remembers what it was given.
   */
  sidecars?: ReadonlyMap<DatasetId, SidecarPaths>;
}

/**
 * One sidecar as a `SidecarRef`: relative to the **dataset's** directory, with an absolute fallback.
 *
 * Anchored to the dataset rather than to the scene file, because a sidecar travels with the file it
 * describes. `ernie.msh.opt` sits beside `ernie.msh`; move the pair and the relative path still
 * resolves, which is exactly the case §8's relocate dialog exists for.
 */
export function sidecarRef(datasetPath: string, sidecarPath: string): SidecarRef {
  const ref: SidecarRef = { path: relativePath(directoryOf(datasetPath), sidecarPath) };
  if (sidecarPath !== '' && !isOpaqueLocation(sidecarPath)) ref.absPath = sidecarPath;
  return ref;
}

/**
 * Where a sidecar might be found once its dataset has resolved to `datasetPath`.
 *
 * Dataset-relative first, absolute second — the same order, and for the same reason, as
 * {@link candidatePaths}. Reading a sidecar is best-effort in the loader
 * (`packages/wasm/src/sources.ts`), so handing it a path that turns out not to exist costs a missing
 * table, never a failed load.
 */
export function sidecarPathsFor(ref: DatasetRef, datasetPath: string): SidecarPaths {
  const out: SidecarPaths = {};
  for (const role of ['lut', 'opt'] as const) {
    const s = ref.sidecars?.[role];
    if (s === undefined) continue;
    const relative = s.path === '' ? undefined : joinPath(directoryOf(datasetPath), s.path);
    const chosen = relative ?? s.absPath;
    if (chosen !== undefined && chosen !== '') out[role] = chosen;
  }
  return out;
}

/** One `DatasetRef` per loaded dataset: relative path, absolute fallback, fingerprint. */
export function datasetRefs(scene: Scene, opts: SerializeOptions = {}): DatasetRef[] {
  const datasets = [...scene.datasets.values()];
  const dir = opts.sceneDir ?? commonDirectory(datasets.map((ds) => ds.path ?? ''));
  return datasets.map((ds) => {
    const absPath = ds.path ?? '';
    const ref: DatasetRef = {
      id: ds.id,
      kind: ds.kind === 'volume' ? 'volume' : 'mesh',
      name: ds.name,
      path: relativePath(dir, absPath),
      fingerprint: opts.fingerprints?.get(ds.id) ?? '',
    };
    if (absPath !== '') ref.absPath = absPath;
    const cars = opts.sidecars?.get(ds.id);
    if (cars !== undefined && absPath !== '') {
      const sidecars: NonNullable<DatasetRef['sidecars']> = {};
      if (cars.lut !== undefined) sidecars.lut = sidecarRef(absPath, cars.lut);
      if (cars.opt !== undefined) sidecars.opt = sidecarRef(absPath, cars.opt);
      if (Object.keys(sidecars).length > 0) ref.sidecars = sidecars;
    }
    return ref;
  });
}

/**
 * The loader's per-file fingerprint, when the meta carries one.
 *
 * §4.6 defines it as `"<size>-<sha256 of first 1 MiB>-<sha256 of last 1 MiB>"`, and §5 rule 3 puts
 * the only place it can be computed — over the input bytes — inside the dataset's worker. That is
 * gap 1 of `docs/PHASE2-OWNERSHIP.md`, owned by **W-WASM**: `VolumeMeta` and `MeshMeta` do not carry
 * the field yet. Reading it defensively rather than declaring it is deliberate — the declaration
 * lives in a **frozen** file (`packages/protocol/src/index.ts`) that E-SCENE may not touch, and a
 * cast that *asserted* the field would be a lie about the wire. This accepts only a string and
 * yields `''` otherwise, which is what §4.6's consumer — the relocate dialog — already reads as
 * "cannot verify".
 */
export function fingerprintFromMeta(meta: unknown): string {
  const value = (meta as { fingerprint?: unknown } | null)?.fingerprint;
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------

/**
 * One layer, as JSON.
 *
 * Two fields of §4.4 are not JSON, and §4.6's `SerializableLayer` says so: `visibleLabels` is a
 * `Uint32Array` (which `JSON.stringify` silently turns into `{"0":1,"1":2}`) and
 * `MeshLayer.label.table` is a `LabelTable` holding a `Map` (which becomes `{}`). The table is not
 * persisted at all — §4.6: "`LabelTable`s are **not** serialised; they are re-derived from the
 * dataset and its LUT on load".
 */
/**
 * JSON has no infinity, and `Threshold` is full of it.
 *
 * `JSON.stringify(Infinity)` is `null` — silently, with no error and no warning — so a default
 * threshold (`lo: -Infinity, hi: Infinity`, "let everything through") reached the file as
 * `{"lo": null, "hi": null}` and came back as two nulls, which is not a number and is not a bound.
 * Directed task 13's round-trip test is what found it, on a scene nobody had edited: every layer
 * every user has ever saved carried it.
 *
 * The encoding is `null` **on purpose** rather than by accident, and the two are read back as the
 * bound they mean: a missing `lo` is no lower bound, a missing `hi` is no upper one. A sentinel
 * string would have been the other option and is worse — it makes the field's type a union in a file
 * humans are meant to be able to read and edit (§4.6: "a scene file a human can read").
 */
function jsonThreshold(threshold: Threshold): Record<string, unknown> {
  return {
    ...threshold,
    lo: Number.isFinite(threshold.lo) ? threshold.lo : null,
    hi: Number.isFinite(threshold.hi) ? threshold.hi : null,
  };
}

/** The inverse: `null` is the unbounded side it was written for. NaN is not preserved and is not a bound. */
function runtimeThreshold(value: unknown): Threshold | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as { lo?: unknown; hi?: unknown };
  return {
    ...(value as Threshold),
    lo: typeof raw.lo === 'number' && Number.isFinite(raw.lo) ? raw.lo : -Infinity,
    hi: typeof raw.hi === 'number' && Number.isFinite(raw.hi) ? raw.hi : Infinity,
  };
}

export function serializableLayer(layer: Layer): SerializableLayer {
  const out = { ...layer } as Record<string, unknown>;
  if ('threshold' in layer) out.threshold = jsonThreshold(layer.threshold);
  if ('visibleLabels' in layer && layer.visibleLabels !== undefined) {
    out.visibleLabels = [...layer.visibleLabels];
  }
  if (layer.kind === 'points') {
    // A parsed Gmsh view's labels and `SL` segments are **dataset**-derived (`MeshDataset.geo`), so
    // they are re-seeded by `defaultLayerFor` on restore, exactly as a `.label.gii`'s `LabelTable`
    // is. Dropping them here is not a loss and is the only correct answer for `lineSegments`: it is
    // a `Float32Array`, and `JSON.stringify` turns one into `{"0":…}` — a scene file that would
    // restore garbage, silently, and be megabytes of it.
    delete out.lineSegments;
    delete out.labels;
  }
  if (layer.kind === 'mesh' && layer.label !== undefined) {
    const { name, mode, outlineWidthPx, visibleLabels } = layer.label;
    out.label = {
      name,
      mode,
      outlineWidthPx,
      ...(visibleLabels !== undefined ? { visibleLabels: [...visibleLabels] } : {}),
    };
  }
  return out as SerializableLayer;
}

/**
 * A serialised layer as a patch for `Engine.addLayer`, with every `DatasetId` in it remapped.
 *
 * A layer names its own dataset, and two kinds name a second one: `MeshLayer.isolate.labelVolume`
 * (the label volume an isolation mask is cut from) and `IsosurfaceLayer.source`. A remap that missed
 * either would restore a scene whose isolation had silently stopped applying.
 *
 * Returns `null` when a dataset the layer cannot do without did not resolve.
 */
export function remapLayer(
  layer: SerializableLayer,
  idMap: ReadonlyMap<DatasetId, DatasetId>
): (Partial<Layer> & { datasetId: DatasetId; kind: Layer['kind'] }) | null {
  const datasetId = idMap.get(layer.datasetId);
  if (datasetId === undefined) return null;
  const out = { ...(layer as unknown as Record<string, unknown>) };
  delete out.id;
  out.datasetId = datasetId;

  const visible = (layer as { visibleLabels?: number[] }).visibleLabels;
  if (visible !== undefined) out.visibleLabels = Uint32Array.from(visible);

  // The `null`s {@link jsonThreshold} wrote, back as the ±Infinity they stand for.
  const threshold = runtimeThreshold(out['threshold']);
  if (threshold !== undefined) out.threshold = threshold;

  if (layer.kind === 'mesh') {
    // §4.6 does not serialise the `LabelTable`, so the spec's `label` has no `table` and cannot be
    // handed to `addLayer` as a `MeshLayer['label']`. It **is** carried, though: `mode`,
    // `outlineWidthPx` and `visibleLabels` are things the user set in the annotation editor, and
    // deleting the whole object — which is what this did until directed task 13 — reopened every
    // saved scene with the annotation back in `fill` at the default width and every hidden region
    // visible again. `Engine.addLayer` merges these three over the table it re-derived.
    const label = (layer as { label?: { visibleLabels?: number[] } }).label;
    if (label === undefined) delete out.label;
    else {
      out.label = {
        ...label,
        ...(label.visibleLabels !== undefined
          ? { visibleLabels: Uint32Array.from(label.visibleLabels) }
          : {}),
      };
    }
    const isolate = (layer as unknown as MeshLayer).isolate;
    const labelVolume = isolate?.labelVolume;
    if (isolate !== undefined && labelVolume !== undefined) {
      const remapped = idMap.get(labelVolume.datasetId);
      out.isolate =
        remapped !== undefined
          ? { ...isolate, labelVolume: { ...labelVolume, datasetId: remapped } }
          : { ...isolate, labelVolume: undefined };
    }
  }
  if (layer.kind === 'iso') {
    const source = (layer as unknown as { source: { datasetId: DatasetId } }).source;
    const remapped = idMap.get(source.datasetId);
    if (remapped === undefined) return null;
    out.source = { ...source, datasetId: remapped };
  }
  return out as Partial<Layer> & { datasetId: DatasetId; kind: Layer['kind'] };
}

/**
 * The spec's views with every `LayerId` in `layerVisibility` remapped to the ids the load created.
 *
 * A view naming a layer id nothing answers to hides nothing and shows nothing — it falls back to
 * "visible", which is the quiet kind of wrong: a scene saved with one overlay hidden reopens with it
 * shown.
 */
export function remapViews(
  spec: ViewSpec,
  layerMap: ReadonlyMap<LayerId, LayerId>
): { slices: SliceView[]; view3d: View3D } {
  const remap = (
    table: Record<LayerId, boolean> | undefined
  ): Record<LayerId, boolean> | undefined => {
    if (table === undefined) return undefined;
    const out: Record<LayerId, boolean> = {};
    for (const [id, visible] of Object.entries(table)) {
      const next = layerMap.get(id);
      if (next !== undefined) out[next] = visible;
    }
    return out;
  };
  const slices = spec.slices.map((s) => {
    const next: SliceView = { ...s };
    const layerVisibility = remap(s.layerVisibility);
    if (layerVisibility === undefined) delete next.layerVisibility;
    else next.layerVisibility = layerVisibility;
    return next;
  });
  const view3d: View3D = { ...spec.view3d };
  const visibility3d = remap(spec.view3d.layerVisibility);
  if (visibility3d === undefined) delete view3d.layerVisibility;
  else view3d.layerVisibility = visibility3d;
  return { slices, view3d };
}

/**
 * Narrow a serialised layer to the kinds `scene/defaults.ts` can seed (§4.4).
 *
 * **All four, since directed task 13 (2026-08-28).** It used to be `volume | mesh`, on the grounds
 * that "`addLayer` derives a layer's kind from its dataset" — which stopped being true when
 * `defaultLayerFor` gained its third parameter: `addLayer` passes `spec.kind` straight through, and
 * `'iso'` and `'points'` are two of its four cases. Excluding them silently dropped every
 * isosurface and every electrode-position layer from a reopened scene, which is the exact failure
 * §4.6 exists to prevent.
 */
export function isRestorableKind(kind: Layer['kind']): boolean {
  return kind === 'volume' || kind === 'mesh' || kind === 'iso' || kind === 'points';
}

// ---------------------------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------------------------

/**
 * The `ViewSpec.version` this engine writes (§4.6). Bumped 1 → 2 by directed task 13, 2026-08-28.
 */
export const SCENE_VERSION = 2;

/**
 * Bring a spec read from disk up to {@link SCENE_VERSION}.
 *
 * v1 → v2 is a version stamp: every field v2 added is optional, and a v1 file simply has none of
 * them. The migration exists anyway rather than being skipped, for two reasons. It is the **one**
 * place a version is decided, so `load` and every host read the same answer; and it is where the
 * next migration goes, at which point "v1 files still open" is a test that already exists rather
 * than a promise. A spec from a *newer* version is returned untouched — refusing it is the reader's
 * call (`lib/scene.ts`'s `parseScene` does refuse), not this function's.
 *
 * Layouts are **not** migrated here: `'1x3'` and the rest are still valid `LayoutKind`s, and which
 * of them the UI is willing to show is the app's policy (directed task 3, `lib/layout.ts`'s
 * `migrateSpecLayout`), not the scene model's.
 */
export function migrateViewSpec(spec: ViewSpec): ViewSpec {
  if (spec.version >= SCENE_VERSION) return spec;
  return { ...spec, version: SCENE_VERSION };
}

/** `Engine.serialize()` (§4.7): the scene as a `ViewSpec`. */
export function toViewSpec(scene: Scene, opts: SerializeOptions = {}): ViewSpec {
  return {
    version: SCENE_VERSION,
    datasets: datasetRefs(scene, opts),
    layers: scene.layers.map(serializableLayer),
    activeLayerId: scene.activeLayerId,
    slices: scene.slices,
    view3d: scene.view3d,
    layout: scene.layout,
    cursor: scene.cursor,
    radiological: scene.radiological,
    background: scene.background,
    lighting: scene.lighting,
    annotations: scene.annotations,
    transparency: scene.transparency,
  };
}

/**
 * Apply the view half of a `ViewSpec` to a store, remapping any `LayerId` it names.
 *
 * Annotations are assigned **as the spec holds them**, not merged through
 * `SceneStore.setAnnotations` — a saved scene is a complete description, and merging would let the
 * live scene's flags leak into a loaded one. `conventionBadge` is still `true` in any spec this
 * engine wrote, because `setAnnotations` forces it (§8).
 *
 * `layers` and `activeLayerId` are **not** here: restoring a layer means creating its runtime, which
 * is `Engine.addLayer`'s job and not a store mutation. `engine.ts`'s `load` does that first, then
 * calls this with the map from the spec's layer ids to the ones it created.
 */
export function applyViewSpec(
  store: SceneStore,
  spec: ViewSpec,
  layerMap: ReadonlyMap<LayerId, LayerId> = new Map()
): void {
  const { slices, view3d } = remapViews(spec, layerMap);
  store.setSlices(slices);
  store.setView3D(view3d);
  store.setLayout(spec.layout);
  store.setCursor(spec.cursor);
  store.setRadiological(spec.radiological);
  store.setBackground(spec.background);
  store.setLighting(spec.lighting);
  store.replaceAnnotations(spec.annotations);
  store.setTransparency(spec.transparency);
}
