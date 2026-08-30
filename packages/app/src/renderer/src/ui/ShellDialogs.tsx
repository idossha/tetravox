/**
 * The shell's modal layer: one dialog at a time, chosen by `UiState.dialog`.
 *
 * Keeping the switch here rather than three conditionals inside `Shell.tsx` is what makes "one at a
 * time" structural: all three of these cover the window, so a stack would only ever hide one behind
 * another, and the store field says which is up. It is also the seam the E2E drives — flipping
 * `dialog` in the store is the same code path a click on the toolbar takes.
 *
 * Every dialog receives *callbacks into the controller* and no `Engine` (§8), so the screenshot
 * preview really renders through §4.7 and the relocate picker really goes through the preload
 * bridge, without either component knowing that.
 */

import { useCallback } from 'react';
import type { DatasetRef, ScreenshotOptions } from '@tetravox/engine';
import { KeyboardHelp } from '../keyboard/KeyboardHelp';
import { RelocateDialog } from '../dialogs/RelocateDialog';
import { ScreenshotDialog } from '../dialogs/ScreenshotDialog';
import type { FigureOptions } from '../lib/figure';
import { SettingsDialog } from '../dialogs/SettingsDialog';
import { SampleDataDialog } from '../dialogs/SampleDataDialog';
import { useController, useUi } from './context';

export function ShellDialogs(): React.JSX.Element | null {
  const controller = useController();
  const dialog = useUi((s) => s.dialog);
  const relocate = useUi((s) => s.relocate);
  const screenshotOptions = useUi((s) => s.screenshotOptions);
  const subjectsDir = useUi((s) => s.freesurferSubjectsDir);
  const reopenLastScene = useUi((s) => s.reopenLastScene);
  const settingsTab = useUi((s) => s.settingsTab);
  const themeChoice = useUi((s) => s.themeChoice);
  const theme = useUi((s) => s.theme);
  const screenshotDefaults = useUi((s) => s.screenshotDefaults);
  const configPath = useUi((s) => s.configPath);
  const samples = useUi((s) => s.samples);
  const sampleStatuses = useUi((s) => s.sampleStatuses);
  const sampleProgress = useUi((s) => s.sampleProgress);
  const sampleCacheDir = useUi((s) => s.sampleCacheDir);

  const capture = useCallback(
    (opts: ScreenshotOptions, figure: FigureOptions | null) =>
      figure === null ? controller.captureScreenshot(opts) : controller.captureFigure(opts, figure),
    [controller]
  );
  const pick = useCallback((ref: DatasetRef) => controller.pickRelocation(ref), [controller]);
  const close = useCallback(() => controller.closeDialog(), [controller]);

  if (dialog === 'keyboard') return <KeyboardHelp open onClose={close} />;

  if (dialog === 'sampleData') {
    return (
      <SampleDataDialog
        samples={samples}
        statuses={sampleStatuses}
        progress={sampleProgress}
        cacheDir={sampleCacheDir}
        onOpen={(id) => void controller.openSample(id)}
        onCancel={(id) => controller.cancelSample(id)}
        onRemove={(id) => void controller.removeSample(id)}
        onRevealCache={() => controller.revealSampleCache()}
        onClose={close}
      />
    );
  }

  if (dialog === 'settings') {
    return (
      <SettingsDialog
        tab={settingsTab}
        onTab={(tab) => controller.openSettingsTab(tab)}
        themeChoice={themeChoice}
        theme={theme}
        onThemeChoice={(choice) => controller.setThemeChoice(choice)}
        screenshotDefaults={screenshotDefaults}
        onScreenshotDefaults={(patch) => void controller.setScreenshotDefaults(patch)}
        subjectsDir={subjectsDir}
        onSubjectsDir={(dir) => void controller.setFreesurferSubjectsDir(dir)}
        onBrowse={() => void controller.browseFreesurferSubjectsDir()}
        reopenLastScene={reopenLastScene}
        onReopenLastScene={(on) => void controller.setReopenLastScene(on)}
        configPath={configPath}
        onRevealConfigFile={() => void controller.revealConfigFile()}
        onClose={close}
      />
    );
  }

  if (dialog === 'screenshot') {
    return (
      <ScreenshotDialog
        views={controller.viewIds()}
        initial={screenshotOptions}
        capture={capture}
        onConfirm={(opts, figure) => void controller.saveScreenshot(opts, figure)}
        onCancel={close}
        onOpenDefaults={() => controller.openSettingsTab('capture')}
      />
    );
  }

  if (dialog === 'relocate' && relocate !== null) {
    return (
      <RelocateDialog
        missing={relocate.missing}
        pick={pick}
        onResolved={(paths) => void controller.resolveRelocate(paths)}
        onCancel={() => controller.cancelRelocate()}
      />
    );
  }

  return null;
}
