/**
 * Vector glyphs (§4.4 `GlyphSpec`, §7.4's last bullet).
 *
 * §7.4, verbatim: "one instanced draw of a shared cone+shaft VAO with per-instance origin /
 * direction / magnitude, in the opaque pass. **No new geometry from WASM.** Origins restricted to
 * visible tags and, when a cut plane is active and `clipToCutPlane`, to elements the plane
 * intersects."
 *
 * **Where the origins come from, and why there is no per-instance origin attribute.** Building
 * origins on the UI thread would be geometry (AGENTS rule 7), so an origin is *read* on the GPU out
 * of an `R32F` table the worker filled. There are two such tables and `GlyphSpec.origins` picks
 * between them; both are uploaded verbatim, so §7.4's "**No new geometry from WASM**" holds either
 * way.
 *
 * * **`TVX_GLYPH_VOLUME 0` — `origins: 'surface'`, the default.** The table is a de-indexed triangle
 *   set (`SurfacePayload`). Instance `g` takes triangle `uFirst + g * uStride` (that is
 *   `GlyphSpec.subsample`), averages its three vertices for the origin, and reads its element number
 *   from the same `ownerElm` table §7.2.3 already uses. Per-triangle `faceTag` against the layer's
 *   tag LUT is what restricts origins to visible tags.
 * * **`TVX_GLYPH_VOLUME 1` — `origins: 'volume'`.** The table is §6.5.2's `meshCentroids`: one
 *   point per interior tet, already strided by the op and already filtered to the visible **tet**
 *   tags, in Morton order. Instance `g` reads position `3g` and element number `ownerTet[g]`. There
 *   is no tag texture and no averaging — the op did the restricting, which is what makes a mesh
 *   whose surface no glyph belongs on (a field over all 5,900,498 elements of
 *   `ernie_TDCS_1_scalar.msh`) drawable at all.
 *
 * The field arrives as three `R32F` tables — one per component of `field`, from three `field` ops
 * (§6.5.2) — so no packing pass runs anywhere: each op's `Float32Array` is uploaded as it came.
 * Both origin paths index them the same way, by `ownerElm`/`ownerTet` **minus one**, which §6.5.2
 * licenses only when `MeshMeta.identityElementNumbers` holds.
 *
 * The template is a unit **cone + shaft along +Z** built once per engine (`derived/arrow.ts`); a
 * shared 24-triangle template is not dataset geometry and is exactly what §7.4 asks for.
 */

import { PRECISION_FLOAT, PRECISION_INT, PRECISION_USAMPLER2D, VERSION } from './chunks/caps';

export const GLYPH_VS = `${VERSION}
${PRECISION_FLOAT}
${PRECISION_INT}
// The vertex language has no default precision for an integer sampler; see shaders/fill2d.ts.
${PRECISION_USAMPLER2D}
layout(location = 0) in vec3 aPos;        // unit arrow template, +Z, length 1, radius ~0.06
layout(location = 1) in vec3 aNormal;

uniform mat4 uViewProj;
uniform mat4 uModel;

uniform sampler2D uPosTex;                // R32F, 3 floats per de-indexed vertex
uniform int uPosW;
uniform usampler2D uOwnerTex;             // R32UI, one Gmsh element number per triangle
uniform usampler2D uTagTex;               // R32UI, one tag per triangle
uniform int uTableW;
uniform sampler2D uTagLut;                // RGBA8, alpha 0 = this tag is hidden
uniform int uTagLutW;
uniform int uTagLutN;

uniform sampler2D uFx;                    // R32F over elements: the field's three components
uniform sampler2D uFy;
uniform sampler2D uFz;
uniform int uFieldW;

uniform int uFirst;                       // GlyphSpec.subsample: first triangle …
uniform int uStride;                      // … and every uStride-th after it
uniform float uLengthMm;                  // GlyphSpec.lengthMm
uniform float uByMagnitude;               // 1 = scale 'byMagnitude', 0 = 'fixed'
uniform float uRefMag;                    // the magnitude that maps to uLengthMm
uniform vec2 uLutRange;                   // colorBy 'magnitude': the baked LUT's (lo, hi)

out vec3 vNormal;
out vec3 vWorld;
out float vT;                             // normalised magnitude, for colorBy: 'magnitude'
flat out float vAlpha;                    // 0 when the glyph's tag is hidden or the vector is null

float table1(sampler2D t, int w, int i) {
  return texelFetch(t, ivec2(i % w, i / w), 0).r;
}

void main() {
#if TVX_GLYPH_VOLUME
  // One origin per surviving tet: \`meshCentroids\` applied the stride and the tag filter already,
  // so instance \`g\` is row \`g\` and there is nothing left here to skip or to hide.
  int row = gl_InstanceID;
  int p0 = row * 3;
  vec3 origin = vec3(table1(uPosTex, uPosW, p0), table1(uPosTex, uPosW, p0 + 1), table1(uPosTex, uPosW, p0 + 2));
  vec4 style = vec4(1.0);
  ivec2 tc = ivec2(row % uTableW, row / uTableW);
  uint elm = texelFetch(uOwnerTex, tc, 0).r;
  int fi = max(int(elm) - 1, 0);
#else
  int tri = uFirst + gl_InstanceID * uStride;
  int v0 = tri * 9;                       // 3 vertices x 3 floats
  vec3 a = vec3(table1(uPosTex, uPosW, v0), table1(uPosTex, uPosW, v0 + 1), table1(uPosTex, uPosW, v0 + 2));
  vec3 b = vec3(table1(uPosTex, uPosW, v0 + 3), table1(uPosTex, uPosW, v0 + 4), table1(uPosTex, uPosW, v0 + 5));
  vec3 c = vec3(table1(uPosTex, uPosW, v0 + 6), table1(uPosTex, uPosW, v0 + 7), table1(uPosTex, uPosW, v0 + 8));
  vec3 origin = (a + b + c) / 3.0;

  ivec2 tc = ivec2(tri % uTableW, tri / uTableW);
  uint tag = texelFetch(uTagTex, tc, 0).r;
  int ti = int(min(tag, uint(uTagLutN - 1)));
  vec4 style = texelFetch(uTagLut, ivec2(ti % uTagLutW, ti / uTagLutW), 0);

  uint elm = texelFetch(uOwnerTex, tc, 0).r;
  int fi = max(int(elm) - 1, 0);
#endif
  vec3 e = vec3(table1(uFx, uFieldW, fi), table1(uFy, uFieldW, fi), table1(uFz, uFieldW, fi));
  float mag = length(e);
  vAlpha = (style.a > 0.0 && mag > 0.0) ? 1.0 : 0.0;
  vT = clamp((mag - uLutRange.x) / max(1e-20, uLutRange.y - uLutRange.x), 0.0, 1.0);

  float len = uLengthMm * mix(1.0, mag / max(1e-20, uRefMag), uByMagnitude);
  vec3 dir = mag > 0.0 ? e / mag : vec3(0.0, 0.0, 1.0);
  // An orthonormal frame with +Z on \`dir\`; the reference axis is whichever world axis \`dir\` is
  // least aligned with, so the cross product never degenerates.
  vec3 ref = abs(dir.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(ref, dir));
  vec3 bt = cross(dir, t);
  mat3 frame = mat3(t, bt, dir);

  vec3 local = vec3(aPos.xy * len, aPos.z * len);
  vec4 world = uModel * vec4(origin + frame * local, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * (frame * aNormal);
  gl_Position = uViewProj * world;
}`;

export const GLYPH_FS = `${VERSION}
${PRECISION_FLOAT}
in vec3 vNormal;
in vec3 vWorld;
in float vT;
flat in float vAlpha;
uniform vec3 uEye;
uniform sampler2D uLut;
uniform vec4 uSolidColor;
uniform float uColorByMagnitude;          // 1 = colorBy 'magnitude', 0 = 'solid'
uniform float uAmbient;
uniform float uOpacity;
out vec4 fragColor;

void main() {
  if (vAlpha <= 0.0) discard;
  vec4 base = mix(uSolidColor, texture(uLut, vec2(vT, 0.5)), uColorByMagnitude);
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float diff = max(dot(n, v), 0.0);
  vec3 rgb = base.rgb * (uAmbient + (1.0 - uAmbient) * diff);
  fragColor = vec4(rgb, base.a * uOpacity);
}`;
