/**
 * Tract lines (§7.4.1). `TRACT_QUADS` 0 is the `LINE_STRIP` fast path with primitive restart; 1 is
 * instanced screen-space quads over the same buffers, one instance per consecutive point pair.
 * `TRACT_PICK` writes §7.2.3's id and depth instead of colour. No lighting: a pixel is a function of
 * the data alone, which is what lets §11 assert it.
 */

import { PRECISION_FLOAT, VERSION } from './chunks/caps';

export const TRACT_MODE = { direction: 0, solid: 1, group: 2, scalar: 3 } as const;

const VS_COMMON = `
uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform float uQuantum;
uniform int uMode;
uniform vec4 uSolid;
uniform float uScalarLo;
uniform float uScalarHi;
uniform sampler2D uStyle;
uniform int uStyleWidth;
uniform vec4 uPlane;

out vec3 vColor;
out float vScalar;
out float vNan;
out float vPlane;

vec3 octDecode(vec2 e) {
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    vec2 s = vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
    v.xy = (1.0 - abs(v.yx)) * s;
  }
  return normalize(v);
}

vec4 styleOf(uint id) {
  int w = uStyleWidth;
  return texelFetch(uStyle, ivec2(int(id % uint(w)), int(id / uint(w))), 0);
}

vec3 colorOf(vec2 oct, vec4 style) {
  if (uMode == 0) return abs(octDecode(oct));
  if (uMode == 2) return style.rgb;
  return uSolid.rgb;
}

float physical(float code) {
  return uScalarLo + (code / 65534.0) * (uScalarHi - uScalarLo);
}
`;

export const TRACTS_VS = `${VERSION}
${PRECISION_FLOAT}
precision highp int;
#if TRACT_QUADS
layout(location = 0) in vec3 aA;
layout(location = 1) in vec2 aOctA;
layout(location = 2) in uint aIdA;
layout(location = 3) in float aCodeA;
layout(location = 4) in vec3 aB;
layout(location = 5) in vec2 aOctB;
layout(location = 6) in uint aIdB;
layout(location = 7) in float aCodeB;
uniform vec2 uViewportPx;
uniform float uWidthPx;
#else
layout(location = 0) in vec3 aA;
layout(location = 1) in vec2 aOctA;
layout(location = 2) in uint aIdA;
layout(location = 3) in float aCodeA;
#endif
flat out uint vId;
${VS_COMMON}

void main() {
  vec4 style = styleOf(aIdA);
  vId = aIdA;
#if TRACT_QUADS
  // Corner (t along, side across), from gl_VertexID over a 4-vertex strip.
  float t = float(gl_VertexID & 1);
  float side = float(gl_VertexID & 2) - 1.0;
  vec3 wa = uOrigin + aA * uQuantum;
  vec3 wb = uOrigin + aB * uQuantum;
  vec4 ca = uViewProj * vec4(wa, 1.0);
  vec4 cb = uViewProj * vec4(wb, 1.0);
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uViewportPx;
  float len = length(d);
  if (aIdA != aIdB || style.a < 0.5 || ca.w <= 0.0 || cb.w <= 0.0 || len < 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vScalar = 0.0;
    vNan = 0.0;
    vPlane = 0.0;
    return;
  }
  vec2 n = vec2(-d.y, d.x) / len;
  vec4 clip = mix(ca, cb, t);
  clip.xy += n * side * uWidthPx / uViewportPx * clip.w;
  gl_Position = clip;
  vec3 world = mix(wa, wb, t);
  vColor = mix(colorOf(aOctA, style), colorOf(aOctB, style), t);
  float nanA = aCodeA > 65534.5 ? 1.0 : 0.0;
  float nanB = aCodeB > 65534.5 ? 1.0 : 0.0;
  vNan = mix(nanA, nanB, t);
  vScalar = mix(physical(aCodeA), physical(aCodeB), t);
#else
  vec3 world = uOrigin + aA * uQuantum;
  if (style.a < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    gl_Position = uViewProj * vec4(world, 1.0);
  }
  vColor = colorOf(aOctA, style);
  vNan = aCodeA > 65534.5 ? 1.0 : 0.0;
  vScalar = physical(aCodeA);
#endif
  vPlane = dot(uPlane.xyz, world) + uPlane.w;
}
`;

export const TRACTS_FS = `${VERSION}
${PRECISION_FLOAT}
precision highp int;
flat in uint vId;
in vec3 vColor;
in float vScalar;
in float vNan;
in float vPlane;
uniform int uMode;
uniform float uOpacity;
uniform float uSolidAlpha;
uniform sampler2D uLut;
uniform float uLutLo;
uniform float uLutHi;
uniform int uThreshMode;
uniform float uThreshLo;
uniform float uThreshHi;
uniform float uThreshSoft;
uniform float uClipMax;
uniform float uSlab;
#if TRACT_PICK
uniform uint uLayerBits;
layout(location = 0) out uint oId;
layout(location = 1) out uint oDepth;
#else
out vec4 oColor;
#endif

const vec3 NEUTRAL = vec3(128.0 / 255.0);

void main() {
  if (uSlab >= 0.0 && abs(vPlane) > uSlab) discard;
  vec3 rgb = vColor;
  float alpha = uSolidAlpha;
  if (uMode == 3) {
    if (vNan > 0.0) {
      // A missing value passes no test, so an active threshold hides it (§7.4.1).
      if (uThreshMode != 0) discard;
      rgb = NEUTRAL;
    } else {
      float t = (vScalar - uLutLo) / (uLutHi - uLutLo);
      vec4 base = texture(uLut, vec2(clamp(t, 0.0, 1.0), 0.5));
      if (vScalar > uClipMax) discard;
      rgb = base.rgb;
      alpha *= base.a;
      if (uThreshMode != 0) {
        float tv = uThreshMode == 2 ? abs(vScalar) : vScalar;
        alpha *= smoothstep(uThreshLo, uThreshLo + uThreshSoft, tv);
        alpha *= 1.0 - smoothstep(uThreshHi - uThreshSoft, uThreshHi, tv);
      }
    }
  }
  alpha *= uOpacity;
  if (alpha <= 0.0) discard;
#if TRACT_PICK
  oId = uLayerBits | (vId & 0x00FFFFFFu);
  oDepth = floatBitsToUint(gl_FragCoord.z);
#else
  oColor = vec4(rgb, alpha);
#endif
}
`;
