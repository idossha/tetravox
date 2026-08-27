/**
 * The relocate dialog (§8: "a missing dataset opens a 'relocate' dialog").
 *
 * It is the app's half of `Engine.load(spec, resolve)` (§4.7): the engine calls `resolve(ref)` for
 * every `DatasetRef` and takes `null` to mean "skip". The controller tries §4.6's candidates first —
 * the path relative to the scene file, then `absPath`, then the basename beside the scene — and only
 * what none of them found reaches this dialog. So a scene copied together with its data never opens
 * it, and a scene that moved alone opens it with the reason on screen.
 *
 * **What the fingerprint column can and cannot say today.** §4.6 defines `fingerprint` as
 * `"<size>-<sha256 of first 1 MiB>-<sha256 of last 1 MiB>"`, and `docs/PHASE2-OWNERSHIP.md` records
 * that it has **no producer** — it is W-WASM's Gap 1, because §5 rule 3 forbids digesting file bytes
 * on the UI thread and neither `VolumeMeta` nor `MeshMeta` carries the field. So this column shows
 * the fingerprint the scene *recorded* and says plainly that it cannot be checked yet, rather than
 * showing a green tick that means nothing. When W-WASM lands it, the comparison is one string
 * equality here and the three states below become `match` / `differs` / `unrecorded`.
 */

import { useCallback, useState } from 'react';
import type { DatasetRef } from '@tetravox/engine';
import { DialogFrame } from './dialog';

export type FingerprintState = 'unrecorded' | 'unverified' | 'match' | 'differs';

export interface MissingDataset {
  ref: DatasetRef;
  /** The paths the controller tried, in order, so the user is told what was looked for. */
  tried: readonly string[];
  /** The replacement the user picked, or `null` while it is still missing. */
  picked: string | null;
}

export interface RelocateDialogProps {
  /** The datasets `Engine.load`'s `resolve` could not find. */
  missing: readonly MissingDataset[];
  /** Opens the OS picker for one ref and returns the chosen path, or null when cancelled. */
  pick(ref: DatasetRef): Promise<string | null>;
  /** Resolves with one path per ref, `null` for the ones the user chose to skip. */
  onResolved(paths: readonly (string | null)[]): void;
  onCancel(): void;
}

/** Today's honest verdict: recorded but not checkable (W-WASM Gap 1), or not recorded at all. */
export function fingerprintState(ref: DatasetRef): FingerprintState {
  return ref.fingerprint === '' || /^0+$/.test(ref.fingerprint) ? 'unrecorded' : 'unverified';
}

const FINGERPRINT_TEXT: Record<FingerprintState, string> = {
  unrecorded: 'no fingerprint recorded',
  unverified: 'fingerprint recorded, not yet checkable',
  match: 'fingerprint matches',
  differs: 'fingerprint differs — this is a different file',
};

export function RelocateDialog({
  missing,
  pick,
  onResolved,
  onCancel,
}: RelocateDialogProps): React.JSX.Element {
  const [picked, setPicked] = useState<(string | null)[]>(() => missing.map((m) => m.picked));

  const choose = useCallback(
    async (index: number) => {
      const entry = missing[index];
      if (entry === undefined) return;
      const path = await pick(entry.ref);
      if (path === null) return;
      setPicked((current) => current.map((value, i) => (i === index ? path : value)));
    },
    [missing, pick]
  );

  const resolvedCount = picked.filter((p) => p !== null).length;

  return (
    <DialogFrame
      testId="relocate-dialog"
      title="Some of this scene’s files are missing"
      subtitle="§4.6: paths are stored relative to the scene file, with an absolute fallback. Point at the ones that moved, or skip them."
      width="44rem"
      onCancel={onCancel}
      footer={
        <>
          <span data-testid="relocate-summary" className="text-[10px] text-tvx-dim">
            {resolvedCount} of {missing.length} located
          </span>
          <button
            type="button"
            data-testid="relocate-cancel"
            className="tvx-btn ml-auto"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="relocate-skip-all"
            className="tvx-btn"
            onClick={() => onResolved(missing.map(() => null))}
          >
            Open without them
          </button>
          <button
            type="button"
            data-testid="relocate-confirm"
            className="tvx-btn tvx-btn-on"
            disabled={resolvedCount === 0}
            onClick={() => onResolved(picked)}
          >
            Open scene
          </button>
        </>
      }
    >
      <ul className="flex flex-col gap-2">
        {missing.map((entry, index) => {
          const state = fingerprintState(entry.ref);
          const chosen = picked[index] ?? null;
          return (
            <li
              key={entry.ref.id}
              data-testid={`relocate-row-${entry.ref.id}`}
              data-resolved={chosen !== null}
              className="rounded border border-tvx-line bg-tvx-bg/40 px-3 py-2"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] text-tvx-text">{entry.ref.name}</span>
                <span className="font-mono text-[10px] uppercase text-tvx-dim">
                  {entry.ref.kind}
                </span>
                <button
                  type="button"
                  data-testid={`relocate-pick-${entry.ref.id}`}
                  className="tvx-btn tvx-btn-sm ml-auto"
                  onClick={() => void choose(index)}
                >
                  {chosen === null ? 'Locate…' : 'Change…'}
                </button>
                <button
                  type="button"
                  data-testid={`relocate-skip-${entry.ref.id}`}
                  className="tvx-btn tvx-btn-sm"
                  onClick={() =>
                    setPicked((current) => current.map((v, i) => (i === index ? null : v)))
                  }
                >
                  Skip
                </button>
              </div>

              <dl className="mt-1 grid grid-cols-[5rem_1fr] gap-x-2 font-mono text-[10px] text-tvx-dim">
                <dt>recorded</dt>
                <dd data-testid={`relocate-recorded-${entry.ref.id}`} className="truncate">
                  {entry.ref.path}
                </dd>
                <dt>tried</dt>
                <dd data-testid={`relocate-tried-${entry.ref.id}`} className="break-all">
                  {entry.tried.length === 0 ? '—' : entry.tried.join(' · ')}
                </dd>
                <dt>fingerprint</dt>
                <dd data-testid={`relocate-fingerprint-${entry.ref.id}`}>
                  <span className={state === 'differs' ? 'text-tvx-danger' : ''}>
                    {FINGERPRINT_TEXT[state]}
                  </span>
                  {state !== 'unrecorded' && (
                    <span className="ml-1 text-tvx-dim/70">{entry.ref.fingerprint}</span>
                  )}
                </dd>
                {chosen !== null && (
                  <>
                    <dt className="text-tvx-accent">using</dt>
                    <dd
                      data-testid={`relocate-picked-${entry.ref.id}`}
                      className="break-all text-tvx-accent"
                    >
                      {chosen}
                    </dd>
                  </>
                )}
              </dl>
            </li>
          );
        })}
      </ul>
    </DialogFrame>
  );
}
