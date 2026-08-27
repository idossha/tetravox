/**
 * §3's view basis and the orientation letters derived from it.
 *
 * §8: the letters are "derived from the affine and the radiological flag, **never hardcoded per
 * pane**" — a laterality-safety requirement. This is the test that pins the derivation, so a change
 * to the basis can never quietly relabel a pane.
 */

import { describe, expect, it } from 'vitest';
import {
  edgeLetters,
  letterFor,
  presetNormal,
  presetUp,
  sliceBasis,
  stepMm,
  voxelAxisAlong,
} from '../../src/view/geometry';
import type { SliceMode, vec3 } from '../../src/scene/types';

const basisOf = (mode: SliceMode, radiological: boolean): ReturnType<typeof sliceBasis> =>
  sliceBasis({ normal: presetNormal(mode), up: presetUp(mode) }, radiological);

describe('the slice basis', () => {
  it('maps a world direction to the anatomical letter, world space being scanner RAS (§3)', () => {
    expect(letterFor([1, 0, 0])).toBe('R');
    expect(letterFor([-1, 0, 0])).toBe('L');
    expect(letterFor([0, 1, 0])).toBe('A');
    expect(letterFor([0, -1, 0])).toBe('P');
    expect(letterFor([0, 0, 1])).toBe('S');
    expect(letterFor([0, 0, -1])).toBe('I');
    // The dominant axis wins, so an oblique normal still names a side.
    expect(letterFor([0.9, 0.3, 0.2])).toBe('R');
  });

  it('is orthonormal and right-handed for every preset', () => {
    for (const mode of ['axial', 'coronal', 'sagittal', 'oblique'] as SliceMode[]) {
      const b = basisOf(mode, false);
      const dot = (x: vec3, y: vec3): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
      expect(dot(b.right, b.up)).toBeCloseTo(0, 6);
      expect(dot(b.right, b.normal)).toBeCloseTo(0, 6);
      expect(dot(b.up, b.normal)).toBeCloseTo(0, 6);
      for (const v of [b.right, b.up, b.normal]) expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    }
  });

  it('mirrors about the vertical screen axis when radiological, and never touches `up` (§3)', () => {
    for (const mode of ['axial', 'coronal', 'sagittal', 'oblique'] as SliceMode[]) {
      const neu = basisOf(mode, false);
      const rad = basisOf(mode, true);
      expect(rad.up).toEqual(neu.up);
      expect(rad.normal).toEqual(neu.normal);
      expect(rad.right.map((v) => -v)).toEqual(neu.right);
      const a = edgeLetters(neu);
      const b = edgeLetters(rad);
      // Left and right swap; top and bottom do not.
      expect(b.left).toBe(a.right);
      expect(b.right).toBe(a.left);
      expect(b.top).toBe(a.top);
      expect(b.bottom).toBe(a.bottom);
    }
  });

  it('labels each preset with the letters its basis actually points at', () => {
    // §3: `right = cross(up, normal)` with the preset normals (+Z, −Y, −X). Every pane that has a
    // left/right axis on screen puts **L on the left** in neurological, so the one `NEU` badge is
    // true of all of them. Phase 1 shipped coronal `+Y`, which put R|L on the coronal pane while the
    // axial pane read L|R under the same badge; see docs/DECISIONS.md (2026-08-27).
    expect(edgeLetters(basisOf('axial', false))).toEqual({
      left: 'L',
      right: 'R',
      top: 'A',
      bottom: 'P',
    });
    expect(edgeLetters(basisOf('coronal', false))).toEqual({
      left: 'L',
      right: 'R',
      top: 'S',
      bottom: 'I',
    });
    // Sagittal has no left/right axis on screen — the subject's L/R is the view normal — so what the
    // convention fixes there is the mirror: anterior is screen-left in neurological.
    expect(edgeLetters(basisOf('sagittal', false))).toEqual({
      left: 'A',
      right: 'P',
      top: 'S',
      bottom: 'I',
    });
  });

  it('puts the subject-left half of the world on screen-left in every preset (§11)', () => {
    // The screen-x of a world offset is `dot(offset, basis.right)`. §11's fixture is a bright cube
    // in the LEFT-anterior-superior octant, i.e. offset (−1, +1, +1) from the volume centre; the
    // three mandatory orientation tests require it on screen-LEFT in neurological and screen-RIGHT
    // in radiological, in each of the three views. That is a property of the basis alone, so it is
    // pinned here as arithmetic as well as in the pixel tests.
    const las: vec3 = [-1, 1, 1];
    const dot = (x: vec3, y: vec3): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    for (const mode of ['axial', 'coronal', 'sagittal'] as SliceMode[]) {
      expect(dot(las, basisOf(mode, false).right), `${mode} neurological`).toBeLessThan(0);
      expect(dot(las, basisOf(mode, true).right), `${mode} radiological`).toBeGreaterThan(0);
    }
  });

  it('re-orthogonalises a degenerate `up` instead of producing NaN (§4.5)', () => {
    const b = sliceBasis({ normal: [0, 0, 1], up: [0, 0, 1] }, false);
    for (const v of [b.right, b.up, b.normal]) {
      for (const c of v) expect(Number.isFinite(c)).toBe(true);
    }
    expect(Math.hypot(...b.up)).toBeCloseTo(1, 6);
  });
});

describe('stepMm (§7.5)', () => {
  it('is the largest projection of the normal on a voxel axis', () => {
    // Column-major mat4 for diag(1, 2, 3): stepping along +Z on a 3 mm-thick slab is 3 mm.
    const affine = new Float32Array([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1]);
    expect(stepMm([0, 0, 1], affine, null, null)).toBeCloseTo(3, 6);
    expect(stepMm([0, 1, 0], affine, null, null)).toBeCloseTo(2, 6);
    expect(stepMm([1, 0, 0], affine, null, null)).toBeCloseTo(1, 6);
    // An oblique normal reduces to the dominant axis, which is what keeps one definition for both.
    expect(stepMm([0, 0.6, 0.8], affine, null, null)).toBeCloseTo(2.4, 6);
  });

  it('falls back to the smallest spacing, then to the bbox diagonal / 256', () => {
    expect(stepMm([0, 0, 1], null, [0.5, 1, 2], null)).toBeCloseTo(0.5, 6);
    const bounds = { min: [0, 0, 0] as vec3, max: [256, 0, 0] as vec3 };
    expect(stepMm([0, 0, 1], null, null, bounds)).toBeCloseTo(1, 6);
    expect(stepMm([0, 0, 1], null, null, null)).toBe(1);
  });
});

describe('the stepping voxel axis (§7.5 step, §8 corner slice index)', () => {
  // `m2m_ernie/T1.nii.gz`'s affine, from AGENTS.md, transposed into the column-major `mat4` the
  // engine carries (§3: `w[col * 4 + row] = m[row][col]`). It maps world x <- k, y <- -i, z <- j.
  const T1 = new Float32Array([
    0, -1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -99.737457, 154.1875, -143.642273, 1,
  ]);

  it('derives the axis from the affine, not from the view mode', () => {
    // Every SimNIBS m2m volume permutes the voxel axes, so an axial plane steps along voxel `j` and
    // a sagittal plane along voxel `k` here. A per-mode table reports two panes' numbers swapped.
    expect(voxelAxisAlong(presetNormal('axial'), T1).axis).toBe(1);
    expect(voxelAxisAlong(presetNormal('coronal'), T1).axis).toBe(0);
    expect(voxelAxisAlong(presetNormal('sagittal'), T1).axis).toBe(2);
    // 1 mm voxels, so each step is 1 mm.
    for (const mode of ['axial', 'coronal', 'sagittal'] as SliceMode[]) {
      expect(voxelAxisAlong(presetNormal(mode), T1).mm).toBeCloseTo(1, 6);
    }
  });

  it('reports the slice index the reference volume actually has at its bbox centre', () => {
    // 256x256x208 => the centre voxel is (127.5, 127.5, 103.5); §8's corner rounds it.
    const centre: vec3 = [127.5, 127.5, 103.5];
    const indexOf = (mode: SliceMode): number =>
      Math.round(centre[voxelAxisAlong(presetNormal(mode), T1).axis]);
    expect(indexOf('axial')).toBe(128);
    expect(indexOf('coronal')).toBe(128);
    expect(indexOf('sagittal')).toBe(104);
  });

  it('falls back to the dominant axis for an oblique normal', () => {
    // normalize([1,1,1]) projects equally on world x, y and z; the affine's columns are unit axes,
    // so the tie is broken by order and the answer is still *an* axis rather than a hardcoded one.
    const { axis, mm } = voxelAxisAlong(presetNormal('oblique'), T1);
    expect([0, 1, 2]).toContain(axis);
    expect(mm).toBeCloseTo(1 / Math.sqrt(3), 6);
  });
});
