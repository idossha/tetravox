/**
 * A 5×7 bitmap font, defined in this file as bit patterns.
 *
 * **Why not a system font.** §8's 2D view chrome — orientation letters, corner info, the RAD/NEU
 * badge — is a *laterality-safety requirement*, and §11 requires it present in every golden. Goldens
 * are compared at `maxDiffPixelRatio <= 0.002` across macOS and `ubuntu-24.04`, and any
 * `canvas.fillText` rasterises differently on the two (different font files, different hinting), so
 * a system font would make the letters the least reproducible pixels on the page. These glyphs are
 * bytes in the repository: identical everywhere, forever.
 *
 * The atlas is one row of 6×8 cells, single-channel R8, sampled NEAREST and scaled by an integer
 * factor so it stays crisp at any DPR.
 */

export const GLYPH_W = 5;
export const GLYPH_H = 7;
export const CELL_W = 6;
export const CELL_H = 8;

/** Every character the chrome can draw. Anything else renders as a blank cell. */
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:-+/()';

// One string per glyph: 7 rows of 5 characters, '1' = on. Validated by `font.test.ts`.
const BITS: string[] = [
  '01110100011000111111100011000110001', // A
  '11110100011000111110100011000111110', // B
  '01110100011000010000100001000101110', // C
  '11110100011000110001100011000111110', // D
  '11111100001000011110100001000011111', // E
  '11111100001000011110100001000010000', // F
  '01110100011000010111100011000101111', // G
  '10001100011000111111100011000110001', // H
  '11111001000010000100001000010011111', // I
  '00111000100001000010000101001001100', // J
  '10001100101010011000101001001010001', // K
  '10000100001000010000100001000011111', // L
  '10001110111010110101100011000110001', // M
  '10001110011010110011100011000110001', // N
  '01110100011000110001100011000101110', // O
  '11110100011000111110100001000010000', // P
  '01110100011000110001101011001001101', // Q
  '11110100011000111110101001001010001', // R
  '01111100001000001110000010000111110', // S
  '11111001000010000100001000010000100', // T
  '10001100011000110001100011000101110', // U
  '10001100011000110001100010101000100', // V
  '10001100011000110101101011101110001', // W
  '10001100010101000100010101000110001', // X
  '10001100010101000100001000010000100', // Y
  '11111000010001000100010001000011111', // Z
  '01110100011001110101110011000101110', // 0
  '00100011000010000100001000010001110', // 1
  '01110100010000100010001000100011111', // 2
  '11111000100010000010000011000101110', // 3
  '00010001100101010010111110001000010', // 4
  '11111100001111000001000011000101110', // 5
  '00110010001000011110100011000101110', // 6
  '11111000010001000100010000100001000', // 7
  '01110100011000101110100011000101110', // 8
  '01110100011000101111000010001001100', // 9
  '00000000000000000000000000000000000', // space
  '00000000000000000000000000110001100', // period
  '00000000000000000000011000010001000', // comma
  '00000011000110000000011000110000000', // colon
  '00000000000000011111000000000000000', // minus
  '00000001000010011111001000010000000', // plus
  '00001000100001000100010000100010000', // slash
  '00010001000100001000010000010000010', // lparen
  '01000001000001000010000100010001000', // rparen
];

/** `char -> cell index`, built once. */
const INDEX = new Map<string, number>();
for (let i = 0; i < CHARS.length; i += 1) INDEX.set(CHARS[i] ?? '', i);

export const ATLAS_CELLS = CHARS.length;
export const ATLAS_W = ATLAS_CELLS * CELL_W;
export const ATLAS_H = CELL_H;

/** Build the R8 atlas. One row of cells, `ATLAS_W × ATLAS_H`. */
export function buildAtlas(): Uint8Array {
  const out = new Uint8Array(ATLAS_W * ATLAS_H);
  for (let c = 0; c < ATLAS_CELLS; c += 1) {
    const bits = BITS[c] ?? '';
    for (let row = 0; row < GLYPH_H; row += 1) {
      for (let col = 0; col < GLYPH_W; col += 1) {
        const on = bits[row * GLYPH_W + col] === '1';
        if (on) out[row * ATLAS_W + c * CELL_W + col] = 255;
      }
    }
  }
  return out;
}

/** Cell index for a character; `-1` when the font has no glyph (drawn as blank). */
export function cellOf(ch: string): number {
  return INDEX.get(ch.toUpperCase()) ?? INDEX.get(' ') ?? 0;
}

/** Width in atlas pixels of `text` at scale 1. */
export function textWidth(text: string): number {
  return text.length * CELL_W;
}
