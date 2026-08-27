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
    // Recorded rather than assumed. §3 fixes both `right = cross(up, normal)` and the preset
    // normals, and the two together make the **coronal** pane mirror the axial one on laterality:
    // axial puts R on the right, coronal puts L there. Both are real cameras — the coronal preset is
    // the "looking at the face" view — and the letters say so, which is the whole point of deriving
    // them. See docs/DECISIONS.md (2026-08-27); Phase 2 owns whether the preset should change.
    expect(edgeLetters(basisOf('axial', false))).toEqual({
      left: 'L',
      right: 'R',
      top: 'A',
      bottom: 'P',
    });
    expect(edgeLetters(basisOf('coronal', false))).toEqual({
      left: 'R',
      right: 'L',
      top: 'S',
      bottom: 'I',
    });
    expect(edgeLetters(basisOf('sagittal', false))).toEqual({
      left: 'P',
      right: 'A',
      top: 'S',
      bottom: 'I',
    });
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
