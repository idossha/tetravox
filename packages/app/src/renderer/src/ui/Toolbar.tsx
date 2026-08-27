/**
 * §8 top toolbar: Open, layout, radiological toggle, screenshot.
 *
 * Scene save/load is the other member of §8's list and is a Phase-2 item (`ViewSpec`, relocate
 * dialog), so its control is absent rather than present-and-dead.
 */

import { useCallback } from 'react';
import { LAYOUT_LABEL } from '../lib/layout';
import { KEYMAP_HELP } from '../lib/keymap';
import { useController, useUi } from './context';

export function Toolbar(): React.JSX.Element {
  const controller = useController();
  const layoutKind = useUi((s) => s.layoutKind);
  const radiological = useUi((s) => s.radiological);
  const crosshair = useUi((s) => s.crosshair);
  const busy = useUi((s) => s.loads.some((c) => c.state === 'loading' || c.state === 'queued'));

  const onOpen = useCallback(() => void controller.openDialog(), [controller]);
  const onScreenshot = useCallback(() => void controller.screenshot(), [controller]);

  return (
    <header
      data-testid="toolbar"
      className="flex items-center gap-2 border-b border-tvx-line bg-tvx-panel px-3 py-1.5"
    >
      <span className="mr-1 text-sm font-semibold tracking-wide text-tvx-accent">Tetravox</span>

      <button type="button" data-testid="open-button" className="tvx-btn" onClick={onOpen}>
        Open…
      </button>

      <div className="mx-2 flex items-center gap-0.5" role="group" aria-label="Layout">
        {controller.layouts.map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={`layout-${kind}`}
            aria-pressed={layoutKind === kind}
            className={layoutKind === kind ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
            onClick={() => controller.setLayout(kind)}
          >
            {LAYOUT_LABEL[kind]}
          </button>
        ))}
      </div>

      <button
        type="button"
        data-testid="radiological-toggle"
        aria-pressed={radiological}
        className={radiological ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
        onClick={() => controller.setRadiological(!radiological)}
        title="Radiological convention mirrors the in-plane right axis only (§3)"
      >
        {radiological ? 'RAD' : 'NEU'}
      </button>

      <button
        type="button"
        data-testid="crosshair-toggle"
        aria-pressed={crosshair}
        className={crosshair ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
        onClick={() => controller.toggleCrosshair()}
      >
        Crosshair
      </button>

      <button
        type="button"
        data-testid="screenshot-button"
        className="tvx-btn"
        onClick={onScreenshot}
      >
        Screenshot
      </button>

      <span
        data-testid="keymap-help"
        className="ml-auto truncate text-[11px] text-tvx-dim"
        title={KEYMAP_HELP}
      >
        {busy ? 'loading…' : KEYMAP_HELP}
      </span>
    </header>
  );
}
