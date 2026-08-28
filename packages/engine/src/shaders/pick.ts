/**
 * The §7.2.3 pick programs.
 *
 * Two `R32UI` attachments: id, and depth written as `floatBitsToUint(gl_FragCoord.z)` — **depth is
 * read from a second colour attachment, never from the depth attachment**, because WebGL2 restricts
 * `readPixels` to RGBA / RGBA_INTEGER and the implementation-defined format, and `DEPTH_COMPONENT`
 * is not a legal read format.
 *
 * `MESH_PICK_VS` sources the element id with `texelFetch(uOwnerTex, ..., 0)` at `gl_VertexID / 3`
 * over **de-indexed** geometry built in the worker. WebGL2 has no `gl_PrimitiveID` (verified compile
 * error `[M2Max]`), and a per-vertex id attribute would be a UI-thread vertex-buffer expansion,
 * which §5 rule 7 forbids.
 *
 * Phase 2 adds the discards these must reproduce — the up-to-6 clip planes, §7.3's threshold and
 * label discards, and the isolation `BitMask` — because "the pick pass reproduces **every** discard
 * of the main pass. Otherwise double-click lands on geometry the user cannot see."
 */

import {
  CLIP_DEFINES,
  CLIP_DISCARD,
  CLIP_EXTENSION,
  CLIP_UNIFORMS,
  CLIP_WRITE,
  PICK_OUTPUTS,
  PICK_WRITE_DEPTH,
  PRECISION_FLOAT,
  PRECISION_INT,
  PRECISION_SAMPLER3D,
  PRECISION_USAMPLER2D,
  VERSION,
} from './chunks/caps';

/**
 * The mesh pick program.
 *
 * `TVX_CAP` picks a `plane_cut` cap instead of a surface: §7.2.3's `kindBit` is 1 there, and the
 * element number is the cap's own per-vertex `ownerTet` — "Cut caps and flat-shaded field geometry
 * are already de-indexed and carry `ownerElm`" — rather than a `texelFetch` at `gl_VertexID / 3`.
 *
 * The clip defines are the **same chunks** `shaders/mesh.ts` splices, because §7.2.3 requires the
 * pick pass to enable "the same set"; a second copy of the sign convention is how the two drift and
 * a double-click starts landing on geometry the clip removed.
 */
export const MESH_PICK_VS = `${VERSION}
#ifndef TVX_CAP
#define TVX_CAP 0
#endif
${CLIP_DEFINES}
${CLIP_EXTENSION}
${PRECISION_FLOAT}
${PRECISION_INT}
${PRECISION_USAMPLER2D}
layout(location = 0) in vec3 aPos;
#if TVX_CAP
layout(location = 8) in uint aOwnerTet;
#else
uniform usampler2D uOwnerTex;
uniform int uOwnerWidth;
#endif
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform uint uLayerBits;     // (layerIndex + 1) << 25 | kindBit << 24
${CLIP_UNIFORMS}
#if TVX_CLIP_PLANES > 0 && TVX_CLIP_DISCARD == 0
out highp float gl_ClipDistance[TVX_CLIP_PLANES];
#endif
#if TVX_CLIP_PLANES > 0 && TVX_CLIP_DISCARD == 1
out vec3 vWorld;
#endif
flat out uint vId;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
#if TVX_CAP
  uint owner = aOwnerTet;
#else
  int tri = gl_VertexID / 3;
  uint owner = texelFetch(uOwnerTex, ivec2(tri % uOwnerWidth, tri / uOwnerWidth), 0).r;
#endif
  vId = uLayerBits | (owner & 0x00FFFFFFu);
#if TVX_CLIP_PLANES > 0 && TVX_CLIP_DISCARD == 1
  vWorld = w.xyz;
#endif
${CLIP_WRITE}
  gl_Position = uViewProj * w;
}`;

/** Slice quads participate in picking: `elementKind:'slice'`, `elementId` = plane index (§7.2.3). */
export const SLICE_PICK_VS = `${VERSION}
${PRECISION_FLOAT}
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
out vec3 vWorld;
invariant gl_Position;
void main() {
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const SLICE_PICK_FS = `${VERSION}
${PRECISION_FLOAT}
${PRECISION_INT}
${PRECISION_SAMPLER3D}
in vec3 vWorld;
uniform mat4 uInvAffine;
uniform vec3 uDims;
uniform uint uId;
${PICK_OUTPUTS}
void main() {
  // The pick pass reproduces every discard of the main pass (§7.2.3) — otherwise a double-click
  // lands on geometry the user cannot see.
  vec3 tc = ((uInvAffine * vec4(vWorld, 1.0)).xyz + vec3(0.5)) / uDims;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) discard;
  outId = uId;
  ${PICK_WRITE_DEPTH}
}`;

export const PICK_FS = `${VERSION}
${CLIP_DEFINES}
${PRECISION_FLOAT}
${PRECISION_INT}
#if TVX_CLIP_PLANES > 0 && TVX_CLIP_DISCARD == 1
in vec3 vWorld;
${CLIP_UNIFORMS}
uniform int uClipSkip;
#endif
flat in uint vId;
${PICK_OUTPUTS}
void main() {
${CLIP_DISCARD}
  outId = vId;
  ${PICK_WRITE_DEPTH}
}`;
