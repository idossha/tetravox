/**
 * §7.5's oblique affordances, the half that needs no GL: where the gizmo's handles are, where its
 * hit test says they are, and what the two plane operations do to a `{ normal, up }`.
 *
 * The property this file exists to pin is that **the handle you see and the handle you grab are the
 * same point**. `drawGizmo` and `gizmoHandleAt` both read `handlePoints`, and the test asserts the
 * hit test against a position derived independently — through the projection maths, from first
 * principles — rather than against whatever `handlePoints` happened to return.
 */

import { describe, expect, it } from 'vitest';
import { quat } from 'gl-matrix';
import {
  ARC_SEGMENTS,
  HANDLE_HIT_PX,
  RING_SEGMENTS,
  drawGizmo,
  gizmoBasis,
  gizmoHandleAt,
  handlePoints,
  planeBasis,
} from './gizmo';
import type { GizmoColors, GizmoSpec } from './gizmo';
import { OverlayBuilder, overlayMetrics } from './builder';
import { camera3dMatrices, planeFromPoints, rotatePlane, worldToPane3D } from '../view/geometry';
import type { Camera3D, vec3 } from '../scene/types';

const COLORS: GizmoColors = { ring: [0, 0.25, 0.5, 1], hot: [1, 0.75, 0.5, 1] };
const RECT = { width: 400, height: 300 };

/**
 * A camera looking at the origin from 400 mm, **tilted** off the plane's normal.
 *
 * Not `defaultView3D`'s identity rotation, deliberately: that looks straight down +Z, which is this
 * gizmo's normal, so the ring collapses to a circle seen face-on and — worse for a test — the
 * translate stem projects to a single point at the pane centre and is skipped as zero-length. The
 * degenerate view is a real case the drawing handles; it is a useless one to assert geometry from.
 */
const TILT = ((): quat => {
  const q = quat.create();
  quat.rotateY(q, q, 0.4);
  quat.rotateX(q, q, -0.6);
  return q;
})();
const CAMERA: Camera3D = {
  target: [0, 0, 0],
  distance: 400,
  rotation: [TILT[0], TILT[1], TILT[2], TILT[3]],
  fovYDeg: 35,
  orthographic: false,
  near: 1,
  far: 2000,
};

const spec = (patch: Partial<GizmoSpec> = {}): GizmoSpec => ({
  plane: { normal: [0, 0, 1], offset: 0 },
  center: [0, 0, 0],
  radiusMm: 60,
  hot: 'none',
  u: [1, 0, 0],
  v: [0, 1, 0],
  ...patch,
});

const dot = (a: vec3, b: vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('planeBasis / gizmoBasis', () => {
  it('produces an orthonormal right-handed frame for any normal', () => {
    for (const n of [
      [0, 0, 1],
      [0, -1, 0],
      [-1, 0, 0],
      [0.5773, 0.5773, 0.5773],
      [0.1, -0.98, 0.05],
    ] as vec3[]) {
      const { u, v } = planeBasis(n);
      expect(Math.hypot(u[0], u[1], u[2]), `|u| for ${n.join(',')}`).toBeCloseTo(1, 6);
      expect(Math.hypot(v[0], v[1], v[2]), `|v| for ${n.join(',')}`).toBeCloseTo(1, 6);
      expect(dot(u, n), `u·n for ${n.join(',')}`).toBeCloseTo(0, 6);
      expect(dot(v, n), `v·n for ${n.join(',')}`).toBeCloseTo(0, 6);
      expect(dot(u, v), `u·v for ${n.join(',')}`).toBeCloseTo(0, 6);
    }
  });

  it('prefers the caller’s basis — the pane’s own right and up — when it has one', () => {
    const { u, v } = gizmoBasis(spec({ u: [0, 1, 0], v: [-1, 0, 0] }));
    expect(u).toEqual([0, 1, 0]);
    expect(v).toEqual([-1, 0, 0]);
  });
});

describe('handlePoints', () => {
  it('puts the rotate handles on the ring and the translate handle off the plane', () => {
    const s = spec();
    const p = handlePoints(s);
    expect(p.rotateU).toEqual([60, 0, 0]);
    expect(p.rotateV).toEqual([0, 60, 0]);
    expect(p.translate).toEqual([0, 0, 60]);
    // Each is exactly `radiusMm` from the centre; the rotate pair is in the plane, the third is not.
    for (const q of Object.values(p)) {
      expect(Math.hypot(q[0], q[1], q[2])).toBeCloseTo(s.radiusMm, 6);
    }
    expect(dot(p.rotateU, s.plane.normal)).toBeCloseTo(0, 6);
    expect(dot(p.translate, s.plane.normal)).toBeCloseTo(s.radiusMm, 6);
  });
});

describe('gizmoHandleAt', () => {
  const { viewProj } = camera3dMatrices(CAMERA, RECT.width, RECT.height);

  it('finds each handle at the pixel the projection puts it at', () => {
    const s = spec();
    for (const [handle, world] of Object.entries(handlePoints(s))) {
      const at = worldToPane3D(viewProj, RECT, world as vec3);
      expect(at, handle).not.toBeNull();
      expect(gizmoHandleAt(viewProj, RECT, s, at![0], at![1]), handle).toBe(handle);
    }
  });

  it('misses by more than the grab radius, and takes the nearest inside it', () => {
    const s = spec();
    const at = worldToPane3D(viewProj, RECT, handlePoints(s).rotateU)!;
    expect(gizmoHandleAt(viewProj, RECT, s, at[0] + HANDLE_HIT_PX - 1, at[1])).toBe('rotateU');
    expect(gizmoHandleAt(viewProj, RECT, s, at[0] + HANDLE_HIT_PX + 2, at[1])).toBeNull();
    // A corner of the pane is nowhere near any of the three.
    expect(gizmoHandleAt(viewProj, RECT, s, 4, 4)).toBeNull();
  });
});

describe('drawGizmo', () => {
  const { viewProj } = camera3dMatrices(CAMERA, RECT.width, RECT.height);
  const metrics = overlayMetrics(RECT.width, RECT.height, 1);

  function build(s: GizmoSpec): OverlayBuilder {
    const b = new OverlayBuilder();
    b.begin(RECT.width, RECT.height);
    drawGizmo(b, metrics, viewProj, s, COLORS);
    return b;
  }

  it('emits exactly the ring, the two arcs, the stem and three knobs', () => {
    // 6 vertices per quad: `RING_SEGMENTS` ring segments + 2 arcs of `ARC_SEGMENTS` + 1 stem, plus
    // 3 knobs. Counting is the honest check that nothing was silently skipped by a null projection.
    const quads = RING_SEGMENTS + 2 * ARC_SEGMENTS + 1 + 3;
    expect(build(spec()).vertexCount).toBe(quads * 6);
  });

  it('draws the hot handle in the hot colour, and only it', () => {
    const cool = build(spec()).build();
    const hot = build(spec({ hot: 'rotateU' })).build();
    expect(hot.length).toBe(cool.length);
    // Layout is identical; only colours move. `OverlayBuilder`'s stride is 8 floats with the colour
    // in slots 4..7, so a differing vertex is a recoloured one.
    let recoloured = 0;
    let moved = 0;
    for (let i = 0; i < cool.length; i += 8) {
      if (cool[i] !== hot[i] || cool[i + 1] !== hot[i + 1]) moved += 1;
      // All four colour channels: the two test colours differ in R and G but share B, and comparing
      // a subset is how a "recoloured" count silently becomes zero.
      if ([4, 5, 6, 7].some((k) => cool[i + k] !== hot[i + k])) recoloured += 1;
    }
    expect(moved).toBe(0);
    // The `rotateU` arc and its knob: (ARC_SEGMENTS + 1) quads of 6 vertices.
    expect(recoloured).toBe((ARC_SEGMENTS + 1) * 6);
  });

  it('draws nothing when the gizmo is entirely behind the eye', () => {
    // 900 mm behind a camera 400 mm from the target: every vertex fails the w > 0 test.
    const behind = build(spec({ center: [0, 0, 900] }));
    expect(behind.vertexCount).toBe(0);
  });
});

describe('planeFromPoints (§7.5’s third affordance)', () => {
  it('is the plane through the three points, with a superior-ish up', () => {
    const plane = planeFromPoints([0, 0, 0], [10, 0, 0], [0, 10, 0]);
    expect(plane).not.toBeNull();
    // (b−a) × (c−a) = +Z for these three.
    expect(plane!.normal[0]).toBeCloseTo(0, 6);
    expect(plane!.normal[1]).toBeCloseTo(0, 6);
    expect(plane!.normal[2]).toBeCloseTo(1, 6);
    // `up` is in the plane and unit length, whichever fallback it took.
    expect(dot(plane!.up, plane!.normal)).toBeCloseTo(0, 6);
    expect(Math.hypot(...plane!.up)).toBeCloseTo(1, 6);
  });

  it('takes the in-plane direction closest to superior when there is one', () => {
    // A vertical plane: `up` must be world +Z exactly, not an arbitrary orthogonalisation.
    const plane = planeFromPoints([0, 0, 0], [0, 0, 10], [10, 0, 0]);
    expect(plane!.up).toEqual([0, 0, 1]);
  });

  it('returns null for collinear or coincident points rather than a NaN normal', () => {
    expect(planeFromPoints([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull();
    expect(planeFromPoints([3, 3, 3], [3, 3, 3], [3, 3, 3])).toBeNull();
  });

  it('is unaffected by the order of the two spanning points, up to the normal’s sign', () => {
    const a = planeFromPoints([0, 0, 0], [10, 0, 0], [0, 10, 0])!;
    const b = planeFromPoints([0, 0, 0], [0, 10, 0], [10, 0, 0])!;
    for (const k of [0, 1, 2] as const) expect(a.normal[k]).toBeCloseTo(-b.normal[k], 6);
  });
});

describe('rotatePlane (the rotate handles)', () => {
  it('rotates the normal by the angle, about the axis given', () => {
    const out = rotatePlane([0, 0, 1], [0, 1, 0], [0, 1, 0], Math.PI / 2);
    // +Z rotated 90 degrees about +Y is +X.
    expect(out.normal[0]).toBeCloseTo(1, 6);
    expect(out.normal[1]).toBeCloseTo(0, 6);
    expect(out.normal[2]).toBeCloseTo(0, 6);
  });

  it('carries `up` along rigidly rather than letting it be re-derived', () => {
    // The defect this exists to prevent: rotating only the normal leaves `up` out of the new plane,
    // and `sliceBasis` then re-orthogonalises it to whatever falls out — the pane rolls.
    const up: vec3 = [0, 1, 0];
    const out = rotatePlane([0, 0, 1], up, [1, 0, 0], 0.4);
    expect(dot(out.up, out.normal)).toBeCloseTo(0, 6);
    // Rotating about +X by 0.4 rad takes (0,1,0) to (0, cos, sin).
    expect(out.up[1]).toBeCloseTo(Math.cos(0.4), 6);
    expect(out.up[2]).toBeCloseTo(Math.sin(0.4), 6);
  });

  it('keeps both vectors unit, and is reversible', () => {
    const there = rotatePlane([0, 0, 1], [0, 1, 0], [0.577, 0.577, 0.577], 0.7);
    const back = rotatePlane(there.normal, there.up, [0.577, 0.577, 0.577], -0.7);
    expect(Math.hypot(...there.normal)).toBeCloseTo(1, 6);
    expect(Math.hypot(...there.up)).toBeCloseTo(1, 6);
    for (const k of [0, 1, 2] as const) {
      expect(back.normal[k]).toBeCloseTo([0, 0, 1][k] ?? 0, 6);
      expect(back.up[k]).toBeCloseTo([0, 1, 0][k] ?? 0, 6);
    }
  });
});
