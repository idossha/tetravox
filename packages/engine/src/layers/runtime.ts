/**
 * `LayerRuntime` — one object per `Layer`, owning everything that is **specific to that layer's
 * kind**.
 *
 * Before this existed, "is it a volume or a mesh?" was asked in six places in `engine.ts`, twice in
 * `render/renderer.ts` and twice in `render/pick.ts`, none of them checked for exhaustiveness by the
 * type system — so a new layer kind compiled cleanly and drew nothing. §4.4 declares four kinds
 * (`volume`, `mesh`, `iso`, `points`) and Phase 1 implements two; Phase 2 adds the other two and a
 * great deal to the first two, in **four separate files**.
 *
 * Rules a runtime lives by:
 *
 * * It never parses, never de-indexes, never builds a vertex buffer (§5 rule 7, AGENTS rule 7).
 *   Everything it uploads arrived from that dataset's worker as a transferable.
 * * It never draws. It **enumerates** what should be drawn, and the §7.2 passes draw it.
 * * It never emits. `EngineEvents` belongs to the facade.
 * * It may issue worker ops through {@link LayerRuntimeContext.client}, always latest-wins on a key
 *   it owns (§5 rule 6), and always through {@link LayerRuntimeContext.track} so `whenSettled()`
 *   waits for it (§7.2).
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** Every layer owner reads
 * these types and one of them appends to them. Append a `DrawItem` / `PickItem` variant or a
 * runtime member; never narrow an existing field, because the pass that reads it belongs to
 * someone else.
 */

import type { ComputeClient } from '@tetravox/wasm';
import type { ProbeRow } from '../api';
import type { CutManager } from '../compute/cut-manager';
import type { GpuStore, SurfaceGeometry, VolumeGpu } from '../render/gpu';
import { isSliceView } from '../scene/store';
import type {
  DatasetId,
  Layer,
  LayerId,
  MeshDataset,
  MeshLayer,
  vec3,
  View,
  VolumeDataset,
  VolumeLayer,
} from '../scene/types';

/** What a runtime is allowed to reach out to. Deliberately four members and no `Engine`. */
export interface LayerRuntimeContext {
  /** GPU resources, keyed by `volumeKey` / `surfaceKey` (`render/gpu.ts`). */
  readonly gpu: GpuStore;
  /** That dataset's worker client, or `undefined` once it has been torn down (§5 rule 1). */
  client(id: DatasetId): ComputeClient | undefined;
  /** Mark the frame dirty. §7.2: this **never** draws. */
  requestRender(): void;
  /** Register a promise with `whenSettled()`, so a golden waits for it (§7.2). */
  track<T>(p: Promise<T>): Promise<T>;
  /**
   * The engine's one `cut` owner (`compute/cut-manager.ts`, E-MESH).
   *
   * Every consumer of a cut goes through it under its own key — `'3d-clip'` for a mesh layer's clip
   * planes, `'pane:<viewId>'` for a 2D pane's cursor plane — so §7.4's caps and §7.4's 2D
   * `contoursIn2D` / `fillIn2D` share one request per plane set and one latest-wins queue per
   * consumer. A runtime never issues the `cut` op itself.
   */
  readonly cuts: CutManager;
}

/** One (layer, plane) slice draw: §7.3's "one draw per (layer, plane)". */
export interface VolumeDrawItem {
  kind: 'volume';
  layer: VolumeLayer;
  ds: VolumeDataset;
  gpu: VolumeGpu;
}

/** One mesh surface draw, with the per-tag sub-ranges §7.4 draws it in. */
export interface MeshDrawItem {
  kind: 'mesh';
  layer: MeshLayer;
  ds: MeshDataset;
  geom: SurfaceGeometry;
}

export type DrawItem = VolumeDrawItem | MeshDrawItem;

/** The slice quad of a volume layer, which participates in picking (§7.2.3). */
export interface VolumePickItem {
  kind: 'volume';
  layer: VolumeLayer;
  ds: VolumeDataset;
}

/** De-indexed mesh geometry plus its `ownerElm` texture — the only pickable mesh variant. */
export interface MeshPickItem {
  kind: 'mesh';
  layer: MeshLayer;
  ds: MeshDataset;
  geom: SurfaceGeometry;
}

export type PickItem = VolumePickItem | MeshPickItem;

export interface LayerRuntime {
  readonly kind: Layer['kind'];
  readonly id: LayerId;
  readonly datasetId: DatasetId;
  /** The layer as the scene currently holds it. */
  readonly layer: Layer;

  /** The scene replaced this layer object (`updateLayer`); adopt it and react to what changed. */
  applyPatch(next: Layer): void;

  /**
   * This layer's row in `Engine.probe(world)` (§4.7).
   *
   * Synchronous, always — the facade's signature is. A row whose value needs a worker round trip is
   * served from whatever {@link refreshProbe} last landed, and carries no `value` until it has.
   */
  probeRow(world: vec3): ProbeRow;

  /** The cursor moved: refresh anything asynchronous that {@link probeRow} reads. */
  refreshProbe(world: vec3): void;

  /** Make sure the GPU resources the pick pass needs exist; lazy, and a no-op once they do. */
  ensurePickGeometry(view: View): void;

  /** What this layer contributes to the §7.2 draw passes in `view`, in draw order. */
  drawItems(view: View): DrawItem[];

  /** What this layer contributes to the §7.2.3 pick pass in `view`. */
  pickItems(view: View): PickItem[];

  /** Release anything this runtime owns that the `GpuStore` does not key by dataset. */
  dispose(): void;
}

/**
 * §4.5: a layer draws in a view when it is visible **and** that view has not hidden it.
 *
 * `layerVisibility` is per-view and optional on both `SliceView` and `View3D`; absent means "show
 * everything the layer itself allows".
 */
export function visibleIn(layer: Layer, view: View): boolean {
  const vis = isSliceView(view) ? view.layerVisibility : view.layerVisibility;
  return layer.visible && (vis?.[layer.id] ?? true);
}

/**
 * §7.2.3: pick only layers with `visible && pickable && opacity >= pickOpacityMin`.
 *
 * The default is 0.25 and there is no per-layer override in the frozen §4.4 `LayerBase`, so the
 * constant lives here rather than being written out at each call site.
 */
export const PICK_OPACITY_MIN = 0.25;

export function pickableIn(layer: Layer): boolean {
  return layer.visible && layer.pickable && layer.opacity >= PICK_OPACITY_MIN;
}
