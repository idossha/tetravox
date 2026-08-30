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

import type { vec4 } from '@tetravox/engine';
import type { ContactSet, TipEnd } from '../shared/contacts/model';
import type { ColumnMap, Delimiter } from '../shared/contacts/tsv';
import { paletteColor } from '../shared/contacts/palette';

/** `manifest.sceneBlock.version`. Bumping it means an older build's block needs migrating. */
export const SEEG_BLOCK_VERSION = 1;

export interface SeegBlockSource {
  /** The table this set was read from. `null` after a degraded restore — Save becomes Save as…. */
  tsv: string | null;
  coordsystem: string | null;
  /** The file's header, in its own order, so the writer can reproduce it. */
  fieldnames: string[];
  columns: ColumnMap;
  delimiter: Delimiter;
}

export interface SeegBlockRow {
  original: [number, number, number] | null;
  status: string | null;
  extra: Record<string, string>;
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
  snapRadiusMm: number;
  namePad: number;
  ghost: boolean;
}

export interface BlockInput {
  set: ContactSet;
  source: SeegBlockSource | null;
  snapRadiusMm: number;
  namePad: number;
  ghost: boolean;
}

/** Everything the module needs to resume, and nothing the scene already holds. */
export function toBlock(input: BlockInput): SeegBlock {
  const rows: Record<string, SeegBlockRow> = {};
  for (const contact of input.set.contacts) {
    rows[contact.id] = {
      original:
        contact.original === null
          ? null
          : [contact.original[0], contact.original[1], contact.original[2]],
      status: contact.loadedStatus,
      extra: contact.extra,
    };
  }
  return {
    source: input.source,
    rows,
    electrodes: input.set.groups.map((g) => ({ name: g.name, color: g.color, tip: g.tip })),
    snapRadiusMm: input.snapRadiusMm,
    namePad: input.namePad,
    ghost: input.ghost,
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
  if (level === 1) {
    const rows: Record<string, SeegBlockRow> = {};
    for (const [id, row] of Object.entries(block.rows)) {
      rows[id] = { original: row.original, status: row.status, extra: {} };
    }
    return { ...block, rows };
  }
  return { ...block, rows: {} };
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
    fieldnames: Array.isArray(raw['fieldnames'])
      ? (raw['fieldnames'] as unknown[]).filter((f): f is string => typeof f === 'string')
      : [],
    columns: columnMapOf(raw['columns']),
    delimiter,
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
    const row = value as Record<string, unknown>;
    rows[id] = {
      original: isFiniteTriple(row['original']) ? row['original'] : null,
      status: typeof row['status'] === 'string' ? row['status'] : null,
      extra: stringRecord(row['extra']),
    };
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
  return {
    source: sourceOf(raw['source']),
    rows,
    electrodes,
    snapRadiusMm:
      typeof snapRadiusMm === 'number' && Number.isFinite(snapRadiusMm) ? snapRadiusMm : 1.5,
    namePad: typeof namePad === 'number' && Number.isFinite(namePad) ? Math.trunc(namePad) : 2,
    ghost: raw['ghost'] !== false,
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
