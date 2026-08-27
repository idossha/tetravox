/**
 * The §7.4 mesh program.
 *
 * Phase 1 shipped the **minimum**: indexed tag surfaces with the tag colour as a uniform, headlight
 * Blinn-Phong, two-sided lighting, `faceMode`. **No** clip planes, **no** caps, **no** edges, **no**
 * field colouring, **no** glyphs. Phase 2's "§7.4 complete" extends this file and only this file —
 * including the N ∈ 0..6 clip-distance variants, which `ProgramVariants` (`gl/program.ts`) already
 * keys on because §7.1 says a blanket `[6]` costs 20 % of the varying budget on every mesh program.
 */

import { PRECISION_FLOAT, VERSION } from './chunks/caps';

export const MESH_VS = `${VERSION}
${PRECISION_FLOAT}
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

export const MESH_FS = `${VERSION}
${PRECISION_FLOAT}
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
