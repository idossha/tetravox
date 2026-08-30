/**
 * The scene block (§13.2, §13.4).
 *
 * Three properties, and each is a rule the format depends on: no `LayerId` or `DatasetId` anywhere
 * inside it; a shrink path for a set too large for 256 KiB that loses the least valuable thing
 * first; and a read side that defaults every field rather than throwing, because a malformed block
 * handed to `restoreBlock` is a module crash on file open.
 */

import { describe, expect, it } from 'vitest';
import type { Contact, ContactSet } from '../shared/contacts/model';
import { paletteColor } from '../shared/contacts/palette';
import { resolveColumns } from '../shared/contacts/tsv';
import type { SeegBlockSource } from './block';
import { fromBlock, mergeBlockIntoSet, SEEG_BLOCK_VERSION, shrinkBlock, toBlock } from './block';

function contact(id: string, partial: Partial<Contact> = {}): Contact {
  return {
    id,
    name: 'A01',
    group: 'A',
    ordinal: 1,
    position: [1, 2, 3],
    original: [1, 2, 3],
    loadedStatus: 'located',
    extra: { name: 'A01', x: '1', y: '2', z: '3', csc: '17' },
    ...partial,
  };
}

const SET: ContactSet = {
  contacts: [contact('c1'), contact('p4', { name: 'A02', ordinal: 2, original: null, extra: {} })],
  groups: [{ name: 'A', color: paletteColor(0), tip: 'high' }],
};

const SOURCE: SeegBlockSource = {
  tsv: '/data/sub-01_electrodes.tsv',
  coordsystem: null,
  fieldnames: ['name', 'x', 'y', 'z', 'csc'],
  columns: resolveColumns(['name', 'x', 'y', 'z', 'csc']),
  delimiter: 'tab',
};

const INPUT = { set: SET, source: SOURCE, snapRadiusMm: 2.25, namePad: 2, ghost: false };

describe('toBlock', () => {
  const block = toBlock(INPUT);

  it('is keyed by point id and holds no LayerId or DatasetId anywhere', () => {
    expect(Object.keys(block.rows)).toEqual(['c1', 'p4']);
    const text = JSON.stringify(block);
    // The two id shapes the app mints (`l<n>` / `ds<n>`) must not appear in a block at all: both are
    // reassigned on load, so a block naming one would point at someone else's layer.
    expect(/"(layerId|datasetId)"/.test(text)).toBe(false);
  });

  it('carries the provenance a `points[]` entry has no field for', () => {
    expect(block.rows['c1']).toEqual({
      original: [1, 2, 3],
      status: 'located',
      extra: { name: 'A01', x: '1', y: '2', z: '3', csc: '17' },
    });
    // A contact added in this session has no original, and says so with a null.
    expect(block.rows['p4']?.original).toBeNull();
    expect(block.electrodes).toEqual([{ name: 'A', color: paletteColor(0), tip: 'high' }]);
    expect(block.snapRadiusMm).toBe(2.25);
    expect(block.ghost).toBe(false);
    expect(block.source?.fieldnames).toEqual(['name', 'x', 'y', 'z', 'csc']);
  });

  it('is small — a 103-contact table is nowhere near §13.2’s 256 KiB', () => {
    const many: ContactSet = {
      contacts: Array.from({ length: 103 }, (_v, i) => contact(`c${i + 1}`)),
      groups: SET.groups,
    };
    const bytes = JSON.stringify(toBlock({ ...INPUT, set: many })).length;
    expect(bytes).toBeLessThan(64 * 1024);
  });
});

describe('shrinkBlock', () => {
  it('drops the original columns first, keeping every position', () => {
    const smaller = shrinkBlock(toBlock(INPUT), 1);
    expect(smaller.rows['c1']?.original).toEqual([1, 2, 3]);
    expect(smaller.rows['c1']?.extra).toEqual({});
    expect(smaller.source?.tsv).toBe('/data/sub-01_electrodes.tsv');
  });

  it('drops the rows entirely as the last resort', () => {
    const smallest = shrinkBlock(toBlock(INPUT), 2);
    expect(smallest.rows).toEqual({});
    expect(smallest.electrodes).toHaveLength(1);
  });
});

describe('fromBlock', () => {
  it('round-trips a block this build wrote', () => {
    const block = toBlock(INPUT);
    expect(fromBlock(JSON.parse(JSON.stringify(block)))).toEqual(block);
    expect(SEEG_BLOCK_VERSION).toBe(1);
  });

  it('defaults every field rather than throwing on a malformed one', () => {
    const read = fromBlock({
      source: 'not an object',
      rows: {
        c1: { original: ['a', 'b', 'c'], status: 7, extra: { ok: 'yes', bad: 3 } },
        c2: null,
      },
      electrodes: [{ name: 'A', color: 'red', tip: 'sideways' }, { tip: 'low' }, 42],
      snapRadiusMm: 'wide',
      namePad: null,
    });
    expect(read).not.toBeNull();
    expect(read?.source).toBeNull();
    expect(read?.rows['c1']).toEqual({ original: null, status: null, extra: { ok: 'yes' } });
    expect(read?.rows).not.toHaveProperty('c2');
    expect(read?.electrodes).toEqual([{ name: 'A', color: paletteColor(0), tip: 'auto' }]);
    expect(read?.snapRadiusMm).toBe(1.5);
    expect(read?.namePad).toBe(2);
    // Absent means the ghost is ON, which is the module's own default.
    expect(read?.ghost).toBe(true);
  });

  it('is null only for something that is not an object at all', () => {
    expect(fromBlock(null)).toBeNull();
    expect(fromBlock('a block')).toBeNull();
    expect(fromBlock({})).not.toBeNull();
  });
});

describe('mergeBlockIntoSet', () => {
  it('puts provenance back onto a set rebuilt from the layer', () => {
    // What `contactSetFromLayer` produces: positions and names, no provenance at all.
    const rebuilt: ContactSet = {
      contacts: [
        { ...contact('c1'), original: null, loadedStatus: null, extra: {} },
        {
          ...contact('p4'),
          name: 'A02',
          ordinal: 2,
          original: null,
          loadedStatus: null,
          extra: {},
        },
      ],
      groups: [{ name: 'A', color: paletteColor(5), tip: 'auto' }],
    };
    const merged = mergeBlockIntoSet(rebuilt, toBlock(INPUT));
    expect(merged.contacts[0]?.original).toEqual([1, 2, 3]);
    expect(merged.contacts[0]?.loadedStatus).toBe('located');
    expect(merged.contacts[0]?.extra['csc']).toBe('17');
    // The added contact stays added; the block agrees it had no original.
    expect(merged.contacts[1]?.original).toBeNull();
    // The group's colour and its pinned tip come back too.
    expect(merged.groups[0]).toEqual({ name: 'A', color: paletteColor(0), tip: 'high' });
  });

  it('leaves a contact the block has never heard of alone', () => {
    const rebuilt: ContactSet = {
      contacts: [{ ...contact('p99'), original: null, extra: {} }],
      groups: [{ name: 'A', color: paletteColor(0), tip: 'auto' }],
    };
    const merged = mergeBlockIntoSet(rebuilt, toBlock(INPUT));
    expect(merged.contacts[0]?.original).toBeNull();
  });
});
