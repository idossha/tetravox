/**
 * `ContactSet` ⇄ `PointsLayer` — the one place a contact becomes something the engine draws.
 *
 * §13.2's persistence rule is that a module's geometry is an **ordinary core-typed layer**, so a
 * build without the module still draws the scene and `serialize` still round-trips it. That makes
 * this file the whole of the module's rendering: every field it sets is one §4.4 declared on
 * `PointsLayer`, and the module never reaches a pass, a shader or a property editor.
 *
 * Four choices are worth stating, because a plausible alternative fails visibly:
 *
 *  * **One layer for every electrode, not one per electrode.** Twelve same-kind rows each mount a
 *    full property editor, add twelve stops to `[` / `]`, take twelve probe rows, and put twelve ✕
 *    buttons on the layer panel that each close the carrier CT. One layer with `points[].group`
 *    costs two optional fields and no rendering change (§4.4, DECISIONS 2026-08-30).
 *  * **`shape: 'dot'` with `radiusMm: 1.5`.** The dot branch draws at a constant pixel radius, which
 *    is what Slicer's `SetGlyphScale(2.0)` glyphs do; the millimetre radius is still the 3D
 *    hemisphere, the 2D slab and the probe radius, and 1.5 mm is the contact-plus-halo a clinician
 *    aims at.
 *  * **`offPlaneOpacity: 0.6` — the ghost.** A depth electrode is twelve contacts on a line no single
 *    slice contains, so under §7.2's plain cull the shaft is never visible *as* a shaft. 0.6 is
 *    Slicer's slice-projection opacity.
 *  * **`lineSegments` is regenerated, never stored.** §4.6 does not serialise it (a `Float32Array`
 *    through `JSON.stringify` is megabytes of `{"0":…}` that restore as garbage), so it is rebuilt
 *    from the set on every change and on every scene load — which is also what keeps the shaft
 *    following an edit for free. §4.4's `lineColors` is its parallel array and goes the same way.
 *  * **The shaft and the names take the electrode's colour** (§4.4's `lineColors` and
 *    `labelColorSource: 'points'`, 2026-08-30). One layer carries the whole implant, so a single
 *    `lineColor` drew fifteen shafts in one colour and a single `labelColor` wrote every name in it:
 *    the discs said which electrode a contact belonged to and the two things drawn *next* to them
 *    did not. Both are now the group's palette colour, which is the colour `pointsOf` already gives
 *    the disc — so the marker, its line and its name cannot disagree.
 */

import type { Layer, PointsLayer, Threshold, vec3, vec4 } from '@tetravox/engine';
import type { ContactSet, Contact } from './model';
import { contactsOf, groupFromName, namePadOf, ordinalFromName } from './model';
import { paletteColor } from './palette';

/** The per-point record a contact becomes. `id`/`group`/`ordinal` are §4.4's 2026-08-30 fields. */
export interface ContactPoint {
  id: string;
  name: string;
  group: string;
  ordinal: number;
  position: vec3;
  color: vec4;
}

/** The layer fields a contact-editing module owns, as one object (§4.4). */
export const CONTACT_LAYER_STYLE = {
  kind: 'points' as const,
  shape: 'dot' as const,
  radiusMm: 1.5,
  showLabels: true,
  labelSource: 'names' as const,
  // §4.4 (2026-08-30): each name in its own electrode's colour, which is the point's own colour.
  labelColorSource: 'points' as const,
  offPlaneOpacity: 0.6,
  lineWidthPx: 2,
  pickable: false,
  visible: true,
  opacity: 1,
  showColorbar: false,
};

/** How opaque an off-slice contact is drawn when the ghost is on. Slicer's slice projection. */
export const GHOST_OPACITY = 0.6;

/**
 * How big a contact marker is, in CSS pixels — §4.4's `dotRadiusPx`, and the panel's Size control.
 *
 * The default is the engine's own `DOT_RADIUS_PX`, so a layer built at the default size is the
 * layer this module drew before the control existed. The bounds are the useful range and no more:
 * below 2 px a marker is a pixel of noise over a bone-window CT, and above 12 px one contact covers
 * the neighbour a clinician is comparing it with.
 */
export const CONTACT_DOT_RADIUS_PX = 4;
export const CONTACT_DOT_RADIUS_MIN_PX = 2;
export const CONTACT_DOT_RADIUS_MAX_PX = 12;
/** One press of the panel's Size stepper. */
export const CONTACT_DOT_RADIUS_STEP_PX = 1;

/** A size the panel or a scene block asked for, held to {@link CONTACT_DOT_RADIUS_MIN_PX}…MAX. */
export function clampDotRadius(px: number): number {
  if (!Number.isFinite(px)) return CONTACT_DOT_RADIUS_PX;
  return Math.min(CONTACT_DOT_RADIUS_MAX_PX, Math.max(CONTACT_DOT_RADIUS_MIN_PX, px));
}

/**
 * The empty geometry a hidden wire patches in — **one** instance, so `derived/store.ts`'s identity
 * check sees the same array on every write and re-uploads nothing.
 *
 * Hiding the wire is a patch and not a deletion because a `Partial<PointsLayer>` merge cannot
 * *unset* a field: `{ ...layer, ...patch }` keeps whatever the layer had wherever the patch is
 * silent, and `lineSegments: undefined` would be spread as an explicit `undefined` only by luck of
 * the merge implementation. An empty array is the honest statement — the engine's own rule is
 * "fewer than one segment draws nothing" (`store.lineSegments` returns `null` under six floats), so
 * this needs no engine change and no new mechanism at all.
 */
const NO_SEGMENTS = new Float32Array(0);

/** `points[]` for a set, in the set's own (drawing) order. */
export function pointsOf(set: ContactSet): ContactPoint[] {
  const colors = new Map(set.groups.map((g) => [g.name, g.color]));
  return set.contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    group: contact.group,
    ordinal: contact.ordinal,
    position: [...contact.position] as vec3,
    color: [...(colors.get(contact.group) ?? paletteColor(0))] as vec4,
  }));
}

/**
 * The shaft polylines and their colours: one segment between consecutive **ordinals** of each group.
 *
 * Six floats per segment and four per segment, the layouts §4.4's `lineSegments` and `lineColors`
 * declare. Consecutive by ordinal rather than by array order, because the array is drawing order —
 * a contact inserted between 4 and 5 sits wherever the editor put it and still belongs on the line
 * between them.
 *
 * One function for both arrays rather than two, because §4.4's contract is that they are
 * **parallel**: two loops over the same groups is two places for a `continue` to be added to one of
 * them, and the failure that produces is a shaft painted in its neighbour's colour.
 */
export function shaftGeometry(set: ContactSet): { segments: Float32Array; colors: Float32Array } {
  const values: number[] = [];
  const colors: number[] = [];
  for (const group of set.groups) {
    const contacts = contactsOf(set, group.name);
    for (let i = 1; i < contacts.length; i += 1) {
      const a = (contacts[i - 1] as Contact).position;
      const b = (contacts[i] as Contact).position;
      values.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      colors.push(group.color[0], group.color[1], group.color[2], group.color[3]);
    }
  }
  return { segments: new Float32Array(values), colors: new Float32Array(colors) };
}

/** Just the segments — {@link shaftGeometry}'s first half, for a caller that wants only geometry. */
export function shaftSegments(set: ContactSet): Float32Array {
  return shaftGeometry(set).segments;
}

/** What the panel's three display switches are, as one value the block and the layer both read. */
export interface ContactLook {
  /** §4.4's `offPlaneOpacity`: draw the contacts that are not on this slice. */
  ghost: boolean;
  /** Draw the shaft line between consecutive contacts. */
  wire: boolean;
  /** §4.4's `dotRadiusPx`, in CSS pixels. */
  dotRadiusPx: number;
}

/** The look a layer has when nothing has said otherwise — today's picture, field for field. */
export const DEFAULT_CONTACT_LOOK: ContactLook = {
  ghost: true,
  wire: true,
  dotRadiusPx: CONTACT_DOT_RADIUS_PX,
};

/** Everything about the layer that follows from the set — one patch per edit. */
export function layerPatch(set: ContactSet, look: ContactLook): Partial<PointsLayer> {
  const shaft = look.wire ? shaftGeometry(set) : { segments: NO_SEGMENTS, colors: NO_SEGMENTS };
  return {
    points: pointsOf(set),
    lineSegments: shaft.segments,
    lineColors: shaft.colors,
    offPlaneOpacity: look.ghost ? GHOST_OPACITY : 0,
    dotRadiusPx: clampDotRadius(look.dotRadiusPx),
  };
}

/** `Contacts · <stem>` — the layer's name, and how a reader tells two subjects apart in the panel. */
export function contactLayerName(stem: string): string {
  return `Contacts · ${stem === '' ? 'untitled' : stem}`;
}

/**
 * The display preset a CT gets when contacts are loaded onto it (Slicer's `_syncDisplayControls`).
 *
 * Grey, fully opaque, and a **150 HU floor with `mode: 'hide'`**, so the soft tissue drops out and
 * the bone and metal that a contact is aimed at are what is left. `mode: 'hide'` rather than
 * `'clamp'` is the half that matters: clamping would paint everything below the floor black and hide
 * whatever layer is underneath, and the point of the floor is to see the T1 through it.
 */
export const CT_THRESHOLD_LO_HU = 150;

export function ctDisplayPreset(): {
  colormap: string;
  opacity: number;
  visible: boolean;
  threshold: Threshold;
} {
  return {
    colormap: 'gray',
    opacity: 1,
    visible: true,
    threshold: {
      lo: CT_THRESHOLD_LO_HU,
      hi: Infinity,
      symmetric: false,
      mode: 'hide',
      softEdge: 0,
    },
  };
}

/**
 * The **other half** of that preset: the anatomy the CT's 150 HU floor exists to reveal.
 *
 * Grey, fully opaque and *visible*, and visible is the field that does any work — a T1 the app has
 * open but not drawn shows nothing under the floor, and a job that named one meant to see it. There
 * is no threshold here on purpose: the CT hides its own soft tissue, and thresholding the layer
 * underneath as well would leave a hole rather than a head.
 *
 * `ctDisplayPreset`'s comment names the half this host still cannot do — putting the CT *above* the
 * T1, which needs a `reorderLayers` `ModuleHost` does not have — and applying this does not change
 * that: the module says so in a toast instead.
 */
export function t1DisplayPreset(): { colormap: string; opacity: number; visible: boolean } {
  return { colormap: 'gray', opacity: 1, visible: true };
}

/**
 * Rebuild a contact set from a layer alone — §13.2's **degradation contract**.
 *
 * A scene re-saved by a build without this module keeps the layer and every per-point field (they
 * ride §4.6's `{ ...layer }` spread) and drops `extensions`. So the module can still recover the
 * contacts, their electrodes and their numbering; what it cannot recover is where they *came from* —
 * every `original` is `null`, which is why the panel says "provenance unknown" and Save becomes
 * Save as… rather than silently writing a table with every row marked `added`.
 */
export function contactSetFromLayer(layer: Layer): ContactSet {
  if (layer.kind !== 'points') return { contacts: [], groups: [] };
  const points = layer.points ?? [];
  const contacts: Contact[] = [];
  const groupOrder: string[] = [];
  const seen = new Map<string, number>();

  points.forEach((point, index) => {
    const name = point.name ?? `p${index + 1}`;
    const group = point.group ?? groupFromName(name);
    if (!groupOrder.includes(group)) groupOrder.push(group);
    const count = (seen.get(group) ?? 0) + 1;
    seen.set(group, count);
    contacts.push({
      id: point.id ?? `p${index}`,
      name,
      group,
      ordinal: point.ordinal ?? ordinalFromName(name) ?? count,
      position: [...point.position] as vec3,
      original: null,
      // The layer carries the name it carries and nothing about where that name came from; a block
      // that knows better puts it back (`mergeBlockIntoSet`).
      originalName: null,
      loadedStatus: null,
      extra: {},
    });
  });

  return {
    contacts,
    groups: groupOrder.map((name, i) => ({ name, color: paletteColor(i), tip: 'auto' as const })),
  };
}

/** The name padding a rebuilt set should use — the width its own names already have. */
export function namePadOfLayer(layer: Layer): number {
  if (layer.kind !== 'points') return 2;
  return namePadOf((layer.points ?? []).map((p) => p.name ?? ''));
}
