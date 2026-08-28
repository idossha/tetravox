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
  easeFraction,
  pluckShape,
  tweenFractions,
  tweenValue,
  nullsToUndefined,
  mergeOnto,
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

// ------------------------------------------------------------------------------------------------
// tween (directed task 14)
// ------------------------------------------------------------------------------------------------

describe('easeFraction', () => {
  it('pins both ends for every curve — a shot must arrive exactly where it was aimed', () => {
    for (const ease of ['linear', 'in', 'out', 'inOut'] as const) {
      expect(easeFraction(ease, 0)).toBe(0);
      expect(easeFraction(ease, 1)).toBe(1);
    }
  });

  it('clamps outside 0..1, so a caller’s rounding cannot overshoot the end state', () => {
    expect(easeFraction('inOut', -0.2)).toBe(0);
    expect(easeFraction('inOut', 1.4)).toBe(1);
  });

  it('is symmetric about the midpoint for inOut — accelerate and decelerate equally', () => {
    expect(easeFraction('inOut', 0.5)).toBeCloseTo(0.5, 12);
    for (const t of [0.1, 0.25, 0.37]) {
      expect(easeFraction('inOut', t) + easeFraction('inOut', 1 - t)).toBeCloseTo(1, 12);
    }
  });

  it('starts slower than linear and ends faster, which is what "ease in" means', () => {
    expect(easeFraction('in', 0.25)).toBeLessThan(0.25);
    expect(easeFraction('out', 0.25)).toBeGreaterThan(0.25);
    expect(easeFraction('linear', 0.25)).toBe(0.25);
  });

  it('is monotonic — no frame of a tween ever moves backwards', () => {
    for (const ease of ['linear', 'in', 'out', 'inOut'] as const) {
      let previous = -1;
      for (let i = 0; i <= 100; i += 1) {
        const value = easeFraction(ease, i / 100);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });
});

describe('tweenFractions', () => {
  it('includes both ends — unlike an orbit, a move must land on its destination', () => {
    const f = tweenFractions(5, 'linear');
    expect(f).toHaveLength(5);
    expect(f[0]).toBe(0);
    expect(f[4]).toBe(1);
  });

  it('a one-frame tween is the end state, which is what makes `frames: 1` a hold', () => {
    expect(tweenFractions(1)).toEqual([1]);
  });

  it('defaults to inOut and caps at MAX_FRAMES', () => {
    expect(tweenFractions(3)).toEqual(tweenFractions(3, 'inOut'));
    expect(tweenFractions(10_000)).toHaveLength(MAX_FRAMES);
  });
});

describe('tweenValue', () => {
  it('lerps a number', () => {
    expect(tweenValue(0, 10, 0.25)).toBe(2.5);
    expect(tweenValue(10, 0, 1)).toBe(0);
  });

  it('walks an array element-wise — a cursor is three numbers, not one', () => {
    expect(tweenValue([0, 0, 0], [10, -20, 4], 0.5)).toEqual([5, -10, 2]);
  });

  it('walks nested objects over the keys `to` names, and only those', () => {
    const out = tweenValue(
      { opacity: 0, threshold: { lo: 1, hi: 2 }, colormap: 'jet' },
      { opacity: 1, threshold: { lo: 3 } },
      0.5
    );
    expect(out).toEqual({ opacity: 0.5, threshold: { lo: 2 } });
  });

  it('applies a non-numeric leaf from the first frame — there is no halfway between two colormaps', () => {
    expect(tweenValue('jet', 'hot', 0)).toBe('hot');
    expect(tweenValue(false, true, 0)).toBe(true);
  });

  it('holds a number whose start is missing rather than fading it up from an invented zero', () => {
    expect(tweenValue(undefined, 0.8, 0)).toBe(0.8);
    expect(tweenValue(Number.NaN, 0.8, 0.5)).toBe(0.8);
  });
});

describe('pluckShape', () => {
  it('reads the paths `to` names out of the live object, so `from` can be omitted', () => {
    const layer = { opacity: 0.25, colormap: 'hot', clip: { planes: [{ plane: { offset: 12 } }] } };
    expect(
      pluckShape(layer, { opacity: 1, clip: { planes: [{ plane: { offset: 40 } }] } })
    ).toEqual({
      opacity: 0.25,
      clip: { planes: [{ plane: { offset: 12 } }] },
    });
  });

  it('yields undefined where the live object has nothing, which tweenValue then holds at `to`', () => {
    expect(pluckShape({}, { iso: 0.13 })).toEqual({ iso: undefined });
    expect(tweenValue(pluckShape({}, { iso: 0.13 }), { iso: 0.13 }, 0)).toEqual({ iso: 0.13 });
  });
});

describe('nullsToUndefined', () => {
  it('turns a null into undefined, which is how a job removes an optional layer field', () => {
    expect(nullsToUndefined({ isolate: null })).toEqual({ isolate: undefined });
    expect('isolate' in (nullsToUndefined({ isolate: null }) as object)).toBe(true);
  });

  it('walks objects and arrays, and leaves every other value alone', () => {
    expect(
      nullsToUndefined({ clip: { planes: [{ plane: null }], caps: true }, name: 'x', n: 0 })
    ).toEqual({ clip: { planes: [{ plane: undefined }], caps: true }, name: 'x', n: 0 });
  });
});

describe('mergeOnto', () => {
  it('keeps the parts of a nested field the tween did not name', () => {
    const clip = {
      planes: [{ plane: { normal: [0, 0, 1], offset: 130 }, enabled: true }],
      caps: true,
    };
    expect(mergeOnto(clip, { planes: [{ plane: { offset: -16.3 } }] })).toEqual({
      planes: [{ plane: { normal: [0, 0, 1], offset: -16.3 }, enabled: true }],
      caps: true,
    });
  });

  it('merges arrays element-wise and leaves the entries the patch is silent about', () => {
    expect(mergeOnto([{ a: 1, b: 2 }, { a: 9 }], [{ a: 5 }])).toEqual([{ a: 5, b: 2 }, { a: 9 }]);
  });

  it('an undefined leaf is "no change", not "delete"', () => {
    expect(mergeOnto({ lo: 0.1, hi: 10 }, { lo: 0.3, hi: undefined })).toEqual({ lo: 0.3, hi: 10 });
  });

  it('a scalar patch replaces a scalar base', () => {
    expect(mergeOnto(1, 2)).toBe(2);
    expect(mergeOnto({ a: 1 }, 'x')).toBe('x');
  });
});
