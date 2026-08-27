/**
 * The tag LUT — the table R4's "the pixel equals the tag colour" is decided by.
 *
 * §4.1 requires the wire `[u8;4]` of `MeshMeta.tags[].color` to round-trip **exactly** through the
 * engine's 0..1 form, and this is where the return trip happens. The colours below are ernie's, from
 * `m2m_ernie/ernie.msh.opt` via §6.2's carousel rule (`Mesh.Color.One` → tag 1, and a `1xxx` surface
 * tag inherits `1xxx − 1000`) — so a byte that changes here is a tissue that renders the wrong
 * colour in every pane.
 */

import { describe, expect, it } from 'vitest';
import { buildTagLut } from './tag-lut';
import type { MeshDataset, MeshLayer, vec4 } from '../scene/types';

const wire = (r: number, g: number, b: number): vec4 => [r / 255, g / 255, b / 255, 1];

/** ernie's tissue colours, from `ernie.msh.opt` (`Mesh.Color.{One,Two,Three,Five}`). */
const WM = wire(230, 230, 230);
const GM = wire(129, 129, 129);
const CSF = wire(104, 163, 255);
const SCALP = wire(255, 166, 133);

function dataset(): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds1',
    name: 'ernie.msh',
    transform: new Float32Array(16),
    appliedTransform: new Float32Array(16),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    nNodes: 0,
    nTris: 0,
    nTets: 0,
    hasTris: true,
    fields: [],
    tags: [
      { id: 1, name: 'WM', color: WM, kind: 'tet', count: 1 },
      { id: 2, name: 'GM', color: GM, kind: 'tet', count: 1 },
      { id: 3, name: 'CSF', color: CSF, kind: 'tet', count: 1 },
      { id: 5, name: 'Scalp', color: SCALP, kind: 'tet', count: 1 },
    ],
    skipped: [],
    orient: { components: 1, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
    topologyBuilt: false,
    worker: { id: 1 },
    handle: 1,
  };
}

function layer(over: Partial<MeshLayer> = {}): MeshLayer {
  return {
    id: 'l1',
    datasetId: 'ds1',
    name: 'ernie',
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: false,
    kind: 'mesh',
    colorMode: 'tag',
    solidColor: [0, 0, 0, 1],
    colormap: 'viridis',
    scale: { kind: 'linear', lo: 0, hi: 1 },
    threshold: { lo: -Infinity, hi: Infinity, symmetric: false, mode: 'clamp', softEdge: 0 },
    tagStyle: {
      1: { visible: true, opacity: 1 },
      2: { visible: true, opacity: 1 },
      3: { visible: true, opacity: 1 },
      5: { visible: true, opacity: 1 },
    },
    edges: { surface: false, caps: false },
    edgeColor: [0, 0, 0, 1],
    edgeWidthPx: 1,
    flatShading: false,
    faceMode: 'both',
    clip: { planes: [], caps: true, capColorMode: 'inherit' },
    contoursIn2D: true,
    contourWidthPx: 1,
    fillIn2D: true,
    ...over,
  };
}

const at = (lut: Uint8Array, tag: number): number[] => [...lut.subarray(tag * 4, tag * 4 + 4)];

describe('buildTagLut', () => {
  it('writes the wire bytes back exactly, indexed by the raw tag', () => {
    const { rgba, count } = buildTagLut(layer(), dataset());
    expect(count).toBe(6); // maxTag 5 + 1 — sized by the tags present, not by a fixed 256
    expect(at(rgba, 1)).toEqual([230, 230, 230, 255]);
    expect(at(rgba, 2)).toEqual([129, 129, 129, 255]);
    expect(at(rgba, 3)).toEqual([104, 163, 255, 255]);
    expect(at(rgba, 5)).toEqual([255, 166, 133, 255]);
  });

  it('leaves an absent tag at zero — tag 4 does not exist in ernie, and must not borrow a colour', () => {
    const { rgba } = buildTagLut(layer(), dataset());
    expect(at(rgba, 4)).toEqual([0, 0, 0, 0]);
  });

  it('hides a tag by writing alpha 0, which the shader discards on (R5)', () => {
    const l = layer({
      tagStyle: { ...layer().tagStyle, 5: { visible: false, opacity: 1 } },
    });
    const { rgba } = buildTagLut(l, dataset());
    expect(at(rgba, 5)).toEqual([255, 166, 133, 0]);
    // Everything else is untouched: R5's "others are unchanged", at the source.
    expect(at(rgba, 2)).toEqual([129, 129, 129, 255]);
  });

  it('carries per-tag opacity in alpha, rounded to the byte the blend uses', () => {
    const l = layer({ tagStyle: { ...layer().tagStyle, 2: { visible: true, opacity: 0.5 } } });
    const { rgba } = buildTagLut(l, dataset());
    expect(at(rgba, 2)).toEqual([129, 129, 129, 128]);
  });

  it('takes the layer’s per-tag colour override ahead of the dataset’s (R5 recolour)', () => {
    const l = layer({
      tagStyle: { ...layer().tagStyle, 3: { visible: true, opacity: 1, color: wire(10, 20, 30) } },
    });
    const { rgba } = buildTagLut(l, dataset());
    expect(at(rgba, 3)).toEqual([10, 20, 30, 255]);
  });

  it('keys on the bytes, so an unrelated layer edit does not re-upload the texture', () => {
    const a = buildTagLut(layer(), dataset());
    const b = buildTagLut(layer({ opacity: 0.3 }), dataset());
    expect(b.key).toBe(a.key);
    const c = buildTagLut(
      layer({ tagStyle: { ...layer().tagStyle, 1: { visible: false, opacity: 1 } } }),
      dataset()
    );
    expect(c.key).not.toBe(a.key);
  });
});
