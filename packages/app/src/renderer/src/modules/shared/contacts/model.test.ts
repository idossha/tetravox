/**
 * The contact model's own rules (§13.4): what "moved" means, what `status` says, and how a name is
 * built. Each one is a defect the Slicer editor shipped, written down as a test.
 */

import { describe, expect, it } from 'vitest';
import type { vec3 } from '@tetravox/engine';
import type { Contact, ContactSet } from './model';
import {
  cloneSet,
  contactName,
  contactsOf,
  dirtyCount,
  emptySet,
  groupFromName,
  groupNames,
  groupOf,
  hasMoved,
  namePadOf,
  ordinalFromName,
  shiftMm,
  statusOf,
  wasRenamed,
} from './model';
import { paletteColor } from './palette';

function contact(partial: Partial<Contact> & Pick<Contact, 'id'>): Contact {
  const base = {
    name: 'A01',
    group: 'A',
    ordinal: 1,
    position: [0, 0, 0] as vec3,
    original: [0, 0, 0] as vec3 | null,
    loadedStatus: null,
    extra: {},
    ...partial,
  };
  // The loaded name is the name, unless a case says a relabel changed it.
  return { originalName: base.original === null ? null : base.name, ...base };
}

function setOf(...contacts: Contact[]): ContactSet {
  const names = [...new Set(contacts.map((c) => c.group))];
  return {
    contacts,
    groups: names.map((name, i) => ({ name, color: paletteColor(i), tip: 'auto' as const })),
  };
}

describe('hasMoved and statusOf', () => {
  it('uses Slicer’s L1 tolerance of 1e-3 mm', () => {
    // Exactly at the tolerance is NOT moved; the test is strictly greater, like Slicer's.
    expect(hasMoved(contact({ id: 'c1', position: [0.001, 0, 0] }))).toBe(false);
    expect(hasMoved(contact({ id: 'c1', position: [0.0011, 0, 0] }))).toBe(true);
    // L1, so three small components add up.
    expect(hasMoved(contact({ id: 'c1', position: [0.0004, 0.0004, 0.0004] }))).toBe(true);
  });

  it('is `added` with no original, `edited` once moved, `kept` otherwise', () => {
    expect(statusOf(contact({ id: 'c1', original: null }))).toBe('added');
    expect(statusOf(contact({ id: 'c1', position: [1, 0, 0] }))).toBe('edited');
    expect(statusOf(contact({ id: 'c1' }))).toBe('kept');
  });

  it('keeps a file’s own status on a contact that did not move, and drops it when it did', () => {
    expect(statusOf(contact({ id: 'c1', loadedStatus: 'gapfilled' }))).toBe('gapfilled');
    expect(statusOf(contact({ id: 'c1', loadedStatus: 'gapfilled', position: [1, 0, 0] }))).toBe(
      'edited'
    );
  });

  it('reports the Euclidean shift, and 0 for a contact with no original', () => {
    expect(shiftMm(contact({ id: 'c1', position: [3, 4, 0] }))).toBeCloseTo(5, 12);
    expect(shiftMm(contact({ id: 'c1', original: null, position: [3, 4, 0] }))).toBe(0);
  });
});

describe('names', () => {
  it('zero-pads to the width the file used — the LINS01 → LINS1 defect', () => {
    expect(contactName('LINS', 1, 2)).toBe('LINS01');
    expect(contactName('LINS', 14, 2)).toBe('LINS14');
    expect(contactName('LINS', 1, 1)).toBe('LINS1');
    expect(contactName('LINS', 123, 2)).toBe('LINS123');
  });

  it('recovers the widest padding a table uses, and defaults to 2', () => {
    expect(namePadOf(['LINS01', 'LINS14'])).toBe(2);
    expect(namePadOf(['A1', 'B2'])).toBe(1);
    expect(namePadOf(['A1', 'LINS001'])).toBe(3);
    expect(namePadOf(['tip', 'entry'])).toBe(2);
    expect(namePadOf([])).toBe(2);
  });

  it('strips trailing digits for a group, and keeps an all-digit name whole', () => {
    expect(groupFromName('LHIP8')).toBe('LHIP');
    expect(groupFromName('LINS01')).toBe('LINS');
    expect(groupFromName('42')).toBe('42');
    expect(ordinalFromName('LINS14')).toBe(14);
    expect(ordinalFromName('tip')).toBeNull();
  });
});

describe('set helpers', () => {
  const set = setOf(
    contact({ id: 'c1', group: 'A', ordinal: 2, name: 'A02' }),
    contact({ id: 'c2', group: 'A', ordinal: 1, name: 'A01' }),
    contact({ id: 'c3', group: 'B', ordinal: 1, name: 'B01' })
  );

  it('lists a group by ordinal, not by array order', () => {
    expect(contactsOf(set, 'A').map((c) => c.name)).toEqual(['A01', 'A02']);
    expect(groupNames(set)).toEqual(['A', 'B']);
    expect(groupOf(set, 'B')?.name).toBe('B');
    expect(groupOf(set, 'Z')).toBeNull();
  });

  it('counts what a save would write as changed', () => {
    expect(dirtyCount(set)).toBe(0);
    const edited = setOf(
      contact({ id: 'c1', position: [5, 0, 0] }),
      contact({ id: 'c2', original: null })
    );
    expect(dirtyCount(edited)).toBe(2);
    expect(dirtyCount(edited, 3)).toBe(5);
  });

  it('counts a contact a relabel renamed, and never an added one', () => {
    // A renumber changes every name on a shaft and moves nothing: a footer reading "0 changed"
    // beside the dirty dot is the panel disagreeing with itself.
    const renumbered = setOf(contact({ id: 'c1', name: 'A06', originalName: 'A01' }));
    expect(dirtyCount(renumbered)).toBe(1);
    expect(wasRenamed(contact({ id: 'c1', name: 'A06', originalName: 'A01' }))).toBe(true);
    // An added contact has no name in the file to have been renamed from, and is already counted.
    expect(wasRenamed(contact({ id: 'p1', original: null }))).toBe(false);
    expect(dirtyCount(setOf(contact({ id: 'p1', original: null })))).toBe(1);
  });

  it('clones deeply enough that a snapshot survives the next edit', () => {
    const copy = cloneSet(set);
    (copy.contacts[0] as Contact).position[0] = 99;
    expect((set.contacts[0] as Contact).position[0]).toBe(0);
    expect(emptySet().contacts).toEqual([]);
  });
});
