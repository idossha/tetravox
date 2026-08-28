/**
 * The pure half of §8's scene save/load: paths, candidates and the layer reconcile.
 *
 * §4.6 is the contract: `DatasetRef.path` is **relative to the scene file**, `absPath` is the
 * fallback, and `fingerprint` is what the relocate dialog shows the user. None of that needs a
 * filesystem to compute — the app only needs to know *which candidates to try, in which order* —
 * so it all lives here, without React, without an `Engine`, and is unit-tested against strings.
 *
 * The one piece of judgement in this file is `relocationCandidates`. When a scene moves with its
 * data (the common case: a results directory copied to another machine), the relative path still
 * resolves and the absolute one does not; when the scene alone moves, the reverse. Trying the
 * relative form **first** is what makes "copy the whole folder" the case that never needs a dialog.
 */

import { SCENE_VERSION, migrateViewSpec } from '@tetravox/engine';
import type { DatasetRef, Layer, ViewSpec } from '@tetravox/engine';

/** §4.6's extension. One regexp, shared by the drop route, the Open route and the Save default. */
export const SCENE_SUFFIX = '.tetravox.json';

/**
 * True for a `*.tetravox.json`. **Not** for any `.json`: §7.6's user colormaps are `.json` too, and
 * opening one as a scene would report "no datasets array" instead of loading a colormap.
 *
 * Mirrors `main/menu.ts`'s `isScenePath` — duplicated rather than imported, because the renderer
 * must not import from main, and a two-line predicate is a smaller liability than a shared module
 * across the §5 boundary. `scene.test.ts` and `menu.test.ts` assert the same cases of both.
 */
export function isScenePath(path: string): boolean {
  return /\.tetravox\.json$/i.test(path);
}

// ------------------------------------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------------------------------------

/** POSIX and Windows separators both, because a scene written on either must open on the other. */
const SEPARATOR = /[/\\]/;

function isWindowsAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(path) || path.startsWith('\\\\');
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || isWindowsAbsolute(path);
}

/** The directory part of a path, without its trailing separator. `''` when there is none. */
export function dirName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at <= 0 ? path.slice(0, Math.max(at, 0)) : path.slice(0, at);
}

/**
 * Collapse `.` and `..` in a path that has already been joined. Leading `..` segments are **kept**:
 * dropping them would silently turn `../T1.nii.gz` into `T1.nii.gz` and open the wrong file.
 */
export function normalisePath(path: string): string {
  const windows = isWindowsAbsolute(path);
  const absolute = isAbsolutePath(path);
  const parts = path.split(SEPARATOR);
  const out: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === '.' || (part === '' && index > 0)) continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      const last = out[out.length - 1] as string;
      // Never pop the root ('' for POSIX, 'C:' for Windows): `/..` is `/`.
      if (!(out.length === 1 && absolute && (last === '' || /^[a-zA-Z]:$/.test(last)))) {
        out.pop();
        continue;
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join(windows ? '\\' : '/');
  return joined === '' && absolute ? '/' : joined;
}

/** Join a directory and a possibly-relative path, normalised. An absolute `path` wins outright. */
export function joinPath(dir: string, path: string): string {
  if (path === '') return normalisePath(dir);
  if (isAbsolutePath(path)) return normalisePath(path);
  if (dir === '') return normalisePath(path);
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return normalisePath(`${dir}${separator}${path}`);
}

/**
 * Express `target` relative to `fromDir`, per §4.6 ("paths are stored relative to the scene file").
 *
 * Falls back to the absolute path when the two have no common root — a scene on `D:` referring to a
 * dataset on `C:`, or a POSIX path against a Windows directory. A `../../../..` chain across drive
 * letters is not a relative path, it is a wrong one.
 */
export function relativePath(fromDir: string, target: string): string {
  if (!isAbsolutePath(fromDir) || !isAbsolutePath(target)) return target;
  const windows = isWindowsAbsolute(target);
  if (windows !== isWindowsAbsolute(fromDir)) return target;
  const from = normalisePath(fromDir).split(SEPARATOR);
  const to = normalisePath(target).split(SEPARATOR);
  if (windows && (from[0] ?? '').toLowerCase() !== (to[0] ?? '').toLowerCase()) return target;
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  if (shared === 0) return target;
  const up = new Array<string>(from.length - shared).fill('..');
  const down = to.slice(shared);
  const joined = [...up, ...down].join(windows ? '\\' : '/');
  return joined === '' ? '.' : joined;
}

/**
 * The candidates to try for one `DatasetRef`, most likely first (§4.6).
 *
 * 1. `path` resolved against the scene's directory — the scene and its data moved together.
 * 2. `absPath` — the scene alone moved, the data is where it always was.
 * 3. the ref's basename beside the scene — the flattened "everything in one folder" case.
 *
 * Duplicates are dropped so a caller does not stat the same path twice, and the order is stable so
 * the relocate dialog can report *which* candidate it tried.
 */
export function relocationCandidates(ref: DatasetRef, sceneDir: string): string[] {
  const out: string[] = [];
  const push = (candidate: string): void => {
    if (candidate !== '' && !out.includes(candidate)) out.push(candidate);
  };
  if (ref.path !== '') push(joinPath(sceneDir, ref.path));
  if (ref.absPath !== undefined && ref.absPath !== '') push(normalisePath(ref.absPath));
  const base = ref.path.split(SEPARATOR).pop() ?? '';
  if (base !== '') push(joinPath(sceneDir, base));
  return out;
}

// ------------------------------------------------------------------------------------------------
// The spec on disk
// ------------------------------------------------------------------------------------------------

/**
 * Rewrite the spec's `DatasetRef` paths to be relative to `sceneDir`, keeping the absolute fallback.
 *
 * `Engine.serialize()` emits absolute paths today (audit §4.7: "`DatasetRef.fingerprint` is `''` and
 * `path` is absolute"). §4.6 asks for the relative form **with an absolute fallback**, and both are
 * string work over a spec the engine already produced — so doing it here neither duplicates engine
 * state nor waits on E-SCENE's P2-07. When P2-07 lands and `serialize()` emits relative paths
 * already, `relativePath` is the identity on them and this stays correct.
 */
export function withRelativePaths(spec: ViewSpec, scenePath: string): ViewSpec {
  const dir = dirName(scenePath);
  return {
    ...spec,
    datasets: spec.datasets.map((ref) => {
      if (!isAbsolutePath(ref.path)) return ref;
      return { ...ref, path: relativePath(dir, ref.path), absPath: ref.path };
    }),
  };
}

/** `2 kB of JSON, indented`: a scene file a human can read and a diff can show. */
export interface SceneExtras {
  /** §8's theme choice, written into the file so a scene reopens looking as it was left. */
  theme?: 'system' | 'light' | 'dark';
  /**
   * Measurements (directed task 11) carried through from the spec that was loaded.
   *
   * `Engine.serialize()` cannot produce them — `Scene` has no measurement list on this branch — so
   * a save that ignored them would delete a colleague's measurements the first time their scene was
   * opened here and saved again. Carrying them is the difference between "not implemented" and
   * "silently destructive".
   */
  measurements?: unknown[];
}

export function serialiseScene(
  spec: ViewSpec,
  scenePath: string,
  extras: SceneExtras = {}
): string {
  const out: ViewSpec = {
    ...withRelativePaths(spec, scenePath),
    ...(extras.theme !== undefined ? { theme: extras.theme } : {}),
    ...(extras.measurements !== undefined && extras.measurements.length > 0
      ? { measurements: extras.measurements }
      : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export interface ParsedScene {
  ok: boolean;
  spec?: ViewSpec;
  error?: string;
}

/**
 * Parse and shape-check a scene file.
 *
 * Only the fields the app itself depends on are checked — `version`, `datasets`, `layers` — because
 * everything past them is the engine's to validate, and a shell that re-validated the whole `ViewSpec`
 * would be a second copy of §4.6 to keep in step. A wrong `version` is refused rather than guessed:
 * §4.6 is `version: 1`, and a future file opened as one would restore the wrong scene silently.
 */
export function parseScene(text: string): ParsedScene {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : 'not JSON' };
  }
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'not an object' };
  const spec = value as Partial<ViewSpec>;
  if (spec.version !== 1 && spec.version !== SCENE_VERSION) {
    return { ok: false, error: `unsupported scene version ${String(spec.version)}` };
  }
  if (!Array.isArray(spec.datasets)) return { ok: false, error: 'no datasets array' };
  if (!Array.isArray(spec.layers)) return { ok: false, error: 'no layers array' };
  // v1 → v2 (directed task 13). The engine owns the migration so that a host which reads a file
  // itself and one which hands the bytes to `Engine.load` agree on what version 1 means.
  return { ok: true, spec: migrateViewSpec(spec as ViewSpec) };
}

/**
 * The default filename the Save dialog offers: the first dataset's stem, else `scene`.
 *
 * The **basename** first, because `DatasetRef.name` is not guaranteed to be one: the engine takes it
 * from `VolumeMeta.name`, which the loader derives from the source URL, and on the real dataset that
 * is the whole absolute path `[DATA]`. Offering `_Users_idohaber_…_T1.tetravox.json` as a filename
 * would be a defensible bug and a terrible default.
 */
/**
 * The **path** the Save dialog opens on: `<first dataset's directory>/<name>.tetravox.json` (§8,
 * directed task 13).
 *
 * The maintainer's ask is "default name next to the data" — a name alone leaves the sheet in
 * whatever directory the OS last used, which for a first save is usually Documents and never the
 * results directory the user is working in. The directory comes from the first `DatasetRef`'s
 * `absPath` (the relative `path` is measured from a scene file that does not exist yet), and falls
 * back to the bare name when there is no absolute path to anchor to — a scene of datasets opened
 * from dropped `File`s with no path, which is the one case where there is nowhere to point at.
 */
export function defaultScenePath(spec: ViewSpec): string {
  const name = defaultSceneName(spec);
  const anchor = spec.datasets[0]?.absPath ?? '';
  if (anchor === '' || !isAbsolutePath(anchor)) return name;
  const dir = dirName(anchor);
  return dir === '' ? name : joinPath(dir, name);
}

export function defaultSceneName(spec: ViewSpec): string {
  const first = (spec.datasets[0]?.name ?? '').split(SEPARATOR).pop() ?? '';
  const stem = first
    .replace(/\.(nii\.gz|nii|mgz|mgh|msh|gii|stl|ply|obj)$/i, '')
    .replace(/[^\w.-]+/g, '_');
  return `${stem === '' ? 'scene' : stem}.tetravox.json`;
}

// ------------------------------------------------------------------------------------------------
// Reconciling layers after `Engine.load`
// ------------------------------------------------------------------------------------------------

export interface ReconcileInput {
  /** `spec.layers`, in the order they were saved (bottom → top, §4.4). */
  specLayers: readonly ViewSpec['layers'][number][];
  /** The scene's layers **after** `Engine.load` returned. */
  liveLayers: readonly Layer[];
  /** Spec dataset id → the id the engine gave the re-loaded dataset. */
  datasetIdMap: ReadonlyMap<string, string>;
}

export interface LayerToAdd {
  datasetId: string;
  kind: Layer['kind'];
  /** Everything the spec carried for that layer, minus the ids that are no longer valid. */
  patch: Record<string, unknown>;
}

/**
 * The layers `Engine.load` did not restore, as `addLayer` specs.
 *
 * **This exists because of audit P2-07 and is designed to become a no-op.** `Engine.load` "never
 * restores `spec.layers` or `spec.activeLayerId`" on `main`; E-SCENE owns fixing that. Until then a
 * saved scene would reopen with datasets and no layers, which is not a restored scene. So the shell
 * reconciles: for every spec layer whose dataset came back and which has **no** live counterpart, it
 * asks the engine to add one. The moment `load` restores layers itself, `liveLayers` covers the spec
 * and this returns `[]` — the same code path, one branch colder.
 *
 * Counterparts are matched by `(datasetId, kind, name)` rather than by `LayerId`: §4.6's own
 * dataset-id remap means the saved ids cannot be assumed to survive, and two layers over the same
 * dataset with the same kind are told apart by their name, which `serialize` preserves.
 */
export function layersToRestore(input: ReconcileInput): LayerToAdd[] {
  const { specLayers, liveLayers, datasetIdMap } = input;
  const unmatched = [...liveLayers];
  const out: LayerToAdd[] = [];
  for (const specLayer of specLayers) {
    const datasetId = datasetIdMap.get(specLayer.datasetId);
    if (datasetId === undefined) continue; // the user skipped this dataset in the relocate dialog
    const at = unmatched.findIndex(
      (live) =>
        live.datasetId === datasetId && live.kind === specLayer.kind && live.name === specLayer.name
    );
    if (at !== -1) {
      unmatched.splice(at, 1);
      continue;
    }
    const {
      id: _id,
      datasetId: _datasetId,
      ...rest
    } = specLayer as Record<string, unknown> & { id: unknown; datasetId: unknown };
    out.push({ datasetId, kind: specLayer.kind, patch: runtimeLayerFields(rest) });
  }
  return out;
}

/**
 * §4.6's `SerializableLayer` differs from `Layer` in exactly one way: `visibleLabels` is a
 * `number[]` on disk and a `Uint32Array` at runtime (and again inside `label`). Handing the array
 * form straight to `addLayer` would put a plain array where the engine indexes a typed one — which
 * fails as a wrong *rendering*, not as a type error, because `NewLayer` is `Partial<Layer>` behind a
 * cast. Converting it here is the whole of the round trip's asymmetry.
 */
function runtimeLayerFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  if (Array.isArray(out['visibleLabels'])) {
    out['visibleLabels'] = Uint32Array.from(out['visibleLabels'] as number[]);
  }
  const label = out['label'];
  if (typeof label === 'object' && label !== null) {
    const inner = { ...(label as Record<string, unknown>) };
    if (Array.isArray(inner['visibleLabels'])) {
      inner['visibleLabels'] = Uint32Array.from(inner['visibleLabels'] as number[]);
    }
    out['label'] = inner;
  }
  return out;
}
