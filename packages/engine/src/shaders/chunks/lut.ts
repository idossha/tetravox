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
 */

export const LUT_UNIFORMS = `uniform vec2 uLutRange;      // (lo, hi) of the baked LUT, in physical units
uniform sampler2D uLut;`;

export const PALETTE_UNIFORMS = `uniform sampler2D uPalette;  // N x 1 RGBA8, indexed by DENSE index (§7.3)
uniform float uPaletteSize;`;

/** Normalise a physical value into the baked LUT's range and sample it. */
export const LUT_SAMPLE = `float t = (v - uLutRange.x) / max(1e-20, uLutRange.y - uLutRange.x);
  vec4 c = texture(uLut, vec2(clamp(t, 0.0, 1.0), 0.5));`;

/** Sample the `N×1` palette at a **dense** index — `palette[k]` is the colour of `ids[k]`, no offset. */
export const PALETTE_SAMPLE =
  'vec4 c = texture(uPalette, vec2((float(dense) + 0.5) / uPaletteSize, 0.5));';
