/**
 * Turning a file of coordinates into a `PointsLayer['points']` array.
 *
 * §4.4: a points layer is "not backed by a dataset worker — the points arrive with the layer". These
 * parsers are why that is safe: a SimNIBS `eeg_positions/*.csv` is one line per electrode (256 for
 * the largest net SimNIBS ships), so there is no bulk array, no worker and nothing for §5 rule 3 to
 * protect the UI thread from. A file that is not of that shape belongs in a dataset.
 *
 * **SimNIBS `eeg_positions/*.csv`**, verbatim from the reference dataset:
 *
 * ```
 * ReferenceElectrode,2.182542192384508,22.01588488214105,98.26506048178896,reference
 * Electrode,3.1580753497774077,2.5861636926470153,99.89741319823554,1
 * ```
 *
 * — `type,x,y,z,name`, world mm, no header. The type column is not decoration: `Fiducials.csv` uses
 * `Fiducial`, and a net's own file carries one `ReferenceElectrode` among its `Electrode` rows. Rows
 * whose first field is not a recognised type are skipped rather than parsed as coordinates, which is
 * what keeps a `.geo` header or a stray comment from becoming a point at the origin.
 *
 * **Generic CSV** (`x,y,z[,name]`) is accepted too, with an optional header line, because ROI files
 * in the wild are written by hand as often as by SimNIBS.
 *
 * **JSON** is either an array of `[x, y, z]`, an array of `{position|coords|xyz, name?, color?,
 * radiusMm?}`, or an object with a `points` member holding one of those.
 */

import type { PointsLayer, vec3, vec4 } from '../scene/types';

export type ParsedPoints = PointsLayer['points'];

/** SimNIBS's first column. `Electrode` and `ReferenceElectrode` are the two a net file carries. */
const SIMNIBS_TYPES = new Set([
  'electrode',
  'referenceelectrode',
  'fiducial',
  'customelectrode',
  'coilpos',
]);

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse a SimNIBS `eeg_positions/*.csv` **or** a generic `x,y,z[,name]` CSV.
 *
 * One pass, no header sniffing beyond "the first line has no numbers where coordinates belong":
 * SimNIBS files have no header, and a generic file's header cannot parse as three numbers.
 */
export function parsePointsCsv(text: string): ParsedPoints {
  const out: ParsedPoints = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
    const cols = line.split(',');
    const head = (cols[0] ?? '').trim().toLowerCase();

    if (SIMNIBS_TYPES.has(head)) {
      const x = num(cols[1]);
      const y = num(cols[2]);
      const z = num(cols[3]);
      if (x === null || y === null || z === null) continue;
      const name = (cols[4] ?? '').trim();
      out.push({ position: [x, y, z] as vec3, ...(name === '' ? {} : { name }) });
      continue;
    }
    // Generic `x,y,z[,name]`. A header line fails `num` on its first field and is skipped.
    const x = num(cols[0]);
    const y = num(cols[1]);
    const z = num(cols[2]);
    if (x === null || y === null || z === null) continue;
    const name = (cols[3] ?? '').trim();
    out.push({ position: [x, y, z] as vec3, ...(name === '' ? {} : { name }) });
  }
  return out;
}

interface JsonPoint {
  position?: unknown;
  coords?: unknown;
  xyz?: unknown;
  name?: unknown;
  color?: unknown;
  radiusMm?: unknown;
}

function toVec3(v: unknown): vec3 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [a, b, c] = v;
  if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return [a, b, c];
}

function toVec4(v: unknown): vec4 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const rgb = toVec3(v);
  if (rgb === null) return null;
  const a = v[3];
  return [rgb[0], rgb[1], rgb[2], typeof a === 'number' && Number.isFinite(a) ? a : 1];
}

/** Parse a JSON points/ROI file. Unknown members are ignored; malformed entries are skipped. */
export function parsePointsJson(text: string): ParsedPoints {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { points?: unknown }).points)
      ? (parsed as { points: unknown[] }).points
      : [];
  const out: ParsedPoints = [];
  for (const entry of list) {
    const direct = toVec3(entry);
    if (direct !== null) {
      out.push({ position: direct });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as JsonPoint;
    const position = toVec3(e.position) ?? toVec3(e.coords) ?? toVec3(e.xyz);
    if (position === null) continue;
    const color = toVec4(e.color);
    out.push({
      position,
      ...(typeof e.name === 'string' ? { name: e.name } : {}),
      ...(color !== null ? { color } : {}),
      ...(typeof e.radiusMm === 'number' && Number.isFinite(e.radiusMm)
        ? { radiusMm: e.radiusMm }
        : {}),
    });
  }
  return out;
}

/** Pick the parser from the file name; `.json` is JSON, everything else is CSV. */
export function parsePoints(name: string, text: string): ParsedPoints {
  return name.toLowerCase().endsWith('.json') ? parsePointsJson(text) : parsePointsCsv(text);
}
