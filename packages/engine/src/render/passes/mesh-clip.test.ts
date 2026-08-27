/**
 * §7.4's clip planes and caps, as arithmetic — the half of the feature that has an answer before a
 * GL context exists.
 *
 * Everything here is checked against the contract's own words rather than against a previous run:
 * the plane list the cap rule indexes, the `vec4` packing the shader reads, the sort key §7.2 names
 * for a translucent cap, the variant a frame compiles, and the cap normal §7.4 calls "the (negated)
 * clip-plane normal". The pixel half lives in `test/e2e/mesh-clip.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  activeClipPlanes,
  capDepth,
  capDraws,
  capVariantOf,
  clipVariant,
  effectiveCapColorSource,
  packClipPlanes,
  variantOf,
} from './mesh';
import type { CapGeometry, SurfaceGeometry } from '../gpu';
import { MESH_COLOR_SOURCE } from '../../shaders';
import { defaultLayerFor } from '../../scene/defaults';
import type { Aabb, MeshDataset, MeshLayer, Plane, vec3 } from '../../scene/types';

const BOUNDS: Aabb = { min: [-10, -10, -10], max: [10, 10, 10] };

function meshDataset(): MeshDataset {
  return {
    kind: 'mesh',
    id: 'ds1',
    name: 'lattice',
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    appliedTransform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    bounds: BOUNDS,
    nNodes: 27,
    nTris: 56,
    nTets: 48,
    hasTris: true,
    fields: [],
    tags: [
      {
        id: 1,
        kind: 'tet',
        name: 'Tissue_A',
        color: [230 / 255, 230 / 255, 210 / 255, 1],
        count: 24,
      },
      {
        id: 2,
        kind: 'tet',
        name: 'Tissue_B',
        color: [129 / 255, 129 / 255, 129 / 255, 1],
        count: 24,
      },
      { id: 1001, kind: 'tri', name: 'A_surface', color: [104 / 255, 163 / 255, 1, 1], count: 24 },
    ],
    skipped: [],
    orient: { openComponents: 0, flippedTags: [], signedVolumes: [] },
    topologyBuilt: false,
    worker: { id: 'w1' },
    handle: 1,
  } as unknown as MeshDataset;
}

function meshLayer(patch: Partial<MeshLayer> = {}): MeshLayer {
  const base = defaultLayerFor('l1', meshDataset()) as MeshLayer;
  return { ...base, ...patch };
}

/** `p` with an `enabled` flag, in the shape `MeshLayer.clip.planes` wants. */
function clipped(...planes: { plane: Plane; enabled: boolean }[]): MeshLayer['clip'] {
  return { planes, caps: true, capColorMode: 'inherit' };
}

const PX: Plane = { normal: [1, 0, 0], offset: 0 };
const PY: Plane = { normal: [0, 1, 0], offset: -2 };
const PZ: Plane = { normal: [0, 0, 1], offset: 3 };

describe('activeClipPlanes', () => {
  it('keeps only the enabled planes, in order — the index the cap rule exempts', () => {
    const layer = meshLayer({
      clip: clipped(
        { plane: PX, enabled: false },
        { plane: PY, enabled: true },
        { plane: PZ, enabled: true }
      ),
    });
    const planes = activeClipPlanes(layer);
    expect(planes.length).toBe(2);
    // Plane 0 of the *active* list is PY, not PX: the cap rule, the CLIP_DISTANCE enable set and
    // `CapPlaneRange.plane` all index this list, and only this list.
    expect(planes[0]).toBe(PY);
    expect(planes[1]).toBe(PZ);
  });

  it('caps the list at §7.4’s six, and returns one shared empty array for none', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({
      plane: { normal: [1, 0, 0] as vec3, offset: i },
      enabled: true,
    }));
    expect(activeClipPlanes(meshLayer({ clip: clipped(...seven) })).length).toBe(6);
    // No allocation for the overwhelmingly common case (§7.1: no per-frame allocations).
    const a = activeClipPlanes(meshLayer());
    const b = activeClipPlanes(meshLayer({ clip: clipped({ plane: PX, enabled: false }) }));
    expect(a.length).toBe(0);
    expect(a).toBe(b);
  });
});

describe('packClipPlanes', () => {
  it('is §6.0’s Plane verbatim: xyz = normal, w = offset, with no negation', () => {
    const packed = packClipPlanes([PY, PZ]);
    expect([...packed]).toEqual([0, 1, 0, -2, 0, 0, 1, 3]);
    // The shader keeps `dot(n, p) + w >= 0`. Applying that here to a point 1 mm inside PY's kept
    // half-space must be positive, and 1 mm outside negative — the sign convention §11 pins.
    const inside = 0 * 0 + 1 * 3 + 0 * 0 + -2;
    const outside = 0 * 0 + 1 * 1 + 0 * 0 + -2;
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeLessThan(0);
  });
});

describe('clipVariant', () => {
  it('compiles N = the active plane count, and the hardware path only when the cap is granted', () => {
    const layer = meshLayer({ clip: clipped({ plane: PX, enabled: true }) });
    expect(clipVariant(layer, { clipDistance: true })).toEqual({
      TVX_CLIP_PLANES: 1,
      TVX_CLIP_DISCARD: 0,
    });
    // §11's clip-path axis and a driver without `WEBGL_clip_cull_distance` produce the SAME program.
    expect(clipVariant(layer, { clipDistance: true, forceDiscardClip: true })).toEqual(
      clipVariant(layer, { clipDistance: false })
    );
    expect(clipVariant(layer, { clipDistance: false })).toEqual({
      TVX_CLIP_PLANES: 1,
      TVX_CLIP_DISCARD: 1,
    });
  });

  it('at N = 0 emits neither path, so the variant is Phase 1’s program', () => {
    // §7.4: "At N = 0: no #extension, no redeclaration." Both defines are 0 whatever the capability.
    expect(clipVariant(meshLayer(), { clipDistance: false })).toEqual({
      TVX_CLIP_PLANES: 0,
      TVX_CLIP_DISCARD: 0,
    });
  });
});

/** A surface geometry with nothing optional present — enough for `variantOf`. */
const BARE_GEOM = {
  hasNodeIndex: false,
  ownerTexture: null,
  edgeMaskTexture: null,
  perTag: [],
  tagBounds: null,
} as unknown as SurfaceGeometry;

describe('variantOf', () => {
  it('carries the clip keys onto a surface draw and never marks it a cap', () => {
    const layer = meshLayer({ clip: clipped({ plane: PX, enabled: true }) });
    const v = variantOf(
      {
        item: { kind: 'mesh', layer, ds: meshDataset(), geom: BARE_GEOM },
        tag: 1,
        first: 0,
        count: 3,
        color: [1, 1, 1, 1],
        alpha: 1,
        bounds: BOUNDS,
        emphasised: false,
      },
      { clipDistance: true }
    );
    expect(v.TVX_CLIP_PLANES).toBe(1);
    expect(v.TVX_CAP).toBe(0);
  });
});

describe('effectiveCapColorSource', () => {
  const ds = meshDataset();
  const layer = meshLayer();
  const palette = { texture: {} as WebGLTexture, width: 2, size: 2 };

  it('falls back to the uniform colour until the table it needs has landed', () => {
    // §7.4 calls these "async loads with a progress state, not instant checkboxes": a cap with no
    // palette yet draws in the solid colour rather than in a half-applied one.
    expect(
      effectiveCapColorSource({
        kind: 'mesh',
        layer,
        ds,
        geom: BARE_GEOM,
        style: { colorSource: 0, emphasisTags: [], labelEmphasis: false, capColorSource: 4 },
      })
    ).toBe(MESH_COLOR_SOURCE.uniform);
    expect(
      effectiveCapColorSource({
        kind: 'mesh',
        layer,
        ds,
        geom: BARE_GEOM,
        style: {
          colorSource: 0,
          emphasisTags: [],
          labelEmphasis: false,
          capColorSource: 4,
          capPalette: palette,
        },
      })
    ).toBe(MESH_COLOR_SOURCE.capTag);
  });

  it('needs only the field table for a node field — a cut vertex carries its own interpolation', () => {
    // The surface path additionally needs `geom.hasNodeIndex`; a cap does not, because §6.5.1 puts
    // `interpNodes` / `interpT` on every cut vertex.
    expect(
      effectiveCapColorSource({
        kind: 'mesh',
        layer,
        ds,
        geom: BARE_GEOM,
        style: {
          colorSource: 1,
          emphasisTags: [],
          labelEmphasis: false,
          capColorSource: 1,
          fieldTable: { texture: {} as WebGLTexture, width: 4, size: 27 },
        },
      })
    ).toBe(MESH_COLOR_SOURCE.nodeField);
  });
});

describe('capDepth', () => {
  it('is the eye distance to the plane’s foot point under the bbox centre (§7.2’s sort key)', () => {
    // Centre (0,0,0); PZ keeps `z >= -3`, so its foot point under the centre is (0, 0, -3).
    // An eye at (0, 0, 7) is 10 mm from it.
    expect(capDepth(PZ, BOUNDS, [0, 0, 7])).toBeCloseTo(10, 6);
    // …and the far cap of a second plane sorts behind it, which is what back-to-front means here.
    expect(capDepth(PX, BOUNDS, [0, 0, 7])).toBeCloseTo(7, 6);
  });
});

describe('capDraws', () => {
  const ds = meshDataset();
  const geom = (ranges: { plane: number; firstVertex: number; vertexCount: number }[]) =>
    ({
      vao: {} as never,
      vertexCount: 12,
      triangleCount: 4,
      planeRanges: ranges,
      generation: 1,
      hasFields: true,
      bytes: 0,
    }) as CapGeometry;

  it('emits one draw per plane that produced geometry, with the negated plane normal', () => {
    const layer = meshLayer({
      clip: clipped({ plane: PY, enabled: true }, { plane: PZ, enabled: true }),
      opacity: 0.5,
    });
    const draws = capDraws(
      {
        kind: 'mesh',
        layer,
        ds,
        geom: BARE_GEOM,
        caps: geom([
          { plane: 0, firstVertex: 0, vertexCount: 6 },
          { plane: 1, firstVertex: 6, vertexCount: 6 },
        ]),
      },
      [0, 0, 7]
    );
    expect(draws.map((d) => d.plane)).toEqual([0, 1]);
    // §7.4: "Cap normals are the (negated) clip-plane normal." The kept half is `dot(n,x)+d >= 0`,
    // so the face the viewer looks into points along −n.
    expect(draws[0]!.normal).toEqual([-0, -1, -0]);
    expect(draws[1]!.normal).toEqual([-0, -0, -1]);
    // §7.2: "cut caps are drawn … with that layer's opacity".
    expect(draws[0]!.alpha).toBe(0.5);
  });

  it('skips an empty range and drops a cap whose plane no longer exists', () => {
    const layer = meshLayer({ clip: clipped({ plane: PY, enabled: true }) });
    expect(
      capDraws(
        {
          kind: 'mesh',
          layer,
          ds,
          geom: BARE_GEOM,
          caps: geom([
            { plane: 0, firstVertex: 0, vertexCount: 0 },
            // A stale range from a two-plane cut, after one plane was removed.
            { plane: 1, firstVertex: 0, vertexCount: 6 },
          ]),
        },
        [0, 0, 7]
      )
    ).toEqual([]);
  });

  it('draws nothing when `clip.caps` is off, even with a cut in hand', () => {
    const layer = meshLayer({
      clip: { planes: [{ plane: PY, enabled: true }], caps: false, capColorMode: 'inherit' },
    });
    expect(
      capDraws(
        {
          kind: 'mesh',
          layer,
          ds,
          geom: BARE_GEOM,
          caps: geom([{ plane: 0, firstVertex: 0, vertexCount: 6 }]),
        },
        [0, 0, 7]
      )
    ).toEqual([]);
  });
});

describe('capVariantOf', () => {
  it('is a cap, never flat-shaded, and masked exactly when the layer draws cap edges', () => {
    const layer = meshLayer({
      clip: clipped({ plane: PY, enabled: true }),
      edges: { surface: true, caps: true },
      flatShading: true,
    });
    const v = capVariantOf(
      {
        item: { kind: 'mesh', layer, ds: meshDataset(), geom: BARE_GEOM },
        geom: {} as CapGeometry,
        plane: 0,
        normal: [0, -1, 0],
        first: 0,
        count: 3,
        alpha: 1,
        depth: 1,
      },
      { clipDistance: true }
    );
    expect(v.TVX_CAP).toBe(1);
    // A cap is planar and its normal is a uniform, so derivatives would cost more for the same
    // vector. Flat shading is a property of the surface draw.
    expect(v.TVX_FLAT_SHADING).toBe(0);
    // `Cut.edge_mask` always exists, so cap edges are always the masked variant — that is what
    // suppresses the 2-2 split's invented diagonal.
    expect(v.TVX_EDGES).toBe(1);
    expect(v.TVX_EDGE_MASK).toBe(1);
    expect(v.TVX_CLIP_PLANES).toBe(1);
  });
});
