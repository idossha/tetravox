/**
 * `SceneStore` — the one owner of the §4.5 `Scene` object.
 *
 * Everything the engine mutates about the scene happens here, in one place, so that Phase 2's
 * parallel agents share **state** rather than sharing a 1,000-line file. The split is deliberate:
 *
 * * This file mutates. It **never emits** — `EngineEvents` (§4.7) belongs to the facade, and a store
 *   that emitted would give two objects an opinion about when the app hears about a change.
 * * This file holds **no GL objects**. `scene/types.ts` is frozen and says so; GPU resources live in
 *   `render/gpu.ts`, keyed by `DatasetId`.
 * * Every mutation replaces the array or object it touches rather than mutating it in place, because
 *   the app's store diffs by identity (`store/controller.ts`'s `syncLayers`).
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** Append new query helpers and
 * new mutations; never reorder or repurpose the existing ones.
 */

import { defaultScene } from './defaults';
import type {
  Aabb,
  Annotations,
  Dataset,
  DatasetId,
  Layer,
  LayerId,
  Layout,
  MeshDataset,
  Scene,
  SliceView,
  vec3,
  vec4,
  View,
  View3D,
  ViewId,
  VolumeDataset,
  VolumeLayer,
} from './types';

/**
 * `View` is a union with no discriminant field of its own; `SliceView` is the one with `mode`.
 *
 * Declared once, here, because three files used to carry their own copy of this predicate and a
 * fourth wrote it inline as a cast.
 */
export function isSliceView(v: View): v is SliceView {
  return (v as SliceView).mode !== undefined;
}

/** The scene bounds fallback when nothing is loaded: a 200 mm cube about the origin. */
const EMPTY_BOUNDS: Aabb = { min: [-100, -100, -100], max: [100, 100, 100] };

export class SceneStore {
  #scene: Scene = defaultScene();

  get scene(): Scene {
    return this.#scene;
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  get views(): View[] {
    return [...this.#scene.slices, this.#scene.view3d];
  }

  view(id: ViewId): View | undefined {
    return this.views.find((v) => v.id === id);
  }

  layer(id: LayerId): Layer | undefined {
    return this.#scene.layers.find((l) => l.id === id);
  }

  dataset(id: DatasetId): Dataset | undefined {
    return this.#scene.datasets.get(id);
  }

  /** Every dataset's world AABB, for `fit()` and for the slice quad's size. */
  bounds(): Aabb {
    const min: vec3 = [Infinity, Infinity, Infinity];
    const max: vec3 = [-Infinity, -Infinity, -Infinity];
    for (const ds of this.#scene.datasets.values()) {
      for (let i = 0; i < 3; i += 1) {
        min[i] = Math.min(min[i] ?? 0, ds.bounds.min[i] ?? 0);
        max[i] = Math.max(max[i] ?? 0, ds.bounds.max[i] ?? 0);
      }
    }
    if (!Number.isFinite(min[0])) return EMPTY_BOUNDS;
    return { min, max };
  }

  /**
   * The **topmost visible volume layer** and its dataset.
   *
   * §7.5's slice step and §8's corner slice index both read "the topmost visible volume layer's
   * affine", and `Scene.layers` is bottom → top, so the search runs backwards.
   */
  topVolume(): { layer: VolumeLayer; ds: VolumeDataset } | undefined {
    return topVolume(this.#scene) ?? undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Datasets
  // -------------------------------------------------------------------------------------------

  addDataset(ds: VolumeDataset | MeshDataset): void {
    this.#scene.datasets.set(ds.id, ds);
  }

  /** Drop a dataset and every layer on it. Returns the layers that went, so their runtimes can go too. */
  removeDataset(id: DatasetId): Layer[] {
    const dropped = this.#scene.layers.filter((l) => l.datasetId === id);
    this.#scene.layers = this.#scene.layers.filter((l) => l.datasetId !== id);
    this.#reseatActiveLayer();
    this.#scene.datasets.delete(id);
    return dropped;
  }

  // -------------------------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------------------------

  addLayer(layer: Layer): Layer {
    this.#scene.layers = [...this.#scene.layers, layer];
    if (this.#scene.activeLayerId === null) this.#scene.activeLayerId = layer.id;
    return layer;
  }

  removeLayer(id: LayerId): void {
    this.#scene.layers = this.#scene.layers.filter((l) => l.id !== id);
    if (this.#scene.activeLayerId === id) this.#reseatActiveLayer(true);
  }

  /** Shallow-merge a patch over one layer. Returns the new layer, or `undefined` if there is none. */
  updateLayer(id: LayerId, patch: Partial<Layer>): Layer | undefined {
    let next: Layer | undefined;
    this.#scene.layers = this.#scene.layers.map((l) => {
      if (l.id !== id) return l;
      next = { ...l, ...patch } as Layer;
      return next;
    });
    return next;
  }

  /** Anything the caller forgot keeps its relative order at the top rather than vanishing. */
  reorderLayers(order: LayerId[]): void {
    const byId = new Map(this.#scene.layers.map((l) => [l.id, l]));
    const next: Layer[] = [];
    for (const id of order) {
      const l = byId.get(id);
      if (l !== undefined) {
        next.push(l);
        byId.delete(id);
      }
    }
    this.#scene.layers = [...next, ...byId.values()];
  }

  setActiveLayer(id: LayerId | null): void {
    this.#scene.activeLayerId = id;
  }

  /**
   * Re-point `activeLayerId` when the layer it named has gone.
   *
   * `force` re-points even if the id still resolves — `removeLayer` already knows it was the one
   * removed and does not need the lookup.
   */
  #reseatActiveLayer(force = false): void {
    const id = this.#scene.activeLayerId;
    if (!force && this.#scene.layers.some((l) => l.id === id)) return;
    this.#scene.activeLayerId = this.#scene.layers.at(-1)?.id ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Cursor, views, annotations
  // -------------------------------------------------------------------------------------------

  setCursor(world: vec3): void {
    this.#scene.cursor = world;
  }

  setLayout(layout: Layout): void {
    this.#scene.layout = layout;
  }

  setView(id: ViewId, patch: Partial<SliceView> | Partial<View3D>): void {
    if (id === this.#scene.view3d.id) {
      this.#scene.view3d = { ...this.#scene.view3d, ...(patch as Partial<View3D>) };
      return;
    }
    this.#scene.slices = this.#scene.slices.map((s) =>
      s.id === id ? ({ ...s, ...(patch as Partial<SliceView>) } as SliceView) : s
    );
  }

  setSlices(slices: SliceView[]): void {
    this.#scene.slices = slices;
  }

  setView3D(view: View3D): void {
    this.#scene.view3d = view;
  }

  setRadiological(on: boolean): void {
    this.#scene.radiological = on;
  }

  setBackground(color: vec4): void {
    this.#scene.background = color;
  }

  setLighting(lighting: Scene['lighting']): void {
    this.#scene.lighting = lighting;
  }

  setTransparency(transparency: Scene['transparency']): void {
    this.#scene.transparency = transparency;
  }

  /**
   * Replace the whole annotation block, as a loaded `ViewSpec` does.
   *
   * Distinct from {@link SceneStore.setAnnotations}, which **merges** and forces `conventionBadge`:
   * a saved scene is a complete description, and merging would let the live scene's flags leak into
   * a loaded one.
   */
  replaceAnnotations(annotations: Annotations): void {
    this.#scene.annotations = annotations;
  }

  /** §8: `Annotations.conventionBadge` is `true`, not optional — the badge is never turned off. */
  setAnnotations(patch: Partial<Annotations>): void {
    this.#scene.annotations = { ...this.#scene.annotations, ...patch, conventionBadge: true };
  }
}

/**
 * The topmost visible volume layer of a plain `Scene`.
 *
 * Exported as a free function as well as a method because the render passes hold a `Scene`, not the
 * store, and had grown their own copy of this loop.
 */
export function topVolume(scene: Scene): { layer: VolumeLayer; ds: VolumeDataset } | null {
  for (let i = scene.layers.length - 1; i >= 0; i -= 1) {
    const l = scene.layers[i];
    if (l === undefined || l.kind !== 'volume' || !l.visible) continue;
    const ds = scene.datasets.get(l.datasetId);
    if (ds !== undefined && ds.kind === 'volume') return { layer: l, ds };
  }
  return null;
}
