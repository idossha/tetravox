/**
 * Colour lookup, in GLSL — the two branches §7.6 keeps apart.
 *
 * * **Continuous scalars** read a 256×1 RGBA8 texture baked on the CPU from `Scale` (`bakeScale`),
 *   512×1 when `negative === 'separate'`. `kind: 'heat'` "costs nothing extra in the shader — it is a
 *   different bake", which is only true because the shader does nothing but a normalised lookup.
 * * **Labels** cannot use a 256×1 texture: FreeSurfer / `.annot` ids do not fit in a byte. §7.3's
 *   path is a **dense index remap** in `R8UI`/`R16UI` plus an `N×1 RGBA8` palette, `usampler3D`,
 *   NEAREST forced.
 *
 * Background is decided by **alpha**, not by index. SimNIBS and FreeSurfer LUTs give id 0
 * ("Unknown") `A = 0`, so a single `c.a <= 0.0` discard is the whole background rule and it works for
 * an atlas whose lowest id is not zero just as well as for one whose is.
 *
 * **`visibleLabels`, `labelOpacity` and per-label recolour are all baked into the palette** — see
 * `layers/volume.ts`'s `buildLabelPalette`. Hiding a label is `A = 0`; per-label opacity multiplies
 * `A`; a recolour rewrites `RGB`. That is the whole mechanism, and it is why R5's gate assertion
 * ("hiding a label leaves every other pixel byte-identical") is true by construction rather than by
 * care: one texel of one `N×1` texture changes and nothing else in the frame does.
 */

export const LUT_UNIFORMS = `uniform vec2 uLutRange;      // (lo, hi) of the baked LUT, in physical units
uniform sampler2D uLut;`;

export const PALETTE_UNIFORMS = `uniform sampler2D uPalette;  // N x 1 RGBA8, indexed by DENSE index (§7.3)
uniform sampler2D uLabelAttr; // N x 1 RGBA8; .r = 1.0 when the label is SELECTED (§8's region panel)
uniform float uPaletteSize;
uniform float uOutlineWidthPx;   // render-target px (§7.0.5), never voxels
uniform int uLabelMode;          // 0 = fill, 1 = outline, 2 = both
uniform float uOutlineDarken;    // 'both': the rim is the label's own colour x this
uniform vec4 uSelectColor;       // R5's selected-label emphasis rim
uniform float uSelectWidthScale; // ...and how much wider than uOutlineWidthPx it is`;

/** Normalise a physical value into the baked LUT's range and sample it. */
export const LUT_SAMPLE = `float t = (v - uLutRange.x) / max(1e-20, uLutRange.y - uLutRange.x);
  vec4 c = texture(uLut, vec2(clamp(t, 0.0, 1.0), 0.5));`;

/** Sample the `N×1` palette at a **dense** index — `palette[k]` is the colour of `ids[k]`, no offset. */
export const PALETTE_SAMPLE =
  'vec4 c = texture(uPalette, vec2((float(dense) + 0.5) / uPaletteSize, 0.5));';

/**
 * §7.3's **normative 4-tap label-outline formula**, as two global functions.
 *
 * They are global (not inlined into `main`) because both the slice program and the slice **pick**
 * program need them and §7.2.3 requires the pick pass to reproduce every discard — a second,
 * hand-copied outline test in the pick shader is exactly the divergence that makes double-click land
 * on a fragment the user cannot see. They reference `uVol` directly rather than taking it as a
 * parameter, so they must be interpolated inside the `#if IS_LABEL` branch that declares it.
 *
 * The step is **screen-relative on purpose** and is not to be re-derived from voxel size:
 * `duv = (inverseAffine · dFdx(worldPos)) / dims` is the texture-space extent of one screen pixel,
 * so the drawn band stays a constant screen width at any zoom and stays correct on a `showIn3D`
 * plane under perspective, where world-per-pixel varies across a single quad. The proposed
 * voxel-space step yields a **12.87 px** band covering 42.3 % of the viewport at 0.05 mm/px — a 13×
 * regression — and cannot recover a distance from 4 binary taps anyway. 8 taps buy 2.76 px instead
 * of 2.69 px at 45° for 12 % more slice-composite cost. **4 taps.**
 *
 * The `0.5` is because **both** sides of a boundary are flagged: taps at `± 0.5 · outlineWidthPx`
 * draw a band `outlineWidthPx` wide, and a naive `± outlineWidthPx` offset draws twice the requested
 * width. Offsetting in texture space (rather than adding a small world delta to a large world
 * coordinate) also avoids f32 cancellation at extreme magnification.
 */
export const LABEL_FUNCS = `bool tvxLabelDiffers(vec3 tc, uint centre) {
  return texture(uVol, clamp(tc, 0.0, 1.0)).r != centre;
}
// 4 taps at +/- k along the two screen axes, in texture space, clamped to [0,1]^3.
bool tvxLabelEdge(vec3 tc, uint centre, vec3 du, vec3 dv, float k) {
  return tvxLabelDiffers(tc + k * du, centre) || tvxLabelDiffers(tc - k * du, centre)
      || tvxLabelDiffers(tc + k * dv, centre) || tvxLabelDiffers(tc - k * dv, centre);
}
bool tvxLabelSelected(uint dense) {
  return texture(uLabelAttr, vec2((float(dense) + 0.5) / uPaletteSize, 0.5)).r > 0.5;
}`;

/**
 * The label body: fill / outline / both, plus R5's selected-label emphasis.
 *
 * Expects `tc`, `dense`, `c` (the palette sample) and the two screen-pixel texture-space steps
 * `duv` / `dvv` to be in scope, and leaves the fragment's colour in `c`.
 *
 * * `fill` — the label's colour everywhere.
 * * `outline` — the label's colour on the boundary only; the interior is discarded, which is what
 *   makes an atlas readable over an anatomical base.
 * * `both` — fill, with the boundary darkened by `uOutlineDarken` so the rim reads as a rim. Drawing
 *   the rim in the label's own undarkened colour would make `both` pixel-identical to `fill`.
 *
 * The emphasis rim is drawn **in every mode, `fill` included** — that is the point of R5: you select
 * a region and its border lights up while its fill stays exactly as it was. A hidden label
 * (`palette.a == 0`) gets no rim.
 */
export const LABEL_BODY = `float outlineK = 0.5 * uOutlineWidthPx;
  bool labelEdge = uLabelMode != 0 && tvxLabelEdge(tc, dense, duv, dvv, outlineK);
  if (tvxLabelSelected(dense)
      && tvxLabelEdge(tc, dense, duv, dvv, outlineK * uSelectWidthScale)) {
    if (c.a <= 0.0) discard;
    c = uSelectColor;
  } else if (uLabelMode == 1) {
    if (!labelEdge) discard;
  } else if (uLabelMode == 2 && labelEdge) {
    c = vec4(c.rgb * uOutlineDarken, c.a);
  }`;

/**
 * The texture-space extent of one screen pixel, computed **before any discard**.
 *
 * `vWorld` is linear across the quad, so these derivatives are well defined on the whole primitive;
 * taking them first keeps them out of any control flow a `discard` has already made non-uniform.
 */
export const SCREEN_STEP = `vec3 duv = (uInvAffine * vec4(dFdx(vWorld), 0.0)).xyz / uDims;
  vec3 dvv = (uInvAffine * vec4(dFdy(vWorld), 0.0)).xyz / uDims;`;
