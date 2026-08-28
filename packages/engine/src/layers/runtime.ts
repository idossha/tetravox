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
import type { ColorbarSpec } from '../overlay/colorbar';
import type { CutManager } from '../compute/cut-manager';
import type {
  CapGeometry,
  GpuStore,
  LabelStyleGpu,
  SurfaceGeometry,
  VolumeGpu,
} from '../render/gpu';
import { isSliceView } from '../scene/store';
import type {
  Dataset,
  DatasetId,
  IsosurfaceLayer,
  Layer,
  LayerId,
  MeshDataset,
  MeshLayer,
  SliceView,
  PointsLayer,
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
  /**
   * The engine's one `cut` owner (`compute/cut-manager.ts`, E-MESH).
   *
   * Every consumer of a cut goes through it under its own key — `'3d-clip'` for a mesh layer's clip
   * planes, `'pane:<viewId>'` for a 2D pane's cursor plane — so §7.4's caps and §7.4's 2D
   * `contoursIn2D` / `fillIn2D` share one request per plane set and one latest-wins queue per
   * consumer. A runtime never issues the `cut` op itself.
   */
  readonly cuts: CutManager;
  /**
   * Any dataset in the scene, by id — the one cross-dataset lookup a runtime is allowed.
   *
   * It exists for §4.4's `IsolateSpec.labelVolume`, which is "the one cross-dataset op in v1"
   * (§5 rule 2): the criterion names *another* dataset's volume, and its samples travel to the mesh's
   * worker as a **structured clone** of `VolumeDataset.data`, never a transfer — transferring would
   * detach the array §4.3 keeps on the UI thread for probes.
   */
  dataset(id: DatasetId): Dataset | undefined;
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

/** A `texelFetch`-only table uploaded by `render/gpu.ts` — a field table or a label palette. */
export interface MeshTableTex {
  texture: WebGLTexture;
  width: number;
  size: number;
}

/**
 * Everything §7.4's mesh pass needs that is not already in `layer` / `ds` / `geom`, resolved by the
 * layer runtime.
 *
 * It exists because the *decision* — which geometry variant, which colour source, whether the async
 * field/label load has landed — belongs to `layers/mesh.ts`, and the pass only draws. Absent means
 * "Phase 1's uniform tag colour", which is also the correct state while a table is still loading.
 */
export interface MeshDrawStyle {
  /** `MESH_COLOR_SOURCE` (`shaders/mesh.ts`): 0 uniform · 1 node field · 2 element field · 3 label. */
  colorSource: 0 | 1 | 2 | 3;
  /** The `R32F` node / element field table, when `colorSource` is 1, 2 or 3. */
  fieldTable?: MeshTableTex;
  /** The `N x 2 RGBA8` label palette (row 0 colour+visibility, row 1 selection). */
  palette?: MeshTableTex;
  /** Tags whose sub-draw carries R5's edge emphasis even when `edges.surface` is off. */
  emphasisTags: readonly number[];
  /** A label is selected, so the shader compiles R5's screen-space boundary band. */
  labelEmphasis: boolean;
  /**
   * §7.4's cap material. A `MESH_COLOR_SOURCE` value resolved for the **cap** rather than for the
   * surface: `capColorMode:'tag'` pins it to `capTag`, `'inherit'` follows the layer's `colorMode`
   * as far as a cut vertex can (a `.annot` label is node-borne and undefined between two nodes, so
   * it falls back to the tet tag).
   */
  capColorSource?: 0 | 1 | 2 | 4;
  /** The `N x 2 RGBA8` **tet-tag** palette a `capTag` cap reads (row 0 colour, alpha = visible). */
  capPalette?: MeshTableTex;
}

/** One mesh surface draw, with the per-tag sub-ranges §7.4 draws it in. */
export interface MeshDrawItem {
  kind: 'mesh';
  layer: MeshLayer;
  ds: MeshDataset;
  geom: SurfaceGeometry;
  /** Appended in Phase 2; absent is Phase 1's behaviour exactly. */
  style?: MeshDrawStyle;
  /**
   * §7.4's exact caps, from `compute/cut-manager.ts` under `CUT_KEY_3D_CLIP`.
   *
   * Absent when the layer has no enabled clip plane, when `clip.caps` is off, or while the first cut
   * for a newly-moved plane is still in flight — in which case the clipped surface draws with no cap
   * for one frame, rather than with the previous plane's cap in the wrong place.
   */
  caps?: CapGeometry;
}

/**
 * One isosurface, as the `SurfacePayload` §6.5.2's `marchingCubes` / `marchingTets` returned.
 *
 * Deliberately **not** a `MeshDrawItem`: the two share a geometry shape and nothing else — an
 * isosurface has one colour, no tags, no `tagStyle`, no clip caps — and `MeshDrawItem.layer` is a
 * `MeshLayer`, which an `IsosurfaceLayer` is not.
 */
export interface IsoDrawItem {
  kind: 'iso';
  layer: IsosurfaceLayer;
  geom: SurfaceGeometry;
}

/**
 * One points layer — §4.4's electrodes and ROI spheres, drawn instanced (§7.4).
 *
 * The item carries the layer and nothing else: the instance buffer is a GPU resource and lives with
 * the other derived GPU resources, keyed by layer id, the same way a volume's texture lives in
 * `render/gpu.ts` rather than in `VolumeDrawItem`.
 */
export interface PointsDrawItem {
  kind: 'points';
  layer: PointsLayer;
}

export type DrawItem = VolumeDrawItem | MeshDrawItem | IsoDrawItem | PointsDrawItem;

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
  /**
   * §7.4's caps, so the pick pass reproduces the surface a double-click actually lands on.
   *
   * §7.2.3's `kindBit` is 1 for these — "0 for a triangle and 1 for a tet (cut caps)" — and the
   * element number comes from the cap's own per-vertex `ownerTet`, which is a Gmsh **tet** number.
   */
  caps?: CapGeometry;
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

  /**
   * §8's colour bar for this layer, or `null` — appended for the kinds whose bar cannot be built
   * from `Layer` and `Dataset` alone.
   *
   * A **volume**'s bar is `overlay/colorbar.ts`'s `volumeColorbarSpec(layer, ds, bakedLut)` and the
   * overlay pass builds it directly; a **mesh**'s needs the runtime, because the range a mesh field
   * is coloured over lives in `MeshFieldInfo` and in the field table the runtime loaded, not in the
   * layer. Optional, so a runtime with no bar says nothing rather than returning `null` five times.
   */
  colorbarSpec?(position?: 'right' | 'bottom'): ColorbarSpec | null;

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
