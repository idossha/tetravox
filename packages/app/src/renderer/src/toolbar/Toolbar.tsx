/**
 * §8 top toolbar: "Open, layout, radiological toggle, screenshot, save/load scene".
 *
 * Phase 1 shipped every one of those but the last, which the audit recorded as "absent rather than
 * present-and-dead" (§10). Phase 2 fills it in: **New · Open scene · Save · Save as**, writing
 * `*.tetravox.json` (§4.6), with the attached file's name shown so "Save" is never ambiguous about
 * where it is about to write.
 *
 * Two deliberate choices in here:
 *
 *  * **The screenshot button still shoots.** It captures with the options the dialog last left, and
 *    the `⚙` beside it opens the dialog. A single button that only opened a form would make the
 *    common case — "take a picture of this" — three clicks, and it would break the Phase-1 E2E that
 *    asserts a click produces a PNG.
 *  * **The `?` opens the keyboard sheet**, and the one-line `KEYMAP_HELP` stays as the tooltip. The
 *    sheet is generated from `keymap.ts` (`keyboard/bindings.ts`), so it cannot drift from what the
 *    resolver implements.
 *
 * Every control here is one controller call, and every controller call is one §4.7 member or one
 * preload-bridge call — there is no scene state in this file.
 */

import { useCallback } from 'react';
import { LAYOUT_LABEL } from '../lib/layout';
import { KEYMAP_HELP } from '../keyboard/keymap';
import { useController, useUi } from '../ui/context';
import { THEME_CHOICES } from '../theme/theme';

export function Toolbar(): React.JSX.Element {
  const controller = useController();
  const layoutKind = useUi((s) => s.layoutKind);
  const radiological = useUi((s) => s.radiological);
  const crosshair = useUi((s) => s.crosshair);
  const colorbars = useUi((s) => s.colorbars);
  const measureMode = useUi((s) => s.measureMode);
  const sceneFile = useUi((s) => s.sceneFile);
  const sceneError = useUi((s) => s.sceneError);
  const dialog = useUi((s) => s.dialog);
  const themeChoice = useUi((s) => s.themeChoice);
  const theme = useUi((s) => s.theme);
  const hasContent = useUi((s) => s.layers.length > 0 || s.datasets.length > 0);
  const busy = useUi((s) => s.loads.some((c) => c.state === 'loading' || c.state === 'queued'));

  const onOpen = useCallback(() => void controller.openDialog(), [controller]);
  const onScreenshot = useCallback(() => {
    void controller.saveScreenshot(controller.snapshotOptions());
  }, [controller]);

  return (
    <header
      data-testid="toolbar"
      className="flex items-center gap-2 border-b border-tvx-line bg-tvx-panel px-3 py-1.5"
    >
      <span className="mr-1 text-sm font-semibold tracking-wide text-tvx-text">Tetravox</span>

      <button type="button" data-testid="open-button" className="tvx-btn" onClick={onOpen}>
        Open…
      </button>

      {/* Scene save/load (§4.6, §8). Grouped so the four verbs read as one control, not four. */}
      <div className="flex items-center gap-0.5" role="group" aria-label="Scene">
        <button
          type="button"
          data-testid="scene-new"
          className="tvx-btn"
          disabled={!hasContent}
          title="Close every dataset and start an empty scene"
          onClick={() => controller.newScene()}
        >
          New
        </button>
        <button
          type="button"
          data-testid="scene-open"
          className="tvx-btn"
          title="Open a *.tetravox.json scene (§4.6)"
          onClick={() => void controller.openSceneDialog()}
        >
          Open scene…
        </button>
        <button
          type="button"
          data-testid="scene-save"
          className="tvx-btn"
          disabled={!hasContent}
          title={
            sceneFile === null
              ? 'Save this scene to a new *.tetravox.json'
              : `Save over ${sceneFile.path}`
          }
          onClick={() => void controller.saveScene()}
        >
          Save
        </button>
        <button
          type="button"
          data-testid="scene-save-as"
          className="tvx-btn"
          disabled={!hasContent}
          onClick={() => void controller.saveSceneAs()}
        >
          Save as…
        </button>
      </div>

      {sceneFile !== null && (
        <span
          data-testid="scene-file"
          className="max-w-[12rem] truncate text-[10px] text-tvx-dim"
          title={sceneFile.path}
        >
          {sceneFile.name}
          {sceneFile.savedAt === null ? '' : ' ✓'}
        </span>
      )}
      {sceneError !== null && (
        <span
          data-testid="scene-error"
          className="max-w-[14rem] truncate text-[10px] text-tvx-danger"
        >
          {sceneError}
        </span>
      )}

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
        data-testid="colorbars-toggle"
        aria-pressed={colorbars}
        className={colorbars ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
        onClick={() => controller.toggleColorbars()}
        title="Colour bars: one per visible scalar layer, with ticks, units and the threshold notch (§8)"
      >
        Bars
      </button>

      {/* §7.5's measure mode (directed task 11). A toolbar mode with a key, beside the two other
        toggles it behaves like. `aria-pressed` is the projection of `Engine.measureMode()`. */}
      <button
        type="button"
        data-testid="measure-toggle"
        aria-pressed={measureMode}
        className={measureMode ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
        onClick={() => controller.toggleMeasureMode()}
        title="Measure (m): two clicks in a pane give a length in mm, a third an angle. Esc cancels."
      >
        Measure
      </button>

      <div className="flex items-center gap-0.5" role="group" aria-label="Screenshot">
        <button
          type="button"
          data-testid="screenshot-button"
          className="tvx-btn"
          onClick={onScreenshot}
        >
          Screenshot
        </button>
        <button
          type="button"
          data-testid="screenshot-options"
          aria-label="Screenshot options"
          aria-pressed={dialog === 'screenshot'}
          className={dialog === 'screenshot' ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
          title="Target, size, scale, DPI, background, chrome and auto-trim (§4.7)"
          onClick={() => controller.openDialogKind('screenshot')}
        >
          ⚙
        </button>
      </div>

      <button
        type="button"
        data-testid="settings-button"
        title="Settings — the FreeSurfer subjects directory for the fsaverage read-out (§8)"
        aria-label="Settings"
        aria-pressed={dialog === 'settings'}
        className={dialog === 'settings' ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
        onClick={() => controller.openDialogKind(dialog === 'settings' ? 'none' : 'settings')}
      >
        ⚙
      </button>

      {/* §8's theme switch. Three radio-ish buttons rather than a `<select>`: it is the same
        control shape as the layout and RAD/NEU groups beside it, one click deep instead of two,
        and `aria-pressed` makes the current one announceable. `data-theme-resolved` is what the
        E2E reads to tell "System, which is dark right now" from "Dark". */}
      <div
        className="flex items-center gap-0.5"
        role="group"
        aria-label="Theme"
        data-testid="theme-group"
        data-theme-choice={themeChoice}
        data-theme-resolved={theme}
      >
        {THEME_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            data-testid={`theme-${choice}`}
            aria-pressed={themeChoice === choice}
            className={themeChoice === choice ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
            title={
              choice === 'system'
                ? 'Follow the operating system’s light/dark setting'
                : `Always use the ${choice} theme`
            }
            onClick={() => controller.setThemeChoice(choice)}
          >
            {choice === 'system' ? 'Sys' : choice === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </div>

      <button
        type="button"
        data-testid="keyboard-help-button"
        aria-label="Keyboard shortcuts"
        aria-pressed={dialog === 'keyboard'}
        className={dialog === 'keyboard' ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
        title={KEYMAP_HELP}
        onClick={() => controller.toggleKeyboardHelp()}
      >
        ?
      </button>

      <span data-testid="keymap-help" className="ml-auto truncate text-[11px] text-tvx-dim">
        {busy ? 'loading…' : 'press ? for the key map'}
      </span>
    </header>
  );
}
