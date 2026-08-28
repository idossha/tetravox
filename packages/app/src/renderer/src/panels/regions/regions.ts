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
  /** Mesh tags only — `tri` and `tet` tags share an id space in `.msh` and must not be merged. */
  elementKind?: 'tri' | 'tet';
}

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
      visible: isVisibleLabel(layer.visibleLabels, id),
      opacity: layer.labelOpacity?.[id] ?? 1,
      count: stat?.count ?? null,
      centroid: stat?.centroid ?? null,
    };
  });
}

function meshTagRows(layer: MeshLayer, ds: MeshDataset): RegionRow[] {
  return ds.tags.map((tag) => {
    const style = layer.tagStyle[tag.id];
    return {
      id: tag.id,
      name: tag.name ?? `Tag ${tag.id}`,
      color: style?.color ?? tag.color,
      visible: style?.visible ?? true,
      opacity: style?.opacity ?? 1,
      count: tag.count,
      centroid: null,
      elementKind: tag.kind,
    };
  });
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
    return {
      kind: 'meshTag',
      layerId: layer.id,
      title: 'Tissue tags',
      rows: meshTagRows(layer, dataset),
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
  const id = source.kind === 'meshTag' ? row.tag : row.labelId;
  return id === undefined ? null : id;
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
    const visible = new Set(visibleIds);
    const tagStyle: MeshLayer['tagStyle'] = { ...layer.tagStyle };
    for (const row of source.rows) {
      const prev = tagStyle[row.id] ?? { visible: true, opacity: 1 };
      tagStyle[row.id] = { ...prev, visible: visible.has(row.id) };
    }
    return { tagStyle };
  }
  return null;
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
    const prev = layer.tagStyle[id] ?? { visible: true, opacity: 1 };
    return {
      tagStyle: { ...layer.tagStyle, [id]: { ...prev, opacity: clamped } },
    };
  }
  return null;
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
  if (color === null) return null;
  if (source.kind === 'meshTag' && layer.kind === 'mesh') {
    const prev = layer.tagStyle[id] ?? { visible: true, opacity: 1 };
    return {
      tagStyle: { ...layer.tagStyle, [id]: { ...prev, color } },
    };
  }
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
