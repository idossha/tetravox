/**
 * The Zustand store — **UI state only** (§8: "Everything the UI can do must be reachable from the
 * `Engine` API alone. No logic in React.").
 *
 * Two kinds of state live here and nothing else:
 *
 *  1. **Projections** of engine events (`layers`, `datasets`, `cursor`, `hover`, `caps`, …). The
 *     engine owns them; the store caches the last value each event carried so React can render it.
 *     Nothing here writes back into a projection except the subscription in `controller.ts`.
 *  2. **Chrome** the engine has no opinion about: which pane is focused, which space the coordinate
 *     bar is in, the draft text in it, load cards, toasts, the status-bar metrics buffer.
 *
 * There are no engine calls in this file. Every action is in `controller.ts`, and every one of those
 * ends in a §4.7 member.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type {
  Capabilities,
  CoordSpaceRef,
  Dataset,
  DatasetId,
  DatasetRef,
  Layer,
  LayerId,
  LayoutKind,
  Measurement,
  ProbeResult,
  QualityLevel,
  ScreenshotOptions,
  ViewId,
  ViewSpec,
  vec3,
} from '@tetravox/engine';
import type { ScreenshotDefaults } from '../../preload/index';
import type { LoadCard } from '../lib/loads';
import type { Toast } from '../lib/toasts';
import type { MetricsState } from '../lib/metrics';
import type { RegionStat, SelectionState } from '../panels/regions/regions';
import { EMPTY_METRICS } from '../lib/metrics';
import type { EngineImpl } from '../engine/factory';
import type { ThemeChoice } from '../theme/theme';
import type { ThemeName } from '../theme/tokens';

/**
 * §8's coordinate bar space, as a `CoordSpaceRef` (directed task 8, 2026-08-28).
 *
 * Phase 2 had three string cases — `'ras' | 'voxel' | 'mni'` — which could not express the four
 * spaces task 8 adds, because three of them are *per volume*: `Voxel · T1` and `Voxel ·
 * final_tissues` are different spaces, and so are their tkr-RAS. The selector is now built from
 * `Engine.coordinateSpaces()` and the chosen entry is stored by reference, so a menu entry keeps
 * meaning the same thing when the active layer changes under it.
 *
 * `WORLD_SPACE` is the default and the fallback: a ref whose dataset has been closed resolves to
 * null in `Engine.toSpace`, and the bar falls back to world RAS rather than showing a stale triple.
 */
export type CoordSpace = CoordSpaceRef;

/** The one space that always exists, whatever is loaded. */
export const WORLD_SPACE: CoordSpaceRef = { space: 'world' };

/** Two refs name the same space — used to keep the `<select>`'s value stable across re-renders. */
export function sameSpace(a: CoordSpaceRef, b: CoordSpaceRef): boolean {
  if (a.space !== b.space) return false;
  return a.space === 'world' || b.space === 'world' || a.datasetId === b.datasetId;
}

/** A stable string key for a ref, for `<option value>` and `data-testid`. */
export function spaceKey(ref: CoordSpaceRef): string {
  return ref.space === 'world' ? 'world' : `${ref.space}:${ref.datasetId}`;
}

/** The inverse of {@link spaceKey}, for reading a `<select>` back. Null for an unknown key. */
export function spaceFromKey(key: string): CoordSpaceRef | null {
  if (key === 'world') return WORLD_SPACE;
  const at = key.indexOf(':');
  if (at < 0) return null;
  const space = key.slice(0, at);
  const datasetId = key.slice(at + 1);
  if (space !== 'voxel' && space !== 'tkr' && space !== 'mni-affine' && space !== 'mni-nonlinear') {
    return null;
  }
  return { space, datasetId };
}

export type EngineStatus = 'pending' | 'ready' | 'webgl2-null' | 'failed';

export interface ScreenshotRecord {
  bytes: number;
  type: string;
  /** The blob really started with the 8-byte PNG signature. */
  isPng: boolean;
  at: number;
  // -- Phase 2, appended: what the PNG's own chunks said (§11: parse it, do not eyeball it) -------
  /** `IHDR` width/height, so the status bar reports the file's size, not the pane's. */
  width?: number;
  height?: number;
  /** From the `pHYs` chunk. Absent when the file carries none. */
  dpi?: number;
  /** What `ScreenshotOptions.dpi` asked for, so a mismatch is a visible pair, not a silent drop. */
  requestedDpi?: number;
}

export interface UiState {
  // -- engine projections ------------------------------------------------------------------------
  status: EngineStatus;
  statusMessage: string | null;
  impl: EngineImpl;
  caps: Capabilities | null;
  datasets: Dataset[];
  /** bottom → top, exactly as `Scene.layers` (§4.4). */
  layers: Layer[];
  activeLayerId: LayerId | null;
  layoutKind: LayoutKind;
  cells: ViewId[];
  radiological: boolean;
  crosshair: boolean;
  /** §8's colour bars, mirrored from `Scene.annotations.colorbars` (appended; never renamed). */
  colorbars: boolean;
  /**
   * §7.5's measure mode, mirrored from the engine (directed task 11, 2026-08-28).
   *
   * A projection, not the truth: the engine owns the mode because it owns the click→world
   * conversion, and this is the last value the toolbar's `aria-pressed` saw.
   */
  measureMode: boolean;
  /** `Scene.measurements` (§4.5), from the `measurements` event — what §8's panel lists. */
  measurements: Measurement[];
  /**
   * The 2D panes' scale bar and the 3D pane's orientation cube, mirrored from `Scene.annotations`
   * (directed task 10, 2026-08-28; appended, never renamed).
   *
   * Both default **on in the app** while `scene/defaults.ts` keeps them off, exactly as `colorbars`
   * does and for the same reason: the engine default is what §11's goldens are captured with and may
   * not move, but a product that ships a millimetre scale nobody can see has not shipped it. The
   * toolbar's `Scale` and `Cube` buttons are the way back off.
   */
  scaleBar: boolean;
  orientationCube: boolean;
  /**
   * This window was launched for a `--job` (`automation/run.ts`), so the §8 panels are not drawn.
   *
   * The panels are 18 rem + 20 rem of chrome that no screenshot contains — a job's pictures come off
   * the engine's canvas, not off the DOM — and on a 700 px window they left the view grid about
   * 100 px wide, so a "300 px" sweep frame was a 300x1500 sliver with a thumbnail of a brain in it.
   * Giving the whole window to the view grid is what makes a job's requested size the size of the
   * picture. Appended, never renamed.
   */
  jobMode: boolean;
  cursor: vec3;
  cursorProbe: ProbeResult | null;
  hover: vec3 | null;
  hoverProbe: ProbeResult | null;
  quality: QualityLevel['name'];

  // -- chrome ------------------------------------------------------------------------------------
  activeViewId: ViewId | null;
  coordSpace: CoordSpace;
  /**
   * §8's settings dialog: the FreeSurfer subjects directory, mirrored from `settings.json` so the
   * dialog can render it without a round trip (directed task 8). `''` = unset.
   */
  freesurferSubjectsDir: string;
  /** `null` = the field follows the cursor; a string = the user is editing. */
  coordDraft: string | null;
  loads: LoadCard[];
  toasts: Toast[];
  metrics: MetricsState;
  /** Bumped by a 1 Hz timer so "frames in the last second" decays to 0 when idle (§8). */
  tick: number;
  heapBytes: Record<DatasetId, number>;
  lastLoadMs: Record<DatasetId, number>;
  lastScreenshot: ScreenshotRecord | null;
  /**
   * Region-panel selection per layer (R5: click / ⇧ / ⌘ / Alt-solo).
   *
   * Chrome, not scene: what is *highlighted* is a panel affordance, while what is **visible**
   * lives in `VolumeLayer.visibleLabels` / `MeshLayer.tagStyle` and only the engine holds it.
   */
  regionSelection: Record<LayerId, SelectionState>;
  /**
   * `labelCentroids` (§6.5.2) results per layer — the only legitimate source of a region's voxel
   * count and centroid. §4.3 keeps `VolumeDataset.data` on this thread "for probes only", and a
   * count over 256×256×208 is not a probe.
   */
  regionStats: Record<LayerId, RegionStat[]>;

  // -- §8's property editors — appended, per the shared-file rule.
  //    Both are chrome: the engine has no opinion about either.
  /**
   * Per layer, the §7.4 switches whose geometry is being built in a worker right now — `'edges'`,
   * `'elmField'`, `'label'`. §7.4: "the first toggle of `edges.surface`, the first switch to an
   * element field, and the first `colorMode:'label'` on a given mask are **async loads with a
   * progress state**, not instant checkboxes."
   */
  meshPending: Record<LayerId, string[]>;
  /**
   * Per volume layer, its **3D surface** progress (§4.4's `iso3d`, directed task 2, 2026-08-28):
   * `{pending, total}` straight from `Engine.iso3dStatus`, refreshed by the same `layers`
   * subscription everything else here is refreshed by. Chrome, like `meshPending`: the engine owns
   * the fact, this is the last value React saw.
   */
  iso3dPending: Record<LayerId, { pending: number; total: number }>;

  // -- Phase 2, A-SHELL (appended; §8's scene save/load, dialogs and header panel) ----------------
  /** The scene file this session is attached to, so `Save` can write without asking again (§4.6). */
  sceneFile: SceneFileRecord | null;
  /** The last scene save/load failure, shown next to the toolbar's scene controls. */
  sceneError: string | null;
  /**
   * Unsaved changes since the last save or load (directed task 13) — the title bar's `•`.
   *
   * Derived from the engine's own events rather than from a diff of `serialize()`: the controller
   * subscribes to `layers`, `datasets` and `cursor` anyway, and a spec-to-spec comparison on every
   * pointer move would serialise the scene sixty times a second to answer a question a boolean
   * already answers. It is deliberately **conservative** — a gesture that ends where it started
   * still marks the scene dirty, because "possibly changed" and "changed" have the same right
   * answer for a save prompt, and the opposite mistake loses work.
   */
  sceneDirty: boolean;
  /** The scenes File ▸ Open Recent offers, mirrored from `settings.json` (most recent first). */
  recentScenes: string[];
  /** "Reopen last scene on launch", mirrored from `settings.json` so the dialog can render it. */
  reopenLastScene: boolean;
  /** Which modal is up. One at a time: they are all full-window, so a stack would only hide one. */
  dialog: DialogKind;
  /**
   * Which tab the unified settings dialog opens on (directed task: unified settings, 2026-08-28).
   * Chrome, like `dialog` itself — it is not persisted, and every re-open of the settings dialog
   * simply resumes whatever tab it was last set to.
   */
  settingsTab: SettingsTab;
  /** The `tetravoxrc` path, mirrored from main so the settings dialog's footer needs no round trip. */
  configPath: string;
  /** Persisted §4.7 screenshot defaults, mirrored from `settings.json` (directed task: unified settings). */
  screenshotDefaults: ScreenshotDefaults;
  /** The relocate dialog's rows, populated by `loadScene` before it raises the dialog. */
  relocate: RelocateRequest | null;
  /** The options the screenshot dialog opens with; edits are kept so a reopen resumes them. */
  screenshotOptions: ScreenshotOptions;
  /** The dataset whose raw header the info panel's header block is showing; null = the active one. */
  headerDatasetId: DatasetId | null;

  // -- Appended; the per-row disclosure state for the layer panel --------------------------------
  /**
   * Which layer rows are **collapsed** in the panel, keyed by `LayerId`.
   *
   * Chrome, and deliberately nothing else: a disclosure is a property of this window, not of the
   * scene, so it is never serialised into a `ViewSpec` and a saved scene reopens with every row
   * expanded. A layer absent from the map is expanded, which is what makes a **newly added layer
   * start expanded** for free while every other row keeps whatever the user set.
   */
  collapsedLayers: Record<LayerId, boolean>;

  // -- Themes (directed task 9, 2026-08-28) ------------------------------------------------------
  /**
   * What the user picked in the toolbar — `'system'`, `'light'` or `'dark'`. Persisted in
   * `settings.json` by main; this is the last value the renderer read or wrote.
   */
  themeChoice: ThemeChoice;
  /**
   * What that choice resolves to *now*: `'system'` follows `prefers-color-scheme`, so this changes
   * under the app when the OS does. It is what `data-theme` is stamped with and what the engine's
   * chrome palette is derived from — the two must never disagree, which is why one field drives
   * both.
   */
  theme: ThemeName;
}

/** Where this scene lives on disk, and when it was last written there. */
export interface SceneFileRecord {
  path: string;
  name: string;
  savedAt: number | null;
}

export type DialogKind = 'none' | 'screenshot' | 'relocate' | 'keyboard' | 'settings';

/** The unified settings dialog's tabs (directed task: unified settings, 2026-08-28). */
export type SettingsTab = 'appearance' | 'capture' | 'paths' | 'startup';

/** `main/settings.ts`'s `DEFAULT_SCREENSHOT_DEFAULTS`, duplicated for the same reason as `bridge.ts`. */
export const DEFAULT_SCREENSHOT_DEFAULTS: ScreenshotDefaults = {
  background: 'scene',
  dpi: 144,
  autoTrim: false,
};

/** One row of the relocate dialog: the ref, what was tried for it, and what the user picked. */
export interface RelocateRow {
  ref: DatasetRef;
  tried: string[];
  picked: string | null;
}

export interface RelocateRequest {
  spec: ViewSpec;
  scenePath: string;
  /** Refs that resolved on their own, mapped to the path that worked. Not shown; carried through. */
  resolved: Record<string, string>;
  missing: RelocateRow[];
}

/** §8's screenshot defaults — what the toolbar used before the dialog existed, unchanged. */
export const DEFAULT_SCREENSHOT_OPTIONS: ScreenshotOptions = {
  target: 'grid',
  background: 'scene',
  include: {
    colorbar: true,
    orientationLabels: true,
    crosshair: true,
    cornerInfo: true,
    // Directed task 10: appended off, like `scaleBar` already was — this constant is "what the
    // toolbar used before the dialog existed, unchanged", and the dialog's two new checkboxes are
    // how a picture asks for the scale bar or the cube.
    scaleBar: false,
    orientationCube: false,
  },
  autoTrim: false,
  dpi: 144,
};

export const INITIAL_UI: UiState = {
  status: 'pending',
  statusMessage: null,
  impl: 'mock',
  caps: null,
  datasets: [],
  layers: [],
  activeLayerId: null,
  layoutKind: '2x2',
  cells: [],
  radiological: false,
  crosshair: true,
  colorbars: true,
  measureMode: false,
  measurements: [],
  scaleBar: true,
  orientationCube: true,
  jobMode: false,
  cursor: [0, 0, 0],
  cursorProbe: null,
  hover: null,
  hoverProbe: null,
  quality: 'full',
  activeViewId: null,
  coordSpace: WORLD_SPACE,
  freesurferSubjectsDir: '',
  coordDraft: null,
  loads: [],
  toasts: [],
  metrics: EMPTY_METRICS,
  tick: 0,
  heapBytes: {},
  lastLoadMs: {},
  lastScreenshot: null,
  regionSelection: {},
  regionStats: {},
  meshPending: {},
  iso3dPending: {},
  sceneFile: null,
  sceneError: null,
  sceneDirty: false,
  recentScenes: [],
  reopenLastScene: false,
  dialog: 'none',
  settingsTab: 'appearance',
  configPath: '',
  screenshotDefaults: DEFAULT_SCREENSHOT_DEFAULTS,
  relocate: null,
  screenshotOptions: DEFAULT_SCREENSHOT_OPTIONS,
  headerDatasetId: null,
  collapsedLayers: {},
  themeChoice: 'system',
  // Dark until the resolver has run, matching `BrowserWindow.backgroundColor`'s own fallback: a
  // window that guessed light and was wrong would show a white flash, and the reverse would not.
  theme: 'dark',
};

export type UiStore = StoreApi<UiState>;

export function createUiStore(initial: Partial<UiState> = {}): UiStore {
  return createStore<UiState>(() => ({ ...INITIAL_UI, ...initial }));
}

/** The single store the renderer mounts against. Tests build their own with `createUiStore`. */
export const uiStore: UiStore = createUiStore();

// ------------------------------------------------------------------------------------------------
// Selectors — pure, so a component never derives anything itself.
// ------------------------------------------------------------------------------------------------

export function activeLayer(state: UiState): Layer | null {
  return state.layers.find((l) => l.id === state.activeLayerId) ?? null;
}

export function datasetOf(state: UiState, layer: Layer | null): Dataset | null {
  if (layer === null) return null;
  return state.datasets.find((d) => d.id === layer.datasetId) ?? null;
}

/** Layers are stored bottom → top and shown **top first**, like every layer list a user has met. */
export function layersTopFirst(state: UiState): Layer[] {
  return [...state.layers].reverse();
}

export function activeVolumeDataset(state: UiState): Dataset | null {
  const dataset = datasetOf(state, activeLayer(state));
  return dataset?.kind === 'volume' ? dataset : null;
}

// -- Phase 2, A-SHELL (appended) -----------------------------------------------------------------

/** A volume dataset that is known to carry §4.3's `toTemplate`, so callers need no second guard. */
export type TemplateVolume = Extract<Dataset, { kind: 'volume' }> & {
  toTemplate: NonNullable<Extract<Dataset, { kind: 'volume' }>['toTemplate']>;
};

/**
 * The volume whose `toTemplate` the coordinate bar's MNI column uses, or null when none has one.
 *
 * The active layer's dataset first, so a scene with a subject volume *and* an MNI-space overlay
 * reports the space of the thing the user is looking at; otherwise the topmost volume that carries
 * one, because "some dataset in this scene is in MNI" is still worth offering. `sform_code`/
 * `qform_code` = 4 is what makes a volume MNI152, and deriving that is E-SCENE's `scene/fromMeta.ts`
 * (audit P2-10) — the app only reads the field.
 *
 * **It returns the dataset itself, never a wrapper object.** A selector is read through
 * `useSyncExternalStore`, which compares with `Object.is`; a `{ dataset, toTemplate }` literal is a
 * new object on every call, so every store read looks like a change and React re-renders until it
 * throws "Maximum update depth exceeded". Returning the identity that is already in the store is
 * what makes the selector stable, and it is why the return type narrows instead of wrapping.
 */
export function templateSource(state: UiState): TemplateVolume | null {
  const active = datasetOf(state, activeLayer(state));
  if (active?.kind === 'volume' && active.toTemplate !== undefined) return active as TemplateVolume;
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const layer = state.layers[i] as Layer;
    const dataset = state.datasets.find((d) => d.id === layer.datasetId);
    if (dataset?.kind === 'volume' && dataset.toTemplate !== undefined) {
      return dataset as TemplateVolume;
    }
  }
  return null;
}

/** The dataset whose raw header the info panel shows: the pinned one, else the active layer's. */
export function headerDataset(state: UiState): Dataset | null {
  if (state.headerDatasetId !== null) {
    return state.datasets.find((d) => d.id === state.headerDatasetId) ?? null;
  }
  return datasetOf(state, activeLayer(state));
}

/** The active layer's mesh dataset, when it has one — what the `.msh.opt` chip hangs off (§7.6). */
export function activeMeshDataset(state: UiState): Extract<Dataset, { kind: 'mesh' }> | null {
  const dataset = datasetOf(state, activeLayer(state));
  return dataset?.kind === 'mesh' ? dataset : null;
}

// -- A-COLLAPSE (appended) -----------------------------------------------------------------------

/** Is this row collapsed? Absent from the map means expanded (§ new layers start expanded). */
export function isLayerCollapsed(state: UiState, id: LayerId): boolean {
  return state.collapsedLayers[id] === true;
}

/**
 * What the panel-header control should do next: collapse everything while any row is still
 * expanded, expand everything once they are all shut. With no layers at all there is nothing to
 * shut, so it offers `'collapse'` and does nothing — the button is disabled in that state anyway.
 */
export function collapseAllAction(state: UiState): 'collapse' | 'expand' {
  const anyExpanded = state.layers.some((l) => state.collapsedLayers[l.id] !== true);
  return anyExpanded ? 'collapse' : 'expand';
}

/**
 * The map with every entry for a layer that no longer exists dropped, or the map itself when there
 * is nothing to drop.
 *
 * Returning the **same object** when nothing changed is load-bearing: this runs on every `layers`
 * event, selectors are compared with `Object.is`, and a fresh `{}` each time would re-render the
 * whole panel on every cursor probe.
 */
export function pruneCollapsed(
  collapsed: Record<LayerId, boolean>,
  layers: readonly Layer[]
): Record<LayerId, boolean> {
  const live = new Set(layers.map((l) => l.id));
  const keys = Object.keys(collapsed) as LayerId[];
  if (keys.every((id) => live.has(id))) return collapsed;
  const out: Record<LayerId, boolean> = {};
  for (const id of keys) if (live.has(id)) out[id] = collapsed[id] as boolean;
  return out;
}
