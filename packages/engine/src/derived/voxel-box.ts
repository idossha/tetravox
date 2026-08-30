/**
 * **Bounded local reads** of a volume's retained samples — §4.3, amended 2026-08-30.
 *
 * §4.3 keeps `VolumeDataset.data` on the UI thread "for probes only". A probe is one voxel; a
 * contact-snapping tool needs the *neighbourhood* — Slicer's sEEG editor takes a box of radius
 * 1.5 mm around a clicked contact and moves it to the intensity-weighted peak, which on a 0.5 mm CT
 * is a few hundred voxels. So §4.3 now says "for probes **and bounded local reads**", with the bound
 * written into this file: at most 32 voxels on an axis, which is 32,768 of them, ~0.1 ms.
 *
 * **A whole-volume scan is still not a probe**, and that is what the cap is for rather than being a
 * performance note. Without one, "read `data` on the UI thread" is a door to a 512³ loop in a
 * pointermove handler, and §5's whole worker-per-dataset arrangement leaks through it. A caller who
 * wants more than a box asks a worker (§6.5).
 *
 * Both functions here are **pure** — a dataset, a world point, a radius, an answer — so §11 asserts
 * them against numpy with no GL context and no engine at all, and the app's `NoGlEngine` gives the
 * same numbers as the real one because there is only one implementation.
 *
 * The weighting is Slicer's, deliberately and verbatim: `w = clip(v − (max − ½(max − min)), 0)` over
 * the box. It is a **half-maximum-above-background** threshold — the midpoint of the local range,
 * not a fixed HU floor — which is what makes it work on a CT whose background is soft tissue at
 * ~40 HU and whose contacts are metal at ~3000, and equally on one that has been rescaled. A fixed
 * threshold would have to be re-tuned per scanner; this one has no parameters but the radius.
 */

import { transformPoint } from '../view/m4';
import { worldToVoxel } from '../view/geometry';
import type { VolumeDataset, vec3 } from '../scene/types';

/**
 * The most voxels a bounded local read may span on one axis — §4.3's cap, and the reason this is a
 * *bounded* read rather than a scan.
 *
 * 32 rather than a millimetre limit because the bound has to hold whatever the spacing is: 1.5 mm on
 * ernie's 1 mm T1 is a 3-voxel half-extent, and on a 0.2 mm micro-CT it would be 15. A caller that
 * asks for more gets the largest window inside the cap, centred on the same voxel — never a silent
 * 512³ loop.
 */
export const MAX_BOX_VOXELS = 32;
const MAX_HALF = (MAX_BOX_VOXELS - 1) >> 1;

/** One bounded local read: the physical values in the box, and where the box sits in the volume. */
export interface VoxelBox {
  /** `dims[0] * dims[1] * dims[2]` physical values, **i fastest**, like `VolumeDataset.data`. */
  values: Float32Array;
  /** The box's lowest voxel index, inclusive. */
  ijk0: [number, number, number];
  /** The box's size in voxels. */
  dims: [number, number, number];
}

/**
 * The physical values in a box of world radius `radiusMm` around `world`, or `null`.
 *
 * The box is axis-aligned **in voxel space**, not in world space: its half-extent on axis `a` is
 * `ceil(radiusMm / spacing[a])` voxels, so it covers the requested radius in every direction on an
 * oblique volume too (a world-aligned box would need the affine's row norms and would still have to
 * be padded to whole voxels). It is then clipped to the volume, so a point near a face reads a
 * smaller box rather than nothing — `dims` and `ijk0` say which one.
 *
 * `null` when:
 *
 * * the volume is `rgb24` / `rgba32` — those samples are three or four interleaved components and
 *   "the value at this voxel" is not defined for them (§4.2's scalar display model does not cover
 *   them either);
 * * `world` is **outside the volume**. Not clamped: a snap that silently pulled a click 40 mm back
 *   inside the head would be worse than one that refused;
 * * the volume has no samples on the UI thread, or a degenerate spacing.
 *
 * Values are `raw * sclSlope + sclInter` — §6.1's scaling applied here and exactly once, because
 * `data` holds the on-disk samples and a caller comparing a threshold in Hounsfield units against
 * raw shorts would be comparing two different quantities.
 *
 * `volumeIndex` selects the frame of a 4-D volume; it defaults to 0, which is the only frame a 3-D
 * volume has.
 */
export function sampleVoxelBox(
  ds: VolumeDataset,
  world: vec3,
  radiusMm: number,
  volumeIndex = 0
): VoxelBox | null {
  if (ds.dtype === 'rgb24' || ds.dtype === 'rgba32') return null;
  const data = ds.data;
  if (data === undefined || data.length === 0) return null;
  const nx = Math.trunc(ds.dims[0]);
  const ny = Math.trunc(ds.dims[1]);
  const nz = Math.trunc(ds.dims[2]);
  if (nx <= 0 || ny <= 0 || nz <= 0) return null;

  const v = worldToVoxel(ds, world);
  const ci = Math.round(v[0]);
  const cj = Math.round(v[1]);
  const ck = Math.round(v[2]);
  if (ci < 0 || cj < 0 || ck < 0 || ci >= nx || cj >= ny || ck >= nz) return null;

  const half = (axis: 0 | 1 | 2): number => {
    const s = Math.abs(ds.spacing[axis]);
    if (!(s > 0) || !Number.isFinite(radiusMm) || radiusMm < 0) return 0;
    return Math.min(MAX_HALF, Math.ceil(radiusMm / s));
  };
  const hi = half(0);
  const hj = half(1);
  const hk = half(2);

  const i0 = Math.max(0, ci - hi);
  const j0 = Math.max(0, cj - hj);
  const k0 = Math.max(0, ck - hk);
  const i1 = Math.min(nx - 1, ci + hi);
  const j1 = Math.min(ny - 1, cj + hj);
  const k1 = Math.min(nz - 1, ck + hk);
  const di = i1 - i0 + 1;
  const dj = j1 - j0 + 1;
  const dk = k1 - k0 + 1;

  const frame = Math.min(Math.max(0, Math.trunc(volumeIndex)), Math.max(0, ds.nvols - 1));
  const perVol = nx * ny * nz;
  const base = frame * perVol;
  const slope = ds.sclSlope;
  const inter = ds.sclInter;

  const values = new Float32Array(di * dj * dk);
  let o = 0;
  for (let k = k0; k <= k1; k += 1) {
    for (let j = j0; j <= j1; j += 1) {
      const row = base + (k * ny + j) * nx;
      for (let i = i0; i <= i1; i += 1) {
        values[o] = Number(data[row + i] ?? 0) * slope + inter;
        o += 1;
      }
    }
  }
  return { values, ijk0: [i0, j0, k0], dims: [di, dj, dk] };
}

/**
 * The intensity-weighted peak of the neighbourhood around `world`, in world millimetres, or `null`.
 *
 * Slicer's `_peakCentroid`, reproduced: take the box, threshold it at the **midpoint of its own
 * range** (`max − ½(max − min)`), and return the weighted centroid of what is left. Two properties
 * follow, and both are why this is the rule rather than "the brightest voxel":
 *
 * * it is **sub-voxel**, so a contact 0.3 mm off the grid does not snap to a grid point and jitter
 *   between two of them as the radius changes;
 * * it is **local and relative**, so it needs no HU floor: on a CT whose background is soft tissue
 *   and whose contacts are metal the midpoint lands between them wherever the scanner put the
 *   window, and on a rescaled volume it moves with it.
 *
 * The centroid is computed in **voxel index space** and mapped through the affine at the end, which
 * is what makes it correct on an oblique volume: averaging world positions would be the same thing
 * only because the affine is affine, and doing it in indices keeps the weights and the coordinates
 * in the same frame.
 *
 * `null` when {@link sampleVoxelBox} refuses, and when the box is **flat** — every value equal makes
 * the threshold the value itself, every weight 0, and there is no peak to report. Uniform background
 * has no answer, and returning the box centre would be a snap that pretended to have found
 * something.
 *
 * Non-finite samples are skipped rather than poisoning the range: a `NaN` in the box would otherwise
 * make `max` NaN and the whole answer NaN, which is a silent wrong position rather than a refusal.
 */
export function peakCentroid(
  ds: VolumeDataset,
  world: vec3,
  radiusMm: number,
  volumeIndex = 0
): vec3 | null {
  const box = sampleVoxelBox(ds, world, radiusMm, volumeIndex);
  if (box === null) return null;
  const { values, ijk0, dims } = box;

  let min = Infinity;
  let max = -Infinity;
  for (let n = 0; n < values.length; n += 1) {
    const value = values[n] as number;
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  // Slicer's threshold, written the way Slicer writes it. It is `½(max + min)` — the comment is the
  // point: this is "half way up the local range", not a fixed floor.
  const threshold = max - 0.5 * (max - min);

  let sum = 0;
  let si = 0;
  let sj = 0;
  let sk = 0;
  let n = 0;
  for (let k = 0; k < dims[2]; k += 1) {
    for (let j = 0; j < dims[1]; j += 1) {
      for (let i = 0; i < dims[0]; i += 1) {
        const value = values[n] as number;
        n += 1;
        if (!Number.isFinite(value)) continue;
        const w = value - threshold;
        if (!(w > 0)) continue;
        sum += w;
        si += w * (ijk0[0] + i);
        sj += w * (ijk0[1] + j);
        sk += w * (ijk0[2] + k);
      }
    }
  }
  if (!(sum > 0)) return null;
  return transformPoint(ds.affine, [si / sum, sj / sum, sk / sum]) as vec3;
}
