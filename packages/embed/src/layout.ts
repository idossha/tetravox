/**
 * `setLayout`'s `kind`, from what `docs/EMBED.md` documents to what the engine actually has.
 *
 * **This file is a repair, and it is worth reading why it exists.** §4.5's `LayoutKind` is
 * `'1x1' | '1x3' | '1x3-horizontal' | '2x2' | '3d-only' | '1+3' | '3d+1'`. `docs/EMBED.md`'s
 * protocol-1 table has always said the message takes
 * `'2x2' | '1+3' | '3d+1' | '3d' | 'axial' | 'coronal' | 'sagittal'` — four of which are not
 * `LayoutKind` values at all. TypeScript never caught it because a host's message is JSON: the
 * declared type is `LayoutKind` and the value is whatever arrived.
 *
 * What happened to a host that believed the table: `layoutCells` is an exhaustive `switch` over the
 * seven real kinds, so an eighth returned `undefined`, `Engine.setLayout({ kind, cells: undefined })`
 * stored it, and the **next frame** threw `Cannot read properties of undefined (reading 'length')`
 * inside `viewports()` — in the render loop, with no message back to the host and no way to recover
 * short of reloading the frame. A documented message that kills the viewer.
 *
 * So the four documented names are made real rather than deleted, because they are the ones a host
 * wants — "show me the coronal pane", "show me 3-D" — and each maps onto something the engine and
 * the app already do:
 *
 * | Documented | What it is |
 * |---|---|
 * | `'3d'` | `'3d-only'` |
 * | `'axial'` / `'coronal'` / `'sagittal'` | `'1x1'` with that pane active — `layoutCells` honours the active view |
 *
 * And every other string is refused with an `error` reply, which is what the protocol says a message
 * the embed cannot act on gets. Both halves are additive: the seven real kinds are unchanged, and a
 * host that sent one of the four aliases previously got a dead viewer, which is not behaviour there
 * is any obligation to reproduce.
 */

import type { LayoutKind, ViewId } from '@tetravox/engine';

/** The seven §4.5 kinds. Written out because `LayoutKind` is a type and this is a runtime check. */
export const ENGINE_LAYOUT_KINDS: readonly LayoutKind[] = [
  '1x1',
  '1x3',
  '1x3-horizontal',
  '2x2',
  '3d-only',
  '1+3',
  '3d+1',
];

/** The four names `docs/EMBED.md` documents that §4.5 does not have, and what each one means. */
export const LAYOUT_ALIASES: Readonly<Record<string, { kind: LayoutKind; viewId?: ViewId }>> = {
  '3d': { kind: '3d-only' },
  axial: { kind: '1x1', viewId: 'axial' },
  coronal: { kind: '1x1', viewId: 'coronal' },
  sagittal: { kind: '1x1', viewId: 'sagittal' },
};

/**
 * A host's `kind` → the layout to apply, or `null` for one this build cannot act on.
 *
 * `viewId` is the pane to make active **first**: `layoutCells('1x1', …, preferred)` returns
 * `[preferred]` when it is one of the views, which is the only way to say *which* single pane a
 * `'1x1'` shows.
 */
export function resolveLayout(kind: unknown): { kind: LayoutKind; viewId?: ViewId } | null {
  if (typeof kind !== 'string') return null;
  if ((ENGINE_LAYOUT_KINDS as readonly string[]).includes(kind)) {
    return { kind: kind as LayoutKind };
  }
  return LAYOUT_ALIASES[kind] ?? null;
}
