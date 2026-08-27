/**
 * Load-card state (§8: "per-dataset **load card** with phase + percent + elapsed + Cancel").
 *
 * A pure reducer, because the interesting part is a race: `Engine.addDataset(src)` resolves with a
 * `Dataset` only at the *end*, while `EngineEvents.progress` carries the `datasetId` from the first
 * phase — so the card exists before it knows its own id, and Cancel can be pressed in that window.
 * `requestCancel` therefore records the intent and `bindDataset` is what lets the caller finally issue
 * `Engine.cancelDataset(id)` (= `worker.terminate()`, §5 rule 6).
 *
 * Loads are run **one at a time** (see `store/controller.ts`): with worker-per-dataset, two 492 MB
 * meshes in flight is two wasm heaps at once (§9.2), and sequential loading is also what makes the
 * "this progress event belongs to the one unbound card" rule unambiguous.
 */

import type { DatasetId, LoadPhase } from '@tetravox/engine';

export type LoadState = 'queued' | 'loading' | 'done' | 'cancelled' | 'failed';

/** The §6.5 phases, in the order a load walks them — the card's progress spine. */
export const PHASES: readonly LoadPhase[] = [
  'read',
  'inflate',
  'parse',
  'topology',
  'index',
  'upload',
] as const;

export interface LoadCard {
  /** Monotonic, app-side. The card's identity before a `DatasetId` exists. */
  ticket: number;
  name: string;
  path: string | null;
  datasetId: DatasetId | null;
  state: LoadState;
  phase: LoadPhase;
  done: number;
  total: number;
  startedAt: number;
  endedAt: number | null;
  /** Set when Cancel was pressed before the card knew its `datasetId`. */
  cancelRequested: boolean;
  message: string | null;
}

export function newCard(ticket: number, name: string, path: string | null, now: number): LoadCard {
  return {
    ticket,
    name,
    path,
    datasetId: null,
    state: 'queued',
    phase: 'read',
    done: 0,
    total: 0,
    startedAt: now,
    endedAt: null,
    cancelRequested: false,
    message: null,
  };
}

function patch(cards: readonly LoadCard[], ticket: number, next: Partial<LoadCard>): LoadCard[] {
  return cards.map((c) => (c.ticket === ticket ? { ...c, ...next } : c));
}

/** The card moves from `queued` to `loading` when its turn in the queue comes up. */
export function startCard(cards: readonly LoadCard[], ticket: number, now: number): LoadCard[] {
  return patch(cards, ticket, { state: 'loading', startedAt: now });
}

/** Bind the id the first `progress` event revealed. */
export function bindDataset(
  cards: readonly LoadCard[],
  ticket: number,
  datasetId: DatasetId
): LoadCard[] {
  return patch(cards, ticket, { datasetId });
}

export function applyProgress(
  cards: readonly LoadCard[],
  ticket: number,
  progress: { phase: LoadPhase; done: number; total: number; datasetId: DatasetId }
): LoadCard[] {
  return patch(cards, ticket, {
    datasetId: progress.datasetId,
    phase: progress.phase,
    done: progress.done,
    total: progress.total,
    state: 'loading',
  });
}

export function finishCard(
  cards: readonly LoadCard[],
  ticket: number,
  datasetId: DatasetId,
  now: number
): LoadCard[] {
  return patch(cards, ticket, { state: 'done', datasetId, endedAt: now, done: 1, total: 1 });
}

export function failCard(
  cards: readonly LoadCard[],
  ticket: number,
  message: string,
  now: number,
  cancelled = false
): LoadCard[] {
  return patch(cards, ticket, {
    state: cancelled ? 'cancelled' : 'failed',
    endedAt: now,
    message,
  });
}

export function requestCancel(cards: readonly LoadCard[], ticket: number): LoadCard[] {
  return patch(cards, ticket, { cancelRequested: true });
}

export function dismissCard(cards: readonly LoadCard[], ticket: number): LoadCard[] {
  return cards.filter((c) => c.ticket !== ticket);
}

/** Finished cards linger briefly so the last load time is readable, then go (§8). */
export const CARD_TTL_MS = 6000;

export function pruneCards(
  cards: readonly LoadCard[],
  now: number,
  ttlMs = CARD_TTL_MS
): LoadCard[] {
  return cards.filter((c) => c.endedAt === null || c.state === 'failed' || now - c.endedAt < ttlMs);
}

/** 0..1. `total === 0` means the phase reports no denominator yet, which reads as 0 %, not NaN. */
export function cardFraction(card: LoadCard): number {
  if (card.state === 'done') return 1;
  if (card.total <= 0) return 0;
  return Math.max(0, Math.min(1, card.done / card.total));
}

export function cardPercent(card: LoadCard): number {
  return Math.round(cardFraction(card) * 100);
}

export function cardElapsedMs(card: LoadCard, now: number): number {
  return Math.max(0, (card.endedAt ?? now) - card.startedAt);
}

export function isActive(card: LoadCard): boolean {
  return card.state === 'queued' || card.state === 'loading';
}
