/**
 * §4.4's `MeshFieldDisplay.label` markup (2026-10-30): `X_{sub}` — and nothing else — is a subscript.
 *
 * `TI_{max}` is `TI` then `max` lowered; a label without the markup, and a bare field name (`TI_max`),
 * are plain text. A `_` not followed by `{…}`, a `{` without the `_`, and nested braces are literal.
 * One parser so the app's HTML and the engine's bitmap colour bar cannot disagree.
 */

export interface LabelPart {
  text: string;
  sub: boolean;
}

const SUB = /_\{([^{}]*)\}/g;

export function labelParts(label: string): LabelPart[] {
  const parts: LabelPart[] = [];
  let at = 0;
  for (const m of label.matchAll(SUB)) {
    if (m.index > at) parts.push({ text: label.slice(at, m.index), sub: false });
    if ((m[1] ?? '') !== '') parts.push({ text: m[1] ?? '', sub: true });
    at = m.index + m[0].length;
  }
  if (at < label.length) parts.push({ text: label.slice(at), sub: false });
  return parts;
}

/** The label as plain text, for places with no subscripts (a native `<option>`): `TI_{max}` → `TI_max`. */
export function plainLabel(label: string): string {
  return label.replace(SUB, '_$1');
}
