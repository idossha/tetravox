/**
 * The one adapter between gl-matrix's `mat4` type and §4.1's frozen
 * `export type mat4 = Float32Array`.
 *
 * gl-matrix types `mat4` as a union that also admits a 16-number tuple, so its functions do not
 * structurally accept the frozen alias. Rather than casting at every call site — where a wrong cast
 * would be invisible — every conversion happens here, and the rest of the engine passes
 * `Float32Array` around.
 */

import { mat4 as glMat4 } from 'gl-matrix';
import type { mat4 } from '../scene/types';

type GlMat4 = Parameters<typeof glMat4.identity>[0];

export function asGl(m: mat4): GlMat4 {
  return m as unknown as GlMat4;
}

export function fromGl(m: GlMat4): mat4 {
  return m as unknown as mat4;
}

/** A fresh identity matrix, typed as the frozen alias. */
export function identity4(): mat4 {
  const m = new Float32Array(16);
  glMat4.identity(asGl(m));
  return m;
}

/** `out = a · b`, allocating the result. */
export function multiply4(a: mat4, b: mat4): mat4 {
  const out = new Float32Array(16);
  glMat4.multiply(asGl(out), asGl(a), asGl(b));
  return out;
}

/** The inverse, or identity when `a` is singular (never NaN into a shader). */
export function invert4(a: mat4): mat4 {
  const out = new Float32Array(16);
  if (glMat4.invert(asGl(out), asGl(a)) === null) glMat4.identity(asGl(out));
  return out;
}

/** Transform a point (w = 1) by a column-major `mat4`. */
export function transformPoint(
  m: mat4,
  p: readonly [number, number, number]
): [number, number, number] {
  const w = (m[3] ?? 0) * p[0] + (m[7] ?? 0) * p[1] + (m[11] ?? 0) * p[2] + (m[15] ?? 1);
  const iw = w === 0 ? 1 : 1 / w;
  return [
    ((m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0)) * iw,
    ((m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0)) * iw,
    ((m[2] ?? 0) * p[0] + (m[6] ?? 0) * p[1] + (m[10] ?? 0) * p[2] + (m[14] ?? 0)) * iw,
  ];
}
