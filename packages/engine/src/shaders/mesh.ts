/**
 * The §7.4 mesh program.
 *
 * Phase 1 shipped the **minimum**: indexed tag surfaces with the tag colour as a uniform, headlight
 * Blinn-Phong, two-sided lighting, `faceMode`. Phase 2's "§7.4 complete" extends this file and only
 * this file — the clip-distance variants N ∈ 0..6 land beside these defines, and `ProgramVariants`
 * (`gl/program.ts`) already keys on them because §7.1 says a blanket `[6]` costs 20 % of the varying
 * budget on every mesh program.
 *
 * **The `TVX_COLOR_SOURCE = 0`, no-edges, no-flat, no-threshold variant is Phase 1's shader
 * verbatim.** The `#if`s fold away to exactly the Phase-1 source, so the two Phase-1 gate goldens
 * that contain a mesh do not move.
 *
 * ## Defines
 *
 * | define | meaning |
 * |---|---|
 * | `TVX_COLOR_SOURCE` | 0 = uniform colour (`colorMode` `'tag'` / `'solid'`) · 1 = node field · 2 = element field · 3 = label |
 * | `TVX_EDGES` | barycentric edges; implies the de-indexed variant's `corner` attribute |
 * | `TVX_EDGE_MASK` | the per-triangle 3-bit mask exists; 0 = every edge is real, folded to a constant |
 * | `TVX_FLAT_SHADING` | face normal from screen-space derivatives instead of the interpolated one |
 * | `TVX_THRESHOLD` | 0 = none · 1 = `mode:'hide'` on `v` · 2 = `mode:'hide'` on `abs(v)` (`symmetric`) |
 * | `TVX_EMPHASIS` | selected-label edge emphasis (R5); `TVX_COLOR_SOURCE == 3` only |
 *
 * ## Where each colour comes from, and why
 *
 * * **Node field (1).** §7.4's indexed variant carries `nodeIndex` — "vertex → INTERNAL 0-based node
 *   index, which is what the §7.4 node-field texture is indexed by". One `texelFetch` in the vertex
 *   shader and one interpolated `float` varying: a node field is *smooth* by construction.
 * * **Element field (2).** §7.4's de-indexed variant, "the per-face scalar from
 *   `texelFetch(elmFieldTex, ivec2(...), 0)` at `gl_VertexID / 3`". The triangle's element comes from
 *   the same `ownerElm` R32UI table the pick pass reads, so no per-vertex id attribute is built (§5
 *   rule 7). All three vertices of a triangle fetch the same value, so the varying interpolates a
 *   constant — the field is *flat* with no `flat` qualifier and no dependence on ES's last-vertex
 *   provoking rule, which §7.4 rejects as a shortcut.
 * * **Label (3).** A `.annot` / `.label.gii` label is a **node** quantity, and §6.2 remaps it to a
 *   dense `0..N−1` index at parse time, so the value in the node table *is* the palette index. The
 *   palette is an `N×2 RGBA8` texture: row 0 is the label's colour with its visibility folded into
 *   alpha (recolour / hide / solo are all a palette re-upload — R5), row 1's red channel is whether
 *   the label is selected. Both are read in the vertex shader; inside a label — every triangle whose
 *   three corners agree, which is all but the seam — the interpolant is exactly the palette colour,
 *   so §11's 0..255 round trip holds on the pixel.
 *
 * ## Edges
 *
 * §7.4's mechanism verbatim: a 3-bit `edgeMask`, `d = bary / fwidth(bary)`, `d[i] = 1e9` for cleared
 * bits so a suppressed edge never contributes to the `min` and slivers do not flood, shaded
 * `1 − smoothstep(w − 0.5, w + 0.5, min(d))`. The corner ordinal is the 1-byte `corner` attribute
 * expanded to a `vec3` here — never three floats per vertex.
 *
 * The mask itself is a **per-triangle `R8UI` texture** read at `gl_VertexID / 3`, not the per-vertex
 * attribute §7.4 names: `SurfacePayload.edgeMask` is one byte per *triangle*, so binding it as a
 * per-vertex attribute would mean expanding it 3× on the UI thread, and §5 rule 7 puts every
 * vertex-buffer expansion in the worker. §7.4's "when a whole draw is unmasked ... the common case
 * costs zero memory" is served one better by `TVX_EDGE_MASK 0`, which folds the mask to a compile-
 * time `vec3(1)` — no attribute slot, no buffer, no fetch. See docs/DECISIONS.md.
 *
 * The **selected-label emphasis** (R5) reuses the same idea one dimension up: the per-vertex
 * "selected" indicator interpolates 0…1 across a seam, and `abs(s − 0.5) / fwidth(s)` is the distance
 * in **pixels** from the selection boundary, so the band keeps its width at any zoom.
 */

import {
  PRECISION_FLOAT,
  PRECISION_INT,
  PRECISION_SAMPLER2D,
  PRECISION_USAMPLER2D,
  VERSION,
} from './chunks/caps';

/** `TVX_COLOR_SOURCE` values, so the pass and the shader cannot drift apart. */
export const MESH_COLOR_SOURCE = {
  uniform: 0,
  nodeField: 1,
  elmField: 2,
  label: 3,
} as const;

/** `TVX_THRESHOLD` values (§4.2: `mode:'clamp'` needs no discard — the CPU bake already clamps). */
export const MESH_THRESHOLD = {
  none: 0,
  hide: 1,
  hideSymmetric: 2,
} as const;

export const MESH_VS = `${VERSION}
${PRECISION_FLOAT}
${PRECISION_INT}
${PRECISION_SAMPLER2D}
${PRECISION_USAMPLER2D}
#ifndef TVX_COLOR_SOURCE
#define TVX_COLOR_SOURCE 0
#endif
#ifndef TVX_EDGES
#define TVX_EDGES 0
#endif
#ifndef TVX_EDGE_MASK
#define TVX_EDGE_MASK 0
#endif
#ifndef TVX_EMPHASIS
#define TVX_EMPHASIS 0
#endif
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
#if TVX_EDGES
layout(location = 2) in uint aCorner;
#endif
#if TVX_COLOR_SOURCE == 1 || TVX_COLOR_SOURCE == 3
layout(location = 4) in uint aNodeIndex;
#endif
uniform mat4 uViewProj;
uniform mat4 uModel;
#if TVX_COLOR_SOURCE >= 1
uniform sampler2D uFieldTex;      // R32F: one texel per node (1, 3) or per element (2)
uniform int uFieldWidth;
#endif
#if TVX_COLOR_SOURCE == 2
uniform usampler2D uOwnerTex;     // the pick pass's ownerElm table, reused (§7.2.3)
uniform int uOwnerWidth;
#endif
#if TVX_EDGES && TVX_EDGE_MASK
uniform usampler2D uEdgeMaskTex;  // R8UI, §7.4's 3-bit mask, one texel per triangle
uniform int uEdgeMaskWidth;
#endif
#if TVX_COLOR_SOURCE == 3
uniform sampler2D uPalette;       // N x 2 RGBA8: row 0 colour+visibility, row 1 selection
uniform int uPaletteSize;
#endif
out vec3 vWorld;
out vec3 vNormal;
#if TVX_COLOR_SOURCE == 1 || TVX_COLOR_SOURCE == 2
out float vScalar;
#endif
#if TVX_COLOR_SOURCE == 3
out vec4 vLabelColor;
#if TVX_EMPHASIS
out float vLabelSelected;
#endif
#endif
#if TVX_EDGES
out vec3 vBary;
#if TVX_EDGE_MASK
out vec3 vEdgeOn;
#endif
#endif
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  // The model transform is the user-editable MeshDataset.transform, which is identity on load and a
  // rigid/affine edit thereafter; the normal matrix is its inverse-transpose upper 3x3. For the
  // identity case this is exactly aNormal.
  vNormal = mat3(uModel) * aNormal;
#if TVX_COLOR_SOURCE == 1
  int nodeRow = int(aNodeIndex);
  vScalar = texelFetch(uFieldTex, ivec2(nodeRow % uFieldWidth, nodeRow / uFieldWidth), 0).r;
#elif TVX_COLOR_SOURCE == 2
  int tri = gl_VertexID / 3;
  uint owner = texelFetch(uOwnerTex, ivec2(tri % uOwnerWidth, tri / uOwnerWidth), 0).r;
  // §6.2's identity numbering: a Gmsh element number is its 0-based row plus one.
  int elmRow = max(int(owner) - 1, 0);
  vScalar = texelFetch(uFieldTex, ivec2(elmRow % uFieldWidth, elmRow / uFieldWidth), 0).r;
#elif TVX_COLOR_SOURCE == 3
  int nodeRow = int(aNodeIndex);
  // §6.2 remaps a packed .annot / .label.gii id to a dense 0..N-1 index at parse time, so the node
  // value IS the palette index; the +0.5 round-trip is exact for the integers that remap produces.
  float raw = texelFetch(uFieldTex, ivec2(nodeRow % uFieldWidth, nodeRow / uFieldWidth), 0).r;
  int k = clamp(int(floor(raw + 0.5)), 0, uPaletteSize - 1);
  vLabelColor = texelFetch(uPalette, ivec2(k, 0), 0);
#if TVX_EMPHASIS
  vLabelSelected = texelFetch(uPalette, ivec2(k, 1), 0).r;
#endif
#endif
#if TVX_EDGES
  vBary = vec3(aCorner == 0u, aCorner == 1u, aCorner == 2u);
#if TVX_EDGE_MASK
  int edgeTri = gl_VertexID / 3;
  uint m = texelFetch(uEdgeMaskTex,
                      ivec2(edgeTri % uEdgeMaskWidth, edgeTri / uEdgeMaskWidth), 0).r;
  // All three vertices of a triangle read the same texel, so this varying interpolates a constant.
  vEdgeOn = vec3((m & 1u) != 0u, (m & 2u) != 0u, (m & 4u) != 0u);
#endif
#endif
  gl_Position = uViewProj * w;
}`;

export const MESH_FS = `${VERSION}
${PRECISION_FLOAT}
${PRECISION_INT}
${PRECISION_SAMPLER2D}
#ifndef TVX_COLOR_SOURCE
#define TVX_COLOR_SOURCE 0
#endif
#ifndef TVX_EDGES
#define TVX_EDGES 0
#endif
#ifndef TVX_EDGE_MASK
#define TVX_EDGE_MASK 0
#endif
#ifndef TVX_FLAT_SHADING
#define TVX_FLAT_SHADING 0
#endif
#ifndef TVX_THRESHOLD
#define TVX_THRESHOLD 0
#endif
#ifndef TVX_EMPHASIS
#define TVX_EMPHASIS 0
#endif
in vec3 vWorld;
in vec3 vNormal;
#if TVX_COLOR_SOURCE == 1 || TVX_COLOR_SOURCE == 2
in float vScalar;
uniform sampler2D uLut;
uniform float uLutLo;
uniform float uLutHi;
#endif
#if TVX_COLOR_SOURCE == 3
in vec4 vLabelColor;
#if TVX_EMPHASIS
in float vLabelSelected;
#endif
#endif
#if TVX_THRESHOLD
uniform float uThreshLo;
uniform float uThreshHi;
uniform float uThreshSoft;
#endif
#if TVX_EDGES
in vec3 vBary;
#if TVX_EDGE_MASK
in vec3 vEdgeOn;
#endif
#endif
#if TVX_EDGES || TVX_EMPHASIS
uniform vec4 uEdgeColor;
uniform float uEdgeWidthPx;
#endif
uniform vec3 uEye;
uniform vec4 uColor;
uniform float uAmbient;
uniform float uOpacity;
out vec4 fragColor;
void main() {
#if TVX_FLAT_SHADING
  // §4.4's flatShading. The face normal from screen-space derivatives of the world position needs no
  // second geometry variant and is exact for a planar triangle.
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
#else
  vec3 n = normalize(vNormal);
#endif
  vec3 v = normalize(uEye - vWorld);
  // Two-sided lighting (§7.4): an interface triangle's stored winding is arbitrary, and a surface
  // lit from behind would read as a hole.
  if (dot(n, v) < 0.0) n = -n;
  // Headlight: the light direction IS the view direction, so there is no light-position uniform.
  float diff = max(dot(n, v), 0.0);
  vec3 h = v;                       // halfway vector of a headlight is the view vector
  float spec = pow(max(dot(n, h), 0.0), 32.0) * 0.25;
#if TVX_COLOR_SOURCE == 0
  vec4 base = uColor;
#elif TVX_COLOR_SOURCE == 1 || TVX_COLOR_SOURCE == 2
  float lutT = (vScalar - uLutLo) / (uLutHi - uLutLo);
  vec4 base = texture(uLut, vec2(clamp(lutT, 0.0, 1.0), 0.5));
#else
  vec4 base = vLabelColor;
#endif
  float alpha = base.a * uOpacity;
#if TVX_THRESHOLD
#if TVX_THRESHOLD == 2
  float tv = abs(vScalar);          // §4.2: a symmetric threshold compares |v|
#else
  float tv = vScalar;
#endif
  // §4.2 verbatim: softEdge is "the width of the alpha ramp as a fraction of hi - lo; 0 = hard
  // discard". The CPU passes that width already multiplied out and floored just above zero, so the
  // degenerate smoothstep(e, e, x) never appears.
  alpha *= smoothstep(uThreshLo, uThreshLo + uThreshSoft, tv);
  alpha *= 1.0 - smoothstep(uThreshHi - uThreshSoft, uThreshHi, tv);
#endif
  vec3 rgb = base.rgb * (uAmbient + (1.0 - uAmbient) * diff) + vec3(spec);
#if TVX_EDGES
#if TVX_EDGE_MASK
  vec3 edgeOn = vEdgeOn;
#else
  // §7.4's "when a whole draw is unmasked" case, one better than the constant attribute it suggests:
  // a compile-time constant costs no attribute slot, no buffer and no fetch.
  vec3 edgeOn = vec3(1.0);
#endif
  // §7.4: d = bary / fwidth(bary), with a cleared mask bit pushed out of the min entirely.
  vec3 d = mix(vec3(1e9), vBary / max(fwidth(vBary), vec3(1e-9)), edgeOn);
  float edge = 1.0 - smoothstep(uEdgeWidthPx - 0.5, uEdgeWidthPx + 0.5, min(min(d.x, d.y), d.z));
  rgb = mix(rgb, uEdgeColor.rgb, edge * uEdgeColor.a);
#endif
#if TVX_EMPHASIS && TVX_COLOR_SOURCE == 3
  // The selected label's boundary, in screen space: abs(s - 0.5) / fwidth(s) is the distance in
  // pixels from the s = 0.5 iso-line, so the band keeps its width at any zoom (R5's outline
  // emphasis). Inside a label fwidth(s) is 0 and the band never appears.
  float sd = abs(vLabelSelected - 0.5) / max(fwidth(vLabelSelected), 1e-9);
  float emph = 1.0 - smoothstep(uEdgeWidthPx - 0.5, uEdgeWidthPx + 0.5, sd);
  rgb = mix(rgb, uEdgeColor.rgb, emph * uEdgeColor.a);
  alpha = max(alpha, emph * uEdgeColor.a);
#endif
  if (alpha <= 0.0) discard;
  fragColor = vec4(rgb, alpha);
}`;
