/**
 * Layout composition for the §8 toolbar switcher and the `x` key (§7.5).
 *
 * `Engine.setLayout(layout)` takes `{ kind, cells }` (§4.5), so *something* has to turn a layout kind
 * into an ordered list of `ViewId`s. That something is here, pure and tested, rather than inline in a
 * React handler: `Scene.slices` is "independent of layout, so `'3d-only'` keeps plane state", which
 * only holds if choosing cells never edits the views themselves.
 */

import type { LayoutKind, SliceMode, SliceView, View3D, ViewId, ViewSpec } from '@tetravox/engine';

/**
 * **The catalogue: every layout the app offers contains the 3D pane** (directed task 3, 2026-08-28).
 *
 * The maintainer's ask was "the 3D viewer is always on — the only option is whether to render the
 * isosurface". A `1x1` of a slice and a `1x3` of three slices are the two layouts that *cannot*
 * satisfy it, so they leave the toolbar and the `x` cycle. `'1+3'` (3D large, three slices down a
 * narrow column) replaces `1x3` as the reading layout and `'3d+1'` replaces `1x1` as the zoomed one;
 * `2x2` already had a 3D cell and `3d-only` is all 3D.
 *
 * The kinds themselves are **not** removed from `LayoutKind`: §11's single-pane pixel harnesses set
 * `{kind:'1x1', cells:['axial']}` in some thirty specs, and an analytic assertion on one pane is
 * exactly what a viewer catalogue has no business breaking. This is a catalogue, not a model change
 * — which is why {@link migrateLayoutKind}, and not a parser error, is what a saved scene meets.
 */
export const LAYOUT_CYCLE: readonly LayoutKind[] = ['2x2', '1+3', '3d+1', '3d-only'] as const;

export const LAYOUT_LABEL: Record<LayoutKind, string> = {
  '1x1': '1×1',
  '1x3': '1×3',
  '1x3-horizontal': '1×3 —',
  '2x2': '2×2',
  '3d-only': '3D',
  '1+3': '1+3',
  '3d+1': '3D+1',
};

/**
 * What a saved scene's layout becomes on load: itself, or the nearest catalogue entry.
 *
 * "Nearest" is by **pane count and shape**, not by name: a `1x1` was one big pane, so it becomes
 * `3d+1` — the smallest catalogue layout, which keeps the zoomed feel and adds the 3D pane the
 * catalogue now guarantees; a `1x3` or `1x3-horizontal` was three slices, so it becomes `1+3`, which
 * is those same three slices with the 3D pane beside them. Nothing is dropped and no view is
 * rebuilt: `Scene.slices` is independent of the layout (§4.5), so the migration is one string.
 */
export function migrateLayoutKind(kind: LayoutKind): LayoutKind {
  switch (kind) {
    case '1x1':
      return '3d+1';
    case '1x3':
    case '1x3-horizontal':
      return '1+3';
    default:
      return kind;
  }
}

/** True for a layout the toolbar and the `x` cycle offer — i.e. one that contains the 3D pane. */
export function isOfferedLayout(kind: LayoutKind): boolean {
  return LAYOUT_CYCLE.includes(kind);
}

export function nextLayout(kind: LayoutKind): LayoutKind {
  const i = LAYOUT_CYCLE.indexOf(migrateLayoutKind(kind));
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
    // The 3D pane leads in both new layouts, so `cells[0]` is the 3D one wherever 3D is the subject
    // of the layout — which is what `view/layout.ts` lays out and what a `1x1`-style zoom expects.
    case '3d+1': {
      const slice = preferred != null && ids.includes(preferred) ? preferred : ids[0];
      return slice === undefined ? [view3d.id] : [view3d.id, slice];
    }
    case '1+3':
      return [view3d.id, ...ids.slice(0, 3)];
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
    case '3d+1':
      return { columns: 'repeat(2, 1fr)', rows: '1fr' };
    case '1+3':
      // `2fr / 1fr` is `view/layout.ts`'s `ONE_PLUS_THREE_MAIN = 2/3`, said in CSS. The three slices
      // are placed by the overlay's own grid-row spans, so the column is three rows tall.
      return { columns: '2fr 1fr', rows: `repeat(${Math.max(1, cells - 1)}, 1fr)` };
  }
}

/**
 * The CSS grid placement of one cell, when the flow order is not enough.
 *
 * Only `'1+3'` needs it: the 3D pane is the first cell and has to span the column's three rows, and
 * CSS auto-flow would otherwise put it in row 1 and push a slice under it. Everything else places
 * itself, and gets `undefined` — an explicit "no override" the caller can spread.
 */
export function layoutCellStyle(
  kind: LayoutKind,
  index: number
): { gridColumn: string; gridRow: string } | undefined {
  if (kind !== '1+3') return undefined;
  if (index === 0) return { gridColumn: '1', gridRow: '1 / -1' };
  return { gridColumn: '2', gridRow: `${index}` };
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
    case '3d+1':
      return x < rect.width / 2 ? 0 : 1;
    case '1+3': {
      const split = rect.width * (2 / 3);
      if (x < split) return 0;
      const rows = cellCount - 1;
      if (rows <= 0) return 0;
      return clamp(1 + Math.floor((y / rect.height) * rows), cellCount - 1);
    }
  }
}

/**
 * A `ViewSpec` as the catalogue accepts it: the same spec, with a removed layout migrated.
 *
 * Applied by `controller.loadScene` **before** `Engine.load`, so the engine never sees the old kind
 * and `resyncFromEngine` reads the migrated one back out of `Scene`. The cells are recomputed rather
 * than carried, because a migrated layout has a different number of them and a different order (the
 * 3D pane leads) — and they can be recomputed exactly, since the spec carries its own `slices` and
 * `view3d` and §4.5 keeps those independent of the layout.
 *
 * A spec whose layout is already offered is returned **by identity**, so the common path allocates
 * nothing and a test can assert that nothing was touched.
 */
export function migrateSpecLayout(spec: ViewSpec): ViewSpec {
  const kind = migrateLayoutKind(spec.layout.kind);
  if (kind === spec.layout.kind) return spec;
  return {
    ...spec,
    layout: { kind, cells: layoutCells(kind, spec.slices, spec.view3d) },
  };
}
