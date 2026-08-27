/**
 * The §7.3 volume slice program.
 *
 * Phase 1 shipped the **minimum**: one scalar layer per plane, `Scale {kind:'linear'}`, the shared
 * plane geometry, `invariant gl_Position`, and the per-layer AABB discard. No labels beyond the
 * palette path, **no threshold**, **no heat scale**, **no label outlines**, **no `showIn3D`**.
 * Phase 2's "§7.3 complete" extends this file and only this file.
 */

import {
  PRECISION_FLOAT,
  PRECISION_INT,
  PRECISION_SAMPLER3D,
  PRECISION_USAMPLER3D,
  VERSION,
} from './chunks/caps';
import { LADDER_DECODE, LADDER_UNIFORMS, WORLD_TO_TEXCOORD_UNIFORMS } from './chunks/ladder';
import { LUT_SAMPLE, LUT_UNIFORMS, PALETTE_SAMPLE, PALETTE_UNIFORMS } from './chunks/lut';

/** Shared by every slice draw (§7.3): one quad per plane, so depth is bit-identical across layers. */
export const SLICE_VS = `${VERSION}
${PRECISION_FLOAT}
layout(location = 0) in vec3 aPos;      // world mm, the plane's shared quad
uniform mat4 uViewProj;
out vec3 vWorld;
// §7.3: "All slice vertex shaders declare invariant gl_Position." Two coplanar quads with different
// vertex data do NOT produce identical interpolated depth (1.6-11.8% overlay dropout [M2Max]);
// identical geometry plus this qualifier is the correctness mechanism, not an optimisation.
invariant gl_Position;
void main() {
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

/**
 * The §7.3 **minimum** slice fragment shader.
 *
 * `IS_LABEL` is a **compile-time** branch, not a uniform: binding an integer texture to a `sampler3D`
 * is `INVALID_OPERATION` `[M2Max]`, so the two sampler types cannot share one compiled program.
 * `ProgramVariants` (`gl/program.ts`) caches the two.
 */
export const SLICE_FS = `${VERSION}
${PRECISION_FLOAT}
${PRECISION_INT}
${PRECISION_SAMPLER3D}
${PRECISION_USAMPLER3D}

in vec3 vWorld;
${WORLD_TO_TEXCOORD_UNIFORMS}
uniform float uOpacity;
${LUT_UNIFORMS}
#if IS_LABEL
uniform usampler3D uVol;
${PALETTE_UNIFORMS}
#else
uniform sampler3D uVol;
${LADDER_UNIFORMS}
#endif
out vec4 fragColor;

void main() {
  vec3 voxel = (uInvAffine * vec4(vWorld, 1.0)).xyz;
  // Voxel centres are at integer indices (§3), so the texture coordinate of centre i is
  // (i + 0.5) / dims.
  vec3 tc = (voxel + vec3(0.5)) / uDims;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) discard;

#if IS_LABEL
  uint dense = texture(uVol, tc).r;
  // No index is special: background is whatever the palette gives zero alpha, which is what a
  // SimNIBS or FreeSurfer LUT already says about id 0 ("Unknown", A = 0). The c.a <= 0.0 discard
  // below is therefore the *only* background rule, and it works for an atlas whose lowest id is not
  // zero just as well as for one whose is.
  ${PALETTE_SAMPLE}
#else
  ${LADDER_DECODE}
  ${LUT_SAMPLE}
#endif
  if (c.a <= 0.0) discard;
  fragColor = vec4(c.rgb, c.a * uOpacity);
}`;
