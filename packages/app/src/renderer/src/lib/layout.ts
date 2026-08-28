/**
 * Layout composition for the §8 toolbar switcher and the `x` key (§7.5).
 *
 * `Engine.setLayout(layout)` takes `{ kind, cells }` (§4.5), so *something* has to turn a layout kind
 * into an ordered list of `ViewId`s. That something is here, pure and tested, rather than inline in a
 * React handler: `Scene.slices` is "independent of layout, so `'3d-only'` keeps plane state", which
 * only holds if choosing cells never edits the views themselves.
 */

import type { LayoutKind, SliceMode, SliceView, View3D, ViewId } from '@tetravox/engine';

/** The four the §8 toolbar exposes, in the order `x` cycles them (§7.5). */
export const LAYOUT_CYCLE: readonly LayoutKind[] = ['2x2', '1x1', '1x3', '3d-only'] as const;

export const LAYOUT_LABEL: Record<LayoutKind, string> = {
  '1x1': '1×1',
  '1x3': '1×3',
  '1x3-horizontal': '1×3 —',
  '2x2': '2×2',
  '3d-only': '3D',
};

export function nextLayout(kind: LayoutKind): LayoutKind {
  const i = LAYOUT_CYCLE.indexOf(kind);
  return LAYOUT_CYCLE[(i + 1) % LAYOUT_CYCLE.length] as LayoutKind;
}

/**
 * Canonical slice order for the multi-cell layouts — **the engine's own**.
 *
 * `scene/defaults.ts` boots `2x2` as `[axial, coronal, sagittal, view3d]`, and this file used to
 * sort them `sagittal → coronal → axial`. Nothing in §3 or §7.5 fixes an order, so neither was
 * wrong; having two was. Clicking the already-highlighted `2×2` button — or going 3D and back —
 * silently swapped the axial and sagittal panes under the user (the engine-drawn pane label read
 * AXIAL before the click and SAGITTAL after), and the swapped order was then written into a saved
 * scene. The app follows the engine, because the engine is what draws the first frame.
 */
const SLICE_ORDER: readonly SliceMode[] = ['axial', 'coronal', 'sagittal'] as const;

function orderedSlices(slices: readonly SliceView[]): SliceView[] {
  const rank = (mode: SliceMode): number => {
    const i = SLICE_ORDER.indexOf(mode);
    return i === -1 ? SLICE_ORDER.length : i;
  };
  return [...slices].sort((a, b) => rank(a.mode) - rank(b.mode));
}

/**
 * The cells for `kind`.
 *
 * `preferred` is the view a `1x1` should show — the active pane, when there is one — so cycling
 * 2x2 → 1x1 zooms the pane the user was last in rather than always snapping to sagittal.
 */
export function layoutCells(
  kind: LayoutKind,
  slices: readonly SliceView[],
  view3d: View3D,
  preferred?: ViewId | null
): ViewId[] {
  const ordered = orderedSlices(slices);
  const ids = ordered.map((s) => s.id);
  switch (kind) {
    case '3d-only':
      return [view3d.id];
    case '1x1': {
      const candidates = [...ids, view3d.id];
      if (preferred != null && candidates.includes(preferred)) return [preferred];
      return candidates.length > 0 ? [candidates[0] as ViewId] : [];
    }
    case '1x3':
    case '1x3-horizontal':
      return ids.slice(0, 3);
    case '2x2':
      return [...ids.slice(0, 3), view3d.id];
  }
}

/** CSS grid template for a layout kind. The engine draws; this only decides where the panes sit. */
export function layoutGrid(kind: LayoutKind, cells: number): { columns: string; rows: string } {
  switch (kind) {
    case '1x1':
    case '3d-only':
      return { columns: '1fr', rows: '1fr' };
    case '1x3':
      return { columns: '1fr', rows: `repeat(${Math.max(1, cells)}, 1fr)` };
    case '1x3-horizontal':
      return { columns: `repeat(${Math.max(1, cells)}, 1fr)`, rows: '1fr' };
    case '2x2':
      return { columns: 'repeat(2, 1fr)', rows: 'repeat(2, 1fr)' };
  }
}

/**
 * Which cell of the grid a point falls in, from the host rectangle alone.
 *
 * The pane overlays are `pointer-events: none` — they are a border and a label, and a div on top of
 * the canvas would swallow every drag the engine's §7.5 interaction needs. Focus follows the pointer
 * through this instead, which is also the version a test can assert without a browser.
 */
export function cellIndexAt(
  kind: LayoutKind,
  cellCount: number,
  rect: { width: number; height: number },
  x: number,
  y: number
): number {
  if (cellCount <= 1 || rect.width <= 0 || rect.height <= 0) return 0;
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(hi, v));
  switch (kind) {
    case '1x1':
    case '3d-only':
      return 0;
    case '1x3':
      return clamp(Math.floor((y / rect.height) * cellCount), cellCount - 1);
    case '1x3-horizontal':
      return clamp(Math.floor((x / rect.width) * cellCount), cellCount - 1);
    case '2x2': {
      const col = x < rect.width / 2 ? 0 : 1;
      const row = y < rect.height / 2 ? 0 : 1;
      return clamp(row * 2 + col, cellCount - 1);
    }
  }
}
