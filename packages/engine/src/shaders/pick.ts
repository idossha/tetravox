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
  PICK_OUTPUTS,
  PICK_WRITE_DEPTH,
  PRECISION_FLOAT,
  PRECISION_INT,
  PRECISION_SAMPLER3D,
  PRECISION_USAMPLER2D,
  VERSION,
} from './chunks/caps';

export const MESH_PICK_VS = `${VERSION}
${PRECISION_FLOAT}
${PRECISION_INT}
${PRECISION_USAMPLER2D}
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform usampler2D uOwnerTex;
uniform int uOwnerWidth;
uniform uint uLayerBits;     // (layerIndex + 1) << 25 | kindBit << 24
flat out uint vId;
void main() {
  int tri = gl_VertexID / 3;
  uint owner = texelFetch(uOwnerTex, ivec2(tri % uOwnerWidth, tri / uOwnerWidth), 0).r;
  vId = uLayerBits | (owner & 0x00FFFFFFu);
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
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
${PRECISION_FLOAT}
${PRECISION_INT}
flat in uint vId;
${PICK_OUTPUTS}
void main() {
  outId = vId;
  ${PICK_WRITE_DEPTH}
}`;
