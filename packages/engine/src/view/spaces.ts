/**
 * Coordinate **spaces** — the readout half of §3 (directed task 8).
 *
 * §3 fixes one world: scanner RAS millimetres. Everything renders there. But a coordinate a user
 * copies into a paper, a lab notebook or an electrode CSV is almost never in that world — it is a
 * voxel index, a FreeSurfer `tkr-RAS`, or MNI. This module is the pure arithmetic for the extra
 * spaces; who *shows* them is `engine.ts` (`ProbeResult`) and the app's coordinate bar (§8).
 *
 * Every matrix here is §3's wire-side convention: a `mat4` is **flat, length 16, column-major**, so
 * `m[12..14]` is the translation. Nothing in this file touches GL.
 *
 * ## The three derivations, written out
 *
 * **tkr-RAS** (`vox2ras-tkr`, FreeSurfer's `MRIxfmCRS2XYZtkreg`) is a *synthetic* scanner transform:
 * it throws the file's affine away and rebuilds one from dims and spacing alone, with the volume
 * centre at the origin and FreeSurfer's fixed direction cosines
 * `Mdc_tkr = [[-1,0,0],[0,0,1],[0,-1,0]]` (columns for `i, j, k`):
 *
 * ```
 * vox2ras_tkr = [[-dx,   0,   0,  dx*Nx/2],
 *                [  0,   0,  dz, -dz*Nz/2],
 *                [  0, -dy,   0,  dy*Ny/2],
 *                [  0,   0,   0,        1]]
 * ```
 *
 * That is exactly `nibabel.freesurfer.mghformat.MGHHeader.get_vox2ras_tkr()`, and on
 * `m2m_ernie/T1.nii.gz` (256×256×208, 1 mm) it reproduces nibabel's matrix with **max abs error 0**
 * `[DATA]`. It is the space `mri_info --tkrvox2ras` prints, the space FreeSurfer's binary surfaces
 * live in (§3 already says so), and therefore the space a user needs when they want to type a
 * surface vertex's coordinate into anything FreeSurfer. `worldToTkr = vox2ras_tkr · inv(affine)`.
 *
 * It is defined for **any** volume, because it needs nothing but dims and spacing — which is also
 * its trap: two volumes of the same subject at different resolutions have *different* tkr spaces, so
 * the readout is always tied to a named volume (the active layer's), never to "the scene".
 *
 * **MNI, affine.** SimNIBS writes `m2m_<sub>/toMNI/MNI2conform_6DOF.txt` / `MNI2conform_12DOF.txt`:
 * a 4×4, whitespace-separated, **row-major** text matrix mapping **MNI mm → subject conform mm**.
 * `simnibs.utils.transformations.warp_coordinates` reads it verbatim for `mni2subject` and uses
 * `np.linalg.inv(...)` of it for `subject2mni` — so subject→MNI is the **inverse** of the file, and
 * `parseTextAffine` returns the file as-written while {@link subjectToMniAffine} does the inverting.
 * SimNIBS 4's `charm` no longer writes either file (`m2m_ernie/toMNI/` has only the two nonlinear
 * fields `[DATA]`), so this path is exercised by a synthetic matrix and by the semantics above,
 * not by ernie.
 *
 * **MNI, nonlinear.** `toMNI/Conform2MNI_nonl.nii.gz` is a 4-D NIfTI whose three volumes are, at
 * each voxel, **the target-space coordinates of that voxel** — SimNIBS's `coordinates_nonlinear`
 * doc says it in one line: "The deformation field specifies in each voxel the coordinates (x, y, z)
 * of the target space." So mapping subject → MNI is: subject mm → the field's own voxel index
 * through `inv(field.affine)`, then **trilinear** interpolation of the three components, clamped to
 * the volume (SimNIBS uses `scipy.ndimage.map_coordinates(order=1, mode='nearest')`, which is
 * trilinear with edge clamping — {@link sampleDeformation} is that, exactly). The result is MNI mm
 * directly; no affine is composed with it.
 *
 * The **inverse** direction is not an inversion at all: SimNIBS ships the other field,
 * `toMNI/MNI2Conform_nonl.nii.gz`, and `mni2subject` samples *it* the same way. So typed entry in
 * "MNI (nonlinear)" is a forward sample of the inverse field — exact, not a fixed-point iteration.
 * Round-tripped through both fields on five ernie landmarks, SimNIBS itself returns to within
 * 2.0e-2 mm `[DATA]`, which is the interpolation error of the pair, not of this code.
 */

import type { VolumeDataset, mat4, vec3 } from '../scene/types';
import { invert4, multiply4, transformPoint } from './m4';

/**
 * `vox2ras-tkr` for a volume, from **dims and spacing only** — the file's affine is deliberately
 * unused (that is what makes it *tkr*).
 */
export function vox2rasTkr(dims: vec3, spacing: vec3): mat4 {
  const [nx, ny, nz] = dims;
  const [dx, dy, dz] = spacing;
  // Column-major: m[col * 4 + row].
  const m = new Float32Array(16);
  m[0] = -dx; // column i -> (-dx, 0, 0)
  m[6] = -dy; // column j -> (0, 0, -dy)
  m[9] = dz; //  column k -> (0, dz, 0)
  m[12] = (dx * nx) / 2;
  m[13] = (-dz * nz) / 2;
  m[14] = (dy * ny) / 2;
  m[15] = 1;
  return m as mat4;
}

/** World RAS mm → that volume's tkr-RAS mm. */
export function worldToTkrMatrix(
  ds: Pick<VolumeDataset, 'dims' | 'spacing' | 'inverseAffine'>
): mat4 {
  return multiply4(vox2rasTkr(ds.dims, ds.spacing), ds.inverseAffine);
}

/** That volume's tkr-RAS mm → world RAS mm — what typed entry in tkr space needs. */
export function tkrToWorldMatrix(ds: Pick<VolumeDataset, 'dims' | 'spacing' | 'affine'>): mat4 {
  return multiply4(ds.affine, invert4(vox2rasTkr(ds.dims, ds.spacing)));
}

/** World RAS mm → tkr-RAS mm, for one point. */
export function worldToTkr(
  ds: Pick<VolumeDataset, 'dims' | 'spacing' | 'inverseAffine'>,
  world: vec3
): vec3 {
  return transformPoint(worldToTkrMatrix(ds), world);
}

/**
 * Parse a SimNIBS / FSL-style 4×4 text matrix (`MNI2conform_12DOF.txt`).
 *
 * The file is **row-major**, four lines of four numbers, `#` comments and blank lines skipped;
 * returned as §3's column-major `mat4`. `null` for anything that is not exactly sixteen finite
 * numbers — a half-read registration is worse than no registration.
 */
export function parseTextAffine(text: string): mat4 | null {
  const nums: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0] ?? '';
    for (const tok of line.trim().split(/[\s,]+/)) {
      if (tok.length === 0) continue;
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) return null;
      nums.push(Number(tok));
    }
  }
  if (nums.length !== 16 || nums.some((n) => !Number.isFinite(n))) return null;
  const m = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) m[col * 4 + row] = nums[row * 4 + col] as number;
  }
  return m as mat4;
}

/**
 * Subject world mm → MNI mm, given the **file as written** (`MNI2conform_*DOF.txt`, MNI → subject).
 *
 * The inversion is the whole content of this function, and it is the one thing that is easy to get
 * backwards: the file's name says which way it goes, and it is the *opposite* of the direction the
 * readout wants (`warp_coordinates`, `simnibs/utils/transformations.py`).
 */
export function subjectToMniAffine(mni2conform: mat4): mat4 {
  return invert4(mni2conform);
}

/**
 * Trilinear sample of a 3-component deformation field at a **world** point, returning the target
 * space's coordinates, or `null` when the dataset is not a usable field.
 *
 * Edge behaviour is `mode='nearest'`: the voxel index is clamped into the volume before
 * interpolation, so a point outside the field maps to the transform of the closest point inside it
 * — the same answer SimNIBS gives, and documented as such in `coordinates_nonlinear`.
 *
 * `scl_slope`/`scl_inter` are applied here, because §3 keeps them out of the samples.
 */
export function sampleDeformation(field: VolumeDataset, world: vec3): vec3 | null {
  if (field.nvols < 3) return null;
  const [nx, ny, nz] = field.dims;
  if (nx < 1 || ny < 1 || nz < 1) return null;

  const v = transformPoint(field.inverseAffine, world);
  const clamp = (x: number, hi: number): number => (x < 0 ? 0 : x > hi ? hi : x);
  const fx = clamp(v[0], nx - 1);
  const fy = clamp(v[1], ny - 1);
  const fz = clamp(v[2], nz - 1);
  const i0 = Math.min(Math.floor(fx), Math.max(0, nx - 2));
  const j0 = Math.min(Math.floor(fy), Math.max(0, ny - 2));
  const k0 = Math.min(Math.floor(fz), Math.max(0, nz - 2));
  const i1 = Math.min(i0 + 1, nx - 1);
  const j1 = Math.min(j0 + 1, ny - 1);
  const k1 = Math.min(k0 + 1, nz - 1);
  const tx = fx - i0;
  const ty = fy - j0;
  const tz = fz - k0;

  const data = field.data;
  const perVol = nx * ny * nz;
  const at = (i: number, j: number, k: number, c: number): number =>
    (data[c * perVol + (k * ny + j) * nx + i] as number) * field.sclSlope + field.sclInter;

  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const c00 = at(i0, j0, k0, c) * (1 - tx) + at(i1, j0, k0, c) * tx;
    const c10 = at(i0, j1, k0, c) * (1 - tx) + at(i1, j1, k0, c) * tx;
    const c01 = at(i0, j0, k1, c) * (1 - tx) + at(i1, j0, k1, c) * tx;
    const c11 = at(i0, j1, k1, c) * (1 - tx) + at(i1, j1, k1, c) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    out.push(c0 * (1 - tz) + c1 * tz);
  }
  return [out[0] as number, out[1] as number, out[2] as number];
}
