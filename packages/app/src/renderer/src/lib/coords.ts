/**
 * Coordinate formatting and parsing for the §8 coordinate bar.
 *
 * Pure, no React, no engine: this is the display half of "editable `x y z` with a space selector
 * (`World RAS` | `Voxel (active layer)`), Enter jumps the cursor, a copy button yields
 * `-42.0 18.0 6.0`, paste accepts comma- or space-separated triples".
 *
 * The matrix convention is §3's, once: a `mat4` here is **flat, length 16, column-major**
 * (gl-matrix layout), so `m[12..14]` is the translation and
 * `out[row] = m[0*4+row]*x + m[1*4+row]*y + m[2*4+row]*z + m[3*4+row]`.
 */

import type { mat4, vec3 } from '@tetravox/engine';

/** The §8 copy format: one decimal, space-separated, e.g. `-42.0 18.0 6.0`. */
export function formatTriple(v: vec3, decimals = 1): string {
  return v.map((c) => formatNumber(c, decimals)).join(' ');
}

/** `-0` prints as `0.0`, never `-0.0`: a sign on zero is a laterality question a reader should not have. */
export function formatNumber(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = (value === 0 ? 0 : value).toFixed(decimals);
  return fixed === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : fixed;
}

/**
 * Parse a triple typed or pasted into the coordinate bar.
 *
 * Accepts commas, whitespace, or both, with or without surrounding brackets/parentheses, so
 * `-42, 18, 6`, `[-42 18 6]` and `-42\t18\t6` all work. Returns null for anything that is not
 * exactly three finite numbers — a partially parsed coordinate is worse than a rejected one.
 */
export function parseTriple(text: string): vec3 | null {
  const cleaned = text
    .trim()
    .replace(/^[[({]/, '')
    .replace(/[\])}]$/, '');
  const parts = cleaned.split(/[\s,;]+/).filter((p) => p.length > 0);
  if (parts.length !== 3) return null;
  const out: number[] = [];
  for (const part of parts) {
    // `Number('')` is 0 and `Number('1px')` is NaN; require a full numeric literal either way.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    out.push(value);
  }
  return [out[0] as number, out[1] as number, out[2] as number];
}

/** Apply a column-major 4x4 to a point (w = 1), returning world mm. */
export function applyMat4(m: mat4, p: vec3): vec3 {
  const [x, y, z] = p;
  const w = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
  const s = w === 0 ? 1 : w;
  return [
    ((m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number)) / s,
    ((m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number)) / s,
    ((m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number)) / s,
  ];
}

/** Voxel index (fractional allowed) → world mm, using `VolumeDataset.affine`. */
export function voxelToWorld(affine: mat4, voxel: vec3): vec3 {
  return applyMat4(affine, voxel);
}

/** World mm → voxel index, using `VolumeDataset.inverseAffine`. Not rounded: the caller decides. */
export function worldToVoxel(inverseAffine: mat4, world: vec3): vec3 {
  return applyMat4(inverseAffine, world);
}

/** Voxel indices are displayed as integers — voxel centres are at integer indices (§3). */
export function roundVoxel(v: vec3): vec3 {
  return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];
}
