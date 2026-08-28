/**
 * The sweep/orbit arithmetic (`automation/frames.ts`).
 *
 * These are the numbers that decide *where* each frame of an animation is taken, so every expectation
 * below is derived rather than recorded: an orbit's rotation is checked by rotating a vector with it
 * and asking where the vector went, not by comparing quaternion components against a paste.
 */

import { describe, expect, it } from 'vitest';
import type { Aabb, quat, vec3 } from '@tetravox/engine';
import {
  MAX_FRAMES,
  boundsAlongNormal,
  cursorAtOffset,
  normalizeQuat,
  orbitRotations,
  quatFromAxisAngle,
  quatMultiply,
  sweepOffsets,
} from './frames';

const BOUNDS: Aabb = { min: [-10, -20, -30], max: [10, 20, 30] };

/** Rotate a vector by a quaternion — `v' = q v q*`, expanded. */
function rotate(q: quat, v: vec3): vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q.xyz × v); v' = v + w*t + q.xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

describe('sweepOffsets', () => {
  it('`count` is inclusive of both ends', () => {
    expect(sweepOffsets({ from: -40, to: 40, count: 5 }, { lo: 0, hi: 1 })).toEqual([
      -40, -20, 0, 20, 40,
    ]);
  });

  it('`count: 1` is a single frame at `from`, not a division by zero', () => {
    expect(sweepOffsets({ from: 7, to: 40, count: 1 }, { lo: 0, hi: 1 })).toEqual([7]);
  });

  it('`step` walks from `from` towards `to` and lands on `to` when it divides evenly', () => {
    expect(sweepOffsets({ from: 0, to: 10, step: 2.5 }, { lo: 0, hi: 1 })).toEqual([
      0, 2.5, 5, 7.5, 10,
    ]);
  });

  it('a step that does not divide the span stops before overshooting', () => {
    expect(sweepOffsets({ from: 0, to: 10, step: 4 }, { lo: 0, hi: 1 })).toEqual([0, 4, 8]);
  });

  it('takes the direction of travel from `from` and `to`, not from the sign of `step`', () => {
    expect(sweepOffsets({ from: 10, to: 0, step: 5 }, { lo: 0, hi: 1 })).toEqual([10, 5, 0]);
    expect(sweepOffsets({ from: 10, to: 0, step: -5 }, { lo: 0, hi: 1 })).toEqual([10, 5, 0]);
  });

  it('does not stop one frame short on a span that is not exact in binary', () => {
    // `0 + 10 * 0.1` is 0.9999999999999999: without the half-step tolerance this returned 10 frames.
    expect(sweepOffsets({ from: 0, to: 1, step: 0.1 }, { lo: 0, hi: 1 })).toHaveLength(11);
  });

  it('falls back to the bounds when `from` / `to` are absent', () => {
    expect(sweepOffsets({ count: 3 }, { lo: -6, hi: 6 })).toEqual([-6, 0, 6]);
  });

  it('caps the frame count, so a small step cannot fill a disk', () => {
    expect(sweepOffsets({ from: 0, to: 1e6, step: 1 }, { lo: 0, hi: 1 })).toHaveLength(MAX_FRAMES);
    expect(sweepOffsets({ count: 10_000 }, { lo: 0, hi: 1 })).toHaveLength(MAX_FRAMES);
  });

  it('a zero-width sweep is one frame, not none', () => {
    expect(sweepOffsets({ from: 3, to: 3, step: 1 }, { lo: 0, hi: 1 })).toEqual([3]);
  });
});

describe('boundsAlongNormal', () => {
  it('projects the box onto the axis and insets 5 % off each end', () => {
    // Along +Z the box spans −30…30; 5 % of the 60 mm span is 3 mm.
    expect(boundsAlongNormal(BOUNDS, [0, 0, 1])).toEqual({ lo: -27, hi: 27 });
  });

  it('handles a normal that is not an axis', () => {
    const n: vec3 = [0, Math.SQRT1_2, Math.SQRT1_2];
    // The extreme corners along that normal are ±(20 + 30)/√2 = ±35.355…
    const extent = (20 + 30) * Math.SQRT1_2;
    const { lo, hi } = boundsAlongNormal(BOUNDS, n);
    expect(hi).toBeCloseTo(extent * 0.9, 6);
    expect(lo).toBeCloseTo(-extent * 0.9, 6);
  });
});

describe('cursorAtOffset', () => {
  it('moves the cursor onto the plane and leaves its in-plane position alone', () => {
    const moved = cursorAtOffset([3, 4, 5], [0, 0, 1], 20);
    expect(moved).toEqual([3, 4, 20]);
  });

  it('works for an oblique normal: the along-normal component becomes the offset, exactly', () => {
    const normal: vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
    const moved = cursorAtOffset([1, 2, 3], normal, 10);
    const along = moved[0] * normal[0] + moved[1] * normal[1] + moved[2] * normal[2];
    expect(along).toBeCloseTo(10, 10);
    // The in-plane part is untouched: the component perpendicular to the normal is unchanged.
    const before: vec3 = [1, 2, 3];
    const perp = (v: vec3): number => v[1];
    expect(perp(moved)).toBe(perp(before));
  });
});

describe('orbitRotations', () => {
  const IDENTITY: quat = [0, 0, 0, 1];

  it('produces `frames` rotations, the first of which is the camera as it stands', () => {
    const rotations = orbitRotations(IDENTITY, { degrees: 360, frames: 12 });
    expect(rotations).toHaveLength(12);
    expect(rotations[0]).toEqual(IDENTITY);
  });

  it('stops one step short of a full turn, so a 360° GIF loops without a repeated frame', () => {
    const rotations = orbitRotations(IDENTITY, { degrees: 360, frames: 4 });
    // Four frames over 360° means 90° apart: +X goes to +Y, −X, −Y.
    const x: vec3 = [1, 0, 0];
    const at = (i: number): vec3 => rotate(rotations[i] as quat, x);
    expect(at(0)[0]).toBeCloseTo(1, 6);
    expect(at(1)[1]).toBeCloseTo(1, 6);
    expect(at(2)[0]).toBeCloseTo(-1, 6);
    expect(at(3)[1]).toBeCloseTo(-1, 6);
  });

  it('orbits about the named world axis', () => {
    const aboutX = orbitRotations(IDENTITY, { degrees: 360, frames: 4, axis: 'x' });
    // About +X, +Y goes to +Z.
    const moved = rotate(aboutX[1] as quat, [0, 1, 0]);
    expect(moved[2]).toBeCloseTo(1, 6);
  });

  it('defaults to 36 frames of a full turn about z', () => {
    expect(orbitRotations(IDENTITY, {})).toHaveLength(36);
    const tenDegrees = rotate(orbitRotations(IDENTITY, {})[1] as quat, [1, 0, 0]);
    expect(tenDegrees[0]).toBeCloseTo(Math.cos((10 * Math.PI) / 180), 6);
    expect(tenDegrees[1]).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 6);
  });

  it('keeps every rotation a unit quaternion, so a long orbit does not drift', () => {
    for (const q of orbitRotations([0.3, 0.4, 0.5, 0.7071], { frames: 60 })) {
      expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    }
  });

  it('composes on the LEFT of the camera, which walks the camera around the target', () => {
    // A camera already looking from +X (a 90° turn about z), orbited another 90° about z, must be
    // looking from +Y — a right-multiplication would spin it about its own view axis instead.
    const start = quatFromAxisAngle('z', Math.PI / 2);
    const [, second] = orbitRotations(start, { degrees: 360, frames: 4 });
    const moved = rotate(second as quat, [1, 0, 0]);
    expect(moved[0]).toBeCloseTo(-1, 6);
    expect(moved[1]).toBeCloseTo(0, 6);
  });

  it('caps the frame count like a sweep does', () => {
    expect(orbitRotations(IDENTITY, { frames: 5000 })).toHaveLength(MAX_FRAMES);
  });
});

describe('quaternion helpers', () => {
  it('multiplies in gl-matrix order', () => {
    const a = quatFromAxisAngle('z', Math.PI / 2);
    const b = quatFromAxisAngle('z', Math.PI / 2);
    const both = quatMultiply(a, b);
    expect(rotate(both, [1, 0, 0])[0]).toBeCloseTo(-1, 6);
  });

  it('normalises, and answers identity for a zero quaternion rather than NaN', () => {
    expect(normalizeQuat([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(Math.hypot(...normalizeQuat([2, 0, 0, 0]))).toBeCloseTo(1, 12);
  });
});
