/**
 * The `mesh` layer runtime — §7.4's side of the scene.
 *
 * Phase 1's scope: enumerate the indexed tag-surface draw, request the **de-indexed** variant the
 * pick pass needs (lazily, once), and keep the most recent `locate` result so the synchronous
 * `Engine.probe` has a mesh row to show.
 *
 * Two contract rules this file is the enforcement point for:
 *
 * * **`probe` is synchronous and a mesh probe is a worker round trip** (§6.3's `locate_point`). The
 *   row is therefore at most one round trip stale and is omitted entirely until the first result
 *   lands. §8's ≤ 50 ms mesh-hover target is met by latest-wins on the layer's own key, so a hover
 *   never queues behind a cut (§5 rule 6).
 * * **The engine never builds a vertex buffer** (§5 rule 7). The de-indexed variant is built in the
 *   worker and arrives as transferables; this file only asks for it.
 *
 * **Phase 2 (owner: E-MESH) extends this file**: `tagStyle` beyond visible/opacity, node/elm field
 * colouring and its de-indexed variant, `colorMode: 'label'`, masked edges, the six clip planes with
 * their caps (through `compute/cut-manager.ts`), isolation (through `compute/isolate-manager.ts`)
 * and its boundary re-upload, and vector glyphs.
 */

import { surfaceKey } from '../render/gpu';
import { pickableIn, visibleIn } from './runtime';
import type {
  DrawItem,
  LayerRuntime,
  LayerRuntimeContext,
  MeshDrawItem,
  MeshPickItem,
  PickItem,
} from './runtime';
import { isSliceView } from '../scene/store';
import type { ProbeRow } from '../api';
import type { DatasetId, LayerId, MeshDataset, MeshLayer, vec3, View } from '../scene/types';

function dist3(a: vec3, b: vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export class MeshLayerRuntime implements LayerRuntime {
  readonly kind = 'mesh' as const;
  readonly id: LayerId;
  readonly datasetId: DatasetId;

  #layer: MeshLayer;
  readonly #ds: MeshDataset;
  readonly #ctx: LayerRuntimeContext;

  /** The most recent `locate` result, and the world point it answered for. */
  #located: { world: vec3; row: ProbeRow } | null = null;

  constructor(layer: MeshLayer, ds: MeshDataset, ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.#ds = ds;
    this.#ctx = ctx;
    this.id = layer.id;
    this.datasetId = ds.id;
  }

  get layer(): MeshLayer {
    return this.#layer;
  }

  applyPatch(next: MeshLayer): void {
    this.#layer = next;
    // PHASE 2 (E-MESH): a changed `field` / `colorMode: 'label'` / `edges.surface` needs the
    // de-indexed variant (§7.4's "async loads with a progress state, not instant checkboxes"), and a
    // changed `clip` / `isolate` invalidates both variants' cache key.
  }

  probeRow(world: vec3): ProbeRow {
    const cached = this.#located;
    if (cached !== null && dist3(cached.world, world) < 1e-3) return cached.row;
    return { layerId: this.#layer.id, layerName: this.#layer.name, kind: 'mesh' };
  }

  /**
   * Ask the worker which element contains `world`.
   *
   * Latest-wins on `locate:<layerId>`: a drag issues one per frame and only the last survives. It is
   * deliberately **not** tracked by `whenSettled()` — a probe is not something a golden waits for,
   * and tracking it would make every screenshot wait on a round trip it does not render.
   */
  refreshProbe(world: vec3): void {
    const ds = this.#ds;
    if (ds.nTets === 0) return;
    const client = this.#ctx.client(ds.id);
    if (client === undefined) return;
    void client
      .call(`locate:${this.#layer.id}`, 'locate', { handle: ds.handle, world })
      .then((res) => {
        if (res.hit === null) {
          this.#located = null;
          return;
        }
        const tag = ds.tags.find((t) => t.id === res.hit?.tag);
        this.#located = {
          world,
          row: {
            layerId: this.#layer.id,
            layerName: this.#layer.name,
            kind: 'mesh',
            elementId: res.hit.elementId,
            tag: res.hit.tag,
            tagName: tag?.name,
            fields: [
              ...Object.entries(res.hit.nodeValues).map(([name, v]) => ({
                name,
                value: v.length === 1 ? (v[0] ?? 0) : v,
              })),
              ...Object.entries(res.hit.elmValues).map(([name, v]) => ({
                name,
                value: v.length === 1 ? (v[0] ?? 0) : v,
              })),
            ],
          },
        };
      })
      .catch(() => {
        // A superseded or cancelled locate is normal under latest-wins; it is not an error.
      });
  }

  /**
   * §7.2.3 wants the pick geometry **de-indexed**: an indexed draw has no per-corner identity, and
   * WebGL2 has no `gl_PrimitiveID`, so the element id comes from `texelFetch` at `gl_VertexID / 3`.
   *
   * Requested lazily, once, and a no-op while it is in flight — the pick simply misses that layer
   * until it lands, which is why the request is `track`ed and a golden's `whenSettled()` waits.
   */
  ensurePickGeometry(view: View): void {
    if (isSliceView(view)) return;
    const layer = this.#layer;
    if (!layer.pickable || !layer.visible) return;
    if (this.#ctx.gpu.surface(surfaceKey(this.datasetId, 'deindexed')) !== undefined) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    // §6.3's default 3D representation, same rule as the first upload: the mesh's own triangles when
    // it has them, the derived boundary when it has none.
    const op = this.#ds.hasTris ? 'surface' : 'boundary';
    void this.#ctx
      .track(
        client.call(`pickgeom:${this.datasetId}`, op, {
          handle: this.#ds.handle,
          variant: 'deindexed',
        })
      )
      .then((payload) => {
        this.#ctx.gpu.uploadSurface(surfaceKey(this.datasetId, 'deindexed'), payload);
        this.#ctx.requestRender();
      })
      .catch(() => {
        /* a cancelled or superseded build is not an error */
      });
  }

  drawItems(view: View): DrawItem[] {
    // Phase 1 draws meshes in 3D panes only; §7.4's 2D `contoursIn2D` / `fillIn2D` are Phase 2's.
    if (isSliceView(view) || !visibleIn(this.#layer, view)) return [];
    const geom =
      this.#ctx.gpu.surface(surfaceKey(this.datasetId, 'indexed')) ??
      this.#ctx.gpu.surface(surfaceKey(this.datasetId, 'deindexed'));
    if (geom === undefined) return [];
    const item: MeshDrawItem = { kind: 'mesh', layer: this.#layer, ds: this.#ds, geom };
    return [item];
  }

  pickItems(view: View): PickItem[] {
    if (isSliceView(view) || !pickableIn(this.#layer)) return [];
    const geom = this.#ctx.gpu.surface(surfaceKey(this.datasetId, 'deindexed'));
    if (geom === undefined || geom.ownerTexture === null) return [];
    const item: MeshPickItem = { kind: 'mesh', layer: this.#layer, ds: this.#ds, geom };
    return [item];
  }

  /** Surface geometry is keyed by dataset and released by `GpuStore.dropSurfaces`. */
  dispose(): void {
    this.#located = null;
  }
}
