/**
 * The §7.3 volume slice program — **complete** (Phase 2, owner E-SLICE).
 *
 * Phase 1 shipped the minimum: one scalar layer per plane, `Scale {kind:'linear'}`, the shared plane
 * geometry, `invariant gl_Position`, and the per-layer AABB discard. This file now carries the rest
 * of §7.3: the value gate (`Threshold` with `softEdge`, symmetric compare, `heat`'s `truncate`
 * clip), label fill / outline / both over the dense index remap with the normative 4-tap outline
 * formula, R5's selected-label emphasis, and — via `SLICE_PICK_GATED_FS` — the same discards in the
 * pick pass, from the same chunks, so the two can never drift.
 *
 * `Scale` itself is **not here**. §7.6: `kind:'heat'` "costs nothing extra in the shader — it is a
 * different bake", and that is only true because everything about min/mid/max, `inverse` and the
 * negative branch is resolved on the CPU in `color/colormaps.ts`. The shader does one divide and one
 * `NEAREST` fetch.
 */

import {
  PICK_OUTPUTS,
  PICK_WRITE_DEPTH,
  PRECISION_FLOAT,
  PRECISION_INT,
  PRECISION_SAMPLER3D,
  PRECISION_USAMPLER3D,
  VERSION,
} from './chunks/caps';
import {
  LADDER_DECODE,
  LADDER_UNIFORMS,
  VALUE_GATE,
  VALUE_GATE_UNIFORMS,
  WORLD_TO_TEXCOORD_UNIFORMS,
} from './chunks/ladder';
import {
  LABEL_BODY,
  LABEL_FUNCS,
  LUT_SAMPLE,
  LUT_UNIFORMS,
  PALETTE_SAMPLE,
  PALETTE_UNIFORMS,
  SCREEN_STEP,
} from './chunks/lut';

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
 * The common head of both slice fragment shaders: the two sampler branches and everything each
 * needs. Interpolated rather than duplicated so the pick program cannot declare a different set.
 *
 * `IS_LABEL` is a **compile-time** branch, not a uniform: binding an integer texture to a `sampler3D`
 * is `INVALID_OPERATION` `[M2Max]`, so the two sampler types cannot share one compiled program.
 * `ProgramVariants` (`gl/program.ts`) caches the two.
 */
const TENSOR_UNIFORMS = `uniform int uTensor;
uniform float uTensorStride;
uniform float uTensorMinFA;
uniform mat4 uAffine;
float tensorAt(ivec3 cell, int slab, int depth) {
  return texelFetch(uVol, ivec3(cell.xy, cell.z + slab * depth), 0).r;
}`;

const SLICE_FS_HEAD = `${PRECISION_FLOAT}
${PRECISION_INT}
${PRECISION_SAMPLER3D}
${PRECISION_USAMPLER3D}

in vec3 vWorld;
${WORLD_TO_TEXCOORD_UNIFORMS}
#if IS_LABEL
uniform usampler3D uVol;
${PALETTE_UNIFORMS}
${LABEL_FUNCS}
#else
uniform sampler3D uVol;
${LADDER_UNIFORMS}
${TENSOR_UNIFORMS}
${LUT_UNIFORMS}
${VALUE_GATE_UNIFORMS}
#endif`;

/**
 * The body both programs run: world → texcoord, the AABB discard, then either the label path or the
 * scalar path, leaving `c` (RGBA, 0..1) and `gateAlpha` set.
 *
 * The screen-pixel step is taken **first**, before the AABB discard, so the derivatives are never
 * asked for inside control flow a discard has already made non-uniform.
 */
const SLICE_FS_BODY = `  ${SCREEN_STEP}
  vec3 planeNormal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 voxel = (uInvAffine * vec4(vWorld, 1.0)).xyz;
  // Voxel centres are at integer indices (§3), so the texture coordinate of centre i is
  // (i + 0.5) / dims. A tc outside [0,1]^3 is outside this layer's own world AABB, which is the
  // discard that makes a showIn3D plane terminate at the data (§7.3).
  vec3 tc = (voxel + vec3(0.5)) / uDims;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) discard;

#if IS_LABEL
  // The label path has no scalar gate; VALUE_GATE declares this one for the scalar path.
  float gateAlpha = 1.0;
  uint dense = texture(uVol, tc).r;
  // No index is special: background is whatever the palette gives zero alpha, which is what a
  // SimNIBS or FreeSurfer LUT already says about id 0 ("Unknown", A = 0). The c.a <= 0.0 discard
  // below is therefore the *only* background rule, and it works for an atlas whose lowest id is not
  // zero just as well as for one whose is. visibleLabels / labelOpacity / recolour are baked into
  // this same texel (layers/volume.ts), so they need no branch here at all.
  ${PALETTE_SAMPLE}
  ${LABEL_BODY}
#else
  vec4 c;
  float gateAlpha = 1.0;
  if (uTensor == 1) {
    ivec3 grid = ivec3(ceil(uDims / uTensorStride));
    ivec3 cell = clamp(ivec3(floor(voxel / uTensorStride + 0.5)), ivec3(0), grid - 1);
    float fa = tensorAt(cell, 7, grid.z);
    float packedColor = tensorAt(cell, 6, grid.z);
    if (packedColor == 0.0 || fa < uTensorMinFA) discard;
    float xx = tensorAt(cell, 0, grid.z), xy = tensorAt(cell, 1, grid.z);
    float xz = tensorAt(cell, 2, grid.z), yy = tensorAt(cell, 3, grid.z);
    float yz = tensorAt(cell, 4, grid.z), zz = tensorAt(cell, 5, grid.z);
    mat3 q = mat3(xx,xy,xz, xy,yy,yz, xz,yz,zz);
    vec3 center = (uAffine * vec4(vec3(cell) * uTensorStride, 1.0)).xyz;
    float spacing = min(length(uAffine[0].xyz), min(length(uAffine[1].xyz), length(uAffine[2].xyz)));
    vec3 delta = (vWorld - center) / (0.42 * spacing * uTensorStride);
    delta -= planeNormal * dot(delta, planeNormal);
    // Project the ellipsoid onto this plane by minimising its quadratic along the normal.
    // The same silhouette and FA gate are used for picking.
    vec3 qn = q * planeNormal;
    float dn = dot(delta, qn);
    float radius2 = max(0.0, dot(delta, q * delta) - dn*dn / dot(planeNormal, qn));
    if (radius2 > 1.0) discard;
    vec3 rgb = mod(floor(packedColor / vec3(1.0,256.0,65536.0)), 256.0) / 255.0;
    c = vec4(rgb * (0.4 + 0.6 * sqrt(1.0 - radius2)), 1.0);
  } else {
    ${LADDER_DECODE}
    ${VALUE_GATE.replace('float gateAlpha =', 'gateAlpha =')}
    ${LUT_SAMPLE.replace('vec4 c =', 'c =')}
  }
#endif
  if (c.a <= 0.0) discard;`;

/** The §7.3 slice fragment shader. */
export const SLICE_FS = `${VERSION}
${SLICE_FS_HEAD}
uniform float uOpacity;
out vec4 fragColor;

void main() {
${SLICE_FS_BODY}
  fragColor = vec4(c.rgb, c.a * gateAlpha * uOpacity);
}`;

/**
 * The slice **pick** fragment shader, gated exactly like the frame (§7.2.3).
 *
 * It runs `SLICE_FS_BODY` verbatim — the same threshold, the same `truncate` clip, the same palette
 * alpha, the same 4-tap outline test — and then writes the id instead of a colour. Phase 1's
 * `SLICE_PICK_FS` (`shaders/pick.ts`) reproduced only the AABB discard, which was correct for what
 * Phase 1 drew; with `outline` mode and a threshold in play, a hand-copied second implementation is
 * precisely how "double-click lands on geometry the user cannot see" gets shipped.
 *
 * `gateAlpha` is deliberately *not* consulted: a soft-edge fragment is visible, however faintly, so
 * it is pickable. Only what the frame **discards** is unpickable.
 */
export const SLICE_PICK_GATED_FS = `${VERSION}
${SLICE_FS_HEAD}
uniform uint uId;
${PICK_OUTPUTS}

void main() {
${SLICE_FS_BODY}
  outId = uId;
  ${PICK_WRITE_DEPTH}
}`;
