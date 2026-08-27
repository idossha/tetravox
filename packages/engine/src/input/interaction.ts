/**
 * §7.2's `interacting` state and the adaptive-quality hook — P2-02.
 *
 * Two separate things live here because they are two separate decisions that Phase 1 left as one
 * unassigned field:
 *
 * 1. **`interacting`** — entered on pointerdown / wheel / key-repeat / gizmo drag, left `settleMs`
 *    (120 ms) after the last input. It is a *fact about the user*, not about the frame rate, and it
 *    is what `whenSettled()` waits for.
 * 2. **Automatic degradation** — a fact about the frame rate: "when the median full-quality frame
 *    over the last 30 frames exceeds the budget, drop one `QualityLevel` … and **surface it in the
 *    status bar**. Never degrade silently."
 *
 * §7.2's hard rule about what a level may change: **"Forbidden in the fallback set: any knob that
 * changes displayed *values* rather than displayed *resolution*."** `interpolation` is a reading, so
 * no level below names it, and none ever will — a `QualityLevel` has no field for it, which is the
 * cheapest way to keep the rule.
 */

import type { QualityLevel } from '../scene/types';

/** §7.2: "left `settleMs` (default 120 ms) after the last input". */
export const DEFAULT_SETTLE_MS = 120;

/** §7.2's budget, stated per cadence: "≤ 8 ms at 60 Hz, ≤ 5 ms at 120 Hz". */
export const FRAME_BUDGET_MS_60HZ = 8;

/** §7.2: the median is taken "over the last 30 frames". */
export const FRAME_WINDOW = 30;

/**
 * The three §4.5 levels.
 *
 * `full` is `scene/defaults.ts`'s, repeated rather than imported so that a Phase-3 agent changing a
 * knob here cannot silently move the default scene (and every golden with it).
 */
export const QUALITY_LEVELS: Record<QualityLevel['name'], QualityLevel> = {
  full: { name: 'full', dprScale: 1, msaa: 4, edges: true, capDecimation: 1, oit: false },
  // §7.2 verbatim: `dprScale 1`, `msaa 0`, `edges false`, `capDecimation` per §9.
  interacting: {
    name: 'interacting',
    dprScale: 1,
    msaa: 0,
    edges: false,
    capDecimation: 4,
    oit: false,
  },
  reduced: { name: 'reduced', dprScale: 1, msaa: 0, edges: false, capDecimation: 8, oit: false },
};

/** Median of a sample, without sorting the caller's array. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * The level the last 30 full-quality frames argue for, or `null` for "leave it where it is".
 *
 * Degrade at the budget, recover at 60 % of it. The hysteresis is not decoration: at exactly the
 * budget a degrade/recover pair each move the median across the line, and a viewer that flips
 * `QualityLevel` every 30 frames flickers `edges` on and off in the user's face — and, per §7.2,
 * announces it in the status bar each time.
 */
export function adaptiveLevel(
  frameTimes: readonly number[],
  current: QualityLevel['name'],
  budgetMs: number = FRAME_BUDGET_MS_60HZ
): QualityLevel['name'] | null {
  if (frameTimes.length < FRAME_WINDOW) return null;
  const m = median(frameTimes.slice(-FRAME_WINDOW));
  if (m > budgetMs && current === 'full') return 'reduced';
  if (m < budgetMs * 0.6 && current === 'reduced') return 'full';
  return null;
}

export interface InteractionOptions {
  settleMs?: number;
  /** Called on every **change** of the flag, never on a re-arm. */
  onChange: (interacting: boolean) => void;
  /** Injected so a unit test can drive the clock; defaults to the real timers. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * The `interacting` flag and its settle timer.
 *
 * `note()` is called by every input the pointer layer sees. The first one raises the flag; each one
 * re-arms the timer. When the timer fires the flag drops and `onChange(false)` fires exactly once,
 * which is what §7.2 means by "leaving it triggers exactly one full-quality re-render".
 */
export class InteractionState {
  #interacting = false;
  #timer: unknown = null;
  readonly #settleMs: number;
  readonly #onChange: (interacting: boolean) => void;
  readonly #set: (fn: () => void, ms: number) => unknown;
  readonly #clear: (handle: unknown) => void;

  constructor(opts: InteractionOptions) {
    this.#settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
    this.#onChange = opts.onChange;
    this.#set = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clear = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get interacting(): boolean {
    return this.#interacting;
  }

  get settleMs(): number {
    return this.#settleMs;
  }

  /** An input happened: raise the flag if it is down, and re-arm the settle timer either way. */
  note(): void {
    if (this.#timer !== null) this.#clear(this.#timer);
    this.#timer = this.#set(() => {
      this.#timer = null;
      if (!this.#interacting) return;
      this.#interacting = false;
      this.#onChange(false);
    }, this.#settleMs);
    if (this.#interacting) return;
    this.#interacting = true;
    this.#onChange(true);
  }

  /** Drop the flag now, without waiting out the timer — `destroy()`, and nothing else. */
  cancel(): void {
    if (this.#timer !== null) this.#clear(this.#timer);
    this.#timer = null;
    if (!this.#interacting) return;
    this.#interacting = false;
    this.#onChange(false);
  }
}
