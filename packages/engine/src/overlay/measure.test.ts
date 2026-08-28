/**
 * `overlay/measure.ts` — the measurement item's geometry, with no GL context (§11).
 *
 * The builder's vertex layout is `[x, y, u, v, r, g, b, a]` in **clip space**, so every assertion
 * here converts back to pane pixels the way `OverlayBuilder.#vertex` converted forwards. What is
 * asserted is the property the item exists for: the segment is a constant number of *pixels* wide
 * whatever its length or angle, the endpoints are marked, and the label is not drawn on top of the
 * line it names.
 */

import { describe, expect, it } from 'vitest';
import { FLOATS_PER_VERTEX, OverlayBuilder, overlayMetrics } from './builder';
import { MEASURE_ENDPOINT_PX, MEASURE_WIDTH_PX, drawMeasurement, onPlane } from './measure';
import type { PlacedMeasurement } from './measure';
import type { vec4 } from '../scene/types';

const W = 200;
const H = 200;
const COLOR: vec4 = [1, 0.45, 0.85, 1];

/** Every vertex the builder holds, back in pane pixels. */
function vertices(data: Float32Array): { x: number; y: number; textured: boolean }[] {
  const out: { x: number; y: number; textured: boolean }[] = [];
  for (let i = 0; i < data.length; i += FLOATS_PER_VERTEX) {
    out.push({
      x: (((data[i] as number) + 1) / 2) * W,
      y: (((data[i + 1] as number) + 1) / 2) * H,
      textured: (data[i + 2] as number) >= 0,
    });
  }
  return out;
}

function build(placed: PlacedMeasurement, uiScale = 1): Float32Array {
  const b = new OverlayBuilder();
  b.begin(W, H);
  drawMeasurement(b, overlayMetrics(W, H, uiScale), placed, COLOR);
  return b.build();
}

/** The perpendicular distance from `p` to the infinite line through `a` and `b`. */
function distanceToLine(
  p: { x: number; y: number },
  a: [number, number],
  b: [number, number]
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return Math.abs((p.x - a[0]) * dy - (p.y - a[1]) * dx) / len;
}

describe('drawMeasurement', () => {
  it('draws a segment of constant screen width, whatever its direction', () => {
    const half = MEASURE_WIDTH_PX / 2;
    for (const end of [
      [180, 20],
      [20, 180],
      [100, 190],
      [190, 100],
    ] as [number, number][]) {
      const a: [number, number] = [20, 20];
      const data = build({ points: [a, end], label: '' });
      // The first six vertices are the segment quad; its corners sit exactly half a width off the
      // centre line, so the drawn ribbon is MEASURE_WIDTH_PX across for every angle.
      const quad = vertices(data).slice(0, 6);
      expect(quad).toHaveLength(6);
      for (const v of quad) expect(distanceToLine(v, a, end)).toBeCloseTo(half, 4);
    }
  });

  it('scales the width with the overlay scale, not with the segment length', () => {
    const a: [number, number] = [20, 100];
    const b: [number, number] = [180, 100];
    for (const scale of [1, 2, 3]) {
      const quad = vertices(build({ points: [a, b], label: '' }, scale)).slice(0, 6);
      const ys = quad.map((v) => v.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(MEASURE_WIDTH_PX * scale, 4);
      // …and the length is untouched by the scale: it is a world quantity projected once.
      const xs = quad.map((v) => v.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(160, 4);
    }
  });

  it('marks every endpoint', () => {
    const pts: [number, number][] = [
      [40, 40],
      [160, 40],
      [160, 160],
    ];
    const vs = vertices(build({ points: pts, label: '' }));
    const t = MEASURE_ENDPOINT_PX;
    for (const p of pts) {
      // A marker is a square centred on the point; its corners are the extreme vertices near it.
      const near = vs.filter(
        (v) => Math.abs(v.x - p[0]) <= t + 0.01 && Math.abs(v.y - p[1]) <= t + 0.01
      );
      expect(near.length, `no marker at ${p.join(',')}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('draws two segments for an angle — the arms that share the vertex', () => {
    const twoPoint = build({
      points: [
        [40, 40],
        [160, 40],
      ],
      label: '',
    });
    const threePoint = build({
      points: [
        [40, 40],
        [160, 40],
        [160, 160],
      ],
      label: '',
    });
    // One more segment quad (6 vertices) and one more endpoint marker (6 vertices).
    expect(threePoint.length - twoPoint.length).toBe(12 * FLOATS_PER_VERTEX);
  });

  it('puts the label clear of the line it names', () => {
    const a: [number, number] = [40, 100];
    const b: [number, number] = [160, 100];
    const vs = vertices(build({ points: [a, b], label: '5.0 MM' }));
    const glyphs = vs.filter((v) => v.textured);
    expect(glyphs.length).toBeGreaterThan(0);
    // Every glyph vertex is off the segment, and on one side of it — text over its own rule is
    // unreadable at any halo strength.
    for (const g of glyphs) expect(Math.abs(g.y - 100)).toBeGreaterThan(MEASURE_WIDTH_PX / 2);
    expect(glyphs.every((g) => g.y > 100) || glyphs.every((g) => g.y < 100)).toBe(true);
  });

  it('draws nothing but a marker for a single point — there is no length yet', () => {
    const vs = vertices(build({ points: [[100, 100]], label: '' }));
    expect(vs).toHaveLength(6);
    expect(vs.every((v) => !v.textured)).toBe(true);
  });
});

describe('onPlane', () => {
  it('accepts a point on the plane and rejects one a slice away', () => {
    const plane = { normal: [0, 0, 1] as [number, number, number], offset: -50 };
    expect(onPlane(plane, [10, 20, 50])).toBe(true);
    expect(onPlane(plane, [10, 20, 50.4])).toBe(true);
    expect(onPlane(plane, [10, 20, 51])).toBe(false);
    // The in-plane coordinates are irrelevant — only the distance along the normal counts.
    expect(onPlane(plane, [1e4, -1e4, 50])).toBe(true);
  });

  it('is symmetric about the plane', () => {
    const plane = { normal: [0, 1, 0] as [number, number, number], offset: 0 };
    expect(onPlane(plane, [0, 0.5, 0])).toBe(onPlane(plane, [0, -0.5, 0]));
    expect(onPlane(plane, [0, 5, 0], 10)).toBe(true);
  });
});
