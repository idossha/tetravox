/**
 * The 5x7 bitmap font is data, so it is checked as data.
 *
 * §11 compares goldens across macOS and ubuntu-24.04 at `maxDiffPixelRatio <= 0.002`, and §8 calls
 * the orientation letters a laterality-safety requirement — so the glyphs are bytes in the
 * repository rather than a system font. A malformed row would silently shift every glyph after it in
 * the atlas, which is exactly the kind of thing a golden diff reports as "some pixels changed".
 */

import { describe, expect, it } from 'vitest';
import {
  ATLAS_CELLS,
  ATLAS_H,
  ATLAS_W,
  CELL_W,
  GLYPH_H,
  GLYPH_W,
  buildAtlas,
  cellOf,
} from '../../src/render/font';

describe('the bitmap font', () => {
  it('has one cell per supported character, and the atlas is exactly that wide', () => {
    expect(ATLAS_W).toBe(ATLAS_CELLS * CELL_W);
    expect(ATLAS_H).toBeGreaterThanOrEqual(GLYPH_H);
    // A-Z, 0-9, space and eight punctuation marks.
    expect(ATLAS_CELLS).toBe(45);
  });

  it('renders every glyph inside its 5x7 box, and every letter has ink', () => {
    const atlas = buildAtlas();
    expect(atlas.length).toBe(ATLAS_W * ATLAS_H);
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      const cell = cellOf(ch);
      let ink = 0;
      for (let row = 0; row < ATLAS_H; row += 1) {
        for (let col = 0; col < CELL_W; col += 1) {
          const v = atlas[row * ATLAS_W + cell * CELL_W + col] ?? 0;
          if (v !== 0) {
            ink += 1;
            // The 6x8 cell has a one-pixel gutter on the right and bottom so glyphs never touch.
            expect(col, `${ch} spills past its glyph box`).toBeLessThan(GLYPH_W);
            expect(row, `${ch} spills past its glyph box`).toBeLessThan(GLYPH_H);
          }
        }
      }
      expect(ink, `${ch} has no ink`).toBeGreaterThan(0);
    }
  });

  it('gives space no ink, and maps an unknown character to it rather than throwing', () => {
    const atlas = buildAtlas();
    const blank = cellOf(' ');
    for (let row = 0; row < ATLAS_H; row += 1) {
      for (let col = 0; col < CELL_W; col += 1) {
        expect(atlas[row * ATLAS_W + blank * CELL_W + col]).toBe(0);
      }
    }
    expect(cellOf('~')).toBe(blank);
    // Lower case folds to upper, so the chrome can be written either way.
    expect(cellOf('r')).toBe(cellOf('R'));
  });

  it('distinguishes every glyph from every other one', () => {
    const atlas = buildAtlas();
    const seen = new Map<string, number>();
    for (let cell = 0; cell < ATLAS_CELLS; cell += 1) {
      if (cell === cellOf(' ')) continue;
      let key = '';
      for (let row = 0; row < GLYPH_H; row += 1) {
        for (let col = 0; col < GLYPH_W; col += 1) {
          key += (atlas[row * ATLAS_W + cell * CELL_W + col] ?? 0) === 0 ? '0' : '1';
        }
      }
      const first = seen.get(key);
      // '+' and '-' would collide if the plus lost its vertical stroke, and 'O'/'0' are the classic
      // pair; a duplicate here means two different characters draw the same pixels.
      expect(first, `cell ${cell} draws the same pixels as cell ${first}`).toBeUndefined();
      seen.set(key, cell);
    }
  });
});
