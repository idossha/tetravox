/**
 * **R5's "Save LUT…"**: writing edited label colours back out as a colour lookup table.
 *
 * `docs/requirements/2026-08-27-maintainer.md` R5: a region row's "colour swatch (colour picker;
 * edits persist in the scene **and can be saved as a LUT file**)". A-PROPS owns the picker and the
 * row; this is the export, per requirement R5.
 *
 * Two formats, both of which §7.6 already names as *parsers*, so a file written here reopens in the
 * same viewer — the round trip is the point of the feature, and a third format nothing reads would
 * not be:
 *
 * * **SimNIBS** `*_LUT.txt` — `#No.\tLabel Name:\tR G B A`, the header line included verbatim so
 *   `final_tissues_LUT.txt` and a file written here are the same shape.
 * * **FreeSurfer** `FreeSurferColorLUT.txt` — `#No. Label Name  R G B A`, space-aligned columns.
 *
 * Colour convention (§4.1): everything in §4 is **0..1 float RGBA** and every LUT on disk is
 * **0..255**. This module is a wire boundary, so it multiplies by 255 and rounds — the same
 * arithmetic §4.1 pins for `expectPixel`, in the one direction §4.1's "only `fromMeta` divides"
 * rule does not cover.
 */

import type { LabelEntry, vec4 } from '@tetravox/engine';

export type LutFormat = 'simnibs' | 'freesurfer';

/** 0..1 float RGBA → the 0..255 bytes a LUT file carries (§4.1). */
export function toBytes(color: vec4): [number, number, number, number] {
  const clamp = (c: number): number => Math.max(0, Math.min(255, Math.round(c * 255)));
  return [clamp(color[0]), clamp(color[1]), clamp(color[2]), clamp(color[3])];
}

/** A label name with no whitespace, because both formats are whitespace-delimited. */
export function safeName(name: string, id: number): string {
  const trimmed = name.trim().replace(/\s+/g, '_');
  return trimmed === '' ? `label_${id}` : trimmed;
}

export interface LutEntry {
  id: number;
  name: string;
  /** 0..1 RGBA, exactly as §4.4 holds it. */
  color: vec4;
}

/** `LabelEntry[]` is already the right shape; this is the widening the callers share. */
export function fromLabelEntries(entries: readonly LabelEntry[]): LutEntry[] {
  return entries.map((e) => ({ id: e.id, name: e.name, color: e.color }));
}

/**
 * Format a LUT. Entries are sorted by id — a LUT is read by id, and a file whose rows follow the
 * order a React list happened to be in is a file whose diff is meaningless between two saves.
 */
export function formatLut(
  entries: readonly LutEntry[],
  format: LutFormat = 'simnibs',
  title = 'Tetravox'
): string {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const lines: string[] = [];
  if (format === 'simnibs') {
    lines.push('#No.\tLabel Name:\tR\tG\tB\tA');
    for (const entry of sorted) {
      const [r, g, b, a] = toBytes(entry.color);
      lines.push(`${entry.id}\t${safeName(entry.name, entry.id)}\t${r}\t${g}\t${b}\t${a}`);
    }
  } else {
    lines.push(`#$Id: ${title} label lookup table`);
    lines.push('#No.  Label Name:                     R   G   B   A');
    for (const entry of sorted) {
      const [r, g, b, a] = toBytes(entry.color);
      const id = String(entry.id).padEnd(5, ' ');
      const name = safeName(entry.name, entry.id).padEnd(32, ' ');
      const cols = [r, g, b, a].map((c) => String(c).padStart(3, ' ')).join(' ');
      lines.push(`${id}${name}${cols}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The filename offered by the Save dialog: `<layer>_LUT.txt`, the name §7.6 auto-associates. */
export function lutFileName(layerName: string): string {
  const stem = layerName
    .replace(/\.(nii\.gz|nii|mgz|mgh|msh|gii|annot)$/i, '')
    .replace(/[^\w.-]+/g, '_');
  return `${stem === '' ? 'labels' : stem}_LUT.txt`;
}
