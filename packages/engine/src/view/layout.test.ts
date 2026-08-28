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

describe('viewports under a sidebar-toggle-shaped resize (bug: panes going black)', () => {
  // A collapsing/expanding sidebar drives `ViewGrid`'s `ResizeObserver` through a flex reflow that
  // can (briefly) report a near-zero host size, then the final one — never through any `Layout`
  // change. `viewports` is the one thing standing between "the canvas the embedder resized" and
  // "what each pane draws", so it has to hold up at both ends of that sequence with no memory of
  // what came before: a canvas resize carries no scene state of its own (§7.2's `camera` is
  // `center`/`mmPerPx`, entirely separate from pixel geometry), so the same `(layout, w, h)` must
  // always produce the same rects regardless of what call preceded it.
  it('is a pure function of (layout, w, h) — no residue from a prior call', () => {
    const layout: Layout = { kind: '1+3', cells: CELLS };
    const before = viewports(layout, 1200, 900);
    // Simulate the mid-transition sequence a flex-layout sidebar toggle produces: a transient
    // near-zero size (ViewGrid's `Math.max(1, …)` floor), then settling back to the same size.
    viewports(layout, 1, 1);
    viewports(layout, 640, 480);
    const after = viewports(layout, 1200, 900);
    expect(after).toEqual(before);
  });

  it('never collapses a pane to a degenerate rect at the 1x1 floor `ViewGrid` clamps to', () => {
    for (const layout of [
      { kind: '1+3', cells: CELLS } as Layout,
      { kind: '2x2', cells: CELLS } as Layout,
    ]) {
      const rects = viewports(layout, 1, 1);
      expect(rects).toHaveLength(cellCount(layout.kind));
      for (const r of rects) {
        expect(r.width).toBeGreaterThanOrEqual(0);
        expect(r.height).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(r.x)).toBe(true);
        expect(Number.isFinite(r.y)).toBe(true);
      }
      // Still tiles exactly — no NaN/undefined leaks through the rounding at the floor.
      expect(area(layout, 1, 1)).toBe(1);
    }
  });

  it('tiles exactly at every size in a rapid toggle sequence (collapse, expand, collapse)', () => {
    const layout: Layout = { kind: '2x2', cells: CELLS };
    // A left-panel collapse widens the grid host; a right-panel collapse widens it again; expanding
    // either narrows it back. None of that touches height.
    for (const w of [960, 1216, 1536, 1216, 960]) {
      expect(area(layout, w, 900)).toBe(w * 900);
    }
  });
});
