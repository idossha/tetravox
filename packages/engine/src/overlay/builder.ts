/**
 * `OverlayBuilder` — the one interleaved vertex buffer every §7.2 pass-3 item writes into.
 *
 * §8 calls the 2D view chrome **a laterality-safety requirement, not decoration**, and §11 requires
 * it present in every golden — so it is drawn into the GL framebuffer, not into a DOM layer above
 * it. A DOM overlay would be invisible to `readPixel` and to `screenshot()`, which is the same as
 * not testing it.
 *
 * Layout is `[x, y, u, v, r, g, b, a]` per vertex. `u < 0` marks a solid quad; otherwise the vertex
 * samples the bitmap font atlas. Every item module in this directory (`letters`, `corner`, `badge`,
 * `crosshair`, and Phase 2's `colorbar` / `gizmo`) appends into one of these and the pass makes one
 * draw call out of the lot.
 */

import { ATLAS_W, ATLAS_H, CELL_W, GLYPH_H, GLYPH_W, cellOf } from '../render/font';
import type { vec4 } from '../scene/types';

export const FLOATS_PER_VERTEX = 8;

export class OverlayBuilder {
  #data: number[] = [];
  #w = 1;
  #h = 1;
  #halo: vec4 = [0, 0, 0, 1];

  /** Pixel size of the pane being annotated. Pixel coordinates below are origin **bottom-left**. */
  begin(widthPx: number, heightPx: number): void {
    this.#data.length = 0;
    this.#w = Math.max(1, widthPx);
    this.#h = Math.max(1, heightPx);
    this.#halo = [0, 0, 0, 1];
  }

  /**
   * The colour {@link OverlayBuilder.labelWithHalo} outlines text with, until the next
   * {@link OverlayBuilder.begin} — which resets it to black, so every existing caller and every §11
   * golden is unaffected (directed task 9, 2026-08-28).
   *
   * A builder-level setting rather than a parameter on six call sites: every pass-3 item that draws
   * a label — letters, corner info, badge, colour-bar ticks and titles — wants the *same* halo, and
   * it is the one chrome colour that must **invert** with the theme rather than shift with it.
   * Threading it through `drawEdgeLetters`, `drawCornerLines`, `drawBadge` and `drawColorbar` would
   * have meant an optional argument on each and four ways to forget it.
   */
  setHalo(color: vec4): void {
    this.#halo = [color[0], color[1], color[2], color[3]];
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
   * An arbitrary convex quad, corners in order — the primitive a **rotated** line needs.
   *
   * Every Phase-1 item was axis-aligned, so {@link OverlayBuilder.rect} was enough. §7.0.6's
   * screen-space quad expansion is not — "`gl.lineWidth()` is a no-op; `ALIASED_LINE_WIDTH_RANGE` is
   * `[1,1]` `[M2Max]`" — so the gizmo's ring and arcs are thick segments built from this.
   */
  quad(
    a: [number, number],
    b: [number, number],
    c: [number, number],
    d: [number, number],
    color: vec4
  ): void {
    for (const [px, py] of [a, b, c, a, c, d]) this.#vertex(px, py, -1, -1, color);
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

  /**
   * Text with a 1 px halo, so letters stay legible over bright anatomy.
   *
   * The halo colour is {@link OverlayBuilder.setHalo}'s — black until a caller says otherwise. Its
   * alpha is clamped to the label's own so a translucent label does not gain an opaque outline.
   */
  labelWithHalo(
    text: string,
    x: number,
    y: number,
    scale: number,
    color: vec4,
    align: 'left' | 'center' | 'right' = 'left'
  ): void {
    const h = this.#halo;
    const halo: vec4 = [h[0], h[1], h[2], Math.min(h[3], color[3])];
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

/** Pane geometry every overlay item needs: size in device pixels and the font magnification. */
export interface OverlayMetrics {
  widthPx: number;
  heightPx: number;
  /** Scale factor for the bitmap font, at least 1. */
  scale: number;
  /** Edge padding in pane pixels. */
  pad: number;
  /** Baseline-to-baseline distance for stacked corner lines. */
  lineH: number;
}

/** Derive {@link OverlayMetrics} from a pane's size and DPR. Pure — every position follows from it. */
export function overlayMetrics(widthPx: number, heightPx: number, uiScale: number): OverlayMetrics {
  const scale = Math.max(1, Math.round(uiScale));
  return { widthPx, heightPx, scale, pad: 4 * scale, lineH: (GLYPH_H + 3) * scale };
}
