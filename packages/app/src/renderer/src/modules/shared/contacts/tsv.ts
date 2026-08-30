/**
 * Reading and writing a table of contacts — the tolerant reader in, the canonical BIDS writer out.
 *
 * **Tolerant in, canonical out**, which is the shape every clinical importer ends up with: the file a
 * user has is whatever their site exports — a comma-separated sheet, a Slicer `.fcsv`, a table with
 * `R`/`A`/`S` instead of `x`/`y`/`z`, one row short of the header — and the file this writes is a
 * BIDS-iEEG `electrodes.tsv` that `seegprep` reads back. Slicer's `_readTable` /`_resolveColumns`
 * are the reference for the tolerance, and `seegprep/io/localization.py` for the output.
 *
 * Three properties are load-bearing, and each one is a defect somebody had:
 *
 *  * **The original columns survive.** A `csc` column bridging to `channels.tsv`, a `hu_peak`, a
 *    `manufacturer` — none of them mean anything here, and dropping them would quietly delete the
 *    localiser's output. Every cell that came in goes back out, in the file's own column order, with
 *    `electrode` / `contact` / `status` appended only if they were not already there.
 *  * **Floats are formatted like Python's `repr`, not like `String(x)`.** `seegprep` writes `repr`
 *    so its tables round-trip bit for bit, and JavaScript disagrees with it in three places:
 *    `String(3)` is `3` where `repr(3.0)` is `3.0`, `String(1e-7)` is `1e-7` where `repr` is
 *    `1e-07`, and the two switch to exponent notation at different magnitudes. {@link formatFloat}
 *    is Python's rule, with a JS/Python fixture pinning it (`testdata/manifest.json`, `seeg.floats`).
 *  * **An unchanged contact is written back byte for byte.** Its cells are the ones it arrived with
 *    and its coordinate is the `repr` of the double the file parsed to, so a save with no edits is a
 *    no-op diff — which is what makes `status` mean something.
 */

import type { vec3 } from '@tetravox/engine';
import type { ContactSet, Contact } from './model';
import { contactName, groupFromName, namePadOf, ordinalFromName, statusOf } from './model';
import { paletteColor } from './palette';

/** What the header was separated by. Reported so a "column not found" error can say it. */
export type Delimiter = 'tab' | 'comma' | 'semicolon' | 'whitespace';

/** The file's own name for each field this reader understands, or `null` when it has none. */
export interface ColumnMap {
  name: string | null;
  x: string | null;
  y: string | null;
  z: string | null;
  electrode: string | null;
  contact: string | null;
  status: string | null;
}

export interface ParsedTable {
  /** The header, in the file's order. */
  fieldnames: string[];
  delimiter: Delimiter;
  /** One record per data row, keyed by the file's own column names. */
  rows: Record<string, string>[];
  columns: ColumnMap;
  format: 'table' | 'fcsv';
  /** The frame the coordinates were written in. An `.fcsv` may say LPS; a BIDS tsv is always RAS. */
  coordinateSystem: 'RAS' | 'LPS';
}

/** A table this reader cannot use, with the delimiter and the columns it did find. */
export class ContactTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactTableError';
  }
}

const REQUIRED: readonly (keyof ColumnMap)[] = ['name', 'x', 'y', 'z'];

/**
 * Every spelling of the electrode field, and the reason this list is exported to the writer.
 *
 * `seegprep`'s canonical `electrodes.tsv` carries **both** `group` and `electrode`, with the shaft
 * label in each; `resolveColumns` picks `electrode`, which leaves `group` an ordinary extra column.
 * A contact added here has no cell for it, so the writer's absent → `n/a` rule would put the literal
 * string `n/a` there — and `seegprep`'s reader is `r.get("group") or r.get("electrode")`, where the
 * *truthy* `'n/a'` wins over the real label and the contact comes back detached from its shaft into
 * a phantom `n/a` group. Slicer wrote `''`, which is falsy and falls through, so this was a
 * regression against the reference rather than a difference of opinion.
 */
const ALIASES: Record<keyof ColumnMap, readonly string[]> = {
  name: ['name', 'label', 'contact_name', 'contactlabel'],
  x: ['x', 'pos_x', 'x_mm', 'xmm'],
  y: ['y', 'pos_y', 'y_mm', 'ymm'],
  z: ['z', 'pos_z', 'z_mm', 'zmm'],
  electrode: ['electrode', 'group', 'name_electrode', 'shaft', 'lead'],
  contact: ['contact', 'contact_index', 'index', 'number'],
  status: ['status'],
};

/**
 * Which of the file's columns each field is, case- and space-insensitively.
 *
 * The `R`/`A`/`S` fallback runs only when `x`/`y`/`z` are all missing, so a table with both an `x`
 * and a stray `r` column is read the way it was written.
 */
export function resolveColumns(fieldnames: readonly string[]): ColumnMap {
  const norm = new Map<string, string>();
  for (const column of fieldnames) norm.set(column.trim().toLowerCase(), column);
  const pick = (...aliases: readonly string[]): string | null => {
    for (const alias of aliases) {
      const found = norm.get(alias);
      if (found !== undefined) return found;
    }
    return null;
  };
  const columns: ColumnMap = {
    name: pick(...ALIASES.name),
    x: pick(...ALIASES.x),
    y: pick(...ALIASES.y),
    z: pick(...ALIASES.z),
    electrode: pick(...ALIASES.electrode),
    contact: pick(...ALIASES.contact),
    status: pick(...ALIASES.status),
  };
  if (columns.x === null || columns.y === null || columns.z === null) {
    const r = pick('r');
    const a = pick('a');
    const s = pick('s');
    if (r !== null && a !== null && s !== null) {
      columns.x = r;
      columns.y = a;
      columns.z = s;
    }
  }
  return columns;
}

/** The delimiter with the most occurrences in the header; whitespace when there is none. */
function detectDelimiter(header: string): Delimiter {
  const counts: [Delimiter, number][] = [
    ['tab', (header.match(/\t/g) ?? []).length],
    ['comma', (header.match(/,/g) ?? []).length],
    ['semicolon', (header.match(/;/g) ?? []).length],
  ];
  let best: [Delimiter, number] = counts[0] as [Delimiter, number];
  for (const entry of counts) if (entry[1] > best[1]) best = entry;
  return best[1] === 0 ? 'whitespace' : best[0];
}

function splitBy(delimiter: Delimiter, line: string): string[] {
  switch (delimiter) {
    case 'tab':
      return line.split('\t');
    case 'comma':
      return line.split(',');
    case 'semicolon':
      return line.split(';');
    default:
      return line.trim().split(/\s+/);
  }
}

/** Non-blank lines with the UTF-8 BOM and any CR stripped. CRLF files are ordinary here. */
function usefulLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

/**
 * A 3D Slicer markups fiducial file, or `null` when the text is not one.
 *
 * Its header is comment lines: `# columns = id,x,y,z,…` names the fields and
 * `# CoordinateSystem = LPS` names the frame. Only the label and the position are carried over —
 * the markup bookkeeping (`ow`, `ox`, `vis`, `associatedNodeID`) describes a Slicer node and has no
 * place in a BIDS table, so an `.fcsv` is read and saved as a canonical four-column one.
 */
function parseFcsv(text: string): ParsedTable | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let columns: string[] | null = null;
  let system: 'RAS' | 'LPS' = 'RAS';
  const data: string[] = [];
  let looksLikeFcsv: boolean | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    // A comment before anything else is the discriminator: no delimited table this reader accepts
    // begins with `#`, and every Slicer fiducial file does.
    looksLikeFcsv ??= line.startsWith('#');
    if (line.startsWith('#')) {
      const body = line.slice(1).trim();
      const columnsMatch = /^columns\s*=\s*(.+)$/i.exec(body);
      if (columnsMatch !== null)
        columns = (columnsMatch[1] as string).split(',').map((c) => c.trim());
      const systemMatch = /^coordinatesystem\s*=\s*(\S+)$/i.exec(body);
      if (systemMatch !== null) {
        const value = (systemMatch[1] as string).toUpperCase();
        system = value === 'RAS' || value === '1' ? 'RAS' : 'LPS';
      }
      continue;
    }
    data.push(line);
  }
  if (looksLikeFcsv !== true || columns === null) return null;

  const rows: Record<string, string>[] = [];
  for (const line of data) {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    for (let i = 0; i < columns.length && i < cells.length; i += 1) {
      row[columns[i] as string] = (cells[i] as string).trim();
    }
    const label = row['label'] ?? row['id'] ?? '';
    rows.push({ name: label, x: row['x'] ?? '', y: row['y'] ?? '', z: row['z'] ?? '' });
  }
  return {
    fieldnames: ['name', 'x', 'y', 'z'],
    delimiter: 'comma',
    rows,
    columns: resolveColumns(['name', 'x', 'y', 'z']),
    format: 'fcsv',
    coordinateSystem: system,
  };
}

/**
 * Parse an electrode table, tolerantly.
 *
 * Handled: a UTF-8 BOM, CRLF, blank lines anywhere, tab / comma / semicolon / whitespace, headers in
 * any case with spaces around them, `R`/`A`/`S` instead of `x`/`y`/`z`, and a **ragged** row — a
 * hand-edited sheet legitimately has one, and truncating to the shorter of header and row is what
 * every tolerant reader does. A missing required column is the one thing that throws, and the
 * message names the delimiter and the columns it found, because "column not found" without those
 * two facts is the least useful error in data work.
 */
export function parseTable(text: string): ParsedTable {
  const fcsv = parseFcsv(text);
  if (fcsv !== null) return fcsv;

  const lines = usefulLines(text);
  if (lines.length === 0) throw new ContactTableError('the table is empty');
  const header = lines[0] as string;
  const delimiter = detectDelimiter(header);
  const fieldnames = splitBy(delimiter, header).map((c) => c.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = splitBy(delimiter, line);
    const row: Record<string, string> = {};
    for (let i = 0; i < fieldnames.length && i < cells.length; i += 1) {
      row[fieldnames[i] as string] = (cells[i] as string).trim();
    }
    return row;
  });

  const columns = resolveColumns(fieldnames);
  const missing = REQUIRED.filter((key) => columns[key] === null);
  if (missing.length > 0) {
    throw new ContactTableError(
      `no ${missing.join(', ')} column. Delimiter: ${delimiter}. Columns found: ` +
        `${fieldnames.join(', ')}. An electrodes table needs a name column and x/y/z (or R/A/S) ` +
        `coordinates in millimetres.`
    );
  }
  return { fieldnames, delimiter, rows, columns, format: 'table', coordinateSystem: 'RAS' };
}

/** `n/a`, an empty cell and whitespace all mean "no value". */
function cellNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const text = cell.trim();
  if (text === '' || text.toLowerCase() === 'n/a') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export interface ContactSetResult {
  set: ContactSet;
  /** The zero-padding width the file's own names use — what a relabel must reproduce. */
  namePad: number;
  /** Rows that were dropped, and why. Shown as a toast rather than failing the load. */
  warnings: string[];
}

/**
 * Turn a parsed table into a {@link ContactSet}.
 *
 * Ids are `c<row>`, 1-based over the **file's** rows, so a contact keeps its identity across a
 * reload of the same file and a scene block written against it still resolves. Contacts stay in file
 * order — §4.4's rule that the array is drawing order and `ordinal` is anatomy — and the panel sorts
 * by ordinal when it lists them.
 */
export function contactSetFrom(parsed: ParsedTable): ContactSetResult {
  const { columns, fieldnames } = parsed;
  const warnings: string[] = [];
  const contacts: Contact[] = [];
  const groupOrder: string[] = [];
  const perGroup = new Map<string, number>();
  const flip = parsed.coordinateSystem === 'LPS';

  parsed.rows.forEach((row, index) => {
    const name = (row[columns.name as string] ?? '').trim();
    const x = cellNumber(row[columns.x as string]);
    const y = cellNumber(row[columns.y as string]);
    const z = cellNumber(row[columns.z as string]);
    if (name === '' || x === null || y === null || z === null) {
      warnings.push(`row ${index + 2} has no name or no usable coordinate — skipped`);
      return;
    }
    // An `.fcsv` written in LPS is the one frame conversion this reader does; §3 keeps everything
    // else in world RAS millimetres and a BIDS `electrodes.tsv` is already there.
    const position: vec3 = flip ? [-x, -y, z] : [x, y, z];

    const groupCell = columns.electrode === null ? '' : (row[columns.electrode] ?? '').trim();
    const group =
      groupCell !== '' && groupCell.toLowerCase() !== 'n/a' ? groupCell : groupFromName(name);
    if (!groupOrder.includes(group)) groupOrder.push(group);

    const seen = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, seen);
    const ordinalCell = columns.contact === null ? null : cellNumber(row[columns.contact]);
    const ordinal =
      ordinalCell !== null ? Math.trunc(ordinalCell) : (ordinalFromName(name) ?? seen);

    const extra: Record<string, string> = {};
    // Only the cells this row really had. A ragged row's missing cell stays **absent** rather than
    // becoming `''`, because the writer distinguishes the two: absent is written as `n/a`, and an
    // empty string is written back as the empty cell the file had.
    for (const field of fieldnames) {
      const cell = row[field];
      if (cell !== undefined) extra[field] = cell;
    }
    const statusCell = columns.status === null ? null : (row[columns.status] ?? '').trim();

    contacts.push({
      id: `c${index + 1}`,
      name,
      group,
      ordinal,
      position,
      original: [...position] as vec3,
      originalName: name,
      loadedStatus: statusCell === null || statusCell === '' ? null : statusCell,
      extra,
    });
  });

  return {
    set: {
      contacts,
      groups: groupOrder.map((name, i) => ({ name, color: paletteColor(i), tip: 'auto' as const })),
    },
    namePad: namePadOf(contacts.map((c) => c.name)),
    warnings,
  };
}

// ------------------------------------------------------------------------------------------------
// Float formatting — Python's `repr`, so a table round-trips through both languages
// ------------------------------------------------------------------------------------------------

/**
 * Above this decimal exponent, and at or below `-4`, Python's `repr` switches to `e` notation.
 *
 * CPython's `format_float_short` in repr mode: exponential iff `decpt <= -4 || decpt > 16`, where
 * `decpt` is the position of the decimal point relative to the shortest digit string. So
 * `repr(1e15)` is `1000000000000000.0` and `repr(1e16)` is `1e+16`; `repr(0.0001)` is `0.0001` and
 * `repr(0.00001)` is `1e-05`. JavaScript's own thresholds are 21 and −7, which is why this exists.
 */
const REPR_MAX_DECPT = 16;
const REPR_MIN_DECPT = -4;

/**
 * A float formatted exactly as Python's `repr` writes it.
 *
 * `toExponential()` with no argument is the shortest round-tripping digit string by specification,
 * which is the same set of digits CPython's David Gay / Grisu shortest repr produces — so the only
 * work here is Python's *layout* of them: always a decimal point, a two-digit signed exponent, and
 * the two thresholds above.
 *
 * Non-finite values become `n/a`: BIDS's missing-value token, and what `seegprep`'s own writer
 * emits for a NaN.
 */
export function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const exponential = value.toExponential();
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential);
  // Unreachable for a finite double; a plain fallback rather than a throw, because a save must not
  // fail on a number the platform formatted in a shape this regexp did not expect.
  if (match === null) return String(value);
  // `(-0).toExponential()` is `'0e+0'` — JavaScript drops the sign of negative zero and Python's
  // `repr` keeps it (`-0.0`). The one place the digit strings themselves disagree.
  const sign = Object.is(value, -0) ? '-' : (match[1] as string);
  const digits = `${match[2] as string}${match[3] ?? ''}`;
  const decpt = Number.parseInt(match[4] as string, 10) + 1;

  if (decpt <= REPR_MIN_DECPT || decpt > REPR_MAX_DECPT) {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : (digits[0] as string);
    const exponent = decpt - 1;
    const exponentSign = exponent < 0 ? '-' : '+';
    return `${sign}${mantissa}e${exponentSign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

// ------------------------------------------------------------------------------------------------
// The canonical writer
// ------------------------------------------------------------------------------------------------

/** BIDS's missing-value token. `seegprep` writes it and its reader expects it. */
export const MISSING = 'n/a';

/** What the writer needs to remember about the file that was read. */
export interface WriteSource {
  fieldnames: readonly string[];
  columns: ColumnMap;
}

/** The canonical column set for a table that had none of its own (a new set, or an `.fcsv`). */
export const CANONICAL_FIELDNAMES: readonly string[] = ['name', 'x', 'y', 'z'];

/** A cell can hold neither a tab nor a newline in a tab-separated file. */
function sanitiseCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/**
 * The columns the output will have: the file's own, then `electrode` / `contact` / `status` if they
 * were not already among them under any of their aliases.
 */
export function outputFieldnames(source: WriteSource): string[] {
  const fields = [...source.fieldnames];
  for (const [key, fallback] of [
    ['electrode', 'electrode'],
    ['contact', 'contact'],
    ['status', 'status'],
  ] as const) {
    const existing = source.columns[key];
    const column = existing ?? fallback;
    if (!fields.includes(column)) fields.push(column);
  }
  return fields;
}

/**
 * The table, as the text to write: tab-separated, **LF**, one trailing newline.
 *
 * Rows come out grouped by electrode in the set's group order and ordered by `ordinal` inside a
 * group — the clinical order, and the order `seegprep` writes — rather than the array's drawing
 * order. Every cell a contact arrived with is written back unless this writer owns it; a cell the
 * file never had (a contact added here) is `n/a`, because BIDS says a missing value is `n/a` and an
 * empty cell in a tab-separated file is indistinguishable from a ragged row.
 *
 * CRLF is a Slicer defect this deliberately does not reproduce: `csv.DictWriter` with the default
 * `\r\n` is what put carriage returns into hand-edited tables, and `seegprep` writes LF.
 */
export function writeTable(set: ContactSet, source: WriteSource): string {
  const fields = outputFieldnames(source);
  const nameColumn = source.columns.name ?? 'name';
  // The columns that are *also* the electrode field but are not the one this writer owns — `group`
  // beside `electrode` on `seegprep`'s own header. See {@link ALIASES}.
  const electrodeAliases = new Set(ALIASES.electrode);
  const xColumn = source.columns.x ?? 'x';
  const yColumn = source.columns.y ?? 'y';
  const zColumn = source.columns.z ?? 'z';
  const electrodeColumn = source.columns.electrode ?? 'electrode';
  const contactColumn = source.columns.contact ?? 'contact';
  const statusColumn = source.columns.status ?? 'status';

  const ordered: Contact[] = [];
  for (const group of set.groups) {
    ordered.push(
      ...set.contacts
        .filter((c) => c.group === group.name)
        .sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name))
    );
  }
  // A contact whose group is not in `groups` would otherwise vanish from the file it was read from.
  const written = new Set(ordered);
  for (const contact of set.contacts) if (!written.has(contact)) ordered.push(contact);

  const lines = [fields.join('\t')];
  for (const contact of ordered) {
    const cells = fields.map((field) => {
      // `undefined` is a cell this contact never had — an added contact, or a ragged row. An empty
      // string is a cell the file really did leave empty, and it is written back as it arrived so
      // that an untouched contact produces no diff at all.
      const value = contact.extra[field];
      return sanitiseCell(value === undefined ? MISSING : value);
    });
    const put = (column: string, value: string): void => {
      const at = fields.indexOf(column);
      if (at >= 0) cells[at] = sanitiseCell(value);
    };
    put(nameColumn, contact.name);
    put(xColumn, formatFloat(contact.position[0]));
    put(yColumn, formatFloat(contact.position[1]));
    put(zColumn, formatFloat(contact.position[2]));
    put(electrodeColumn, contact.group);
    // A sibling column that means the same thing gets the same label — but only where this contact
    // never had a cell of its own, so a row the file really did write is still written back byte for
    // byte and an added one never carries `n/a` where a shaft label belongs.
    for (const field of fields) {
      if (field === electrodeColumn) continue;
      if (!electrodeAliases.has(field.trim().toLowerCase())) continue;
      if (contact.extra[field] !== undefined) continue;
      put(field, contact.group);
    }
    put(contactColumn, String(contact.ordinal));
    put(statusColumn, statusOf(contact));
    lines.push(cells.join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/** A fresh contact for a position the user placed, with no row behind it. */
export function newContact(
  id: string,
  group: string,
  ordinal: number,
  position: vec3,
  pad: number
): Contact {
  return {
    id,
    name: contactName(group, ordinal, pad),
    group,
    ordinal,
    position,
    original: null,
    originalName: null,
    loadedStatus: null,
    extra: {},
  };
}
