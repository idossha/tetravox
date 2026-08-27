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
  Dataset,
  DatasetId,
  DatasetRef,
  Layer,
  LayerId,
  LayoutKind,
  ProbeResult,
  QualityLevel,
  ScreenshotOptions,
  ViewId,
  ViewSpec,
  vec3,
} from '@tetravox/engine';
import type { LoadCard } from '../lib/loads';
import type { Toast } from '../lib/toasts';
import type { MetricsState } from '../lib/metrics';
import type { RegionStat, SelectionState } from '../panels/regions/regions';
import { EMPTY_METRICS } from '../lib/metrics';
import type { EngineImpl } from '../engine/factory';

/**
 * §8's coordinate bar: `World RAS` | `Voxel (active layer)` | `MNI`.
 *
 * `'mni'` is Phase 2's (audit P2-10). The option is offered only when a volume dataset carries a
 * `toTemplate`, and rendered **greyed** otherwise, so its absence is visible rather than silent.
 */
export type CoordSpace = 'ras' | 'voxel' | 'mni';

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
  cursor: vec3;
  cursorProbe: ProbeResult | null;
  hover: vec3 | null;
  hoverProbe: ProbeResult | null;
  quality: QualityLevel['name'];

  // -- chrome ------------------------------------------------------------------------------------
  activeViewId: ViewId | null;
  coordSpace: CoordSpace;
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

  // -- A-PROPS (§8's property editors) — appended, per the shared-file rule in
  //    docs/PHASE2-OWNERSHIP.md. Both are chrome: the engine has no opinion about either.
  /**
   * Per layer, the §7.4 switches whose geometry is being built in a worker right now — `'edges'`,
   * `'elmField'`, `'label'`. §7.4: "the first toggle of `edges.surface`, the first switch to an
   * element field, and the first `colorMode:'label'` on a given mask are **async loads with a
   * progress state**, not instant checkboxes."
   */
  meshPending: Record<LayerId, string[]>;
  /**
   * Per layer, the indices into `MeshLayer.clip.planes` of the planes whose offset follows the
   * cursor. This is **app** state, not layer state, because the frozen `ClipPlane` (§4.4) has no
   * `followCursor` field — so it does not survive `serialize()` / `load()`. Recorded, with the
   * frozen-interface request it implies, in `docs/DECISIONS.md`.
   */
  clipFollowsCursor: Record<LayerId, number[]>;

  // -- Phase 2, A-SHELL (appended; §8's scene save/load, dialogs and header panel) ----------------
  /** The scene file this session is attached to, so `Save` can write without asking again (§4.6). */
  sceneFile: SceneFileRecord | null;
  /** The last scene save/load failure, shown next to the toolbar's scene controls. */
  sceneError: string | null;
  /** Which modal is up. One at a time: they are all full-window, so a stack would only hide one. */
  dialog: DialogKind;
  /** The relocate dialog's rows, populated by `loadScene` before it raises the dialog. */
  relocate: RelocateRequest | null;
  /** The options the screenshot dialog opens with; edits are kept so a reopen resumes them. */
  screenshotOptions: ScreenshotOptions;
  /** The dataset whose raw header the info panel's header block is showing; null = the active one. */
  headerDatasetId: DatasetId | null;
}

/** Where this scene lives on disk, and when it was last written there. */
export interface SceneFileRecord {
  path: string;
  name: string;
  savedAt: number | null;
}

export type DialogKind = 'none' | 'screenshot' | 'relocate' | 'keyboard';

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
    scaleBar: false,
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
  cursor: [0, 0, 0],
  cursorProbe: null,
  hover: null,
  hoverProbe: null,
  quality: 'full',
  activeViewId: null,
  coordSpace: 'ras',
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
  clipFollowsCursor: {},
  sceneFile: null,
  sceneError: null,
  dialog: 'none',
  relocate: null,
  screenshotOptions: DEFAULT_SCREENSHOT_OPTIONS,
  headerDatasetId: null,
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
