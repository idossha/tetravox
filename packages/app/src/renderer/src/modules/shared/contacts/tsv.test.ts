/**
 * The tolerant reader and the canonical writer (§13.4).
 *
 * Every case here is a file somebody really has: a comma-separated export, a semicolon-separated
 * one from a European spreadsheet, a UTF-8 BOM from Excel, `R`/`A`/`S` column names, a row one cell
 * short, a Slicer `.fcsv` in LPS. The float formatter's Python parity is pinned twice — the obvious
 * pairs here, and a generated JS/Python fixture in `modules/seeg-fixtures.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_FIELDNAMES,
  ContactTableError,
  contactSetFrom,
  formatFloat,
  outputFieldnames,
  parseTable,
  resolveColumns,
  writeTable,
} from './tsv';
import type { Contact } from './model';
import { statusOf } from './model';
import type { ContactSet } from './model';

/** `set.contacts[i]`, non-optional — every index used below is one the test just built. */
function at(set: ContactSet, index: number): Contact {
  return set.contacts[index] as Contact;
}

const TSV = [
  'name\telectrode\tcontact\tcsc\tx\ty\tz',
  'LINS01\tLINS\t1\t69\t-22.62\t49.38\t4.31',
  'LINS02\tLINS\t2\t70\t-22.9\t49.51\t9.37',
  'LOF01\tLOF\t1\t23\t-12.1\t92.91\t19.38',
  '',
].join('\n');

describe('parseTable', () => {
  it('reads a tab-separated BIDS table and keeps the column order', () => {
    const parsed = parseTable(TSV);
    expect(parsed.delimiter).toBe('tab');
    expect(parsed.fieldnames).toEqual(['name', 'electrode', 'contact', 'csc', 'x', 'y', 'z']);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.columns.electrode).toBe('electrode');
    expect(parsed.columns.status).toBeNull();
  });

  it('detects a comma and a semicolon, and strips a BOM', () => {
    const comma = parseTable('\uFEFFname,x,y,z\nA1,1,2,3\n');
    expect(comma.delimiter).toBe('comma');
    expect(comma.fieldnames).toEqual(['name', 'x', 'y', 'z']);
    expect(comma.rows[0]).toEqual({ name: 'A1', x: '1', y: '2', z: '3' });

    expect(parseTable('name;x;y;z\nA1;1;2;3\n').delimiter).toBe('semicolon');
    expect(parseTable('name x y z\nA1 1 2 3\n').delimiter).toBe('whitespace');
  });

  it('survives CRLF, blank lines and spaces around the header names', () => {
    const parsed = parseTable('  name \t X \t Y \t Z \r\n\r\nA1\t1\t2\t3\r\n');
    expect(parsed.fieldnames).toEqual(['name', 'X', 'Y', 'Z']);
    expect(parsed.columns.x).toBe('X');
    expect(parsed.rows).toHaveLength(1);
  });

  it('falls back to R/A/S only when x/y/z are all missing', () => {
    expect(resolveColumns(['name', 'R', 'A', 'S'])).toMatchObject({ x: 'R', y: 'A', z: 'S' });
    // An `x` present means the file meant `x`, whatever else it also has.
    expect(resolveColumns(['name', 'x', 'y', 'z', 'r'])).toMatchObject({ x: 'x' });
  });

  it('truncates a ragged row instead of throwing', () => {
    const parsed = parseTable('name\tx\ty\tz\tcsc\nA1\t1\t2\t3\n');
    expect(parsed.rows[0]).toEqual({ name: 'A1', x: '1', y: '2', z: '3' });
  });

  it('names the delimiter and the columns when a required one is missing', () => {
    let error: unknown = null;
    try {
      parseTable('label,px,py,pz\nA1,1,2,3\n');
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ContactTableError);
    const message = (error as Error).message;
    expect(message).toContain('comma');
    expect(message).toContain('label, px, py, pz');
  });

  it('refuses an empty file', () => {
    expect(() => parseTable('\n\n')).toThrow(ContactTableError);
  });

  it('reads a Slicer .fcsv and converts LPS to RAS', () => {
    const fcsv = [
      '# Markups fiducial file version = 4.11',
      '# CoordinateSystem = LPS',
      '# columns = id,x,y,z,ow,ox,oy,oz,vis,sel,lock,label,desc,associatedNodeID',
      'vtkMRMLMarkupsFiducialNode_0,22.62,-49.38,4.31,0,0,0,1,1,1,0,LINS01,,',
      '',
    ].join('\n');
    const parsed = parseTable(fcsv);
    expect(parsed.format).toBe('fcsv');
    expect(parsed.coordinateSystem).toBe('LPS');
    expect(parsed.fieldnames).toEqual([...CANONICAL_FIELDNAMES]);
    const { set } = contactSetFrom(parsed);
    expect(set.contacts[0]?.name).toBe('LINS01');
    // LPS → RAS negates x and y, and leaves z.
    expect(set.contacts[0]?.position).toEqual([-22.62, 49.38, 4.31]);
  });
});

describe('contactSetFrom', () => {
  it('builds groups in file order, with stable ids and per-file ordinals', () => {
    const { set, namePad } = contactSetFrom(parseTable(TSV));
    expect(set.groups.map((g) => g.name)).toEqual(['LINS', 'LOF']);
    expect(set.contacts.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(set.contacts.map((c) => c.ordinal)).toEqual([1, 2, 1]);
    expect(namePad).toBe(2);
    // Provenance: `original` is where the file put it, and nothing has moved yet.
    expect(set.contacts[0]?.original).toEqual([-22.62, 49.38, 4.31]);
    expect(statusOf(at(set, 0))).toBe('kept');
  });

  it('infers the electrode by stripping trailing digits when there is no group column', () => {
    const { set } = contactSetFrom(parseTable('name\tx\ty\tz\nLHIP8\t1\t2\t3\nLHIP9\t1\t2\t4\n'));
    expect(set.groups.map((g) => g.name)).toEqual(['LHIP']);
    expect(set.contacts.map((c) => c.ordinal)).toEqual([8, 9]);
  });

  it('skips a row with no coordinate, and says so', () => {
    const { set, warnings } = contactSetFrom(
      parseTable('name\tx\ty\tz\nA1\t1\t2\t3\nA2\tn/a\tn/a\tn/a\n')
    );
    expect(set.contacts).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('row 3');
  });

  it('keeps a status the file carried, so `located` is not overwritten by `kept`', () => {
    const { set } = contactSetFrom(parseTable('name\tx\ty\tz\tstatus\nA1\t1\t2\t3\tlocated\n'));
    expect(set.contacts[0]?.loadedStatus).toBe('located');
    expect(statusOf(at(set, 0))).toBe('located');
  });
});

describe('formatFloat', () => {
  it('writes what Python `repr` writes', () => {
    // Every pair here is `repr(x)` in CPython 3.11. The generated fixture covers the rest.
    expect(formatFloat(3)).toBe('3.0');
    expect(formatFloat(-22.62)).toBe('-22.62');
    expect(formatFloat(0)).toBe('0.0');
    expect(formatFloat(-0)).toBe('-0.0');
    expect(formatFloat(0.1)).toBe('0.1');
    expect(formatFloat(1 / 3)).toBe('0.3333333333333333');
    expect(formatFloat(1e-5)).toBe('1e-05');
    expect(formatFloat(1e-4)).toBe('0.0001');
    expect(formatFloat(1e15)).toBe('1000000000000000.0');
    expect(formatFloat(1e16)).toBe('1e+16');
    expect(formatFloat(1e100)).toBe('1e+100');
    expect(formatFloat(-1.5e-9)).toBe('-1.5e-09');
  });

  it('is `n/a` for a non-finite value, which is what BIDS says', () => {
    expect(formatFloat(Number.NaN)).toBe('n/a');
    expect(formatFloat(Number.POSITIVE_INFINITY)).toBe('n/a');
  });

  it('round-trips every value it writes', () => {
    for (const value of [-22.62, 49.38, 4.31, 1 / 7, 1e-5, 1e16, 123456.789]) {
      expect(Number(formatFloat(value))).toBe(value);
    }
  });
});

describe('writeTable', () => {
  it('preserves the original columns and appends only what is missing', () => {
    const parsed = parseTable(TSV);
    expect(outputFieldnames(parsed)).toEqual([
      'name',
      'electrode',
      'contact',
      'csc',
      'x',
      'y',
      'z',
      'status',
    ]);
  });

  it('writes an untouched table back with the same coordinates and LF endings', () => {
    const parsed = parseTable(TSV);
    const { set } = contactSetFrom(parsed);
    const text = writeTable(set, parsed);
    expect(text.includes('\r')).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('name\telectrode\tcontact\tcsc\tx\ty\tz\tstatus');
    expect(lines[1]).toBe('LINS01\tLINS\t1\t69\t-22.62\t49.38\t4.31\tkept');
    // Grouped by electrode in group order, ordered by contact inside a group.
    expect(lines.map((l) => l.split('\t')[0])).toEqual(['name', 'LINS01', 'LINS02', 'LOF01']);
  });

  it('marks a moved contact `edited` and an added one `added`, at 1e-3 mm', () => {
    const parsed = parseTable(TSV);
    const { set } = contactSetFrom(parsed);
    // Below the tolerance: still `kept`.
    at(set, 0).position = [-22.6203, 49.38, 4.31];
    // Above it: `edited`.
    at(set, 1).position = [-22.9, 49.51, 9.87];
    set.contacts.push({
      id: 'p7',
      name: 'LOF02',
      group: 'LOF',
      ordinal: 2,
      position: [1, 2, 3],
      original: null,
      loadedStatus: null,
      extra: {},
    });
    const rows = writeTable(set, parsed).trimEnd().split('\n').slice(1);
    const status = (line: string): string => line.split('\t')[7] as string;
    expect(status(rows[0] as string)).toBe('kept');
    expect(status(rows[1] as string)).toBe('edited');
    expect(status(rows[3] as string)).toBe('added');
    // An added contact's unknown cells are BIDS's `n/a`, never an empty cell.
    expect((rows[3] as string).split('\t')[3]).toBe('n/a');
  });

  it('keeps a cell the file really left empty, so an untouched row makes no diff', () => {
    const parsed = parseTable('name\tx\ty\tz\tnote\nA1\t1\t2\t3\t\n');
    const { set } = contactSetFrom(parsed);
    const row = writeTable(set, parsed).trimEnd().split('\n')[1] as string;
    expect(row.split('\t')[4]).toBe('');
  });
});
