/**
 * `snapAlong` — §7.5's anti-drift rule, shared by the slice step and P2-09's in-plane nudge.
 *
 * The property that matters is stated in §7.5 and in §11's obligations: *"100 steps forward and 100
 * back return to the starting voxel exactly (the anti-drift rule)"*, and the snap must move the
 * cursor **along the stepped direction only** — rounding all three voxel indices instead is the
 * defect that made one wheel notch also drag the cursor 0.5 mm across the plane.
 *
 * The affine below is `m2m_ernie/T1.nii.gz`'s, transcribed from `AGENTS.md`: `world x ← k`,
 * `world y ← −i`, `world z ← j`, with `qfac = −1` already applied. It is the reference case for
 * "never assume a voxel axis per view mode", because every one of its three canonical planes steps
 * along a *different* voxel axis than a naive reading would give.
 */

import { describe, expect, it } from 'vitest';
import { mat4 as glMat4 } from 'gl-matrix';
import { snapAlong, voxelAxisAlong, worldToVoxel } from './geometry';
import { asGl, identity4 } from './m4';
import type { vec3, VolumeDataset } from '../scene/types';

/**
 * `m2m_ernie/T1.nii.gz`'s affine `[DATA]`, column-major (§3):
 *
 * ```
 * [[ 0, 0, 1,  -99.737457],
 *  [-1, 0, 0,  154.187500],
 *  [ 0, 1, 0, -143.642273],
 *  [ 0, 0, 0,    1       ]]
 * ```
 */
const T1_AFFINE = Float32Array.from([
  0, -1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -99.737457, 154.1875, -143.642273, 1,
]);

function dataset(affine: Float32Array): VolumeDataset {
  const inverseAffine = identity4();
  glMat4.invert(asGl(inverseAffine), asGl(affine));
  return { kind: 'volume', affine, inverseAffine } as unknown as VolumeDataset;
}

const T1 = dataset(T1_AFFINE);
/** 1 mm isotropic, axis-aligned, origin at zero — the easy case, for readable expectations. */
const UNIT = dataset(Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));

const AXIAL: vec3 = [0, 0, 1];
const RIGHT: vec3 = [1, 0, 0];
const UP: vec3 = [0, 1, 0];

describe('snapAlong', () => {
  it('puts the stepped voxel index on an integer and leaves the other two alone', () => {
    const start: vec3 = [0.3, -0.4, 0.7];
    const snapped = snapAlong(UNIT, start, AXIAL);
    const v = worldToVoxel(UNIT, snapped);
    expect(v[2]).toBeCloseTo(Math.round(v[2] ?? 0), 9);
    // The in-plane components are untouched — this is the whole difference from rounding all three.
    expect(v[0]).toBeCloseTo(0.3, 9);
    expect(v[1]).toBeCloseTo(-0.4, 9);
  });

  it('moves along `dir` and nowhere else, on the permuted reference affine', () => {
    const start: vec3 = [1.3, -7.2, 4.9];
    const snapped = snapAlong(T1, start, RIGHT);
    // Displacement is a multiple of `dir`, so both other world axes are exactly unchanged.
    expect(snapped[1]).toBe(start[1]);
    expect(snapped[2]).toBe(start[2]);
    // The T1 affine maps `world x ← k`, so stepping along world +x steps voxel axis 2.
    expect(voxelAxisAlong(RIGHT, T1_AFFINE).axis).toBe(2);
    const v = worldToVoxel(T1, snapped);
    expect(v[2]).toBeCloseTo(Math.round(v[2] ?? 0), 4);
  });

  it('is idempotent — snapping an already-snapped point does nothing', () => {
    const once = snapAlong(T1, [1.3, -7.2, 4.9], UP);
    expect(snapAlong(T1, once, UP)).toEqual(once);
  });

  it('never moves more than half a voxel', () => {
    // 0.5 mm voxels along the stepped axis: `label_prep/*_upsampled.nii.gz`'s spacing `[DATA]`.
    const half = dataset(Float32Array.from([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]));
    for (const z of [0.01, 0.24, 0.26, 0.49, -0.3]) {
      const moved = snapAlong(half, [0, 0, z], AXIAL);
      expect(Math.abs((moved[2] ?? 0) - z)).toBeLessThanOrEqual(0.25 + 1e-9);
    }
  });

  it('100 steps out and 100 back return to the starting voxel exactly (§7.5, §11)', () => {
    const step = voxelAxisAlong(RIGHT, T1_AFFINE).mm;
    expect(step).toBeCloseTo(1, 6);
    const start: vec3 = [1.3, -7.2, 4.9];
    let cursor = start;
    const walk = (steps: number): void => {
      cursor = snapAlong(
        T1,
        [
          cursor[0] + RIGHT[0] * step * steps,
          cursor[1] + RIGHT[1] * step * steps,
          cursor[2] + RIGHT[2] * step * steps,
        ],
        RIGHT
      );
    };
    for (let i = 0; i < 100; i += 1) walk(1);
    for (let i = 0; i < 100; i += 1) walk(-1);
    const back = worldToVoxel(T1, cursor);
    const from = worldToVoxel(T1, snapAlong(T1, start, RIGHT));
    // Same voxel, to the fourth decimal — no accumulated drift over 200 steps.
    expect(back[2]).toBeCloseTo(from[2] ?? 0, 4);
    expect(back[0]).toBeCloseTo(from[0] ?? 0, 4);
    expect(back[1]).toBeCloseTo(from[1] ?? 0, 4);
  });

  it('returns the point unchanged when the direction cannot move that index', () => {
    // A degenerate affine whose third column is zero: nothing to snap to, and no NaN either.
    const flat = dataset(Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
    const p: vec3 = [0.3, 0.4, 0.5];
    expect(snapAlong(flat, p, [0, 0, 1])).toEqual(p);
  });
});
