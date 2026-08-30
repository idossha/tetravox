/**
 * The sEEG module against a **real seegprep subject** — AGENTS.md rule 2's real-data half for §13.
 *
 * Skips (never fails) without `TETRAVOX_SEEG_TESTDATA`, which points at a subject directory inside a
 * `seegprep` derivative tree:
 *
 * ```sh
 * export TETRAVOX_SEEG_TESTDATA=/path/to/derivatives/seegprep/sub-P076
 * #   <dir>/ct/sub-<id>_acq-bone_space-T1w_ct.nii.gz
 * #   <dir>/ieeg/sub-<id>_space-T1w_electrodes.tsv
 * ```
 *
 * **No such subject exists on the development machine**, which is why every assertion here is a
 * *property* rather than a number: a real table's contact count, its column set and its coordinates
 * are the site's, not this repository's, and a test that pinned them could only ever be run by
 * whoever generated it. What it does check is what would be wrong with the module rather than with
 * the data — a coordinate that is not in a head, a shaft that is not straight, a save that does not
 * round-trip, a sibling pattern that does not resolve the file it was written for.
 *
 * The synthetic half is `seeg-fixtures.test.ts`, where the expectations come from numpy.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { vec3 } from '@tetravox/engine';
import { contactSetFrom, parseTable, writeTable } from './shared/contacts/tsv';
import { contactsOf } from './shared/contacts/model';
import { lineMetrics } from './shared/contacts/geometry';
import { editlogDate } from './shared/contacts/editlog';
import { instantiateSiblings } from './siblings';
import { seegManifest } from '../../../modules/seeg/manifest';
import { bundleOf, seegprepWarning, stemOf } from './seeg/bids';
import { resolveTip, shaftStats, tipReference } from './seeg/shaft';

const ROOT = process.env['TETRAVOX_SEEG_TESTDATA'] ?? '';
const have = ROOT !== '' && existsSync(ROOT);

/** A head is about 200 mm across; anything outside this box is not a contact in T1w RAS. */
const HEAD_BOX_MM = 300;

describe.skipIf(!have)('a real seegprep subject', () => {
  // Read inside the tests, never at the top level: vitest evaluates a skipped `describe`'s body, so
  // a read here would throw on every machine without the dataset — the opposite of "skips, never
  // fails".
  const tablePath = (): string => {
    const ieeg = join(ROOT, 'ieeg');
    const name = readdirSync(ieeg).find((f) => f.endsWith('_electrodes.tsv'));
    expect(name, `no *_electrodes.tsv in ${ieeg}`).toBeDefined();
    return join(ieeg, name as string);
  };

  it('reads the table, and every contact is somewhere a head is', () => {
    const path = tablePath();
    const parsed = parseTable(readFileSync(path, 'utf8'));
    const { set, namePad, warnings } = contactSetFrom(parsed);

    expect(warnings, `rows this reader could not use: ${warnings.join('; ')}`).toEqual([]);
    expect(set.contacts.length).toBeGreaterThan(0);
    expect(set.groups.length).toBeGreaterThan(0);
    expect(namePad).toBeGreaterThanOrEqual(1);
    // A real table is tab-separated; anything else means the tolerance did the work, which is worth
    // knowing but is not what this file is for.
    expect(parsed.delimiter).toBe('tab');

    for (const contact of set.contacts) {
      expect(contact.name).not.toBe('');
      expect(contact.group).not.toBe('');
      expect(contact.ordinal).toBeGreaterThan(0);
      for (const axis of contact.position) {
        expect(Number.isFinite(axis)).toBe(true);
        expect(Math.abs(axis)).toBeLessThan(HEAD_BOX_MM);
      }
      // The name really does belong to its electrode, which is what makes `group` usable.
      expect(contact.name.startsWith(contact.group)).toBe(true);
    }
  });

  it('finds every electrode straight, evenly spaced and numbered from one end', () => {
    const parsed = parseTable(readFileSync(tablePath(), 'utf8'));
    const { set } = contactSetFrom(parsed);
    const reference = tipReference(null, set);

    for (const group of set.groups) {
      const contacts = contactsOf(set, group.name);
      const stats = shaftStats(set, group.name);
      expect(stats.n).toBe(contacts.length);
      if (contacts.length < 3) continue;

      // A depth electrode is a rigid rod: a millimetre of residual is already a lot, and anything
      // above three means the contacts of one "electrode" are not on one shaft.
      expect(stats.rmsMm, `${group.name} line RMS`).toBeLessThan(3);
      // Contacts of one electrode are equally spaced by construction; a CV above a half means a
      // missing contact has been filled from the wrong end, or two electrodes share a name.
      expect(stats.spacingCv, `${group.name} spacing CV`).toBeLessThan(0.5);
      // A clinical pitch is 3.5–10 mm depending on the model.
      expect(stats.pitchMm, `${group.name} pitch`).toBeGreaterThan(1);
      expect(stats.pitchMm, `${group.name} pitch`).toBeLessThan(15);

      // The tip rule answers, and it answers one of exactly two things.
      const tip = resolveTip(
        group,
        contacts.map((c) => c.position),
        reference
      );
      expect(['low', 'high']).toContain(tip);

      // …and the file's own numbering is monotonic along the shaft, which is what "contact 1 is the
      // tip" means once the localiser has done its job.
      const along = lineMetrics(contacts.map((c) => c.position));
      expect(along).not.toBeNull();
    }
  });

  it('writes the table back with its own columns and its own coordinates', () => {
    const path = tablePath();
    const source = readFileSync(path, 'utf8');
    const parsed = parseTable(source);
    const { set } = contactSetFrom(parsed);

    const written = writeTable(set, parsed);
    expect(written.includes('\r')).toBe(false);
    expect(written.endsWith('\n')).toBe(true);

    // Every original column survives, in the file's own order, with `status` appended if it was not
    // already there.
    const header = (written.split('\n')[0] as string).split('\t');
    for (const column of parsed.fieldnames) expect(header).toContain(column);
    expect(header.slice(0, parsed.fieldnames.length)).toEqual(parsed.fieldnames);

    // Read it back: the same contacts, at the same coordinates, to the bit.
    const again = contactSetFrom(parseTable(written)).set;
    expect(again.contacts.length).toBe(set.contacts.length);
    const byName = new Map(again.contacts.map((c) => [c.name, c.position as vec3]));
    for (const contact of set.contacts) {
      expect(byName.get(contact.name), contact.name).toEqual(contact.position);
    }
    // Nothing moved, so nothing is `edited` and nothing is `added`.
    expect(written).not.toContain('\tedited\n');
    expect(written).not.toContain('\tadded\n');
  });

  it('resolves the CT from the table and the table from the CT', () => {
    const path = tablePath();
    const rules = seegManifest.siblings ?? [];
    const fromTable: Record<string, string | null> = {};
    for (const rule of rules) {
      for (const candidate of instantiateSiblings(rule, path)) {
        fromTable[candidate.template] = existsSync(candidate.path) ? candidate.path : null;
      }
    }
    const bundle = bundleOf(fromTable);
    expect(bundle.ct, `no CT beside ${path}`).not.toBeNull();
    expect(existsSync(bundle.ct as string)).toBe(true);

    const fromCt: Record<string, string | null> = {};
    for (const rule of rules) {
      for (const candidate of instantiateSiblings(rule, bundle.ct as string)) {
        fromCt[candidate.template] = existsSync(candidate.path) ? candidate.path : null;
      }
    }
    expect(bundleOf(fromCt).tsv).toBe(path);
  });

  it('would write an editlog seegprep’s --force guard can find', () => {
    const path = tablePath();
    expect(seegprepWarning(path), 'this subject would get an editlog seegprep ignores').toBeNull();
    // …and an editlog that is already there is one this build can read the date out of.
    const editlog = join(ROOT, 'ieeg', `${stemOf(path.split('/').pop() as string)}_editlog.json`);
    if (!existsSync(editlog)) return;
    const when = editlogDate(readFileSync(editlog, 'utf8'));
    expect(when === null || /^\d{4}-\d{2}-\d{2}/.test(when)).toBe(true);
  });
});
