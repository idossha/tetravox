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
import { capKey, surfaceKey } from '../render/gpu';
import type { CapGeometry } from '../render/gpu';
import { activeClipPlanes } from '../render/passes/mesh';
import { CUT_KEY_3D_CLIP, MAX_CUT_PLANES } from '../compute/cut-manager';
import type { CutSnapshot } from '../compute/cut-manager';
import { IsolateManager } from '../compute/isolate-manager';
import type { IsolateState } from '../compute/isolate-manager';
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
import type { IsolateCriteriaT } from '@tetravox/protocol';
import type {
  ColormapName,
  DatasetId,
  IsolateSpec,
  LabelTable,
  LayerId,
  MeshDataset,
  MeshLayer,
  vec3,
  View,
  VolumeDataset,
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

/**
 * The layer's enabled clip planes, in order, capped at §7.4's six.
 *
 * Re-exported from the pass so that the *cut request*, the *shader variant*, the `CLIP_DISTANCE`
 * enable set and the cut's `planeRanges` all index one list. "Plane 2" has to mean the same plane in
 * four places or §7.4's cap rule exempts the wrong one.
 */
export { activeClipPlanes };

/**
 * Tet tag → its index in the cap palette.
 *
 * Only tet tags: a `Cut` is a slab through the *volume* elements, so `CutSnapshot.tag` is always a
 * tet tag. Ernie's tri tags are 1001–1099 and its tet tags 1–10, so mixing the two would silently
 * paint a cap with a surface tag's colour where the numbering happened to collide.
 */
export function tetTagIndex(ds: MeshDataset): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of ds.tags) {
    if (t.kind !== 'tet') continue;
    if (!out.has(t.id)) out.set(t.id, out.size);
  }
  return out;
}

/**
 * The cap's `N x 2 RGBA8` tag palette — the same layout, and the same GPU path, as the label one.
 *
 * Row 0 is the tag's colour with **visibility folded into alpha**, so hiding a tissue removes its
 * cap without re-cutting; row 1's red channel is R5's selection. A recolour is therefore an
 * `8N`-byte re-upload and no geometry work at all, which is what makes R5's "the same three
 * assertions on a mesh tissue tag … in a 2D cut" cheap enough to do live.
 */
export function buildCapPalette(
  layer: MeshLayer,
  ds: MeshDataset,
  index: ReadonlyMap<number, number>,
  selected: ReadonlySet<number>
): Uint8Array {
  const n = Math.max(1, index.size);
  const out = new Uint8Array(n * 2 * 4);
  for (const [tag, k] of index) {
    const style = layer.tagStyle[tag];
    const color = style?.color ?? ds.tags.find((t) => t.id === tag && t.kind === 'tet')?.color;
    const rgba = color ?? layer.solidColor;
    out[k * 4] = Math.round((rgba[0] ?? 0) * 255);
    out[k * 4 + 1] = Math.round((rgba[1] ?? 0) * 255);
    out[k * 4 + 2] = Math.round((rgba[2] ?? 0) * 255);
    out[k * 4 + 3] = style === undefined || style.visible ? 255 : 0;
    out[(n + k) * 4] = selected.has(tag) ? 255 : 0;
  }
  return out;
}

/** A cap palette's cache key: its whole content, so a recolour or a hide is a different texture. */
export function capPaletteKey(
  layerId: LayerId,
  layer: MeshLayer,
  ds: MeshDataset,
  index: ReadonlyMap<number, number>,
  selected: ReadonlySet<number>
): string {
  const body = [...index.keys()]
    .map((tag) => {
      const style = layer.tagStyle[tag];
      const color = style?.color ?? ds.tags.find((t) => t.id === tag && t.kind === 'tet')?.color;
      const rgba = color ?? layer.solidColor;
      const hex = rgba.map((c) => Math.round(c * 255)).join(',');
      return `${tag}:${hex}:${style === undefined || style.visible ? 1 : 0}:${selected.has(tag) ? 1 : 0}`;
    })
    .join(';');
  return `${layerId}|cappalette|${body}`;
}

/**
 * Which colour a cap takes, before checking whether the table it needs has landed.
 *
 * `capColorMode:'tag'` pins it to the tet tag; `'inherit'` follows the layer, except for
 * `colorMode:'label'` — a `.annot` id is a **node** quantity and a cut vertex lies *between* two
 * nodes, where no id is defined. There is no honest interpolation of a categorical value, so a
 * labelled surface's cross-section is drawn by tissue, which is what it is.
 */
export function capColorSourceOf(layer: MeshLayer): 0 | 1 | 2 | 4 {
  if (layer.clip.capColorMode === 'tag') return MESH_COLOR_SOURCE.capTag;
  switch (layer.colorMode) {
    case 'solid':
      return MESH_COLOR_SOURCE.uniform;
    case 'field':
      return layer.field?.source === 'elm'
        ? MESH_COLOR_SOURCE.elmField
        : MESH_COLOR_SOURCE.nodeField;
    case 'tag':
    case 'label':
    default:
      return MESH_COLOR_SOURCE.capTag;
  }
}

/**
 * §4.4's `IsolateSpec` as §6.5.1's `IsolateCriteriaT`.
 *
 * Two things this conversion is the enforcement point for. **`labelVolume` names another dataset**,
 * so its `dims` / `worldToVoxel` / `dtype` are read off that `VolumeDataset` here rather than being
 * carried in the scene — §6.3 rejects a mismatch as `Error::Parse`, and the only way to be right is
 * to read them from the volume the criterion points at. And **`labels` is a plain JSON array**:
 * §6.5.1 spells out that the criteria object is `JSON.stringify`d into `mesh_isolate`, where a
 * `Uint32Array` would become `{"0":…}`.
 */
export function toIsolateCriteria(
  spec: IsolateSpec,
  volume: VolumeDataset | undefined
): IsolateCriteriaT {
  const out: IsolateCriteriaT = { combine: spec.combine };
  if (spec.tags !== undefined) out.tags = [...spec.tags];
  if (spec.field !== undefined) {
    out.field = {
      source: spec.field.source,
      name: spec.field.name,
      component: spec.field.component,
      lo: spec.field.lo,
      hi: spec.field.hi,
    };
  }
  if (spec.sphere !== undefined) {
    out.sphere = { center: [...spec.sphere.center], radius: spec.sphere.radius };
  }
  if (spec.box !== undefined) out.box = { min: [...spec.box.min], max: [...spec.box.max] };
  if (spec.labelVolume !== undefined && volume !== undefined) {
    out.labelVolume = {
      dims: [volume.dims[0], volume.dims[1], volume.dims[2]],
      // §6.3: "FLAT, length 16, column-major — deliberately NOT [[f64;4];4]".
      worldToVoxel: [...volume.inverseAffine],
      dtype: volume.dtype,
      volumeIndex: spec.labelVolume.volumeIndex,
      labels: [...spec.labelVolume.labels],
    };
  }
  return out;
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
  /** The cap palette's key, likewise. */
  #capPaletteKey: string | null = null;
  /** Tet tag → cap-palette index. Fixed for the life of the dataset. */
  readonly #tagIndex: Map<number, number>;
  /** The `CutManager` subscription for {@link CUT_KEY_3D_CLIP}, opened on the first clip plane. */
  #cutSub: (() => void) | null = null;
  /**
   * §6.5.2's mask lifecycle for this layer. One manager **per layer**, not per dataset: `isolate` is
   * a `MeshLayer` field, so two layers over one mesh may isolate differently, and the mask id is part
   * of §7.4's geometry cache key — which is what keeps their geometry apart.
   */
  #isolate: IsolateManager | null = null;
  #isolateState: IsolateState | null = null;
  /** The criteria last *requested*, serialised — the test for "did `isolate` actually change?". */
  #isolateKey = 'null';
  /** True between asking for a mask and the isolated boundary landing (§8's progress state). */
  #isolating = false;
  /** `build_topology` is issued once, and only because isolation asked for it (§6.3). */
  #topologyRequested = false;

  constructor(layer: MeshLayer, ds: MeshDataset, ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.#ds = ds;
    this.#ctx = ctx;
    this.id = layer.id;
    this.datasetId = ds.id;
    this.#tagIndex = tetTagIndex(ds);
    this.#isolateKey = JSON.stringify(layer.isolate ?? null);
    if (layer.isolate !== undefined) this.#requestIsolate(layer.isolate);
  }

  get layer(): MeshLayer {
    return this.#layer;
  }

  applyPatch(next: MeshLayer): void {
    this.#layer = next;
    // §4.4's `isolate` is the one field whose change is a **worker round trip**, not a re-render:
    // it allocates a `BitMask` the geometry cache key is built from. Compared by value, because
    // `updateLayer` replaces the whole layer object on every patch, so identity says nothing.
    const key = JSON.stringify(next.isolate ?? null);
    if (key !== this.#isolateKey) {
      this.#isolateKey = key;
      if (next.isolate === undefined) this.#clearIsolate();
      else this.#requestIsolate(next.isolate);
    }
    // A changed `field` / `colorMode:'label'` / `edges.surface` may need geometry or a table that is
    // not there yet — §7.4's "async loads with a progress state". `drawItems` issues them, because
    // that is where "what would this frame need?" is already answered.
    this.#ctx.requestRender();
  }

  /** The isolation in force, or `null` when the whole mesh is visible (§8's region panel reads it). */
  get isolation(): IsolateState | null {
    return this.#isolateState;
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
    // An isolation is the fourth: it is a `BitMask` allocation plus an `extract_boundary` over the
    // sub-mesh, so §8 must show it as work in progress rather than as a checkbox that lags.
    if (this.#isolating) return true;
    const want = wantedVariant(this.#layer, this.#emphasis.tags.size);
    if (this.#ctx.gpu.surface(this.#surfaceKey(want)) === undefined) return true;
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
    this.#requestCut();
    const gpu = this.#ctx.gpu;
    const other: SurfaceVariant = want === 'indexed' ? 'deindexed' : 'indexed';
    // Until the wanted variant lands, draw the one that has (§7.4's async switch): the layer keeps
    // its tag colours rather than disappearing.
    const geom = gpu.surface(this.#surfaceKey(want)) ?? gpu.surface(this.#surfaceKey(other));
    if (geom === undefined) return [];
    const item: MeshDrawItem = {
      kind: 'mesh',
      layer: this.#layer,
      ds: this.#ds,
      geom,
      style: this.#style(),
      caps: this.#capGeometry(),
    };
    return [item];
  }

  pickItems(view: View): PickItem[] {
    if (isSliceView(view) || !pickableIn(this.#layer)) return [];
    const geom = this.#ctx.gpu.surface(this.#surfaceKey('deindexed'));
    if (geom === undefined || geom.ownerTexture === null) return [];
    const item: MeshPickItem = {
      kind: 'mesh',
      layer: this.#layer,
      ds: this.#ds,
      geom,
      // §7.2.3 wants the pick pass to reproduce every discard, which includes what the clip removed
      // *and* what the cap put back: a double-click on a cross-section must land on the tet under it.
      caps: this.#capGeometry(),
    };
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
    if (this.#capPaletteKey !== null) {
      this.#ctx.gpu.dropMeshTable(this.#capPaletteKey);
      this.#capPaletteKey = null;
    }
    this.#cutSub?.();
    this.#cutSub = null;
    this.#ctx.gpu.dropCaps(capKey(this.id));
    // Isolated geometry is keyed by mask id, so `dropSurfaces(datasetId)` would take it — but this
    // layer may be the only holder of it, and `removeLayer` leaves the dataset alive.
    this.#dropIsolatedSurfaces();
    // §6.5.2: "the client owns `maskId` and must `freeMask`." `removeLayer` leaves the worker
    // running, so not freeing here leaks a worker-side allocation with no owner left to reclaim it.
    this.#isolate?.dispose();
    this.#isolate = null;
    this.#isolateState = null;
  }

  // -----------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------

  /**
   * §7.4's geometry cache key for this layer, *including the isolation mask*.
   *
   * §7.4 states it as `(dataset, maskId, clip state)`. The clip state is deliberately **not** in it:
   * clipping is a shader discard over the same buffers, and the caps are their own VBO set, so a
   * moving plane never invalidates a surface. What does is the mask — a different `BitMask` is a
   * different sub-mesh, and §6.5.2's `generation` is part of the key because ids are reused.
   */
  #surfaceKey(variant: SurfaceVariant): string {
    return `${surfaceKey(this.datasetId, variant, this.#isolateState?.maskId)}${
      this.#isolateState === null ? '' : `|${this.#isolateState.generation}`
    }`;
  }

  /**
   * §7.4's lazy variant build: "built in the worker on first use of `field.source === 'elm'`,
   * `edges.surface`, or `colorMode: 'label'`". Issued once, `track`ed so a golden waits for it.
   */
  #requestVariant(variant: SurfaceVariant): void {
    const key = this.#surfaceKey(variant);
    if (this.#ctx.gpu.surface(key) !== undefined) return;
    if (this.#variantRequested.has(variant)) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    this.#variantRequested.add(variant);
    // §6.3's default 3D representation: the mesh's own triangles when it has them, the derived
    // boundary when it has none (`grey_Thalamus_TI.msh` — 1,340,029 tets, 0 tris). Under a mask it
    // is always the boundary — `surface_op` routes there itself, because a sub-mesh's outside is not
    // the stored triangle set.
    const maskId = this.#isolateState?.maskId;
    const op = this.#ds.hasTris && maskId === undefined ? 'surface' : 'boundary';
    void this.#ctx
      .track(
        client.call(`geom:${this.id}:${variant}`, op, {
          handle: this.#ds.handle,
          maskId,
          variant,
        })
      )
      .then((payload) => {
        this.#ctx.gpu.uploadSurface(key, payload);
        this.#isolating = false;
        this.#ctx.requestRender();
      })
      .catch(() => {
        this.#variantRequested.delete(variant);
        this.#isolating = false;
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

  // -----------------------------------------------------------------------------------------
  // §7.4's clip planes and their exact caps
  // -----------------------------------------------------------------------------------------

  /**
   * Ask `CutManager` for this layer's clip cut, under §7.4's own key.
   *
   * Called from `drawItems`, i.e. once per pane per frame during a gizmo drag. That is deliberate
   * and cheap: `requestCut` compares the whole request — planes, mask, flags — and an identical one
   * is a no-op, so a re-render that did not move a plane issues no `cut`, and a moved plane issues
   * exactly one, latest-wins on its own key (§5 rule 6).
   *
   * `wantEdges` / `wantBoundary` are **false**: §7.4 is explicit that `Cut.edge_segments` "is not
   * used in the 3D passes — it exists for the 2D overlay", and the 3D cap's own edges come from
   * `Cut.edge_mask` through the barycentric shader. E-DERIVED asks for them under its pane keys.
   */
  #requestCut(): void {
    const planes = activeClipPlanes(this.#layer);
    // Two ways to stop needing a cut, and they release the same things: the last plane was
    // disabled, or `clip.caps` was turned off. Either leaves a subscription, a worker-side arena
    // and ~6 MB of cap buffers with nothing to draw them, so both take the release path rather
    // than only the first.
    if (planes.length === 0 || !this.#layer.clip.caps) {
      if (this.#cutSub !== null) {
        this.#cutSub();
        this.#cutSub = null;
        this.#ctx.cuts.releaseCut(this.datasetId, CUT_KEY_3D_CLIP);
        this.#ctx.gpu.dropCaps(capKey(this.id));
      }
      return;
    }
    this.#cutSub ??= this.#ctx.cuts.onCut(this.datasetId, CUT_KEY_3D_CLIP, (snap) => {
      this.#onCut(snap);
    });
    this.#ctx.cuts.requestCut(this.datasetId, CUT_KEY_3D_CLIP, planes.slice(0, MAX_CUT_PLANES), {
      maskId: this.#isolateState?.maskId ?? null,
      wantEdges: false,
      wantBoundary: false,
    });
  }

  /**
   * A cut landed: write it into §7.4's cap VBO set.
   *
   * Done here, in the worker-result task, because a {@link CutSnapshot}'s arrays are **views into
   * the manager's arena** and stay valid only until the next cut for the same key lands. Uploading
   * on the next frame instead would read whatever the drag had already overwritten.
   */
  #onCut(snap: CutSnapshot | null): void {
    if (snap === null) {
      this.#ctx.gpu.dropCaps(capKey(this.id));
    } else {
      this.#ctx.gpu.uploadCaps(capKey(this.id), snap, this.#tagIndex);
    }
    this.#ctx.requestRender();
  }

  /**
   * The cap geometry to draw this frame, or `undefined`.
   *
   * The one guard that matters is the **plane count**: §7.4's cap rule exempts "plane *i*", and a
   * `CapPlaneRange.plane` indexes the plane list the cut was requested with. Latest-wins means a
   * drag shows the previous cut for a frame — which is right, and is what "latest-wins is the only
   * drag mechanism" (§7.4) buys — but a cut taken with a *different number* of planes indexes a list
   * that no longer exists, so it is dropped rather than mis-attributed.
   */
  #capGeometry(): CapGeometry | undefined {
    const layer = this.#layer;
    if (!layer.clip.caps) return undefined;
    const planes = activeClipPlanes(layer);
    if (planes.length === 0) return undefined;
    const geom = this.#ctx.gpu.caps(capKey(this.id));
    if (geom === undefined || geom.vertexCount === 0) return undefined;
    return geom.planeRanges.every((r) => r.plane < planes.length) ? geom : undefined;
  }

  // -----------------------------------------------------------------------------------------
  // §7.4's element isolation
  // -----------------------------------------------------------------------------------------

  /**
   * Isolate by `spec`: allocate the `BitMask`, then re-derive the sub-mesh's boundary from it.
   *
   * §6.3's `build_topology` is issued **here**, once, and nowhere else: it is "called eagerly after
   * the first frame, and only when isolation or clipping needs it — never lazily from inside a
   * drag", and this is the only path that repeatedly asks `extract_boundary` for a boundary over the
   * same tets. Issuing it on the load path instead would put a several-hundred-millisecond sort in
   * front of the first frame of every mesh, which §6.3 forbids and gate 2 asserts against.
   */
  #requestIsolate(spec: IsolateSpec): void {
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    this.#isolate ??= new IsolateManager(client, this.#ds.handle, `isolate:${this.id}`);
    const manager = this.#isolate;
    this.#isolating = true;

    let volume: VolumeDataset | undefined;
    let samples: ArrayBuffer | undefined;
    if (spec.labelVolume !== undefined) {
      const ds = this.#ctx.dataset(spec.labelVolume.datasetId);
      if (ds !== undefined && ds.kind === 'volume') {
        volume = ds;
        // §5 rule 2: structured-cloned, never transferred — transferring would detach the array
        // §4.3 keeps on the UI thread for probes, and every probe after the first would read zeros.
        const d = ds.data;
        // Exactly the view's bytes: `data.buffer` can be larger than the frame the criterion
        // names, and §6.3 rejects a byte-length mismatch as `Error::Parse`.
        samples = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
      }
    }
    if (spec.labelVolume !== undefined && volume === undefined) {
      // §6.3 makes a missing label volume an `Error::Parse`; refusing to ask is the same answer
      // without a round trip, and it leaves the previous mask in force rather than clearing it.
      this.#isolating = false;
      return;
    }

    if (!this.#topologyRequested) {
      this.#topologyRequested = true;
      void this.#ctx
        .track(
          client.call(`topology:${this.datasetId}`, 'buildTopology', {
            handle: this.#ds.handle,
          })
        )
        .catch(() => {
          this.#topologyRequested = false;
        });
    }

    void this.#ctx
      .track(manager.isolate(toIsolateCriteria(spec, volume), samples))
      .then(() => {
        const state = manager.current();
        if (state === null || state === this.#isolateState) return;
        this.#adoptMask(state);
      })
      .catch(() => {
        this.#isolating = false;
      });
  }

  /** Drop the isolation: the whole mesh becomes visible again, and its mask is freed (§6.5.2). */
  #clearIsolate(): void {
    const manager = this.#isolate;
    if (manager === null) return;
    this.#isolating = true;
    void this.#ctx
      .track(manager.clear())
      .then(() => {
        this.#adoptMask(null);
      })
      .catch(() => {
        this.#isolating = false;
      });
  }

  /**
   * Adopt a new mask (or none) and invalidate what it changes.
   *
   * §7.4: "Isolation or clip changes invalidate **both** variants." Both are dropped by key rather
   * than by dataset, because another layer over the same mesh may be holding the unmasked geometry
   * — and the new mask's geometry is re-requested by `drawItems` on the very next frame.
   */
  #adoptMask(state: IsolateState | null): void {
    this.#dropIsolatedSurfaces();
    this.#isolateState = state;
    this.#variantRequested.clear();
    // The cut has to be re-taken against the new mask: `plane_cut` takes the same `maskId`, so a
    // cap over isolated-away tets would otherwise survive the isolation that removed them.
    // `requestCut` sees the changed mask and issues one; `isolating` stays true until the boundary
    // lands, which is what §8 shows as progress.
    this.#isolating = state !== null;
    this.#ctx.requestRender();
  }

  /** Release the surfaces keyed to the mask currently in force. */
  #dropIsolatedSurfaces(): void {
    if (this.#isolateState === null) return;
    for (const variant of ['indexed', 'deindexed'] as const) {
      this.#ctx.gpu.dropSurface(this.#surfaceKey(variant));
    }
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

    // §7.4's cap material. The palette is built only while there is something to cap, so an
    // unclipped layer pays nothing for it.
    const capColorSource = capColorSourceOf(layer);
    let capPalette: MeshTableTex | undefined;
    if (capColorSource === MESH_COLOR_SOURCE.capTag && activeClipPlanes(layer).length > 0) {
      const key = capPaletteKey(this.id, layer, this.#ds, this.#tagIndex, this.#emphasis.tags);
      if (this.#capPaletteKey !== null && this.#capPaletteKey !== key) {
        gpu.dropMeshTable(this.#capPaletteKey);
      }
      this.#capPaletteKey = key;
      capPalette =
        gpu.meshPalette(key) ??
        gpu.uploadMeshPalette(
          key,
          buildCapPalette(layer, this.#ds, this.#tagIndex, this.#emphasis.tags)
        );
    }

    return {
      colorSource,
      fieldTable,
      palette,
      emphasisTags,
      labelEmphasis,
      capColorSource,
      capPalette,
    };
  }
}
