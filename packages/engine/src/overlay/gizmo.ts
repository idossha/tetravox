/**
 * The cut-plane gizmo and the oblique rotate handles (§7.5's "oblique affordances", §7.4's gizmo).
 *
 * Two contract facts this file inherits rather than rediscovers:
 *
 * * It is drawn in the **overlay** pass, where §7.2 requires **all clip distances disabled** — "or
 *   the gizmo gets clipped by the plane it manipulates".
 * * Its lines are screen-space quads, never `LINES` + `lineWidth`: `gl.lineWidth()` is a no-op,
 *   `ALIASED_LINE_WIDTH_RANGE` is `[1,1]` `[M2Max]` (§7.0.6).
 *
 * Everything here is **pure layout**: world points in, `OverlayBuilder` quads out, with the pane's
 * own view-projection doing the projecting. That is what lets §11 assert a handle's pixel position
 * without a GL context, and it is why the hit test ({@link gizmoHandleAt}) lives beside the drawing
 * rather than in the pointer layer — a handle you can see and a handle you can grab have to be the
 * same three points, or the gizmo is a picture of a control rather than a control.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import { worldToPane3D } from '../view/geometry';
import type { mat4, Plane, vec3, vec4 } from '../scene/types';

/** Which part of the gizmo a pointer is over, or is dragging. */
export type GizmoHandle = 'translate' | 'rotateU' | 'rotateV';

export interface GizmoSpec {
  /** The plane being manipulated, in §6.0's convention: keep `dot(normal, x) + offset >= 0`. */
  plane: Plane;
  /** World-space centre the handles orbit, normally the scene bounds' centre. */
  center: vec3;
  /** Handle size in world mm. */
  radiusMm: number;
  /** Which handle the pointer is over, for highlight. */
  hot: 'none' | GizmoHandle;
  /**
   * The plane's own in-plane basis — the pane's `right` and `up`.
   *
   * Supplied rather than derived so the rotate handles sit where the *pane* says they do. A gizmo
   * whose `u` came from an arbitrary orthogonalisation would spin under the user's finger the moment
   * the plane passed near whichever axis that orthogonalisation branches on. Omitted,
   * {@link planeBasis} derives a stable pair from the normal alone.
   */
  u?: vec3;
  v?: vec3;
}

export interface GizmoColors {
  ring: vec4;
  /** The handle under the pointer, and the one being dragged. */
  hot: vec4;
}

/** Segments in the ring. 48 keeps a 200 px circle visibly round inside one draw call. */
export const RING_SEGMENTS = 48;
/** Segments per quarter-arc rotate handle. */
export const ARC_SEGMENTS = 12;
/** How close, in pane pixels, the pointer must be to a handle's anchor to grab it. */
export const HANDLE_HIT_PX = 14;
/** Side of a handle knob, in unscaled overlay pixels. */
export const KNOB_PX = 7;

function norm(v: vec3): vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

function cross(a: vec3, b: vec3): vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * A deterministic in-plane basis for a normal: `u` from the world axis **least** aligned with it,
 * `v = normal × u`.
 *
 * Used only when a caller supplies no basis of its own. Choosing the least-aligned axis is what
 * keeps it well-conditioned for every normal, the three canonical ones included.
 */
export function planeBasis(normal: vec3): { u: vec3; v: vec3 } {
  const n = norm(normal);
  const ax =
    Math.abs(n[0]) < Math.abs(n[1])
      ? Math.abs(n[0]) < Math.abs(n[2])
        ? 0
        : 2
      : Math.abs(n[1]) < Math.abs(n[2])
        ? 1
        : 2;
  const seed: vec3 = ax === 0 ? [1, 0, 0] : ax === 1 ? [0, 1, 0] : [0, 0, 1];
  const u = norm(cross(seed, n));
  return { u, v: norm(cross(n, u)) };
}

/** The gizmo's basis: the caller's when it has one, {@link planeBasis}'s otherwise. */
export function gizmoBasis(spec: GizmoSpec): { n: vec3; u: vec3; v: vec3 } {
  const n = norm(spec.plane.normal);
  if (spec.u !== undefined && spec.v !== undefined) {
    return { n, u: norm(spec.u), v: norm(spec.v) };
  }
  return { n, ...planeBasis(n) };
}

/**
 * Where each handle sits in the world: the two rotate handles on the ring along `u` and `v`, the
 * translate handle off the plane along the normal.
 *
 * One function, used by the drawing **and** by the hit test, so what is grabbed is always what is
 * seen.
 */
export function handlePoints(spec: GizmoSpec): Record<GizmoHandle, vec3> {
  const { n, u, v } = gizmoBasis(spec);
  const r = spec.radiusMm;
  const at = (d: vec3): vec3 => [
    spec.center[0] + d[0] * r,
    spec.center[1] + d[1] * r,
    spec.center[2] + d[2] * r,
  ];
  return { rotateU: at(u), rotateV: at(v), translate: at(n) };
}

/** A world point in **pane pixels, bottom-left origin** — the convention every overlay item uses. */
function project(viewProj: mat4, m: OverlayMetrics, world: vec3): [number, number] | null {
  const p = worldToPane3D(viewProj, { width: m.widthPx, height: m.heightPx }, world);
  return p === null ? null : [p[0], m.heightPx - 1 - p[1]];
}

/** A thick screen-space segment — §7.0.6's quad expansion, since `lineWidth` is a no-op. */
function segment(
  b: OverlayBuilder,
  a: [number, number],
  c: [number, number],
  width: number,
  color: vec4
): void {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  b.quad(
    [a[0] + nx, a[1] + ny],
    [c[0] + nx, c[1] + ny],
    [c[0] - nx, c[1] - ny],
    [a[0] - nx, a[1] - ny],
    color
  );
}

/** A filled square centred on a point — the grab target a user aims at. */
function knob(b: OverlayBuilder, at: [number, number], size: number, color: vec4): void {
  b.rect(at[0] - size / 2, at[1] - size / 2, size, size, color);
}

/**
 * Append the gizmo: the plane's ring, two quarter rotate arcs, and the translate stem with knobs.
 *
 * Every vertex is projected through the pane's own `viewProj`, so the gizmo sits **on** the plane in
 * three dimensions rather than being an icon drawn over it — which is what makes a rotate handle
 * point at something the user can reason about. Each arc lies in the plane its drag will sweep: the
 * `rotateU` arc runs from `u` toward the normal, which is exactly the path that handle travels.
 */
export function drawGizmo(
  b: OverlayBuilder,
  m: OverlayMetrics,
  viewProj: mat4,
  spec: GizmoSpec,
  colors: GizmoColors
): void {
  const { n, u, v } = gizmoBasis(spec);
  const r = spec.radiusMm;
  const w = Math.max(1, m.scale);
  const at = (a: vec3, ka: number, c: vec3, kc: number): vec3 => [
    spec.center[0] + a[0] * ka + c[0] * kc,
    spec.center[1] + a[1] * ka + c[1] * kc,
    spec.center[2] + a[2] * ka + c[2] * kc,
  ];

  // The ring: the plane itself, as a circle of radius `r` in (u, v).
  let previous = project(viewProj, m, at(u, r, v, 0));
  for (let i = 1; i <= RING_SEGMENTS; i += 1) {
    const t = (i / RING_SEGMENTS) * Math.PI * 2;
    const next = project(viewProj, m, at(u, r * Math.cos(t), v, r * Math.sin(t)));
    if (previous !== null && next !== null) segment(b, previous, next, w, colors.ring);
    previous = next;
  }

  // The two rotate handles, each a quarter arc out of the plane toward the normal.
  for (const [handle, from] of [
    ['rotateU', u],
    ['rotateV', v],
  ] as [GizmoHandle, vec3][]) {
    const color = spec.hot === handle ? colors.hot : colors.ring;
    let prev = project(viewProj, m, at(from, r, n, 0));
    for (let i = 1; i <= ARC_SEGMENTS; i += 1) {
      const t = (i / ARC_SEGMENTS) * (Math.PI / 2);
      const next = project(viewProj, m, at(from, r * Math.cos(t), n, r * Math.sin(t)));
      if (prev !== null && next !== null) segment(b, prev, next, w, color);
      prev = next;
    }
  }

  // The translate stem, along the normal, and a knob on each of the three handles.
  const points = handlePoints(spec);
  const base = project(viewProj, m, spec.center);
  const tip = project(viewProj, m, points.translate);
  const translateColor = spec.hot === 'translate' ? colors.hot : colors.ring;
  if (base !== null && tip !== null) segment(b, base, tip, w, translateColor);
  for (const handle of ['translate', 'rotateU', 'rotateV'] as GizmoHandle[]) {
    const p = project(viewProj, m, points[handle]);
    if (p !== null) knob(b, p, KNOB_PX * m.scale, spec.hot === handle ? colors.hot : colors.ring);
  }
}

/**
 * Which handle a pane pixel is over — pane-local, **top-left origin**, like every pointer event.
 *
 * The nearest handle within {@link HANDLE_HIT_PX}, or `null`. It reads the same
 * {@link handlePoints} the drawing does, so the hit test cannot drift away from the picture.
 */
export function gizmoHandleAt(
  viewProj: mat4,
  rect: { width: number; height: number },
  spec: GizmoSpec,
  x: number,
  y: number,
  radiusPx: number = HANDLE_HIT_PX
): GizmoHandle | null {
  let best: GizmoHandle | null = null;
  let bestDistance = radiusPx;
  for (const [handle, world] of Object.entries(handlePoints(spec)) as [GizmoHandle, vec3][]) {
    const p = worldToPane3D(viewProj, rect, world);
    if (p === null) continue;
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d <= bestDistance) {
      bestDistance = d;
      best = handle;
    }
  }
  return best;
}
