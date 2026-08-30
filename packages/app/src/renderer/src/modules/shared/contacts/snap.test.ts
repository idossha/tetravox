/**
 * Snap scoping (§13.4). The peak-finding itself is the engine's (`derived/voxel-box.ts`, with its
 * own numpy fixture); what is tested here is what a scope means and what a refusal does.
 */

import { describe, expect, it } from 'vitest';
import type { vec3 } from '@tetravox/engine';
import type { Contact, ContactSet } from './model';
import {
  applySnap,
  clampSnapRadius,
  SNAP_RADIUS_DEFAULT_MM,
  SNAP_RADIUS_MAX_MM,
  SNAP_RADIUS_MIN_MM,
  snapContacts,
} from './snap';
import { paletteColor } from './palette';

function contact(id: string, group: string, position: vec3): Contact {
  return {
    id,
    name: id,
    group,
    ordinal: 1,
    position,
    original: [...position] as vec3,
    originalName: id,
    loadedStatus: null,
    extra: {},
  };
}

const SET: ContactSet = {
  contacts: [
    contact('c1', 'A', [0, 0, 0]),
    contact('c2', 'A', [0, 0, 3.5]),
    contact('c3', 'B', [5, 0, 0]),
  ],
  groups: [
    { name: 'A', color: paletteColor(0), tip: 'auto' },
    { name: 'B', color: paletteColor(1), tip: 'auto' },
  ],
};

/** A blob 1 mm along +x of wherever it is asked, except above `z = 3` where there is nothing. */
const peak = (world: vec3): vec3 | null =>
  world[2] > 3 ? null : [world[0] + 1, world[1], world[2]];

describe('snapContacts', () => {
  it('moves only the contacts named, and reports the mean shift', () => {
    const result = snapContacts(SET, ['c1'], 1.5, peak);
    expect(result.moved).toBe(1);
    expect(result.meanShiftMm).toBeCloseTo(1, 12);
    expect(result.positions.get('c1')).toEqual([1, 0, 0]);
    expect(result.positions.has('c3')).toBe(false);
  });

  it('skips a contact the peak finder refuses, and does not count it', () => {
    // `c2` sits above z = 3, where the oracle answers null — "there is no metal here".
    const result = snapContacts(SET, ['c1', 'c2'], 1.5, peak);
    expect(result.moved).toBe(1);
    expect(result.positions.has('c2')).toBe(false);
  });

  it('is a pure result, so one scope is one undo step however many contacts it touched', () => {
    const result = snapContacts(SET, ['c1', 'c3'], 1.5, peak);
    // Nothing moved yet: the caller applies it, once.
    expect((SET.contacts[0] as Contact).position).toEqual([0, 0, 0]);
    const after = applySnap(SET, result);
    expect(after).not.toBe(SET);
    expect((after.contacts[0] as Contact).position).toEqual([1, 0, 0]);
    expect((after.contacts[2] as Contact).position).toEqual([6, 0, 0]);
    // …and the untouched contact is the very same object, so a re-render is cheap.
    expect(after.contacts[1]).toBe(SET.contacts[1]);
  });

  it('returns the same set when nothing moved', () => {
    const result = snapContacts(SET, ['c2'], 1.5, peak);
    expect(applySnap(SET, result)).toBe(SET);
  });
});

describe('clampSnapRadius', () => {
  it('holds the panel’s range and falls back to Slicer’s default', () => {
    expect(clampSnapRadius(0.1)).toBe(SNAP_RADIUS_MIN_MM);
    expect(clampSnapRadius(50)).toBe(SNAP_RADIUS_MAX_MM);
    expect(clampSnapRadius(Number.NaN)).toBe(SNAP_RADIUS_DEFAULT_MM);
    expect(clampSnapRadius(2.25)).toBe(2.25);
  });
});
