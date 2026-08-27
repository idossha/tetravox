/**
 * The §7.2 overlay pass geometry: orientation letters, corner info, the RAD/NEU badge, the
 * crosshair.
 *
 * §8 calls the 2D view chrome **a laterality-safety requirement, not decoration**, and §11 requires
 * it present in every golden — so it is drawn into the GL framebuffer, not into a DOM layer above
 * it. A DOM overlay would be invisible to `readPixel` and to `screenshot()`, which is the same as
 * not testing it.
 *
 * Everything is built into one interleaved `[x, y, u, v, r, g, b, a]` buffer and drawn once.
 * `u < 0` marks a solid quad; otherwise the vertex samples the bitmap font atlas.
 */

import { ATLAS_W, ATLAS_H, CELL_W, GLYPH_H, GLYPH_W, cellOf } from './font';
import type { vec4 } from '../scene/types';

export const FLOATS_PER_VERTEX = 8;

export class OverlayBuilder {
  #data: number[] = [];
  #w = 1;
  #h = 1;

  /** Pixel size of the pane being annotated. Pixel coordinates below are origin **bottom-left**. */
  begin(widthPx: number, heightPx: number): void {
    this.#data.length = 0;
    this.#w = Math.max(1, widthPx);
    this.#h = Math.max(1, heightPx);
  }

  #vertex(px: number, py: number, u: number, v: number, c: vec4): void {
    this.#data.push((px / this.#w) * 2 - 1, (py / this.#h) * 2 - 1, u, v, c[0], c[1], c[2], c[3]);
  }

  /** A solid axis-aligned rectangle in pane pixels. */
  rect(x: number, y: number, w: number, h: number, color: vec4): void {
    const quad: [number, number][] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y],
      [x + w, y + h],
      [x, y + h],
    ];
    for (const [px, py] of quad) this.#vertex(px, py, -1, -1, color);
  }

  /**
   * Draw `text` with its lower-left corner at `(x, y)`, magnified `scale`×.
   *
   * `align` positions the whole string: `'left'` puts `x` at the left edge, `'center'` centres on
   * `x`, `'right'` puts `x` at the right edge.
   */
  text(
    text: string,
    x: number,
    y: number,
    scale: number,
    color: vec4,
    align: 'left' | 'center' | 'right' = 'left'
  ): void {
    const totalW = text.length * CELL_W * scale;
    const x0 = align === 'left' ? x : align === 'center' ? x - totalW / 2 : x - totalW;
    for (let i = 0; i < text.length; i += 1) {
      const cell = cellOf(text[i] ?? ' ');
      const gx = x0 + i * CELL_W * scale;
      // Atlas texel rectangle for this glyph. v is flipped because the atlas rows run top-down
      // while pane pixels run bottom-up.
      const u0 = (cell * CELL_W) / ATLAS_W;
      const u1 = (cell * CELL_W + GLYPH_W) / ATLAS_W;
      const v0 = GLYPH_H / ATLAS_H;
      const v1 = 0;
      const w = GLYPH_W * scale;
      const h = GLYPH_H * scale;
      const quad: [number, number, number, number][] = [
        [gx, y, u0, v0],
        [gx + w, y, u1, v0],
        [gx + w, y + h, u1, v1],
        [gx, y, u0, v0],
        [gx + w, y + h, u1, v1],
        [gx, y + h, u0, v1],
      ];
      for (const [px, py, u, v] of quad) this.#vertex(px, py, u, v, color);
    }
  }

  /** Text with a 1 px dark halo, so letters stay legible over bright anatomy. */
  labelWithHalo(
    text: string,
    x: number,
    y: number,
    scale: number,
    color: vec4,
    align: 'left' | 'center' | 'right' = 'left'
  ): void {
    const halo: vec4 = [0, 0, 0, Math.min(1, color[3])];
    for (const [dx, dy] of [
      [-scale, 0],
      [scale, 0],
      [0, -scale],
      [0, scale],
    ] as [number, number][]) {
      this.text(text, x + dx, y + dy, scale, halo, align);
    }
    this.text(text, x, y, scale, color, align);
  }

  get vertexCount(): number {
    return this.#data.length / FLOATS_PER_VERTEX;
  }

  build(): Float32Array {
    return new Float32Array(this.#data);
  }
}

export interface ChromeInput {
  widthPx: number;
  heightPx: number;
  /** Scale factor for the bitmap font, at least 1. */
  uiScale: number;
  letters?: { left: string; right: string; top: string; bottom: string };
  /** `['AXIAL', 'SLICE 104', 'RAS -0.7 18.0 6.0']` — drawn bottom-left, one line each. */
  cornerLines?: string[];
  /** Always drawn when present; `Annotations.conventionBadge` is `true`, not optional (§8). */
  badge?: 'RAD' | 'NEU';
  /** Pane pixel position of the crosshair, or `null`. */
  crosshair?: { x: number; y: number } | null;
  crosshairColor: vec4;
  textColor: vec4;
  /** 1 px accent border, drawn when this pane is the active view. */
  activeBorder?: vec4;
}

/** Compose one pane's chrome. Pure: every position is derived from `widthPx` / `heightPx`. */
export function buildChrome(b: OverlayBuilder, c: ChromeInput): void {
  const s = Math.max(1, Math.round(c.uiScale));
  const pad = 4 * s;
  const lineH = (GLYPH_H + 3) * s;

  if (c.crosshair != null) {
    const t = Math.max(1, s);
    b.rect(0, c.crosshair.y - t / 2, c.widthPx, t, c.crosshairColor);
    b.rect(c.crosshair.x - t / 2, 0, t, c.heightPx, c.crosshairColor);
  }

  if (c.letters !== undefined) {
    const mid = c.heightPx / 2;
    const midX = c.widthPx / 2;
    b.labelWithHalo(c.letters.left, pad, mid - (GLYPH_H * s) / 2, s, c.textColor, 'left');
    b.labelWithHalo(
      c.letters.right,
      c.widthPx - pad,
      mid - (GLYPH_H * s) / 2,
      s,
      c.textColor,
      'right'
    );
    b.labelWithHalo(c.letters.top, midX, c.heightPx - pad - GLYPH_H * s, s, c.textColor, 'center');
    b.labelWithHalo(c.letters.bottom, midX, pad, s, c.textColor, 'center');
  }

  if (c.cornerLines !== undefined) {
    c.cornerLines.forEach((line, i) => {
      b.labelWithHalo(
        line,
        pad,
        pad + (c.cornerLines!.length - 1 - i) * lineH,
        s,
        c.textColor,
        'left'
      );
    });
  }

  if (c.badge !== undefined) {
    b.labelWithHalo(
      c.badge,
      c.widthPx - pad,
      c.heightPx - pad - GLYPH_H * s,
      s,
      c.textColor,
      'right'
    );
  }

  if (c.activeBorder !== undefined) {
    const t = Math.max(1, s);
    b.rect(0, 0, c.widthPx, t, c.activeBorder);
    b.rect(0, c.heightPx - t, c.widthPx, t, c.activeBorder);
    b.rect(0, 0, t, c.heightPx, c.activeBorder);
    b.rect(c.widthPx - t, 0, t, c.heightPx, c.activeBorder);
  }
}
