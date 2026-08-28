/**
 * §7.5's viewport split, for the two layouts directed task 3 added (2026-08-28).
 *
 * The property every layout has to hold is that its panes **tile the canvas exactly**: §7.2 scissors
 * each pane and nothing clears the gaps, so a one-pixel rounding gap is an unpainted seam in every
 * golden. That is what these assert, alongside the shape each layout promises.
 */

import { describe, expect, it } from 'vitest';
import { cellCount, viewports } from './layout';
import type { Layout } from '../scene/types';

const CELLS = ['view3d', 'axial', 'coronal', 'sagittal'];

function area(layout: Layout, w: number, h: number): number {
  return viewports(layout, w, h).reduce((sum, r) => sum + r.width * r.height, 0);
}

describe("the 3D-first layouts' viewports", () => {
  it('1+3 is one big 3D pane and three stacked slices', () => {
    const rects = viewports({ kind: '1+3', cells: CELLS }, 1200, 900);
    expect(rects).toHaveLength(4);
    // The 3D pane: full height, two thirds of the width, at the origin.
    expect(rects[0]).toEqual({ viewId: 'view3d', x: 0, y: 0, width: 800, height: 900 });
    // The column: the remaining third, three rows, top pane first in `cells` (origin bottom-left,
    // so the first row's `y` is the highest).
    expect(rects.slice(1).map((r) => r.x)).toEqual([800, 800, 800]);
    expect(rects.slice(1).map((r) => r.width)).toEqual([400, 400, 400]);
    expect(rects.slice(1).map((r) => r.y)).toEqual([600, 300, 0]);
    expect(rects.slice(1).map((r) => r.height)).toEqual([300, 300, 300]);
  });

  it('3d+1 is the 3D pane and one slice, side by side, 3D first', () => {
    const rects = viewports({ kind: '3d+1', cells: ['view3d', 'axial'] }, 1000, 700);
    expect(rects).toEqual([
      { viewId: 'view3d', x: 0, y: 0, width: 500, height: 700 },
      { viewId: 'axial', x: 500, y: 0, width: 500, height: 700 },
    ]);
  });

  it('tiles the canvas exactly at a size that divides evenly in neither direction', () => {
    // 1279 / 3 and 721 / 3 both leave a remainder, which the last pane must absorb.
    const w = 1279;
    const h = 721;
    expect(area({ kind: '1+3', cells: CELLS }, w, h)).toBe(w * h);
    expect(area({ kind: '3d+1', cells: ['view3d', 'axial'] }, w, h)).toBe(w * h);
  });

  it('counts its cells', () => {
    expect(cellCount('1+3')).toBe(4);
    expect(cellCount('3d+1')).toBe(2);
  });
});
