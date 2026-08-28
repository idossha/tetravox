/**
 * §8's unified settings dialog (directed task: unified settings, 2026-08-28).
 *
 * Every app preference behind one button and one popup, in four tabs: **Appearance** (theme),
 * **Capture** (§4.7 screenshot defaults), **Paths** (the FreeSurfer subjects directory — Phase 2's
 * original settings dialog, unchanged in behaviour) and **Startup** (reopen-last-scene). All four are
 * preferences about *this machine*, not the scene, so they all live in `settings.json` (`main/
 * settings.ts`) — and, since directed task unified-settings, may also be defaulted machine-wide from
 * `tetravoxrc`, whose path the footer shows with a "Reveal" button.
 *
 * There is deliberately **no validation message** on the Paths tab: see the original comment this
 * file carried, reproduced there — whether a directory holds a real `fsaverage` is a filesystem
 * question the info panel answers when a surface is opened.
 */

import { useEffect, useState } from 'react';
import type { ScreenshotOptions } from '@tetravox/engine';
import type { ScreenshotDefaults } from '../../../preload/index';
import type { SettingsTab } from '../store/store';
import type { ThemeChoice } from '../theme/theme';
import { THEME_CHOICES } from '../theme/theme';
import type { ThemeName } from '../theme/tokens';
import { DialogFrame, Field } from './dialog';

export interface SettingsDialogProps {
  tab: SettingsTab;
  onTab(tab: SettingsTab): void;

  // -- Appearance --
  themeChoice: ThemeChoice;
  /** What `themeChoice` resolves to right now — `theme-group`'s `data-theme-resolved` (§8). */
  theme: ThemeName;
  onThemeChoice(choice: ThemeChoice): void;

  // -- Capture --
  screenshotDefaults: ScreenshotDefaults;
  onScreenshotDefaults(patch: Partial<ScreenshotDefaults>): void;

  // -- Paths --
  subjectsDir: string;
  onSubjectsDir(dir: string): void;
  onBrowse(): void;

  // -- Startup --
  reopenLastScene: boolean;
  onReopenLastScene(on: boolean): void;

  // -- Footer --
  configPath: string;
  onRevealConfigFile(): void;

  onClose(): void;
}

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'capture', label: 'Capture' },
  { id: 'paths', label: 'Paths' },
  { id: 'startup', label: 'Startup' },
];

const BACKGROUNDS: readonly ScreenshotOptions['background'][] = ['scene', 'white', 'transparent'];

export function SettingsDialog({
  tab,
  onTab,
  themeChoice,
  theme,
  onThemeChoice,
  screenshotDefaults,
  onScreenshotDefaults,
  subjectsDir,
  onSubjectsDir,
  onBrowse,
  reopenLastScene,
  onReopenLastScene,
  configPath,
  onRevealConfigFile,
  onClose,
}: SettingsDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState(subjectsDir);
  // Browse writes through the store, so the field has to follow a value it did not type.
  useEffect(() => setDraft(subjectsDir), [subjectsDir]);
  const [dpiText, setDpiText] = useState(String(screenshotDefaults.dpi));
  useEffect(() => setDpiText(String(screenshotDefaults.dpi)), [screenshotDefaults.dpi]);

  return (
    <DialogFrame
      testId="settings-dialog"
      title="Settings"
      subtitle="Every preference for this machine, not the scene, in one place (§8)."
      width="42rem"
      onCancel={onClose}
      footer={
        <>
          <span
            data-testid="settings-config-path"
            className="mr-auto max-w-[22rem] truncate font-mono text-[10px] text-tvx-dim"
            title={configPath}
          >
            {configPath === '' ? '' : `Config file: ${configPath}`}
          </span>
          <button
            type="button"
            data-testid="settings-reveal-config"
            className="tvx-btn tvx-btn-sm"
            disabled={configPath === ''}
            onClick={onRevealConfigFile}
          >
            Reveal
          </button>
          <button type="button" data-testid="settings-close" className="tvx-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-0.5 border-b border-tvx-line pb-2" role="tablist">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`settings-tab-${id}`}
            className={tab === id ? 'tvx-btn tvx-btn-sm tvx-btn-on' : 'tvx-btn tvx-btn-sm'}
            onClick={() => onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'appearance' && (
        <div
          className="flex flex-col gap-1.5"
          role="tabpanel"
          data-testid="settings-panel-appearance"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
            Theme
          </span>
          {/* Testids kept as `theme-*` / `theme-group` (directed task: toolbar consolidation,
            2026-08-28) — this used to be the toolbar's own control, and the E2E that reads
            `data-theme-resolved` off it did not need to learn a new name, only a new place. */}
          <div
            className="flex items-center gap-1"
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
                onClick={() => onThemeChoice(choice)}
              >
                {choice === 'system' ? 'System' : choice === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-tvx-dim">
            System follows the operating system’s light/dark setting; the other two pin it.
          </p>
        </div>
      )}

      {tab === 'capture' && (
        <div className="flex flex-col gap-1" role="tabpanel" data-testid="settings-panel-capture">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
            Screenshot defaults
          </span>
          <Field label="Background">
            <select
              data-testid="settings-screenshot-background"
              className="tvx-input text-[11px]"
              value={screenshotDefaults.background}
              onChange={(e) =>
                onScreenshotDefaults({
                  background: e.currentTarget.value as ScreenshotOptions['background'],
                })
              }
            >
              {BACKGROUNDS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field label="DPI" hint="Written to the PNG pHYs chunk (§4.7)">
            <input
              data-testid="settings-screenshot-dpi"
              className="tvx-input w-24 font-mono text-[11px]"
              inputMode="numeric"
              value={dpiText}
              onChange={(e) => setDpiText(e.currentTarget.value)}
              onBlur={() => {
                const dpi = Number(dpiText);
                if (Number.isFinite(dpi) && dpi > 0) onScreenshotDefaults({ dpi });
                else setDpiText(String(screenshotDefaults.dpi));
              }}
            />
          </Field>
          <Field label="Auto-trim" hint="Crop the empty border away after rendering">
            <input
              type="checkbox"
              data-testid="settings-screenshot-autotrim"
              checked={screenshotDefaults.autoTrim}
              onChange={(e) => onScreenshotDefaults({ autoTrim: e.currentTarget.checked })}
            />
          </Field>
          <p className="mt-1 text-[10px] leading-relaxed text-tvx-dim">
            These apply the moment they are changed and every time the Screenshot dialog opens next.
            `Target`, size and the `Include` chrome toggles stay per-capture, in the Screenshot
            dialog itself.
          </p>
        </div>
      )}

      {tab === 'paths' && (
        <div className="flex flex-col gap-1.5" role="tabpanel" data-testid="settings-panel-paths">
          <label
            htmlFor="settings-fs-subjects"
            className="text-[11px] font-semibold uppercase tracking-wider text-tvx-dim"
          >
            FreeSurfer subjects directory
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="settings-fs-subjects"
              data-testid="settings-fs-subjects"
              spellCheck={false}
              placeholder="/usr/local/freesurfer/subjects"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => onSubjectsDir(draft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onSubjectsDir(e.currentTarget.value);
                }
              }}
              className="tvx-input min-w-0 flex-1 font-mono text-[11px]"
            />
            <button
              type="button"
              data-testid="settings-fs-browse"
              className="tvx-btn tvx-btn-sm"
              onClick={onBrowse}
            >
              Browse…
            </button>
            <button
              type="button"
              data-testid="settings-fs-clear"
              className="tvx-btn tvx-btn-sm"
              disabled={subjectsDir.length === 0}
              onClick={() => {
                setDraft('');
                onSubjectsDir('');
              }}
            >
              Clear
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-tvx-dim">
            Used for the <span className="font-mono">fsaverage</span> vertex in the info panel: a
            pick on a subject surface is mapped through its{' '}
            <span className="font-mono">sphere.reg</span> to the nearest vertex of{' '}
            <span className="font-mono">fsaverage/surf/lh.sphere</span>. Nothing is bundled — point
            this at a FreeSurfer <span className="font-mono">subjects</span> directory that contains{' '}
            <span className="font-mono">fsaverage</span>. Leave it empty and the row is simply
            absent.
          </p>
        </div>
      )}

      {tab === 'startup' && (
        <div className="flex flex-col gap-1.5" role="tabpanel" data-testid="settings-panel-startup">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
            Scenes
          </span>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="settings-reopen-last-scene"
              checked={reopenLastScene}
              onChange={(e) => onReopenLastScene(e.currentTarget.checked)}
            />
            Reopen last scene on launch
          </label>
          <p className="text-[10px] leading-relaxed text-tvx-dim">
            Off by default: reopening a scene reloads every dataset in it, which for a head mesh is
            seconds of work nobody asked for. When it is on, the most recent entry of{' '}
            <span className="font-mono">File ▸ Open Recent</span> opens at launch — unless the
            launch names a file of its own, which always wins.
          </p>
        </div>
      )}
    </DialogFrame>
  );
}
