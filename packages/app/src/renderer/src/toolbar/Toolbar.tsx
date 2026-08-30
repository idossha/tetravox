/**
 * §8 top toolbar: "Open, layout, radiological toggle, screenshot, save/load scene".
 *
 * Consolidated (directed task: toolbar consolidation, 2026-08-28) from a rail that had grown three
 * separate ways to reach roughly the same preferences into one:
 *
 *  * **One `⚙`.** The screenshot-options gear and the Sys/Light/Dark buttons are gone; `SettingsDialog`
 *    is the single home for every standing preference (Appearance/Capture/Paths/Startup), and it is
 *    the right-most control on the rail so "the gear is always in the same corner" holds regardless
 *    of how many toggles sit to its left.
 *  * **"Tetravox" is a menu**, not a label. `Open…` / `New` / `Open scene…` / `Save` / `Save as…` are
 *    one accessible dropdown (`AppMenu.tsx`) instead of five buttons — see that file's header for
 *    why "Open Recent" is deliberately not in it.
 *  * **The screenshot button still shoots.** It captures with the options `SettingsDialog`'s Capture
 *    tab last left. The small `▾` beside it opens `ScreenshotDialog` for the per-capture knobs
 *    (target/size/scale/include) and the live preview — a capture action, not a setting, so it stays
 *    one click away without being a second gear.
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
import { ModuleSwitcher } from '../modules/ModuleSwitcher';
import { AppMenu } from './AppMenu';
import type { AppMenuAction } from './AppMenu';

export function Toolbar(): React.JSX.Element {
  const controller = useController();
  const layoutKind = useUi((s) => s.layoutKind);
  const radiological = useUi((s) => s.radiological);
  const crosshair = useUi((s) => s.crosshair);
  const colorbars = useUi((s) => s.colorbars);
  const leftPanelCollapsed = useUi((s) => s.leftPanelCollapsed);
  const rightPanelCollapsed = useUi((s) => s.rightPanelCollapsed);
  const measureMode = useUi((s) => s.measureMode);
  const scaleBar = useUi((s) => s.scaleBar);
  const orientationCube = useUi((s) => s.orientationCube);
  const sceneFile = useUi((s) => s.sceneFile);
  const sceneError = useUi((s) => s.sceneError);
  const dialog = useUi((s) => s.dialog);
  const hasContent = useUi((s) => s.layers.length > 0 || s.datasets.length > 0);

  const onOpen = useCallback(() => void controller.openDialog(), [controller]);
  const onScreenshot = useCallback(() => {
    void controller.saveScreenshot(controller.snapshotOptions());
  }, [controller]);

  const menuActions: AppMenuAction[] = [
    { id: 'open', label: 'Open…', onSelect: onOpen },
    {
      id: 'sample-data',
      label: 'Sample data…',
      title: 'Public datasets to download and open (File ▸ Sample Data…)',
      onSelect: () => void controller.openSampleData(),
    },
    {
      id: 'new',
      label: 'New',
      disabled: !hasContent,
      title: 'Close every dataset and start an empty scene',
      onSelect: () => controller.newScene(),
    },
    {
      id: 'open-scene',
      label: 'Open scene…',
      title: 'Open a *.tetravox.json scene (§4.6)',
      onSelect: () => void controller.openSceneDialog(),
    },
    {
      id: 'save',
      label: 'Save',
      disabled: !hasContent,
      title:
        sceneFile === null
          ? 'Save this scene to a new *.tetravox.json'
          : `Save over ${sceneFile.path}`,
      onSelect: () => void controller.saveScene(),
    },
    {
      id: 'save-as',
      label: 'Save as…',
      disabled: !hasContent,
      onSelect: () => void controller.saveSceneAs(),
    },
  ];

  // Three columns whose outer two are the sidebars' widths (`ui/Shell.tsx`: `w-72` left, `w-80`
  // right, a `w-6` rail when collapsed), so the controls in the middle column are centred over the
  // **view grid** rather than over the window — which is where a user looking at the panes expects
  // the layout, crosshair and screenshot buttons to be. The columns follow the collapse state, so a
  // collapsed panel slides the cluster over with the grid.
  const leftCol = leftPanelCollapsed ? '1.5rem' : '18rem';
  const rightCol = rightPanelCollapsed ? '1.5rem' : '20rem';
  return (
    <header
      data-testid="toolbar"
      className="grid items-center gap-2 border-b border-tvx-line bg-tvx-panel px-3 py-1.5"
      style={{ gridTemplateColumns: `minmax(0, ${leftCol}) 1fr minmax(0, ${rightCol})` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AppMenu actions={menuActions} />

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
      </div>

      <div
        data-testid="toolbar-controls"
        className="flex min-w-0 flex-wrap items-center justify-center gap-2"
      >
        <div className="flex items-center gap-0.5" role="group" aria-label="Layout">
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

        {/* `ShellController.resetAll` (`Home`): refit every view, send the cursor to world (0, 0, 0)
        and cancel any measurement in progress — deliberately not `scene-new` beside it, so it
        never unloads a dataset or touches a layer property. */}
        <button
          type="button"
          data-testid="reset-all"
          className="tvx-btn"
          title="Reset: refit every view and jump the cursor to world (0, 0, 0). Datasets and layers are untouched. (Home)"
          onClick={() => controller.runCommand({ kind: 'resetAll' })}
        >
          Reset
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

        {/* Directed task 10: the two §4.5 annotations that were named but never drawn. */}
        <button
          type="button"
          data-testid="scalebar-toggle"
          aria-pressed={scaleBar}
          className={scaleBar ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
          onClick={() => controller.toggleScaleBar()}
          title="Scale bar: a millimetre rule in every 2D pane, snapped to 1 2 5 10 20 50 100 mm (§4.5)"
        >
          Scale
        </button>

        <button
          type="button"
          data-testid="orientation-cube-toggle"
          aria-pressed={orientationCube}
          className={orientationCube ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
          onClick={() => controller.toggleOrientationCube()}
          title="Orientation cube: A/P/L/R/S/I faces in the 3D pane; click a face for that preset (§4.5)"
        >
          Cube
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
            data-testid="screenshot-menu"
            aria-label="Screenshot options"
            aria-pressed={dialog === 'screenshot'}
            className={dialog === 'screenshot' ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
            title="Target, size, scale, DPI, background, chrome and auto-trim, with a live preview (§4.7)"
            onClick={() => controller.openDialogKind('screenshot')}
          >
            ▾
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {/* §13.3: one switcher, in the right column, directly above the slot it opens — never a
          button per module, which would wrap the toolbar's centre cluster at 1440 px with the
          second one. It renders nothing at all in a build that offers no module. */}
        <ModuleSwitcher />

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

        <button
          type="button"
          data-testid="settings-button"
          title="Settings — appearance, capture defaults, paths and startup (§8)"
          aria-label="Settings"
          aria-pressed={dialog === 'settings'}
          className={dialog === 'settings' ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
          onClick={() => controller.openDialogKind(dialog === 'settings' ? 'none' : 'settings')}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
