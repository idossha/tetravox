/**
 * The geometry of a **depth electrode**, as opposed to the geometry of any contact set.
 *
 * `shared/contacts/geometry.ts` fits the line; this file knows what an sEEG shaft *is*: a rigid rod
 * pushed through the skull, contacts evenly spaced along it, numbered **1 at the deepest end**. Every
 * rule below is a fact about that hardware and about a head, which is exactly why none of it belongs
 * in the shared library (`shared/contacts/README.md`).
 *
 * ## The tip rule, stated
 *
 * Slicer's `_tipSign` is a **stub**: its docstring describes a heuristic and its body is
 * `return 1.0  # neutral default`, so "Renumber tip-first" there numbers from whichever end the line
 * fit happened to point at, and the module's own README lists "verify contact 1 = deepest" as a known
 * limitation. This build implements the heuristic the docstring describes, and states it:
 *
 * > **Contact 1 is the end of the shaft nearer the reference centre; the entry is the end farther
 * > from it.** The reference is the centre of the bound volume's bounding box — the head, near
 * > enough — falling back to the centroid of every contact in the set when there is no volume.
 *
 * Why that reference and not the electrode's own centroid: a shaft's own centroid lies *between* its
 * ends, so both ends are about equidistant from it and the rule would be a coin toss. The head's
 * centre is the thing "deep" is measured against, and every shaft is inserted from the outside
 * inward. It is a **heuristic**, not a brain mask: an occipital shaft entering close to the midline
 * can defeat it, which is why the tip is shown in the panel, `t` flips it, and **nothing renumbers
 * implicitly** — see below.
 *
 * ## What renumbers, and what does not
 *
 * Only **Re-fit** and **Renumber tip-first** ever change a contact's number or name. Loading a table,
 * placing a contact, dragging one, snapping and deleting all leave the numbering exactly as it was.
 * So a clinical table's numbering — which is wired to the recording system through `csc` — can only
 * be changed by a button that says it changes it. Re-fit relabels because that is what Slicer's
 * Re-fit does and what its label promises; it does not re-derive the tip, it uses the electrode's
 * current one.
 */

import type { vec3 } from '@tetravox/engine';
import type { Contact, ContactSet, Group, TipEnd } from '../shared/contacts/model';
import { contactName, contactsOf } from '../shared/contacts/model';
import {
  centroidOf,
  distanceMm,
  fitLine,
  lineMetrics,
  orderAlong,
  respaceEven,
} from '../shared/contacts/geometry';

/** Two ends that are this close to equidistant from the reference are a tie, in millimetres. */
const TIP_TIE_MM = 1e-6;

/** Which end of the fitted line is the tip, by the heuristic above. `'low'` on a tie or no fit. */
export function tipEnd(positions: readonly vec3[], reference: vec3): 'low' | 'high' {
  const fit = fitLine(positions);
  if (fit === null) return 'low';
  const order = orderAlong(positions);
  const low = positions[order[0] as number] as vec3;
  const high = positions[order[order.length - 1] as number] as vec3;
  const dLow = distanceMm(low, reference);
  const dHigh = distanceMm(high, reference);
  // Nearer the head's centre is deeper. A tie keeps the low end, so the rule is total.
  return dHigh < dLow - TIP_TIE_MM ? 'high' : 'low';
}

/** The end this electrode is numbered from: what the user pinned, or the heuristic. */
export function resolveTip(
  group: Group,
  positions: readonly vec3[],
  reference: vec3
): 'low' | 'high' {
  return group.tip === 'auto' ? tipEnd(positions, reference) : group.tip;
}

/** `t` — pin the other end, whichever one is currently in force. Never `'auto'` again. */
export function flippedTip(group: Group, positions: readonly vec3[], reference: vec3): TipEnd {
  return resolveTip(group, positions, reference) === 'low' ? 'high' : 'low';
}

/**
 * The reference the tip rule measures "deep" against.
 *
 * The centre of the bound volume's bounds when there is one, and otherwise the centroid of every
 * contact in the set — which is a poor proxy for one electrode and a decent one for a whole implant.
 */
export function tipReference(bounds: { min: vec3; max: vec3 } | null, set: ContactSet): vec3 {
  if (bounds !== null) {
    return [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
  }
  return centroidOf(set.contacts.map((c) => c.position)) ?? [0, 0, 0];
}

/** The contacts of `group`, ordered from the tip outward. */
export function tipFirstOrder(contacts: readonly Contact[], tip: 'low' | 'high'): Contact[] {
  const order = orderAlong(contacts.map((c) => c.position));
  const along = order.map((index) => contacts[index] as Contact);
  return tip === 'low' ? along : along.reverse();
}

/** One electrode's three numbers, for the panel and for the `stats` operation. */
export interface ShaftStats {
  electrode: string;
  n: number;
  rmsMm: number | null;
  spacingCv: number | null;
  pitchMm: number | null;
}

export function shaftStats(set: ContactSet, group: string): ShaftStats {
  const contacts = contactsOf(set, group);
  const metrics = lineMetrics(contacts.map((c) => c.position));
  return {
    electrode: group,
    n: contacts.length,
    rmsMm: metrics?.rmsMm ?? null,
    spacingCv: metrics?.spacingCv ?? null,
    pitchMm: metrics?.pitchMm ?? null,
  };
}

/** Every electrode's stats, in the set's group order — the `stats` operation's result. */
export function allShaftStats(set: ContactSet): ShaftStats[] {
  return set.groups.map((group) => shaftStats(set, group.name));
}

/** Replace the named contacts inside a set, keeping the array's (drawing) order. */
function withContacts(set: ContactSet, replaced: readonly Contact[]): ContactSet {
  const byId = new Map(replaced.map((c) => [c.id, c]));
  return { groups: set.groups, contacts: set.contacts.map((c) => byId.get(c.id) ?? c) };
}

export interface RenumberResult {
  set: ContactSet;
  /** The names that changed, `old → new`, for a toast and for the editlog. */
  renamed: { from: string; to: string }[];
}

/**
 * Number one electrode 1…n from the tip, **without moving anything**.
 *
 * The contact nearest the tip becomes 1, and every name becomes `<ELEC><n>` zero-padded to `pad` —
 * the width the file's own names use, which is the half Slicer got wrong (`LINS01` relabelled to
 * `LINS1`, so the next load read every contact as `added`).
 */
export function renumberTipFirst(
  set: ContactSet,
  group: string,
  reference: vec3,
  pad: number
): RenumberResult {
  const contacts = contactsOf(set, group);
  if (contacts.length === 0) return { set, renamed: [] };
  const spec = set.groups.find((g) => g.name === group);
  const tip =
    spec === undefined
      ? 'low'
      : resolveTip(
          spec,
          contacts.map((c) => c.position),
          reference
        );
  const ordered = tipFirstOrder(contacts, tip);
  const renamed: { from: string; to: string }[] = [];
  const next = ordered.map((contact, index) => {
    const name = contactName(group, index + 1, pad);
    if (name !== contact.name) renamed.push({ from: contact.name, to: name });
    return { ...contact, name, ordinal: index + 1 };
  });
  return { set: withContacts(set, next), renamed };
}

export interface RefitResult {
  set: ContactSet;
  stats: ShaftStats;
  renamed: { from: string; to: string }[];
}

/**
 * Re-fit one shaft: PCA line → project → re-space at the median gap → relabel tip-first.
 *
 * Slicer's `refitShaft`, with its two defects fixed. The **tip** is the electrode's own — pinned by
 * the user or derived by the stated heuristic — rather than an unconditional `+1`; and the relabel
 * pads to the file's width rather than dropping the leading zero.
 *
 * The contact nearest the tip keeps the tip slot, so a shaft whose contacts were already in order
 * stays in order and only moves onto the ideal grid. Its `original` is untouched: the point of
 * re-fitting is that the *file's* positions were noisy, and `status` has to keep saying so.
 */
export function refitShaft(
  set: ContactSet,
  group: string,
  reference: vec3,
  pad: number
): RefitResult | null {
  const contacts = contactsOf(set, group);
  if (contacts.length < 2) return null;
  const spec = set.groups.find((g) => g.name === group);
  const tip =
    spec === undefined
      ? 'low'
      : resolveTip(
          spec,
          contacts.map((c) => c.position),
          reference
        );

  const positions = contacts.map((c) => c.position);
  const spaced = respaceEven(positions);
  if (spaced === null) return null;
  // `respaceEven` answers in ascending-`t` order; the tip decides which end of that is contact 1.
  const slots = tip === 'low' ? spaced : [...spaced].reverse();

  const ordered = tipFirstOrder(contacts, tip);
  const renamed: { from: string; to: string }[] = [];
  const next = ordered.map((contact, index) => {
    const name = contactName(group, index + 1, pad);
    if (name !== contact.name) renamed.push({ from: contact.name, to: name });
    return { ...contact, name, ordinal: index + 1, position: slots[index] as vec3 };
  });

  const after = withContacts(set, next);
  return { set: after, stats: shaftStats(after, group), renamed };
}
