/**
 * §8 load cards: "per-dataset **load card** with phase + percent + elapsed + Cancel".
 *
 * Cancel is `Engine.cancelDataset(id)`, which is `worker.terminate()` (§5 rule 6) — there is no abort
 * flag to poll, because the app is not cross-origin isolated and `SharedArrayBuffer` does not exist
 * (§1). ROADMAP Phase-1 gate 1 gives it 500 ms; a terminate is immediate, and the card says
 * `cancelled` as soon as the rejection lands.
 */

import { cardElapsedMs, cardPercent, isActive } from '../lib/loads';
import type { LoadCard } from '../lib/loads';
import { formatDuration } from '../lib/metrics';
import { useController, useUi } from './context';

const STATE_LABEL: Record<LoadCard['state'], string> = {
  queued: 'queued',
  loading: 'loading',
  done: 'loaded',
  cancelled: 'cancelled',
  failed: 'failed',
};

function Card({ card, now }: { card: LoadCard; now: number }): React.JSX.Element {
  const controller = useController();
  const percent = cardPercent(card);
  const elapsed = cardElapsedMs(card, now);
  const active = isActive(card);
  return (
    <li
      data-testid={`load-card-${card.ticket}`}
      data-state={card.state}
      data-phase={card.phase}
      className="rounded border border-tvx-line bg-tvx-bg/60 px-2 py-1.5"
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate text-xs text-tvx-text" title={card.path ?? card.name}>
          {card.name}
        </span>
        <span
          data-testid="load-elapsed"
          className="ml-auto shrink-0 font-mono text-[10px] text-tvx-dim"
        >
          {formatDuration(elapsed)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span data-testid="load-phase" className="w-16 shrink-0 font-mono text-[10px] text-tvx-dim">
          {active ? card.phase : STATE_LABEL[card.state]}
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded bg-tvx-line">
          <div
            data-testid="load-bar"
            className={
              card.state === 'failed'
                ? 'h-full bg-tvx-danger'
                : card.state === 'cancelled'
                  ? 'h-full bg-tvx-dim'
                  : 'h-full bg-tvx-accent'
            }
            style={{ width: `${percent}%` }}
          />
        </div>
        <span
          data-testid="load-percent"
          className="w-9 shrink-0 text-right font-mono text-[10px] text-tvx-dim"
        >
          {percent}%
        </span>
        {active ? (
          <button
            type="button"
            data-testid="load-cancel"
            className="tvx-btn tvx-btn-sm"
            onClick={() => controller.cancelLoad(card.ticket)}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            data-testid="load-dismiss"
            className="tvx-btn tvx-btn-sm"
            onClick={() => controller.dismissLoad(card.ticket)}
          >
            Dismiss
          </button>
        )}
      </div>
      {card.message !== null && (
        <p data-testid="load-message" className="mt-1 text-[10px] text-tvx-danger">
          {card.message}
        </p>
      )}
    </li>
  );
}

export function LoadCards(): React.JSX.Element | null {
  const cards = useUi((s) => s.loads);
  // `tick` is the 1 Hz heartbeat; reading it is what keeps "elapsed" moving while a load runs.
  const tick = useUi((s) => s.tick);
  if (cards.length === 0) return null;
  const now = performance.now();
  void tick;
  return (
    <ul data-testid="load-cards" className="flex flex-col gap-1 border-b border-tvx-line p-2">
      {cards.map((card) => (
        <Card key={card.ticket} card={card} now={now} />
      ))}
    </ul>
  );
}
