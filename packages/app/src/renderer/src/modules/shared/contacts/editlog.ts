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
 */

import type { vec3 } from '@tetravox/engine';
import type { Contact, ContactSet } from './model';
import { hasMoved, shiftMm } from './model';

export const EDITLOG_SCHEMA = 'tetravox.contacts/editlog@1';

export type EditlogChange = 'added' | 'edited' | 'deleted';

export interface EditlogEntry {
  name: string;
  electrode: string;
  contact: number;
  change: EditlogChange;
  from?: [number, number, number];
  to?: [number, number, number];
  /** Euclidean, millimetres. Absent for an addition and a deletion. */
  shift_mm?: number;
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
  if (!hasMoved(contact)) return null;
  return {
    name: contact.name,
    electrode: contact.group,
    contact: contact.ordinal,
    change: 'edited',
    from: triple(contact.original),
    to: triple(contact.position),
    shift_mm: shiftMm(contact),
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
  let kept = 0;
  for (const contact of input.set.contacts) {
    const entry = entryFor(contact);
    if (entry === null) {
      kept += 1;
      continue;
    }
    if (entry.change === 'added') added += 1;
    else edited += 1;
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
