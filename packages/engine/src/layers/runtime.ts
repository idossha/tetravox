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

import type { GpuCapsT } from '@tetravox/protocol';
import type { ComputeClient } from '@tetravox/wasm';
import type { ProbeRow } from '../api';
import type { GpuStore, LabelStyleGpu, SurfaceGeometry, VolumeGpu } from '../render/gpu';
import { isSliceView } from '../scene/store';
import type {
  DatasetId,
  Layer,
  LayerId,
  MeshDataset,
  MeshLayer,
  SliceView,
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
   * **Appended by E-SLICE (Phase 2).** The scene's slice planes.
   *
   * §7.2 pass 1 draws, in a **3D** pane, "the plane of each `SliceView` whose owning volume layer has
   * `showIn3D`" — so a volume runtime enumerating its draws for the 3D pane has to know which planes
   * exist. `drawItems(view)` is handed one view and the 3D one is not a plane, and widening that
   * signature would touch every other owner's runtime, so the planes arrive here instead.
   */
  slicePlanes(): readonly SliceView[];
  /**
   * **Appended by E-SLICE (Phase 2).** The §6.5 `GpuCapsT` the worker needs to pick a payload format.
   *
   * `loadVolume` is issued by the facade, which has `Capabilities`; `volumeFrame` (§6.5.2) is issued
   * *here*, when a 4D index changes, and needs the identical three fields or frame 1 comes back in a
   * different format from frame 0.
   */
  gpuCaps(): GpuCapsT;
}

/** One (layer, plane) slice draw: §7.3's "one draw per (layer, plane)". */
export interface VolumeDrawItem {
  kind: 'volume';
  layer: VolumeLayer;
  ds: VolumeDataset;
  gpu: VolumeGpu;
  /**
   * **Appended by E-SLICE (Phase 2).** The `SliceView` whose plane this draw sits on, when the pane
   * is a **3D** one and the layer has `showIn3D` — §7.2 pass 1 draws "the plane of each `SliceView`
   * whose owning volume layer has `showIn3D`", so one layer contributes one item *per plane* there.
   *
   * `undefined` in a 2D pane, where the plane is the pane's own view and the pass already has it.
   */
  plane?: SliceView;
  /**
   * **Appended by E-SLICE (Phase 2).** This layer's own label palette and selection table, when the
   * dataset is a label volume and the layer has styled it (`visibleLabels`, `labelOpacity`, a
   * recolour, or a selection). Absent means the dataset's own unstyled `gpu.palette` is the palette,
   * which is what a freshly added layer uses until something is styled.
   */
  labelStyle?: LabelStyleGpu;
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
  /**
   * **Appended by E-SLICE (Phase 2).** §7.2.3 requires the pick pass to reproduce *every* discard of
   * the main pass, and for a label slice that means the same palette (a hidden label is `A = 0`) and
   * the same 4-tap outline test. Carrying the GPU handles here rather than looking them up in the
   * pass keeps the decision in this layer's runtime, where the rest of it lives.
   */
  gpu?: VolumeGpu;
  labelStyle?: LabelStyleGpu;
  /** The plane this quad is on, when the pane is a 3D one (`showIn3D`); see `VolumeDrawItem.plane`. */
  plane?: SliceView;
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
