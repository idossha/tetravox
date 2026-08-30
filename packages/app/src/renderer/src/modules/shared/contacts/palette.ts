/**
 * The twelve colours a contact set cycles across its groups.
 *
 * Slicer's `SEEGContactEditor._PALETTE`, value for value, so the same subject opened in either tool
 * shows the same electrode in the same colour — which is the whole point of copying a palette rather
 * than picking a nicer one. It is the ColorBrewer "paired"-family set the module chose for being
 * distinguishable under the common forms of colour blindness.
 *
 * Cycled by **index within the set's group list**, not hashed from the name: a hash gives two
 * neighbouring shafts the same colour often enough to matter, and the group list is the file's own
 * order, which is stable across a reload.
 */

import type { vec4 } from '@tetravox/engine';

export const CONTACT_PALETTE: readonly vec4[] = [
  [0.9, 0.1, 0.1, 1],
  [0.12, 0.47, 0.71, 1],
  [0.2, 0.63, 0.17, 1],
  [1.0, 0.5, 0.0, 1],
  [0.42, 0.24, 0.6, 1],
  [0.65, 0.34, 0.16, 1],
  [0.89, 0.1, 0.55, 1],
  [0.4, 0.76, 0.65, 1],
  [0.99, 0.75, 0.44, 1],
  [0.55, 0.63, 0.8, 1],
  [0.85, 0.85, 0.1, 1],
  [0.6, 0.6, 0.6, 1],
];

/** The colour for the `index`-th group, cycling. */
export function paletteColor(index: number): vec4 {
  const n = CONTACT_PALETTE.length;
  const at = ((Math.trunc(index) % n) + n) % n;
  return [...(CONTACT_PALETTE[at] as vec4)] as vec4;
}

/** `#rrggbb` for a swatch. Alpha is dropped: a swatch is opaque. */
export function cssColor(color: vec4): string {
  const byte = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${byte(color[0])}${byte(color[1])}${byte(color[2])}`;
}
