/**
 * The arithmetic behind `sweep` and `orbit`, kept pure so it can be asserted without a GPU.
 *
 * Both actions are "N frames, each a `set` followed by a `screenshot`", and the only interesting part
 * is where each frame's camera or cursor goes. That part is here; `run.ts` does the engine calls.
 */

import type { Aabb, quat, vec3 } from '@tetravox/engine';

// ------------------------------------------------------------------------------------------------
// sweep
// ------------------------------------------------------------------------------------------------

export interface SweepRange {
  from?: number;
  to?: number;
  step?: number;
  count?: number;
}

/** How many frames a sweep may produce before it is refused, so a typo cannot fill a disk. */
export const MAX_FRAMES = 720;

/**
 * The slice offsets a sweep visits, in millimetres along the view normal (world RAS).
 *
 * `count` is inclusive of both ends — a `count: 10` from −40 to 40 puts a frame *on* −40 and *on* 40 —
 * because that is what a caller asking for "ten slices through the head" means. `step` walks from
 * `from` towards `to` and stops at or before it, with the sign of the step taken from the direction
 * of travel rather than from the caller: `from: 40, to: -40, step: 8` sweeps downwards, and demanding
 * `step: -8` there would be a footgun with no upside.
 *
 * A single-frame sweep (`count: 1`, or a `from` equal to `to`) is legal and yields one offset. That
 * matters because it is what a script that computed its own range from a small ROI ends up asking for.
 *
 * The last frame is at or before `to`, never past it: `from: 0, to: 10, step: 4` gives 0, 4, 8.
 */
export function sweepOffsets(range: SweepRange, bounds: { lo: number; hi: number }): number[] {
  const from = range.from ?? bounds.lo;
  const to = range.to ?? bounds.hi;
  if (range.count !== undefined) {
    const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(range.count)));
    if (count === 1) return [from];
    const span = (to - from) / (count - 1);
    return Array.from({ length: count }, (_, i) => from + span * i);
  }
  const magnitude = Math.abs(range.step ?? 1);
  if (magnitude === 0 || from === to) return [from];
  const step = to >= from ? magnitude : -magnitude;
  const out: number[] = [];
  // Indexed rather than accumulated (`from + step * i`, not `at += step`): accumulation drifts, and
  // the drift is what decides whether the last frame lands. The epsilon on the bound is the matching
  // hygiene — `0 + 0.1 * 10` is 0.9999999999999999, and without it a sweep to 1.0 stops one frame
  // short — and it is nine orders of magnitude below a step, so it can never admit a whole extra one.
  const epsilon = magnitude * 1e-9;
  for (let i = 0; out.length < MAX_FRAMES; i += 1) {
    const at = from + step * i;
    if ((step > 0 && at > to + epsilon) || (step < 0 && at < to - epsilon)) break;
    out.push(at);
  }
  return out;
}

/**
 * The default sweep range for a view: the scene bounds along that normal, inset by 5 %.
 *
 * The inset trims the boundary slices, which are background by construction. It does **not** promise
 * a sweep of nothing but anatomy, and it cannot: a bounding box is the extent of the *volume*, not of
 * what is in it, and `m2m_ernie/T1.nii.gz` is 255 mm tall around a head that occupies maybe 180 of
 * them — so a ten-frame default sweep spends its first two or three frames below the chin. Give
 * `from` and `to` when the sweep is a figure rather than a survey; the default is there so that a
 * caller who does not know the subject's extent still gets a sweep that covers it.
 */
export function boundsAlongNormal(bounds: Aabb, normal: vec3): { lo: number; hi: number } {
  const corners: vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
    }
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    const d = corner[0] * normal[0] + corner[1] * normal[1] + corner[2] * normal[2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const inset = (hi - lo) * 0.05;
  return { lo: lo + inset, hi: hi - inset };
}

/**
 * Move a world point onto the plane `dot(normal, p) = offset`, keeping its in-plane position.
 *
 * This is what makes a sweep a *slice* sweep: the cursor's along-normal component is the slice
 * (§4.5: "the plane is DERIVED — `offset: -dot(normal, scene.cursor)`"), and its in-plane components
 * are where the crosshair sits, which must not wander while the slice steps.
 */
export function cursorAtOffset(cursor: vec3, normal: vec3, offset: number): vec3 {
  const current = cursor[0] * normal[0] + cursor[1] * normal[1] + cursor[2] * normal[2];
  const delta = offset - current;
  return [
    cursor[0] + normal[0] * delta,
    cursor[1] + normal[1] * delta,
    cursor[2] + normal[2] * delta,
  ];
}

// ------------------------------------------------------------------------------------------------
// orbit
// ------------------------------------------------------------------------------------------------

/** Hamilton product, `a` then `b` — the same convention gl-matrix's `quat.multiply` uses. */
export function quatMultiply(a: quat, b: quat): quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatFromAxisAngle(axis: 'x' | 'y' | 'z', radians: number): quat {
  const half = radians / 2;
  const s = Math.sin(half);
  const c = Math.cos(half);
  return axis === 'x' ? [s, 0, 0, c] : axis === 'y' ? [0, s, 0, c] : [0, 0, s, c];
}

export interface OrbitSpec {
  degrees?: number;
  frames?: number;
  axis?: 'x' | 'y' | 'z';
}

/**
 * The camera rotations an orbit visits, starting from `start`.
 *
 * The **first** frame is the camera as it stands and the **last** stops one step short of `degrees`,
 * so a 360° orbit loops seamlessly: a run that included both 0° and 360° would hold the same picture
 * for two frames every lap, which is the classic visible stutter in a turntable GIF.
 *
 * `Camera3D.rotation` is the camera's orientation about `target` (§4.5), so an orbit is a rotation
 * applied on the **left** of it — post-multiplying would spin the camera about its own axis instead
 * of walking it around the head.
 */
export function orbitRotations(start: quat, spec: OrbitSpec): quat[] {
  const frames = Math.max(1, Math.min(MAX_FRAMES, Math.round(spec.frames ?? 36)));
  const degrees = spec.degrees ?? 360;
  const axis = spec.axis ?? 'z';
  const perFrame = (degrees / frames) * (Math.PI / 180);
  const out: quat[] = [];
  for (let i = 0; i < frames; i += 1) {
    out.push(normalizeQuat(quatMultiply(quatFromAxisAngle(axis, perFrame * i), start)));
  }
  return out;
}

/** Renormalise, because `frames` multiplications of a unit quaternion still drift at float32. */
export function normalizeQuat(q: quat): quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (length === 0) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}
