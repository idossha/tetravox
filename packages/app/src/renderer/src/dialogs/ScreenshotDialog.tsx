/**
 * The screenshot dialog — **Phase 2** (owner: A-SHELL).
 *
 * It edits a `ScreenshotOptions` (§4.7) and hands it to `Engine.screenshot`. Phase 1's toolbar button
 * calls that method with a fixed options object; the dialog is what exposes the rest of the spec:
 * `target: 'view' | 'grid'` with a `viewId`, `width` / `height` / `scale`, `dpi` (written into the
 * PNG **pHYs** chunk), `background`, the `include` toggles (colour bar, orientation labels,
 * crosshair, corner info, scale bar) and `autoTrim`.
 *
 * The engine half of those knobs is P2-06 in `docs/review/2026-08-27-phase1-audit.md`; this dialog is
 * inert until it lands, so that the two halves can be built in either order.
 */

import type { ScreenshotOptions, ViewId } from '@tetravox/engine';

export interface ScreenshotDialogProps {
  /** The panes the `target: 'view'` selector offers. */
  views: readonly ViewId[];
  /** The starting options — Phase 1's fixed set, until the dialog can edit them. */
  initial: ScreenshotOptions;
  onConfirm(opts: ScreenshotOptions): void;
  onCancel(): void;
}

export function ScreenshotDialog(_props: ScreenshotDialogProps): React.JSX.Element | null {
  return null;
}
