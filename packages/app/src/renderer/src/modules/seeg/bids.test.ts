/**
 * The `seegprep` derivative layout, as this module reads it (§13.4).
 *
 * The warnings are the load-bearing part: `seegprep`'s `--force` guard globs
 * `*_electrodes_editlog.json` inside `<derivatives>/sub-<id>/ieeg`, so a save under any other name is
 * a save whose provenance sidecar nothing will ever look at, and the module has to say so **before**
 * the user has written it. That the sibling *templates* here are the same strings the manifest
 * declares is asserted in `modules/seeg.test.ts`, which can see both.
 */

import { describe, expect, it } from 'vitest';
import {
  baseNameOf,
  bundleIsEmpty,
  bundleOf,
  editlogNameFor,
  FROM_CT_COORDSYSTEM,
  FROM_CT_EDITLOG,
  FROM_CT_T1,
  FROM_CT_TSV,
  FROM_TSV_COORDSYSTEM,
  FROM_TSV_CT,
  FROM_TSV_EDITLOG,
  seegprepWarning,
  stemOf,
  subjectOf,
} from './bids';

const DERIV = '/data/bids/derivatives/seegprep/sub-P076';

describe('bundleOf', () => {
  it('reads what a CT anchor found', () => {
    const bundle = bundleOf({
      [FROM_CT_TSV]: `${DERIV}/ieeg/sub-P076_space-T1w_electrodes.tsv`,
      [FROM_CT_COORDSYSTEM]: `${DERIV}/ieeg/sub-P076_space-T1w_coordsystem.json`,
      [FROM_CT_EDITLOG]: null,
      [FROM_CT_T1]: '/data/bids/derivatives/SimNIBS/sub-P076/m2m_P076/T1.nii.gz',
    });
    expect(bundle.tsv).toBe(`${DERIV}/ieeg/sub-P076_space-T1w_electrodes.tsv`);
    expect(bundle.t1).toBe('/data/bids/derivatives/SimNIBS/sub-P076/m2m_P076/T1.nii.gz');
    expect(bundle.coordsystem).toContain('_coordsystem.json');
    expect(bundle.editlog).toBeNull();
    expect(bundle.ct).toBeNull();
    expect(bundleIsEmpty(bundle)).toBe(false);
  });

  it('reads what a table anchor found, including the editlog beside it', () => {
    const bundle = bundleOf({
      [FROM_TSV_CT]: `${DERIV}/ct/sub-P076_acq-bone_space-T1w_ct.nii.gz`,
      [FROM_TSV_COORDSYSTEM]: null,
      [FROM_TSV_EDITLOG]: `${DERIV}/ieeg/sub-P076_space-T1w_electrodes_editlog.json`,
    });
    expect(bundle.ct).toContain('_ct.nii.gz');
    expect(bundle.editlog).toContain('_editlog.json');
    expect(bundle.tsv).toBeNull();
  });

  it('is empty for an anchor no rule claimed — `{}`, not a record of nulls', () => {
    expect(bundleIsEmpty(bundleOf({}))).toBe(true);
  });
});

describe('names', () => {
  it('takes a whole extension chain off a stem', () => {
    expect(stemOf('sub-P076_space-T1w_electrodes.tsv')).toBe('sub-P076_space-T1w_electrodes');
    expect(stemOf('sub-P076_acq-bone_space-T1w_ct.nii.gz')).toBe('sub-P076_acq-bone_space-T1w_ct');
    expect(baseNameOf('/a/b/c.tsv')).toBe('c.tsv');
    expect(baseNameOf('C:\\a\\b\\c.tsv')).toBe('c.tsv');
  });

  it('builds the editlog name seegprep globs for', () => {
    expect(editlogNameFor('sub-P076_space-T1w_electrodes.tsv')).toBe(
      'sub-P076_space-T1w_electrodes_editlog.json'
    );
  });

  it('finds the subject in a path', () => {
    expect(subjectOf(`${DERIV}/ieeg/sub-P076_space-T1w_electrodes.tsv`)).toBe('sub-P076');
    expect(subjectOf('/data/contacts.tsv')).toBeNull();
  });
});

describe('seegprepWarning', () => {
  it('says nothing about a canonical path', () => {
    expect(seegprepWarning(`${DERIV}/ieeg/sub-P076_space-T1w_electrodes.tsv`)).toBeNull();
  });

  it('warns when the stem does not end in _electrodes', () => {
    const warning = seegprepWarning(`${DERIV}/ieeg/sub-P076_contacts.tsv`);
    expect(warning).toContain('_electrodes.tsv');
    expect(warning).toContain('*_electrodes_editlog.json');
  });

  it('warns when the file is not in an ieeg/ directory', () => {
    const warning = seegprepWarning('/tmp/sub-P076_space-T1w_electrodes.tsv');
    expect(warning).toContain('ieeg/');
  });
});
