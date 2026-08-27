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
import { contourInstanceCount, expandContourSegment } from './contours';
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
