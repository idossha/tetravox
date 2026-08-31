/**
 * Where a 3D text label lands, from first principles (§11 rule 0: numbers before pictures).
 *
 * The projection is the interesting half — a label is drawn at whatever pixel its world anchor
 * projects to, so an off-by-one in the y flip puts every electrode's name one pixel below where it
 * belongs at DPR 1 and two at DPR 2, which looks fine and is wrong. The view-projection here is
 * built by hand so the expected pixel is arithmetic, not a screenshot.
 */

import { describe, expect, it } from 'vitest';
import {
  drawPointLabels,
  labelHeightPx,
  placePointLabels,
  pointLabelAnchors,
} from './point-labels';
import { FLOATS_PER_VERTEX, OverlayBuilder, overlayMetrics } from './builder';
import type { mat4, vec3, vec4 } from '../scene/types';

/**
 * An orthographic view-projection mapping world `[-100, 100]` on x and y to clip `[-1, 1]`, looking
 * down −z. Column-major (§3), and `w = 1` everywhere, so `worldToPane3D` is a pure scale.
 */
function ortho100(): mat4 {
  // prettier-ignore
  return new Float32Array([
    0.01, 0,    0, 0,
    0,    0.01, 0, 0,
    0,    0,   -0.01, 0,
    0,    0,    0, 1,
  ]);
}

const at = (position: vec3, text: string): { position: vec3; text: string } => ({ position, text });

describe('3D text labels', () => {
  it('projects an anchor to the pixel the view-projection puts it at', () => {
    // World (50, 25, 0) → NDC (0.5, 0.25) → x = (0.5*0.5+0.5)*200 - 0.5 = 149.5,
    // top-down y = (0.5 - 0.125)*100 - 0.5 = 37, which flips to 100 - 1 - 37 = 62.
    const placed = placePointLabels([at([50, 25, 0], 'E001')], ortho100(), {
      width: 200,
      height: 100,
      liftPx: 0,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]?.text).toBe('E001');
    // `mat4` is a Float32Array, so the arithmetic is f32-exact to ~6 decimals, not to the bit.
    expect(placed[0]?.x).toBeCloseTo(149.5, 4);
    expect(placed[0]?.y).toBeCloseTo(62, 4);
  });

  it('lifts the text above the anchor by liftPx', () => {
    const placed = placePointLabels([at([0, 0, 0], 'Cz')], ortho100(), {
      width: 200,
      height: 100,
      liftPx: 8,
    });
    expect(placed[0]?.y).toBeCloseTo(49.5 + 8, 6);
  });

  it('drops an anchor outside the pane', () => {
    const labels = [at([0, 0, 0], 'in'), at([500, 0, 0], 'out')];
    const placed = placePointLabels(labels, ortho100(), { width: 200, height: 100, liftPx: 0 });
    expect(placed.map((p) => p.text)).toEqual(['in']);
  });

  it('drops an anchor behind the eye', () => {
    // A projection with a real w: anything at z > 0 lands behind the near plane.
    // prettier-ignore
    const persp = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, -1,
      0, 0, 0, 0,
    ]) as mat4;
    const placed = placePointLabels([at([0, 0, 1], 'behind')], persp, {
      width: 200,
      height: 100,
      liftPx: 0,
    });
    expect(placed).toEqual([]);
  });

  /**
   * A 2D pane shows one slice. A 187-electrode net projected whole onto an axial slice would be a
   * smear of names belonging to slices 80 mm away, so only the anchors within the slab are drawn.
   */
  it('keeps only the anchors within the slab of a 2D pane', () => {
    const labels = [at([0, 0, 0], 'on'), at([0, 0, 3], 'near'), at([0, 0, 40], 'far')];
    const placed = placePointLabels(labels, ortho100(), {
      width: 200,
      height: 100,
      liftPx: 0,
      slab: { normal: [0, 0, 1], offset: 0, slabMm: 4 },
    });
    expect(placed.map((p) => p.text)).toEqual(['on', 'near']);
  });

  it('honours a plane that is not through the origin', () => {
    // Plane z = 10 is `normal (0,0,1), offset -10`: the signed distance of (0,0,12) is 2.
    const labels = [at([0, 0, 12], 'in'), at([0, 0, 0], 'out')];
    const placed = placePointLabels(labels, ortho100(), {
      width: 200,
      height: 100,
      liftPx: 0,
      slab: { normal: [0, 0, 1], offset: -10, slabMm: 4 },
    });
    expect(placed.map((p) => p.text)).toEqual(['in']);
  });

  /**
   * The halo is what makes a name legible over bright scalp, and §11 will not accept "it looked
   * fine": every glyph is drawn five times — four dark offsets plus the coloured one.
   */
  it('draws each glyph five times, so every label carries its halo', () => {
    const b = new OverlayBuilder();
    b.begin(200, 100);
    const m = overlayMetrics(200, 100, 1);
    drawPointLabels(b, m, [{ text: 'AB', x: 100, y: 50 }], 1, [1, 1, 1, 1]);
    // 2 glyphs x 6 vertices x (4 halo + 1 body).
    expect(b.vertexCount).toBe(2 * 6 * 5);
  });

  it('scales the font by labelScale, never below one texel per pixel', () => {
    const m = overlayMetrics(200, 100, 1);
    expect(labelHeightPx(m, 2)).toBe(labelHeightPx(m, 1) * 2);
    expect(labelHeightPx(m, 0.01)).toBe(labelHeightPx(m, 1));
  });
});

/**
 * §4.4's `labelSource` (2026-08-30) — *which* array the text comes from, before anything is placed.
 *
 * The two sources are not interchangeable and the tests below say so with different strings in each,
 * because the failure this guards against is silent: a resolver that fell through to `labels` for a
 * `'names'` layer draws the right number of labels in the right places on a Gmsh net and nothing at
 * all on a layer that has no `labels` array — which looks like "labels are off", not like a bug.
 */
describe('labelSource', () => {
  const layer = {
    points: [
      { position: [1, 2, 3] as vec3, name: 'A01' },
      { position: [4, 5, 6] as vec3, name: 'A02' },
      { position: [7, 8, 9] as vec3 },
    ],
    labels: [{ position: [0, 0, 0] as vec3, text: 'GMSH' }],
  };

  it('defaults to the labels array — absent is the behaviour that predates the field', () => {
    expect(pointLabelAnchors(layer)).toEqual(layer.labels);
    expect(pointLabelAnchors({ ...layer, labelSource: 'labels' })).toEqual(layer.labels);
  });

  it("'names' draws points[].name at each point's own position", () => {
    expect(pointLabelAnchors({ ...layer, labelSource: 'names' })).toEqual([
      { position: [1, 2, 3], text: 'A01' },
      { position: [4, 5, 6], text: 'A02' },
    ]);
  });

  it('drops a point with no name rather than drawing a halo around nothing', () => {
    const anchors = pointLabelAnchors({
      points: [{ position: [0, 0, 0], name: '' }, { position: [1, 1, 1] }],
      labelSource: 'names',
    });
    expect(anchors).toEqual([]);
  });

  it('is empty, not a crash, for a layer with neither array', () => {
    expect(pointLabelAnchors({})).toEqual([]);
    expect(pointLabelAnchors({ labelSource: 'names' })).toEqual([]);
  });
});

/**
 * §4.4's `labelColorSource` (2026-08-30) — *whose* colour a name is drawn in.
 *
 * One points layer carries a whole implant, so one `labelColor` writes every electrode's names in
 * the same colour while the discs beside them are already told apart by theirs. Absent is that
 * behaviour, which is why the first case asserts the anchors carry no colour at all.
 */
describe('labelColorSource', () => {
  const coloured = {
    points: [
      { position: [1, 2, 3] as vec3, name: 'A01', color: [1, 0, 0, 1] as vec4 },
      { position: [4, 5, 6] as vec3, name: 'B01', color: [0, 0, 1, 1] as vec4 },
      { position: [7, 8, 9] as vec3, name: 'C01' },
    ],
    labelSource: 'names' as const,
  };

  it('absent leaves every anchor colourless, so the pass uses the layer’s one colour', () => {
    for (const anchor of pointLabelAnchors(coloured)) {
      expect(anchor.color).toBeUndefined();
    }
    expect(pointLabelAnchors({ ...coloured, labelColorSource: 'layer' })[0]?.color).toBeUndefined();
  });

  it("'points' gives each name its own point's colour, and falls back for one with none", () => {
    const anchors = pointLabelAnchors({ ...coloured, labelColorSource: 'points' });
    expect(anchors.map((a) => a.color)).toEqual([[1, 0, 0, 1], [0, 0, 1, 1], undefined]);
  });

  it('cannot apply to the labels array — a Gmsh T3 has no point behind it', () => {
    const anchors = pointLabelAnchors({
      points: [{ position: [1, 2, 3], name: 'A01', color: [1, 0, 0, 1] }],
      labels: [{ position: [0, 0, 0], text: 'GMSH' }],
      labelColorSource: 'points',
    });
    expect(anchors).toEqual([{ position: [0, 0, 0], text: 'GMSH' }]);
  });

  it('is carried through placePointLabels to the placed label', () => {
    const placed = placePointLabels(
      [{ position: [0, 0, 0], text: 'A01', color: [0.2, 0.4, 0.6, 1] }],
      ortho100(),
      { width: 200, height: 100, liftPx: 0 }
    );
    expect(placed[0]?.color).toEqual([0.2, 0.4, 0.6, 1]);
  });

  it('drawPointLabels uses the label’s colour over the layer’s, and fades both alike', () => {
    const b = new OverlayBuilder();
    b.begin(200, 100);
    const m = overlayMetrics(200, 100, 1);
    // Two labels: one with its own colour, one without. The builder's vertex colours are what the
    // pass would upload, so the assertion is on the ink itself rather than on a screenshot.
    drawPointLabels(
      b,
      m,
      [
        { text: 'A', x: 40, y: 50, color: [1, 0, 0, 1] },
        { text: 'B', x: 120, y: 50 },
      ],
      1,
      [0, 1, 0, 1],
      0.5
    );
    const inks = new Set(bodyInks(b));
    // `labelWithHalo` draws four dark halo copies and one body copy per glyph, so the two body
    // colours are the two RGBAs below and the halo's is the fifth entry.
    expect(inks.has('1,0,0,0.5')).toBe(true);
    expect(inks.has('0,1,0,0.5')).toBe(true);
  });

  it('an opacity of 1 leaves the caller’s colour byte-identical — the default is a no-op', () => {
    const b = new OverlayBuilder();
    b.begin(200, 100);
    const m = overlayMetrics(200, 100, 1);
    drawPointLabels(b, m, [{ text: 'A', x: 40, y: 50 }], 1, [0.25, 0.5, 0.75, 0.5]);
    expect(new Set(bodyInks(b)).has('0.25,0.5,0.75,0.5')).toBe(true);
  });
});

/** Every distinct RGBA the builder was handed, as `r,g,b,a` strings. */
function bodyInks(b: OverlayBuilder): string[] {
  const data = b.build();
  const out: string[] = [];
  for (let i = 0; i < b.vertexCount; i += 1) {
    const o = i * FLOATS_PER_VERTEX;
    out.push(
      [data[o + 4], data[o + 5], data[o + 6], data[o + 7]]
        .map((v) => Number((v ?? 0).toFixed(4)))
        .join(',')
    );
  }
  return out;
}
