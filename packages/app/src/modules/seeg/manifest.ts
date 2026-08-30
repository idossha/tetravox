/**
 * `tetravox.seeg` — the sEEG contact editor (ARCHITECTURE.md §13).
 *
 * The first product module: an Inputs → Edit → Save loop over a BIDS-iEEG `electrodes.tsv` and the
 * registered CT it was localised on, reproducing the 3D Slicer `SEEGContactEditor` a lab already
 * uses (`seegprep/slicer/SEEGContactEditor/`) inside Tetravox's own panes.
 *
 * **Data only**, like every manifest: type annotations and object literals, no DOM type and no
 * import outside this directory, because `main/job.ts` validates a `type: "module"` job action
 * against `MANIFESTS` before a window exists (§13.6).
 *
 * **Every scene-mutating command is also an operation**, which is §13.6's "there is no
 * automation-only code path" applied to a module: the `operations` below are what a job file drives,
 * and each one is the same function the panel's button calls. The commands that are *not* operations
 * are the ones with no meaning without a person, and there is a rule rather than a list: a command
 * that needs a **live pointer** (`add` arms place mode), a **file sheet** (`save-as`), the session's
 * own **undo stack** (`undo`, `redo`), or that only moves the **selection** (`next`, `prev`) has
 * nothing to do in a batch run; `snap-electrode` and `snap-all` are the `snap` operation's `scope`.
 * `modules.test.ts` holds this manifest to that rule, so a scene-mutating command added without an
 * operation fails the build rather than becoming an automation-only gap.
 *
 * **Command ids are kebab-case, not camelCase.** `modules.test.ts` requires every contributed id to
 * match `^[a-z][a-z0-9-]*$` — the shape the host namespaces as `<moduleId>/<id>` — so `snap-electrode`
 * rather than `snapElectrode`. The **operation** ids, which are the half §13.6's job envelope names,
 * are unaffected.
 *
 * **The sibling patterns are the `seegprep` derivative layout.** The templates are duplicated in
 * `renderer/src/modules/seeg/bids.ts`, which is what a data-only manifest costs; `modules/seeg.test.ts`
 * asserts the two agree, so a typo fails a test rather than quietly disabling a sibling.
 */

import type { ModuleManifest } from '../manifest-types';

export const seegManifest: ModuleManifest = {
  id: 'tetravox.seeg',
  title: 'sEEG contacts',
  version: '0.1.0',
  hostApi: 1,
  docs: 'sEEG contacts',
  activation: ['onToggle', 'onReader', 'onSibling', 'onSceneBlock'],
  commands: [
    { id: 'add', title: 'Add contacts (place mode)', key: 'a' },
    { id: 'snap', title: 'Snap selected contact to metal', key: 's', when: 'selection' },
    { id: 'snap-electrode', title: 'Snap electrode to metal', key: 's', shift: true },
    { id: 'snap-all', title: 'Snap all electrodes to metal…' },
    { id: 'next', title: 'Next contact', key: 'n' },
    { id: 'prev', title: 'Previous contact', key: 'p' },
    { id: 'refit', title: 'Re-fit shaft', key: 'f' },
    { id: 'renumber', title: 'Renumber tip-first' },
    { id: 'flip-tip', title: 'Flip tip end', key: 't' },
    { id: 'ghost', title: 'Contacts visible through slices', key: 'g' },
    { id: 'delete', title: 'Delete selected contact', key: 'Delete', when: 'selection' },
    { id: 'undo', title: 'Undo', key: 'z' },
    { id: 'redo', title: 'Redo', key: 'z', shift: true },
    { id: 'load', title: 'Open electrodes table…' },
    { id: 'save', title: 'Save electrodes table' },
    { id: 'save-as', title: 'Save electrodes table as…' },
    { id: 'revert', title: 'Revert to loaded positions' },
  ],
  readers: [
    {
      id: 'electrodes',
      title: 'Electrode tables',
      extensions: ['tsv', 'csv', 'fcsv'],
      // `.tsv` alone is far too broad — a BIDS dataset is full of them — so the basename has to say
      // what it is. Matched against the basename, never the whole path (`modules/readers.ts`).
      match: '(electrodes|contacts|markups)',
    },
  ],
  siblings: [
    {
      // The registered CT. `{id}` is nested inside `{sub}` because SimNIBS names its model directory
      // `m2m_<id>` without the `sub-` prefix.
      from: '^(?<sub>sub-(?<id>[A-Za-z0-9]+))_acq-bone_space-(?<space>[A-Za-z0-9]+)_ct\\.nii(\\.gz)?$',
      candidates: [
        '../ieeg/{sub}_space-{space}_electrodes.tsv',
        '../ieeg/{sub}_space-{space}_coordsystem.json',
        '../ieeg/{sub}_space-{space}_electrodes_editlog.json',
        '../../../SimNIBS/{sub}/m2m_{id}/T1.nii.gz',
      ],
    },
    {
      from: '^(?<sub>sub-(?<id>[A-Za-z0-9]+))_space-(?<space>[A-Za-z0-9]+)_electrodes\\.tsv$',
      candidates: [
        '../ct/{sub}_acq-bone_space-{space}_ct.nii.gz',
        '{sub}_space-{space}_coordsystem.json',
        '{stem}_editlog.json',
      ],
    },
  ],
  writers: [
    {
      id: 'electrodes',
      title: 'Save electrodes table',
      filters: [{ name: 'BIDS electrodes table', extensions: ['tsv'] }],
      // The two files a save writes beside the table it was given: the backup of what was there, and
      // the provenance sidecar `seegprep`'s --force guard looks for.
      siblings: ['{name}.{stamp}.bak', '{stem}_editlog.json'],
      backup: 'timestamped',
    },
  ],
  operations: [
    // `t1` is `'path?'` (2026-08-30, at the merge): §13.6's `ArgType` gained the optional path form
    // for exactly this argument. A `path?` is `${VAR}`-expanded, resolved against the job file's
    // directory and allow-listed before the window opens; a `string?` would have named a file the
    // module is told about and main never admitted, which is the wrong promise to make about a T1.
    //
    // What the module does with it: a module cannot open a dataset, so `t1` names a volume the job
    // has **already opened** (`scene.files`, or an earlier `open` action). `load` gives that layer
    // the T1 half of the display preset — visible, grey, opaque: the anatomy the CT's 150 HU floor
    // exists to reveal — and records the file in the scene block's `source`. When it is not open the
    // operation reports `{ t1: 'not-open' }` and everything else it did still stands, so a job
    // author learns which file the scene is missing instead of getting contacts over nothing.
    { id: 'load', args: { ct: 'path', tsv: 'path', t1: 'path?' } },
    // `scope` is contact | electrode | all.
    {
      id: 'snap',
      args: { scope: 'string', electrode: 'string?', contact: 'string?', radiusMm: 'number?' },
    },
    { id: 'refit', args: { electrode: 'string?' } },
    { id: 'renumber', args: { electrode: 'string?' } },
    { id: 'ghost', args: { on: 'boolean' } },
    { id: 'stats', args: {} },
    { id: 'save', args: { out: 'out' } },
    // Appended 2026-08-30. `tip: 'auto'` is a heuristic — DECISIONS says an occipital shaft entering
    // near the midline defeats it — and `renumber` applies whatever the tip currently is, so without
    // a way to flip it a job could number a shaft tip-last and had no remedy at all short of an
    // interactive session that saved a scene first. `revert` and `delete` are here for the same
    // reason: both are deterministic, neither needs a person, and a batch pipeline that can localise
    // but cannot drop an artefact contact is a pipeline with a hole in it.
    { id: 'flip-tip', args: { electrode: 'string?' } },
    { id: 'revert', args: {} },
    // Named, never "the selected one": a job has no selection to speak of. Matches the table's own
    // contact name (`LINS01`) or the id the scene block keys on.
    { id: 'delete', args: { contact: 'string' } },
  ],
  sceneBlock: { version: 1 },
};
