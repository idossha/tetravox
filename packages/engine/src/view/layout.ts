/**
 * Layout → viewport rectangles (§7.5).
 *
 * Layouts: `1x1`, `1x3`, `1x3-horizontal`, `2x2`, `3d-only`, `1+3`, `3d+1`; `mosaic` is Phase 3.
 * Rects are in **device pixels**, origin bottom-left, which is what `gl.viewport` / `gl.scissor`
 * take. The engine converts pointer coordinates (origin top-left) at the single point that reads
 * them.
 */

import type { Layout, LayoutKind, ViewId } from '../scene/types';

export interface ViewportRect {
  viewId: ViewId;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many panes a layout shows. */
export function cellCount(kind: LayoutKind): number {
  switch (kind) {
    case '1x1':
    case '3d-only':
      return 1;
    case '3d+1':
      return 2;
    case '1x3':
    case '1x3-horizontal':
      return 3;
    case '2x2':
    case '1+3':
      return 4;
  }
}

/**
 * `'1+3'`'s split: the 3D pane takes this fraction of the width, the slice column the rest.
 *
 * Two thirds, so the three stacked slices in the remaining third stay close to square on a 16:9
 * canvas (1280×720 → 427×240 each) — the shape the layout exists to produce.
 */
const ONE_PLUS_THREE_MAIN = 2 / 3;

/**
 * Split `width × height` device pixels into the layout's panes.
 *
 * Integer arithmetic throughout, with the last pane absorbing the remainder, so panes tile the
 * canvas exactly — a rounding gap would show as an unpainted seam in a golden.
 */
export function viewports(layout: Layout, width: number, height: number): ViewportRect[] {
  const ids = layout.cells;
  const n = Math.min(cellCount(layout.kind), ids.length);
  const out: ViewportRect[] = [];
  const at = (i: number): ViewId => ids[i] ?? '';

  switch (layout.kind) {
    case '1x1':
    case '3d-only':
      if (n > 0) out.push({ viewId: at(0), x: 0, y: 0, width, height });
      break;
    case '1x3': {
      // Three stacked rows, top pane first in `cells`.
      const h = Math.floor(height / 3);
      for (let i = 0; i < n; i += 1) {
        const isLast = i === 2;
        const y = height - (i + 1) * h;
        out.push({
          viewId: at(i),
          x: 0,
          y: isLast ? 0 : y,
          width,
          height: isLast ? height - 2 * h : h,
        });
      }
      break;
    }
    case '1x3-horizontal': {
      const w = Math.floor(width / 3);
      for (let i = 0; i < n; i += 1) {
        const isLast = i === 2;
        out.push({
          viewId: at(i),
          x: i * w,
          y: 0,
          width: isLast ? width - 2 * w : w,
          height,
        });
      }
      break;
    }
    case '3d+1': {
      // The 3D pane first, so `cells[0]` is the 3D one in every 3D-first layout.
      const w = Math.floor(width / 2);
      const rects: [number, number, number, number][] = [
        [0, 0, w, height],
        [w, 0, width - w, height],
      ];
      for (let i = 0; i < n; i += 1) {
        const c = rects[i];
        if (c === undefined) continue;
        out.push({ viewId: at(i), x: c[0], y: c[1], width: c[2], height: c[3] });
      }
      break;
    }
    case '1+3': {
      // `cells[0]` is the big 3D pane on the left; `cells[1..3]` stack down the right-hand column,
      // top pane first, exactly as `'1x3'` orders its rows.
      const w = Math.floor(width * ONE_PLUS_THREE_MAIN);
      const colW = width - w;
      const h = Math.floor(height / 3);
      if (n > 0) out.push({ viewId: at(0), x: 0, y: 0, width: w, height });
      for (let i = 1; i < n; i += 1) {
        const row = i - 1;
        const isLast = row === 2;
        out.push({
          viewId: at(i),
          x: w,
          y: isLast ? 0 : height - (row + 1) * h,
          width: colW,
          height: isLast ? height - 2 * h : h,
        });
      }
      break;
    }
    case '2x2': {
      const w = Math.floor(width / 2);
      const h = Math.floor(height / 2);
      const cells: [number, number, number, number][] = [
        [0, h, w, height - h], // top-left
        [w, h, width - w, height - h], // top-right
        [0, 0, w, h], // bottom-left
        [w, 0, width - w, h], // bottom-right
      ];
      for (let i = 0; i < n; i += 1) {
        const c = cells[i];
        if (c === undefined) continue;
        out.push({ viewId: at(i), x: c[0], y: c[1], width: c[2], height: c[3] });
      }
      break;
    }
  }
  return out;
}
