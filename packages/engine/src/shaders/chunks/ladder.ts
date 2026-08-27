/**
 * The §6.1 format-ladder value chain, in GLSL — **the one multiply that turns a texel into physics.**
 *
 * `gpu_payload` never stores physical units except on the `R32F` rows. The normalised rows (3, 4, 6,
 * 7, 8) store an integer **code** and carry `scale = (max - min) / full`, `offset = min`; GL then
 * hands the shader `code / full` because the texture is a normalised integer format. So:
 *
 *     physical = texture(...).r * (CODE_FULL * payload.scale) + payload.offset
 *
 * with `CODE_FULL` = 255 for `R8`, 65535 for `R16`, and **1 for `R32F`**, whose payload carries
 * `scale = 1, offset = 0` and stores physical units directly. The engine folds `CODE_FULL * scale`
 * into one uniform, `uValueScale` (`render/gpu.ts`'s `codeFull`), so there is one multiply per
 * fragment and one place that can be wrong. `docs/DECISIONS.md` records this as the reading
 * `tvx-nifti` and this shader agree on.
 *
 * The golden authority has no `EXT_texture_norm16`, so every golden pins the R32F branch and the R16
 * branch is covered by the paired `forceCaps` analytic tests (§11). Both branches run **this** line.
 *
 * This file also carries the **value gate** — §4.2's `Threshold` and `heat`'s `truncate` clip — which
 * belongs beside the decode because it is the second thing that happens to `v`, and because the pick
 * pass has to reproduce it exactly (§7.2.3: "the pick pass reproduces **every** discard of the main
 * pass. Otherwise double-click lands on geometry the user cannot see.").
 */

export const LADDER_UNIFORMS = `uniform float uValueScale;   // CODE_FULL * payload.scale  (see the file header)
uniform float uValueOffset;  // payload.offset`;

/** Decode one scalar texel of `uVol` at `tc` into physical units. */
export const LADDER_DECODE = 'float v = texture(uVol, tc).r * uValueScale + uValueOffset;';

/**
 * World mm → texture coordinate, and the per-layer AABB discard that goes with it.
 *
 * Voxel centres are at integer indices (§3), so the texture coordinate of centre `i` is
 * `(i + 0.5) / dims`; a `tc` outside `[0,1]³` is outside this layer's own box, which is exactly
 * §7.3's "discard fragments outside the owning layer's world AABB".
 */
export const WORLD_TO_TEXCOORD_UNIFORMS = `uniform mat4 uInvAffine;     // world mm -> voxel index
uniform vec3 uDims;`;

/**
 * §4.2's `Threshold`, plus `heat`'s `truncate` clip.
 *
 * `uSoftEdge` is §4.2's definition **verbatim**, and there is no other one: *width of the alpha ramp
 * as a fraction of `hi - lo`; 0 = hard discard*. Not a count of histogram bins, not a fraction of one
 * bin. `uSymmetric` compares `|v|` (§7.3). `uClipMax` is `BakedLut.clipMax` — a LUT cannot express a
 * discard, because it is defined only over its own range and a sampler clamps rather than dropping.
 *
 * The engine sends **finite sentinels** rather than `±Infinity` (`render/passes/slice.ts`), so
 * nothing here has to reason about `inf - inf`.
 */
export const VALUE_GATE_UNIFORMS = `uniform vec2 uThreshold;     // (lo, hi), physical units
uniform float uSoftEdge;     // fraction of (hi - lo); 0 = hard discard
uniform int uThresholdMode;  // 0 = clamp, 1 = hide
uniform int uSymmetric;      // 1 => compare |v|
uniform float uClipMax;      // heat truncate: |v| > uClipMax is discarded`;

/**
 * Apply the gate to `v`, producing `gateAlpha`.
 *
 * `'hide'` discards (hard) or ramps (`softEdge > 0`); `'clamp'` pulls the value into the window and
 * never discards — which is why the ramp lives only on the `'hide'` branch: the ramp **is** the soft
 * form of the discard, and a clamped fragment was never going to be dropped.
 */
export const VALUE_GATE = `float gateValue = uSymmetric == 1 ? abs(v) : v;
  float gateAlpha = 1.0;
  if (uThresholdMode == 1) {
    float ramp = uSoftEdge * (uThreshold.y - uThreshold.x);
    if (ramp <= 0.0) {
      if (gateValue < uThreshold.x || gateValue > uThreshold.y) discard;
    } else {
      gateAlpha = smoothstep(uThreshold.x, uThreshold.x + ramp, gateValue)
                * (1.0 - smoothstep(uThreshold.y - ramp, uThreshold.y, gateValue));
      if (gateAlpha <= 0.0) discard;
    }
  } else if (uSymmetric == 1) {
    v = sign(v) * clamp(abs(v), uThreshold.x, uThreshold.y);
  } else {
    v = clamp(v, uThreshold.x, uThreshold.y);
  }
  if (abs(v) > uClipMax) discard;`;
