/**
 * The real-data half of §11 rule 2 for `spaces.ts`: our MNI mapping against **SimNIBS itself**.
 *
 * Skips (never fails) without `TETRAVOX_TESTDATA` — AGENTS.md's rule for real data.
 *
 * ```
 * export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
 * ```
 *
 * **Where the expected numbers come from.** `scripts/refvalues/mni_refvalues.py`, run under
 * `/Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python`, calls
 * `simnibs.utils.transformations.subject2mni_coords` / `mni2subject_coords` — the reference
 * implementation, not this one — on five landmarks. Re-run it to reproduce; do not retype these
 * from memory (AGENTS.md).
 *
 * **The affine leg is a documented absence, not a gap in coverage.** SimNIBS 4's `charm` writes only
 * the two nonlinear fields into `m2m_ernie/toMNI/`; `MNI2conform_6DOF.txt` / `MNI2conform_12DOF.txt`
 * are a SimNIBS-3 / `headreco` artefact and are **not present in this dataset** `[DATA]` —
 * `subject2mni_coords(..., transformation_type='12dof')` raises `FileNotFoundError` on it. So the
 * affine path is asserted here on its *semantics* (that a `MNI2conform_*DOF.txt` is inverted for
 * subject→MNI, tested against a synthetic matrix in `spaces.test.ts`) and this file asserts the
 * nonlinear path, which is the one ernie actually carries. Point this test at a `headreco` subject
 * and the affine leg would run too — that is why the discovery code reads the files at all.
 *
 * **The NIfTI reader in this file is test-only.** The engine reads volumes in Rust (§6.1) through a
 * worker, which a node unit test has no way to drive; and §12.3 freezes the dependency set, so no
 * `nifti-reader` package may be added. Sixty lines of `DataView` over the fixed 348-byte NIfTI-1
 * header is the whole of it, and it is deliberately *not* exported: nothing outside this test may
 * grow a second volume reader.
 */

import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { VolumeDataset, mat4, vec3 } from '../scene/types';
import { invert4 } from './m4';
import { sampleDeformation } from './spaces';

const ROOT = process.env.TETRAVOX_TESTDATA;
const M2M = ROOT === undefined ? null : join(ROOT, 'm2m_ernie');
const CONF2MNI = M2M === null ? null : join(M2M, 'toMNI', 'Conform2MNI_nonl.nii.gz');
const MNI2CONF = M2M === null ? null : join(M2M, 'toMNI', 'MNI2Conform_nonl.nii.gz');
const have = CONF2MNI !== null && MNI2CONF !== null && existsSync(CONF2MNI) && existsSync(MNI2CONF);

/** The five landmarks the reference script used, in subject world mm. */
const LANDMARKS: vec3[] = [
  [0, 0, 0],
  [-40, -20, 50],
  [30, 40, 10],
  [-10, -90, 0],
  [5, 20, -30],
];

/** `subject2mni_coords(LANDMARKS, m2m_ernie, transformation_type='nonl')` — SimNIBS 4.6. */
const SIMNIBS_MNI_NONL: vec3[] = [
  [-1.5131770372390747, -28.01997947692871, -12.62722110748291],
  [-43.192256927490234, -41.09191131591797, 47.252071380615234],
  [29.011333465576172, 11.717751502990723, -6.161109924316406],
  [-10.49146556854248, -116.5941162109375, 3.4597511291503906],
  [5.283070087432861, -11.250802040100098, -48.78440856933594],
];

/**
 * `mni2subject_coords(SIMNIBS_MNI_NONL, m2m_ernie, transformation_type='nonl')` — the return leg.
 *
 * Quoted to six decimals. The assertions below are `toBeCloseTo(…, 3)` — 1e-3 mm, three orders
 * tighter than the 2.0e-2 mm SimNIBS's own round trip loses — so the digits beyond are noise, and
 * writing them out only trips `no-loss-of-precision`. `scripts/refvalues/mni_refvalues.py` prints
 * them at full width.
 */
const SIMNIBS_BACK: vec3[] = [
  [0.000494, -0.000457, 0.001305],
  [-39.998306, -19.994381, 50.000797],
  [30.000902, 40.004757, 9.999962],
  [-9.999774, -90.001129, -0.000343],
  [5.00247, 19.980223, -29.994766],
];

/**
 * Minimal NIfTI-1 reader, test-only (see the file header). Handles exactly what these two files are:
 * single-file `n+1`, little-endian, `sform_code > 0`, float32 or float64, no `.hdr/.img` pair.
 */
function readNifti(path: string): VolumeDataset {
  const raw = readFileSync(path);
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, true) !== 348) throw new Error(`${path}: not a little-endian NIfTI-1 header`);

  const ndim = dv.getInt16(40, true);
  const dim = [1, 2, 3, 4].map((i) => (i <= ndim ? dv.getInt16(40 + i * 2, true) : 1));
  const dims: vec3 = [dim[0] as number, dim[1] as number, dim[2] as number];
  const nvols = dim[3] as number;
  const datatype = dv.getInt16(70, true);
  const slope0 = dv.getFloat32(112, true);
  const inter = dv.getFloat32(116, true);
  // §6.1's NaN guard, and "slope 0 means no scaling" from the NIfTI-1 spec.
  const sclSlope = Number.isFinite(slope0) && slope0 !== 0 ? slope0 : 1;
  const sclInter = Number.isFinite(inter) ? inter : 0;
  const voxOffset = Math.max(352, Math.trunc(dv.getFloat32(108, true)));

  if (dv.getInt16(254, true) <= 0) throw new Error(`${path}: no sform`);
  // srow_x/y/z are three ROWS of the 4×4; §3's `mat4` is column-major.
  const affine = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      affine[col * 4 + row] = dv.getFloat32(280 + row * 16 + col * 4, true);
    }
  }
  affine[15] = 1;

  const n = dims[0] * dims[1] * dims[2] * nvols;
  let data: Float32Array | Float64Array;
  if (datatype === 16) data = new Float32Array(buf.buffer, buf.byteOffset + voxOffset, n).slice();
  else if (datatype === 64)
    data = new Float64Array(buf.buffer, buf.byteOffset + voxOffset, n).slice();
  else throw new Error(`${path}: unsupported test datatype ${datatype}`);

  return {
    dims,
    nvols,
    affine: affine as mat4,
    inverseAffine: invert4(affine as mat4),
    data,
    sclSlope,
    sclInter,
  } as unknown as VolumeDataset;
}

describe.skipIf(!have)('MNI (nonlinear) against simnibs.transformations on ernie', () => {
  // 97 MB and 230 MB gzipped; read once for the whole suite — and in `beforeAll`, not in the
  // describe body: vitest *evaluates* a skipped describe's body, so a top-level read would throw
  // on every machine without the dataset, which is the opposite of "skips, never fails".
  let forward: VolumeDataset;
  let inverse: VolumeDataset;
  beforeAll(() => {
    forward = readNifti(CONF2MNI as string);
    inverse = readNifti(MNI2CONF as string);
  });

  it('reads the two deformation fields with the shapes SimNIBS wrote', () => {
    // `[DATA]`, nibabel: Conform2MNI_nonl is the T1's own grid; MNI2Conform_nonl is the MNI grid.
    expect(Array.from(forward.dims)).toEqual([256, 256, 208]);
    expect(forward.nvols).toBe(3);
    expect(Array.from(inverse.dims)).toEqual([182, 238, 282]);
    expect(inverse.nvols).toBe(3);
    // Conform2MNI_nonl carries the T1 affine verbatim (AGENTS.md's "Affine reference").
    expect(forward.affine[12]).toBeCloseTo(-99.737457, 4);
    expect(forward.affine[13]).toBeCloseTo(154.1875, 4);
    expect(forward.affine[14]).toBeCloseTo(-143.642273, 4);
  });

  it.each(LANDMARKS.map((p, i) => [p, SIMNIBS_MNI_NONL[i] as vec3] as const))(
    'subject %j → MNI matches subject2mni_coords',
    (world, expected) => {
      const got = sampleDeformation(forward, world) as vec3;
      expect(got).not.toBeNull();
      // 1e-3 mm: both sides are trilinear over the same float32 field, so the only difference is
      // float32-vs-float64 accumulation. A looser bound would hide a wrong voxel index.
      for (let i = 0; i < 3; i++) expect(got[i] as number).toBeCloseTo(expected[i] as number, 3);
    }
  );

  it.each(SIMNIBS_MNI_NONL.map((p, i) => [p, SIMNIBS_BACK[i] as vec3] as const))(
    'MNI %j → subject matches mni2subject_coords',
    (mni, expected) => {
      const got = sampleDeformation(inverse, mni) as vec3;
      expect(got).not.toBeNull();
      for (let i = 0; i < 3; i++) expect(got[i] as number).toBeCloseTo(expected[i] as number, 3);
    }
  );

  it('round-trips a landmark through both fields to within SimNIBS’s own error', () => {
    // Typed entry in "MNI (nonlinear)" is a forward sample of the *inverse* field, so this is the
    // accuracy the coordinate bar gives, end to end. SimNIBS itself returns to 2.0e-2 mm here.
    for (const world of LANDMARKS) {
      const mni = sampleDeformation(forward, world) as vec3;
      const back = sampleDeformation(inverse, mni) as vec3;
      for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(world[i] as number, 1);
    }
  });

  it('clamps far outside the field instead of returning NaN', () => {
    const far = sampleDeformation(forward, [1e4, -1e4, 1e4]) as vec3;
    expect(far.every((c) => Number.isFinite(c))).toBe(true);
  });
});
