/**
 * Every GLSL source in the engine, ESSL 3.00.
 *
 * **The value chain, once (§6.1 + §7.3).** `gpu_payload` never stores physical units except on the
 * `R32F` rows. The normalised rows (3, 4, 6, 7, 8) store an integer **code** and carry
 * `scale = (max - min) / full`, `offset = min`; GL then hands the shader `code / full` because the
 * texture is a normalised integer format. So the shader's job is
 *
 *     physical = texture(...).r * (CODE_FULL * payload.scale) + payload.offset
 *
 * with `CODE_FULL` = 255 for `R8`, 65535 for `R16`, and **1 for `R32F`**, whose payload carries
 * `scale = 1, offset = 0` and stores physical units directly. The engine folds `CODE_FULL * scale`
 * into one uniform, `uValueScale`, so there is one multiply per fragment and one place that can be
 * wrong. `docs/DECISIONS.md` records this as the reading `tvx-nifti` and this shader agree on.
 */

/** Shared by every slice draw (§7.3): one quad per plane, so depth is bit-identical across layers. */
export const SLICE_VS = `#version 300 es
precision highp float;
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
 * The §7.3 **minimum** slice fragment shader: one scalar layer per plane, `Scale {kind:'linear'}`,
 * per-layer AABB discard. No labels, no threshold, no heat scale — those are Phase 2's, and the
 * `IS_LABEL` variant below is the compile-time branch §7.1 requires because binding an integer
 * texture to a `sampler3D` is `INVALID_OPERATION`.
 */
export const SLICE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler3D;

in vec3 vWorld;
uniform mat4 uInvAffine;     // world mm -> voxel index
uniform vec3 uDims;
uniform float uOpacity;
uniform vec2 uLutRange;      // (lo, hi) of the baked LUT, in physical units
uniform sampler2D uLut;
#if IS_LABEL
uniform usampler3D uVol;
uniform sampler2D uPalette;  // N x 1 RGBA8, indexed by DENSE index (§7.3)
uniform float uPaletteSize;
#else
uniform sampler3D uVol;
uniform float uValueScale;   // CODE_FULL * payload.scale  (see the file header)
uniform float uValueOffset;  // payload.offset
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
  vec4 c = texture(uPalette, vec2((float(dense) + 0.5) / uPaletteSize, 0.5));
#else
  float v = texture(uVol, tc).r * uValueScale + uValueOffset;
  float t = (v - uLutRange.x) / max(1e-20, uLutRange.y - uLutRange.x);
  vec4 c = texture(uLut, vec2(clamp(t, 0.0, 1.0), 0.5));
#endif
  if (c.a <= 0.0) discard;
  fragColor = vec4(c.rgb, c.a * uOpacity);
}`;

/**
 * §7.4 **minimum** mesh shader: indexed tag surfaces with the tag colour as a uniform, headlight
 * Blinn-Phong, `faceMode`. No clip planes, no caps, no edges, no field colouring, no glyphs.
 */
export const MESH_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  // The model transform is the user-editable MeshDataset.transform, which is identity on load and a
  // rigid/affine edit thereafter; the normal matrix is its inverse-transpose upper 3x3. For the
  // identity case this is exactly aNormal.
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProj * w;
}`;

export const MESH_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
uniform vec3 uEye;
uniform vec4 uColor;
uniform float uAmbient;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  // Two-sided lighting (§7.4): an interface triangle's stored winding is arbitrary, and a surface
  // lit from behind would read as a hole.
  if (dot(n, v) < 0.0) n = -n;
  // Headlight: the light direction IS the view direction, so there is no light-position uniform.
  float diff = max(dot(n, v), 0.0);
  vec3 h = v;                       // halfway vector of a headlight is the view vector
  float spec = pow(max(dot(n, h), 0.0), 32.0) * 0.25;
  vec3 rgb = uColor.rgb * (uAmbient + (1.0 - uAmbient) * diff) + vec3(spec);
  fragColor = vec4(rgb, uColor.a * uOpacity);
}`;

/**
 * The §7.2.3 pick pass. Two `R32UI` attachments: id, and depth written as
 * `floatBitsToUint(gl_FragCoord.z)` — **depth is read from a second colour attachment, never from
 * the depth attachment**, because WebGL2 restricts `readPixels` to RGBA / RGBA_INTEGER and the
 * implementation-defined format, and `DEPTH_COMPONENT` is not a legal read format.
 *
 * `MESH_PICK_VS` sources the element id with `texelFetch(uOwnerTex, ..., 0)` at `gl_VertexID / 3`
 * over **de-indexed** geometry built in the worker. WebGL2 has no `gl_PrimitiveID` (verified compile
 * error `[M2Max]`), and a per-vertex id attribute would be a UI-thread vertex-buffer expansion,
 * which §5 rule 7 forbids.
 */
export const MESH_PICK_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
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
export const SLICE_PICK_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
out vec3 vWorld;
invariant gl_Position;
void main() {
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const SLICE_PICK_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
in vec3 vWorld;
uniform mat4 uInvAffine;
uniform vec3 uDims;
uniform uint uId;
layout(location = 0) out uint outId;
layout(location = 1) out uint outDepth;
void main() {
  // The pick pass reproduces every discard of the main pass (§7.2.3) — otherwise a double-click
  // lands on geometry the user cannot see.
  vec3 tc = ((uInvAffine * vec4(vWorld, 1.0)).xyz + vec3(0.5)) / uDims;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) discard;
  outId = uId;
  outDepth = floatBitsToUint(gl_FragCoord.z);
}`;

export const PICK_FS = `#version 300 es
precision highp float;
precision highp int;
flat in uint vId;
layout(location = 0) out uint outId;
layout(location = 1) out uint outDepth;
void main() {
  outId = vId;
  outDepth = floatBitsToUint(gl_FragCoord.z);
}`;

/**
 * The overlay pass (§7.2 pass 3) — orientation letters, corner info, the RAD/NEU badge, the
 * crosshair. One dynamic buffer, one draw.
 *
 * `gl.lineWidth()` is a **no-op** (`ALIASED_LINE_WIDTH_RANGE` is `[1,1]` `[M2Max]`), so the
 * crosshair is instanced screen-space quad expansion like every other `*WidthPx` knob on
 * line-drawn geometry — never `LINES`.
 *
 * A negative `aUv.x` marks a solid quad; otherwise the vertex samples the bitmap font atlas.
 */
export const OVERLAY_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;      // NDC
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const OVERLAY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uAtlas;
out vec4 fragColor;
void main() {
  float a = vColor.a;
  if (vUv.x >= 0.0) {
    a *= texture(uAtlas, vUv).r;
  }
  if (a <= 0.0) discard;
  fragColor = vec4(vColor.rgb, a);
}`;
