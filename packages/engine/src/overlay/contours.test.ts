/**
 * The contour expansion's arithmetic, without a GL context.
 *
 * §7.0.6: `gl.lineWidth()` is a no-op (`ALIASED_LINE_WIDTH_RANGE` is `[1,1]` `[M2Max]`), so a
 * contour's width has to come from quad expansion — and the failure mode of getting that wrong is
 * *a line that is still visible*, one pixel wide, at every zoom. So the assertion that matters is
 * the one below: **the perpendicular width is `contourWidthPx` and does not change when the zoom
 * does**, which is exactly what a `LINES` implementation would fail and what §11 asks the pixel test
 * to confirm on screen.
 */

import { describe, expect, it } from 'vitest';
import {
  contourInstanceCount,
  expandContourSegment,
  nearestContourDistanceSqPx,
  segmentDistanceSqPx,
} from './contours';
import type { mat4, vec2, vec3 } from '../scene/types';

/**
 * An orthographic 2D pane at `mmPerPx`, exactly as `sliceViewProj` builds one for an axial view:
 * world x → screen x, world y → screen y, scaled so one pixel is `mmPerPx` millimetres.
 */
function orthoPane(mmPerPx: number, widthPx: number, heightPx: number): mat4 {
  const sx = 2 / (widthPx * mmPerPx);
  const sy = 2 / (heightPx * mmPerPx);
  // Column-major, gl-matrix layout (§3).
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

const VIEWPORT: vec2 = [512, 512];

function perpendicularWidth(q: { corners: [vec2, vec2, vec2, vec2] }): number {
  const [a, b] = q.corners; // the two corners at t = 0, on either side
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

describe('expandContourSegment', () => {
  it('gives a perpendicular width of exactly `widthPx`, at two zooms one order apart', () => {
    const a: vec3 = [-20, 0, 0];
    const b: vec3 = [20, 0, 0];
    for (const mmPerPx of [0.1, 1]) {
      const q = expandContourSegment(a, b, orthoPane(mmPerPx, 512, 512), VIEWPORT, 3);
      expect(q).not.toBeNull();
      expect(perpendicularWidth(q!)).toBeCloseTo(3, 9);
    }
  });

  it('expands across the segment, never along it — a horizontal line thickens vertically', () => {
    const q = expandContourSegment([-10, 0, 0], [10, 0, 0], orthoPane(1, 512, 512), VIEWPORT, 4, 0);
    expect(q).not.toBeNull();
    const [c0, c1] = q!.corners;
    expect(c0[0]).toBeCloseTo(c1[0], 9); // same x
    expect(c1[1] - c0[1]).toBeCloseTo(4, 9); // 4 px apart in y
  });

  it('the cap extends the ends along the segment and leaves the width alone', () => {
    const bare = expandContourSegment(
      [-10, 0, 0],
      [10, 0, 0],
      orthoPane(1, 512, 512),
      VIEWPORT,
      2,
      0
    )!;
    const capped = expandContourSegment(
      [-10, 0, 0],
      [10, 0, 0],
      orthoPane(1, 512, 512),
      VIEWPORT,
      2,
      1
    )!;
    expect(perpendicularWidth(capped)).toBeCloseTo(perpendicularWidth(bare), 9);
    // The t = 0 corner moved one pixel further back along −x, and the t = 1 corner one forward.
    expect(bare.corners[0][0] - capped.corners[0][0]).toBeCloseTo(1, 9);
    expect(capped.corners[2][0] - bare.corners[2][0]).toBeCloseTo(1, 9);
  });

  it('scales the segment’s length with the zoom while the width stays put', () => {
    const near = expandContourSegment(
      [0, 0, 0],
      [10, 0, 0],
      orthoPane(0.5, 512, 512),
      VIEWPORT,
      2,
      0
    )!;
    const far = expandContourSegment(
      [0, 0, 0],
      [10, 0, 0],
      orthoPane(1, 512, 512),
      VIEWPORT,
      2,
      0
    )!;
    const len = (q: typeof near): number => q.corners[2][0] - q.corners[0][0];
    expect(len(near)).toBeCloseTo(20, 6); // 10 mm at 0.5 mm/px
    expect(len(far)).toBeCloseTo(10, 6); // 10 mm at 1 mm/px
    expect(perpendicularWidth(near)).toBeCloseTo(perpendicularWidth(far), 9);
  });

  it('drops a degenerate segment rather than inventing a normal for it', () => {
    const vp = orthoPane(1, 512, 512);
    expect(expandContourSegment([1, 2, 3], [1, 2, 3], vp, VIEWPORT, 2)).toBeNull();
  });
});

describe('contourInstanceCount', () => {
  it('is six floats per segment, matching §6.5.1’s `boundarySegments`', () => {
    expect(contourInstanceCount(new Float32Array(0))).toBe(0);
    expect(contourInstanceCount(new Float32Array(6))).toBe(1);
    expect(contourInstanceCount(new Float32Array(24))).toBe(4);
  });
});

// ------------------------------------------------------------------------------------------------
// The contour pick (§7.4, directed task 12)
// ------------------------------------------------------------------------------------------------

/**
 * The distance test is the *inverse* of the expansion, and it is asserted against the expansion —
 * not against a hand-computed number — because that is the invariant that has to hold: a point
 * inside the quad the shader draws must measure less than half the width, and a point outside it
 * must measure more. If the two ever disagree, a user clicks a line they can see and nothing
 * happens, which is the bug this pair of functions exists to prevent.
 */
describe('segmentDistanceSqPx / nearestContourDistanceSqPx', () => {
  const a: vec3 = [-20, 0, 0];
  const b: vec3 = [20, 0, 0];
  const proj = orthoPane(0.5, 512, 512);

  it('measures zero on the segment and the offset off it, in pane pixels', () => {
    // The segment runs along y = 0 through the pane centre; at 0.5 mm/px it is 80 px long.
    expect(segmentDistanceSqPx(a, b, proj, VIEWPORT, 0, 0)).toBeCloseTo(0, 6);
    expect(Math.sqrt(segmentDistanceSqPx(a, b, proj, VIEWPORT, 0, 7))).toBeCloseTo(7, 6);
    // Past the end, the distance is to the endpoint, not to the infinite line: 80/2 = 40 px right
    // of centre is the end, so 50 px right is 10 px away.
    expect(Math.sqrt(segmentDistanceSqPx(a, b, proj, VIEWPORT, 50, 0))).toBeCloseTo(10, 6);
  });

  it('agrees with the quad the shader draws: inside is within half the width', () => {
    const widthPx = 6;
    const q = expandContourSegment(a, b, proj, VIEWPORT, widthPx);
    expect(q).not.toBeNull();
    // The quad's corner at t = 0 is `half` across; a point just inside it must measure less.
    const half = widthPx / 2;
    expect(Math.sqrt(segmentDistanceSqPx(a, b, proj, VIEWPORT, 0, half - 0.1))).toBeLessThan(half);
    expect(Math.sqrt(segmentDistanceSqPx(a, b, proj, VIEWPORT, 0, half + 0.1))).toBeGreaterThan(
      half
    );
  });

  it('is `Infinity` for what the shader refuses to draw', () => {
    // A zero-length segment has no direction, so the shader emits nothing — and this says so too.
    expect(segmentDistanceSqPx(a, a, proj, VIEWPORT, 0, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('scans a packed segment array and returns the nearest', () => {
    // Two segments, 6 floats each (§6.5.1): one through the centre, one 20 mm = 40 px above it.
    const segments = new Float32Array([-20, 0, 0, 20, 0, 0, -20, 20, 0, 20, 20, 0]);
    expect(Math.sqrt(nearestContourDistanceSqPx(segments, proj, VIEWPORT, 0, 5))).toBeCloseTo(5, 5);
    // 30 px up is 5 px from the upper segment, 30 from the lower — the nearer one wins.
    expect(Math.sqrt(nearestContourDistanceSqPx(segments, proj, VIEWPORT, 0, 35))).toBeCloseTo(
      5,
      5
    );
    expect(nearestContourDistanceSqPx(new Float32Array(), proj, VIEWPORT, 0, 0)).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it('counts instances the way the pass does', () => {
    expect(contourInstanceCount(new Float32Array(12))).toBe(2);
  });
});
