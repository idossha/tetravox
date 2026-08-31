/**
 * `ContactSet` — what every implanted-contact module edits (ARCHITECTURE.md §13.1).
 *
 * One flat list of contacts plus one list of the groups they belong to, and nothing about *how* a
 * group's contacts are arranged: an sEEG shaft, a DBS lead and an ECoG grid differ in their
 * geometry, not in what a contact is. See `README.md` for where the line is drawn and what a new
 * module has to supply.
 *
 * **Identity is `Contact.id`, and it is the engine's `points[].id`.** §4.4 says why: the array index
 * is the engine's key and cannot survive a deletion, so a selection, an undo step and a scene block
 * all name a contact by its id. A contact imported from a table gets `c<row>`; one the point tool
 * placed keeps the `p<n>` the engine minted, because renaming it would clear the selection the user
 * is holding.
 *
 * **`original` is provenance, not history.** It is the position the file had, so "did this move?" is
 * a comparison rather than a flag, and `null` means "this contact was not in the file at all". The
 * undo stack is a different thing entirely and lives in the module (`host.history`).
 */

import type { vec3, vec4 } from '@tetravox/engine';

/** What a saved row's `status` cell says. Anything else the file carried is kept verbatim. */
export type ContactStatus = 'kept' | 'edited' | 'added';

/** Which end of a group's line carries contact 1. `'auto'` = decide from geometry each time. */
export type TipEnd = 'auto' | 'low' | 'high';

export interface Contact {
  /** Stable identity, unique within the set. Becomes `points[].id`. */
  id: string;
  /** The contact's label — `LINS01`. Becomes `points[].name`. */
  name: string;
  /** The electrode / lead / grid it belongs to. Becomes `points[].group`. */
  group: string;
  /** 1-based position within `group`; 1 is the deepest contact. Becomes `points[].ordinal`. */
  ordinal: number;
  position: vec3;
  /** Where the file put it, or `null` for a contact added in this session. */
  original: vec3 | null;
  /**
   * The **name** the file gave it, or `null` for a contact added in this session.
   *
   * The twin of `original` and there for the same reason: a renumber rewrites `name` and `ordinal`
   * and moves nothing, so without this the one edit that rewires a table's `csc`/channel mapping
   * produces a diff of nothing at all — `added: 0`, `edited: 0`, no contact entries — and the panel
   * footer says "0 changed" beside a dirty dot. `null` is not "unchanged": it is "there was no row
   * behind this contact", exactly as it is for `original`.
   */
  originalName: string | null;
  /** The `status` cell the file carried, or `null`. Preserved on a contact that did not move. */
  loadedStatus: string | null;
  /** Every other cell of the row this contact came from, by the file's own column name. */
  extra: Record<string, string>;
}

export interface Group {
  name: string;
  color: vec4;
  tip: TipEnd;
}

export interface ContactSet {
  contacts: Contact[];
  groups: Group[];
}

/** Below this the two positions are the same contact — Slicer's save tolerance, in millimetres. */
export const MOVED_TOLERANCE_MM = 1e-3;

/** The L1 test Slicer's save uses: `|dx| + |dy| + |dz| > 1e-3`. */
export function hasMoved(contact: Contact): boolean {
  const from = contact.original;
  if (from === null) return false;
  const p = contact.position;
  const l1 = Math.abs(from[0] - p[0]) + Math.abs(from[1] - p[1]) + Math.abs(from[2] - p[2]);
  return l1 > MOVED_TOLERANCE_MM;
}

/**
 * What this contact's `status` cell should say now.
 *
 * `added` for a contact the file never had, `edited` for one that moved, and otherwise `kept` —
 * except that a row which arrived with a status of its own and has **not** moved keeps it, because
 * overwriting seegprep's `located` / `gapfilled` with `kept` would destroy the localiser's own
 * record of how the contact was found.
 */
export function statusOf(contact: Contact): string {
  if (contact.original === null) return 'added';
  if (hasMoved(contact)) return 'edited';
  const loaded = contact.loadedStatus;
  return loaded !== null && loaded !== '' ? loaded : 'kept';
}

/**
 * Whether a relabel changed this contact's name since the file was read.
 *
 * `false` for a contact the file never had: an added contact has no name to have been renamed
 * *from*, and calling it renamed would double-count it against `added`.
 */
export function wasRenamed(contact: Contact): boolean {
  return contact.originalName !== null && contact.originalName !== contact.name;
}

/** The distance a contact has been moved from where the file put it, or 0. */
export function shiftMm(contact: Contact): number {
  const from = contact.original;
  if (from === null) return 0;
  const p = contact.position;
  return Math.hypot(from[0] - p[0], from[1] - p[1], from[2] - p[2]);
}

/** Every contact of one group, ordered by `ordinal` then by name — the order a panel lists. */
export function contactsOf(set: ContactSet, group: string): Contact[] {
  return set.contacts
    .filter((c) => c.group === group)
    .sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name));
}

/** The group names in the order their first contact appears — the file's own order. */
export function groupNames(set: ContactSet): string[] {
  return set.groups.map((g) => g.name);
}

export function groupOf(set: ContactSet, name: string): Group | null {
  return set.groups.find((g) => g.name === name) ?? null;
}

export function contactById(set: ContactSet, id: string): Contact | null {
  return set.contacts.find((c) => c.id === id) ?? null;
}

/**
 * `<GROUP><ordinal>`, zero-padded to `pad` digits.
 *
 * The padding is the width the **file** used, not a constant: Slicer's relabel wrote `LINS1` over a
 * table whose rows said `LINS01`, so every renamed contact came back as `added` on the next load and
 * the diff was unreadable. `namePadOf` recovers the width; this applies it.
 */
export function contactName(group: string, ordinal: number, pad: number): string {
  return `${group}${String(Math.max(1, Math.trunc(ordinal))).padStart(Math.max(1, pad), '0')}`;
}

/**
 * The digit width the names in a table use, or 2 when they carry no trailing number.
 *
 * The **maximum** width seen, so a file holding `LINS01…LINS14` and `A1…A9` pads to 2 rather than
 * alternating; a file with no numbered names at all gets 2, which is what a clinical table uses.
 */
export function namePadOf(names: readonly string[]): number {
  let pad = 0;
  for (const name of names) {
    const match = /(\d+)$/.exec(name);
    if (match === null) continue;
    pad = Math.max(pad, (match[1] as string).length);
  }
  return pad === 0 ? 2 : pad;
}

/** `LHIP8` → `LHIP` — the fallback when a table has no group column at all (Slicer's rule). */
export function groupFromName(name: string): string {
  const stripped = name.replace(/\d+$/, '');
  return stripped === '' ? name : stripped;
}

/** The trailing number of a contact name, or `null`. */
export function ordinalFromName(name: string): number | null {
  const match = /(\d+)$/.exec(name);
  return match === null ? null : Number.parseInt(match[1] as string, 10);
}

/** A deep-enough copy for an undo snapshot: positions and rows are replaced, never mutated. */
export function cloneSet(set: ContactSet): ContactSet {
  return {
    contacts: set.contacts.map((c) => ({
      ...c,
      position: [...c.position] as vec3,
      original: c.original === null ? null : ([...c.original] as vec3),
      extra: { ...c.extra },
    })),
    groups: set.groups.map((g) => ({ ...g, color: [...g.color] as vec4 })),
  };
}

/** An empty set — what a module holds before anything is loaded. */
export function emptySet(): ContactSet {
  return { contacts: [], groups: [] };
}

/**
 * How many contacts of the set differ from what the file said, plus how many are new.
 *
 * A renamed contact counts (2026-08-30): a renumber changes every name on a shaft and moves
 * nothing, and a footer reading "0 changed" beside the dirty dot is a panel disagreeing with itself
 * about the one edit that rewires the recording system's channel mapping.
 */
export function dirtyCount(set: ContactSet, deleted: number = 0): number {
  let n = deleted;
  for (const contact of set.contacts) {
    if (contact.original === null || hasMoved(contact) || wasRenamed(contact)) n += 1;
  }
  return n;
}
