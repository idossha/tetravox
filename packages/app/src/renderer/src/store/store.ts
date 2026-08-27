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
  Layer,
  LayerId,
  LayoutKind,
  ProbeResult,
  QualityLevel,
  ViewId,
  vec3,
} from '@tetravox/engine';
import type { LoadCard } from '../lib/loads';
import type { Toast } from '../lib/toasts';
import type { MetricsState } from '../lib/metrics';
import type { RegionStat, SelectionState } from '../panels/regions/regions';
import { EMPTY_METRICS } from '../lib/metrics';
import type { EngineImpl } from '../engine/factory';

/** §8's coordinate bar: `World RAS` | `Voxel (active layer)`. `MNI` arrives with `toTemplate` (Phase 2). */
export type CoordSpace = 'ras' | 'voxel';

export type EngineStatus = 'pending' | 'ready' | 'webgl2-null' | 'failed';

export interface ScreenshotRecord {
  bytes: number;
  type: string;
  /** The blob really started with the 8-byte PNG signature. */
  isPng: boolean;
  at: number;
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
}

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
