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

// ------------------------------------------------------------------------------------------------
// tween
// ------------------------------------------------------------------------------------------------

/**
 * The easing curves a `tween` offers (directed task 14, 2026-08-28).
 *
 * `inOut` is the default and the only one a camera move should normally use: a 3D shot that starts
 * and stops abruptly reads as a jump cut even at 30 fps, and the whole reason a showcase tweens a
 * camera rather than stepping it is that the eye can follow an accelerating move and cannot follow a
 * teleport. `in` / `out` exist for a shot that has to hand off to another one already in motion, and
 * `linear` for a caller that wants the frames to mean equal increments of the *parameter* — a slider
 * being demonstrated, rather than a camera being flown.
 */
export type Ease = 'linear' | 'in' | 'out' | 'inOut';

export const EASES: readonly Ease[] = ['linear', 'in', 'out', 'inOut'];

/** The cubic family, on `t ∈ [0, 1]`. Clamped, so a caller's rounding cannot overshoot the end state. */
export function easeFraction(ease: Ease, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (ease) {
    case 'linear':
      return x;
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    default:
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  }
}

/**
 * The eased fraction for each frame of an `n`-frame tween.
 *
 * **Both ends are included** — frame 0 is exactly the start state and the last frame is exactly the
 * end state — which is the opposite of {@link orbitRotations}' choice and for the opposite reason. An
 * orbit is a *loop*, so repeating the start at the end is a stutter; a tween is a *move*, and a move
 * that stops one step short of its destination leaves the scene not quite where the next shot assumes
 * it is. A one-frame tween is legal and is the end state, which is what makes `frames: 1` a usable
 * "hold this" beat.
 */
export function tweenFractions(frames: number, ease: Ease = 'inOut'): number[] {
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(frames)));
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => easeFraction(ease, i / (n - 1)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Interpolate `from` towards `to` at `t`, over whatever shape `to` has.
 *
 * **Only numbers move.** A number is lerped; an array is walked element-wise; an object is walked key
 * by key over the keys `to` names. Anything else — a string colormap, a boolean `visible`, a null —
 * takes its `to` value from the very first frame, because there is no halfway between `'jet'` and
 * `'hot'` and a control that flips at the last frame would look like a glitch rather than a cut.
 * `to` is therefore also the shape of the result: a key `from` has and `to` does not is not in the
 * patch at all, so a tween never writes a field the caller did not name.
 *
 * A leaf where `to` is a number and `from` is not (the caller gave no start, or the live layer had
 * nothing at that path) is held at `to` rather than lerped from an invented zero — a fade that starts
 * from a made-up 0 is a fade the data never had.
 */
export function tweenValue(from: unknown, to: unknown, t: number): unknown {
  if (typeof to === 'number') {
    if (typeof from !== 'number' || !Number.isFinite(from)) return to;
    return from + (to - from) * t;
  }
  if (Array.isArray(to)) {
    const source = Array.isArray(from) ? from : [];
    return to.map((entry, i) => tweenValue(source[i], entry, t));
  }
  if (isPlainObject(to)) {
    const source = isPlainObject(from) ? from : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(to)) out[key] = tweenValue(source[key], value, t);
    return out;
  }
  return to;
}

/**
 * Read the paths `shape` names out of a live object, so a tween with no `from` can start from
 * wherever the scene already is.
 *
 * This is what makes `tween { to: { layers: [{ patch: { opacity: 1 } }] } }` mean "fade this up from
 * whatever it is now" instead of forcing every job to restate the current value — and restating it is
 * exactly the thing that goes stale when an earlier shot is edited.
 */
export function pluckShape(source: unknown, shape: unknown): unknown {
  if (Array.isArray(shape)) {
    const from = Array.isArray(source) ? source : [];
    return shape.map((entry, i) => pluckShape(from[i], entry));
  }
  if (isPlainObject(shape)) {
    const from = isPlainObject(source) ? source : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) out[key] = pluckShape(from[key], value);
    return out;
  }
  return source;
}

/**
 * Turn JSON's `null` into `undefined`, everywhere in a layer patch.
 *
 * JSON has no `undefined`, and §4.4 uses **absence** for "this layer has no isolation / no glyphs /
 * no 3D surface" — `MeshLayer.isolate` and friends are optional fields, and the app clears them by
 * assigning `undefined`. Without this a job could switch those features on and never off again, so
 * `{"isolate": null}` is how a job says "remove it", and it is the only sensible reading of a `null`
 * in a patch: no field of a `Layer` is legitimately null.
 *
 * Arrays are walked too, so a `null` inside one is converted rather than silently kept.
 */
export function nullsToUndefined<T>(value: T): T {
  if (value === null) return undefined as T;
  if (Array.isArray(value)) return value.map((entry) => nullsToUndefined(entry)) as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = nullsToUndefined(entry);
    }
    return out as T;
  }
  return value;
}

/**
 * Deep-merge `patch` onto a copy of `base`.
 *
 * `Engine.updateLayer` merges a patch onto the layer at the **top level only** — that is the right
 * rule for `set`, where the caller writes out the whole value of the field being changed. A tween
 * cannot do that: it names *leaves* (`clip.planes[0].plane.offset`, `isolate.field.lo`,
 * `glyphs.scale.lengthMm`), and a top-level merge would replace the whole `clip` / `isolate` /
 * `glyphs` object with the sparse skeleton the tween built, silently dropping the plane's normal,
 * the isolation's tags and the glyphs' subsampling. So a tween merges its interpolated leaves onto
 * the layer's **current** value first and hands `updateLayer` a complete field.
 *
 * Arrays merge element-wise when both sides are arrays — `planes: [{ plane: { offset } }]` updates
 * plane 0 and leaves plane 1 alone — and a longer patch array wins outright, which is how a tween
 * could add one. `undefined` in the patch means "the base had nothing here", not "delete".
 */
export function mergeOnto(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) {
    const from = Array.isArray(base) ? base : [];
    const length = Math.max(from.length, patch.length);
    return Array.from({ length }, (_, i) =>
      i < patch.length ? mergeOnto(from[i], patch[i]) : from[i]
    );
  }
  if (isPlainObject(patch)) {
    if (!isPlainObject(base)) return patch;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) out[key] = mergeOnto(base[key], value);
    return out;
  }
  return patch;
}
