/**
 * R5's "Save LUT…" export, asserted against the §7.6 formats it has to reopen in.
 *
 * The load-bearing assertion is the colour arithmetic: §4.1 keeps colours as 0..1 floats everywhere
 * in §4 and 0..255 on the wire and on disk, so a LUT written from an edited swatch must come back as
 * exactly the byte the user picked. `k / 255` round-trips exactly and `0.1` does not, which is why
 * the fixtures below are eighths and exact byte fractions rather than decimals.
 */

import { describe, expect, it } from 'vitest';
import type { LabelEntry, vec4 } from '@tetravox/engine';
import { formatLut, fromLabelEntries, lutFileName, safeName, toBytes } from './lut';

const WHITE: vec4 = [1, 1, 1, 1];
const HALF: vec4 = [128 / 255, 64 / 255, 32 / 255, 1];

describe('toBytes', () => {
  it('is the §4.1 conversion, rounded, and exact on byte fractions', () => {
    expect(toBytes(WHITE)).toEqual([255, 255, 255, 255]);
    expect(toBytes(HALF)).toEqual([128, 64, 32, 255]);
    expect(toBytes([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });

  it('clamps rather than wrapping, so a slider that overshoots cannot write 0 for 256', () => {
    expect(toBytes([1.4, -0.2, 1, 1])).toEqual([255, 0, 255, 255]);
  });
});

describe('safeName', () => {
  it('collapses whitespace, because both formats are whitespace-delimited', () => {
    expect(safeName('Grey matter', 2)).toBe('Grey_matter');
    expect(safeName('  Left \t Insula ', 7)).toBe('Left_Insula');
  });

  it('never writes an empty column', () => {
    expect(safeName('   ', 13)).toBe('label_13');
  });
});

describe('formatLut', () => {
  const entries = [
    { id: 5, name: 'Scalp', color: HALF },
    { id: 1, name: 'White matter', color: WHITE },
  ];

  it('writes SimNIBS `#No. Label Name: R G B A`, sorted by id', () => {
    const lines = formatLut(entries, 'simnibs').trimEnd().split('\n');
    expect(lines[0]).toBe('#No.\tLabel Name:\tR\tG\tB\tA');
    expect(lines[1]).toBe('1\tWhite_matter\t255\t255\t255\t255');
    expect(lines[2]).toBe('5\tScalp\t128\t64\t32\t255');
  });

  it('sorts by id, not by list order — a saved LUT must diff cleanly against the next save', () => {
    const forward = formatLut(entries, 'simnibs');
    const reversed = formatLut([...entries].reverse(), 'simnibs');
    expect(forward).toBe(reversed);
  });

  it('writes FreeSurfer columns wide enough to stay aligned', () => {
    const lines = formatLut(entries, 'freesurfer').trimEnd().split('\n');
    expect(lines[0]).toContain('label lookup table');
    expect(lines[2]).toBe(`1    ${'White_matter'.padEnd(32, ' ')}255 255 255 255`);
    expect(lines[3]).toBe(`5    ${'Scalp'.padEnd(32, ' ')}128  64  32 255`);
  });

  it('ends with a newline, like every LUT the §7.6 parsers were written against', () => {
    expect(formatLut(entries).endsWith('\n')).toBe(true);
  });
});

describe('fromLabelEntries', () => {
  it('is a widening, not a conversion — the colours stay 0..1 (§4.1)', () => {
    const table: LabelEntry[] = [{ id: 3, name: 'CSF', color: HALF }];
    expect(fromLabelEntries(table)).toEqual([{ id: 3, name: 'CSF', color: HALF }]);
  });
});

describe('lutFileName', () => {
  it('offers `<stem>_LUT.txt`, the name §7.6 auto-associates on the next open', () => {
    expect(lutFileName('final_tissues.nii.gz')).toBe('final_tissues_LUT.txt');
    expect(lutFileName('ernie.msh')).toBe('ernie_LUT.txt');
    expect(lutFileName('lh.ernie_DK40.annot')).toBe('lh.ernie_DK40_LUT.txt');
    expect(lutFileName('')).toBe('labels_LUT.txt');
  });
});
