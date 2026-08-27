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
