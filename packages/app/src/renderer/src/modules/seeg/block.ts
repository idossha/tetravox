/**
 * The module's scene block — `ViewSpec.extensions['tetravox.seeg']` (ARCHITECTURE.md §13.2).
 *
 * **What the layer cannot carry.** The contacts themselves are ordinary `PointsLayer` points, so a
 * build without this module still draws them and still round-trips them. What a `points[]` entry has
 * no field for is *provenance*: which file the contact came from, where that file put it, what its
 * `status` cell said, and every other cell of its row. Without those, reopening a scene and pressing
 * Save would write a table in which every contact was `added` and every original column was gone.
 *
 * **Three rules make the block portable**, and each is checked here rather than assumed:
 *
 *  * it holds **no `LayerId` and no `DatasetId`** — both are reassigned on load, so it is keyed by
 *    `points[].id` and finds its layer by `LayerBase.module` instead;
 *  * it is **≤ 256 KiB of JSON**, enforced by the host. A 103-contact table is about 20 kB; a
 *    5 000-row one with seventeen columns is not, so {@link shrinkBlock} drops the per-row `extra`
 *    first and the whole `rows` map second, in that order, because losing the original columns is
 *    worse than losing nothing and better than losing the block;
 *  * a block **this build cannot read is not this build's to break** — `fromBlock` validates the
 *    shape of everything it uses and ignores everything it does not, so a newer module's extra keys
 *    survive a round trip through an older one only in the sense that they are dropped, never
 *    misread.
 */

import type { vec3, vec4 } from '@tetravox/engine';
import type { Contact, ContactSet, TipEnd } from '../shared/contacts/model';
import type { ColumnMap, Delimiter } from '../shared/contacts/tsv';
import { paletteColor } from '../shared/contacts/palette';
import { CONTACT_DOT_RADIUS_PX } from '../shared/contacts/layer';

/** `manifest.sceneBlock.version`. Bumping it means an older build's block needs migrating. */
export const SEEG_BLOCK_VERSION = 1;

export interface SeegBlockSource {
  /** The table this set was read from. `null` after a degraded restore — Save becomes Save as…. */
  tsv: string | null;
  coordsystem: string | null;
  /**
   * The T1 these contacts are being read against, when a `load` operation named one that was already
   * open (§13.6's `t1: 'path?'`). **Additive and optional**: absent is exactly what every block
   * written before this field existed says, and it restores to the same state, which is why
   * `sceneBlock.version` is still 1. It is provenance, not a dependency — nothing reopens from it,
   * because a module cannot open a dataset.
   */
  t1?: string | null;
  /** The file's header, in its own order, so the writer can reproduce it. */
  fieldnames: string[];
  columns: ColumnMap;
  delimiter: Delimiter;
}

export interface SeegBlockRow {
  original: [number, number, number] | null;
  /**
   * The name the **table** gave this contact (`Contact.originalName`), or `null` for one placed in
   * the session. Additive, 2026-08-30: a block written before it says `null`, which restores to the
   * previous behaviour — a rebuilt contact whose name is not known to have changed — so
   * `sceneBlock.version` is still 1. Without it a renumber made before a scene save is invisible to
   * the editlog written after the scene is reopened.
   */
  name: string | null;
  status: string | null;
  extra: Record<string, string>;
}

/**
 * A contact this session deleted, kept in the block so the record of it survives the slot.
 *
 * The deletion itself lives in the layer — the point is simply gone — but *that it was deleted* is
 * provenance, and provenance is what this block is for. Without it, switching module and coming
 * back, or saving and reopening the scene, writes an editlog claiming nothing was deleted while the
 * table it sits beside is missing the rows, and Revert quietly stops being able to bring them back
 * after promising it would.
 */
export interface SeegBlockDeleted {
  /** `points[].id` — the identity the contact had, so an undo/redo cycle keeps naming the same one. */
  id: string;
  name: string;
  group: string;
  ordinal: number;
  /** Where it was when it was deleted; `row.original` is where the file had put it. */
  position: [number, number, number];
  row: SeegBlockRow;
}

export interface SeegBlockElectrode {
  name: string;
  color: vec4;
  tip: TipEnd;
}

export interface SeegBlock {
  source: SeegBlockSource | null;
  /** Keyed by `points[].id` — never a `LayerId`, never a `DatasetId` (§13.2). */
  rows: Record<string, SeegBlockRow>;
  electrodes: SeegBlockElectrode[];
  /**
   * The contacts the session deleted (2026-08-30). Additive, and absent restores to what this build
   * did before it existed — an empty list — so `sceneBlock.version` is still 1.
   */
  deleted: SeegBlockDeleted[];
  snapRadiusMm: number;
  namePad: number;
  ghost: boolean;
  /**
   * The panel's two other display switches (2026-08-30). Both additive: a block written without
   * them restores to what this build did before they existed — the wire drawn, the marker at the
   * engine's own 4 px — so `sceneBlock.version` is still 1.
   *
   * They are here rather than left to the layer for the same reason `ghost` is: `wire: false`
   * writes an **empty** `lineSegments`, and §4.6 does not serialise that array at all, so a scene
   * reopened without the block would put every shaft back and a figure saved without them would
   * not reproduce.
   */
  wire: boolean;
  /** §4.4's `dotRadiusPx`, in CSS pixels. */
  dotRadiusPx: number;
}

export interface BlockInput {
  set: ContactSet;
  /** What `doDelete` has taken out of the set so far, in the order it took them. */
  deleted: readonly Contact[];
  source: SeegBlockSource | null;
  snapRadiusMm: number;
  namePad: number;
  ghost: boolean;
  wire: boolean;
  dotRadiusPx: number;
}

function rowOf(contact: Contact): SeegBlockRow {
  return {
    original:
      contact.original === null
        ? null
        : [contact.original[0], contact.original[1], contact.original[2]],
    name: contact.originalName,
    status: contact.loadedStatus,
    extra: contact.extra,
  };
}

/** Everything the module needs to resume, and nothing the scene already holds. */
export function toBlock(input: BlockInput): SeegBlock {
  const rows: Record<string, SeegBlockRow> = {};
  for (const contact of input.set.contacts) rows[contact.id] = rowOf(contact);
  return {
    source: input.source,
    rows,
    electrodes: input.set.groups.map((g) => ({ name: g.name, color: g.color, tip: g.tip })),
    deleted: input.deleted.map((contact) => ({
      id: contact.id,
      name: contact.name,
      group: contact.group,
      ordinal: contact.ordinal,
      position: [contact.position[0], contact.position[1], contact.position[2]],
      row: rowOf(contact),
    })),
    snapRadiusMm: input.snapRadiusMm,
    namePad: input.namePad,
    ghost: input.ghost,
    wire: input.wire,
    dotRadiusPx: input.dotRadiusPx,
  };
}

/**
 * The same block with less in it, for a set too large for §13.2's 256 KiB.
 *
 * `level` 1 drops the original columns — the table can still be saved, with its own four columns
 * plus the three this module appends. `level` 2 drops the row map entirely, which loses `original`
 * and turns every contact into an `added` one; the module says so rather than pretending.
 */
export function shrinkBlock(block: SeegBlock, level: 1 | 2): SeegBlock {
  const trim = (row: SeegBlockRow): SeegBlockRow => ({
    original: row.original,
    name: row.name,
    status: row.status,
    extra: {},
  });
  if (level === 1) {
    const rows: Record<string, SeegBlockRow> = {};
    for (const [id, row] of Object.entries(block.rows)) rows[id] = trim(row);
    return {
      ...block,
      rows,
      deleted: block.deleted.map((gone) => ({ ...gone, row: trim(gone.row) })),
    };
  }
  // Level 2 loses `original` for every contact, so the deletion records go with it: an editlog
  // entry for a contact whose position is unknown would be worse than the missing entry.
  return { ...block, rows: {}, deleted: [] };
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, cell] of Object.entries(value as Record<string, unknown>)) {
    if (typeof cell === 'string') out[key] = cell;
  }
  return out;
}

function columnMapOf(value: unknown): ColumnMap {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof raw[key] === 'string' ? (raw[key] as string) : null;
  return {
    name: pick('name'),
    x: pick('x'),
    y: pick('y'),
    z: pick('z'),
    electrode: pick('electrode'),
    contact: pick('contact'),
    status: pick('status'),
  };
}

const DELIMITERS: readonly Delimiter[] = ['tab', 'comma', 'semicolon', 'whitespace'];

function sourceOf(value: unknown): SeegBlockSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const delimiter = DELIMITERS.find((d) => d === raw['delimiter']) ?? 'tab';
  return {
    tsv: typeof raw['tsv'] === 'string' ? raw['tsv'] : null,
    coordsystem: typeof raw['coordsystem'] === 'string' ? raw['coordsystem'] : null,
    // A block from before this field, or one written with no T1, reads back as `null` — the same
    // "there isn't one" the module started from.
    t1: typeof raw['t1'] === 'string' ? raw['t1'] : null,
    fieldnames: Array.isArray(raw['fieldnames'])
      ? (raw['fieldnames'] as unknown[]).filter((f): f is string => typeof f === 'string')
      : [],
    columns: columnMapOf(raw['columns']),
    delimiter,
  };
}

/** One row of the block, read tolerantly: every field defaults rather than throwing. */
function rowFrom(value: unknown): SeegBlockRow {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    original: isFiniteTriple(row['original']) ? row['original'] : null,
    name: typeof row['name'] === 'string' ? row['name'] : null,
    status: typeof row['status'] === 'string' ? row['status'] : null,
    extra: stringRecord(row['extra']),
  };
}

const TIPS: readonly TipEnd[] = ['auto', 'low', 'high'];

/**
 * Read a block written by this module, tolerantly.
 *
 * `null` only when `data` is not an object at all. Everything else is defaulted, because §13.2 says
 * the *envelope* is validated strictly and `data` is not inspected by the host — so a block whose
 * `snapRadiusMm` arrived as a string is a bad field, not a module crash on file open.
 */
export function fromBlock(data: unknown): SeegBlock | null {
  if (typeof data !== 'object' || data === null) return null;
  const raw = data as Record<string, unknown>;

  const rows: Record<string, SeegBlockRow> = {};
  const rawRows = typeof raw['rows'] === 'object' && raw['rows'] !== null ? raw['rows'] : {};
  for (const [id, value] of Object.entries(rawRows as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    rows[id] = rowFrom(value);
  }

  // A block written before deletions were carried has no `deleted` key and reads back as none,
  // which is the state this build used to restore to.
  const deleted: SeegBlockDeleted[] = [];
  if (Array.isArray(raw['deleted'])) {
    for (const value of raw['deleted'] as unknown[]) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      const position = entry['position'];
      if (typeof entry['id'] !== 'string' || entry['id'] === '') continue;
      if (typeof entry['name'] !== 'string' || !isFiniteTriple(position)) continue;
      const ordinal = entry['ordinal'];
      deleted.push({
        id: entry['id'],
        name: entry['name'],
        group: typeof entry['group'] === 'string' ? entry['group'] : entry['name'],
        ordinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? Math.trunc(ordinal) : 1,
        position,
        row: rowFrom(entry['row']),
      });
    }
  }

  const electrodes: SeegBlockElectrode[] = [];
  if (Array.isArray(raw['electrodes'])) {
    (raw['electrodes'] as unknown[]).forEach((value, index) => {
      if (typeof value !== 'object' || value === null) return;
      const entry = value as Record<string, unknown>;
      if (typeof entry['name'] !== 'string' || entry['name'] === '') return;
      const color = entry['color'];
      electrodes.push({
        name: entry['name'],
        color:
          Array.isArray(color) && color.length === 4 && color.every((c) => typeof c === 'number')
            ? ([color[0], color[1], color[2], color[3]] as vec4)
            : paletteColor(index),
        tip: TIPS.find((t) => t === entry['tip']) ?? 'auto',
      });
    });
  }

  const snapRadiusMm = raw['snapRadiusMm'];
  const namePad = raw['namePad'];
  const dotRadiusPx = raw['dotRadiusPx'];
  return {
    source: sourceOf(raw['source']),
    rows,
    electrodes,
    deleted,
    snapRadiusMm:
      typeof snapRadiusMm === 'number' && Number.isFinite(snapRadiusMm) ? snapRadiusMm : 1.5,
    namePad: typeof namePad === 'number' && Number.isFinite(namePad) ? Math.trunc(namePad) : 2,
    ghost: raw['ghost'] !== false,
    // `!== false` for the same reason `ghost` uses it: absent means "on", which is what a block
    // written before these keys existed meant. The size is clamped by the caller, which owns the
    // panel's bounds; here it only has to be a number.
    wire: raw['wire'] !== false,
    dotRadiusPx:
      typeof dotRadiusPx === 'number' && Number.isFinite(dotRadiusPx)
        ? dotRadiusPx
        : CONTACT_DOT_RADIUS_PX,
  };
}

/** A deletion record, back as the contact it was — the module's `deleted` list after a restore. */
export function contactFromDeleted(gone: SeegBlockDeleted): Contact {
  return {
    id: gone.id,
    name: gone.name,
    group: gone.group,
    ordinal: gone.ordinal,
    position: [...gone.position] as vec3,
    original: gone.row.original === null ? null : ([...gone.row.original] as vec3),
    originalName: gone.row.name,
    loadedStatus: gone.row.status,
    extra: { ...gone.row.extra },
  };
}

/**
 * Put a block's provenance back onto a set rebuilt from the layer.
 *
 * The layer supplies the positions, the names, the electrodes and the numbering; the block supplies
 * `original`, the loaded `status`, the original row cells, the group colours and the pinned tip. A
 * contact the block does not know — one placed after the scene was written, or a block shrunk under
 * the size cap — keeps its `original: null`, which is the honest answer: nothing says where it was.
 */
export function mergeBlockIntoSet(set: ContactSet, block: SeegBlock): ContactSet {
  const byName = new Map(block.electrodes.map((e) => [e.name, e]));
  return {
    contacts: set.contacts.map((contact) => {
      const row = block.rows[contact.id];
      if (row === undefined) return contact;
      return {
        ...contact,
        original:
          row.original === null ? null : [row.original[0], row.original[1], row.original[2]],
        originalName: row.name,
        loadedStatus: row.status,
        extra: row.extra,
      };
    }),
    groups: set.groups.map((group) => {
      const known = byName.get(group.name);
      return known === undefined ? group : { ...group, color: known.color, tip: known.tip };
    }),
  };
}
