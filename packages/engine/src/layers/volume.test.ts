/**
 * The label palette — R5's mute/recolour half, with no GL in sight.
 *
 * §7.3 makes the palette the *only* place `visibleLabels`, `labelOpacity` and a recolour are
 * expressed: the shader reads one `N × 1 RGBA8` texel and branches on nothing. That is what makes
 * R5's gate assertion ("hiding a label leaves every other pixel byte-identical") true by
 * construction, and it is what these tests check — that hiding label *k* changes texel *k*'s four
 * bytes and no others.
 *
 * The dense-index remap is the other thing under test. `palette[k]` is the colour of `ids[k]`, with
 * **no offset**; an off-by-one paints every region with its neighbour's colour, which looks
 * plausible and is wrong, so the ids here are deliberately sparse (0, 1, 5, 530 — the shape of a
 * real SimNIBS LUT) and never equal to their own index.
 */

import { describe, expect, it } from 'vitest';
import { buildLabelAttrs, buildLabelPalette, fallbackLabelColor } from './volume';
import type { LabelEntry, Stats, vec4, VolumeDataset } from '../scene/types';

/** Sparse ids, exactly as SimNIBS and FreeSurfer write them: 530 in a 4-label atlas. */
const IDS = Uint32Array.from([0, 1, 5, 530]);

const COLORS: Record<number, vec4> = {
  0: [0, 0, 0, 0],
  1: [230 / 255, 230 / 255, 210 / 255, 1],
  5: [255 / 255, 239 / 255, 179 / 255, 1],
  530: [20 / 255, 180 / 255, 90 / 255, 1],
};

const EMPTY_STATS: Stats = {
  min: 0,
  max: 530,
  mean: 0,
  percentiles: {
    '0.1': 0,
    '1': 0,
    '2': 0,
    '5': 0,
    '50': 1,
    '95': 5,
    '98': 530,
    '99': 530,
    '99.9': 530,
  },
  histogram: new Uint32Array(256),
  histogramLo: 0,
  histogramHi: 530,
};

function labelDataset(): VolumeDataset {
  const entries: LabelEntry[] = [...IDS].map((id) => ({
    id,
    name: `L${id}`,
    color: [...(COLORS[id] ?? [0, 0, 0, 1])] as vec4,
  }));
  return {
    kind: 'volume',
    id: 'ds1',
    name: 'atlas',
    dims: [2, 2, 2],
    nvols: 1,
    affine: new Float32Array(16),
    inverseAffine: new Float32Array(16),
    spacing: [1, 1, 1],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    dtype: 'u16',
    data: new Uint16Array(8),
    sclSlope: 1,
    sclInter: 0,
    isLabel: true,
    labelIds: IDS,
    labelTable: { entries, byId: new Map(entries.map((e) => [e.id, e])) },
    stats: EMPTY_STATS,
    gpu: { format: 'R8UI', scale: 1, offset: 0, filterable: false, chunked: false },
    headerJson: '{}',
    worker: { id: 1 },
    handle: 1,
  };
}

/** The four bytes of dense index `k`. */
function texel(p: Uint8Array, k: number): number[] {
  return [...p.slice(k * 4, k * 4 + 4)];
}

describe('buildLabelPalette — the dense index remap', () => {
  it('palette[k] is the colour of ids[k], with no offset', () => {
    const ds = labelDataset();
    const p = buildLabelPalette(ds, IDS);
    expect(p).not.toBeNull();
    expect(p!.length).toBe(IDS.length * 4);
    expect(texel(p!, 0)).toEqual([0, 0, 0, 0]);
    expect(texel(p!, 1)).toEqual([230, 230, 210, 255]);
    expect(texel(p!, 2)).toEqual([255, 239, 179, 255]);
    // Dense index 3 is id 530 — not index 530, and not the third colour of anything else.
    expect(texel(p!, 3)).toEqual([20, 180, 90, 255]);
  });

  it('is null for a non-label volume, which is what says "no palette texture"', () => {
    const ds = { ...labelDataset(), isLabel: false };
    expect(buildLabelPalette(ds, IDS)).toBeNull();
    expect(buildLabelPalette(labelDataset(), undefined)).toBeNull();
  });

  it('falls back to a deterministic palette for an id the LUT does not name', () => {
    const ds = labelDataset();
    ds.labelTable = undefined;
    const p = buildLabelPalette(ds, IDS)!;
    // Id 0 with no table at all is the one convention the engine imposes: background.
    expect(texel(p, 0)).toEqual([0, 0, 0, 0]);
    for (const k of [1, 2, 3]) {
      const c = fallbackLabelColor(k);
      expect(texel(p, k)).toEqual([
        Math.round(c[0] * 255),
        Math.round(c[1] * 255),
        Math.round(c[2] * 255),
        255,
      ]);
    }
    // Deterministic: no clock, no RNG, so a golden captured today matches one captured tomorrow.
    expect(fallbackLabelColor(7)).toEqual(fallbackLabelColor(7));
  });
});

describe('R5 — hide, mute, recolour', () => {
  it('hiding a label zeroes exactly its texel and leaves every other byte identical', () => {
    const ds = labelDataset();
    const all = buildLabelPalette(ds, IDS)!;
    // `visibleLabels` names the ids that stay; 5 is dropped, which is dense index 2.
    const hidden = buildLabelPalette(ds, IDS, {
      visibleLabels: Uint32Array.from([0, 1, 530]),
    })!;
    expect(texel(hidden, 2)).toEqual([255, 239, 179, 0]);
    for (const k of [0, 1, 3]) expect(texel(hidden, k), `texel ${k}`).toEqual(texel(all, k));
    // Only the alpha byte moved: the RGB is kept so unhiding restores the colour without a lookup.
    expect(hidden.length).toBe(all.length);
    let differing = 0;
    for (let i = 0; i < all.length; i += 1) if (all[i] !== hidden[i]) differing += 1;
    expect(differing).toBe(1);
  });

  it('labelOpacity scales that label’s alpha and nothing else’s', () => {
    const ds = labelDataset();
    const all = buildLabelPalette(ds, IDS)!;
    const muted = buildLabelPalette(ds, IDS, { labelOpacity: { 530: 0.25 } })!;
    expect(texel(muted, 3)).toEqual([20, 180, 90, Math.round(255 * 0.25)]);
    for (const k of [0, 1, 2]) expect(texel(muted, k)).toEqual(texel(all, k));
  });

  it('hidden beats muted: a label named out of `visibleLabels` is gone whatever its opacity', () => {
    const ds = labelDataset();
    const p = buildLabelPalette(ds, IDS, {
      visibleLabels: Uint32Array.from([1]),
      labelOpacity: { 5: 1 },
    })!;
    expect(texel(p, 2)[3]).toBe(0);
    expect(texel(p, 1)[3]).toBe(255);
  });

  it('`labelColors` repaints exactly that label and leaves the atlas table alone', () => {
    const ds = labelDataset();
    const before = buildLabelPalette(ds, IDS)!;
    const after = buildLabelPalette(ds, IDS, { labelColors: { 5: [1, 0, 0, 1] } })!;
    expect(texel(after, 2)).toEqual([255, 0, 0, 255]);
    for (const k of [0, 1, 3]) expect(texel(after, k)).toEqual(texel(before, k));
    // The file's own colour is still there underneath, which is what makes a per-row Reset possible
    // and what §4.6 relies on (a `LabelTable` is re-derived on load; the layer is what round-trips).
    expect(ds.labelTable?.byId.get(5)?.color).not.toEqual([1, 0, 0, 1]);
    expect(buildLabelPalette(ds, IDS)!).toEqual(before);
  });

  it('an override for an id this frame has no dense index for changes nothing', () => {
    const ds = labelDataset();
    const before = buildLabelPalette(ds, IDS)!;
    expect(buildLabelPalette(ds, IDS, { labelColors: { 999: [1, 0, 0, 1] } })!).toEqual(before);
  });

  it('an override beats the fallback colour of a label the LUT does not name', () => {
    const ds = labelDataset();
    const named = buildLabelPalette(ds, IDS, { labelColors: { 530: [0, 0, 1, 1] } })!;
    expect(texel(named, 3)).toEqual([0, 0, 255, 255]);
  });

  it('the selection table marks the selected dense indices and only those', () => {
    expect([...buildLabelAttrs(IDS, Uint32Array.from([]))]).toEqual(new Array(16).fill(0));
    const attrs = buildLabelAttrs(IDS, Uint32Array.from([530, 1]));
    expect([...attrs.filter((_, i) => i % 4 === 0)]).toEqual([0, 255, 0, 255]);
    // Ids, not dense indices: selecting "2" selects nothing, because this atlas has no label 2.
    expect([...buildLabelAttrs(IDS, Uint32Array.from([2])).filter((_, i) => i % 4 === 0)]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});
