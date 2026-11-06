/**
 * §7.6's safety test for assumed FreeSurfer names. A wrong name on a brain region is worse than a
 * number, so every "stays numbers" case must go red if the guard is removed, and the last group
 * pins each clause alone.
 *
 * Ids: `scripts/refvalues/label_ids_refvalues.json`, nibabel over the real files (its docstring has
 * the command). Names and colours: `/Applications/freesurfer/FreeSurferColorLUT.txt`, and
 * `scripts/reference/fs_names.py check` compares the table with MRtrix and SimNIBS.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assumedLabelTable, looksFreeSurfer } from './labelNames';
import { volumeLabelTable } from './fromMeta';

const REF = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../scripts/refvalues/label_ids_refvalues.json'), 'utf8')
) as Record<'aseg' | 'dseg' | 'finalTissues', { ids: number[] }>;

const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('a real aseg gets names', () => {
  const table = assumedLabelTable(REF.aseg.ids);

  it('has the 32 regions and background the file has', () => {
    expect(REF.aseg.ids.filter((id) => id !== 0)).toHaveLength(32);
    expect(table?.entries.map((e) => e.id)).toEqual(REF.aseg.ids);
  });

  it('takes names and colours from FreeSurfer’s table, with a transparent background', () => {
    expect(table?.byId.get(41)?.name).toBe('Right-Cerebral-White-Matter');
    expect(table?.byId.get(10)?.name).toBe('Left-Thalamus');
    // FreeSurferColorLUT.txt: `17 Left-Hippocampus 220 216 20 0`.
    expect(table?.byId.get(17)?.color).toEqual([220 / 255, 216 / 255, 20 / 255, 1]);
    expect(table?.byId.get(0)).toEqual({ id: 0, name: 'Background', color: [0, 0, 0, 0] });
  });

  it('holds for a DK parcellation by its cortical ids alone', () => {
    expect(assumedLabelTable([0, 1001, 1035, 2001, 2035])?.byId.get(1035)?.name).toBe(
      'ctx-lh-insula'
    );
  });
});

describe('everything else stays numbers', () => {
  const cases: [string, readonly number[]][] = [
    ['a binary mask', [0, 1]],
    ['a 3-tissue dseg, sub-CHN_space-ACPC_dseg', REF.dseg.ids],
    ['SimNIBS final tissues, ernie (4 absent)', REF.finalTissues.ids],
    ['SimNIBS final tissues 1..10', [0, ...upTo(10)]],
    ['a Schaefer-like 1..100', [0, ...upTo(100)]],
    ['a Schaefer-like 1..400', [0, ...upTo(400)]],
    ['a contiguous 1..116', [0, ...upTo(116)]],
  ];
  it.each(cases)('%s', (_name, ids) => {
    expect(assumedLabelTable(ids)).toBeNull();
  });
});

describe('each clause alone refuses', () => {
  it('an id outside the table, with every other clause satisfied', () => {
    expect(looksFreeSurfer([2, 41, 3, 42, 700])).toBe(false);
    expect(looksFreeSurfer([2, 41, 3, 42])).toBe(true);
  });
  it('fewer than two pairs, and cortex on one side only', () => {
    expect(looksFreeSurfer([2, 41, 3, 10])).toBe(false);
    expect(looksFreeSurfer([1001, 1002, 1035])).toBe(false);
  });
  it('ids that spell pairs but run 1..N', () => {
    expect(looksFreeSurfer(upTo(60))).toBe(false);
    expect(looksFreeSurfer(upTo(60).filter((id) => id !== 30))).toBe(true);
  });
  it('nothing at all', () => {
    expect(looksFreeSurfer([0])).toBe(false);
  });
});

describe('a lookup file’s alpha column (§7.6)', () => {
  const entry = (
    id: number,
    a: number
  ): { id: number; name: string; color: [number, number, number, number] } => ({
    id,
    name: `n${id}`,
    color: [10, 20, 30, a],
  });

  it('reads FreeSurfer’s inverted column as opaque, and id 0 stays background', () => {
    // testdata/labels_freesurfer_LUT.txt, and the real table: A is 0 on 1465 of 1475 rows.
    const table = volumeLabelTable([entry(0, 0), entry(3, 0), entry(7, 0)]);
    expect(table.byId.get(3)?.color[3]).toBe(1);
    expect(table.byId.get(0)?.color[3]).toBe(0);
  });

  it('leaves a SimNIBS column literal', () => {
    const table = volumeLabelTable([entry(0, 0), entry(1, 255), entry(2, 128)]);
    expect(table.byId.get(2)?.color[3]).toBe(128 / 255);
    expect(table.byId.get(0)?.color[3]).toBe(0);
  });
});
