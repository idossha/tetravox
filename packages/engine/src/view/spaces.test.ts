/**
 * Coordinate-space arithmetic (`spaces.ts`), against **nibabel** and **SimNIBS**.
 *
 * §11 rule 2: every geometry function ships synthetic tests plus a real-data test gated by
 * `TETRAVOX_TESTDATA`. The synthetic half is here and always runs; the real-data half is
 * `spaces.realdata.test.ts`.
 *
 * Every expected number in the tkr block was produced by
 * `nibabel.freesurfer.mghformat.MGHHeader.from_header(nib.load(T1).header).get_vox2ras_tkr()` on
 * `m2m_ernie/T1.nii.gz` (256×256×208, 1 mm, the affine AGENTS.md pins), not by this implementation.
 */

import { describe, expect, it } from 'vitest';

import type { VolumeDataset, mat4, vec3 } from '../scene/types';
import { invert4, transformPoint } from './m4';
import {
  parseTextAffine,
  sampleDeformation,
  subjectToMniAffine,
  tkrToWorldMatrix,
  vox2rasTkr,
  worldToTkr,
  worldToTkrMatrix,
} from './spaces';

/** The `m2m_ernie/T1.nii.gz` affine, column-major (AGENTS.md "Affine reference"). */
const ERNIE_T1_AFFINE = Float32Array.from([
  0, -1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -99.737457, 154.1875, -143.642273, 1,
]) as mat4;

function volumeStub(
  dims: vec3,
  spacing: vec3,
  affine: mat4
): Pick<VolumeDataset, 'dims' | 'spacing' | 'affine' | 'inverseAffine'> {
  return { dims, spacing, affine, inverseAffine: invert4(affine) };
}

function rows(m: mat4): number[][] {
  return [0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((col) => m[col * 4 + row] as number));
}

describe('vox2rasTkr', () => {
  it('reproduces nibabel’s vox2ras_tkr for ernie’s T1 exactly', () => {
    // nibabel MGHHeader.get_vox2ras_tkr(), 256×256×208 @ 1 mm — max abs error 0.0 when measured.
    expect(rows(vox2rasTkr([256, 256, 208], [1, 1, 1]))).toEqual([
      [-1, 0, 0, 128],
      [0, 0, 1, -104],
      [0, -1, 0, 128],
      [0, 0, 0, 1],
    ]);
  });

  it('scales with anisotropic spacing and ignores the file affine entirely', () => {
    // The 0.5 mm `label_prep` pair: 512×512×416 @ 0.5 mm has the SAME tkr matrix translation as the
    // 1 mm volume, because the centre of the volume is the origin either way — which is exactly why
    // a tkr readout has to name the volume it belongs to.
    expect(rows(vox2rasTkr([512, 512, 416], [0.5, 0.5, 0.5]))).toEqual([
      [-0.5, 0, 0, 128],
      [0, 0, 0.5, -104],
      [0, -0.5, 0, 128],
      [0, 0, 0, 1],
    ]);
    // Anisotropic: dz drives the y row and dy the z row (Mdc_tkr permutes the axes).
    expect(rows(vox2rasTkr([4, 6, 8], [2, 3, 4]))).toEqual([
      [-2, 0, 0, 4],
      [0, 0, 4, -16],
      [0, -3, 0, 9],
      [0, 0, 0, 1],
    ]);
  });

  it('maps the volume centre to the tkr origin', () => {
    const c = transformPoint(vox2rasTkr([256, 256, 208], [1, 1, 1]), [128, 128, 104]);
    expect(c[0]).toBeCloseTo(0, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    expect(c[2]).toBeCloseTo(0, 6);
  });
});

describe('worldToTkr on ernie’s T1', () => {
  const ds = volumeStub([256, 256, 208], [1, 1, 1], ERNIE_T1_AFFINE);

  it('matches nibabel’s vox2ras_tkr · inv(affine)', () => {
    expect(rows(worldToTkrMatrix(ds)).map((r) => r.map((v) => Number(v.toFixed(4))))).toEqual([
      [0, 1, 0, -26.1875],
      [1, 0, 0, -4.2625],
      [0, 0, -1, -15.6423],
      [0, 0, 0, 1],
    ]);
  });

  it.each<[vec3, vec3]>([
    // python3: (pts @ (vox2ras_tkr @ inv(affine)).T)[:, :3]
    [
      [0, 0, 0],
      [-26.1875, -4.262543, -15.642273],
    ],
    [
      [-40, -20, 50],
      [-46.1875, -44.262543, -65.642273],
    ],
    [
      [30, 40, 10],
      [13.8125, 25.737457, -25.642273],
    ],
    [
      [-10, -90, 0],
      [-116.1875, -14.262543, -15.642273],
    ],
    [
      [5, 20, -30],
      [-6.1875, 0.737457, 14.357727],
    ],
  ])('world %j → tkr', (world, expected) => {
    const got = worldToTkr(ds, world);
    for (let i = 0; i < 3; i++) expect(got[i] as number).toBeCloseTo(expected[i] as number, 3);
  });

  it('round-trips through tkrToWorldMatrix — typed entry lands where it was read', () => {
    const world: vec3 = [-40, -20, 50];
    const back = transformPoint(tkrToWorldMatrix(ds), worldToTkr(ds, world));
    for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(world[i] as number, 3);
  });
});

describe('parseTextAffine', () => {
  it('reads a SimNIBS/FSL row-major 4×4 into a column-major mat4', () => {
    const m = parseTextAffine('1 0 0 10\n0 2 0 20\n0 0 3 30\n0 0 0 1\n') as mat4;
    expect(m).not.toBeNull();
    // Row-major in, column-major out: the translation is m[12..14].
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 10, 20, 30, 1]);
    expect(transformPoint(m, [1, 1, 1])).toEqual([11, 22, 33]);
  });

  it('tolerates comments, blank lines, tabs, commas and scientific notation', () => {
    const m = parseTextAffine(
      '# MNI2conform_12DOF.txt\n\n0.99,\t0, 0, -1.5e0\n0 1 0 2\n0 0 1 3\n0 0 0 1'
    ) as mat4;
    expect(m).not.toBeNull();
    expect(m[0]).toBeCloseTo(0.99, 6);
    expect(m[12]).toBeCloseTo(-1.5, 6);
  });

  it.each([
    ['too few numbers', '1 0 0 0\n0 1 0 0\n0 0 1 0'],
    ['too many numbers', '1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n1'],
    ['a non-number token', '1 0 0 0\n0 1 0 0\n0 0 1 nan\n0 0 0 1'],
    ['empty', ''],
  ])('rejects %s rather than half-reading a registration', (_name, text) => {
    expect(parseTextAffine(text)).toBeNull();
  });
});

describe('subjectToMniAffine', () => {
  it('is the inverse of the file, which is MNI → subject', () => {
    // A 12-DOF-shaped matrix: scale + shear + translation. The file maps MNI → subject, so applying
    // the file to an MNI point must undo what `subjectToMniAffine` did to the subject point.
    const mni2conform = parseTextAffine(
      '1.05 0.02 0 -2\n-0.01 0.98 0.03 5\n0 0.04 1.10 -7\n0 0 0 1'
    ) as mat4;
    const sub2mni = subjectToMniAffine(mni2conform);
    const mni: vec3 = [-12, 34, 56];
    const subject = transformPoint(mni2conform, mni);
    const back = transformPoint(sub2mni, subject);
    for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(mni[i] as number, 2);
  });
});

describe('sampleDeformation', () => {
  /**
   * A 2×2×2 field on a 1 mm grid at the origin whose three volumes hold `2x`, `y + 10`, `-z`, i.e.
   * an exactly-linear target map — trilinear interpolation is exact on it, so any interior point has
   * a closed-form expectation and the test asserts the *interpolation*, not a tolerance.
   */
  function linearField(): VolumeDataset {
    const dims: vec3 = [2, 2, 2];
    const data = new Float32Array(2 * 2 * 2 * 3);
    for (let k = 0; k < 2; k++) {
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const idx = (k * 2 + j) * 2 + i;
          data[idx] = 2 * i;
          data[8 + idx] = j + 10;
          data[16 + idx] = -k;
        }
      }
    }
    const affine = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as mat4;
    return {
      dims,
      nvols: 3,
      affine,
      inverseAffine: invert4(affine),
      data,
      sclSlope: 1,
      sclInter: 0,
    } as unknown as VolumeDataset;
  }

  it('is exact on a linear field', () => {
    const f = linearField();
    expect(sampleDeformation(f, [0, 0, 0])).toEqual([0, 10, 0]);
    expect(sampleDeformation(f, [1, 1, 1])).toEqual([2, 11, -1]);
    const mid = sampleDeformation(f, [0.5, 0.25, 0.75]) as vec3;
    expect(mid[0]).toBeCloseTo(1, 6);
    expect(mid[1]).toBeCloseTo(10.25, 6);
    expect(mid[2]).toBeCloseTo(-0.75, 6);
  });

  it('clamps outside the field, the way SimNIBS’s mode="nearest" does', () => {
    const f = linearField();
    // −5 mm and +5 mm are far outside a 2-voxel field; both return the transform of the closest
    // point inside it, never NaN and never an extrapolation.
    expect(sampleDeformation(f, [-5, -5, -5])).toEqual([0, 10, 0]);
    expect(sampleDeformation(f, [5, 5, 5])).toEqual([2, 11, -1]);
  });

  it('applies scl_slope / scl_inter, which §3 keeps out of the samples', () => {
    const f = linearField();
    const scaled = { ...f, sclSlope: 2, sclInter: 1 } as VolumeDataset;
    expect(sampleDeformation(scaled, [1, 1, 1])).toEqual([5, 23, -1]);
  });

  it('refuses a volume that is not a 3-component field', () => {
    const f = linearField();
    expect(sampleDeformation({ ...f, nvols: 1 } as VolumeDataset, [0, 0, 0])).toBeNull();
  });
});
