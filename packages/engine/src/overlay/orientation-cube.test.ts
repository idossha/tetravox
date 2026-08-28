/**
 * §11 for the orientation cube's pure half: the basis, which faces are visible, where they project,
 * and what a click on one hits.
 *
 * Everything expected here is computed by hand from §3's world RAS (`+x` right, `+y` anterior, `+z`
 * superior) and from the rotation quaternions §7.5's presets are made of — never from the module.
 * The one import from elsewhere in the engine is `presetRotation`, and it is there deliberately: the
 * cube's contract is that **the face you see facing you is the preset you are in**, which is a claim
 * about those two functions agreeing and cannot be tested with one of them stubbed out.
 */

import { describe, expect, it } from 'vitest';
import { OverlayBuilder, overlayMetrics } from './builder';
import {
  CUBE_FACES,
  cameraBasis,
  cubeFaceAt,
  cubeFaces,
  cubeLayout,
  drawOrientationCube,
} from './orientation-cube';
import type { CubeFace } from './orientation-cube';
import { presetRotation } from '../view/geometry';
import type { quat } from '../scene/types';

const M = overlayMetrics(512, 512, 1);
const L = cubeLayout(M);

/** The `1..6` preset order, which is `CUBE_FACES`' order too (`view/geometry.ts`). */
const PRESETS: { index: number; face: CubeFace }[] = [
  { index: 1, face: 'A' },
  { index: 2, face: 'P' },
  { index: 3, face: 'L' },
  { index: 4, face: 'R' },
  { index: 5, face: 'S' },
  { index: 6, face: 'I' },
];

describe('cameraBasis', () => {
  it('the identity rotation is the world basis', () => {
    const b = cameraBasis([0, 0, 0, 1]);
    expect(b.right).toEqual([1, 0, 0]);
    expect(b.up).toEqual([0, 1, 0]);
    expect(b.back).toEqual([0, 0, 1]);
  });

  it('a −90° rotation about x puts the eye anterior — the `A` preset, by hand', () => {
    // q = (sin(−45°), 0, 0, cos(−45°)).
    const q: quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    const b = cameraBasis(q);
    expect(b.back[0]).toBeCloseTo(0, 12);
    expect(b.back[1]).toBeCloseTo(1, 12);
    expect(b.back[2]).toBeCloseTo(0, 12);
  });

  it('stays orthonormal for an arbitrary rotation', () => {
    const q: quat = [0.2, -0.4, 0.1, Math.sqrt(1 - 0.04 - 0.16 - 0.01)];
    const b = cameraBasis(q);
    for (const v of [b.right, b.up, b.back]) expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    const dot = (a: number[], c: number[]): number => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!;
    expect(dot(b.right, b.up)).toBeCloseTo(0, 12);
    expect(dot(b.right, b.back)).toBeCloseTo(0, 12);
    expect(dot(b.up, b.back)).toBeCloseTo(0, 12);
  });
});

describe('cubeFaces', () => {
  it('every preset shows its own letter, square to the camera and dead centre', () => {
    for (const { index, face } of PRESETS) {
      const faces = cubeFaces(L, presetRotation(index));
      // The other five faces are edge-on at a cardinal view, so exactly one survives.
      expect(faces.map((f) => f.face)).toEqual([face]);
      const front = faces[0]!;
      expect(front.facing).toBeCloseTo(1, 6);
      // Sub-pixel: `presetRotation` goes through a float32-free but still finite quaternion, so the
      // centre lands within a thousandth of a pixel rather than exactly.
      expect(front.center[0]).toBeCloseTo(L.cx, 3);
      expect(front.center[1]).toBeCloseTo(L.cy, 3);
    }
  });

  it('an off-preset camera shows three faces, back-to-front', () => {
    // 30° about x then 30° about z, as a quaternion product — no gl-matrix, by hand.
    const h = Math.PI / 12;
    const [c, s] = [Math.cos(h), Math.sin(h)];
    // (s,0,0,c) * (0,0,s,c)
    const q: quat = [s * c, s * s, c * s, c * c - 0];
    const n = Math.hypot(...q);
    const faces = cubeFaces(L, [q[0] / n, q[1] / n, q[2] / n, q[3] / n]);
    expect(faces).toHaveLength(3);
    for (let i = 1; i < faces.length; i += 1) {
      expect(faces[i]!.facing).toBeGreaterThanOrEqual(faces[i - 1]!.facing);
    }
    // Never two of an opposite pair: `A` and `P` cannot both face the camera.
    const seen = new Set(faces.map((f) => f.face));
    for (const [a, b] of [
      ['A', 'P'],
      ['L', 'R'],
      ['S', 'I'],
    ] as [CubeFace, CubeFace][]) {
      expect(seen.has(a) && seen.has(b)).toBe(false);
    }
  });

  it('no rotation can push a corner out of the box', () => {
    for (let i = 0; i < 200; i += 1) {
      // A deterministic sweep of rotations, not a random one.
      const a = (i / 200) * Math.PI * 2;
      const q: quat = [Math.sin(a / 2) * 0.6, Math.sin(a / 2) * 0.8, 0, Math.cos(a / 2)];
      for (const f of cubeFaces(L, q)) {
        for (const [x, y] of f.corners) {
          expect(Math.abs(x - L.cx)).toBeLessThanOrEqual(L.half + 1e-9);
          expect(Math.abs(y - L.cy)).toBeLessThanOrEqual(L.half + 1e-9);
        }
      }
    }
  });

  it('labels every one of the six directions and no other', () => {
    expect(CUBE_FACES.map((f) => f.face).sort()).toEqual(['A', 'I', 'L', 'P', 'R', 'S']);
  });
});

describe('cubeFaceAt', () => {
  it('the centre of the box is the preset you are looking at', () => {
    for (const { index, face } of PRESETS) {
      expect(cubeFaceAt(L, presetRotation(index), L.cx, L.cy)).toBe(face);
    }
  });

  it('misses outside the silhouette, so a click there orbits instead', () => {
    const rot = presetRotation(5);
    // The cube's projected extent at a cardinal view is `half / √3` — the face, not the box.
    expect(cubeFaceAt(L, rot, L.cx + L.half - 1, L.cy)).toBeNull();
    expect(cubeFaceAt(L, rot, 10, 10)).toBeNull();
  });

  it('picks the front face where two overlap in projection', () => {
    // Tilted 40° about x: `S` is still the frontmost, `A` or `P` shares the silhouette.
    const a = (40 * Math.PI) / 180;
    const q: quat = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
    const faces = cubeFaces(L, q);
    const front = faces[faces.length - 1]!;
    expect(cubeFaceAt(L, q, front.center[0], front.center[1])).toBe(front.face);
  });
});

describe('cubeLayout', () => {
  it('sits in the bottom-right corner and never takes more than a third of a small pane', () => {
    const big = cubeLayout(overlayMetrics(512, 512, 1));
    expect(big.cx).toBe(512 - 4 - big.half);
    expect(big.cy).toBe(4 + big.half);
    const small = cubeLayout(overlayMetrics(90, 90, 1));
    expect(small.half * 2).toBeLessThanOrEqual(30);
  });
});

describe('drawOrientationCube', () => {
  it('draws a face, its four edges and its letter at a cardinal view', () => {
    const b = new OverlayBuilder();
    b.begin(512, 512);
    drawOrientationCube(b, M, presetRotation(5), { text: [1, 1, 1, 1], halo: [0, 0, 0, 1] });
    // One visible face: 1 quad + 4 edge quads = 5 × 6 vertices, plus one glyph (6).
    expect(b.vertexCount).toBe(5 * 6 + 6);
  });

  it('draws three faces off-preset', () => {
    const a = (40 * Math.PI) / 180;
    const q: quat = [Math.sin(a / 2) * 0.6, Math.sin(a / 2) * 0.6, Math.sin(a / 2) * 0.5, 0.8];
    const n = Math.hypot(...q);
    const b = new OverlayBuilder();
    b.begin(512, 512);
    drawOrientationCube(b, M, [q[0] / n, q[1] / n, q[2] / n, q[3] / n], {
      text: [1, 1, 1, 1],
      halo: [0, 0, 0, 1],
    });
    expect(b.vertexCount).toBeGreaterThan(3 * 5 * 6);
  });
});
