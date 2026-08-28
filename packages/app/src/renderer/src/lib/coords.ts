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

/**
 * The §8 copy format: one decimal, space-separated, e.g. `-42.0 18.0 6.0`.
 *
 * `Array.from` first, because a `vec3` that came off the §6.5 wire may really be a `Float32Array`:
 * `TypedArray.prototype.map` returns a **typed** array, so mapping to strings silently produces
 * numbers again and `join` then prints full f32 precision. The producers normalise (`layers/mesh.ts`),
 * and this is the second lock on a failure whose only symptom is a plausible-looking number.
 */
export function formatTriple(v: vec3, decimals = 1): string {
  return Array.from(v, (c) => formatNumber(c, decimals)).join(' ');
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

/**
 * Invert a column-major 4×4, or return null when it is singular.
 *
 * The §8 coordinate bar's **MNI** column needs it (audit P2-10): `VolumeDataset.toTemplate.matrix`
 * maps world → the template, so *showing* an MNI coordinate is a forward apply and *jumping* to one
 * the user typed is the inverse. In practice the matrix is rigid-plus-scale, but a general cofactor
 * inverse is branch-free and assumes nothing about the bottom row — one fewer thing to be wrong
 * about than a special case that misbehaves quietly on a sheared matrix.
 *
 * `null` rather than an identity fallback: a singular `toTemplate` means the field cannot accept
 * input, and jumping to the wrong place is worse than refusing to jump.
 */
export function invertMat4(m: mat4): mat4 | null {
  const at = (i: number): number => m[i] as number;
  const b00 = at(0) * at(5) - at(1) * at(4);
  const b01 = at(0) * at(6) - at(2) * at(4);
  const b02 = at(0) * at(7) - at(3) * at(4);
  const b03 = at(1) * at(6) - at(2) * at(5);
  const b04 = at(1) * at(7) - at(3) * at(5);
  const b05 = at(2) * at(7) - at(3) * at(6);
  const b06 = at(8) * at(13) - at(9) * at(12);
  const b07 = at(8) * at(14) - at(10) * at(12);
  const b08 = at(8) * at(15) - at(11) * at(12);
  const b09 = at(9) * at(14) - at(10) * at(13);
  const b10 = at(9) * at(15) - at(11) * at(13);
  const b11 = at(10) * at(15) - at(11) * at(14);

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) return null;
  const d = 1 / det;

  return Float32Array.from([
    (at(5) * b11 - at(6) * b10 + at(7) * b09) * d,
    (at(2) * b10 - at(1) * b11 - at(3) * b09) * d,
    (at(13) * b05 - at(14) * b04 + at(15) * b03) * d,
    (at(10) * b04 - at(9) * b05 - at(11) * b03) * d,
    (at(6) * b08 - at(4) * b11 - at(7) * b07) * d,
    (at(0) * b11 - at(2) * b08 + at(3) * b07) * d,
    (at(14) * b02 - at(12) * b05 - at(15) * b01) * d,
    (at(8) * b05 - at(10) * b02 + at(11) * b01) * d,
    (at(4) * b10 - at(5) * b08 + at(7) * b06) * d,
    (at(1) * b08 - at(0) * b10 - at(3) * b06) * d,
    (at(12) * b04 - at(13) * b02 + at(15) * b00) * d,
    (at(9) * b02 - at(8) * b04 - at(11) * b00) * d,
    (at(5) * b07 - at(4) * b09 - at(6) * b06) * d,
    (at(0) * b09 - at(1) * b07 + at(2) * b06) * d,
    (at(13) * b01 - at(12) * b03 - at(14) * b00) * d,
    (at(8) * b03 - at(9) * b01 + at(10) * b00) * d,
  ]) as mat4;
}

/** World mm → template mm, using `VolumeDataset.toTemplate.matrix` (§4.3, audit P2-10). */
export function worldToTemplate(matrix: mat4, world: vec3): vec3 {
  return applyMat4(matrix, world);
}

/** Template mm → world mm. `null` when the transform cannot be inverted. */
export function templateToWorld(matrix: mat4, template: vec3): vec3 | null {
  const inverse = invertMat4(matrix);
  return inverse === null ? null : applyMat4(inverse, template);
}
