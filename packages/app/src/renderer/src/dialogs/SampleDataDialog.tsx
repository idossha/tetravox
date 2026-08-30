/**
 * File ▸ Sample Data… (§8): the catalogue as a grid of cards, one per sample, grouped.
 *
 * Every card is a thumbnail, a title, one line of description, the size and the licence, and a
 * single button that says the true state — **Download & open**, **Open** (already in the cache), or
 * a progress bar with **Cancel** while a download runs. Nothing here touches the network or the
 * disk: the controller asks main (`main/sample-data.ts`) and main pushes the paths through the same
 * `onOpened` the Open dialog uses, so an opened sample is indistinguishable from an opened file.
 */

import type { Sample, SampleProgress, SampleStatus } from '../../../preload/index';
import { DialogFrame } from './dialog';

const THUMBS = import.meta.glob<string>('../assets/samples/*.jpg', {
  eager: true,
  query: '?url',
  import: 'default',
});

function thumbUrl(key: string): string | undefined {
  return THUMBS[`../assets/samples/${key}.jpg`];
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} kB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export interface SampleDataDialogProps {
  samples: readonly Sample[];
  statuses: readonly SampleStatus[];
  /** In-flight downloads by sample id. */
  progress: Readonly<Record<string, SampleProgress>>;
  cacheDir: string;
  onOpen(id: string): void;
  onCancel(id: string): void;
  onRemove(id: string): void;
  onRevealCache(): void;
  onClose(): void;
}

export function SampleDataDialog({
  samples,
  statuses,
  progress,
  cacheDir,
  onOpen,
  onCancel,
  onRemove,
  onRevealCache,
  onClose,
}: SampleDataDialogProps): React.JSX.Element {
  const groups: string[] = [];
  for (const s of samples) if (!groups.includes(s.group)) groups.push(s.group);
  const statusOf = (id: string): SampleStatus | undefined => statuses.find((s) => s.id === id);

  return (
    <DialogFrame
      testId="sample-data-dialog"
      title="Sample data"
      subtitle="Public datasets, downloaded once into this machine's cache and opened like any other file."
      width="56rem"
      onCancel={onClose}
      footer={
        <>
          <span
            data-testid="sample-cache-dir"
            className="mr-auto max-w-[26rem] truncate font-mono text-[10px] text-tvx-dim"
            title={cacheDir}
          >
            {cacheDir === '' ? '' : `Cache: ${cacheDir}`}
          </span>
          <button
            type="button"
            data-testid="sample-reveal-cache"
            className="tvx-btn tvx-btn-sm"
            disabled={cacheDir === ''}
            onClick={onRevealCache}
          >
            Show cache
          </button>
          <button type="button" data-testid="sample-close" className="tvx-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
        {groups.map((group) => (
          <section key={group} data-testid={`sample-group-${group}`}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
              {group}
            </h3>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {samples
                .filter((s) => s.group === group)
                .map((s) => {
                  const st = statusOf(s.id);
                  const p = progress[s.id];
                  const busy =
                    p !== undefined && (p.state === 'downloading' || p.state === 'verifying');
                  const failed = p !== undefined && p.state === 'error';
                  const pct =
                    p !== undefined && p.total > 0 ? Math.round((100 * p.received) / p.total) : 0;
                  const thumb = thumbUrl(s.thumbnail);
                  return (
                    <li
                      key={s.id}
                      data-testid={`sample-card-${s.id}`}
                      className="flex flex-col overflow-hidden rounded-md border border-tvx-line bg-tvx-panel"
                    >
                      {thumb !== undefined ? (
                        <img
                          src={thumb}
                          alt=""
                          className="aspect-[4/3] w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="aspect-[4/3] w-full bg-black" />
                      )}
                      <div className="flex flex-1 flex-col gap-1 p-2.5">
                        <div className="text-[13px] font-semibold leading-tight">{s.title}</div>
                        <p className="text-[11px] leading-snug text-tvx-dim">{s.description}</p>
                        <div className="mt-auto flex flex-wrap items-center gap-x-2 pt-1 text-[10px] text-tvx-dim">
                          <span>{formatBytes(st?.bytes ?? 0)}</span>
                          <span>·</span>
                          <a
                            href={s.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-dotted hover:text-tvx-text"
                            title={s.source}
                          >
                            {s.source}
                          </a>
                          <span>·</span>
                          <span>{s.licence}</span>
                        </div>
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
                              data-testid={`sample-cancel-${s.id}`}
                              onClick={() => onCancel(s.id)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              className="tvx-btn tvx-btn-sm"
                              data-testid={`sample-open-${s.id}`}
                              onClick={() => onOpen(s.id)}
                            >
                              {st?.cached === true ? 'Open' : 'Download & open'}
                            </button>
                            {st?.cached === true && (
                              <button
                                type="button"
                                className="tvx-btn tvx-btn-sm"
                                data-testid={`sample-remove-${s.id}`}
                                title="Delete the downloaded files from the cache"
                                onClick={() => onRemove(s.id)}
                              >
                                Remove
                              </button>
                            )}
                            {failed && (
                              <span
                                className="truncate text-[10px] text-tvx-danger"
                                title={p.error}
                                data-testid={`sample-error-${s.id}`}
                              >
                                {p.error ?? 'download failed'}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      </div>
    </DialogFrame>
  );
}
