/**
 * Publication export on top of §4.7's `ScreenshotOptions` — **PNG only**, by decision (2026-08-29):
 * the panes are raster by nature, and what figure assembly needs from a raster export is the right
 * physical size, the right DPI, a clean background and panels that arrive already labelled.
 *
 * Three pieces, all pure except `composeFigure`:
 *
 *  * **Presets** — one click sets dpi / background / trim / chrome the way a print figure wants them.
 *  * **Physical width** — a width typed in **mm** at the chosen DPI, with the three journal column
 *    widths as chips, so "85 mm at 300 dpi" is the number the file carries instead of a guess.
 *  * **Figure** — every chosen pane captured *separately* (each is its own `Engine.screenshot`, so
 *    each keeps its own colour bar, letters and scale bar) and laid out on one canvas with A/B/C…
 *    labels, a gutter in mm, and the DPI written to `pHYs`. The layout maths is in `figureLayout`
 *    so it is testable without a canvas; `composeFigure` is the only DOM-touching function.
 *
 * `ScreenshotOptions` itself is frozen (§12.3), so nothing here widens it: the figure is an
 * app-level *wrapper* around several ordinary single-view screenshots.
 */

import type { ScreenshotOptions, ViewId } from '@tetravox/engine';
import { withPngDpi } from './png';

/** `mm` at `dpi` → whole pixels. */
export function pixelsForMm(mm: number, dpi: number): number {
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}

/** The reverse, for the read-back beside the field. */
export function mmForPixels(px: number, dpi: number): number {
  return (px / dpi) * 25.4;
}

/** Journal column widths — the three numbers every author guidelines page quotes. */
export const COLUMN_WIDTHS_MM: readonly { label: string; mm: number }[] = [
  { label: '1 col · 85 mm', mm: 85 },
  { label: '1.5 col · 114 mm', mm: 114 },
  { label: '2 col · 174 mm', mm: 174 },
];

export interface ExportPreset {
  id: string;
  label: string;
  hint: string;
  apply(opts: ScreenshotOptions): ScreenshotOptions;
}

/**
 * The presets. Each is a patch over the current options, not a replacement: the target, the pane and
 * the size the user already chose survive, and only the print-relevant knobs move.
 */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: 'web',
    label: 'Web · 144 dpi',
    hint: 'Scene background, every annotation on — what the screen shows.',
    apply: (o) => ({ ...o, dpi: 144, background: 'scene', autoTrim: false }),
  },
  {
    id: 'print300',
    label: 'Print · 300 dpi',
    hint: 'White background, trimmed, crosshair and corner info off.',
    apply: (o) => ({
      ...o,
      dpi: 300,
      background: 'white',
      autoTrim: true,
      include: { ...o.include, crosshair: false, cornerInfo: false },
    }),
  },
  {
    id: 'print600',
    label: 'Print · 600 dpi',
    hint: 'As Print 300, at line-art resolution.',
    apply: (o) => ({
      ...o,
      dpi: 600,
      background: 'white',
      autoTrim: true,
      include: { ...o.include, crosshair: false, cornerInfo: false },
    }),
  },
  {
    id: 'transparent',
    label: 'Transparent · 300 dpi',
    hint: 'Alpha background for compositing over a page; trimmed, crosshair and corner info off.',
    apply: (o) => ({
      ...o,
      dpi: 300,
      background: 'transparent',
      autoTrim: true,
      include: { ...o.include, crosshair: false, cornerInfo: false },
    }),
  },
];

// ------------------------------------------------------------------------------------------------
// Figure assembly
// ------------------------------------------------------------------------------------------------

export type FigureLabelStyle = 'upper' | 'lower' | 'none';

export interface FigureOptions {
  /** Which panes, in reading order. Each becomes one panel. */
  panels: ViewId[];
  /** Panels per row; `0` = automatic (√n rounded up, so 4 → 2×2 and 3 → 2 + 1). */
  columns: number;
  /** Gutter between panels and around the edge, in mm at the export DPI. */
  gutterMm: number;
  labels: FigureLabelStyle;
  /** Label size in points (1/72 in) at the export DPI. */
  labelPt: number;
  /** The page behind the panels. `transparent` leaves the gutters clear. */
  background: 'white' | 'transparent';
}

export const DEFAULT_FIGURE: FigureOptions = {
  panels: [],
  columns: 0,
  gutterMm: 2,
  labels: 'upper',
  labelPt: 10,
  background: 'white',
};

export interface FigureCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigureLayout {
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** One per panel, in the order given. Every cell is the same size; a smaller image is centred. */
  cells: FigureCell[];
}

/** `0 → A`, `25 → Z`, `26 → AA`; lower-case when asked; `''` for `none`. */
export function figureLabel(index: number, style: FigureLabelStyle): string {
  if (style === 'none') return '';
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return style === 'lower' ? out.toLowerCase() : out;
}

export function autoColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

/**
 * Uniform grid: every cell is the largest panel's size, so panels line up on both axes regardless
 * of which pane was tallest — the property a figure assembled in a page-layout tool needs, and the
 * one an aspect-preserving ragged layout would not give.
 */
export function figureLayout(
  sizes: readonly { width: number; height: number }[],
  columns: number,
  gutterPx: number
): FigureLayout {
  const n = sizes.length;
  const cols = Math.max(1, Math.min(n, columns > 0 ? columns : autoColumns(n)));
  const rows = n === 0 ? 0 : Math.ceil(n / cols);
  const cellW = Math.max(0, ...sizes.map((s) => s.width));
  const cellH = Math.max(0, ...sizes.map((s) => s.height));
  const g = Math.max(0, Math.round(gutterPx));
  const cells: FigureCell[] = sizes.map((_, i) => ({
    x: g + (i % cols) * (cellW + g),
    y: g + Math.floor(i / cols) * (cellH + g),
    width: cellW,
    height: cellH,
  }));
  return {
    width: n === 0 ? 0 : g + cols * (cellW + g),
    height: n === 0 ? 0 : g + rows * (cellH + g),
    columns: cols,
    rows,
    cells,
  };
}

/** The label's pixel size: `labelPt` points at `dpi`. */
export function labelPx(labelPt: number, dpi: number): number {
  return Math.max(6, Math.round((labelPt / 72) * dpi));
}

export interface FigurePanel {
  id: ViewId;
  /** A finished PNG, as `Engine.screenshot` returned it. */
  png: Uint8Array;
}

/**
 * Lay the panels out and return one PNG with `dpi` in its `pHYs` chunk. Browser only — it decodes
 * with `createImageBitmap` and draws on an `OffscreenCanvas` — which is why every number it needs
 * is computed by the pure functions above.
 */
export async function composeFigure(
  panels: readonly FigurePanel[],
  figure: FigureOptions,
  dpi: number
): Promise<Uint8Array> {
  if (panels.length === 0) throw new Error('a figure needs at least one panel');
  const bitmaps = await Promise.all(
    panels.map((p) => createImageBitmap(new Blob([p.png.slice()], { type: 'image/png' })))
  );
  try {
    const gutter = pixelsForMm(figure.gutterMm, dpi);
    const layout = figureLayout(bitmaps, figure.columns, gutter);
    const canvas = new OffscreenCanvas(layout.width, layout.height);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2D context for the figure canvas');
    if (figure.background === 'white') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, layout.width, layout.height);
    }
    const fontPx = labelPx(figure.labelPt, dpi);
    ctx.font = `bold ${fontPx}px Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    bitmaps.forEach((bmp, i) => {
      const cell = layout.cells[i] as FigureCell;
      const dx = cell.x + Math.floor((cell.width - bmp.width) / 2);
      const dy = cell.y + Math.floor((cell.height - bmp.height) / 2);
      ctx.drawImage(bmp, dx, dy);
      const text = figureLabel(i, figure.labels);
      if (text === '') return;
      // Inset by a quarter of the label height; black on the white page, and black with a white
      // halo where the page is transparent so it reads on either a light or a dark composite.
      const inset = Math.round(fontPx * 0.25);
      if (figure.background === 'transparent') {
        ctx.lineWidth = Math.max(1, Math.round(fontPx / 8));
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(text, cell.x + inset, cell.y + inset);
      }
      ctx.fillStyle = '#000000';
      ctx.fillText(text, cell.x + inset, cell.y + inset);
    });
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return withPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
  } finally {
    for (const b of bitmaps) b.close();
  }
}
