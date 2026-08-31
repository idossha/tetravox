/**
 * The selection ring's geometry, from first principles (§11 rule 0: numbers before pictures).
 *
 * The interesting half is {@link discRadiusPx}, which restates the vertex shader's rule on the CPU.
 * Every case below is one line of `shaders/points.ts` read back as arithmetic — the sphere ∩ plane
 * radius, the cull, the ghost's full radius and the `dot` branch's constant pixels — because the
 * failure this file exists to prevent is a ring at a radius the disc does not have, which says the
 * tool has selected something other than what the user can see.
 */

import { describe, expect, it } from 'vitest';
import {
  DOT_RADIUS_MAX_PX,
  DOT_RADIUS_MIN_PX,
  DOT_RADIUS_PX,
  POINT_RING_GAP_PX,
  POINT_RING_MIN_RADIUS_PX,
  POINT_RING_SEGMENTS,
  discRadiusPx,
  dotRadiusPxOf,
  drawPointRing,
  ringRadiusPx,
} from './point-ring';
import { FLOATS_PER_VERTEX, OverlayBuilder, overlayMetrics } from './builder';

const SPHERE = { shape: 'sphere' as const, radiusMm: 2 };
const DOT = { shape: 'dot' as const, radiusMm: 2 };

describe('dotRadiusPxOf', () => {
  it('is 4 px when absent — what every layer written before §4.4 gained the field says', () => {
    expect(dotRadiusPxOf({})).toBe(DOT_RADIUS_PX);
    expect(dotRadiusPxOf({ dotRadiusPx: undefined })).toBe(DOT_RADIUS_PX);
  });

  it('clamps, because a scene file is editable text', () => {
    expect(dotRadiusPxOf({ dotRadiusPx: 10 })).toBe(10);
    expect(dotRadiusPxOf({ dotRadiusPx: 0 })).toBe(DOT_RADIUS_MIN_PX);
    expect(dotRadiusPxOf({ dotRadiusPx: -3 })).toBe(DOT_RADIUS_MIN_PX);
    expect(dotRadiusPxOf({ dotRadiusPx: 5000 })).toBe(DOT_RADIUS_MAX_PX);
    // NaN would delete the quad rather than resize it, so it is not a size at all.
    expect(dotRadiusPxOf({ dotRadiusPx: Number.NaN })).toBe(DOT_RADIUS_PX);
    expect(dotRadiusPxOf({ dotRadiusPx: Infinity })).toBe(DOT_RADIUS_PX);
  });
});

describe('discRadiusPx', () => {
  it('is the sphere ∩ plane radius, in DEVICE pixels', () => {
    // 3-4-5: a 5 mm sphere whose centre is 3 mm off the plane cuts a 4 mm circle. At 0.05 mm per
    // device pixel that is 80 device pixels.
    expect(discRadiusPx({ shape: 'sphere', radiusMm: 5 }, 5, 3, 0.05, 1)).toBeCloseTo(80, 9);
    expect(discRadiusPx({ shape: 'sphere', radiusMm: 5 }, 5, -3, 0.05, 1)).toBeCloseTo(80, 9);
  });

  it('does NOT scale a world radius by uiScale — mmPerPx is already per device pixel', () => {
    // The regression this case exists for. `Camera2D.mmPerPx` is millimetres per *device* pixel
    // (`fitMmPerPx` is fed device-pixel rects; `sliceViewProj`'s ortho box is `widthPx · mmPerPx`
    // over a device-pixel width), and the shader draws a world-space quad of radius `r` mm with no
    // `uiScale` anywhere in it. A CPU rule that multiplied by `uiScale` put the ring and the hit
    // radius at twice the drawn disc on every Retina display, where DPR-1 §11 panes cannot see it.
    for (const uiScale of [1, 2, 3]) {
      expect(discRadiusPx({ shape: 'sphere', radiusMm: 5 }, 5, 3, 0.05, uiScale)).toBeCloseTo(
        80,
        9
      );
    }
    // The equivalent statement about the picture: at DPR 2 the same physical pane has half the
    // millimetres per pixel, so the disc is twice as many device pixels — and it gets there through
    // `mmPerPx`, not through `uiScale`.
    expect(discRadiusPx(SPHERE, 2, 0, 0.1, 1)).toBeCloseTo(20, 9);
    expect(discRadiusPx(SPHERE, 2, 0, 0.05, 2)).toBeCloseTo(40, 9);
  });

  it('takes §4.4’s dotRadiusPx for the `dot` branch, and 4 px when there is none', () => {
    // The A4 half: the marker's size is a layer field, and the ring reads the same one the shader
    // does. Absent is the constant every scene written before the field carries.
    expect(discRadiusPx({ ...DOT, dotRadiusPx: 9 }, 2, 0, 0.05, 1)).toBe(9);
    expect(discRadiusPx({ ...DOT, dotRadiusPx: 9 }, 2, 0, 0.05, 2)).toBe(18);
    expect(discRadiusPx(DOT, 2, 0, 0.05, 1)).toBe(DOT_RADIUS_PX);
    // A sphere layer does not read it: its size is `radiusMm`, all the way through.
    expect(discRadiusPx({ ...SPHERE, dotRadiusPx: 9 }, 2, 0, 0.05, 1)).toBeCloseTo(40, 9);
  });

  it('scales the `dot` branch by uiScale, because THAT radius is authored in CSS pixels', () => {
    // `derived.ts` sends `uDotPx = 4 * uiScale` and the shader turns it into `uDotPx * uMmPerPx`
    // millimetres, i.e. `4 * uiScale` device pixels. The asymmetry with the sphere branch is the
    // whole point: one radius is a world quantity and the other is a screen one.
    expect(discRadiusPx(DOT, 2, 0, 0.05, 2)).toBe(DOT_RADIUS_PX * 2);
    expect(discRadiusPx(DOT, 2, 0, 0.05, 1)).toBe(DOT_RADIUS_PX);
  });

  it('is the whole radius on the plane, and shrinks to nothing at the edge', () => {
    expect(discRadiusPx(SPHERE, 2, 0, 0.1, 1)).toBeCloseTo(20, 9);
    // `|d|` a hair inside `r` still cuts a circle, however small.
    const sliver = discRadiusPx(SPHERE, 2, 1.999999, 0.1, 1);
    expect(sliver).not.toBeNull();
    expect(sliver!).toBeLessThan(0.1);
  });

  it('culls a point off the slice, and that is what absent offPlaneOpacity means', () => {
    expect(discRadiusPx(SPHERE, 2, 2, 0.1, 1)).toBeNull();
    expect(discRadiusPx(SPHERE, 2, 10, 0.1, 1)).toBeNull();
    expect(discRadiusPx({ ...SPHERE, offPlaneOpacity: 0 }, 2, 10, 0.1, 1)).toBeNull();
  });

  it('ghosts at the FULL radius, not at a vanishing cross-section', () => {
    // 10 mm off a 2 mm sphere: no circle exists, so a ghost can only be the whole disc.
    expect(discRadiusPx({ ...SPHERE, offPlaneOpacity: 0.6 }, 2, 10, 0.1, 1)).toBeCloseTo(20, 9);
    // …and on the slice the ghost changes nothing: the cross-section is still the cross-section.
    expect(discRadiusPx({ ...SPHERE, offPlaneOpacity: 0.6 }, 2, 0, 0.1, 1)).toBeCloseTo(20, 9);
  });

  it("gives 'dot' a constant pixel radius, after the same world cull", () => {
    expect(discRadiusPx(DOT, 2, 0, 0.1, 1)).toBe(DOT_RADIUS_PX);
    expect(discRadiusPx(DOT, 2, 1.5, 0.001, 1)).toBe(DOT_RADIUS_PX);
    expect(discRadiusPx(DOT, 2, 0, 0.1, 2)).toBe(DOT_RADIUS_PX * 2);
    // Culled by world distance like a sphere — a screen marker still belongs to a slice.
    expect(discRadiusPx(DOT, 2, 10, 0.1, 1)).toBeNull();
    // …unless it ghosts, and then it is the same 4 px it always is.
    expect(discRadiusPx({ ...DOT, offPlaneOpacity: 0.6 }, 2, 10, 0.1, 1)).toBe(DOT_RADIUS_PX);
  });

  it('takes the point-level radius, not the layer-level one', () => {
    // A per-point `radiusMm` overrides the layer's in `packPoints`, so it must here too.
    expect(discRadiusPx(SPHERE, 6, 0, 0.1, 1)).toBeCloseTo(60, 9);
  });

  it('refuses a degenerate camera rather than returning Infinity', () => {
    expect(discRadiusPx(SPHERE, 2, 0, 0, 1)).toBeNull();
  });
});

describe('ringRadiusPx', () => {
  it('sits one gap outside the disc — §7.2\'s "r + 2 px"', () => {
    expect(ringRadiusPx(40, 1)).toBe(40 + POINT_RING_GAP_PX);
    expect(ringRadiusPx(40, 2)).toBe(40 + POINT_RING_GAP_PX * 2);
  });

  it('never collapses into a dot, however small the disc', () => {
    // A 0.2 px cross-section is a point on the very edge of its slice. A ring 2.2 px across is
    // indistinguishable from the thing it is meant to distinguish, so there is a floor.
    expect(ringRadiusPx(0.2, 1)).toBe(POINT_RING_MIN_RADIUS_PX);
    expect(ringRadiusPx(0.2, 2)).toBe(POINT_RING_MIN_RADIUS_PX * 2);
  });
});

/**
 * `OverlayBuilder` stores NDC, not pixels (`#vertex` normalises by the pane size), so the assertions
 * below convert back. Doing that here rather than asserting on NDC is the point: the claims are
 * about a ring on a screen, and a reader should be able to check them against §7.2's "r + 2 px".
 */
function vertices(b: OverlayBuilder, widthPx: number, heightPx: number): [number, number][] {
  const data = b.build();
  const out: [number, number][] = [];
  for (let i = 0; i < b.vertexCount; i += 1) {
    const o = i * FLOATS_PER_VERTEX;
    out.push([(((data[o] ?? 0) + 1) / 2) * widthPx, (((data[o + 1] ?? 0) + 1) / 2) * heightPx]);
  }
  return out;
}

const mid = (a: [number, number], b: [number, number]): [number, number] => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
];

describe('drawPointRing', () => {
  it('emits exactly one quad per segment', () => {
    const b = new OverlayBuilder();
    b.begin(200, 200);
    const m = overlayMetrics(200, 200, 1);
    drawPointRing(b, m, [100, 100], 40, 2, [1, 0, 0, 1]);
    // 6 vertices per quad (`OverlayBuilder.quad` is two triangles).
    expect(b.vertexCount).toBe(POINT_RING_SEGMENTS * 6);
  });

  it('puts its vertices a ring radius from the centre, within half its width', () => {
    const b = new OverlayBuilder();
    b.begin(200, 200);
    const m = overlayMetrics(200, 200, 1);
    const width = 2;
    drawPointRing(b, m, [100, 100], 40, width, [1, 0, 0, 1]);
    const r = ringRadiusPx(40, m.scale);
    let min = Infinity;
    let max = -Infinity;
    for (const [x, y] of vertices(b, 200, 200)) {
      const d = Math.hypot(x - 100, y - 100);
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    // A polygon's corners sit on the radius; the quad expansion pushes them half a width either
    // way, and the chord sag pulls the inner ones in by `r(1 − cos(π/segments))` more.
    const sag = r * (1 - Math.cos(Math.PI / POINT_RING_SEGMENTS));
    expect(max).toBeLessThanOrEqual(r + width / 2 + 1e-6);
    expect(min).toBeGreaterThanOrEqual(r - width / 2 - sag - 1e-6);
    // …and it really is a ring, not an arc: the outermost and innermost agree to within the width.
    expect(max - min).toBeLessThanOrEqual(width + sag + 1e-6);
  });

  it('closes: the last segment ends where the first began', () => {
    const b = new OverlayBuilder();
    b.begin(200, 200);
    const m = overlayMetrics(200, 200, 1);
    drawPointRing(b, m, [100, 100], 40, 2, [1, 0, 0, 1]);
    const v = vertices(b, 200, 200);
    // `quad(a, b, c, d)` emits `a b c a c d`, where `a`/`d` straddle the segment's start and `b`/`c`
    // its end. So the first segment starts at `mid(v0, v5)` and the last ends at `mid(v1, v2)` of
    // the final quad — the same ring point, or the circle has a notch in it.
    const start = mid(v[0]!, v[5]!);
    const end = mid(v[b.vertexCount - 5]!, v[b.vertexCount - 4]!);
    expect(Math.hypot(start[0] - end[0], start[1] - end[1])).toBeLessThan(1e-6);
  });
});
