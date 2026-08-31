/**
 * File ▸ Extensions… (§13.8): the module catalogue as a grid of cards, and the consent sheet.
 *
 * `SampleDataDialog.tsx` one door further in, and deliberately the same file twice over — the same
 * `DialogFrame`, the same card grid, the same one-button-that-says-the-true-state rule, the same
 * progress bar with **Cancel**, the same footer with a directory and a **Show folder**. Everything
 * that is *different* is different because the payload is script:
 *
 *  * **installing is not enabling.** A downloaded module sits inert in `~/.tetravox/modules/` until
 *    the user consents; `moduleEnable` is the message that says so, and it is the only thing that
 *    puts a file on `main/protocol.ts`'s `tetravox://module` map. So "Download & enable" is two
 *    calls with a sheet between them, never one;
 *  * **the sheet is a state of this dialog, not a toast or a second modal layer.** It replaces the
 *    grid, names the module and its version, lists the permissions **derived from the manifest**
 *    (`manifest-schema.ts#derivePermissions` — one schema, no second source of truth), links the
 *    repository, and offers exactly Enable and Cancel;
 *  * **nothing here is a path.** The cards carry ids, versions, byte counts and card states. The
 *    footer shows the install directory as *text* and the only thing that can act on it is
 *    `moduleRevealDir`, which opens it in the OS file manager from main.
 *
 * Every action's reply carries the refreshed statuses (`ModuleActionResult`), so a card never makes
 * a second round trip to find out what it now says.
 */

import { useState } from 'react';
import type { ExtensionEntry, ModuleProgress, ModuleStatus } from '../../../preload/index';
import { DialogFrame } from './dialog';
import { formatBytes } from './SampleDataDialog';

export interface ExtensionsDialogProps {
  catalogue: readonly ExtensionEntry[];
  statuses: readonly ModuleStatus[];
  /** In-flight installs, and the last failure of one, by module id. */
  progress: Readonly<Record<string, ModuleProgress>>;
  dir: string;
  /** Download and verify. Resolves true when the files are on disk — never when they are running. */
  onInstall(id: string, version?: string): Promise<boolean>;
  onCancel(id: string): void;
  /** Record the consent and make the module reachable. Called only from the sheet. */
  onEnable(id: string): Promise<boolean>;
  onDisable(id: string): void;
  onRemove(id: string): void;
  onRevealDir(): void;
  onClose(): void;
}

/** What the card's one button says, which is the module's true state and nothing else. */
export function primaryAction(status: ModuleStatus): {
  label: string;
  kind: 'install' | 'enable' | 'update' | 'none';
} {
  if (status.incompatible !== undefined) return { label: '', kind: 'none' };
  if (status.installed === null) {
    return status.available === null
      ? { label: '', kind: 'none' }
      : { label: 'Download & enable', kind: 'install' };
  }
  if (status.updatable && status.available !== null) {
    return { label: `Update to ${status.available}`, kind: 'update' };
  }
  return status.enabled ? { label: '', kind: 'none' } : { label: 'Enable', kind: 'enable' };
}

/** The bytes one version weighs, for the card's footer line. Zero when the catalogue has none. */
function versionBytes(entry: ExtensionEntry | undefined, version: string | null): number {
  const found = entry?.versions.find((v) => v.version === version) ?? entry?.versions[0];
  return (found?.files ?? []).reduce((n, f) => n + f.bytes, 0);
}

export function ExtensionsDialog({
  catalogue,
  statuses,
  progress,
  dir,
  onInstall,
  onCancel,
  onEnable,
  onDisable,
  onRemove,
  onRevealDir,
  onClose,
}: ExtensionsDialogProps): React.JSX.Element {
  // The sheet's subject, or null. Local state rather than a store field: it is a step *inside* one
  // gesture — install, then answer — and nothing outside this component can be mid-way through it.
  const [consentId, setConsentId] = useState<string | null>(null);
  const entryOf = (id: string): ExtensionEntry | undefined => catalogue.find((c) => c.id === id);

  const consentStatus =
    consentId === null ? null : (statuses.find((s) => s.id === consentId) ?? null);
  if (consentId !== null && consentStatus !== null) {
    const entry = entryOf(consentId);
    return (
      <DialogFrame
        testId={`extension-consent-${consentId}`}
        title={`Enable ${consentStatus.title}?`}
        subtitle="An enabled extension runs as part of Tetravox, with the same access to your files as the app itself. Enable one only if you trust where it came from."
        width="34rem"
        onCancel={() => setConsentId(null)}
        footer={
          <>
            <button
              type="button"
              data-testid="extension-consent-cancel"
              className="tvx-btn ml-auto"
              onClick={() => setConsentId(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="extension-consent-accept"
              className="tvx-btn tvx-btn-on"
              onClick={() => {
                const id = consentId;
                setConsentId(null);
                void onEnable(id);
              }}
            >
              Enable
            </button>
          </>
        }
      >
        <dl className="mb-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-tvx-dim">Extension</dt>
          <dd data-testid="extension-consent-id" className="font-mono">
            {consentId}
          </dd>
          <dt className="text-tvx-dim">Version</dt>
          <dd data-testid="extension-consent-version" className="font-mono">
            {consentStatus.installed ?? '—'}
          </dd>
          {entry?.repo !== undefined && (
            <>
              <dt className="text-tvx-dim">Source</dt>
              <dd>
                <a
                  data-testid="extension-consent-repo"
                  href={entry.repo}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted hover:text-tvx-text"
                >
                  {entry.repo}
                </a>
              </dd>
            </>
          )}
        </dl>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
          It will be able to
        </h3>
        {/* Derived from the manifest by main, never declared separately — the card and the sheet
            cannot disagree with what the module actually asked for, because there is one list. The
            empty-list line is phrased as what the manifest *declared* rather than as an absolute
            "it can do nothing", so it stays truthful for every manifest `derivePermissions` covers
            (readers, siblings, writers, keys, operations, sceneBlock) and cannot outrun a capability
            the list forgot to enumerate. */}
        <ul data-testid="extension-consent-permissions" className="ml-4 list-disc text-[11px]">
          {consentStatus.permissions.length === 0 ? (
            <li className="text-tvx-dim">
              nothing beyond drawing in its own panel — it declares no file, key, or job access
            </li>
          ) : (
            consentStatus.permissions.map((line) => (
              <li key={line} className="leading-snug">
                {line}
              </li>
            ))
          )}
        </ul>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame
      testId="extensions-dialog"
      title="Extensions"
      subtitle="Tools that are downloaded, never built in. An enabled extension runs inside Tetravox with the app's own access to your files, so each one is enabled by hand, once, after you have read what it asks for."
      width="56rem"
      onCancel={onClose}
      footer={
        <>
          <span
            data-testid="extension-dir"
            className="mr-auto max-w-[26rem] truncate font-mono text-[10px] text-tvx-dim"
            title={dir}
          >
            {dir === '' ? '' : `Installed in: ${dir}`}
          </span>
          <button
            type="button"
            data-testid="extension-reveal-dir"
            className="tvx-btn tvx-btn-sm"
            disabled={dir === ''}
            onClick={onRevealDir}
          >
            Show folder
          </button>
          <button
            type="button"
            data-testid="extensions-close"
            className="tvx-btn"
            onClick={onClose}
          >
            Close
          </button>
        </>
      }
    >
      {statuses.length === 0 ? (
        // An empty catalogue is a correct answer, not a failure: the shipped index may carry nothing
        // yet, and the app is offline-correct by construction (`module-store.ts#catalogue`).
        <p data-testid="extensions-empty" className="py-6 text-center text-[12px] text-tvx-dim">
          Nothing to show. No extensions are installed and this build's catalogue is empty.
        </p>
      ) : (
        <ul className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
          {statuses.map((status) => {
            const entry = entryOf(status.id);
            const p = progress[status.id];
            const busy = p !== undefined && (p.state === 'downloading' || p.state === 'verifying');
            const failed = p !== undefined && p.state === 'error';
            const pct =
              p !== undefined && p.total > 0 ? Math.round((100 * p.received) / p.total) : 0;
            const action = primaryAction(status);
            const bytes = versionBytes(entry, status.installed ?? status.available);
            return (
              <li
                key={status.id}
                data-testid={`extension-card-${status.id}`}
                data-state={
                  status.incompatible !== undefined
                    ? 'incompatible'
                    : status.enabled
                      ? 'enabled'
                      : status.installed !== null
                        ? 'installed'
                        : 'available'
                }
                // The one visual state that is not a button: a module this build cannot run is
                // greyed rather than hidden, because "needs a newer Tetravox" is the answer the user
                // needs and an absent card is not an answer at all.
                className={
                  status.incompatible !== undefined
                    ? 'flex flex-col gap-1 rounded-md border border-tvx-line bg-tvx-panel p-2.5 opacity-50'
                    : 'flex flex-col gap-1 rounded-md border border-tvx-line bg-tvx-panel p-2.5'
                }
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold leading-tight">{status.title}</span>
                  <span className="font-mono text-[10px] text-tvx-dim">
                    {status.installed ?? status.available ?? ''}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-tvx-dim">
                  {entry?.summary ??
                    (status.installed === null ? '' : 'Installed on this machine.')}
                </p>
                <div className="flex flex-wrap items-center gap-x-2 pt-0.5 text-[10px] text-tvx-dim">
                  <span className="font-mono">{status.id}</span>
                  {bytes > 0 && (
                    <>
                      <span>·</span>
                      <span>{formatBytes(bytes)}</span>
                    </>
                  )}
                  {entry?.licence !== undefined && (
                    <>
                      <span>·</span>
                      <span>{entry.licence}</span>
                    </>
                  )}
                  {entry?.repo !== undefined && (
                    <>
                      <span>·</span>
                      <a
                        href={entry.repo}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-dotted hover:text-tvx-text"
                      >
                        source
                      </a>
                    </>
                  )}
                </div>
                {status.incompatible !== undefined && (
                  <span
                    data-testid={`extension-incompatible-${status.id}`}
                    className="pt-1 text-[10px] text-tvx-dim"
                  >
                    {status.incompatible}
                  </span>
                )}
                {busy ? (
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
                    <span className="w-9 text-right font-mono text-[10px] text-tvx-dim">
                      {p.state === 'verifying' ? '…' : `${pct}%`}
                    </span>
                    <button
                      type="button"
                      className="tvx-btn tvx-btn-sm"
                      data-testid={`extension-cancel-${status.id}`}
                      onClick={() => onCancel(status.id)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {status.enabled && (
                      <span
                        data-testid={`extension-enabled-${status.id}`}
                        className="text-[11px] text-tvx-accent-strong"
                      >
                        Enabled ✓
                      </span>
                    )}
                    {action.kind !== 'none' && (
                      <button
                        type="button"
                        className="tvx-btn tvx-btn-sm"
                        data-testid={
                          action.kind === 'enable'
                            ? `extension-enable-${status.id}`
                            : `extension-install-${status.id}`
                        }
                        onClick={() => {
                          if (action.kind === 'enable') {
                            setConsentId(status.id);
                            return;
                          }
                          // Install, then the sheet — never one gesture. The files land inert and the
                          // next click is the consent that admits them.
                          void onInstall(status.id, status.available ?? undefined).then((ok) => {
                            if (ok) setConsentId(status.id);
                          });
                        }}
                      >
                        {action.label}
                      </button>
                    )}
                    {status.enabled && (
                      <button
                        type="button"
                        className="tvx-btn tvx-btn-sm"
                        data-testid={`extension-disable-${status.id}`}
                        title="Withdraw consent: it stops running and its files stop being reachable."
                        onClick={() => onDisable(status.id)}
                      >
                        Disable
                      </button>
                    )}
                    {status.installed !== null && (
                      <button
                        type="button"
                        className="tvx-btn tvx-btn-sm"
                        data-testid={`extension-remove-${status.id}`}
                        title="Disable it and delete its files from this machine."
                        onClick={() => onRemove(status.id)}
                      >
                        Remove
                      </button>
                    )}
                    {failed && (
                      <span
                        className="truncate text-[10px] text-tvx-danger"
                        title={p.error}
                        data-testid={`extension-error-${status.id}`}
                      >
                        {p.error ?? 'install failed'}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DialogFrame>
  );
}
