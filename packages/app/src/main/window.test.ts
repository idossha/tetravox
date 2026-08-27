/**
 * `windowMode` decides whether a launch is allowed to put a window on the user's screen, so the two
 * clauses worth locking down are the ones a future edit would get wrong: a **user** launch is
 * untouched, and `TETRAVOX_E2E_HEADED` **outranks** `TETRAVOX_E2E_OFFSCREEN` — one variable has to
 * turn the windows back on for every leg, including a leg that sets the offscreen variable itself.
 */

import { describe, expect, it } from 'vitest';
import { windowMode } from './window';

describe('windowMode (AGENTS rule 9)', () => {
  it('a user launch sets neither variable and gets a normal, shown window', () => {
    expect(windowMode({})).toBe('normal');
  });

  it('TETRAVOX_E2E_OFFSCREEN=1 suppresses the window', () => {
    expect(windowMode({ TETRAVOX_E2E_OFFSCREEN: '1' })).toBe('offscreen');
  });

  it('TETRAVOX_E2E_HEADED=1 wins over it — the debugging opt-in is not overridable', () => {
    expect(windowMode({ TETRAVOX_E2E_OFFSCREEN: '1', TETRAVOX_E2E_HEADED: '1' })).toBe('normal');
  });

  it('only the exact string "1" counts, so an inherited "0" or "" cannot hide the window', () => {
    expect(windowMode({ TETRAVOX_E2E_OFFSCREEN: '0' })).toBe('normal');
    expect(windowMode({ TETRAVOX_E2E_OFFSCREEN: '' })).toBe('normal');
    expect(windowMode({ TETRAVOX_E2E_OFFSCREEN: 'true' })).toBe('normal');
    // …and equally, a stray `TETRAVOX_E2E_HEADED=0` does not re-show a windowless run.
    expect(windowMode({ TETRAVOX_E2E_OFFSCREEN: '1', TETRAVOX_E2E_HEADED: '0' })).toBe('offscreen');
  });
});
