/**
 * P2-10 — `toTemplate`, derived from the NIfTI header alone (§4.3, §4.7's `ProbeResult.mni`).
 *
 * The ownership map lists this under "explicitly **not** gaps": `VolumeMeta.headerJson` already
 * carries `sform_code` / `qform_code`, so no protocol change is needed and the whole feature is this
 * one pure function plus one lookup in `probe()`.
 *
 * The header strings below are the shape `crates/tvx-nifti/src/read.rs`'s `header_json` writes,
 * including its derived `affineSource` field — the reason this test can assert *which* code matters.
 */

import { describe, expect, it } from 'vitest';
import { applyAffine, toTemplateFromHeader } from './fromMeta';

const header = (fields: Record<string, unknown>): string =>
  JSON.stringify({ sform_code: 0, qform_code: 0, affineSource: 'pixdim', ...fields });

describe('toTemplateFromHeader', () => {
  it('claims MNI152 when the affine the reader used has code 4', () => {
    const t = toTemplateFromHeader(header({ sform_code: 4, affineSource: 'sform' }));
    expect(t?.name).toBe('MNI152');
    expect(t?.kind).toBe('affine');
    // World RAS already *is* MNI152 mm for code 4, so the transform is the identity.
    expect([...(t?.matrix ?? [])]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('reads the qform code when the qform is the affine the reader used', () => {
    expect(toTemplateFromHeader(header({ qform_code: 4, affineSource: 'qform' }))?.name).toBe(
      'MNI152'
    );
  });

  it('ignores a code 4 on the form that was NOT used', () => {
    // The trap: sform wins when `sform_code > 0` (`affine_of`), so a stale `qform_code = 4` beside a
    // scanner-anat sform describes a transform nothing applied. Reporting MNI here would put a
    // coordinate in a paper that is wrong by centimetres.
    expect(
      toTemplateFromHeader(header({ sform_code: 2, qform_code: 4, affineSource: 'sform' }))
    ).toBeUndefined();
  });

  it('claims nothing for scanner anat, aligned, or TEMPLATE_OTHER', () => {
    for (const code of [0, 1, 2, 3, 5]) {
      expect(
        toTemplateFromHeader(header({ sform_code: code, affineSource: 'sform' })),
        `sform_code ${code}`
      ).toBeUndefined();
    }
  });

  it('claims nothing when the affine came from pixdim, whatever the codes say', () => {
    expect(toTemplateFromHeader(header({ sform_code: 4 }))).toBeUndefined();
  });

  it('survives a header that is not JSON rather than throwing inside a load', () => {
    expect(toTemplateFromHeader('')).toBeUndefined();
    expect(toTemplateFromHeader('{ not json')).toBeUndefined();
  });
});

describe('applyAffine', () => {
  it('is a column-major mat4 times a point, translation included', () => {
    // Column-major (§3): columns are [1,0,0,0], [0,2,0,0], [0,0,3,0], [10,20,30,1].
    const m = Float32Array.from([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 10, 20, 30, 1]);
    expect(applyAffine(m, [1, 1, 1])).toEqual([11, 22, 33]);
  });

  it('is the identity for the identity — which is what an MNI152 volume reports', () => {
    const i = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(applyAffine(i, [-42.5, 18, 6.25])).toEqual([-42.5, 18, 6.25]);
  });
});
