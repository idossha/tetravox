/**
 * The real-data half of AGENTS.md rule 2 for §4.3's bounded local reads.
 *
 * Skips (never fails) without `TETRAVOX_TESTDATA` — AGENTS.md's rule for real data.
 *
 * ```
 * export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
 * ```
 *
 * **Where the expected numbers come from.** `scripts/refvalues/voxelbox_refvalues.py` — nibabel and
 * a numpy implementation of the rule, written from the spec — over `m2m_ernie/T1.nii.gz`. Re-run it
 * to reproduce; never retype a number here from memory or from an older revision (AGENTS.md).
 *
 * **Why this file, when `voxel-box.test.ts` already checks the same two functions against numpy on a
 * synthetic phantom.** Because the phantom is a diagonal affine and int16, and the T1 is neither: it
 * is **float32 with a maximum of exactly 65535** — the very value that keeps R16F out of §6.1's
 * ladder — with a real, non-diagonal sform. A box built from `dims` and `spacing` instead of from
 * the inverse affine is right on the phantom and wrong here, and a `Float32Array` accumulator would
 * lose the top of that range. 1 mm spacing also makes the half-extent `max(int(radius), 1)` on all
 * three axes, so an axis mix-up is invisible in the box's *shape* and loud in its *values* — which
 * is exactly the case the phantom's anisotropic spacing cannot produce.
 *
 * One query, `default-radius`, uses the sEEG module's own 1.5 mm (2026-08-30). Every other radius
 * here is an integer, and on 1 mm spacing an integer radius makes `ceil` and Slicer's
 * `max(trunc(r / s), 1)` the same number — so without it this file could not tell the two apart at
 * all. At 1.5 mm they are a 3-voxel box and a 5-voxel one.
 *
 * **The NIfTI reader here is test-only**, like `view/spaces.realdata.test.ts`'s and
 * `voxel-box.test.ts`'s: the engine reads volumes in Rust through a worker (§6.1), which a node test
 * cannot drive, and §12.3 freezes the dependency set. It is checked against the reference file's own
 * nibabel record before it is trusted.
 */

import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { peakCentroid, sampleVoxelBox } from './voxel-box';
import { invert4 } from '../view/m4';
import type { VolumeDataset, mat4, vec3 } from '../scene/types';

interface RefCase {
  name: string;
  world: [number, number, number];
  radiusMm: number;
  box: {
    ijk0: [number, number, number];
    dims: [number, number, number];
    voxelCount: number;
    valueMin: number;
    valueMax: number;
    valueSum: number;
    spotValues: { offset: [number, number, number]; value: number }[];
  } | null;
  peakCentroidWorld: [number, number, number] | null;
}

interface RefValues {
  dims: number[];
  spacing: number[];
  affine: number[][];
  sclSlopeOnDisk: number;
  sclInterOnDisk: number;
  cases: RefCase[];
}

const REF = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../scripts/refvalues/voxelbox_refvalues.json', import.meta.url)
    ),
    'utf8'
  )
) as RefValues;

const ROOT = process.env.TETRAVOX_TESTDATA;
const T1 = ROOT === undefined ? null : join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const have = T1 !== null && existsSync(T1) && Array.isArray(REF.cases);

/**
 * Minimal NIfTI-1 reader, test-only (see the file header). Handles exactly what this file is:
 * single-file `n+1`, little-endian, `sform_code > 0`, float32. Not exported — nothing outside a
 * test may grow a second volume reader.
 */
function readTestNifti(path: string): VolumeDataset {
  const raw = readFileSync(path);
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, true) !== 348) throw new Error(`${path}: not a little-endian NIfTI-1`);

  const dims: vec3 = [dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)];
  const datatype = dv.getInt16(70, true);
  if (datatype !== 16) throw new Error(`${path}: this test reads float32 only, not ${datatype}`);
  const spacing: vec3 = [dv.getFloat32(80, true), dv.getFloat32(84, true), dv.getFloat32(88, true)];
  const slope0 = dv.getFloat32(112, true);
  const inter = dv.getFloat32(116, true);
  // §6.1's NaN guard, and "slope 0 means no scaling" from the NIfTI-1 spec.
  const sclSlope = Number.isFinite(slope0) && slope0 !== 0 ? slope0 : 1;
  const sclInter = Number.isFinite(inter) ? inter : 0;
  const voxOffset = Math.max(352, Math.trunc(dv.getFloat32(108, true)));
  if (dv.getInt16(254, true) <= 0) throw new Error(`${path}: no sform`);

  // srow_x/y/z are three ROWS of the 4×4; §3's `mat4` is column-major.
  const affine = new Float32Array(16);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      affine[col * 4 + row] = dv.getFloat32(280 + row * 16 + col * 4, true);
    }
  }
  affine[15] = 1;

  const n = dims[0] * dims[1] * dims[2];
  const data = new Float32Array(buf.buffer, buf.byteOffset + voxOffset, n).slice();
  return {
    kind: 'volume',
    dims,
    nvols: 1,
    spacing,
    affine: affine as unknown as mat4,
    inverseAffine: invert4(affine as unknown as mat4),
    data,
    sclSlope,
    sclInter,
    dtype: 'f32',
  } as unknown as VolumeDataset;
}

describe.skipIf(!have)('bounded local reads on ernie T1.nii.gz, against numpy', () => {
  // 13 MB gzipped; read once for the whole suite, and in `beforeAll` rather than in the describe
  // body — vitest *evaluates* a skipped describe's body, so a top-level read would throw on every
  // machine without the dataset, which is the opposite of "skips, never fails".
  let ds: VolumeDataset;
  beforeAll(() => {
    ds = readTestNifti(T1 as string);
  });

  it('the test-only reader agrees with nibabel about the geometry', () => {
    // First, so a bug in the reader above cannot masquerade as a bug in `voxel-box.ts`.
    expect([...ds.dims]).toEqual(REF.dims);
    expect(ds.sclSlope).toBeCloseTo(REF.sclSlopeOnDisk, 6);
    expect(ds.sclInter).toBeCloseTo(REF.sclInterOnDisk, 6);
    for (let a = 0; a < 3; a += 1) {
      expect(ds.spacing[a]).toBeCloseTo(REF.spacing[a] as number, 4);
      for (let row = 0; row < 3; row += 1) {
        expect(ds.affine[a * 4 + row]).toBeCloseTo((REF.affine[row] as number[])[a] as number, 4);
      }
    }
  });

  it('reads the file §6.1 keeps R16F out of the ladder for', () => {
    // AGENTS.md: "float32, max exactly 65535.0". A box near the brightest voxel must carry it
    // intact — an accumulator or a copy that quantised would show up here and nowhere else.
    const capped = REF.cases.find((c) => c.name === 'capped-radius');
    expect(capped?.box).toBeTruthy();
    const box = sampleVoxelBox(ds, capped!.world, capped!.radiusMm)!;
    let max = -Infinity;
    for (const v of box.values) max = Math.max(max, v);
    expect(max).toBeCloseTo(capped!.box!.valueMax, 4);
  });

  for (const c of REF.cases) {
    it(`sampleVoxelBox matches numpy — ${c.name}`, () => {
      const box = sampleVoxelBox(ds, c.world, c.radiusMm);
      if (c.box === null) {
        expect(box).toBeNull();
        return;
      }
      expect(box).not.toBeNull();
      expect(box!.ijk0).toEqual(c.box.ijk0);
      expect(box!.dims).toEqual(c.box.dims);
      expect(box!.values.length).toBe(c.box.voxelCount);

      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const v of box!.values) {
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
      }
      expect(min).toBeCloseTo(c.box.valueMin, 4);
      expect(max).toBeCloseTo(c.box.valueMax, 4);
      // A T1 box sums into the millions, so the tolerance is relative: 1e-9 of the total, which is
      // float64 round-off over 30k terms and nothing else.
      expect(Math.abs(sum - c.box.valueSum)).toBeLessThan(Math.abs(c.box.valueSum) * 1e-9 + 1e-6);
      // The sums above would survive a transposed window; these five will not.
      for (const spot of c.box.spotValues) {
        const [i, j, k] = spot.offset;
        const o = (k * box!.dims[1] + j) * box!.dims[0] + i;
        expect(box!.values[o], `spot ${spot.offset.join(',')}`).toBeCloseTo(spot.value, 4);
      }
    });

    it(`peakCentroid matches numpy — ${c.name}`, () => {
      const got = peakCentroid(ds, c.world, c.radiusMm);
      if (c.peakCentroidWorld === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      // Two implementations of one rule over one file. The tolerance is 1e-3 mm — three orders
      // under a voxel — and covers only the float32 affine this reader uses against numpy's float64.
      for (let a = 0; a < 3; a += 1) {
        expect(got![a]).toBeCloseTo(c.peakCentroidWorld[a] as number, 3);
      }
    });
  }

  it('a peak is inside the box it was found in', () => {
    // The property, independent of any reference: a weighted centroid of points inside a window
    // cannot land outside it. It is the one thing that would still be true if both implementations
    // shared a bug in the *weights*, and false the moment either one mixes up index and world space.
    for (const c of REF.cases) {
      if (c.box === null || c.peakCentroidWorld === null) continue;
      const got = peakCentroid(ds, c.world, c.radiusMm)!;
      const d = Math.hypot(got[0] - c.world[0], got[1] - c.world[1], got[2] - c.world[2]);
      // The box's own half-diagonal, plus a voxel for the rounding of its centre.
      const half = c.radiusMm * Math.sqrt(3) + 1;
      expect(d, `${c.name} moved ${d.toFixed(3)} mm`).toBeLessThanOrEqual(half);
    }
  });
});
