/**
 * The Region panel's model — **one panel for every labelled thing** (maintainer requirement R5).
 *
 * R5 names three of them and they are three different places in the frozen scene model:
 *
 * | Source | ids | colour | visible | opacity |
 * |---|---|---|---|---|
 * | label **volume** (atlas / tissue map) | `VolumeDataset.labelIds` | `VolumeLayer.labelColors` over `labelTable` | `VolumeLayer.visibleLabels` | `VolumeLayer.labelOpacity` |
 * | mesh **tissue tags** | `MeshDataset.tags` | `MeshLayer.tagStyle[t].color` | `tagStyle[t].visible` | `tagStyle[t].opacity` |
 * | surface **annotation** (`.annot` / `.label.gii`) | `MeshLayer.label.table` | that table | `label.visibleLabels` | — |
 *
 * Flattening those into one `RegionRow[]` here is what lets **one** `.tsx` render all three, and what
 * keeps §8's "no logic in React" true: every user gesture below ends in a `Partial<Layer>` that the
 * controller hands straight to `Engine.updateLayer`.
 *
 * Two things this file deliberately does **not** do:
 *
 * * It never scans `VolumeDataset.data`. §4.3 keeps those samples on the UI thread "for probes only",
 *   and a voxel count over 256×256×208 is not a probe. Counts and centroids come from the
 *   `labelCentroids` op (§6.5.2), whose result is exactly `{ id, centroid, count }[]` — see
 *   {@link RegionStat}. The facade's producer is `Engine.labelCentroids` (§4.7); until it has
 *   answered, a row's count and centroid are `null` and the panel says so rather than inventing
 *   them.
 * * It never invents a colour. A label with no `LabelEntry` gets `color: null`; the engine paints it
 *   from §7.6's deterministic glasbey-like palette, and a swatch guessed here would disagree with the
 *   pane, which is worse than an honest blank.
 */

import type {
  Dataset,
  Layer,
  LayerId,
  MeshDataset,
  MeshLayer,
  MeshTag,
  ProbeResult,
  VolumeDataset,
  VolumeLayer,
  vec3,
  vec4,
} from '@tetravox/engine';

export type RegionKind = 'labelVolume' | 'meshTag' | 'annot';

/** One row: R5's "eye · colour swatch · opacity · name · id · count". */
export interface RegionRow {
  id: number;
  name: string;
  /** 0..1 RGBA (§4.1), or `null` when no LUT names this id. */
  color: vec4 | null;
  visible: boolean;
  opacity: number;
  /** Element count for a mesh tag; voxel count for a label, once `labelCentroids` has run. */
  count: number | null;
  centroid: vec3 | null;
  /**
   * Every tag / label id this row governs. One for a label or an annot entry; **one or two** for a
   * tissue, which a SimNIBS `.msh` carries as a volume tag `t` (tets) and a surface tag `t + 1000`
   * (tris) sharing one name — see {@link TissuePart}.
   */
  tags: number[];
  /** Mesh tags only: the volume (tet) and surface (tri) halves of one tissue, when each exists. */
  parts?: TissueParts;
  /**
   * True when this row's colour is the user's, not the file's — the per-row Reset. A label volume
   * keeps its override in `VolumeLayer.labelColors`; a mesh tag in `tagStyle[t].color`.
   */
  overridden?: boolean;
  /**
   * Mesh tags only: what this tissue is painted with — the layer's `field`, or its fixed colour.
   * `tagStyle[t].colorMode` when the user set one, else what the layer's `colorMode` implies.
   */
  paint?: TagPaint;
  /** Mesh tags only: `paint` is a per-tissue override rather than the layer's own mode. */
  paintOverridden?: boolean;
}

/** How one tissue is painted. `'color'` is its own colour (`tagStyle[t].color`, else the file's). */
export type TagPaint = 'field' | 'color';

/** The paint the layer's own `colorMode` gives every tissue that has no override. */
export function layerPaint(layer: MeshLayer): TagPaint {
  return layer.colorMode === 'field' && layer.field !== undefined ? 'field' : 'color';
}

/** Whether the per-tissue paint choice means anything on this layer: it needs a field to paint. */
export function canPaintPerTag(layer: MeshLayer): boolean {
  return layer.field !== undefined && layer.colorMode !== 'label';
}

/** One half of a tissue row: the tag itself, its element count, and its own eye state. */
export interface TissuePart {
  tag: number;
  kind: 'tri' | 'tet';
  count: number;
  visible: boolean;
}

/** A tissue's two halves. At least one is present, or there would be no row. */
export interface TissueParts {
  vol?: TissuePart;
  surf?: TissuePart;
}

/** The offset between a SimNIBS volume tag (`1`…`10`, tets) and its surface tag (`1001`…, tris). */
export const SURFACE_TAG_OFFSET = 1000;

/** `OpResult['labelCentroids'].centroids[number]`, in app terms. */
export interface RegionStat {
  id: number;
  centroid: vec3;
  count: number;
}

export interface RegionSource {
  kind: RegionKind;
  layerId: LayerId;
  /** What the panel header calls this list. */
  title: string;
  rows: RegionRow[];
  /** False when the frozen model has nowhere to put an edited colour — see the module header. */
  recolorable: boolean;
  /** False when the frozen model has no per-region opacity for this kind. */
  adjustableOpacity: boolean;
  /** False until `labelCentroids` has a producer on the `Engine` facade. */
  hasCounts: boolean;
}

// ------------------------------------------------------------------------------------------------
// Building the rows
// ------------------------------------------------------------------------------------------------

function statsById(stats: readonly RegionStat[] | undefined): Map<number, RegionStat> {
  return new Map((stats ?? []).map((s) => [s.id, s]));
}

/** `undefined` means "all" (§4.4), which is not the same as an empty `Uint32Array`. */
function isVisibleLabel(visibleLabels: Uint32Array | undefined, id: number): boolean {
  return visibleLabels === undefined || visibleLabels.includes(id);
}

function volumeRows(
  layer: VolumeLayer,
  ds: VolumeDataset,
  stats: readonly RegionStat[] | undefined
): RegionRow[] {
  const byId = statsById(stats);
  // `labelIds` is §6.1's sorted-unique id list and is present iff `isLabel`; a table-only fallback
  // keeps a hand-built dataset (and every unit test) from rendering an empty panel.
  const ids =
    ds.labelIds !== undefined
      ? [...ds.labelIds]
      : (ds.labelTable?.entries.map((e) => e.id) ?? []).sort((a, b) => a - b);
  return ids.map((id) => {
    const entry = ds.labelTable?.byId.get(id);
    const stat = byId.get(id);
    return {
      id,
      name: entry?.name ?? `Label ${id}`,
      // The layer's override wins, exactly as it does in the pane's palette (`layers/volume.ts`).
      color: layer.labelColors?.[id] ?? entry?.color ?? null,
      overridden: layer.labelColors?.[id] !== undefined,
      visible: isVisibleLabel(layer.visibleLabels, id),
      opacity: layer.labelOpacity?.[id] ?? 1,
      count: stat?.count ?? null,
      centroid: stat?.centroid ?? null,
      tags: [id],
    };
  });
}

/**
 * **One row per tissue**, not one per tag.
 *
 * A SimNIBS `.msh` carries every tissue twice: a volume tag `t` over its tets (`1`…`10`) and a
 * surface tag `t + 1000` over its tris (`1001`…`1010`), and the `.msh.opt` sidecar gives both the
 * *same* name. Listing the tags is therefore listing every tissue twice — `ernie.msh` renders as 19
 * rows for 10 tissues — which is what this pairing removes. It is purely presentation: the row keeps
 * both tag ids in {@link RegionRow.parts} and every patch below still writes per-tag `tagStyle`, so
 * nothing new is persisted and a scene file means exactly what it meant.
 *
 * A tag whose partner is absent (`1099 Internal_air_surface`, or an electrode tag the simulation
 * wrote only one half of) is a row of its own with only the half it has.
 */
function meshTagRows(layer: MeshLayer, ds: MeshDataset): RegionRow[] {
  const byId = new Map(ds.tags.map((t) => [t.id, t]));
  const part = (tag: MeshTag): TissuePart => ({
    tag: tag.id,
    kind: tag.kind,
    count: tag.count,
    visible: layer.tagStyle[tag.id]?.visible ?? true,
  });

  const rows: RegionRow[] = [];
  const taken = new Set<number>();
  for (const tag of ds.tags) {
    if (taken.has(tag.id)) continue;
    // The partner must be the *other* element kind: a `tri` tag 1002 pairs with a `tet` tag 2, and
    // two tags that are both tris are two different things that happen to be 1000 apart.
    const mate =
      tag.kind === 'tet'
        ? byId.get(tag.id + SURFACE_TAG_OFFSET)
        : tag.id > SURFACE_TAG_OFFSET
          ? byId.get(tag.id - SURFACE_TAG_OFFSET)
          : undefined;
    const partner = mate?.kind === (tag.kind === 'tet' ? 'tri' : 'tet') ? mate : undefined;
    const vol = tag.kind === 'tet' ? tag : partner;
    const surf = tag.kind === 'tri' ? tag : partner;
    taken.add(tag.id);
    if (partner !== undefined) taken.add(partner.id);

    // The row is named by the tissue, so its id is the **volume** tag where there is one — that is
    // the id `final_tissues.nii.gz`, the LUT and every SimNIBS document use for the tissue.
    const anchor = vol ?? (surf as MeshTag);
    const volStyle = vol === undefined ? undefined : layer.tagStyle[vol.id];
    const surfStyle = surf === undefined ? undefined : layer.tagStyle[surf.id];
    const paintOverride = volStyle?.colorMode ?? surfStyle?.colorMode;
    const parts: TissueParts = {};
    if (vol !== undefined) parts.vol = part(vol);
    if (surf !== undefined) parts.surf = part(surf);

    rows.push({
      id: anchor.id,
      name: anchor.name ?? surf?.name ?? `Tag ${anchor.id}`,
      color: volStyle?.color ?? surfStyle?.color ?? anchor.color,
      // The row's eye reads "anything of this tissue is on screen"; the per-half toggles are the
      // precise control, and `visibilityPatch` writes both halves together.
      visible: (parts.vol?.visible ?? false) || (parts.surf?.visible ?? false),
      opacity: volStyle?.opacity ?? surfStyle?.opacity ?? 1,
      count: (vol?.count ?? 0) + (surf?.count ?? 0),
      centroid: null,
      tags: [vol?.id, surf?.id].filter((t): t is number => t !== undefined),
      parts,
      overridden: volStyle?.color !== undefined || surfStyle?.color !== undefined,
      paint: paintOverride ?? layerPaint(layer),
      paintOverridden: paintOverride !== undefined,
    });
  }
  // Tissue order, not file order: §6.2 delivers the tri block before the tet block, so the raw
  // order would run 1001, 1002, … before 1, 2, … and read as an arbitrary shuffle once paired.
  return rows.sort((a, b) => a.id - b.id);
}

/** The row a tag belongs to, for the pane-click selection and the per-half toggles. */
export function rowForTag(rows: readonly RegionRow[], tag: number): RegionRow | null {
  return rows.find((r) => r.tags.includes(tag)) ?? null;
}

function annotRows(layer: MeshLayer, stats: readonly RegionStat[] | undefined): RegionRow[] {
  const label = layer.label;
  if (label === undefined) return [];
  const byId = statsById(stats);
  return label.table.entries.map((entry) => {
    const stat = byId.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      color: entry.color,
      visible: isVisibleLabel(label.visibleLabels, entry.id),
      opacity: 1,
      count: stat?.count ?? null,
      centroid: stat?.centroid ?? null,
      tags: [entry.id],
    };
  });
}

/**
 * The regions of one layer, or `null` when that layer has none.
 *
 * A mesh with **both** an annot and tissue tags reports the annot: `colorMode: 'label'` is what the
 * user is looking at, and the tissue table (A-PROPS's other half) is where the tags live.
 */
export function regionSourceFor(
  layer: Layer,
  dataset: Dataset,
  stats?: readonly RegionStat[]
): RegionSource | null {
  if (layer.kind === 'volume' && dataset.kind === 'volume') {
    if (!dataset.isLabel) return null;
    return {
      kind: 'labelVolume',
      layerId: layer.id,
      title: 'Labels',
      rows: volumeRows(layer, dataset, stats),
      // `VolumeLayer.labelColors` (§4.4) carries the override; see `colorPatch`.
      recolorable: true,
      adjustableOpacity: true,
      hasCounts: stats !== undefined && stats.length > 0,
    };
  }
  if (layer.kind === 'mesh' && dataset.kind === 'mesh') {
    if (layer.label !== undefined) {
      return {
        kind: 'annot',
        layerId: layer.id,
        title: layer.label.name,
        rows: annotRows(layer, stats),
        recolorable: true,
        adjustableOpacity: false,
        hasCounts: stats !== undefined && stats.length > 0,
      };
    }
    if (dataset.tags.length === 0) return null;
    const rows = meshTagRows(layer, dataset);
    const hidden = rows.filter((r) => !r.visible).length;
    return {
      kind: 'meshTag',
      layerId: layer.id,
      // Counted **per row**, i.e. per tissue: "Tissues (10, 2 hidden)" on `ernie.msh`'s 19 tags.
      title: `Tissues (${rows.length}${hidden > 0 ? `, ${hidden} hidden` : ''})`,
      rows,
      recolorable: true,
      adjustableOpacity: true,
      hasCounts: true,
    };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Search
// ------------------------------------------------------------------------------------------------

/**
 * R5's search-as-you-type: substring over the name, **and** an exact match on the id.
 *
 * The id branch is what makes the box useful on `labeling.nii.gz`, whose ids run to 530 and whose
 * names are FreeSurfer's; typing `17` there means "id 17", not "every name containing 17".
 */
export function filterRows(rows: readonly RegionRow[], query: string): RegionRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  const asId = Number(q);
  const idMatch = Number.isInteger(asId) && q === String(asId);
  return rows.filter((r) => r.name.toLowerCase().includes(q) || (idMatch && r.id === asId));
}

// ------------------------------------------------------------------------------------------------
// Selection
// ------------------------------------------------------------------------------------------------

export interface ClickModifiers {
  shift?: boolean;
  /** ⌘ on macOS, Ctrl elsewhere — the caller normalises. */
  meta?: boolean;
  alt?: boolean;
}

export interface SelectionState {
  /** Selected region ids, in click order. */
  ids: number[];
  /** Where a ⇧-range starts, or `null` when there is nothing to extend from. */
  anchor: number | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: [], anchor: null };

/**
 * R5's click rules: plain = replace, ⇧ = range over the **rows as displayed**, ⌘ = toggle.
 *
 * The range is taken over `rows`, not over ids, because the rows are what the user sees: with a
 * search active, ⇧-clicking across a filtered list must select the filtered span and not the ids
 * between two numbers.
 */
export function selectOnClick(
  rows: readonly RegionRow[],
  state: SelectionState,
  id: number,
  mods: ClickModifiers = {}
): SelectionState {
  if (mods.shift && state.anchor !== null) {
    const a = rows.findIndex((r) => r.id === state.anchor);
    const b = rows.findIndex((r) => r.id === id);
    if (a !== -1 && b !== -1) {
      const [from, to] = a <= b ? [a, b] : [b, a];
      return { ids: rows.slice(from, to + 1).map((r) => r.id), anchor: state.anchor };
    }
  }
  if (mods.meta) {
    const has = state.ids.includes(id);
    const ids = has ? state.ids.filter((x) => x !== id) : [...state.ids, id];
    return { ids, anchor: has ? state.anchor : id };
  }
  return { ids: [id], anchor: id };
}

/** R5's "clicking a labelled voxel / tissue in a pane selects that row" — the id under the cursor. */
export function probedRegionId(source: RegionSource, probe: ProbeResult | null): number | null {
  const row = probe?.rows.find((r) => r.layerId === source.layerId);
  if (row === undefined) return null;
  if (source.kind === 'meshTag') {
    // The engine probes a **tag**; the panel's rows are tissues, so 1005 selects the Scalp row (5).
    return row.tag === undefined ? null : (rowForTag(source.rows, row.tag)?.id ?? null);
  }
  return row.labelId ?? null;
}

// ------------------------------------------------------------------------------------------------
// Visibility algebra — Show all / Hide all / Invert / solo
// ------------------------------------------------------------------------------------------------

export type BulkOp = 'showAll' | 'hideAll' | 'invert';

/** The ids that should be visible after `op`. */
export function bulkVisible(rows: readonly RegionRow[], op: BulkOp): number[] {
  switch (op) {
    case 'showAll':
      return rows.map((r) => r.id);
    case 'hideAll':
      return [];
    case 'invert':
      return rows.filter((r) => !r.visible).map((r) => r.id);
  }
}

/** Alt-click: R5's solo — "mute all others". */
export function soloVisible(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

export function toggledVisible(rows: readonly RegionRow[], id: number): number[] {
  return rows.filter((r) => (r.id === id ? !r.visible : r.visible)).map((r) => r.id);
}

// ------------------------------------------------------------------------------------------------
// Patches — the only things that reach `Engine.updateLayer`
// ------------------------------------------------------------------------------------------------

/**
 * The visibility patch for a set of ids.
 *
 * For a label volume and an annot, "everything visible" is written as **`undefined`**, which §4.4
 * defines as "all" — not as a `Uint32Array` listing every id. The distinction is not cosmetic: it is
 * what lets the shader skip the membership test entirely, and it is what the scene serialises.
 */
export function visibilityPatch(
  source: RegionSource,
  layer: Layer,
  visibleIds: readonly number[]
): Partial<Layer> | null {
  const all = source.rows.length > 0 && visibleIds.length === source.rows.length;
  const sorted = Uint32Array.from([...new Set(visibleIds)].sort((a, b) => a - b));

  if (source.kind === 'labelVolume' && layer.kind === 'volume') {
    return { visibleLabels: all ? undefined : sorted };
  }
  if (source.kind === 'annot' && layer.kind === 'mesh' && layer.label !== undefined) {
    const label = { ...layer.label };
    if (all) delete label.visibleLabels;
    else label.visibleLabels = sorted;
    return { label };
  }
  if (source.kind === 'meshTag' && layer.kind === 'mesh') {
    // A row is a tissue and a tissue is one or two tags: showing Scalp shows tet 5 **and** tri 1005.
    const visible = new Set(visibleIds);
    const tagStyle: MeshLayer['tagStyle'] = { ...layer.tagStyle };
    for (const row of source.rows) {
      for (const tag of row.tags) {
        const prev = tagStyle[tag] ?? { visible: true, opacity: 1 };
        tagStyle[tag] = { ...prev, visible: visible.has(row.id) };
      }
    }
    return { tagStyle };
  }
  return null;
}

/**
 * One **half** of a tissue row — the "Vol" / "Surf" toggles.
 *
 * This is the only gesture in the panel that addresses a tag rather than a row, and it exists
 * because the two halves are genuinely different geometry: hiding a tissue's surface while keeping
 * its tets is what lets the glyphs inside a head be seen (`catalogue.spec.ts` group F does exactly
 * that). Everything else — solo, bulk, opacity, colour — moves both halves together.
 */
export function partVisibilityPatch(
  source: RegionSource,
  layer: Layer,
  tag: number,
  visible: boolean
): Partial<Layer> | null {
  if (source.kind !== 'meshTag' || layer.kind !== 'mesh') return null;
  const prev = layer.tagStyle[tag] ?? { visible: true, opacity: 1 };
  return { tagStyle: { ...layer.tagStyle, [tag]: { ...prev, visible } } };
}

/** Per-region opacity, where the model has one. `null` for an annot, which has none. */
export function opacityPatch(
  source: RegionSource,
  layer: Layer,
  id: number,
  opacity: number
): Partial<Layer> | null {
  const clamped = Math.min(1, Math.max(0, opacity));
  if (source.kind === 'labelVolume' && layer.kind === 'volume') {
    return {
      labelOpacity: { ...(layer.labelOpacity ?? {}), [id]: clamped },
    };
  }
  if (source.kind === 'meshTag' && layer.kind === 'mesh') {
    return { tagStyle: editTags(source, layer, id, (s) => ({ ...s, opacity: clamped })) };
  }
  return null;
}

/**
 * Per-tissue paint: `'field'` shows the layer's field on this tissue alone, `'color'` keeps its
 * fixed colour while the rest of the mesh shows the field, `null` follows the layer again.
 *
 * A choice equal to what the layer already does is stored as **no override**: the chip then reads
 * as inherited, and switching the layer's "Colour by" later moves that tissue with it, which is
 * what a user who never touched the row expects.
 */
export function paintPatch(
  source: RegionSource,
  layer: Layer,
  id: number,
  paint: TagPaint | null
): Partial<Layer> | null {
  if (source.kind !== 'meshTag' || layer.kind !== 'mesh') return null;
  const inherited = layerPaint(layer);
  return {
    tagStyle: editTags(source, layer, id, (s) => {
      const next = { ...s };
      if (paint === null || paint === inherited) delete next.colorMode;
      else next.colorMode = paint;
      return next;
    }),
  };
}

/** Drop every per-tissue paint override on the layer — the "Colour by" row's reset. */
export function clearPaintOverrides(layer: MeshLayer): Partial<MeshLayer> {
  const next: MeshLayer['tagStyle'] = {};
  for (const [k, s] of Object.entries(layer.tagStyle)) {
    const { colorMode: _dropped, ...rest } = s;
    next[Number(k)] = rest;
  }
  return { tagStyle: next };
}

/** How many tissues on the layer carry a paint override (both halves of a tissue count once). */
export function paintOverrideCount(layer: MeshLayer, ds: MeshDataset): number {
  return meshTagRows(layer, ds).filter((r) => r.paintOverridden === true).length;
}

type TagStyleEntry = MeshLayer['tagStyle'][number];

/** Apply an edit to **every tag of one row** — a tissue's tets and tris are styled together. */
function editTags(
  source: RegionSource,
  layer: MeshLayer,
  rowId: number,
  edit: (style: TagStyleEntry) => TagStyleEntry
): MeshLayer['tagStyle'] {
  const tags = source.rows.find((r) => r.id === rowId)?.tags ?? [rowId];
  const next: MeshLayer['tagStyle'] = { ...layer.tagStyle };
  for (const tag of tags) next[tag] = edit(next[tag] ?? { visible: true, opacity: 1 });
  return next;
}

/**
 * R5's colour picker.
 *
 * All three kinds have somewhere to put the answer, and all three are **layer** state so the edit
 * round-trips through `serialize()` / `load()` (§4.6 serialises layers and re-derives a
 * `LabelTable` from the file): a mesh tag's colour is `MeshLayer.tagStyle[t].color`, an annot's is
 * the `LabelTable` on `MeshLayer.label`, and a label volume's is `VolumeLayer.labelColors` — the
 * field the Phase-2 integrator added from this panel's own filing. `labelColors` **overrides** the
 * dataset's table rather than replacing it, so the file's colours stay readable underneath and a
 * per-row Reset is deleting a key.
 *
 * `color: null` is that Reset. It is only meaningful where an override exists as a separate thing
 * from the base colour — the label-volume case; the other two edit their table in place.
 */
export function colorPatch(
  source: RegionSource,
  layer: Layer,
  id: number,
  color: vec4 | null
): Partial<Layer> | null {
  if (source.kind === 'labelVolume' && layer.kind === 'volume') {
    const next = { ...(layer.labelColors ?? {}) };
    if (color === null) delete next[id];
    else next[id] = color;
    return { labelColors: Object.keys(next).length === 0 ? undefined : next };
  }
  if (source.kind === 'meshTag' && layer.kind === 'mesh') {
    // One swatch, one colour, both halves: a tissue whose surface and volume disagreed on colour
    // is the exact confusion the paired row exists to remove. `null` is the Reset — the override is
    // dropped and the file's own `.msh.opt` colour comes back through `MeshTag.color`.
    return {
      tagStyle: editTags(source, layer, id, (s) => {
        const next = { ...s };
        if (color === null) delete next.color;
        else next.color = color;
        return next;
      }),
    };
  }
  if (color === null) return null;
  if (source.kind === 'annot' && layer.kind === 'mesh' && layer.label !== undefined) {
    const entries = layer.label.table.entries.map((e) => (e.id === id ? { ...e, color } : e));
    const table = { entries, byId: new Map(entries.map((e) => [e.id, e])) };
    return { label: { ...layer.label, table } };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Colour formatting — swatch ⇄ `<input type="color">`
// ------------------------------------------------------------------------------------------------

/** §4.1's 0..1 RGBA → `#rrggbb`. Alpha is not representable in the native picker and is preserved. */
export function toHex(color: vec4): string {
  const byte = (c: number): string =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(color[0])}${byte(color[1])}${byte(color[2])}`;
}

/** `#rrggbb` → 0..1 RGBA, keeping the alpha the row already had. */
export function fromHex(hex: string, alpha = 1): vec4 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return [0, 0, 0, alpha];
  const n = Number.parseInt(m[1] as string, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}
