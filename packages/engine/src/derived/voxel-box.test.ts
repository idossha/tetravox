/**
 * §4.3's bounded local reads, against numpy (§11 rule 0 and AGENTS.md "Test data").
 *
 * Two halves, and they check different things.
 *
 * **Closed forms**, on datasets built by hand: a constant volume has no peak, a single bright voxel
 * is its own centroid, a symmetric pair centres between them, slope and intercept are applied
 * exactly once, and the box's half-extent is per axis. Every expected number here is arithmetic a
 * reader can redo on the page.
 *
 * **`testdata/ct_shafts.nii.gz`**, against `testdata/manifest.json`. The manifest's numbers were
 * produced by `scripts/gen-fixtures.py`'s verification half — **nibabel loading the file back** and
 * a numpy implementation of the rule written from the spec — never by the writer that made the
 * fixture (§11). So the agreement asserted below is between two independent implementations of
 * `peakCentroid` reading the same bytes, not between this code and itself. The phantom is three
 * depth electrodes at a 3.5 mm contact pitch, oblique to every axis, on a volume whose spacing is
 * anisotropic on purpose: `ceil(1.5 / spacing)` is 4, 3 and 2 voxels, so a box that used one
 * spacing for all three axes is right on an isotropic volume and wrong here.
 *
 * **The NIfTI reader in this file is test-only**, exactly as `view/spaces.realdata.test.ts` says of
 * its own: the engine reads volumes in Rust through a worker (§6.1), which a node test cannot drive,
 * and §12.3 freezes the dependency set. It is checked against the manifest's own nibabel record
 * before anything else is asserted, so a bug in it fails loudly here instead of quietly excusing a
 * bug in `voxel-box.ts`.
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_BOX_VOXELS, peakCentroid, sampleVoxelBox } from './voxel-box';
import { invert4 } from '../view/m4';
import type { VolumeDataset, mat4, vec3 } from '../scene/types';

const TESTDATA = fileURLToPath(new URL('../../../../testdata/', import.meta.url));

// -------------------------------------------------------------------------------------------
// Hand-built datasets — the closed forms
// -------------------------------------------------------------------------------------------

/** A dataset over `values`, `i` fastest, with a diagonal affine. Only the fields these two read. */
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

/** `i` fastest — the same order `VolumeDataset.data` and `VoxelBox.values` are in. */
const index = (dims: [number, number, number], i: number, j: number, k: number): number =>
  (k * dims[1] + j) * dims[0] + i;

describe('sampleVoxelBox', () => {
  it('takes a box of ceil(radius / spacing) voxels PER AXIS', () => {
    const dims: [number, number, number] = [21, 21, 21];
    const ds = volume(dims, new Float32Array(21 * 21 * 21), {
      spacing: [0.4, 0.5, 0.8],
      origin: [-4, -5, -8],
    });
    // The centre voxel is (10, 10, 10) = world (0, 0, 0). ceil(1.5/0.4)=4, ceil(1.5/0.5)=3,
    // ceil(1.5/0.8)=2, so the box is 9 x 7 x 5 and starts six, three and two voxels back.
    const box = sampleVoxelBox(ds, [0, 0, 0], 1.5);
    expect(box).not.toBeNull();
    expect(box!.ijk0).toEqual([6, 7, 8]);
    expect(box!.dims).toEqual([9, 7, 5]);
    expect(box!.values.length).toBe(9 * 7 * 5);
  });

  it('clips the box to the volume rather than reading outside it', () => {
    const dims: [number, number, number] = [5, 5, 5];
    const ds = volume(dims, new Float32Array(125));
    const box = sampleVoxelBox(ds, [0, 0, 0], 2);
    expect(box!.ijk0).toEqual([0, 0, 0]);
    // Two voxels each way from index 0, clipped at the low face: three, not five.
    expect(box!.dims).toEqual([3, 3, 3]);
  });

  it('is null outside the volume — a snap must refuse, never clamp', () => {
    const ds = volume([5, 5, 5], new Float32Array(125));
    // Rounding: index -0.5 rounds to 0 and is inside; -0.6 rounds to -1 and is not.
    expect(sampleVoxelBox(ds, [-0.5, 0, 0], 1)).not.toBeNull();
    expect(sampleVoxelBox(ds, [-0.6, 0, 0], 1)).toBeNull();
    expect(sampleVoxelBox(ds, [4.6, 0, 0], 1)).toBeNull();
    expect(sampleVoxelBox(ds, [0, 0, 100], 1)).toBeNull();
  });

  it('refuses rgb24 and rgba32 — "the value at this voxel" is not defined for them', () => {
    const rgb = volume([4, 4, 4], new Float32Array(64), { dtype: 'rgb24' });
    const rgba = volume([4, 4, 4], new Float32Array(64), { dtype: 'rgba32' });
    expect(sampleVoxelBox(rgb, [1, 1, 1], 1)).toBeNull();
    expect(sampleVoxelBox(rgba, [1, 1, 1], 1)).toBeNull();
    expect(peakCentroid(rgb, [1, 1, 1], 1)).toBeNull();
    // …and the same volume as a scalar is fine, so the refusal is about the dtype and nothing else.
    expect(sampleVoxelBox(volume([4, 4, 4], new Float32Array(64)), [1, 1, 1], 1)).not.toBeNull();
  });

  it('applies scl_slope and scl_inter exactly once', () => {
    const dims: [number, number, number] = [3, 1, 1];
    const ds = volume(dims, [0, 100, 200], { sclSlope: 2.5, sclInter: -100 });
    const box = sampleVoxelBox(ds, [1, 0, 0], 0.5);
    // physical = raw * 2.5 − 100, the §6.1 rule: −100, 150, 400.
    expect([...box!.values]).toEqual([-100, 150, 400]);
  });

  it('caps the box at MAX_BOX_VOXELS on an axis, whatever the radius', () => {
    const n = 64;
    const dims: [number, number, number] = [n, n, n];
    const ds = volume(dims, new Float32Array(n * n * n), { spacing: [0.1, 0.1, 0.1] });
    // 40 mm at 0.1 mm/voxel would be 801 voxels an axis — a 512 M-voxel read in a pointer handler.
    const box = sampleVoxelBox(ds, [3.2, 3.2, 3.2], 40);
    expect(box!.dims[0]).toBeLessThanOrEqual(MAX_BOX_VOXELS);
    expect(box!.dims[1]).toBeLessThanOrEqual(MAX_BOX_VOXELS);
    expect(box!.dims[2]).toBeLessThanOrEqual(MAX_BOX_VOXELS);
    expect(box!.values.length).toBeLessThanOrEqual(MAX_BOX_VOXELS ** 3);
  });

  it('reads the frame it is asked for, and frame 0 by default', () => {
    const dims: [number, number, number] = [2, 1, 1];
    const ds = volume(dims, [1, 2, 30, 40], { nvols: 2 });
    expect([...sampleVoxelBox(ds, [0, 0, 0], 0.5)!.values]).toEqual([1, 2]);
    expect([...sampleVoxelBox(ds, [0, 0, 0], 0.5, 1)!.values]).toEqual([30, 40]);
    // A frame past the end reads the last one rather than reading past the array.
    expect([...sampleVoxelBox(ds, [0, 0, 0], 0.5, 9)!.values]).toEqual([30, 40]);
  });

  it('returns values i-fastest, like VolumeDataset.data', () => {
    const dims: [number, number, number] = [3, 3, 3];
    const values = new Float32Array(27);
    values[index(dims, 2, 0, 0)] = 7; // +i
    values[index(dims, 0, 2, 0)] = 8; // +j
    values[index(dims, 0, 0, 2)] = 9; // +k
    const ds = volume(dims, values);
    const box = sampleVoxelBox(ds, [1, 1, 1], 1)!;
    expect(box.dims).toEqual([3, 3, 3]);
    // A transposed window would put 7 where 9 is and pass every sum-based assertion.
    expect(box.values[index([3, 3, 3], 2, 0, 0)]).toBe(7);
    expect(box.values[index([3, 3, 3], 0, 2, 0)]).toBe(8);
    expect(box.values[index([3, 3, 3], 0, 0, 2)]).toBe(9);
  });
});

describe('peakCentroid', () => {
  it('is null on a flat box — a uniform field has no peak to report', () => {
    const ds = volume([5, 5, 5], new Float32Array(125).fill(42));
    expect(peakCentroid(ds, [2, 2, 2], 2)).toBeNull();
    // Uniform *zero* is the same case, and the one a caller most easily writes by accident.
    expect(peakCentroid(volume([5, 5, 5], new Float32Array(125)), [2, 2, 2], 2)).toBeNull();
  });

  it('lands on a single bright voxel, exactly', () => {
    const dims: [number, number, number] = [7, 7, 7];
    const values = new Float32Array(343);
    values[index(dims, 5, 2, 3)] = 1000;
    const ds = volume(dims, values, { spacing: [2, 2, 2], origin: [-7, -7, -7] });
    // min 0, max 1000, threshold 500, so only that voxel weighs anything: the centroid IS it,
    // and through the affine it is world (-7 + 5*2, -7 + 2*2, -7 + 3*2).
    const c = peakCentroid(ds, [3, -3, -1], 4)!;
    expect(c[0]).toBeCloseTo(3, 9);
    expect(c[1]).toBeCloseTo(-3, 9);
    expect(c[2]).toBeCloseTo(-1, 9);
  });

  it('is sub-voxel: two equal peaks centre between them', () => {
    const dims: [number, number, number] = [9, 3, 3];
    const values = new Float32Array(81);
    values[index(dims, 3, 1, 1)] = 800;
    values[index(dims, 5, 1, 1)] = 800;
    const ds = volume(dims, values);
    // Equal weights at i = 3 and i = 5: the centroid is i = 4, which is not where either peak is.
    // "Take the brightest voxel" would answer 3 or 5 and jitter between them.
    const c = peakCentroid(ds, [4, 1, 1], 3)!;
    expect(c[0]).toBeCloseTo(4, 9);
    expect(c[1]).toBeCloseTo(1, 9);
  });

  it('weights by intensity above the half-range, not by presence', () => {
    const dims: [number, number, number] = [5, 1, 1];
    // min 0, max 100 ⇒ threshold 50. Weights: 0, 10, 50, 0, 0 at i = 1, 2.
    const ds = volume(dims, [0, 60, 100, 0, 0]);
    const c = peakCentroid(ds, [2, 0, 0], 2)!;
    // (1*10 + 2*50) / 60 = 110/60.
    expect(c[0]).toBeCloseTo(110 / 60, 9);
  });

  it('ignores NaN rather than answering NaN', () => {
    const dims: [number, number, number] = [5, 1, 1];
    const ds = volume(dims, [0, NaN, 100, 0, 0]);
    const c = peakCentroid(ds, [2, 0, 0], 2);
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(2, 9);
  });

  it('is null where sampleVoxelBox is', () => {
    const ds = volume([5, 5, 5], new Float32Array(125).fill(1));
    expect(peakCentroid(ds, [99, 0, 0], 1)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// `testdata/ct_shafts.nii.gz` against numpy
// -------------------------------------------------------------------------------------------

interface ManifestCase {
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
  expectedContact?: {
    group: string;
    ordinal: number;
    world: [number, number, number];
    centroidErrorMm: number;
    queryErrorMm: number;
  };
}

interface Manifest {
  volumes: Record<string, { dims: number[]; spacing: number[]; affine: number[][]; dtype: string }>;
  voxelBox: {
    file: string;
    spacing: number[];
    pitchMm: number;
    contacts: { group: string; ordinal: number; world: [number, number, number] }[];
    cases: ManifestCase[];
  };
}

const manifest = JSON.parse(readFileSync(`${TESTDATA}manifest.json`, 'utf8')) as Manifest;

/**
 * Minimal NIfTI-1 reader, **test-only** — the same deliberate sixty lines
 * `view/spaces.realdata.test.ts` carries, and for the same two reasons (the real reader is Rust in a
 * worker; §12.3 freezes the dependency set). Not exported: nothing outside a test may grow a second
 * volume reader. Handles exactly what this fixture is — single-file `n+1`, little-endian, `sform`,
 * int16 — and is checked against the manifest's nibabel record before it is trusted.
 */
function readTestNifti(path: string): VolumeDataset {
  const raw = readFileSync(path);
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, true) !== 348) throw new Error(`${path}: not a little-endian NIfTI-1`);

  const dims: vec3 = [dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)];
  const datatype = dv.getInt16(70, true);
  if (datatype !== 4) throw new Error(`${path}: this test reads int16 only, not ${datatype}`);
  const spacing: vec3 = [dv.getFloat32(80, true), dv.getFloat32(84, true), dv.getFloat32(88, true)];
  const slope0 = dv.getFloat32(112, true);
  const inter = dv.getFloat32(116, true);
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
  const data = new Int16Array(buf.buffer, buf.byteOffset + voxOffset, n).slice();
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
    dtype: 'i16',
  } as unknown as VolumeDataset;
}

describe('ct_shafts.nii.gz against numpy', () => {
  const ds = readTestNifti(`${TESTDATA}ct_shafts.nii.gz`);
  const record = manifest.volumes['ct_shafts.nii.gz'];

  it('the test-only reader agrees with nibabel about the geometry', () => {
    // Asserted first, so a bug in the reader above cannot masquerade as a bug in `voxel-box.ts`.
    expect(record).toBeDefined();
    expect([...ds.dims]).toEqual(record!.dims);
    expect(record!.dtype).toBe('i16');
    for (let a = 0; a < 3; a += 1) {
      expect(ds.spacing[a]).toBeCloseTo(record!.spacing[a] as number, 5);
      for (let row = 0; row < 3; row += 1) {
        // `affine[col * 4 + row]` is column-major; the manifest stores it as rows.
        expect(ds.affine[a * 4 + row]).toBeCloseTo(
          (record!.affine[row] as number[])[a] as number,
          5
        );
      }
    }
    // §6.1's scaling, on disk: the phantom stores `HU + 1024`.
    expect(ds.sclSlope).toBe(1);
    expect(ds.sclInter).toBe(-1024);
  });

  for (const c of manifest.voxelBox.cases) {
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
      expect(sum).toBeCloseTo(c.box.valueSum, 3);
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
      // Two independent implementations of the same rule over the same bytes: 1e-4 mm is float
      // round-off (the fixture's affine is float32 on disk), not a tolerance for disagreement.
      for (let a = 0; a < 3; a += 1) {
        expect(got![a]).toBeCloseTo(c.peakCentroidWorld[a] as number, 4);
      }
    });
  }

  it('snaps a clicked point onto the contact it was near — the property, not the number', () => {
    const snaps = manifest.voxelBox.cases.filter((c) => c.expectedContact !== undefined);
    expect(snaps.length).toBeGreaterThanOrEqual(3);
    for (const c of snaps) {
      const truth = c.expectedContact!.world;
      const got = peakCentroid(ds, c.world, c.radiusMm)!;
      const err = Math.hypot(got[0] - truth[0], got[1] - truth[1], got[2] - truth[2]);
      // The click was three quarters of a millimetre out; the snap lands within 0.15 mm of the
      // authored contact centre — a third of the smallest voxel (0.4 mm), and five times better
      // than the click. That gap is the whole value of the operation, and it is asserted against
      // the phantom's *design* rather than against numpy: a reference implementation that
      // reproduced a sign error would agree with us and still miss the contact.
      //
      // The residual is not noise. The box is centred on a **rounded** voxel, so a Gaussian
      // contact's tail is truncated asymmetrically and pulls the centroid a fraction of a voxel
      // toward the box's centre. Slicer's rule has the same bias, and it is two orders below the
      // 3.5 mm contact pitch it has to distinguish.
      expect(c.expectedContact!.queryErrorMm).toBeGreaterThan(0.5);
      expect(
        err,
        `${c.name} landed ${err.toFixed(4)} mm from ${c.expectedContact!.group}`
      ).toBeLessThan(0.15);
    }
  });

  it("does not drift to a neighbour: the contacts are a shaft's pitch apart", () => {
    // 3.5 mm pitch against a 1.5 mm radius: the box cannot even see the next contact, which is why
    // a snap is safe to run over a whole electrode at once.
    expect(manifest.voxelBox.pitchMm).toBeCloseTo(3.5, 6);
    const a = manifest.voxelBox.contacts.filter((c) => c.group === 'A');
    for (let n = 1; n < a.length; n += 1) {
      const p = a[n - 1]!.world;
      const q = a[n]!.world;
      expect(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])).toBeCloseTo(3.5, 6);
    }
  });
});
