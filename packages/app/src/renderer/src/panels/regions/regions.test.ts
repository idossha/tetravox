/**
 * The Region panel's model — maintainer requirement **R5**, at the level §11 rule 0 can judge.
 *
 * R5's gate is stated in pixels ("hiding a label removes its colour from the pane pixels while
 * others are unchanged"), and those pixels are E-SLICE's and E-MESH's to produce. What is *this*
 * owner's to prove is the half in between: given a row and a gesture, **which `Partial<Layer>` goes
 * to `Engine.updateLayer`** — because a panel that emits the wrong patch fails the pixel gate in a
 * way no amount of shader work can fix.
 *
 * The three sources are asserted separately on purpose: they are three different fields of the
 * frozen model (`visibleLabels`, `tagStyle`, `label.visibleLabels`) and the panel that unifies them
 * is exactly where they could be crossed.
 */

import { describe, expect, it } from 'vitest';
import type {
  LabelTable,
  Layer,
  MeshDataset,
  MeshLayer,
  ProbeResult,
  VolumeDataset,
  VolumeLayer,
  vec4,
} from '@tetravox/engine';
import {
  EMPTY_SELECTION,
  bulkVisible,
  colorPatch,
  filterRows,
  fromHex,
  opacityPatch,
  partVisibilityPatch,
  probedRegionId,
  regionSourceFor,
  selectOnClick,
  soloVisible,
  toHex,
  toggledVisible,
  visibilityPatch,
} from './regions';
import type { RegionStat } from './regions';

// ------------------------------------------------------------------------------------------------
// Fixtures — shaped after ernie: sparse ids, tag 4 absent, tri and tet tags in one id space.
// ------------------------------------------------------------------------------------------------

function table(entries: { id: number; name: string; color: vec4 }[]): LabelTable {
  return { entries, byId: new Map(entries.map((e) => [e.id, e])) };
}

const LABELS = table([
  { id: 0, name: 'Unknown', color: [0, 0, 0, 0] },
  { id: 1, name: 'White matter', color: [1, 1, 0.8, 1] },
  { id: 2, name: 'Grey matter', color: [0.5, 0.5, 0.6, 1] },
  { id: 5, name: 'Scalp', color: [1, 0.75, 0.6, 1] },
]);

function labelVolume(): VolumeDataset {
  return {
    kind: 'volume',
    id: 'ds1',
    name: 'labeling.nii.gz',
    isLabel: true,
    // §6.1's sorted-unique ids. `3` has no LUT entry on purpose: the engine paints §7.6's
    // deterministic palette for it and the panel must not guess a different colour.
    labelIds: Uint32Array.from([0, 1, 2, 3, 5]),
    labelTable: LABELS,
  } as unknown as VolumeDataset;
}

function volumeLayer(over: Partial<VolumeLayer> = {}): VolumeLayer {
  return {
    id: 'ly1',
    datasetId: 'ds1',
    kind: 'volume',
    name: 'labeling.nii.gz',
    ...over,
  } as unknown as VolumeLayer;
}

function meshDataset(): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds2',
    name: 'ernie.msh',
    // Tag 4 is absent from ernie `[DATA]`, and 1002 is the tri tag of the same tissue as tet tag 2.
    // §6.2 delivers the tri block before the tet block, like the file — the pairing has to survive
    // that order. Tag 4 is absent from ernie `[DATA]`; 1099 has no volume half at all; 1 has no
    // surface half in this fixture, so both lone shapes are covered.
    tags: [
      { id: 1002, name: 'GM', color: [0.55, 0.55, 0.6, 1], kind: 'tri', count: 335_930 },
      { id: 1005, name: 'Scalp', color: [0.95, 0.75, 0.6, 1], kind: 'tri', count: 77_032 },
      {
        id: 1099,
        name: 'Internal_air_surface',
        color: [0.3, 0.3, 0.3, 1],
        kind: 'tri',
        count: 51_582,
      },
      { id: 1, name: 'WM', color: [0.9, 0.9, 0.85, 1], kind: 'tet', count: 517_144 },
      { id: 2, name: 'GM', color: [0.55, 0.55, 0.6, 1], kind: 'tet', count: 1_340_029 },
      { id: 5, name: 'Scalp', color: [0.95, 0.75, 0.6, 1], kind: 'tet', count: 567_089 },
    ],
  } as unknown as MeshDataset;
}

function meshLayer(over: Partial<MeshLayer> = {}): MeshLayer {
  return {
    id: 'ly2',
    datasetId: 'ds2',
    kind: 'mesh',
    name: 'ernie.msh',
    tagStyle: {
      1: { visible: true, opacity: 1 },
      2: { visible: true, opacity: 1 },
      5: { visible: true, opacity: 1 },
      1002: { visible: true, opacity: 1 },
      1005: { visible: true, opacity: 1 },
      1099: { visible: true, opacity: 1 },
    },
    ...over,
  } as unknown as MeshLayer;
}

function annotLayer(): MeshLayer {
  return meshLayer({
    label: {
      name: 'lh.ernie_DK40',
      table: table([
        { id: 0, name: 'unknown', color: [0, 0, 0, 0] },
        { id: 1, name: 'bankssts', color: [0.1, 0.2, 0.3, 1] },
        { id: 2, name: 'caudalanteriorcingulate', color: [0.4, 0.5, 0.6, 1] },
      ]),
      mode: 'fill',
      outlineWidthPx: 1,
    },
  });
}

/** `regionSourceFor` narrowed: a fixture that produces no regions is a broken fixture, not a case. */
function sourceOf(layer: Layer, dataset: MeshDataset | VolumeDataset, stats?: RegionStat[]) {
  const source = regionSourceFor(layer, dataset, stats);
  if (source === null) throw new Error('the fixture produced no regions');
  return source;
}

// ------------------------------------------------------------------------------------------------
// Rows
// ------------------------------------------------------------------------------------------------

describe('one panel, three sources (R5)', () => {
  it('builds a row per label id, keyed by id and never indexed by it', () => {
    const source = regionSourceFor(volumeLayer(), labelVolume());
    expect(source?.kind).toBe('labelVolume');
    expect(source?.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 5]);
    expect(source?.rows.map((r) => r.name)).toEqual([
      'Unknown',
      'White matter',
      'Grey matter',
      'Label 3',
      'Scalp',
    ]);
  });

  it('leaves an unnamed label’s colour null rather than inventing one the pane will not paint', () => {
    const rows = regionSourceFor(volumeLayer(), labelVolume())?.rows ?? [];
    expect(rows.find((r) => r.id === 3)?.color).toBeNull();
    expect(rows.find((r) => r.id === 1)?.color).toEqual([1, 1, 0.8, 1]);
  });

  it('has no counts until labelCentroids has run, and reports so rather than guessing', () => {
    const source = regionSourceFor(volumeLayer(), labelVolume());
    expect(source?.hasCounts).toBe(false);
    expect(source?.rows.every((r) => r.count === null && r.centroid === null)).toBe(true);
  });

  it('takes count and centroid from a labelCentroids result when there is one', () => {
    const stats: RegionStat[] = [{ id: 2, centroid: [1, 2, 3], count: 1_340_029 }];
    const rows = regionSourceFor(volumeLayer(), labelVolume(), stats)?.rows ?? [];
    expect(rows.find((r) => r.id === 2)).toMatchObject({
      count: 1_340_029,
      centroid: [1, 2, 3],
    });
    expect(rows.find((r) => r.id === 1)?.count).toBeNull();
  });

  it('pairs a tissue’s volume tag with its surface tag into ONE row (6 tags → 4 rows)', () => {
    const source = regionSourceFor(meshLayer(), meshDataset());
    expect(source?.kind).toBe('meshTag');
    expect(source?.hasCounts).toBe(true);
    // A `.msh` stores every tissue as tag `t` over its tets and `t + 1000` over its tris, both
    // named the same by `.msh.opt` — so listing the tags lists every tissue twice.
    expect(source?.rows.map((r) => [r.id, r.name, r.tags])).toEqual([
      [1, 'WM', [1]],
      [2, 'GM', [2, 1002]],
      [5, 'Scalp', [5, 1005]],
      [1099, 'Internal_air_surface', [1099]],
    ]);
    // The count column is tets + tris.
    expect(source?.rows.find((r) => r.id === 2)?.count).toBe(1_340_029 + 335_930);
    expect(source?.rows.find((r) => r.id === 1099)?.count).toBe(51_582);
  });

  it('gives each half its own eye state, and a lone tag only the half it has', () => {
    const rows = regionSourceFor(meshLayer(), meshDataset())?.rows ?? [];
    expect(rows.find((r) => r.id === 5)?.parts).toEqual({
      vol: { tag: 5, kind: 'tet', count: 567_089, visible: true },
      surf: { tag: 1005, kind: 'tri', count: 77_032, visible: true },
    });
    expect(rows.find((r) => r.id === 1099)?.parts).toEqual({
      surf: { tag: 1099, kind: 'tri', count: 51_582, visible: true },
    });
    expect(rows.find((r) => r.id === 1)?.parts?.surf).toBeUndefined();
  });

  it('is visible while EITHER half is, so a surface-only hide does not read as hidden', () => {
    const layer = meshLayer({
      tagStyle: {
        5: { visible: true, opacity: 1 },
        1005: { visible: false, opacity: 1 },
      },
    });
    const row = regionSourceFor(layer, meshDataset())?.rows.find((r) => r.id === 5);
    expect(row?.visible).toBe(true);
    expect(row?.parts?.surf?.visible).toBe(false);
  });

  it('counts the header per row — "Tissues (4, 1 hidden)", not per tag', () => {
    expect(regionSourceFor(meshLayer(), meshDataset())?.title).toBe('Tissues (4)');
    const layer = meshLayer({
      tagStyle: { 5: { visible: false, opacity: 1 }, 1005: { visible: false, opacity: 1 } },
    });
    expect(regionSourceFor(layer, meshDataset())?.title).toBe('Tissues (4, 1 hidden)');
  });

  it('shows an annot’s table when the mesh has one — that is what colorMode:"label" displays', () => {
    const source = regionSourceFor(annotLayer(), meshDataset());
    expect(source?.kind).toBe('annot');
    expect(source?.title).toBe('lh.ernie_DK40');
    expect(source?.rows).toHaveLength(3);
  });

  it('has no regions for a plain intensity volume', () => {
    const t1 = { ...labelVolume(), isLabel: false, labelIds: undefined } as VolumeDataset;
    expect(regionSourceFor(volumeLayer(), t1)).toBeNull();
  });

  it('treats `visibleLabels: undefined` as “all”, which is not an empty array', () => {
    const all = regionSourceFor(volumeLayer(), labelVolume())?.rows ?? [];
    expect(all.every((r) => r.visible)).toBe(true);
    const some =
      regionSourceFor(volumeLayer({ visibleLabels: Uint32Array.from([1, 5]) }), labelVolume())
        ?.rows ?? [];
    expect(some.filter((r) => r.visible).map((r) => r.id)).toEqual([1, 5]);
  });
});

// ------------------------------------------------------------------------------------------------
// Search
// ------------------------------------------------------------------------------------------------

describe('search-as-you-type', () => {
  const rows = regionSourceFor(volumeLayer(), labelVolume())?.rows ?? [];

  it('is a case-insensitive substring over the name', () => {
    expect(filterRows(rows, 'matter').map((r) => r.id)).toEqual([1, 2]);
    expect(filterRows(rows, 'GREY').map((r) => r.id)).toEqual([2]);
  });

  it('matches an id exactly, which is the only way to find one of labeling.nii.gz’s 57', () => {
    expect(filterRows(rows, '5').map((r) => r.id)).toEqual([5]);
  });

  it('returns everything for an empty query, and a copy rather than the original array', () => {
    expect(filterRows(rows, '  ')).toEqual(rows);
    expect(filterRows(rows, '')).not.toBe(rows);
  });
});

// ------------------------------------------------------------------------------------------------
// Selection
// ------------------------------------------------------------------------------------------------

describe('click, ⇧-click, ⌘-click (R5)', () => {
  const rows = regionSourceFor(volumeLayer(), labelVolume())?.rows ?? [];

  it('a plain click replaces the selection and sets the anchor', () => {
    expect(selectOnClick(rows, EMPTY_SELECTION, 2)).toEqual({ ids: [2], anchor: 2 });
  });

  it('⇧-click extends over the rows as displayed, not over the id space', () => {
    const first = selectOnClick(rows, EMPTY_SELECTION, 1);
    expect(selectOnClick(rows, first, 5, { shift: true }).ids).toEqual([1, 2, 3, 5]);
  });

  it('⇧-click over a filtered list selects the filtered span', () => {
    const shown = filterRows(rows, 'matter');
    const first = selectOnClick(shown, EMPTY_SELECTION, 1);
    expect(selectOnClick(shown, first, 2, { shift: true }).ids).toEqual([1, 2]);
  });

  it('⌘-click toggles one row in and out without disturbing the rest', () => {
    const two = selectOnClick(rows, { ids: [1], anchor: 1 }, 5, { meta: true });
    expect(two.ids).toEqual([1, 5]);
    expect(selectOnClick(rows, two, 1, { meta: true }).ids).toEqual([5]);
  });

  it('⇧-click with no anchor behaves like a plain click rather than selecting nothing', () => {
    expect(selectOnClick(rows, EMPTY_SELECTION, 5, { shift: true })).toEqual({
      ids: [5],
      anchor: 5,
    });
  });
});

describe('a click in a pane selects the row (R5’s Freeview behaviour)', () => {
  it('takes the label id the engine already resolved into the probe', () => {
    const source = sourceOf(volumeLayer(), labelVolume());
    const probe: ProbeResult = {
      world: [0, 0, 0],
      rows: [{ layerId: 'ly1', layerName: 'labeling', kind: 'volume', labelId: 2 }],
    };
    expect(probedRegionId(source, probe)).toBe(2);
  });

  it('takes the tag for a mesh, because a tissue is a tag and not a label', () => {
    const source = sourceOf(meshLayer(), meshDataset());
    const probe: ProbeResult = {
      world: [0, 0, 0],
      rows: [{ layerId: 'ly2', layerName: 'ernie', kind: 'mesh', tag: 1002, elementId: 7 }],
    };
    // The probe carries the **tag**; the panel's rows are tissues, so the surface tag of GM
    // selects the GM row rather than a row that no longer exists.
    expect(probedRegionId(source, probe)).toBe(2);
  });

  it('selects nothing when the probe never reached this layer', () => {
    const source = sourceOf(volumeLayer(), labelVolume());
    expect(probedRegionId(source, { world: [0, 0, 0], rows: [] })).toBeNull();
    expect(probedRegionId(source, null)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// Show all / Hide all / Invert / solo
// ------------------------------------------------------------------------------------------------

describe('the bulk operations', () => {
  const rows =
    regionSourceFor(volumeLayer({ visibleLabels: Uint32Array.from([1, 5]) }), labelVolume())
      ?.rows ?? [];

  it('Show all lists every id; Hide all lists none', () => {
    expect(bulkVisible(rows, 'showAll')).toEqual([0, 1, 2, 3, 5]);
    expect(bulkVisible(rows, 'hideAll')).toEqual([]);
  });

  it('Invert is the complement of what is visible now', () => {
    expect(bulkVisible(rows, 'invert')).toEqual([0, 2, 3]);
  });

  it('solo keeps exactly the chosen ids', () => {
    expect(soloVisible([2, 2, 5])).toEqual([2, 5]);
  });

  it('toggling one row leaves every other row where it was', () => {
    expect(toggledVisible(rows, 1)).toEqual([5]);
    expect(toggledVisible(rows, 2)).toEqual([1, 2, 5]);
  });
});

// ------------------------------------------------------------------------------------------------
// Patches — the only things that reach the engine
// ------------------------------------------------------------------------------------------------

describe('visibility patches', () => {
  it('writes a label volume’s selection to `visibleLabels`, sorted and deduplicated', () => {
    const layer = volumeLayer();
    const source = sourceOf(layer, labelVolume());
    const patch = visibilityPatch(source, layer, [5, 1, 5]) as Partial<VolumeLayer>;
    expect(patch.visibleLabels).toBeInstanceOf(Uint32Array);
    expect([...(patch.visibleLabels as Uint32Array)]).toEqual([1, 5]);
  });

  it('writes `undefined` — §4.4’s "all" — rather than a list of every id', () => {
    const layer = volumeLayer({ visibleLabels: Uint32Array.from([1]) });
    const source = sourceOf(layer, labelVolume());
    const patch = visibilityPatch(source, layer, [0, 1, 2, 3, 5]) as Partial<VolumeLayer>;
    expect(patch).toHaveProperty('visibleLabels');
    expect(patch.visibleLabels).toBeUndefined();
  });

  it('writes a mesh tag’s visibility into `tagStyle`, keeping every other tag’s style', () => {
    const layer = meshLayer({
      tagStyle: {
        1: { visible: true, opacity: 0.5, color: [1, 0, 0, 1] },
        2: { visible: true, opacity: 1 },
        5: { visible: true, opacity: 1 },
        1002: { visible: true, opacity: 1 },
        1005: { visible: true, opacity: 1 },
        1099: { visible: true, opacity: 1 },
      },
    });
    const source = sourceOf(layer, meshDataset());
    // Row ids, not tag ids: soloing Scalp is tet 5 **and** tri 1005.
    const patch = visibilityPatch(source, layer, [5]) as Partial<MeshLayer>;
    expect(patch.tagStyle?.[5]?.visible).toBe(true);
    expect(patch.tagStyle?.[1005]?.visible).toBe(true);
    expect(patch.tagStyle?.[2]?.visible).toBe(false);
    expect(patch.tagStyle?.[1002]?.visible).toBe(false);
    expect(patch.tagStyle?.[1099]?.visible).toBe(false);
    // Solo must not throw away the colour and opacity the user had already set on tag 1.
    expect(patch.tagStyle?.[1]).toEqual({ visible: false, opacity: 0.5, color: [1, 0, 0, 1] });
  });

  it('the Vol / Surf toggle is the one gesture that moves a single tag', () => {
    const layer = meshLayer();
    const source = sourceOf(layer, meshDataset());
    const patch = partVisibilityPatch(source, layer, 1005, false) as Partial<MeshLayer>;
    expect(patch.tagStyle?.[1005]).toEqual({ visible: false, opacity: 1 });
    expect(patch.tagStyle?.[5]).toEqual({ visible: true, opacity: 1 });
  });

  it('has no per-half toggle for anything that is not a mesh tag', () => {
    const layer = volumeLayer();
    expect(partVisibilityPatch(sourceOf(layer, labelVolume()), layer, 1, false)).toBeNull();
  });

  it('writes an annot’s visibility inside `label`, not on the layer root', () => {
    const layer = annotLayer();
    const source = sourceOf(layer, meshDataset());
    const patch = visibilityPatch(source, layer, [1]) as Partial<MeshLayer>;
    expect([...(patch.label?.visibleLabels as Uint32Array)]).toEqual([1]);
    expect(patch).not.toHaveProperty('visibleLabels');
    expect(patch.label?.name).toBe('lh.ernie_DK40');
  });
});

describe('opacity patches', () => {
  it('goes to `labelOpacity` for a label volume and merges with what is there', () => {
    const layer = volumeLayer({ labelOpacity: { 1: 0.25 } });
    const source = sourceOf(layer, labelVolume());
    const patch = opacityPatch(source, layer, 2, 0.5) as Partial<VolumeLayer>;
    expect(patch.labelOpacity).toEqual({ 1: 0.25, 2: 0.5 });
  });

  it('goes to `tagStyle` for a mesh tag, and clamps to 0..1', () => {
    const layer = meshLayer();
    const source = sourceOf(layer, meshDataset());
    const patch = opacityPatch(source, layer, 2, 1.4) as Partial<MeshLayer>;
    // One slider, both halves — §7.2's per-tag sub-draws still get one value each.
    expect(patch.tagStyle?.[2]).toEqual({ visible: true, opacity: 1 });
    expect(patch.tagStyle?.[1002]).toEqual({ visible: true, opacity: 1 });
  });

  it('has nowhere to go for an annot, and says so instead of silently doing nothing', () => {
    const layer = annotLayer();
    const source = sourceOf(layer, meshDataset());
    expect(source.adjustableOpacity).toBe(false);
    expect(opacityPatch(source, layer, 1, 0.5)).toBeNull();
  });
});

describe('colour patches', () => {
  it('recolours a mesh tag through `tagStyle[t].color`', () => {
    const layer = meshLayer();
    const source = sourceOf(layer, meshDataset());
    const patch = colorPatch(source, layer, 2, [1, 0, 0, 1]) as Partial<MeshLayer>;
    // One swatch recolours the tissue, which is both of its tags.
    expect(patch.tagStyle?.[2]?.color).toEqual([1, 0, 0, 1]);
    expect(patch.tagStyle?.[1002]?.color).toEqual([1, 0, 0, 1]);
    expect(patch.tagStyle?.[1]?.color).toBeUndefined();
  });

  it('`null` is the mesh row’s Reset: the override goes, `.msh.opt`’s colour comes back', () => {
    const layer = meshLayer({
      tagStyle: {
        2: { visible: true, opacity: 1, color: [1, 0, 0, 1] },
        1002: { visible: true, opacity: 1, color: [1, 0, 0, 1] },
      },
    });
    const source = sourceOf(layer, meshDataset());
    expect(source.rows.find((r) => r.id === 2)?.overridden).toBe(true);
    const patch = colorPatch(source, layer, 2, null) as Partial<MeshLayer>;
    expect(patch.tagStyle?.[2]).toEqual({ visible: true, opacity: 1 });
    expect(patch.tagStyle?.[1002]).toEqual({ visible: true, opacity: 1 });
    const after = sourceOf({ ...layer, ...patch } as Layer, meshDataset());
    expect(after.rows.find((r) => r.id === 2)?.color).toEqual([0.55, 0.55, 0.6, 1]);
    expect(after.rows.find((r) => r.id === 2)?.overridden).toBe(false);
  });

  it('recolours an annot entry inside the layer’s own LabelTable, byId included', () => {
    const layer = annotLayer();
    const source = sourceOf(layer, meshDataset());
    const patch = colorPatch(source, layer, 1, [0, 1, 0, 1]) as Partial<MeshLayer>;
    expect(patch.label?.table.byId.get(1)?.color).toEqual([0, 1, 0, 1]);
    expect(patch.label?.table.entries.find((e) => e.id === 2)?.color).toEqual([0.4, 0.5, 0.6, 1]);
  });

  it('recolours a label volume into `VolumeLayer.labelColors`, leaving the atlas table alone', () => {
    const layer = volumeLayer();
    const ds = labelVolume();
    const source = sourceOf(layer, ds);
    expect(source.recolorable).toBe(true);
    const patch = colorPatch(source, layer, 1, [1, 0, 0, 1]) as Partial<VolumeLayer>;
    expect(patch.labelColors).toEqual({ 1: [1, 0, 0, 1] });
    // §4.6 does not serialise a `LabelTable`; the override is on the layer, so the edit round-trips
    // — and the file's own colour is still readable underneath it.
    expect(ds.labelTable?.byId.get(1)?.color).not.toEqual([1, 0, 0, 1]);
  });

  it('adds to the overrides already there, and `null` is the per-row Reset', () => {
    const layer = { ...volumeLayer(), labelColors: { 1: [1, 0, 0, 1] as vec4 } };
    const source = sourceOf(layer, labelVolume());
    const added = colorPatch(source, layer, 2, [0, 1, 0, 1]) as Partial<VolumeLayer>;
    expect(added.labelColors).toEqual({ 1: [1, 0, 0, 1], 2: [0, 1, 0, 1] });
    const cleared = colorPatch(source, layer, 1, null) as Partial<VolumeLayer>;
    // The last override gone is `undefined`, not `{}` — a layer with no edits serialises as Phase
    // 1's did.
    expect(cleared.labelColors).toBeUndefined();
  });

  it('shows the override in the row, so the swatch and the pane agree', () => {
    const layer = { ...volumeLayer(), labelColors: { 1: [1, 0, 0, 1] as vec4 } };
    const source = sourceOf(layer, labelVolume());
    expect(source.rows.find((r) => r.id === 1)?.color).toEqual([1, 0, 0, 1]);
  });

  it('`null` is meaningless for an annot, which edits its table in place', () => {
    const annot = annotLayer();
    expect(colorPatch(sourceOf(annot, meshDataset()), annot, 1, null)).toBeNull();
  });
});

describe('swatch ⇄ colour input', () => {
  it('round-trips every exact 8-bit value', () => {
    for (const hex of ['#000000', '#ffffff', '#6ee7ff', '#8c1a2b']) {
      expect(toHex(fromHex(hex))).toBe(hex);
    }
  });

  it('keeps the alpha the row had, which the native picker cannot express', () => {
    expect(fromHex('#ff0000', 0.25)[3]).toBe(0.25);
  });

  it('clamps rather than wrapping a colour outside 0..1', () => {
    expect(toHex([2, -1, 0.5, 1])).toBe('#ff0080');
  });

  it('falls back to black on anything that is not #rrggbb', () => {
    expect(fromHex('not a colour')).toEqual([0, 0, 0, 1]);
  });
});

describe('a layer with no dataset of its own kind', () => {
  it('reports no regions rather than crossing a volume layer with a mesh dataset', () => {
    expect(regionSourceFor(volumeLayer() as Layer, meshDataset())).toBeNull();
    expect(regionSourceFor(meshLayer() as Layer, labelVolume())).toBeNull();
  });
});
