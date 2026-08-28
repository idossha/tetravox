/**
 * `fillIn2D` — the per-element cut polygons of a mesh layer, drawn in a 2D pane (§7.4's
 * "Surfaces on 2D slices", R4).
 *
 * The geometry is the cut the cut-manager produced for **this pane's** plane: de-indexed triangles,
 * three vertices each, with one `tag` and one `ownerTet` per triangle. §7.4 fixes how a de-indexed
 * draw reads a per-face value — "`texelFetch(elmFieldTex, ivec2(...), 0)` at `gl_VertexID / 3`" —
 * and that is exactly what this program does, for three different per-face quantities:
 *
 * * **`FILL_MODE 0` — tissue tag.** `tag[tri]` indexes an RGBA8 tag LUT whose texel *is* the wire
 *   `[u8;4]` of `MeshMeta.tags[].color`, with alpha carrying `tagStyle[tag].visible / .opacity`.
 *   §4.1 requires that value to round-trip exactly, and it does: the byte goes to the framebuffer
 *   unmodified when the layer is opaque, which is what makes R4's "the pixel equals the tag colour"
 *   a real assertion rather than a tolerance.
 * * **`FILL_MODE 1` — element field.** `ownerTet[tri]` is a **Gmsh element number** (§6.2), so the
 *   field texel is at `elm - 1` under §6.2's identity numbering. One texture per (dataset, field),
 *   uploaded once; switching the displayed field is a texture swap and costs no re-cut (§7.4).
 * * **`FILL_MODE 2` — node field.** The cut's per-vertex interpolated values arrive as a plain
 *   attribute, so the value is interpolated across the triangle and the colormap is sampled per
 *   fragment.
 *
 * Every per-face fetch happens in the **vertex** shader and leaves as `flat`: a `flat` varying
 * cannot be smeared across the triangle by interpolation, which is what makes "the pixel is exactly
 * the tag colour" hold in the interior *and* along the polygon's own edges.
 *
 * **No CPU expansion.** There is no per-vertex `tag` attribute and no per-triangle loop anywhere on
 * the UI thread: the tables are uploaded as textures exactly as the worker produced them (§5 rule 7,
 * AGENTS rule 7).
 */

import { PRECISION_FLOAT, PRECISION_INT, PRECISION_USAMPLER2D, VERSION } from './chunks/caps';

/** How a fill fragment gets its colour. Keyed into the §7.1 variant cache as `FILL_MODE`. */
export const FILL_MODE = { tag: 0, elmField: 1, nodeField: 2 } as const;

export const FILL2D_VS = `${VERSION}
${PRECISION_FLOAT}
${PRECISION_INT}
// ESSL 3.00's vertex language defaults int, float and sampler2D to highp but says nothing about the
// integer sampler types, so an undeclared usampler2D is a compile error — measured, not assumed:
// "'usampler2D' : No precision specified" [SwS].
${PRECISION_USAMPLER2D}
layout(location = 0) in vec3 aPos;        // world mm, de-indexed cut triangles
layout(location = 1) in float aValue;     // FILL_MODE 2 only: the node field, interpolated per vertex

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uOpacity;                   // MeshLayer.opacity

// The per-triangle tables, one texel per triangle, row-major over uTableW.
uniform usampler2D uTagTex;               // R32UI: the Int32 tag reinterpreted; Gmsh tags are >= 0
uniform int uTableW;
uniform sampler2D uTagLut;                // RGBA8, texel[tag] = the wire tag colour, a = visibility
uniform int uTagLutW;                     // row width of that table
uniform int uTagLutN;                     // how many tags it actually covers

#if FILL_MODE == 1
uniform usampler2D uOwnerTex;             // R32UI: ownerTet, a Gmsh element number
uniform sampler2D uFieldTex;              // R32F over elements, indexed by (elm - 1)
uniform int uFieldW;
uniform vec2 uLutRange;                   // the baked LUT's (lo, hi) in physical units
#endif

flat out vec4 vFlatColor;                 // FILL_MODE 0: the tag colour; 1/2: rgb unused, a = alpha
#if FILL_MODE == 1
flat out float vT;                        // normalised position along the colormap
#elif FILL_MODE == 2
out float vValue;
#endif

vec4 fetchRgba8(sampler2D t, int w, int i) {
  return texelFetch(t, ivec2(i % w, i / w), 0);
}

void main() {
  int tri = gl_VertexID / 3;
  uint tag = texelFetch(uTagTex, ivec2(tri % uTableW, tri / uTableW), 0).r;
  // Out-of-range tags take the LUT's last texel rather than wrapping to an unrelated tissue's
  // colour; the store sizes the LUT to max(tag) + 1, so this only fires on a malformed table.
  int ti = int(min(tag, uint(uTagLutN - 1)));
  vec4 style = fetchRgba8(uTagLut, uTagLutW, ti);

#if FILL_MODE == 0
  vFlatColor = vec4(style.rgb, style.a * uOpacity);
#else
  vFlatColor = vec4(0.0, 0.0, 0.0, style.a * uOpacity);
#endif

#if FILL_MODE == 1
  uint elm = texelFetch(uOwnerTex, ivec2(tri % uTableW, tri / uTableW), 0).r;
  int fi = int(elm) - 1;
  fi = max(fi, 0);
  float v = texelFetch(uFieldTex, ivec2(fi % uFieldW, fi / uFieldW), 0).r;
  vT = clamp((v - uLutRange.x) / max(1e-20, uLutRange.y - uLutRange.x), 0.0, 1.0);
#elif FILL_MODE == 2
  vValue = aValue;
#endif

  gl_Position = uViewProj * (uModel * vec4(aPos, 1.0));
}`;

export const FILL2D_FS = `${VERSION}
${PRECISION_FLOAT}
flat in vec4 vFlatColor;
#if FILL_MODE == 1
flat in float vT;
uniform sampler2D uLut;
#elif FILL_MODE == 2
in float vValue;
uniform sampler2D uLut;
uniform vec2 uLutRange;
#endif
out vec4 fragColor;

void main() {
  // A hidden tag (alpha 0 in the LUT) contributes nothing: no fragment, no blend, no dark rim.
  if (vFlatColor.a <= 0.0) discard;
#if FILL_MODE == 0
  fragColor = vFlatColor;
#elif FILL_MODE == 1
  vec4 c = texture(uLut, vec2(vT, 0.5));
  if (c.a <= 0.0) discard;
  fragColor = vec4(c.rgb, c.a * vFlatColor.a);
#else
  float t = clamp((vValue - uLutRange.x) / max(1e-20, uLutRange.y - uLutRange.x), 0.0, 1.0);
  vec4 c = texture(uLut, vec2(t, 0.5));
  if (c.a <= 0.0) discard;
  fragColor = vec4(c.rgb, c.a * vFlatColor.a);
#endif
}`;
