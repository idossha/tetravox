/**
 * `.msh.opt` seeding (§7.6) and the one fit formula three call sites share (§7.5's `r`, R2's readout).
 *
 * The `.msh.opt` blocks below are the shape SimNIBS actually writes — `RangeType = 2` with a
 * `CustomMin` / `CustomMax` pair, `ColormapNumber = 2`, `ShowScale = 1` `[DATA]`, transcribed from
 * `testdata/mesh_v2_binary.msh.opt` and from `m2m_ernie/ernie.msh.opt`.
 */

import { describe, expect, it } from 'vitest';
import {
  MSH_OPT_COLORMAPS,
  defaultLayerFor,
  defaultMeshLayer,
  seedMeshLayerFromOpt,
} from './defaults';
import { fitMmPerPx } from '../view/geometry';
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

  it('seeds tag colours and visibility into `tagStyle`', () => {
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
    // An 8 mm fixture in a 384 px pane wants 0.022 mm/px; [0.05, 20] is the clamp.
    expect(fitMmPerPx(bounds(4), 384)).toBe(0.05);
    expect(fitMmPerPx({ min: [0, 0, 0], max: [0, 0, 0] }, 512)).toBe(0.05);
  });

  it('treats a zero-pixel pane as one pixel rather than dividing by zero', () => {
    expect(Number.isFinite(fitMmPerPx(bounds(100), 0))).toBe(true);
  });
});
