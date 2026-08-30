/**
 * The points layer's pure functions: what goes into the instance buffer, what a probe row says, and
 * — since §13's point tool (2026-08-30) — which point a pane pixel grabs.
 *
 * Both are exercised without a GL context on purpose — §11's rule 0 cuts this way for anything that
 * is not a pixel: the packing is eight floats in a fixed order, and an off-by-one there paints every
 * electrode with its neighbour's colour, which looks plausible and is wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  POINT_INSTANCE_FLOATS,
  nearestPoint,
  packPoints,
  pointAtPane,
  pointAtPane3D,
  pointIdAt,
} from './points';
import type { PanePlacement } from './points';
import type { mat4, PointsLayer, SliceView } from '../scene/types';

function layer(over: Partial<PointsLayer> = {}): PointsLayer {
  return {
    id: 'l1',
    datasetId: 'ds1',
    name: 'Electrodes',
    visible: true,
    opacity: 1,
    pickable: false,
    showColorbar: false,
    kind: 'points',
    points: [],
    shape: 'sphere',
    radiusMm: 4,
    color: [1, 0.85, 0.2, 1],
    showLabels: false,
    ...over,
  };
}

describe('packPoints', () => {
  it('writes centre, colour and radius per instance, in that order', () => {
    const l = layer({
      points: [
        { position: [1, 2, 3], name: 'Fp1' },
        { position: [4, 5, 6], color: [0, 0.5, 1, 0.25], radiusMm: 7 },
      ],
    });
    const a = packPoints(l);
    expect(a.length).toBe(2 * POINT_INSTANCE_FLOATS);
    // The first falls back to the layer's colour and radius.
    expect([...a.subarray(0, 8)]).toEqual([
      1, 2, 3, 1, 0.8500000238418579, 0.20000000298023224, 1, 4,
    ]);
    // The second carries its own.
    expect([...a.subarray(8, 16)]).toEqual([4, 5, 6, 0, 0.5, 1, 0.25, 7]);
  });

  it('is empty for a layer with no points', () => {
    expect(packPoints(layer()).length).toBe(0);
  });
});

describe('nearestPoint', () => {
  it('finds the closest point and reports its index, name and distance', () => {
    const l = layer({
      points: [
        { position: [0, 0, 0], name: 'A' },
        { position: [10, 0, 0], name: 'B' },
      ],
    });
    const near = nearestPoint(l, [9, 0, 0]);
    expect(near).toEqual({ index: 1, name: 'B', distance: 1 });
  });

  it('is null when there is nothing to find', () => {
    expect(nearestPoint(layer(), [0, 0, 0])).toBeNull();
  });
});

/**
 * `valueMode: 'value'` — a parsed view's per-point scalar through the layer's colormap (task 6).
 *
 * Resolved on the CPU in `packPoints`, so it is asserted here rather than as a pixel: the whole
 * point of keeping `points[].value` alongside the colour is that a colormap change recolours the
 * layer without reloading the file, and that is a property of this function.
 */
describe('point colours from a value', () => {
  const withValues = (over: Partial<PointsLayer> = {}): PointsLayer =>
    layer({
      points: [
        { position: [0, 0, 0], value: 0 },
        { position: [1, 0, 0], value: 1 },
      ],
      valueRange: { lo: 0, hi: 1 },
      colormap: 'viridis',
      ...over,
    });

  it('leaves every point the layer colour in the default solid mode', () => {
    const packed = packPoints(withValues());
    // The buffer is f32, so the layer's 0.85 comes back as its nearest float.
    for (const at of [3, 11]) {
      expect(packed[at]).toBeCloseTo(1, 6);
      expect(packed[at + 1]).toBeCloseTo(0.85, 6);
      expect(packed[at + 2]).toBeCloseTo(0.2, 6);
      expect(packed[at + 3]).toBeCloseTo(1, 6);
    }
  });

  it('maps the range endpoints to the colormap endpoints', () => {
    const packed = packPoints(withValues({ valueMode: 'value' }));
    const lo = [...packed.slice(3, 6)];
    const hi = [...packed.slice(11, 14)];
    expect(lo).not.toEqual(hi);
    // viridis runs dark blue-purple → bright yellow-green, so the top of the range is brighter.
    expect(hi[1]).toBeGreaterThan(lo[1] as number);
    // Alpha comes from the layer, so layer opacity and per-point colour stay separable.
    expect(packed[6]).toBe(1);
  });

  /**
   * Every SimNIBS net writes `{0}` for every electrode. A flat field has no gradient to show, so
   * it takes the colormap's midpoint — never a division by zero, and never all-black.
   */
  it('maps a flat field to the colormap midpoint', () => {
    const flat = withValues({
      valueMode: 'value',
      points: [
        { position: [0, 0, 0], value: 0 },
        { position: [1, 0, 0], value: 0 },
      ],
      valueRange: { lo: 0, hi: 0 },
    });
    const packed = packPoints(flat);
    expect([...packed.slice(3, 7)]).toEqual([...packed.slice(11, 15)]);
    expect(Number.isFinite(packed[3])).toBe(true);
    expect(packed[3]).toBeGreaterThan(0);
  });

  it('lets a per-point colour win over the value, as it does over the layer colour', () => {
    const packed = packPoints(
      withValues({
        valueMode: 'value',
        points: [{ position: [0, 0, 0], value: 1, color: [0, 1, 0, 1] }],
      })
    );
    expect([...packed.slice(3, 7)]).toEqual([0, 1, 0, 1]);
  });
});

// -------------------------------------------------------------------------------------------------
// §13's point tool (2026-08-30): the 2D and 3D hit tests.
//
// Every pixel below is derived from the pane's own ruler, never measured: the axial pane is 200×200
// at `mmPerPx = 0.5` with the cursor and the anchor both at the origin, so world `(x, y, ·)` is at
// pane pixel `(100 + x/0.5 − 0.5, 100 − y/0.5 − 0.5)` — §11's pixel-centre convention, which
// `paneToWorld`/`worldToPane` implement as exact inverses.
// -------------------------------------------------------------------------------------------------

const PANE = { width: 200, height: 200 };

/** An axial pane: `normal = +Z`, `up = +Y`, so `right = cross(up, normal) = +X` (§3). */
const axial: SliceView = {
  id: 'axial',
  mode: 'axial',
  normal: [0, 0, 1],
  up: [0, 1, 0],
  camera: { center: [0, 0], mmPerPx: 0.5 },
};

const place: PanePlacement = {
  view: axial,
  cursor: [0, 0, 0],
  anchor: [0, 0, 0],
  radiological: false,
  rect: PANE,
  uiScale: 1,
};

/** The pane pixel a world point projects to, from the ruler above rather than from the engine. */
const at = (x: number, y: number): [number, number] => [100 + x / 0.5 - 0.5, 100 - y / 0.5 - 0.5];

describe('pointAtPane (§7.5, §13)', () => {
  const shafted = (over: Partial<PointsLayer> = {}): PointsLayer =>
    layer({
      radiusMm: 2,
      points: [
        { position: [0, 0, 0], id: 'a' },
        { position: [20, 0, 0], id: 'b' },
        // 10 mm off this slice, and the layer's radius is 2 — no cross-section at all.
        { position: [-20, 0, 10], id: 'off' },
      ],
      ...over,
    });

  it('grabs the point under the pointer, and reports the disc it drew', () => {
    const hit = pointAtPane(shafted(), place, ...at(20, 0));
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(1);
    expect(hit!.distancePx).toBeCloseTo(0, 9);
    // A 2 mm sphere ON the plane at 0.5 mm/px is a 4 px disc — `sqrt(r² − 0²)/mmPerPx`.
    expect(hit!.discPx).toBeCloseTo(4, 9);
  });

  /** §11's boundary case, from the other side: 0.9 r hits, 1.1 r plus the floor misses. */
  it('hits inside max(disc, 8 px) and misses outside it', () => {
    // One point, so the only thing that can answer is its own disc: a 10 mm sphere on the plane at
    // 0.5 mm/px is a 20 px disc, well clear of the 8 px floor.
    const big = layer({ radiusMm: 10, points: [{ position: [0, 0, 0], id: 'a' }] });
    const [cx, cy] = at(0, 0);
    expect(pointAtPane(big, place, cx + 20 * 0.9, cy)).not.toBeNull();
    expect(pointAtPane(big, place, cx + 20 * 1.1, cy)).toBeNull();
  });

  it('falls back to the 8 px floor when the disc is smaller than a hand can aim at', () => {
    // 0.5 mm radius at 0.5 mm/px is a 1 px disc; without a floor nothing but the exact centre hits.
    const tiny = layer({ radiusMm: 0.5, points: [{ position: [0, 0, 0], id: 'a' }] });
    const [cx, cy] = at(0, 0);
    expect(pointAtPane(tiny, place, cx + 7, cy)).not.toBeNull();
    expect(pointAtPane(tiny, place, cx + 9, cy)).toBeNull();
  });

  it('never hits a ghost: an off-slice point is not selectable even when the layer draws it', () => {
    const [gx, gy] = at(-20, 0);
    expect(pointAtPane(shafted(), place, gx, gy), 'culled, so no hit').toBeNull();
    expect(
      pointAtPane(shafted({ offPlaneOpacity: 0.6 }), place, gx, gy),
      'drawn as a ghost, and still no hit'
    ).toBeNull();
  });

  it('takes the nearest of two overlapping discs, not the first in the array', () => {
    const pair = layer({
      radiusMm: 4,
      points: [
        { position: [0, 0, 0], id: 'first' },
        { position: [2, 0, 0], id: 'second' },
      ],
    });
    // 1.4 mm from the second and 2.6 mm from the first: both discs cover it, and it is the
    // second's.
    expect(pointAtPane(pair, place, ...at(3.4, 0))!.index).toBe(1);
    expect(pointAtPane(pair, place, ...at(-1.4, 0))!.index).toBe(0);
  });

  it("uses the point's own radius when it has one, and the layer's otherwise", () => {
    const mixed = layer({
      radiusMm: 1,
      points: [{ position: [0, 0, 0], id: 'fat', radiusMm: 10 }],
    });
    const [cx, cy] = at(0, 0);
    expect(pointAtPane(mixed, place, cx + 18, cy), '10 mm → a 20 px disc').not.toBeNull();
    expect(pointAtPane(mixed, place, cx + 22, cy)).toBeNull();
  });

  it("shape 'dot' is hit at its constant pixel radius, after the same world-radius cull", () => {
    const dots = layer({
      shape: 'dot',
      radiusMm: 20,
      points: [
        { position: [0, 0, 0], id: 'a' },
        { position: [-20, 0, 10], id: 'deep' },
      ],
    });
    const [cx, cy] = at(0, 0);
    // 4 px of dot is under the 8 px floor, so the floor decides — not the 40 px the sphere branch
    // would have given.
    expect(pointAtPane(dots, place, cx + 7, cy)).not.toBeNull();
    expect(pointAtPane(dots, place, cx + 9, cy)).toBeNull();
    // …and the cull is still by world distance: 10 mm off a 20 mm radius is on the slice.
    expect(pointAtPane(dots, place, ...at(-20, 0))).not.toBeNull();
  });

  it('is null for an empty layer, and honours a caller-supplied floor', () => {
    expect(pointAtPane(layer(), place, 100, 100)).toBeNull();
    const [cx, cy] = at(0, 0);
    const tiny = layer({ radiusMm: 0.5, points: [{ position: [0, 0, 0], id: 'a' }] });
    expect(pointAtPane(tiny, place, cx + 20, cy, 32)).not.toBeNull();
  });

  it('follows the radiological flip, because `worldToPane` does', () => {
    const hit = pointAtPane(shafted(), { ...place, radiological: true }, ...at(-20, 0));
    // Mirrored about the vertical screen axis: the pixel that was `x = −20` is now `x = +20`.
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(1);
  });
});

describe('pointAtPane3D (§13)', () => {
  /** An orthographic-looking view-projection: world mm → NDC at 1/50, no perspective divide. */
  const viewProj: mat4 = [
    1 / 50,
    0,
    0,
    0,
    0,
    1 / 50,
    0,
    0,
    0,
    0,
    1 / 50,
    0,
    0,
    0,
    0,
    1,
  ] as unknown as mat4;
  const rect = { width: 200, height: 200 };
  const three = layer({
    points: [
      { position: [0, 0, 0], id: 'a' },
      { position: [25, 0, 0], id: 'b' },
    ],
  });

  it('grabs the nearest projected centre within 14 px', () => {
    // `x = 25 mm` → NDC 0.5 → pixel `(0.5·0.5 + 0.5)·200 − 0.5 = 149.5`; `y` is flipped to 99.5.
    expect(pointAtPane3D(three, viewProj, rect, 149.5, 99.5)!.index).toBe(1);
    expect(pointAtPane3D(three, viewProj, rect, 149.5 + 13, 99.5)!.index).toBe(1);
    expect(pointAtPane3D(three, viewProj, rect, 149.5 + 15, 99.5)).toBeNull();
  });

  it('has no slice to be off, so nothing is culled by a plane distance', () => {
    const deep = layer({ points: [{ position: [0, 0, 40], id: 'deep' }] });
    expect(pointAtPane3D(deep, viewProj, rect, 99.5, 99.5)).not.toBeNull();
  });
});

describe('pointIdAt (§4.4)', () => {
  it("is the point's own id, or the `p<index>` the engine would mint", () => {
    const l = layer({ points: [{ position: [0, 0, 0], id: 'c1' }, { position: [1, 0, 0] }] });
    expect(pointIdAt(l, 0)).toBe('c1');
    expect(pointIdAt(l, 1)).toBe('p1');
    expect(pointIdAt(l, 9)).toBe('p9');
  });
});
