/**
 * The surface layer's runtime (2026-09-06, R5): the mesh runtime, driven by the `MeshLayer`
 * projection `scene/surface.ts` makes of a `SurfaceLayer`.
 *
 * Everything the triangle passes need — the surface variant, the field table, the label palette,
 * the clip planes, picking, probing — the mesh runtime already does for a tet-less mesh, and §7.4
 * keeps one shader set for both. Wrapping rather than subclassing is deliberate: the mesh runtime's
 * private state stays private, this class owns the one seam (`applyPatch` re-projects), and
 * `layers/mesh.ts` never learns that surfaces exist.
 */

import { MeshLayerRuntime } from './mesh';
import type { MeshEmphasis, MeshScaleInfo } from './mesh';
import type { DrawItem, LayerRuntime, LayerRuntimeContext, PickItem } from './runtime';
import type { ProbeRow } from '../api';
import type { ColorbarSpec } from '../overlay/colorbar';
import { meshView } from '../scene/surface';
import type { DatasetId, LayerId, MeshDataset, SurfaceLayer, View, vec3 } from '../scene/types';

export class SurfaceLayerRuntime implements LayerRuntime {
  readonly kind = 'surface' as const;
  readonly id: LayerId;
  readonly datasetId: DatasetId;
  #layer: SurfaceLayer;
  readonly #inner: MeshLayerRuntime;

  constructor(layer: SurfaceLayer, ds: MeshDataset, ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.id = layer.id;
    this.datasetId = ds.id;
    this.#inner = new MeshLayerRuntime(meshView(layer) as never, ds, ctx);
  }

  get layer(): SurfaceLayer {
    return this.#layer;
  }

  /** The mesh runtime underneath, for the engine members that read mesh state (colour bar, loading). */
  get mesh(): MeshLayerRuntime {
    return this.#inner;
  }

  applyPatch(next: SurfaceLayer): void {
    this.#layer = next;
    this.#inner.applyPatch(meshView(next) as never);
  }

  setEmphasis(e: MeshEmphasis): void {
    this.#inner.setEmphasis(e);
  }

  get emphasis(): MeshEmphasis {
    return this.#inner.emphasis;
  }

  get loading(): boolean {
    return this.#inner.loading;
  }

  probeRow(world: vec3): ProbeRow {
    return { ...this.#inner.probeRow(world), kind: 'surface' };
  }

  refreshProbe(world: vec3): void {
    this.#inner.refreshProbe(world);
  }

  ensurePickGeometry(view: View): void {
    this.#inner.ensurePickGeometry(view);
  }

  drawItems(view: View): DrawItem[] {
    return this.#inner.drawItems(view);
  }

  pickItems(view: View): PickItem[] {
    return this.#inner.pickItems(view);
  }

  colorbarScale(): MeshScaleInfo | null {
    return this.#inner.colorbarScale();
  }

  colorbarSpec(position?: ColorbarSpec['position']): ColorbarSpec | null {
    return this.#inner.colorbarSpec(position);
  }

  dispose(): void {
    this.#inner.dispose();
  }
}
