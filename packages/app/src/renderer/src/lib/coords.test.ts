import { describe, expect, it } from 'vitest';
import {
  applyMat4,
  formatNumber,
  formatTriple,
  parseTriple,
  roundVoxel,
  voxelToWorld,
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
