/**
 * **Sampling a volume at arbitrary world points** — §4.3's third read shape (2026-09-03).
 *
 * §4.3 already allows two reads of `VolumeDataset.data` from the UI thread: a **probe** (one voxel)
 * and a **bounded local read** (`voxel-box.ts`, ≤ 32 voxels on an axis). Neither answers the
 * question a QC figure asks — "what is the intensity along this 120 mm oblique line, at 0.1 mm
 * steps" — because the points are not a box and are not on the grid.
 *
 * So this file adds the third shape, and bounds it the way the other two are bounded: **at most
 * {@link MAX_SAMPLE_POINTS} points per call**, which is the number rather than a note. The cap is
 * what keeps "read `data` for a set of points" from being a door to a full-volume resampling loop;
 * a caller who wants more than that wants a §6.5 op in the dataset's worker.
 *
 * **Pure**, like `voxel-box.ts`: a dataset, points, an answer. §11 asserts it against closed forms
 * with no GL context and no engine at all, and the app's `NoGlEngine` gives the same numbers as the
 * real one because there is only one implementation.
 *
 * **Outside is `NaN`, never a clamp.** A trilinear cell needs its eight corners; a point whose cell
 * is not wholly inside the volume has no defined value, and clamping would silently report the face
 * voxel's intensity for a contact that is 40 mm outside the head. `NaN` is a value every consumer
 * already has to handle (a histogram drops it, a plot leaves a gap) and a number is not.
 *
 * Values are `raw * sclSlope + sclInter` — §6.1's scaling applied here and exactly once, the same
 * rule and for the same reason as {@link sampleVoxelBox}.
 */

import { worldToVoxel } from '../view/geometry';
import type { VolumeDataset } from '../scene/types';

/**
 * The most points one call may sample — the bound that makes this a *bounded* read (§4.3).
 *
 * 2,000,000 rather than a millisecond budget because the bound has to be checkable before any work
 * happens: ~24 MB of `xyz` in, 8 MB out, and far more than an oblique reslice at 0.2 mm over
 * 200 × 200 mm needs (1,000,000 points). A caller wanting a whole volume resampled wants a §6.5 op
 * in the dataset's worker, not this.
 */
export const MAX_SAMPLE_POINTS = 2_000_000;

/** `order: 1` is trilinear (the default); `order: 0` is nearest-neighbour. SciPy's spelling. */
export type SampleOrder = 0 | 1;

export interface SampleVolumeOptions {
  order?: SampleOrder;
  /** The frame of a 4-D volume. Defaults to 0, the only frame a 3-D volume has. */
  volumeIndex?: number;
}

/** Thrown for a request this function refuses to start. The host maps it to a `ModuleHostError`. */
export class SampleVolumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleVolumeError';
  }
}

/**
 * The dataset's scalar values at `worldPoints`, one per point, `NaN` outside the volume.
 *
 * `worldPoints` is `xyz` triples in world millimetres — `[x0, y0, z0, x1, y1, z1, …]`, the layout
 * every point buffer in this engine already uses, so a caller that has a `PointsLayer`'s positions
 * hands them over with no repacking.
 *
 * Refuses (throws {@link SampleVolumeError}) rather than answering:
 *
 * * a length that is not a multiple of 3 — the caller packed something other than triples, and
 *   silently dropping the tail would be a plot one point short with no way to notice;
 * * more than {@link MAX_SAMPLE_POINTS} points.
 *
 * Answers `NaN` for every point of a volume it cannot read at all — `rgb24` / `rgba32` (three or
 * four interleaved components, for which "the value at this voxel" is not defined, exactly as
 * {@link sampleVoxelBox} says), a volume whose samples are not on this thread, and a degenerate
 * `dims`. A refusal is about the *request*; a volume with no scalar to give is about the data, and a
 * caller plotting three datasets wants the empty one to be a gap rather than an exception.
 */
export function sampleVolumeAt(
  ds: VolumeDataset,
  worldPoints: Float32Array,
  opts: SampleVolumeOptions = {}
): Float32Array {
  if (worldPoints.length % 3 !== 0) {
    throw new SampleVolumeError(
      `${worldPoints.length} floats is not a whole number of xyz triples`
    );
  }
  const count = worldPoints.length / 3;
  if (count > MAX_SAMPLE_POINTS) {
    throw new SampleVolumeError(
      `${count} points exceeds the ${MAX_SAMPLE_POINTS}-point cap (ARCHITECTURE.md §4.3)`
    );
  }

  const out = new Float32Array(count).fill(Number.NaN);
  if (ds.dtype === 'rgb24' || ds.dtype === 'rgba32') return out;
  const data = ds.data;
  if (data === undefined || data.length === 0) return out;
  const nx = Math.trunc(ds.dims[0]);
  const ny = Math.trunc(ds.dims[1]);
  const nz = Math.trunc(ds.dims[2]);
  if (nx <= 0 || ny <= 0 || nz <= 0) return out;

  const order: SampleOrder = opts.order === 0 ? 0 : 1;
  const frame = Math.min(Math.max(0, Math.trunc(opts.volumeIndex ?? 0)), Math.max(0, ds.nvols - 1));
  const base = frame * nx * ny * nz;
  const slope = ds.sclSlope;
  const inter = ds.sclInter;
  const stride = nx * ny;

  const at = (i: number, j: number, k: number): number =>
    Number(data[base + k * stride + j * nx + i] ?? 0);

  for (let n = 0; n < count; n += 1) {
    const v = worldToVoxel(ds, [
      worldPoints[n * 3] as number,
      worldPoints[n * 3 + 1] as number,
      worldPoints[n * 3 + 2] as number,
    ]);
    const x = v[0];
    const y = v[1];
    const z = v[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    if (order === 0) {
      // `Math.round` — half-up, the same rounding `sampleVoxelBox` centres its box with, so the
      // two reads of one point never disagree about which voxel it is in.
      const i = Math.round(x);
      const j = Math.round(y);
      const k = Math.round(z);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      out[n] = at(i, j, k) * slope + inter;
      continue;
    }

    // Trilinear: the cell `[i0, i0+1]` must be wholly inside, so the last valid coordinate is
    // `n − 1` exactly. A point *on* the far face (`x === nx − 1`) is in the volume and is answered
    // by the degenerate cell below it, which is why the upper bound is `>` and not `>=`.
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const k0 = Math.floor(z);
    if (i0 < 0 || j0 < 0 || k0 < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) continue;
    const i1 = Math.min(i0 + 1, nx - 1);
    const j1 = Math.min(j0 + 1, ny - 1);
    const k1 = Math.min(k0 + 1, nz - 1);
    const fx = x - i0;
    const fy = y - j0;
    const fz = z - k0;

    const c00 = at(i0, j0, k0) * (1 - fx) + at(i1, j0, k0) * fx;
    const c10 = at(i0, j1, k0) * (1 - fx) + at(i1, j1, k0) * fx;
    const c01 = at(i0, j0, k1) * (1 - fx) + at(i1, j0, k1) * fx;
    const c11 = at(i0, j1, k1) * (1 - fx) + at(i1, j1, k1) * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[n] = (c0 * (1 - fz) + c1 * fz) * slope + inter;
  }
  return out;
}
