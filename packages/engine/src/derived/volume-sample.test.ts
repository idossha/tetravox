/**
 * §4.3's third read shape, against closed forms (§11 rule 0).
 *
 * The fixture is a **linear ramp**, `f(x, y, z) = a·x + b·y + c·z + d` sampled on the grid, and it
 * is the fixture because trilinear interpolation reproduces a linear function *exactly* at every
 * point of every cell. So every expected number below is the ramp evaluated on the page — arithmetic
 * a reader redoes without running the code — rather than a number this file's own implementation
 * produced. A bilinear-instead-of-trilinear bug, a transposed axis, a `slope` applied twice and an
 * off-by-one in the cell corners each break that identity somewhere the assertions look.
 *
 * The nearest-neighbour half is checked against the grid values themselves, which is the other thing
 * a caller can verify by hand.
 */

import { describe, expect, it } from 'vitest';

import { MAX_SAMPLE_POINTS, SampleVolumeError, sampleVolumeAt } from './volume-sample';
import { invert4 } from '../view/m4';
import type { VolumeDataset, mat4 } from '../scene/types';

/** A dataset over `values`, `i` fastest, with a diagonal affine — `voxel-box.test.ts`'s builder. */
function volume(
  dims: [number, number, number],
  values: ArrayLike<number>,
  opts: {
    spacing?: [number, number, number];
    origin?: [number, number, number];
    sclSlope?: number;
    sclInter?: number;
    dtype?: VolumeDataset['dtype'];
    nvols?: number;
  } = {}
): VolumeDataset {
  const spacing = opts.spacing ?? [1, 1, 1];
  const origin = opts.origin ?? [0, 0, 0];
  const affine = new Float32Array(16);
  affine[0] = spacing[0];
  affine[5] = spacing[1];
  affine[10] = spacing[2];
  affine[12] = origin[0];
  affine[13] = origin[1];
  affine[14] = origin[2];
  affine[15] = 1;
  return {
    kind: 'volume',
    dims,
    nvols: opts.nvols ?? 1,
    spacing,
    affine: affine as unknown as mat4,
    inverseAffine: invert4(affine as unknown as mat4),
    data: Float32Array.from(values),
    sclSlope: opts.sclSlope ?? 1,
    sclInter: opts.sclInter ?? 0,
    dtype: opts.dtype ?? 'f32',
  } as unknown as VolumeDataset;
}

/** The ramp, in **voxel indices**: `f(i, j, k) = 2i + 3j + 5k + 7`. */
const ramp = (i: number, j: number, k: number): number => 2 * i + 3 * j + 5 * k + 7;

/** An 8×8×8 ramp volume. `spacing`/`origin` map world mm onto those indices. */
function rampVolume(opts: Parameters<typeof volume>[2] = {}): VolumeDataset {
  const dims: [number, number, number] = [8, 8, 8];
  const values = new Float32Array(8 * 8 * 8);
  for (let k = 0; k < 8; k += 1) {
    for (let j = 0; j < 8; j += 1) {
      for (let i = 0; i < 8; i += 1) values[(k * 8 + j) * 8 + i] = ramp(i, j, k);
    }
  }
  return volume(dims, values, opts);
}

describe('sampleVolumeAt', () => {
  it('reproduces a linear ramp EXACTLY at off-grid points (order 1)', () => {
    // spacing 1, origin 0 ⇒ world mm *are* voxel indices, so the ramp is checkable on the page.
    const ds = rampVolume();
    // prettier-ignore
    const points = Float32Array.from([
      0, 0, 0,          // a grid point: 7
      1, 2, 3,          // a grid point: 2 + 6 + 15 + 7 = 30
      0.5, 0, 0,        // half a cell along i: 7 + 1 = 8
      0, 0.25, 0,       // 7 + 0.75 = 7.75
      0, 0, 0.125,      // 7 + 0.625 = 7.625
      1.5, 2.5, 3.5,    // 3 + 7.5 + 17.5 + 7 = 35
      7, 7, 7,          // the far corner, on the face: 14 + 21 + 35 + 7 = 77
    ]);
    const got = sampleVolumeAt(ds, points);
    const want = [7, 30, 8, 7.75, 7.625, 35, 77];
    expect(got.length).toBe(want.length);
    for (const [n, expected] of want.entries()) {
      expect(got[n]).toBeCloseTo(expected, 5);
    }
  });

  it('applies spacing, origin, slope and intercept exactly once', () => {
    // World → index is `(w − origin) / spacing`, so world (−4, −4, −4) is index 0 and world 0 is
    // index 2 on each axis: f(2, 2, 2) = 4 + 6 + 10 + 7 = 27. Then × 10 + 1000 = 1270.
    const ds = rampVolume({
      spacing: [2, 2, 2],
      origin: [-4, -4, -4],
      sclSlope: 10,
      sclInter: 1000,
    });
    const got = sampleVolumeAt(ds, Float32Array.from([-4, -4, -4, 0, 0, 0, 1, 0, 0]));
    expect(got[0]).toBeCloseTo(7 * 10 + 1000, 4); // f(0,0,0) = 7
    expect(got[1]).toBeCloseTo(27 * 10 + 1000, 4);
    // World x = 1 is index 2.5: f(2.5, 2, 2) = 5 + 6 + 10 + 7 = 28.
    expect(got[2]).toBeCloseTo(28 * 10 + 1000, 4);
  });

  it('order 0 answers the grid value of the HALF-UP nearest voxel', () => {
    const ds = rampVolume();
    // prettier-ignore
    const probes = Float32Array.from([
      1.4, 2.4, 3.4,    // → (1, 2, 3) = 30
      1.5, 2.5, 3.5,    // half-up → (2, 3, 4) = 4 + 9 + 20 + 7 = 40
      0.6, 0, 0,        // → (1, 0, 0) = 9
    ]);
    const got = sampleVolumeAt(ds, probes, { order: 0 });
    expect([...got]).toEqual([30, 40, 9]);
  });

  it('is NaN outside the volume, and never clamped to the face', () => {
    const ds = rampVolume();
    // prettier-ignore
    const outside = Float32Array.from([
      -0.001, 0, 0,
      0, 0, 7.001,
      40, 40, 40,
      Number.NaN, 0, 0,
    ]);
    const got = sampleVolumeAt(ds, outside);
    for (const value of got) expect(Number.isNaN(value)).toBe(true);
    // The face itself is inside, so the refusal above is a boundary rule and not a shrunken volume.
    expect(sampleVolumeAt(ds, Float32Array.from([7, 7, 7]))[0]).toBeCloseTo(77, 5);
  });

  it('selects the frame of a 4-D volume', () => {
    const dims: [number, number, number] = [2, 2, 2];
    const values = new Float32Array(16);
    values.fill(1, 0, 8);
    values.fill(9, 8, 16);
    const ds = volume(dims, values, { nvols: 2 });
    expect(sampleVolumeAt(ds, Float32Array.from([0.5, 0.5, 0.5]))[0]).toBeCloseTo(1, 5);
    expect(
      sampleVolumeAt(ds, Float32Array.from([0.5, 0.5, 0.5]), { volumeIndex: 1 })[0]
    ).toBeCloseTo(9, 5);
  });

  it('answers all-NaN, not an exception, for a volume with no scalar to give', () => {
    const ds = rampVolume({ dtype: 'rgb24' });
    const got = sampleVolumeAt(ds, Float32Array.from([1, 1, 1, 2, 2, 2]));
    expect(got.length).toBe(2);
    for (const value of got) expect(Number.isNaN(value)).toBe(true);
  });

  it('refuses a length that is not whole triples, and more than the cap', () => {
    const ds = rampVolume();
    expect(() => sampleVolumeAt(ds, Float32Array.from([1, 2]))).toThrow(SampleVolumeError);
    // The cap is checked BEFORE any allocation of the answer, so this costs nothing to assert.
    const tooMany = { length: (MAX_SAMPLE_POINTS + 1) * 3 } as unknown as Float32Array;
    expect(() => sampleVolumeAt(ds, tooMany)).toThrow(/exceeds the 2000000-point cap/);
  });
});
