/**
 * Reading §8's 2D view chrome **back out of the framebuffer**.
 *
 * §8 calls the chrome "a laterality-safety requirement, not decoration", and §11 requires it in
 * every golden — but a golden cannot police it. The corner block is a few hundred pixels of a
 * 589,824-pixel pane, so `SLICE 104` where `SLICE 128` belongs is 0.02 % of the image and passes
 * `maxDiffPixelRatio: 0.002` without a murmur. Phase 1 shipped exactly that: the corner annotation
 * reported the wrong voxel axis on every `m2m` volume and every golden stayed green.
 *
 * So the chrome is decoded instead. The font is a 5×7 bitmap defined in the repository
 * (`src/render/font.ts`), which makes an exact template match possible: every glyph cell is compared
 * against every glyph in the atlas and the best match wins. Nothing here reads engine state — the
 * assertion is on the pixels a user sees.
 */

import {
  ATLAS_CELLS,
  ATLAS_W,
  CELL_W,
  GLYPH_H,
  GLYPH_W,
  buildAtlas,
  cellOf,
} from '../../src/render/font';
import { readCanvasRect } from './pixels';
import type { Page, Locator } from '@playwright/test';

/** `buildChrome`'s padding and line pitch (§8 chrome layout), at `uiScale` 1. */
export const CHROME_PAD = 4;
export const CHROME_LINE_H = GLYPH_H + 3;

/** Every character the chrome can draw, transcribed from `font.ts`'s `CHARS`. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:-+/()';

const ATLAS = buildAtlas();
const CHAR_OF_CELL = new Map<number, string>();
for (const ch of ALPHABET) CHAR_OF_CELL.set(cellOf(ch), ch);

/** The 35 on/off bits of one atlas cell, row-major from the glyph's top-left. */
function glyphBits(cell: number): boolean[] {
  const out: boolean[] = [];
  for (let row = 0; row < GLYPH_H; row += 1) {
    for (let col = 0; col < GLYPH_W; col += 1) {
      out.push((ATLAS[row * ATLAS_W + cell * CELL_W + col] ?? 0) !== 0);
    }
  }
  return out;
}

const GLYPHS: { cell: number; bits: boolean[] }[] = [];
for (let c = 0; c < ATLAS_CELLS; c += 1) GLYPHS.push({ cell: c, bits: glyphBits(c) });

/** A pane, in device pixels with a **bottom-left** origin — the same convention `gl.viewport` uses. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChromeReadOptions {
  /** Height of the whole canvas, to convert the pane's bottom-left origin to top-left. */
  canvasHeight: number;
  pane: PaneRect;
  /** Bitmap magnification; `Math.max(1, Math.round(dpr))` in the engine, so 1 in every golden. */
  scale?: number;
}

/**
 * The text colour is `[0.92, 0.94, 0.98, 1]` and every glyph is drawn over a 1 px dark halo, so ink
 * is the only thing this bright in the corner block. The threshold is well below the text and well
 * above the halo.
 */
function isInk(r: number, g: number, b: number): boolean {
  return r > 150 && g > 150 && b > 150;
}

/** Best-matching character for one 5×7 cell, plus how many of the 35 bits agreed. */
function decodeCell(mask: boolean[]): { ch: string; score: number } {
  let best = { ch: '?', score: -1 };
  for (const g of GLYPHS) {
    let score = 0;
    for (let i = 0; i < mask.length; i += 1) if (mask[i] === g.bits[i]) score += 1;
    if (score > best.score) best = { ch: CHAR_OF_CELL.get(g.cell) ?? '?', score };
  }
  return best;
}

/**
 * Decode `length` characters starting at pane-local `(xLocal, yLocal)` — the lower-left corner of
 * the string, which is what `OverlayBuilder.text` takes.
 */
export async function readChromeText(
  target: Page | Locator,
  opts: ChromeReadOptions & { xLocal: number; yLocal: number; length: number }
): Promise<string> {
  const s = opts.scale ?? 1;
  const w = opts.length * CELL_W * s;
  const h = GLYPH_H * s;
  const xCanvas = opts.pane.x + opts.xLocal;
  // Pane-local bottom-left -> canvas top-left.
  const yCanvas = opts.canvasHeight - (opts.pane.y + opts.yLocal + h);
  const px = await readCanvasRect(target, xCanvas, yCanvas, w, h);

  let text = '';
  for (let i = 0; i < opts.length; i += 1) {
    const mask: boolean[] = [];
    for (let row = 0; row < GLYPH_H; row += 1) {
      for (let col = 0; col < GLYPH_W; col += 1) {
        // Nearest sampling at an integer scale: the block's top-left subpixel is the whole texel.
        const x = i * CELL_W * s + col * s;
        const y = row * s;
        const o = (y * w + x) * 4;
        mask.push(isInk(px[o] ?? 0, px[o + 1] ?? 0, px[o + 2] ?? 0));
      }
    }
    text += decodeCell(mask).ch;
  }
  return text.trimEnd();
}

/**
 * The corner block (§8: "view name, slice index of the active volume layer, world RAS of the
 * plane"), read as `lineCount` lines from the pane's lower-left corner.
 */
export async function readCornerInfo(
  target: Page | Locator,
  opts: ChromeReadOptions & { lineCount: number; length?: number }
): Promise<string[]> {
  const s = opts.scale ?? 1;
  const out: string[] = [];
  for (let i = 0; i < opts.lineCount; i += 1) {
    out.push(
      await readChromeText(target, {
        ...opts,
        xLocal: CHROME_PAD * s,
        yLocal: (CHROME_PAD + (opts.lineCount - 1 - i) * CHROME_LINE_H) * s,
        length: opts.length ?? 22,
      })
    );
  }
  return out;
}

/** The four edge letters of a 2D pane (§8), decoded from the pane's own pixels. */
export async function readEdgeLetters(
  target: Page | Locator,
  opts: ChromeReadOptions
): Promise<{ left: string; right: string; top: string; bottom: string }> {
  const s = opts.scale ?? 1;
  const { width, height } = opts.pane;
  // `buildChrome` rounds this to the pixel grid; see the comment there.
  const mid = Math.round(height / 2 - (GLYPH_H * s) / 2);
  const midX = width / 2;
  const one = async (xLocal: number, yLocal: number): Promise<string> =>
    (await readChromeText(target, { ...opts, xLocal, yLocal, length: 1 })).trim();
  return {
    left: await one(CHROME_PAD * s, mid),
    right: await one(width - CHROME_PAD * s - CELL_W * s, mid),
    top: await one(midX - (CELL_W * s) / 2, height - CHROME_PAD * s - GLYPH_H * s),
    bottom: await one(midX - (CELL_W * s) / 2, CHROME_PAD * s),
  };
}

/** The `RAD` / `NEU` badge (§8: `Annotations.conventionBadge` is not optional). */
export async function readBadge(target: Page | Locator, opts: ChromeReadOptions): Promise<string> {
  const s = opts.scale ?? 1;
  return (
    await readChromeText(target, {
      ...opts,
      xLocal: opts.pane.width - CHROME_PAD * s - 3 * CELL_W * s,
      yLocal: opts.pane.height - CHROME_PAD * s - GLYPH_H * s,
      length: 3,
    })
  ).trim();
}
