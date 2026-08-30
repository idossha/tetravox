/**
 * The BIDS derivative layout a `seegprep` subject has, and what it means for this module.
 *
 * `seegprep` writes a fixed shape (`seegprep/io/layout.py`, and Slicer's `_resolveInputs`):
 *
 * ```text
 * <bids>/derivatives/seegprep/sub-<id>/ct/sub-<id>_acq-bone_space-T1w_ct.nii.gz
 * <bids>/derivatives/seegprep/sub-<id>/ieeg/sub-<id>_space-T1w_electrodes.tsv
 * <bids>/derivatives/seegprep/sub-<id>/ieeg/sub-<id>_space-T1w_coordsystem.json
 * <bids>/derivatives/SimNIBS/sub-<id>/m2m_<id>/T1.nii.gz
 * ```
 *
 * so opening either of the first two is enough to find the other, and the manifest declares the
 * patterns that say so (`packages/app/src/modules/seeg/manifest.ts`). This file is the module's half
 * of that: the template strings the manifest and the module have to agree on, and what a resolved
 * candidate *means*.
 *
 * **The templates are duplicated on purpose, and a test pins the duplication.** A manifest is
 * data-only TypeScript that main imports before a window exists (§13.1), so it cannot import a
 * renderer file; and this file cannot be the manifest, because a manifest is data. So the strings
 * appear twice and `modules/seeg.test.ts` asserts they are the same strings — which is the only
 * arrangement in which a typo fails a test rather than silently disabling a sibling.
 */

/** Templates the CT anchors. Keys of the `Record` `host.files.siblings` and `onSibling` hand over. */
export const FROM_CT_TSV = '../ieeg/{sub}_space-{space}_electrodes.tsv';
export const FROM_CT_COORDSYSTEM = '../ieeg/{sub}_space-{space}_coordsystem.json';
export const FROM_CT_EDITLOG = '../ieeg/{sub}_space-{space}_electrodes_editlog.json';
export const FROM_CT_T1 = '../../../SimNIBS/{sub}/m2m_{id}/T1.nii.gz';

/** Templates the electrodes table anchors. */
export const FROM_TSV_CT = '../ct/{sub}_acq-bone_space-{space}_ct.nii.gz';
export const FROM_TSV_COORDSYSTEM = '{sub}_space-{space}_coordsystem.json';
export const FROM_TSV_EDITLOG = '{stem}_editlog.json';

/** What a bundle probe found beside the anchor. Every field is a path or `null`. */
export interface SubjectBundle {
  tsv: string | null;
  ct: string | null;
  t1: string | null;
  coordsystem: string | null;
  editlog: string | null;
}

const EMPTY: SubjectBundle = { tsv: null, ct: null, t1: null, coordsystem: null, editlog: null };

/**
 * Read a `host.files.siblings` result — keyed by the manifest's own templates — as a bundle.
 *
 * A template that is not in the record, or whose value is `null`, is "not there"; the two are the
 * same answer to this module and different only to the host, which distinguishes "no rule for this
 * anchor" from "declared, probed, missing".
 */
export function bundleOf(found: Record<string, string | null>): SubjectBundle {
  const at = (...templates: string[]): string | null => {
    for (const template of templates) {
      const path = found[template];
      if (typeof path === 'string' && path !== '') return path;
    }
    return null;
  };
  return {
    tsv: at(FROM_CT_TSV),
    ct: at(FROM_TSV_CT),
    t1: at(FROM_CT_T1),
    coordsystem: at(FROM_CT_COORDSYSTEM, FROM_TSV_COORDSYSTEM),
    editlog: at(FROM_CT_EDITLOG, FROM_TSV_EDITLOG),
  };
}

/** Is there anything in this bundle at all? */
export function bundleIsEmpty(bundle: SubjectBundle): boolean {
  return (Object.keys(EMPTY) as (keyof SubjectBundle)[]).every((key) => bundle[key] === null);
}

/** The basename of a path, on either platform's separator. */
export function baseNameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? '';
}

/** The basename without its extension chain: `sub-01_electrodes.tsv` → `sub-01_electrodes`. */
export function stemOf(name: string): string {
  return name.replace(/(\.[A-Za-z0-9]+)+$/, '');
}

/**
 * `<stem>_editlog.json` beside `tsvPath`.
 *
 * The name is the contract: `seegprep`'s CLI globs `*_electrodes_editlog.json` and refuses to
 * overwrite a hand-edited subject unless `--force`, so an editlog whose stem does not end in
 * `_electrodes` is a file nothing will ever look at.
 */
export function editlogNameFor(tsvName: string): string {
  return `${stemOf(tsvName)}_editlog.json`;
}

/**
 * Whether saving under this name will produce an editlog `seegprep` finds.
 *
 * Two things have to be true, and the warning names whichever is not: the stem ends in
 * `_electrodes`, and the file sits in an `ieeg/` directory. Both come straight from
 * `seegprep/cli.py::_editlog_files`, which looks in `<deriv>/sub-<id>/ieeg` for that glob.
 */
export function seegprepWarning(path: string): string | null {
  const name = baseNameOf(path);
  const stem = stemOf(name);
  const directory = /(?:^|[/\\])ieeg[/\\][^/\\]+$/.test(path);
  if (!stem.endsWith('_electrodes')) {
    return (
      `“${name}” does not end in _electrodes.tsv, so seegprep’s --force guard will not see its ` +
      `editlog (it globs *_electrodes_editlog.json).`
    );
  }
  if (!directory) {
    return (
      `“${name}” is not in an ieeg/ directory, so seegprep will not find its editlog ` +
      `(it looks in <derivatives>/sub-<id>/ieeg).`
    );
  }
  return null;
}

/** `sub-P076` out of a path, for the panel's source line. `null` when there is none. */
export function subjectOf(path: string): string | null {
  const match = /(?:^|[/\\])(sub-[A-Za-z0-9]+)(?=[/\\_])/.exec(path);
  return match === null ? null : (match[1] as string);
}
