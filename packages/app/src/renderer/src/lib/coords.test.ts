import { describe, expect, it } from 'vitest';
import {
  applyMat4,
  formatNumber,
  formatTriple,
  invertMat4,
  parseTriple,
  roundVoxel,
  templateToWorld,
  voxelToWorld,
  worldToTemplate,
  worldToVoxel,
} from './coords';
import type { mat4 } from '@tetravox/engine';

/**
 * `m2m_ernie/T1.nii.gz`'s affine (AGENTS.md), transposed into §6.5.1's flat **column-major** `Mat4x4`:
 * `w[col * 4 + row] = m[row][col]`. Writing it this way, rather than as four rows, is the whole point —
 * §3 says the two layouts are transposes and the app only ever meets the column-major one.
 *
 *   row-major (nibabel):  [[ 0, 0, 1,  -99.737457],
 *                          [-1, 0, 0,  154.187500],
 *                          [ 0, 1, 0, -143.642273],
 *                          [ 0, 0, 0,    1       ]]
 */
const T1_AFFINE: mat4 = Float32Array.from([
  0, -1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -99.737457, 154.1875, -143.642273, 1,
]);

/** Its inverse, likewise column-major. `inv(R) = Rᵀ` here because R is a signed permutation. */
const T1_INVERSE: mat4 = Float32Array.from([
  0, 0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 154.1875, 143.642273, 99.737457, 1,
]);

describe('formatTriple / formatNumber', () => {
  it('is the §8 copy format: one decimal, space-separated', () => {
    expect(formatTriple([-42, 18, 6])).toBe('-42.0 18.0 6.0');
  });

  it('formats a Float32Array too — TypedArray.map returns a typed array, not strings', () => {
    // The failure this pins had no crash and no type error: a `vec3` that really came off the §6.5
    // wire as a `Float32Array` mapped to numbers again, and `join` printed
    // `-28.700000762939453` where §8 promised `-28.7` (directed task 8).
    const wire = Float32Array.from([-28.7, 22, -26.6]) as unknown as [number, number, number];
    expect(formatTriple(wire)).toBe('-28.7 22.0 -26.6');
  });

  it('never prints a signed zero — a sign on zero is a laterality question', () => {
    expect(formatNumber(-0)).toBe('0.0');
    expect(formatNumber(-0.04)).toBe('0.0');
    expect(formatTriple([-0, 0, -0.0001])).toBe('0.0 0.0 0.0');
  });

  it('prints voxel indices as integers at 0 decimals', () => {
    expect(formatTriple([128, 99, 104], 0)).toBe('128 99 104');
  });

  it('shows a dash rather than NaN', () => {
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('parseTriple', () => {
  it('accepts the §8 forms: spaces, commas, or both', () => {
    expect(parseTriple('-42 18 6')).toEqual([-42, 18, 6]);
    expect(parseTriple('-42,18,6')).toEqual([-42, 18, 6]);
    expect(parseTriple('-42, 18, 6')).toEqual([-42, 18, 6]);
    expect(parseTriple('  -42.0\t18.0\n6.0  ')).toEqual([-42, 18, 6]);
    expect(parseTriple('[-42 18 6]')).toEqual([-42, 18, 6]);
    expect(parseTriple('(1.5e1, -2, .5)')).toEqual([15, -2, 0.5]);
  });

  it('rejects anything that is not exactly three finite numbers', () => {
    expect(parseTriple('')).toBeNull();
    expect(parseTriple('1 2')).toBeNull();
    expect(parseTriple('1 2 3 4')).toBeNull();
    expect(parseTriple('1 2 three')).toBeNull();
    // `Number('1px')` is NaN but `Number('')` is 0 and `Number('0x10')` is 16 — a bare `Number()`
    // parse would accept the last two silently.
    expect(parseTriple('1 2 0x10')).toBeNull();
    expect(parseTriple('1 2 NaN')).toBeNull();
    expect(parseTriple('1,,3')).toBeNull();
  });
});

describe('applyMat4 against the reference T1 affine', () => {
  it('reproduces AGENTS.md world(voxel 0,0,0)', () => {
    const world = voxelToWorld(T1_AFFINE, [0, 0, 0]);
    expect(world[0]).toBeCloseTo(-99.737457, 4);
    expect(world[1]).toBeCloseTo(154.1875, 4);
    expect(world[2]).toBeCloseTo(-143.642273, 4);
  });

  it('reproduces AGENTS.md world(voxel 255,255,207)', () => {
    const world = voxelToWorld(T1_AFFINE, [255, 255, 207]);
    expect(world[0]).toBeCloseTo(107.262543, 3);
    expect(world[1]).toBeCloseTo(-100.8125, 3);
    expect(world[2]).toBeCloseTo(111.357727, 3);
  });

  it('round-trips world → voxel → world', () => {
    const voxel = worldToVoxel(T1_INVERSE, [107.262543, -100.8125, 111.357727]);
    expect(roundVoxel(voxel)).toEqual([255, 255, 207]);
  });

  it('reads the translation out of m[12..14], not m[3,7,11]', () => {
    // The transposed matrix would put the translation in 3/7/11 and give a different answer; this is
    // the §3 layout trap, asserted rather than commented.
    expect(applyMat4(T1_AFFINE, [0, 0, 0])).toEqual([
      T1_AFFINE[12] as number,
      T1_AFFINE[13] as number,
      T1_AFFINE[14] as number,
    ]);
  });
});

// ------------------------------------------------------------------------------------------------
// Phase 2 (appended): the MNI column's arithmetic — audit P2-10.
// ------------------------------------------------------------------------------------------------

describe('invertMat4', () => {
  it("inverts the real T1 affine to the reference file's own inverse", () => {
    const inverse = invertMat4(T1_AFFINE);
    expect(inverse).not.toBeNull();
    for (let i = 0; i < 16; i++) {
      expect(inverse?.[i] as number).toBeCloseTo(T1_INVERSE[i] as number, 4);
    }
  });

  it('round-trips a point through the affine and back to the voxel it started at', () => {
    const inverse = invertMat4(T1_AFFINE) as mat4;
    const world = voxelToWorld(T1_AFFINE, [128, 128, 104]);
    expect(roundVoxel(applyMat4(inverse, world))).toEqual([128, 128, 104]);
  });

  it('inverts a sheared matrix too, which a rigid-only special case would get wrong', () => {
    // Column-major: x' = x + 0.5y, y' = y, z' = z, plus a translation.
    const sheared: mat4 = Float32Array.from([1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 3, -2, 7, 1]);
    const inverse = invertMat4(sheared) as mat4;
    const point: [number, number, number] = [11, -4, 2];
    const back = applyMat4(inverse, applyMat4(sheared, point));
    for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(point[i] as number, 5);
  });

  it('returns null for a singular matrix rather than a plausible-looking wrong answer', () => {
    const flat: mat4 = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(invertMat4(flat)).toBeNull();
  });
});

describe('world ↔ template', () => {
  /** A 12 mm anterior shift, column-major — the stand-in engine\'s `mniToTemplate`. */
  const TO_MNI: mat4 = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 12, 0, 1]);

  it('applies `toTemplate.matrix` forward for the read-out', () => {
    expect(worldToTemplate(TO_MNI, [-42, 18, 6])).toEqual([-42, 30, 6]);
  });

  it('inverts it for a coordinate the user typed', () => {
    expect(templateToWorld(TO_MNI, [-42, 30, 6])).toEqual([-42, 18, 6]);
  });

  it('refuses rather than guessing when the transform cannot be inverted', () => {
    const singular: mat4 = Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(templateToWorld(singular, [0, 0, 0])).toBeNull();
  });
});
