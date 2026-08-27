/**
 * The mesh editor's reducers.
 *
 * `docs/PHASE2-OWNERSHIP.md` gives A-PROPS no goldens — "this is DOM, and §11's rule 0 cuts the other
 * way here: assert **state**, not pixels" — and every control in this editor is a pure function from
 * the layer to a `Partial<MeshLayer>`. So this file is the editor's real test surface: the patch is
 * the product, and the E2E only has to prove that the control emits it.
 *
 * Numbers are shaped after the reference data (AGENTS.md) — ernie's tags 1/2/5/1002, `TI_max`'s
 * range, `E`'s three components — but nothing here is a reference value.
 */

import { describe, expect, it } from 'vitest';
import type { MeshDataset, MeshLayer, Stats, vec3, vec4 } from '@tetravox/engine';
import {
  MAX_CLIP_PLANES,
  addClipPlane,
  asyncSwitchFor,
  clearIsolate,
  clearIsolateClause,
  cutColorSource,
  defaultGlyphs,
  disableGlyphs,
  filterRows,
  flipClipPlane,
  hexToVec4,
  invertTagVisibility,
  isolateIsEmpty,
  offsetThrough,
  patchThreshold,
  planesThroughCursor,
  setClipFollowsCursor,
  resetTagColor,
  selectField,
  setClipNormal,
  setContoursIn2D,
  setCutColorSource,
  setEdges,
  setFillIn2D,
  glyphOrigins,
  glyphOriginsAvailable,
  setGlyphOrigins,
  setGlyphStride,
  setIsolateBox,
  setIsolateSphere,
  setScaleKind,
  setTagColor,
  setTagOpacity,
  setTagVisible,
  setTagsVisible,
  soloTag,
  tissueRows,
  toggleIsolateTag,
  vec4ToHex,
} from './state';

function stats(min: number, max: number): Stats {
  return {
    min,
    max,
    mean: (min + max) / 2,
    percentiles: {
      '0.1': min,
      '1': min,
      '2': min,
      '5': min,
      '50': (min + max) / 2,
      '95': max,
      '98': max,
      '99': max,
      '99.9': max,
    },
    histogram: new Uint32Array(256),
    histogramLo: min,
    histogramHi: max,
  };
}

const WHITE: vec4 = [1, 1, 1, 1];

function dataset(over: Partial<MeshDataset> = {}): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds1',
    name: 'ernie.msh',
    bounds: { min: [-84, -92, -128], max: [83, 136, 99] },
    nNodes: 847_165,
    nTris: 1_177_213,
    nTets: 4_722_625,
    hasTris: true,
    fields: [
      {
        name: 'TI_max',
        source: 'elm',
        ncomp: 1,
        n: 5_899_838,
        partial: false,
        units: 'V/m',
        stats: stats(0, 10.29),
      },
      {
        name: 'E',
        source: 'elm',
        ncomp: 3,
        n: 5_900_498,
        partial: false,
        units: 'V/m',
        stats: stats(0, 57.79),
      },
      { name: 'curv', source: 'node', ncomp: 1, n: 847_165, partial: false, stats: stats(-1, 1) },
    ],
    tags: [
      { id: 1, name: 'White matter', color: [0.9, 0.9, 0.85, 1], kind: 'tet', count: 517_144 },
      { id: 2, name: 'Grey matter', color: [0.55, 0.55, 0.6, 1], kind: 'tet', count: 1_340_029 },
      { id: 5, name: 'Scalp', color: [0.95, 0.75, 0.6, 1], kind: 'tet', count: 567_089 },
      {
        id: 1002,
        name: 'Grey matter surface',
        color: [0.5, 0.5, 0.55, 1],
        kind: 'tri',
        count: 335_930,
      },
    ],
    skipped: [],
    orient: { components: 10, openComponents: 10, nonManifoldEdges: 1000, flippedComponents: 4 },
    topologyBuilt: false,
    worker: { id: 1 },
    handle: 1,
    transform: new Float32Array(16),
    appliedTransform: new Float32Array(16),
    ...over,
  } as MeshDataset;
}

function meshLayer(over: Partial<MeshLayer> = {}): MeshLayer {
  return {
    id: 'ly1',
    datasetId: 'ds1',
    name: 'ernie.msh',
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: false,
    kind: 'mesh',
    colorMode: 'tag',
    solidColor: [0.78, 0.78, 0.8, 1],
    colormap: 'viridis',
    scale: { kind: 'linear', lo: 0, hi: 1 },
    threshold: { lo: 0, hi: 1, symmetric: false, mode: 'hide', softEdge: 0 },
    tagStyle: {
      1: { visible: true, opacity: 1 },
      2: { visible: true, opacity: 1 },
      5: { visible: true, opacity: 1 },
      1002: { visible: true, opacity: 1 },
    },
    edges: { surface: false, caps: false },
    edgeColor: [0, 0, 0, 1],
    edgeWidthPx: 1,
    flatShading: false,
    faceMode: 'both',
    clip: { planes: [], caps: true, capColorMode: 'inherit' },
    contoursIn2D: false,
    contourWidthPx: 1,
    fillIn2D: false,
    ...over,
  };
}

const ALL_TAGS = [1, 2, 5, 1002];

describe('colour round trip', () => {
  it('is exact for every 8-bit value, which is what §11 asserts a tag pixel against', () => {
    for (const byte of [0, 1, 127, 128, 254, 255]) {
      const c: vec4 = [byte / 255, byte / 255, byte / 255, 1];
      expect(hexToVec4(vec4ToHex(c))).toEqual(c);
    }
    // `.msh.opt`'s scalp is 255,205,180 on the wire; the swatch must give those bytes back.
    expect(vec4ToHex([255 / 255, 205 / 255, 180 / 255, 1])).toBe('#ffcdb4');
    expect(hexToVec4('#ffcdb4')).toEqual([1, 205 / 255, 180 / 255, 1]);
  });

  it('keeps alpha, which a hex string cannot carry', () => {
    expect(hexToVec4('#000000', 0.35)[3]).toBe(0.35);
  });
});

describe('the tissue table', () => {
  it('is one row per tag, with the dataset colour until the layer overrides it', () => {
    const rows = tissueRows(dataset(), meshLayer());
    expect(rows.map((r) => r.tag)).toEqual(ALL_TAGS);
    expect(rows[0]?.name).toBe('White matter');
    expect(rows[2]?.color).toEqual([0.95, 0.75, 0.6, 1]);
    expect(rows.every((r) => !r.recoloured)).toBe(true);
    // §7.6: the ten tissue tags are not contiguous — tag 4 is absent from ernie.
    expect(rows.map((r) => r.tag)).not.toContain(4);
  });

  it('shows a tag the layer has no style for as visible at full opacity', () => {
    const rows = tissueRows(dataset(), meshLayer({ tagStyle: {} }));
    expect(rows.every((r) => r.visible && r.opacity === 1)).toBe(true);
  });

  it('searches by name and by id', () => {
    const rows = tissueRows(dataset(), meshLayer());
    expect(filterRows(rows, 'grey').map((r) => r.tag)).toEqual([2, 1002]);
    expect(filterRows(rows, '100').map((r) => r.tag)).toEqual([1002]);
    expect(filterRows(rows, '').length).toBe(4);
    expect(filterRows(rows, 'nope')).toEqual([]);
  });

  it('hides one tag without touching the others (R5)', () => {
    const layer = meshLayer();
    const patch = setTagVisible(layer, 5, false);
    expect(patch.tagStyle?.[5]).toEqual({ visible: false, opacity: 1 });
    expect(patch.tagStyle?.[2]).toEqual({ visible: true, opacity: 1 });
    expect(Object.keys(patch)).toEqual(['tagStyle']);
  });

  it('shows all / hides all / inverts over the rows on screen', () => {
    const layer = meshLayer();
    expect(setTagsVisible(layer, [1, 2], false).tagStyle?.[1]?.visible).toBe(false);
    const inverted = invertTagVisibility(
      meshLayer({
        tagStyle: { 1: { visible: false, opacity: 1 }, 2: { visible: true, opacity: 1 } },
      }),
      [1, 2]
    );
    expect(inverted.tagStyle?.[1]?.visible).toBe(true);
    expect(inverted.tagStyle?.[2]?.visible).toBe(false);
  });

  it('solos exactly one tag and mutes the rest', () => {
    const patch = soloTag(meshLayer(), ALL_TAGS, 2);
    expect(ALL_TAGS.map((t) => patch.tagStyle?.[t]?.visible)).toEqual([false, true, false, false]);
  });

  it('clamps opacity into 0..1', () => {
    expect(setTagOpacity(meshLayer(), 1, 2).tagStyle?.[1]?.opacity).toBe(1);
    expect(setTagOpacity(meshLayer(), 1, -1).tagStyle?.[1]?.opacity).toBe(0);
    expect(setTagOpacity(meshLayer(), 1, 0.35).tagStyle?.[1]?.opacity).toBe(0.35);
  });

  it('recolours a tag, and resets back to the file colour', () => {
    const recoloured = setTagColor(meshLayer(), 5, WHITE);
    expect(recoloured.tagStyle?.[5]?.color).toEqual(WHITE);
    const layer = meshLayer({ tagStyle: { 5: { visible: false, opacity: 0.5, color: WHITE } } });
    const reset = resetTagColor(layer, 5);
    expect(reset.tagStyle?.[5]).toEqual({ visible: false, opacity: 0.5 });
    // The row falls back to the dataset's own colour, which is where `.msh.opt` landed.
    expect(tissueRows(dataset(), { ...layer, ...reset })[2]?.color).toEqual([0.95, 0.75, 0.6, 1]);
  });
});

describe('the field selector', () => {
  it('re-seeds the scale and threshold from the field it selects', () => {
    const patch = selectField(dataset(), meshLayer(), 'elm:TI_max');
    expect(patch.colorMode).toBe('field');
    expect(patch.field).toEqual({ source: 'elm', name: 'TI_max', component: 'mag' });
    expect(patch.scale).toEqual({ kind: 'linear', lo: 0, hi: 10.29 });
    expect(patch.threshold).toEqual({
      lo: 0,
      hi: 10.29,
      symmetric: false,
      mode: 'hide',
      softEdge: 0,
    });
  });

  it('keeps the chosen component on a vector field and forces `mag` on a scalar', () => {
    const vector = meshLayer({ field: { source: 'elm', name: 'E', component: 2 } });
    expect(selectField(dataset(), vector, 'elm:E').field?.component).toBe(2);
    expect(selectField(dataset(), vector, 'elm:TI_max').field?.component).toBe('mag');
  });

  it('ignores a field the dataset does not have', () => {
    expect(selectField(dataset(), meshLayer(), 'node:nope')).toEqual({});
  });

  it('converts linear ⇄ heat without losing the window', () => {
    const heat = setScaleKind(meshLayer({ scale: { kind: 'linear', lo: 2, hi: 8 } }), 'heat');
    expect(heat.scale).toEqual({
      kind: 'heat',
      min: 2,
      mid: 5,
      max: 8,
      truncate: false,
      inverse: false,
      negative: 'mirror',
    });
    const back = setScaleKind({ ...meshLayer(), ...heat } as MeshLayer, 'linear');
    expect(back.scale).toEqual({ kind: 'linear', lo: 2, hi: 8 });
  });

  it('patches one threshold field at a time', () => {
    const patch = patchThreshold(meshLayer(), { softEdge: 0.5 });
    expect(patch.threshold).toEqual({
      lo: 0,
      hi: 1,
      symmetric: false,
      mode: 'hide',
      softEdge: 0.5,
    });
  });

  it('merges the two edge switches rather than replacing the pair', () => {
    expect(
      setEdges(meshLayer({ edges: { surface: false, caps: true } }), { surface: true }).edges
    ).toEqual({ surface: true, caps: true });
  });
});

describe('the 2D cross-section (R4)', () => {
  it('toggles fill and contours independently', () => {
    expect(setFillIn2D(meshLayer(), true)).toEqual({ fillIn2D: true });
    expect(setContoursIn2D(meshLayer(), true)).toEqual({ contoursIn2D: true });
  });

  it('drives the cut colour through the layer’s own colour source', () => {
    expect(setCutColorSource(dataset(), meshLayer(), 'tag')).toEqual({ colorMode: 'tag' });
    const byField = setCutColorSource(dataset(), meshLayer(), 'elm:TI_max');
    expect(byField.colorMode).toBe('field');
    expect(byField.field?.name).toBe('TI_max');
    expect(cutColorSource(meshLayer())).toBe('tag');
    expect(
      cutColorSource(
        meshLayer({
          colorMode: 'field',
          field: { source: 'elm', name: 'TI_max', component: 'mag' },
        })
      )
    ).toBe('elm:TI_max');
  });
});

describe('clip planes', () => {
  it('adds up to six and then refuses', () => {
    let layer = meshLayer();
    for (let i = 0; i < MAX_CLIP_PLANES; i += 1) {
      layer = { ...layer, ...addClipPlane(layer, [0, 0, 1], i) };
    }
    expect(layer.clip.planes.length).toBe(MAX_CLIP_PLANES);
    expect(addClipPlane(layer, [1, 0, 0], 0)).toEqual({});
  });

  it('normalises the normal and ignores a degenerate one', () => {
    const layer = meshLayer({
      clip: {
        planes: [{ plane: { normal: [0, 0, 1], offset: 0 }, enabled: true }],
        caps: true,
        capColorMode: 'inherit',
      },
    });
    const patch = setClipNormal(layer, 0, [0, 0, 4]);
    expect(patch.clip?.planes[0]?.plane.normal).toEqual([0, 0, 1]);
    expect(setClipNormal(layer, 0, [0, 0, 0])).toEqual({});
  });

  it('flips the kept side without moving the plane', () => {
    // A plane through z = 40: `dot([0,0,1], p) - 40 = 0`.
    const layer = meshLayer({
      clip: {
        planes: [{ plane: { normal: [0, 0, 1], offset: -40 }, enabled: true }],
        caps: true,
        capColorMode: 'inherit',
      },
    });
    const flipped = flipClipPlane(layer, 0).clip?.planes[0]?.plane;
    expect(flipped).toEqual({ normal: [-0, -0, -1], offset: 40 });
    const on: vec3 = [10, -5, 40];
    const before = 0 * on[0] + 0 * on[1] + 1 * on[2] - 40;
    const after =
      (flipped?.normal[0] ?? 0) * on[0] +
      (flipped?.normal[1] ?? 0) * on[1] +
      (flipped?.normal[2] ?? 0) * on[2] +
      (flipped?.offset ?? 0);
    // The plane is the same set of points; only which half-space is kept changed.
    expect(before).toBe(0);
    expect(after).toBe(0);
    // And a point that was kept is now discarded.
    const above: vec3 = [0, 0, 60];
    expect(1 * above[2] - 40).toBeGreaterThan(0);
    expect(-1 * above[2] + 40).toBeLessThan(0);
  });

  it('puts a plane through a point with `offsetThrough`', () => {
    const n: vec3 = [0, 0, 1];
    const p: vec3 = [3, 4, 12.5];
    const offset = offsetThrough(n, p);
    expect(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + offset).toBe(0);
  });

  it('moves only the planes that follow the cursor, and nothing when they already do', () => {
    const layer = meshLayer({
      clip: {
        planes: [
          { plane: { normal: [0, 0, 1], offset: 0 }, enabled: true },
          { plane: { normal: [1, 0, 0], offset: 0 }, enabled: true },
        ],
        caps: true,
        capColorMode: 'inherit',
      },
    });
    const cursor: vec3 = [10, 20, 30];
    // Nothing follows yet, so nothing moves — `followCursor` is the flag, not an argument.
    expect(planesThroughCursor(layer, cursor)).toEqual({});
    const following = {
      ...layer,
      ...setClipFollowsCursor(layer, 1, true),
    } as MeshLayer;
    expect(following.clip.planes[1]?.followCursor).toBe(true);
    expect(following.clip.planes[0]?.followCursor).toBeUndefined();

    const patch = planesThroughCursor(following, cursor);
    expect(patch.clip?.planes[0]?.plane.offset).toBe(0);
    expect(patch.clip?.planes[1]?.plane.offset).toBe(-10);
    const settled = { ...following, ...patch } as MeshLayer;
    expect(planesThroughCursor(settled, cursor)).toEqual({});

    // Off deletes the key rather than writing `false`, so a plane that never followed serialises
    // exactly as Phase 1's did.
    const off = { ...settled, ...setClipFollowsCursor(settled, 1, false) } as MeshLayer;
    expect('followCursor' in (off.clip.planes[1] as object)).toBe(false);
    expect(planesThroughCursor(off, [99, 99, 99])).toEqual({});
  });
});

describe('isolation', () => {
  it('adds and removes a tag, and drops the whole spec when nothing is left', () => {
    const one = toggleIsolateTag(meshLayer(), 2);
    expect(one.isolate?.tags).toEqual([2]);
    const two = toggleIsolateTag({ ...meshLayer(), ...one } as MeshLayer, 1);
    expect(two.isolate?.tags).toEqual([1, 2]);
    const none = toggleIsolateTag({ ...meshLayer(), ...one } as MeshLayer, 2);
    expect(none.isolate).toBeUndefined();
  });

  it('centres the sphere on the cursor', () => {
    const patch = setIsolateSphere(meshLayer(), [1, 2, 3], 10);
    expect(patch.isolate?.sphere).toEqual({ center: [1, 2, 3], radius: 10 });
  });

  it('orders the box corners whichever way they were dragged', () => {
    const patch = setIsolateBox(meshLayer(), [10, 10, 10], [-10, 0, 30]);
    expect(patch.isolate?.box).toEqual({ min: [-10, 0, 10], max: [10, 10, 30] });
  });

  it('clears one clause and keeps the others', () => {
    const layer = meshLayer({
      isolate: { combine: 'all', tags: [2], sphere: { center: [0, 0, 0], radius: 5 } },
    });
    const patch = clearIsolateClause(layer, 'sphere');
    expect(patch.isolate?.sphere).toBeUndefined();
    expect(patch.isolate?.tags).toEqual([2]);
    expect(clearIsolate(layer)).toEqual({ isolate: undefined });
  });

  it('knows an empty spec from a live one', () => {
    expect(isolateIsEmpty({ combine: 'all' })).toBe(true);
    expect(isolateIsEmpty({ combine: 'all', tags: [] })).toBe(true);
    expect(isolateIsEmpty({ combine: 'all', tags: [1] })).toBe(false);
  });
});

describe('glyphs', () => {
  it('defaults to the mesh’s vector field, and offers nothing when there is none', () => {
    const spec = defaultGlyphs(dataset());
    expect(spec?.field).toEqual({ source: 'elm', name: 'E' });
    expect(spec?.scale).toBe('byMagnitude');
    // `Thalamus_TI.msh` carries `TI_max` alone: ncomp 1, so no glyphs.
    const scalarOnly = dataset({ fields: [dataset().fields[0] as MeshDataset['fields'][number]] });
    expect(defaultGlyphs(scalarOnly)).toBeNull();
  });

  it('rounds the stride to a whole number of elements and never below one', () => {
    const layer = meshLayer({ glyphs: defaultGlyphs(dataset()) ?? undefined });
    expect(setGlyphStride(layer, 0).glyphs?.subsample).toEqual({ everyNth: 1 });
    expect(setGlyphStride(layer, 12.7).glyphs?.subsample).toEqual({ everyNth: 13 });
    expect(disableGlyphs(layer)).toEqual({ glyphs: undefined });
  });

  it('reads an absent `origins` as §4.4’s default rather than as an empty selector value', () => {
    const spec = defaultGlyphs(dataset())!;
    expect(spec.origins).toBeUndefined();
    expect(glyphOrigins(spec)).toBe('surface');
    expect(glyphOrigins({ ...spec, origins: 'volume' })).toBe('volume');
  });

  it('offers `volume` only where §6.5.2 has tets to take centroids of', () => {
    expect(glyphOriginsAvailable(dataset())).toBe(true);
    // A `.gii` surface, or any triangle-only mesh: `meshCentroids` would return nothing.
    expect(glyphOriginsAvailable(dataset({ nTets: 0 }))).toBe(false);
  });

  it('refuses to write `volume` on a tet-less mesh — a state whose only rendering is nothing', () => {
    const layer = meshLayer({ glyphs: defaultGlyphs(dataset()) ?? undefined });
    expect(setGlyphOrigins(dataset(), layer, 'volume').glyphs?.origins).toBe('volume');
    expect(setGlyphOrigins(dataset(), layer, 'surface').glyphs?.origins).toBe('surface');
    expect(setGlyphOrigins(dataset({ nTets: 0 }), layer, 'volume')).toEqual({});
    // Going back to the surface is always allowed, tets or not.
    expect(setGlyphOrigins(dataset({ nTets: 0 }), layer, 'surface').glyphs?.origins).toBe(
      'surface'
    );
  });
});

describe('the three §7.4 async switches', () => {
  it('recognises the first edges toggle, the first element field and the first label mode', () => {
    const layer = meshLayer();
    expect(asyncSwitchFor(layer, setEdges(layer, { surface: true }))).toBe('edges');
    expect(asyncSwitchFor(layer, selectField(dataset(), layer, 'elm:TI_max'))).toBe('elmField');
    expect(asyncSwitchFor(layer, { colorMode: 'label' })).toBe('label');
  });

  it('does not re-trigger once the variant is built — §7.4: "free thereafter"', () => {
    const withEdges = meshLayer({ edges: { surface: true, caps: false } });
    expect(asyncSwitchFor(withEdges, setEdges(withEdges, { caps: true }))).toBeNull();
    const withElm = meshLayer({ field: { source: 'elm', name: 'TI_max', component: 'mag' } });
    expect(asyncSwitchFor(withElm, selectField(dataset(), withElm, 'elm:E'))).toBeNull();
  });
});
