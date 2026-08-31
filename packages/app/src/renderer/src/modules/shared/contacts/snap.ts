/**
 * Snapping contacts onto the metal they are inside.
 *
 * The arithmetic is **not here**: it is `derived/voxel-box.ts#peakCentroid`, the engine's §4.3
 * bounded local read, reached through `host.scene.peakCentroid`. This file is the *scope* — which
 * contacts, at what radius, and what to report — because "where is this contact really" must have
 * exactly one implementation, shared by the engine, the app's `NoGlEngine` and every module
 * (DECISIONS 2026-08-30).
 *
 * The peak function is injected rather than the host, so this is a pure function of a set, a scope
 * and an oracle: a test drives it with a hand-written blob and no engine at all.
 *
 * **A contact the oracle refuses does not move**, and it is not counted. `peakCentroid` returns
 * `null` for a query outside the volume, for a mesh, and for a box with nothing in it to weigh — all
 * three mean "there is no metal here", and moving the contact to the box centre would be a snap that
 * pretended to have found something.
 */

import type { vec3 } from '@tetravox/engine';
import type { ContactSet } from './model';
import { distanceMm } from './geometry';

/** `host.scene.peakCentroid`, bound to a dataset. `null` = nothing found. */
export type PeakFn = (world: vec3, radiusMm: number) => vec3 | null;

export interface SnapResult {
  /** How many contacts the oracle answered for. */
  moved: number;
  /** The mean distance those contacts travelled, in millimetres. 0 when none moved. */
  meanShiftMm: number;
  /** The new position for each contact that moved, by contact id. */
  positions: Map<string, vec3>;
}

/** The smallest and largest snap radius the panel offers, and its default (Slicer's). */
export const SNAP_RADIUS_MIN_MM = 0.5;
export const SNAP_RADIUS_MAX_MM = 5;
export const SNAP_RADIUS_STEP_MM = 0.25;
export const SNAP_RADIUS_DEFAULT_MM = 1.5;

export function clampSnapRadius(value: number): number {
  if (!Number.isFinite(value)) return SNAP_RADIUS_DEFAULT_MM;
  return Math.min(SNAP_RADIUS_MAX_MM, Math.max(SNAP_RADIUS_MIN_MM, value));
}

/**
 * Snap the named contacts, returning what would move without mutating anything.
 *
 * A pure result rather than an in-place edit so the caller can make it **one** history entry and one
 * dirty mark whatever the scope was — snapping 103 contacts is one undo step, not 103.
 */
export function snapContacts(
  set: ContactSet,
  ids: readonly string[],
  radiusMm: number,
  peak: PeakFn
): SnapResult {
  const wanted = new Set(ids);
  const positions = new Map<string, vec3>();
  let total = 0;
  for (const contact of set.contacts) {
    if (!wanted.has(contact.id)) continue;
    const found = peak(contact.position, radiusMm);
    if (found === null) continue;
    positions.set(contact.id, [...found] as vec3);
    total += distanceMm(contact.position, found);
  }
  const moved = positions.size;
  return { moved, meanShiftMm: moved === 0 ? 0 : total / moved, positions };
}

/** Apply a {@link SnapResult} to a set, returning a new set — the array is replaced, never mutated. */
export function applySnap(set: ContactSet, result: SnapResult): ContactSet {
  if (result.positions.size === 0) return set;
  return {
    groups: set.groups,
    contacts: set.contacts.map((contact) => {
      const found = result.positions.get(contact.id);
      return found === undefined ? contact : { ...contact, position: found };
    }),
  };
}
