/**
 * §7.6: built-in FreeSurfer names for a label volume that came with no lookup table.
 *
 * Many atlases reuse small ids, and a wrong name on a brain region is worse than a number, so names
 * are assumed only when the ids themselves look like an aseg or aparc.
 */

import { FREESURFER_TABLE } from './freesurfer-table';
import type { LabelEntry, LabelTable, vec4 } from './types';

const BY_ID = new Map(FREESURFER_TABLE.map((row) => [row[0], row]));

/** Left and right ids of the structures every FreeSurfer segmentation has. */
const LEFT_RIGHT: readonly (readonly [number, number])[] = [
  [2, 41],
  [3, 42],
  [10, 49],
  [11, 50],
  [12, 51],
  [17, 53],
  [18, 54],
];

/** The safety test. Every clause is load-bearing: see `labelNames.test.ts`. */
export function looksFreeSurfer(labelIds: ArrayLike<number>): boolean {
  const ids = Array.from(labelIds).filter((id) => id !== 0);
  if (ids.length === 0 || !ids.every((id) => BY_ID.has(id))) return false;
  const has = new Set(ids);
  const pairs = LEFT_RIGHT.filter(([l, r]) => has.has(l) && has.has(r)).length;
  const cortex =
    ids.some((id) => id >= 1000 && id <= 1999) && ids.some((id) => id >= 2000 && id <= 2999);
  if (pairs < 2 && !cortex) return false;
  // 1..N is what a parcellation with its own numbering looks like, whatever the first ids spell.
  return !(has.size === Math.max(...ids));
}

/** Entries for the ids present, or `null` when the safety test fails. Id 0 stays transparent. */
export function assumedLabelTable(labelIds: ArrayLike<number>): LabelTable | null {
  if (!looksFreeSurfer(labelIds)) return null;
  const entries: LabelEntry[] = Array.from(labelIds).map((id) => {
    const [, name, r, g, b] = BY_ID.get(id) as (typeof FREESURFER_TABLE)[number];
    const color: vec4 = id === 0 ? [0, 0, 0, 0] : [r / 255, g / 255, b / 255, 1];
    return { id, name: id === 0 ? 'Background' : name, color };
  });
  return { entries, byId: new Map(entries.map((e) => [e.id, e])) };
}
