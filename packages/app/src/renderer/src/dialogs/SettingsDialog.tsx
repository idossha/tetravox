/**
 * §8's settings dialog (directed task 8, 2026-08-28).
 *
 * One field today: the **FreeSurfer subjects directory**, which is what turns the fsaverage row of
 * the info panel on. It is a preference rather than part of a scene — it describes the *machine*,
 * not the data — so it lives in `settings.json` beside the theme (`main/settings.ts`) and not in a
 * `ViewSpec`.
 *
 * The path is typed **or** browsed. Browse goes through the preload bridge to a native directory
 * picker, because §5 keeps the filesystem in main and the renderer has no way to enumerate one; the
 * text field exists anyway, because a user who knows the path should not have to click through four
 * levels of `/usr/local/freesurfer/subjects` to enter it, and because that is the field a headless
 * or scripted run can drive.
 *
 * There is deliberately **no validation message here**. Whether the directory holds an `fsaverage`
 * with the right surfaces is a filesystem question main answers when a surface is opened, and the
 * honest place to report the answer is the readout that would have shown the vertex — a dialog that
 * said "looks fine" and a panel that then showed nothing would be worse than one that says neither.
 */

import { useEffect, useState } from 'react';
import { DialogFrame } from './dialog';

export interface SettingsDialogProps {
  subjectsDir: string;
  onSubjectsDir(dir: string): void;
  onBrowse(): void;
  /** "Reopen last scene on launch" (directed task 13); persisted in `settings.json`. */
  reopenLastScene: boolean;
  onReopenLastScene(on: boolean): void;
  onClose(): void;
}

export function SettingsDialog({
  subjectsDir,
  onSubjectsDir,
  onBrowse,
  reopenLastScene,
  onReopenLastScene,
  onClose,
}: SettingsDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState(subjectsDir);
  // Browse writes through the store, so the field has to follow a value it did not type.
  useEffect(() => setDraft(subjectsDir), [subjectsDir]);

  return (
    <DialogFrame
      testId="settings-dialog"
      title="Settings"
      subtitle="Preferences for this machine, not for the scene (§8)."
      width="38rem"
      onCancel={onClose}
      footer={
        <button type="button" data-testid="settings-close" className="tvx-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="flex flex-col gap-1.5">
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
          Used for the <span className="font-mono">fsaverage</span> vertex in the info panel: a pick
          on a subject surface is mapped through its <span className="font-mono">sphere.reg</span>{' '}
          to the nearest vertex of <span className="font-mono">fsaverage/surf/lh.sphere</span>.
          Nothing is bundled — point this at a FreeSurfer{' '}
          <span className="font-mono">subjects</span> directory that contains{' '}
          <span className="font-mono">fsaverage</span>. Leave it empty and the row is simply absent.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-1.5 border-t border-tvx-line pt-4">
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
          <span className="font-mono">File ▸ Open Recent</span> opens at launch — unless the launch
          names a file of its own, which always wins.
        </p>
      </div>
    </DialogFrame>
  );
}
