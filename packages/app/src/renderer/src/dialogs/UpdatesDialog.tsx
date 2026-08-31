/**
 * Software Update (§12.4, `main/updater.ts`, 2026-08-31).
 *
 * Pure presentational, like every dialog here: values and callbacks, no store, no bridge. The one
 * `UpdateStatus` prop is the whole truth — main owns the feed and the installer, and this component
 * only says where things stand and offers the clicks that exist in the current phase. The download
 * runs in main, so closing this dialog interrupts nothing; the status-bar pill keeps the thread.
 */

import type { UpdateStatus } from '../bridge';
import { DialogFrame } from './dialog';

export interface UpdatesDialogProps {
  status: UpdateStatus | null;
  onCheck(): void;
  onDownload(): void;
  onInstall(): void;
  onSkip(): void;
  onClose(): void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

export function UpdatesDialog({
  status,
  onCheck,
  onDownload,
  onInstall,
  onSkip,
  onClose,
}: UpdatesDialogProps): React.JSX.Element {
  const phase = status?.phase ?? 'idle';
  const mode = status?.mode ?? 'off';
  const received = status?.received ?? 0;
  const total = status?.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  return (
    <DialogFrame
      testId="updates-dialog"
      title="Software Update"
      subtitle={
        status !== null && status.current !== ''
          ? `Tetravox ${status.current} — updates come from the GitHub Releases page (§12.4).`
          : 'Updates come from the GitHub Releases page (§12.4).'
      }
      width="30rem"
      onCancel={onClose}
      footer={
        <>
          {mode !== 'off' && (phase === 'none' || phase === 'error') && (
            <button type="button" data-testid="updates-check" className="tvx-btn" onClick={onCheck}>
              {phase === 'error' ? 'Try Again' : 'Check Again'}
            </button>
          )}
          {phase === 'available' && (
            <>
              <button
                type="button"
                data-testid="updates-download"
                className="tvx-btn tvx-btn-on"
                onClick={mode === 'notify' ? onInstall : onDownload}
              >
                {mode === 'notify' ? 'Open Releases Page' : `Update to ${status?.available}`}
              </button>
              <button type="button" data-testid="updates-skip" className="tvx-btn" onClick={onSkip}>
                Skip This Version
              </button>
            </>
          )}
          {phase === 'downloaded' && (
            <button
              type="button"
              data-testid="updates-install"
              className="tvx-btn tvx-btn-on"
              onClick={onInstall}
            >
              Restart Now
            </button>
          )}
          {/* Last, so Escape and the cancelling button agree (`ConfirmDialog`'s rule). */}
          <button
            type="button"
            data-testid="updates-close"
            className="tvx-btn ml-auto"
            onClick={onClose}
          >
            {phase === 'available' || phase === 'downloaded' ? 'Later' : 'Close'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs" data-testid={`updates-phase-${phase}`}>
        {mode === 'off' && (
          <p className="text-[11px] leading-relaxed text-tvx-dim">
            In-app updates come with the packaged releases. This build checks nothing — new versions
            are announced on the GitHub Releases page.
          </p>
        )}

        {mode !== 'off' && (phase === 'idle' || phase === 'checking') && (
          <p className="text-[11px] text-tvx-dim" role="status">
            Checking for updates…
          </p>
        )}

        {mode !== 'off' && phase === 'none' && (
          <p className="text-[11px] text-tvx-dim" role="status">
            You’re up to date{status?.current !== '' ? ` — Tetravox ${status?.current}` : ''} is the
            newest version.
          </p>
        )}

        {phase === 'error' && (
          <p className="break-words text-[11px] text-tvx-danger" role="alert">
            Could not check for updates: {status?.error ?? 'unknown error'}
          </p>
        )}

        {(phase === 'available' || phase === 'downloading' || phase === 'downloaded') && (
          <>
            <p className="text-[11px]">
              <strong className="font-semibold">Tetravox {status?.available}</strong>{' '}
              <span className="text-tvx-dim">is available — you have {status?.current}.</span>
            </p>
            {mode === 'notify' && phase === 'available' && (
              <p className="text-[10px] leading-relaxed text-tvx-dim">
                This install came from a <span className="font-mono">.deb</span> or{' '}
                <span className="font-mono">.tar.gz</span>, which the app does not replace in place
                — the Releases page has the new one.
              </p>
            )}
            {phase === 'downloading' && (
              <div className="flex items-center gap-2 pt-1">
                <div
                  className="h-1.5 flex-1 overflow-hidden rounded bg-tvx-line"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full bg-tvx-accent transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-24 text-right font-mono text-[10px] text-tvx-dim">
                  {total > 0 ? `${formatBytes(received)} · ${pct}%` : '…'}
                </span>
              </div>
            )}
            {phase === 'downloaded' && (
              <p className="text-[10px] leading-relaxed text-tvx-dim" role="status">
                Downloaded. Restart to use it now — or keep working, and it installs when the app
                next quits.
              </p>
            )}
            {status?.notes !== undefined && (
              <div className="max-h-48 overflow-y-auto rounded border border-tvx-line bg-tvx-bg/40 p-2">
                <pre
                  data-testid="updates-notes"
                  className="whitespace-pre-wrap break-words font-sans text-[10px] leading-relaxed text-tvx-dim"
                >
                  {status.notes}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </DialogFrame>
  );
}
