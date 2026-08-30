/**
 * The editlog's schema (§13.4).
 *
 * Two things are being pinned: the **counts Slicer wrote**, key for key, because `seegprep` and any
 * lab script that already reads one must keep working; and the **per-contact diff**, which is what
 * this build adds. A change to either is a change to a file another program reads.
 */

import { describe, expect, it } from 'vitest';
import type { Contact, ContactSet } from './model';
import { buildEditlog, editlogDate, formatEditlog, EDITLOG_SCHEMA, utcSeconds } from './editlog';
import { paletteColor } from './palette';

function contact(partial: Partial<Contact> & Pick<Contact, 'id'>): Contact {
  return {
    name: 'A01',
    group: 'A',
    ordinal: 1,
    position: [0, 0, 0],
    original: [0, 0, 0],
    loadedStatus: null,
    extra: {},
    ...partial,
  };
}

const SET: ContactSet = {
  contacts: [
    contact({ id: 'c1', name: 'A01', ordinal: 1 }),
    contact({ id: 'c2', name: 'A02', ordinal: 2, position: [0.5, 0, 0] }),
    contact({ id: 'p9', name: 'A03', ordinal: 3, original: null, position: [7, 0, 0] }),
  ],
  groups: [{ name: 'A', color: paletteColor(0), tip: 'auto' }],
};

const OPERATIONS = {
  refit: new Set(['A']),
  renumbered: new Set<string>(),
  snapped: new Set(['A']),
};

describe('buildEditlog', () => {
  const log = buildEditlog({
    set: SET,
    deleted: [{ name: 'A04', group: 'A', ordinal: 4, position: [10, 0, 0] }],
    sourceTsv: '/data/sub-01_electrodes.tsv',
    outputTsv: '/data/sub-01_electrodes.tsv',
    backup: '/data/sub-01_electrodes.tsv.20260830-101500.bak',
    snapRadiusMm: 1.5,
    tool: 'Tetravox sEEG contacts 0.1.0',
    operations: OPERATIONS,
    now: new Date(Date.UTC(2026, 7, 30, 10, 15, 0)),
  });

  it('carries every count Slicer’s editor wrote, under the same names', () => {
    expect(log.edited_utc).toBe('2026-08-30T10:15:00Z');
    expect(log.source_tsv).toBe('/data/sub-01_electrodes.tsv');
    expect(log.output_tsv).toBe('/data/sub-01_electrodes.tsv');
    expect(log.backup).toBe('/data/sub-01_electrodes.tsv.20260830-101500.bak');
    expect(log.n_electrodes).toBe(1);
    expect(log.n_contacts).toBe(3);
    expect(log.added).toBe(1);
    expect(log.edited).toBe(1);
    expect(log.tool).toContain('Tetravox');
  });

  it('adds the counts Slicer had no answer for', () => {
    expect(log.schema).toBe(EDITLOG_SCHEMA);
    expect(log.deleted).toBe(1);
    expect(log.kept).toBe(1);
    expect(log.snap_radius_mm).toBe(1.5);
    expect(log.electrodes).toEqual([
      { name: 'A', n_contacts: 3, refit: true, renumbered: false, snapped: true },
    ]);
  });

  it('names every contact that changed, with from / to / shift', () => {
    expect(log.contacts).toHaveLength(3);
    expect(log.contacts[0]).toEqual({
      name: 'A02',
      electrode: 'A',
      contact: 2,
      change: 'edited',
      from: [0, 0, 0],
      to: [0.5, 0, 0],
      shift_mm: 0.5,
    });
    // An addition has no `from`; a deletion has no `to`. Both are the honest shape.
    expect(log.contacts[1]).toMatchObject({ name: 'A03', change: 'added', to: [7, 0, 0] });
    expect(log.contacts[1]).not.toHaveProperty('from');
    expect(log.contacts[2]).toMatchObject({ name: 'A04', change: 'deleted', from: [10, 0, 0] });
    expect(log.contacts[2]).not.toHaveProperty('to');
  });

  it('says nothing about a contact that did not move', () => {
    expect(log.contacts.some((c) => c.name === 'A01')).toBe(false);
  });

  it('is two-space JSON with a trailing newline, like `json.dump(…, indent=2)`', () => {
    const text = formatEditlog(log);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')[1]).toMatch(/^ {2}"/);
    expect(JSON.parse(text)).toEqual(log);
  });
});

describe('editlogDate', () => {
  it('reads the timestamp out of this build’s log and out of Slicer’s', () => {
    expect(editlogDate('{"edited_utc": "2026-08-30T10:15:00Z", "n_contacts": 3}')).toBe(
      '2026-08-30T10:15:00Z'
    );
    // Slicer's log has no `schema` key at all; the banner only needs the date.
    expect(editlogDate('{"edited_utc": "2025-01-02T03:04:05Z", "added": 0, "edited": 2}')).toBe(
      '2025-01-02T03:04:05Z'
    );
  });

  it('is null rather than throwing on anything it cannot read', () => {
    expect(editlogDate('not json at all')).toBeNull();
    expect(editlogDate('{}')).toBeNull();
    expect(editlogDate('[1, 2, 3]')).toBeNull();
    expect(editlogDate('null')).toBeNull();
  });
});

describe('utcSeconds', () => {
  it('drops the milliseconds an ISO string carries', () => {
    expect(utcSeconds(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)))).toBe('2026-01-02T03:04:05Z');
  });
});
