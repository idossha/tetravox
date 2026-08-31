/**
 * `<stem>_editlog.json` — the provenance sidecar a save writes beside the table.
 *
 * **It is a contract with another program, not a log.** `seegprep`'s CLI globs
 * `<derivatives>/sub-<id>/ieeg/*_electrodes_editlog.json` and refuses to overwrite a subject that
 * has one unless `--force` (`seegprep/cli.py::_editlog_files`), so the file's *name* is the signal
 * and the counts inside it are what a reader checks first. Every key Slicer's editor wrote is
 * written here with the same name and the same meaning — `edited_utc`, `source_tsv`, `output_tsv`,
 * `backup`, `n_electrodes`, `n_contacts`, `added`, `edited`, `tool` — so a pipeline that already
 * parses one keeps working.
 *
 * **What is new is the per-contact diff.** Slicer wrote counts only, which answers "was this
 * hand-edited?" and not "what was changed?" — and the second question is the one a reviewer asks
 * three months later when the electrode is in a paper. Each entry names the contact, its electrode,
 * where it was, where it is, and how far that is; a deletion has no `to` and an addition has no
 * `from`. Counts stay beside them so the two can never disagree.
 *
 * **A relabel is a change even when nothing moved** (2026-08-30). Renumber and Re-fit rewrite names
 * and ordinals; a diff keyed on position alone reported `added: 0`, `edited: 0` and no entries at all
 * for the one edit that changes how a table's `csc` column maps onto the recording system. The
 * `renamed` change and the `renamed_from` field are additive beside Slicer's keys.
 */

import type { vec3 } from '@tetravox/engine';
import type { Contact, ContactSet } from './model';
import { hasMoved, shiftMm, wasRenamed } from './model';

export const EDITLOG_SCHEMA = 'tetravox.contacts/editlog@1';

/**
 * `renamed` is the fourth change, added 2026-08-30.
 *
 * A renumber rewrites names and ordinals and moves nothing, so it used to produce an editlog with
 * `added: 0`, `edited: 0` and no contact entries at all — silent about the one edit that rewires a
 * table's `csc`/channel mapping. It is a *change kind* rather than a flag on `edited` because a
 * contact can be renamed without moving, and the old→new pair is the thing a reader needs.
 */
export type EditlogChange = 'added' | 'edited' | 'deleted' | 'renamed';

export interface EditlogEntry {
  name: string;
  electrode: string;
  contact: number;
  change: EditlogChange;
  from?: [number, number, number];
  to?: [number, number, number];
  /** Euclidean, millimetres. Absent for an addition and a deletion. */
  shift_mm?: number;
  /** The name the table had, when a re-fit or a renumber changed it. */
  renamed_from?: string;
}

export interface EditlogElectrode {
  name: string;
  n_contacts: number;
  refit: boolean;
  renumbered: boolean;
  snapped: boolean;
}

export interface Editlog {
  schema: string;
  edited_utc: string;
  tool: string;
  source_tsv: string | null;
  output_tsv: string;
  backup: string | null;
  n_electrodes: number;
  n_contacts: number;
  added: number;
  edited: number;
  /**
   * How many contacts a relabel renamed without moving (2026-08-30).
   *
   * Additive beside the counts Slicer's editor wrote: a reader that knows only `added` / `edited` /
   * `deleted` is unaffected, and a log written before this key existed reads as zero, which is what
   * it was. The schema string does not move for it.
   */
  renamed: number;
  deleted: number;
  kept: number;
  snap_radius_mm: number;
  electrodes: EditlogElectrode[];
  contacts: EditlogEntry[];
}

/** A contact that was in the file and is not in the set any more. */
export interface DeletedContact {
  name: string;
  group: string;
  ordinal: number;
  position: vec3;
}

/** What the module remembers about which operations touched which electrode. */
export interface OperationRecord {
  refit: ReadonlySet<string>;
  renumbered: ReadonlySet<string>;
  snapped: ReadonlySet<string>;
}

export interface EditlogInput {
  set: ContactSet;
  deleted: readonly DeletedContact[];
  sourceTsv: string | null;
  outputTsv: string;
  backup: string | null;
  snapRadiusMm: number;
  tool: string;
  operations: OperationRecord;
  /** Injected so a test pins the timestamp rather than the clock. */
  now?: Date;
}

function triple(p: vec3): [number, number, number] {
  return [p[0], p[1], p[2]];
}

function entryFor(contact: Contact): EditlogEntry | null {
  if (contact.original === null) {
    return {
      name: contact.name,
      electrode: contact.group,
      contact: contact.ordinal,
      change: 'added',
      to: triple(contact.position),
    };
  }
  const renamedFrom = wasRenamed(contact) ? (contact.originalName as string) : null;
  // Moved and renamed is **one** entry: a re-fit does both to the same contact, and two entries for
  // it would make the counts beside them disagree with the rows.
  if (!hasMoved(contact)) {
    if (renamedFrom === null) return null;
    return {
      name: contact.name,
      electrode: contact.group,
      contact: contact.ordinal,
      change: 'renamed',
      renamed_from: renamedFrom,
      to: triple(contact.position),
    };
  }
  return {
    name: contact.name,
    electrode: contact.group,
    contact: contact.ordinal,
    change: 'edited',
    from: triple(contact.original),
    to: triple(contact.position),
    shift_mm: shiftMm(contact),
    ...(renamedFrom === null ? {} : { renamed_from: renamedFrom }),
  };
}

/** `YYYY-MM-DDTHH:MM:SSZ` — seconds precision, the form Slicer's editor wrote. */
export function utcSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

export function buildEditlog(input: EditlogInput): Editlog {
  const contacts: EditlogEntry[] = [];
  let added = 0;
  let edited = 0;
  let renamed = 0;
  let kept = 0;
  for (const contact of input.set.contacts) {
    const entry = entryFor(contact);
    if (entry === null) {
      kept += 1;
      continue;
    }
    if (entry.change === 'added') added += 1;
    else if (entry.change === 'renamed') renamed += 1;
    else edited += 1;
    // A contact that moved *and* was relabelled is one `edited` row carrying `renamed_from`, so the
    // rename count is "renamed and nothing else" — the sum of the four counts is still the number
    // of rows, which is what makes the counts and the diff impossible to disagree.
    contacts.push(entry);
  }
  for (const gone of input.deleted) {
    contacts.push({
      name: gone.name,
      electrode: gone.group,
      contact: gone.ordinal,
      change: 'deleted',
      from: triple(gone.position),
    });
  }

  const electrodes: EditlogElectrode[] = input.set.groups.map((group) => ({
    name: group.name,
    n_contacts: input.set.contacts.filter((c) => c.group === group.name).length,
    refit: input.operations.refit.has(group.name),
    renumbered: input.operations.renumbered.has(group.name),
    snapped: input.operations.snapped.has(group.name),
  }));

  return {
    schema: EDITLOG_SCHEMA,
    edited_utc: utcSeconds(input.now ?? new Date()),
    tool: input.tool,
    source_tsv: input.sourceTsv,
    output_tsv: input.outputTsv,
    backup: input.backup,
    n_electrodes: input.set.groups.length,
    n_contacts: input.set.contacts.length,
    added,
    edited,
    renamed,
    deleted: input.deleted.length,
    kept,
    snap_radius_mm: input.snapRadiusMm,
    electrodes,
    contacts,
  };
}

/** The text to write: two-space JSON with a trailing newline, like `json.dump(…, indent=2)`. */
export function formatEditlog(log: Editlog): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}

/**
 * The date an existing editlog records, for the "hand-edited on …" banner — or `null`.
 *
 * Deliberately tolerant: the file may have been written by Slicer's editor (no `schema`, counts
 * only) or by a later version of this one, and all the banner needs is the timestamp. Anything it
 * cannot read is "there is an editlog and it does not say when", which is still worth showing.
 */
export function editlogDate(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const when = (parsed as { edited_utc?: unknown }).edited_utc;
    return typeof when === 'string' && when !== '' ? when : null;
  } catch {
    return null;
  }
}
