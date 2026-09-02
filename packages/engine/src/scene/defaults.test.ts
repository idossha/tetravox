/**
 * `.msh.opt` seeding (§7.6) and the one fit formula three call sites share (§7.5's `r`, R2's readout).
 *
 * The `.msh.opt` blocks below are the shape SimNIBS actually writes — `RangeType = 2` with a
 * `CustomMin` / `CustomMax` pair, `ColormapNumber = 2`, `ShowScale = 1` `[DATA]`, transcribed from
 * `testdata/mesh_v2_binary.msh.opt` and from `m2m_ernie/ernie.msh.opt`.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SURFACE_CONTOUR_WIDTH_PX,
  MSH_OPT_COLORMAPS,
  SURFACE_CONTOUR_PALETTE,
  defaultLayerFor,
  defaultMeshLayer,
  isSurfaceMesh,
  seedMeshLayerFromOpt,
  surfaceContourColor,
} from './defaults';
import { fitMmPerPx } from '../view/geometry';
import { remapLayer, serializableLayer } from './serialize';
import type { Aabb, MeshDataset, MeshLayer, MshOptions } from './types';

function meshDataset(opt?: MshOptions): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds1',
    name: 'ernie.msh',
    tags: [
      { id: 1, name: 'WM', color: [0.9, 0.9, 0.82, 1], kind: 'tet', count: 4 },
      { id: 2, name: 'GM', color: [0.5, 0.5, 0.5, 1], kind: 'tet', count: 8 },
    ],
    orient: { components: 1, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
    opt,
  } as unknown as MeshDataset;
}

/** `View[0]` as SimNIBS writes it. */
const SIMNIBS_VIEW: MshOptions['views'][number] = {
  customMin: -1.5,
  customMax: 3.5,
  rangeType: 2,
  saturateValues: true,
  colormapNumber: 2,
  showScale: true,
  vectorType: 1,
};

describe('seedMeshLayerFromOpt (§7.6)', () => {
  it('does nothing at all without a sidecar — which is every Phase-1 golden', () => {
    const ds = meshDataset();
    const layer = defaultMeshLayer('layer1', ds);
    const out = seedMeshLayerFromOpt(layer, ds);
    expect(out.layer).toBe(layer);
    expect(out.seed).toBeNull();
  });

  it('seeds tag visibility, and a colour the dataset’s own tag does not already carry', () => {
    const ds = meshDataset({
      tagColor: { 1: [0.1, 0.2, 0.3, 1], 2: [0.4, 0.5, 0.6, 1] },
      tagVisible: { 1: false, 2: true },
      views: [],
    });
    const { layer, seed } = seedMeshLayerFromOpt(defaultMeshLayer('layer1', ds), ds);
    expect(layer.tagStyle[1]).toEqual({ visible: false, opacity: 1, color: [0.1, 0.2, 0.3, 1] });
    expect(layer.tagStyle[2]).toEqual({ visible: true, opacity: 1, color: [0.4, 0.5, 0.6, 1] });
    expect(seed?.seeded).toContain('tagStyle.color');
    expect(seed?.seeded).toContain('tagStyle.visible');
    // §7.6's chip: "defaults from X.msh.opt".
    expect(seed?.file).toBe('ernie.msh.opt');
  });

  it('does NOT copy a colour §6.2’s ladder already put on the dataset’s tag', () => {
    // Every real open: the sidecar reached the loader, so `MeshTag.color` is the `.msh.opt` colour.
    // Writing it into `tagStyle` too would occupy the slot R5 keeps for the *user's* edit, and
    // A-PROPS's per-row Reset and its "recoloured" marker could no longer tell one from the other.
    const ds = meshDataset({
      tagColor: { 1: [0.9, 0.9, 0.82, 1], 2: [0.4, 0.5, 0.6, 1] },
      tagVisible: { 1: false, 2: true },
      views: [],
    });
    const { layer, seed } = seedMeshLayerFromOpt(defaultMeshLayer('layer1', ds), ds);
    // Tag 1's sidecar colour is exactly `MeshTag.color`, so nothing is seeded for it…
    expect(layer.tagStyle[1]).toEqual({ visible: false, opacity: 1 });
    // …while tag 2's differs and still is.
    expect(layer.tagStyle[2]).toEqual({ visible: true, opacity: 1, color: [0.4, 0.5, 0.6, 1] });
    expect(seed?.seeded).toContain('tagStyle.color');
    expect(seed?.seeded).toContain('tagStyle.visible');
  });

  it('seeds no colour at all when every tag already carries its own', () => {
    const ds = meshDataset({
      tagColor: { 1: [0.9, 0.9, 0.82, 1], 2: [0.5, 0.5, 0.5, 1] },
      tagVisible: { 1: false },
      views: [],
    });
    const { layer, seed } = seedMeshLayerFromOpt(defaultMeshLayer('layer1', ds), ds);
    expect(layer.tagStyle[1]?.color).toBeUndefined();
    expect(layer.tagStyle[2]?.color).toBeUndefined();
    expect(seed?.seeded).not.toContain('tagStyle.color');
    expect(seed?.seeded).toContain('tagStyle.visible');
  });

  it('leaves a tag the sidecar does not name at the layer default', () => {
    const ds = meshDataset({ tagColor: { 1: [0.1, 0.2, 0.3, 1] }, tagVisible: {}, views: [] });
    const { layer } = seedMeshLayerFromOpt(defaultMeshLayer('layer1', ds), ds);
    expect(layer.tagStyle[2]).toEqual({ visible: true, opacity: 1 });
    expect(layer.tagStyle[2]?.color).toBeUndefined();
  });

  it('seeds the field range, the colormap and the colour bar from `View[0]`', () => {
    const ds = meshDataset({ tagColor: {}, tagVisible: {}, views: [SIMNIBS_VIEW] });
    const { layer, seed } = seedMeshLayerFromOpt(defaultMeshLayer('layer1', ds), ds);
    expect(layer.scale).toEqual({ kind: 'linear', lo: -1.5, hi: 3.5 });
    expect(layer.colormap).toBe('jet');
    expect(layer.showColorbar).toBe(true);
    expect(seed?.seeded).toEqual(expect.arrayContaining(['scale', 'colormap', 'showColorbar']));
  });

  it('ignores CustomMin/CustomMax unless RangeType says they are custom', () => {
    // With `RangeType = 1` (Gmsh's default) the pair is whatever the last save left behind, and
    // adopting it would window a field to numbers nobody chose.
    const ds = meshDataset({
      tagColor: {},
      tagVisible: {},
      views: [{ ...SIMNIBS_VIEW, rangeType: 1 }],
    });
    const base = defaultMeshLayer('layer1', ds);
    const { layer } = seedMeshLayerFromOpt(base, ds);
    expect(layer.scale).toEqual(base.scale);
  });

  it('ignores an inverted or empty custom range', () => {
    const ds = meshDataset({
      tagColor: {},
      tagVisible: {},
      views: [{ ...SIMNIBS_VIEW, customMin: 3.5, customMax: 3.5 }],
    });
    const base = defaultMeshLayer('layer1', ds);
    expect(seedMeshLayerFromOpt(base, ds).layer.scale).toEqual(base.scale);
  });

  it('leaves the colormap alone for a number the table does not claim', () => {
    // Guessing at Gmsh's colour-table numbering would paint a field in the wrong colours silently,
    // which is the one failure a viewer may not have.
    const ds = meshDataset({
      tagColor: {},
      tagVisible: {},
      views: [{ ...SIMNIBS_VIEW, colormapNumber: 11 }],
    });
    const base = defaultMeshLayer('layer1', ds);
    const { layer, seed } = seedMeshLayerFromOpt(base, ds);
    expect(layer.colormap).toBe(base.colormap);
    expect(seed?.seeded).not.toContain('colormap');
    expect(MSH_OPT_COLORMAPS[11]).toBeUndefined();
  });

  it('is what `defaultLayerFor` applies, so a mesh is seeded on open', () => {
    const ds = meshDataset({ tagColor: {}, tagVisible: {}, views: [SIMNIBS_VIEW] });
    const layer = defaultLayerFor('layer1', ds) as MeshLayer;
    expect(layer.kind).toBe('mesh');
    expect(layer.colormap).toBe('jet');
    expect(layer.showColorbar).toBe(true);
  });

  it('is idempotent — seeding an already-seeded layer changes nothing', () => {
    const ds = meshDataset({
      tagColor: { 1: [0.1, 0.2, 0.3, 1] },
      tagVisible: { 1: false },
      views: [SIMNIBS_VIEW],
    });
    const once = seedMeshLayerFromOpt(defaultMeshLayer('layer1', ds), ds).layer;
    const twice = seedMeshLayerFromOpt(once, ds).layer;
    expect(twice).toEqual(once);
  });
});

describe('fitMmPerPx (§7.5 `r`, and R2’s corner readout)', () => {
  const bounds = (half: number): Aabb => ({
    min: [-half, -half, -half],
    max: [half, half, half],
  });

  it('fits the bounding-box DIAGONAL, so an oblique cut is never clipped', () => {
    // A 200 mm cube's diagonal is 200·√3 = 346.4 mm; 0.62 of it over 512 px.
    const expected = (200 * Math.sqrt(3) * 0.62) / 512;
    expect(fitMmPerPx(bounds(100), 512)).toBeCloseTo(expected, 9);
  });

  it('is inversely proportional to the pane, so a pane twice as wide zooms in twice', () => {
    expect(fitMmPerPx(bounds(100), 256)).toBeCloseTo(fitMmPerPx(bounds(100), 512) * 2, 9);
  });

  it('never returns a value R2’s clamp would refuse', () => {
    // A 2 mm fixture in a 384 px pane wants 0.0056 mm/px; [0.01, 20] is the clamp.
    expect(fitMmPerPx(bounds(1), 384)).toBe(0.01);
    expect(fitMmPerPx({ min: [0, 0, 0], max: [0, 0, 0] }, 512)).toBe(0.01);
  });

  it('treats a zero-pixel pane as one pixel rather than dividing by zero', () => {
    expect(Number.isFinite(fitMmPerPx(bounds(100), 0))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// Directed task 12 — a surface opens as an outline, a tissue complex does not move
// ------------------------------------------------------------------------------------------------

/** A triangle-only mesh: `nTets === 0` is the whole of what makes a dataset a surface (§7.4). */
function surfaceDataset(name = 'lh.pial.gii'): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds2',
    name,
    nTets: 0,
    tags: [{ id: 1, name: 'surface', color: [0.8, 0.8, 0.8, 1], kind: 'tri', count: 18 }],
    orient: { components: 1, openComponents: 1, nonManifoldEdges: 0, flippedComponents: 0 },
  } as unknown as MeshDataset;
}

describe('surface contour defaults (§7.4, directed task 12)', () => {
  it('opens a surface as a 1.5 px yellow outline with no fill', () => {
    const layer = defaultMeshLayer('l1', surfaceDataset());
    expect(layer.contoursIn2D).toBe(true);
    expect(layer.contourWidthPx).toBe(DEFAULT_SURFACE_CONTOUR_WIDTH_PX);
    expect(layer.contourWidthPx).toBe(1.5);
    // `fillIn2D` is off because there is nothing to fill: `derived/store.ts` sends a tet-less mesh
    // to the `contours` op, which returns lines and no polygons.
    expect(layer.fillIn2D).toBe(false);
    // Freeview's pial yellow, and the first palette entry — the two are the same by construction.
    expect(layer.contourColor).toEqual(SURFACE_CONTOUR_PALETTE[0]);
    expect(layer.contourColor?.[0]).toBeGreaterThan(0.9);
    expect(layer.contourColor?.[2]).toBeLessThan(0.3);
  });

  it('leaves a tissue mesh exactly where R4 left it', () => {
    const layer = defaultMeshLayer('l1', meshDataset());
    expect(layer.contoursIn2D).toBe(true);
    expect(layer.contourWidthPx).toBe(1);
    expect(layer.fillIn2D).toBe(true);
    // No `contourColor`, so `render/passes/derived.ts` falls back to `edgeColor` as it always did.
    expect(layer.contourColor).toBeUndefined();
  });

  it('gives consecutive surfaces distinct colours, and wraps rather than running out', () => {
    const n = SURFACE_CONTOUR_PALETTE.length;
    const seen = new Set(Array.from({ length: n }, (_, i) => surfaceContourColor(i).join(',')));
    expect(seen.size).toBe(n);
    expect(surfaceContourColor(n)).toEqual(SURFACE_CONTOUR_PALETTE[0]);
    expect(surfaceContourColor(n + 2)).toEqual(SURFACE_CONTOUR_PALETTE[2]);
  });

  it('classifies by tet count, which is what the render path branches on', () => {
    expect(isSurfaceMesh(surfaceDataset())).toBe(true);
    expect(isSurfaceMesh({ ...meshDataset(), nTets: 12 } as MeshDataset)).toBe(false);
  });
});

describe('a surface layer round-trips its contour colour (§4.6)', () => {
  it('survives serialize → remap, because both are spread-based', () => {
    const layer = defaultMeshLayer('l1', surfaceDataset());
    const wire = serializableLayer({ ...layer, contourColor: [0.2, 0.4, 0.6, 1] });
    const back = remapLayer(wire, new Map([['ds2' as never, 'ds9' as never]]));
    expect((back as { contourColor?: number[] }).contourColor).toEqual([0.2, 0.4, 0.6, 1]);
  });
});
