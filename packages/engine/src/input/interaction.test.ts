/**
 * §7.2's `interacting` flag and the adaptive-quality hook (P2-02), on an injected clock.
 *
 * The two behaviours worth pinning are the ones Phase 1 left as a declared-and-never-assigned field:
 * *entered once, not once per event*, and *left exactly once, `settleMs` after the **last** input* —
 * because "leaving it triggers exactly one full-quality re-render" is only true if leaving happens
 * once.
 */

import { describe, expect, it } from 'vitest';
import {
  adaptiveLevel,
  median,
  InteractionState,
  DEFAULT_SETTLE_MS,
  FRAME_BUDGET_MS_60HZ,
  FRAME_WINDOW,
  QUALITY_LEVELS,
} from './interaction';

/** A clock a test can advance by hand: one pending timeout at a time is all the state machine uses. */
class FakeClock {
  #next = 1;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();
  now = 0;

  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#pending.set(id, { at: this.now + ms, fn });
    return id;
  };

  readonly clear = (handle: unknown): void => {
    this.#pending.delete(handle as number);
  };

  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.#pending]) {
      if (t.at <= this.now) {
        this.#pending.delete(id);
        t.fn();
      }
    }
  }
}

function stateWith(clock: FakeClock, settleMs?: number): { s: InteractionState; log: boolean[] } {
  const log: boolean[] = [];
  const s = new InteractionState({
    settleMs,
    onChange: (on) => log.push(on),
    setTimeout: clock.set,
    clearTimeout: clock.clear,
  });
  return { s, log };
}

describe('InteractionState (§7.2)', () => {
  it('enters on the first input and reports it once, not once per event', () => {
    const clock = new FakeClock();
    const { s, log } = stateWith(clock);
    expect(s.interacting).toBe(false);
    s.note();
    s.note();
    s.note();
    expect(s.interacting).toBe(true);
    expect(log).toEqual([true]);
  });

  it('leaves settleMs after the LAST input, exactly once', () => {
    const clock = new FakeClock();
    const { s, log } = stateWith(clock);
    s.note();
    clock.advance(100);
    expect(s.interacting).toBe(true);
    // A drag that is still going re-arms the timer rather than letting it fire.
    s.note();
    clock.advance(100);
    expect(s.interacting).toBe(true);
    clock.advance(DEFAULT_SETTLE_MS);
    expect(s.interacting).toBe(false);
    expect(log).toEqual([true, false]);
    // And it stays left: no second `false`.
    clock.advance(10_000);
    expect(log).toEqual([true, false]);
  });

  it('defaults to §7.2’s 120 ms and takes an override', () => {
    expect(DEFAULT_SETTLE_MS).toBe(120);
    const clock = new FakeClock();
    const { s } = stateWith(clock, 40);
    expect(s.settleMs).toBe(40);
    s.note();
    clock.advance(39);
    expect(s.interacting).toBe(true);
    clock.advance(1);
    expect(s.interacting).toBe(false);
  });

  it('cancel() drops the flag now and cannot fire again afterwards', () => {
    const clock = new FakeClock();
    const { s, log } = stateWith(clock);
    s.note();
    s.cancel();
    expect(s.interacting).toBe(false);
    expect(log).toEqual([true, false]);
    clock.advance(10_000);
    expect(log).toEqual([true, false]);
  });
});

describe('the quality ladder (§7.2, §4.5)', () => {
  it('never names a knob that changes displayed VALUES', () => {
    // §7.2: "Forbidden in the fallback set: any knob that changes displayed *values* rather than
    // displayed *resolution*." `interpolation` is a reading — a `QualityLevel` has no field for it,
    // which is the cheapest possible enforcement, and this test is what says so out loud.
    for (const level of Object.values(QUALITY_LEVELS)) {
      expect(Object.keys(level).sort()).toEqual(
        ['capDecimation', 'dprScale', 'edges', 'msaa', 'name', 'oit'].sort()
      );
    }
  });

  it('is §7.2’s interacting level verbatim', () => {
    expect(QUALITY_LEVELS.interacting).toMatchObject({ dprScale: 1, msaa: 0, edges: false });
    expect(QUALITY_LEVELS.interacting.capDecimation).toBeGreaterThan(1);
    expect(QUALITY_LEVELS.full).toEqual({
      name: 'full',
      dprScale: 1,
      msaa: 4,
      edges: true,
      capDecimation: 1,
      oit: false,
    });
  });
});

describe('adaptiveLevel (§7.2 automatic degradation)', () => {
  const fill = (v: number): number[] => new Array(FRAME_WINDOW).fill(v) as number[];

  it('says nothing until it has a full window of frames', () => {
    expect(adaptiveLevel(new Array(FRAME_WINDOW - 1).fill(100) as number[], 'full')).toBeNull();
  });

  it('drops a level when the median exceeds the budget', () => {
    expect(adaptiveLevel(fill(FRAME_BUDGET_MS_60HZ + 1), 'full')).toBe('reduced');
    // Already degraded: no further drop is defined, and it must not oscillate.
    expect(adaptiveLevel(fill(FRAME_BUDGET_MS_60HZ + 1), 'reduced')).toBeNull();
  });

  it('recovers only well below the budget — hysteresis, not a coin toss at the line', () => {
    expect(adaptiveLevel(fill(FRAME_BUDGET_MS_60HZ * 0.9), 'reduced')).toBeNull();
    expect(adaptiveLevel(fill(FRAME_BUDGET_MS_60HZ * 0.5), 'reduced')).toBe('full');
    expect(adaptiveLevel(fill(FRAME_BUDGET_MS_60HZ * 0.5), 'full')).toBeNull();
  });

  it('reads the median, so a single stall does not degrade the whole session', () => {
    const times = fill(1);
    times[0] = 10_000;
    expect(adaptiveLevel(times, 'full')).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
