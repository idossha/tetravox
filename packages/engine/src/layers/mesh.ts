/**
 * The `mesh` layer runtime — §7.4's side of the scene.
 *
 * Two contract rules this file is the enforcement point for:
 *
 * * **`probe` is synchronous and a mesh probe is a worker round trip** (§6.3's `locate_point`). The
 *   row is therefore at most one round trip stale and is omitted entirely until the first result
 *   lands. §8's ≤ 50 ms mesh-hover target is met by latest-wins on the layer's own key, so a hover
 *   never queues behind a cut (§5 rule 6).
 * * **The engine never builds a vertex buffer** (§5 rule 7). The de-indexed variant, every field
 *   table and every label index arrive from the worker as transferables; this file only asks for
 *   them and hands the GPU handles to the pass.
 *
 * ## What this file decides, and the pass does not
 *
 * §7.4's three switches — the first `edges.surface`, the first element field, the first
 * `colorMode:'label'` on a given mask — are "**async loads with a progress state, not instant
 * checkboxes**". So the *decision* of which geometry variant and which colour source a draw can use
 * lives here, and {@link MeshLayerRuntime.loading} reports what has not landed. Until it does, the
 * layer keeps drawing its tag colours: never a half-applied field.
 *
 * **Which variant, and the one combination that cannot be served.** §6.5.1 puts `nodeIndex` on the
 * *indexed* variant only and `corner` on the *de-indexed* one only, so a node-borne colour (a node
 * field, or an `.annot` / `.label.gii` label) and §7.4's barycentric edges want opposite geometry.
 * Colour wins: a layer that asks for both is drawn indexed and its edges wait. Closing that needs
 * `nodeIndex` on the de-indexed `SurfacePayload` — 4 bytes per vertex on a variant that already
 * costs 85 MB for ernie — which is a frozen-interface change and therefore W-WASM's. It is filed,
 * not worked around.
 */

import { MESH_COLOR_SOURCE } from '../shaders';
import { surfaceKey } from '../render/gpu';
import { bakeScale, isColormapName } from '../color/colormaps';
import { pickableIn, visibleIn } from './runtime';
import type {
  DrawItem,
  LayerRuntime,
  LayerRuntimeContext,
  MeshDrawItem,
  MeshDrawStyle,
  MeshPickItem,
  MeshTableTex,
  PickItem,
} from './runtime';
import { isSliceView } from '../scene/store';
import type { ColorbarSpec } from '../overlay/colorbar';
import type { ProbeRow } from '../api';
import type {
  ColormapName,
  DatasetId,
  LabelTable,
  LayerId,
  MeshDataset,
  MeshLayer,
  vec3,
  View,
} from '../scene/types';

export type SurfaceVariant = 'indexed' | 'deindexed';

/**
 * R5's selection, which the frozen §4.4 `MeshLayer` has nowhere to put.
 *
 * Deliberately **engine state, not scene state**: it drives an outline and nothing else, and R5's
 * "selection persists through scene save/load" needs a `ViewSpec` field that does not exist yet.
 * Filed with the integrator; until it lands, a selection is per-session.
 */
export interface MeshEmphasis {
  /** Tag ids drawn with §7.4's edges even when `edges.surface` is off. */
  tags?: readonly number[];
  /** Label ids (the `LabelEntry.id`, i.e. the original packed value) whose boundary is banded. */
  labels?: readonly number[];
}

/** One node/element field a layer reads, with the `GpuStore` key its values land under. */
export interface MeshFieldRef {
  source: 'node' | 'elm';
  name: string;
  component: 'mag' | 0 | 1 | 2;
  key: string;
}

/** What a mesh layer's colour bar is made of — E-DERIVED renders it (§8, `overlay/colorbar.ts`). */
export interface MeshScaleInfo {
  layerId: LayerId;
  /** The field's name, or the layer's when it is not field-coloured. */
  title: string;
  units?: string;
  scale: MeshLayer['scale'];
  threshold: MeshLayer['threshold'];
  colormap: string;
  colormapNegative?: string;
  /** The baked 256×1 (or 512×1 for `negative: 'separate'`) RGBA8 ramp, and what it spans. */
  ramp: Uint8Array;
  lo: number;
  hi: number;
}

function dist3(a: vec3, b: vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function colormapOf(name: string): ColormapName {
  return isColormapName(name) ? name : 'gray';
}

/**
 * §7.4's label palette, as the `N × 2 RGBA8` texture `shaders/mesh.ts` reads.
 *
 * Row 0 is each dense label's colour; row 1's red channel is whether it is selected. **Alpha is
 * visibility, not the table's own alpha**: a FreeSurfer `.annot` colortable stores 0 in the alpha
 * slot (the committed fixture's four entries are `[25,5,25,0]`, `[255,0,0,0]`, `[0,128,0,0]`,
 * `[0,0,255,0]`), so honouring it would render every annotation invisible. §4.4 gives the layer its
 * `opacity` and R5 gives each row its eye; that is where transparency lives.
 *
 * Index `k` is the **dense** index §6.2 remapped the file's packed ids to — the position in
 * `LabelTable.entries` — while `visibleLabels` and {@link MeshEmphasis.labels} name the original
 * `LabelEntry.id`, which is what the region panel and a saved scene carry.
 */
export function buildLabelPalette(
  table: LabelTable,
  visibleLabels: Uint32Array | undefined,
  selected: ReadonlySet<number>
): Uint8Array {
  const n = table.entries.length;
  const out = new Uint8Array(Math.max(1, n) * 2 * 4);
  const visible = visibleLabels === undefined ? null : new Set<number>(visibleLabels);
  table.entries.forEach((e, k) => {
    const shown = visible === null || visible.has(e.id);
    out[k * 4] = Math.round(e.color[0] * 255);
    out[k * 4 + 1] = Math.round(e.color[1] * 255);
    out[k * 4 + 2] = Math.round(e.color[2] * 255);
    out[k * 4 + 3] = shown ? 255 : 0;
    out[(n + k) * 4] = selected.has(e.id) ? 255 : 0;
  });
  return out;
}

/** A palette's cache key: its whole content, so a recolour is a different texture (R5). */
export function paletteKey(
  datasetId: DatasetId,
  name: string,
  table: LabelTable,
  visibleLabels: Uint32Array | undefined,
  selected: ReadonlySet<number>
): string {
  const colors = table.entries
    .map((e) => `${e.id}:${e.color.map((c) => Math.round(c * 255)).join(',')}`)
    .join(';');
  const vis = visibleLabels === undefined ? '*' : [...visibleLabels].join(',');
  const sel = [...selected].sort((a, b) => a - b).join(',');
  return `${datasetId}|palette|${name}|${colors}|${vis}|${sel}`;
}

/** A field table's cache key. §7.4: swapping which field is displayed is then "a texture swap". */
export function fieldKey(
  datasetId: DatasetId,
  source: 'node' | 'elm',
  name: string,
  component: 'mag' | 0 | 1 | 2
): string {
  return `${datasetId}|field|${source}|${name}|${String(component)}`;
}

/**
 * Which geometry variant a layer's settings want (§7.4's two).
 *
 * Node-borne colour forces `indexed` (only it carries `nodeIndex`); an element field and §7.4's
 * barycentric edges force `deindexed` (only it carries `corner`). Colour wins a tie — see the file
 * header.
 */
export function wantedVariant(layer: MeshLayer, emphasisedTags = 0): SurfaceVariant {
  if (layer.colorMode === 'label') return 'indexed';
  if (layer.colorMode === 'field' && layer.field?.source === 'node') return 'indexed';
  if (layer.colorMode === 'field' && layer.field?.source === 'elm') return 'deindexed';
  if (layer.edges.surface || emphasisedTags > 0) return 'deindexed';
  return 'indexed';
}

/** The node/element field a layer reads, if any. */
export function fieldRefOf(layer: MeshLayer, datasetId: DatasetId): MeshFieldRef | null {
  if (layer.colorMode === 'field' && layer.field !== undefined) {
    const { source, name, component } = layer.field;
    return { source, name, component, key: fieldKey(datasetId, source, name, component) };
  }
  if (layer.colorMode === 'label' && layer.label !== undefined) {
    // A `.annot` / `.label.gii` is a node field of **dense** indices (§6.2), read through the same
    // table as a scalar field — the palette is what turns an index into a colour.
    return {
      source: 'node',
      name: layer.label.name,
      component: 'mag',
      key: fieldKey(datasetId, 'node', layer.label.name, 'mag'),
    };
  }
  return null;
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
  /** R5's per-session selection (see {@link MeshEmphasis}). */
  #emphasis: { tags: Set<number>; labels: Set<number> } = { tags: new Set(), labels: new Set() };
  /** Surface variants already asked for, so a lazy build is issued once. */
  readonly #variantRequested = new Set<SurfaceVariant>();
  /** Field tables already asked for, keyed exactly as `GpuStore` keys them. */
  readonly #tableRequested = new Set<string>();
  /** The palette key currently uploaded, so a recolour replaces rather than leaks it. */
  #paletteKey: string | null = null;

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
    // A changed `field` / `colorMode:'label'` / `edges.surface` may need geometry or a table that is
    // not there yet — §7.4's "async loads with a progress state". `drawItems` issues them, because
    // that is where "what would this frame need?" is already answered.
    this.#ctx.requestRender();
  }

  /** R5: which tags / labels are selected. Engine state, not scene state — see {@link MeshEmphasis}. */
  setEmphasis(e: MeshEmphasis): void {
    this.#emphasis = { tags: new Set(e.tags ?? []), labels: new Set(e.labels ?? []) };
    this.#ctx.requestRender();
  }

  get emphasis(): MeshEmphasis {
    return { tags: [...this.#emphasis.tags], labels: [...this.#emphasis.labels] };
  }

  /**
   * §7.4's three async switches, as a UI-visible state (§8: "not instant checkboxes").
   *
   * `true` while the geometry variant or the field/label table this layer's settings need has been
   * asked for and has not landed.
   */
  get loading(): boolean {
    const want = wantedVariant(this.#layer, this.#emphasis.tags.size);
    if (this.#ctx.gpu.surface(surfaceKey(this.datasetId, want)) === undefined) return true;
    const ref = fieldRefOf(this.#layer, this.datasetId);
    return ref !== null && this.#ctx.gpu.meshTable(ref.key) === undefined;
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
    this.#requestVariant('deindexed');
  }

  drawItems(view: View): DrawItem[] {
    // Meshes draw in 3D panes; §7.4's 2D `contoursIn2D` / `fillIn2D` are E-DERIVED's.
    if (isSliceView(view) || !visibleIn(this.#layer, view)) return [];
    const want = wantedVariant(this.#layer, this.#emphasis.tags.size);
    this.#requestVariant(want);
    const gpu = this.#ctx.gpu;
    const other: SurfaceVariant = want === 'indexed' ? 'deindexed' : 'indexed';
    // Until the wanted variant lands, draw the one that has (§7.4's async switch): the layer keeps
    // its tag colours rather than disappearing.
    const geom =
      gpu.surface(surfaceKey(this.datasetId, want)) ??
      gpu.surface(surfaceKey(this.datasetId, other));
    if (geom === undefined) return [];
    const item: MeshDrawItem = {
      kind: 'mesh',
      layer: this.#layer,
      ds: this.#ds,
      geom,
      style: this.#style(),
    };
    return [item];
  }

  pickItems(view: View): PickItem[] {
    if (isSliceView(view) || !pickableIn(this.#layer)) return [];
    const geom = this.#ctx.gpu.surface(surfaceKey(this.datasetId, 'deindexed'));
    if (geom === undefined || geom.ownerTexture === null) return [];
    const item: MeshPickItem = { kind: 'mesh', layer: this.#layer, ds: this.#ds, geom };
    return [item];
  }

  /**
   * §8's mesh colour bar, as everything but the drawing (E-DERIVED renders it).
   *
   * `null` when the layer is not scalar-coloured or has `showColorbar` off — §8 asks for "one per
   * visible **scalar** layer", and a tag-coloured surface has a tissue table instead.
   */
  colorbarScale(): MeshScaleInfo | null {
    const layer = this.#layer;
    if (!layer.showColorbar || layer.colorMode !== 'field' || layer.field === undefined)
      return null;
    const field = layer.field;
    const info = this.#ds.fields.find((f) => f.name === field.name && f.source === field.source);
    const baked = bakeScale(
      layer.scale,
      colormapOf(layer.colormap),
      layer.colormapNegative !== undefined ? colormapOf(layer.colormapNegative) : undefined
    );
    return {
      layerId: layer.id,
      title: field.name,
      units: info?.units,
      scale: layer.scale,
      threshold: layer.threshold,
      colormap: layer.colormap,
      colormapNegative: layer.colormapNegative,
      ramp: baked.rgba,
      lo: baked.lo,
      hi: baked.hi,
    };
  }

  /** The same, as the `ColorbarSpec` the §7.2 overlay pass takes (§8's ticks and threshold notch). */
  colorbarSpec(position: ColorbarSpec['position'] = 'right'): ColorbarSpec | null {
    const s = this.colorbarScale();
    if (s === null) return null;
    const span = s.hi - s.lo;
    const at = (v: number): number => (span === 0 ? 0 : (v - s.lo) / span);
    const ticks =
      s.scale.kind === 'heat'
        ? [
            { t: at(s.scale.min), label: String(s.scale.min) },
            { t: at(s.scale.mid), label: String(s.scale.mid) },
            { t: at(s.scale.max), label: String(s.scale.max) },
          ]
        : [
            { t: 0, label: String(s.scale.lo) },
            { t: 1, label: String(s.scale.hi) },
          ];
    const notches = [s.threshold.lo, s.threshold.hi]
      .filter((v) => Number.isFinite(v))
      .map(at)
      .filter((t) => t >= 0 && t <= 1);
    return {
      layerId: s.layerId,
      title: s.title,
      units: s.units,
      ramp: s.ramp,
      ticks,
      notches,
      position,
    };
  }

  /** Surface geometry is keyed by dataset and released by `GpuStore.dropSurfaces`. */
  dispose(): void {
    this.#located = null;
    if (this.#paletteKey !== null) {
      this.#ctx.gpu.dropMeshTable(this.#paletteKey);
      this.#paletteKey = null;
    }
  }

  // -----------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------

  /**
   * §7.4's lazy variant build: "built in the worker on first use of `field.source === 'elm'`,
   * `edges.surface`, or `colorMode: 'label'`". Issued once, `track`ed so a golden waits for it.
   */
  #requestVariant(variant: SurfaceVariant): void {
    if (this.#ctx.gpu.surface(surfaceKey(this.datasetId, variant)) !== undefined) return;
    if (this.#variantRequested.has(variant)) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    this.#variantRequested.add(variant);
    // §6.3's default 3D representation: the mesh's own triangles when it has them, the derived
    // boundary when it has none (`grey_Thalamus_TI.msh` — 1,340,029 tets, 0 tris).
    const op = this.#ds.hasTris ? 'surface' : 'boundary';
    void this.#ctx
      .track(
        client.call(`geom:${this.datasetId}:${variant}`, op, {
          handle: this.#ds.handle,
          variant,
        })
      )
      .then((payload) => {
        this.#ctx.gpu.uploadSurface(surfaceKey(this.datasetId, variant), payload);
        this.#ctx.requestRender();
      })
      .catch(() => {
        this.#variantRequested.delete(variant);
      });
  }

  /** The same, for the values a scalar or label colour reads (§6.5.2's `field` op). */
  #requestField(ref: MeshFieldRef): void {
    if (this.#ctx.gpu.meshTable(ref.key) !== undefined) return;
    if (this.#tableRequested.has(ref.key)) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    this.#tableRequested.add(ref.key);
    void this.#ctx
      .track(
        client.call(`field:${this.id}`, 'field', {
          handle: this.#ds.handle,
          source: ref.source,
          name: ref.name,
          component: ref.component,
        })
      )
      .then((res) => {
        this.#ctx.gpu.uploadMeshTable(ref.key, res.values);
        this.#ctx.requestRender();
      })
      .catch(() => {
        this.#tableRequested.delete(ref.key);
      });
  }

  /** What the pass needs beyond `layer` / `ds` / `geom` — see `MeshDrawStyle`. */
  #style(): MeshDrawStyle {
    const layer = this.#layer;
    const gpu = this.#ctx.gpu;
    const emphasisTags = [...this.#emphasis.tags];
    const ref = fieldRefOf(layer, this.datasetId);
    let fieldTable: MeshTableTex | undefined;
    if (ref !== null) {
      this.#requestField(ref);
      fieldTable = gpu.meshTable(ref.key);
    }

    let palette: MeshTableTex | undefined;
    let labelEmphasis = false;
    if (layer.colorMode === 'label' && layer.label !== undefined) {
      const key = paletteKey(
        this.datasetId,
        layer.label.name,
        layer.label.table,
        layer.label.visibleLabels,
        this.#emphasis.labels
      );
      if (this.#paletteKey !== null && this.#paletteKey !== key) {
        gpu.dropMeshTable(this.#paletteKey);
      }
      this.#paletteKey = key;
      palette =
        gpu.meshPalette(key) ??
        gpu.uploadMeshPalette(
          key,
          buildLabelPalette(layer.label.table, layer.label.visibleLabels, this.#emphasis.labels)
        );
      labelEmphasis = this.#emphasis.labels.size > 0;
    }

    const colorSource =
      layer.colorMode === 'label'
        ? MESH_COLOR_SOURCE.label
        : layer.colorMode === 'field' && layer.field?.source === 'node'
          ? MESH_COLOR_SOURCE.nodeField
          : layer.colorMode === 'field' && layer.field?.source === 'elm'
            ? MESH_COLOR_SOURCE.elmField
            : MESH_COLOR_SOURCE.uniform;

    return { colorSource, fieldTable, palette, emphasisTags, labelEmphasis };
  }
}
