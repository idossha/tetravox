/**
 * The scene block (§13.2, §13.4).
 *
 * Three properties, and each is a rule the format depends on: no `LayerId` or `DatasetId` anywhere
 * inside it; a shrink path for a set too large for 256 KiB that loses the least valuable thing
 * first; and a read side that defaults every field rather than throwing, because a malformed block
 * handed to `restoreBlock` is a module crash on file open.
 */

import { describe, expect, it } from 'vitest';
import type { vec3 } from '@tetravox/engine';
import type { Contact, ContactSet } from '../shared/contacts/model';
import { paletteColor } from '../shared/contacts/palette';
import { resolveColumns } from '../shared/contacts/tsv';
import type { SeegBlockSource } from './block';
import { fromBlock, mergeBlockIntoSet, SEEG_BLOCK_VERSION, shrinkBlock, toBlock } from './block';

function contact(id: string, partial: Partial<Contact> = {}): Contact {
  const base = {
    id,
    name: 'A01',
    group: 'A',
    ordinal: 1,
    position: [1, 2, 3] as vec3,
    original: [1, 2, 3] as vec3 | null,
    loadedStatus: 'located' as string | null,
    extra: { name: 'A01', x: '1', y: '2', z: '3', csc: '17' } as Record<string, string>,
    ...partial,
  };
  // The loaded name is the name; a contact with no row behind it never had one.
  return { originalName: base.original === null ? null : base.name, ...base };
}

const SET: ContactSet = {
  contacts: [contact('c1'), contact('p4', { name: 'A02', ordinal: 2, original: null, extra: {} })],
  groups: [{ name: 'A', color: paletteColor(0), tip: 'high' }],
};

const SOURCE: SeegBlockSource = {
  tsv: '/data/sub-01_electrodes.tsv',
  coordsystem: null,
  // The T1 a `load` operation named and found open (§13.6). A path, so the round trip below is
  // evidence the field survives one rather than that `null === null`.
  t1: '/data/derivatives/SimNIBS/sub-01/m2m_01/T1.nii.gz',
  fieldnames: ['name', 'x', 'y', 'z', 'csc'],
  columns: resolveColumns(['name', 'x', 'y', 'z', 'csc']),
  delimiter: 'tab',
};

const INPUT = {
  set: SET,
  deleted: [] as Contact[],
  source: SOURCE,
  snapRadiusMm: 2.25,
  namePad: 2,
  ghost: false,
};

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
      name: 'A01',
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
    // …and the deletions with them: level 2 loses every `original`, and a deletion whose position
    // is unknown is a worse editlog entry than a missing one.
    expect(smallest.deleted).toEqual([]);
  });

  it('keeps a deletion’s identity through the level-1 shrink, minus its columns', () => {
    const smaller = shrinkBlock(
      toBlock({ ...INPUT, deleted: [contact('c9', { name: 'A09' })] }),
      1
    );
    expect(smaller.deleted).toHaveLength(1);
    expect(smaller.deleted[0]).toMatchObject({ id: 'c9', name: 'A09', position: [1, 2, 3] });
    expect(smaller.deleted[0]?.row.original).toEqual([1, 2, 3]);
    expect(smaller.deleted[0]?.row.extra).toEqual({});
  });
});

describe('fromBlock', () => {
  it('round-trips a block this build wrote', () => {
    const block = toBlock(INPUT);
    expect(fromBlock(JSON.parse(JSON.stringify(block)))).toEqual(block);
    expect(SEEG_BLOCK_VERSION).toBe(1);
  });

  /**
   * `source.t1` was appended 2026-08-30 with the `load` operation's `t1` argument, and the version
   * did **not** move — which is a claim about blocks written before it existed, not about this one.
   * A block with no `t1` reads back as "there isn't one", which is the state the module starts in,
   * so nothing it does afterwards can tell the difference.
   */
  it('reads a block written before `source.t1` existed as having no T1', () => {
    const { t1: _dropped, ...older } = SOURCE;
    const read = fromBlock({ ...toBlock(INPUT), source: older });
    expect(read?.source?.t1).toBeNull();
    expect(read?.source?.tsv).toBe('/data/sub-01_electrodes.tsv');
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
    expect(read?.rows['c1']).toEqual({
      original: null,
      name: null,
      status: null,
      extra: { ok: 'yes' },
    });
    expect(read?.rows).not.toHaveProperty('c2');
    expect(read?.electrodes).toEqual([{ name: 'A', color: paletteColor(0), tip: 'auto' }]);
    expect(read?.snapRadiusMm).toBe(1.5);
    expect(read?.namePad).toBe(2);
    // Absent means the ghost is ON, which is the module's own default.
    expect(read?.ghost).toBe(true);
  });

  /**
   * `deleted` and `rows[].name` were appended 2026-08-30 and the version did **not** move, which is
   * a claim about the blocks already written: one with neither key restores to no deletions and no
   * remembered names, which is exactly what this build did before they existed.
   */
  it('reads a block written before deletions and loaded names were carried', () => {
    const { deleted: _gone, ...older } = toBlock({
      ...INPUT,
      deleted: [contact('c9', { name: 'A09' })],
    });
    const read = fromBlock({
      ...older,
      rows: { c1: { original: [1, 2, 3], status: 'located', extra: {} } },
    });
    expect(read?.deleted).toEqual([]);
    expect(read?.rows['c1']?.name).toBeNull();
  });

  it('drops a deletion record it cannot use, rather than restoring a contact with no position', () => {
    const read = fromBlock({
      ...toBlock(INPUT),
      deleted: [
        { id: 'c9', name: 'A09', group: 'A', ordinal: 9, position: [1, 2, 3], row: {} },
        { name: 'no id', position: [1, 2, 3] },
        { id: 'c8', name: 'A08', position: 'over there' },
        7,
      ],
    });
    expect(read?.deleted).toHaveLength(1);
    expect(read?.deleted[0]).toMatchObject({ id: 'c9', group: 'A', ordinal: 9 });
    expect(read?.deleted[0]?.row).toEqual({ original: null, name: null, status: null, extra: {} });
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

  it('puts the name the table had back, so a relabel survives a scene reopen', () => {
    // What `contactSetFromLayer` produces: the layer's own names and no memory of any other.
    const rebuilt: ContactSet = {
      contacts: [{ ...contact('c1'), original: null, originalName: null, extra: {} }],
      groups: [{ name: 'A', color: paletteColor(0), tip: 'auto' }],
    };
    const renumbered = toBlock({
      ...INPUT,
      set: { ...SET, contacts: [contact('c1', { name: 'A06', originalName: 'A01' })] },
    });
    expect(mergeBlockIntoSet(rebuilt, renumbered).contacts[0]?.originalName).toBe('A01');
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
