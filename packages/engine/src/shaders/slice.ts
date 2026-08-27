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
  ${LADDER_DECODE}
  ${VALUE_GATE}
  ${LUT_SAMPLE}
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
