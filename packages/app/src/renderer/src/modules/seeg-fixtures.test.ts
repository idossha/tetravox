/**
 * The sEEG kernels against **numpy**, not against themselves (AGENTS.md rule 1 / §11, applied to a
 * module per §13.4).
 *
 * `scripts/gen-fixtures.py` writes two electrode tables beside the CT phantom and then computes,
 * with numpy and nibabel reading those files *back*, every number this module is supposed to
 * produce: the PCA axis and its RMS, the spacing CV and the median pitch, the re-spaced positions,
 * which end of each shaft is the tip, the names a relabel writes, the snapped position of every
 * contact, and the string Python's `repr` gives for a set of awkward doubles. This test replays
 * them. A disagreement is a real disagreement, because neither side has ever seen the other's code.
 *
 * It lives outside `modules/seeg/` for the same reason `hostImpl.test.ts` does: §13.1's import wall
 * covers every file under a module's directory, and this one reads the repository off disk.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { peakCentroid } from '@tetravox/engine';
import type { vec3 } from '@tetravox/engine';
import { makeVolume } from '../engine/mockData';
import { contactSetFrom, formatFloat, parseTable } from './shared/contacts/tsv';
import { contactsOf } from './shared/contacts/model';
import type { Contact, ContactSet } from './shared/contacts/model';
import { fitLine, lineMetrics } from './shared/contacts/geometry';
import { applySnap, snapContacts } from './shared/contacts/snap';
import { refitShaft, renumberTipFirst, tipEnd } from './seeg/shaft';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTDATA = resolve(HERE, '..', '..', '..', '..', '..', '..', 'testdata');

interface SeegFixture {
  table: string;
  messyTable: string;
  tipReference: [number, number, number];
  snapRadiusMm: number;
  contacts: {
    name: string;
    electrode: string;
    contact: number;
    world: [number, number, number];
    snappedWorld: [number, number, number] | null;
    errorToContactMm?: number;
    shiftMm?: number;
  }[];
  electrodes: {
    electrode: string;
    n: number;
    axis: [number, number, number];
    metrics: { rmsMm: number; spacingCv: number | null; pitchMm: number | null };
    tip: 'low' | 'high';
    refitWorld: [number, number, number][];
    refitMetrics: { rmsMm: number; spacingCv: number | null; pitchMm: number | null };
    namesTipFirst: string[];
  }[];
  floats: { value: number; repr: string }[];
}

const MANIFEST = JSON.parse(readFileSync(join(TESTDATA, 'manifest.json'), 'utf8')) as {
  seeg: SeegFixture;
};
const FIXTURE = MANIFEST.seeg;

function readSet(name: string): ContactSet {
  return contactSetFrom(parseTable(readFileSync(join(TESTDATA, name), 'utf8'))).set;
}

/** The manifest rounds to nine decimals; every comparison here allows exactly that. */
function expectVec(actual: vec3, expected: readonly number[], places = 6): void {
  for (let i = 0; i < 3; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i] as number, places);
  }
}

describe('the reader, against the generated tables', () => {
  it('reads the canonical table the fixture writes', () => {
    const set = readSet(FIXTURE.table);
    expect(set.contacts).toHaveLength(FIXTURE.contacts.length);
    expect(set.groups.map((g) => g.name)).toEqual(['A', 'B', 'C']);
    set.contacts.forEach((contact, index) => {
      const expected = FIXTURE.contacts[index] as SeegFixture['contacts'][number];
      expect(contact.name).toBe(expected.name);
      expect(contact.group).toBe(expected.electrode);
      expect(contact.ordinal).toBe(expected.contact);
      expectVec(contact.position, expected.world, 9);
      // The file's own `status` survives a load, so `located` is not overwritten by `kept`.
      expect(contact.loadedStatus).toBe('located');
    });
  });

  it('reads the deliberately awkward one — BOM, commas, CRLF, R/A/S, no group column, ragged', () => {
    const parsed = parseTable(readFileSync(join(TESTDATA, FIXTURE.messyTable), 'utf8'));
    expect(parsed.delimiter).toBe('comma');
    expect(parsed.columns).toMatchObject({ name: 'Name', x: 'R', y: 'A', z: 'S' });
    const set = contactSetFrom(parsed).set;
    expect(set.contacts.map((c) => c.name)).toEqual(['LHIP8', 'LHIP9', 'LHIP10']);
    // No electrode column: the group is the name with its trailing digits stripped.
    expect(set.groups.map((g) => g.name)).toEqual(['LHIP']);
    expect(set.contacts.map((c) => c.ordinal)).toEqual([8, 9, 10]);
    expectVec(set.contacts[0]?.position as vec3, [-6, -7, -11], 9);
    // The last row is one cell short of the header; it is truncated, not refused.
    expect(set.contacts[2]?.extra['csc']).toBeUndefined();
  });
});

describe('the line fit, against numpy’s SVD', () => {
  const set = readSet(FIXTURE.table);

  for (const expected of FIXTURE.electrodes) {
    it(`agrees about ${expected.electrode}`, () => {
      const positions = contactsOf(set, expected.electrode).map((c) => c.position);
      expect(positions).toHaveLength(expected.n);

      const fit = fitLine(positions);
      expect(fit).not.toBeNull();
      // The canonical sign is what makes this an axis comparison rather than a LAPACK tie-break.
      expectVec((fit as { axis: vec3 }).axis, expected.axis, 8);

      const metrics = lineMetrics(positions);
      expect(metrics?.rmsMm).toBeCloseTo(expected.metrics.rmsMm, 8);
      expect(metrics?.pitchMm).toBeCloseTo(expected.metrics.pitchMm as number, 8);
      expect(metrics?.spacingCv).toBeCloseTo(expected.metrics.spacingCv as number, 8);
    });
  }
});

describe('the tip rule, the re-fit and the relabel', () => {
  const set = readSet(FIXTURE.table);
  const reference = FIXTURE.tipReference as vec3;

  for (const expected of FIXTURE.electrodes) {
    it(`numbers ${expected.electrode} from the end numpy says is nearer the centre`, () => {
      const positions = contactsOf(set, expected.electrode).map((c) => c.position);
      expect(tipEnd(positions, reference)).toBe(expected.tip);
    });

    it(`re-fits ${expected.electrode} onto the same positions numpy computes`, () => {
      const result = refitShaft(set, expected.electrode, reference, 2);
      expect(result).not.toBeNull();
      const after = contactsOf((result as { set: ContactSet }).set, expected.electrode);
      expect(after.map((c) => c.name)).toEqual(expected.namesTipFirst);
      after.forEach((contact, index) => {
        expectVec(contact.position, expected.refitWorld[index] as number[], 8);
      });
      // …and the re-fit really did straighten it: the residual is zero to numpy's own precision.
      const metrics = lineMetrics(after.map((c) => c.position));
      expect(metrics?.rmsMm).toBeCloseTo(expected.refitMetrics.rmsMm, 8);
      expect(metrics?.pitchMm).toBeCloseTo(expected.refitMetrics.pitchMm as number, 8);
    });

    it(`relabels ${expected.electrode} tip-first without moving it`, () => {
      const before = contactsOf(set, expected.electrode).map((c) => [...c.position]);
      const { set: after } = renumberTipFirst(set, expected.electrode, reference, 2);
      const contacts = contactsOf(after, expected.electrode);
      expect(contacts.map((c) => c.name)).toEqual(expected.namesTipFirst);
      // The same positions, in the same order along the shaft — only the labels moved.
      const sorted = (list: readonly number[][]): number[][] =>
        [...list].sort((a, b) => (a[0] as number) - (b[0] as number));
      expect(sorted(contacts.map((c) => [...c.position]))).toEqual(sorted(before));
    });
  }
});

describe('snapping, against numpy’s peak centroid on the phantom', () => {
  // The stand-in engine's phantom, which `mockData.ts` recomputes from the same geometry
  // `gen-fixtures.py` writes into `ct_shafts.nii.gz`. Comparing a snap against the manifest is
  // therefore also the check that the two phantoms have not drifted apart.
  const dataset = makeVolume('ds1', 'sub-fixture_acq-bone_space-T1w_ct.nii.gz', undefined, 1, 1);
  const set = readSet(FIXTURE.table);

  it('reproduces the volume the fixture was generated from', () => {
    expect(dataset.dims).toEqual([56, 48, 40]);
    expect(dataset.spacing).toEqual([0.4, 0.5, 0.8]);
    expect(dataset.data?.length).toBe(56 * 48 * 40);
  });

  it('moves every contact where numpy says the metal is', () => {
    const result = snapContacts(
      set,
      set.contacts.map((c) => c.id),
      FIXTURE.snapRadiusMm,
      (world, radius) => peakCentroid(dataset, world, radius)
    );
    expect(result.moved).toBe(FIXTURE.contacts.length);
    const after = applySnap(set, result);
    after.contacts.forEach((contact, index) => {
      const expected = FIXTURE.contacts[index] as SeegFixture['contacts'][number];
      const truth = expected.snappedWorld as number[];
      const apart = Math.hypot(
        contact.position[0] - (truth[0] as number),
        contact.position[1] - (truth[1] as number),
        contact.position[2] - (truth[2] as number)
      );
      // Five micrometres, and the reason it is not zero: the fixture's samples come from numpy's
      // `exp`/`sin` rounded by `np.rint`, and this phantom's from JavaScript's, rounded by
      // `Math.round`. A voxel whose value lands within an ULP of a half rounds the other way in one
      // of them, which moves an intensity-weighted centroid by a fraction of a micrometre. It is
      // four orders of magnitude below the thing being measured.
      expect(apart, expected.name).toBeLessThan(0.005);
    });
  });

  it('lands nearer the authored contact centre than it started, every time', () => {
    // The property that matters, and the one a user judges: a snap is an improvement. The residual
    // is not zero — a 1.5 mm box around a point that is already 0.5 mm off a Gaussian blob is not
    // symmetric about the blob, so the weighted centroid keeps a fraction of the miss.
    for (const expected of FIXTURE.contacts) {
      expect(expected.errorToContactMm, expected.name).toBeLessThan(expected.shiftMm as number);
      expect(expected.errorToContactMm, expected.name).toBeLessThan(0.25);
      // …from a starting point that really was off the metal.
      expect(expected.shiftMm, expected.name).toBeGreaterThan(0.4);
    }
  });
});

describe('float formatting, against Python’s repr', () => {
  it('writes every value the way `repr` writes it', () => {
    expect(FIXTURE.floats.length).toBeGreaterThan(20);
    for (const { value, repr } of FIXTURE.floats) {
      expect(formatFloat(value), `repr(${repr})`).toBe(repr);
    }
  });

  it('round-trips a table’s coordinates through both languages', () => {
    const set = readSet(FIXTURE.table);
    const source = readFileSync(join(TESTDATA, FIXTURE.table), 'utf8');
    for (const contact of set.contacts as Contact[]) {
      const cells = contact.position.map((v) => formatFloat(v));
      // The generator wrote `repr` too, so the exact strings are in the file.
      expect(source).toContain(cells.join('\t'));
    }
  });
});
