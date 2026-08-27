/**
 * The CPU half of §7.6 — **the bake is the display model.**
 *
 * §7.6 says `kind:'heat'` "costs nothing extra in the shader — it is a different bake", so every
 * branch of §4.2's `Scale` is decided here and nowhere else. That makes these unit tests the
 * primary check on `heat`: the Playwright analytic tests then assert that the shader shows
 * `LUT(value)`, and this file asserts that `LUT` is the right function.
 *
 * Expectations are computed from first principles (§11 rule 0). Every test uses `gray` — two stops,
 * black to white — so the expected channel is `round(255 · t)` with no table to transcribe, and
 * `cool` (cyan → magenta, also two stops) for the `separate` negative branch.
 */

import { describe, expect, it } from 'vitest';
import { bakeScale, lutSample, lutTexelOf, sampleColormap, scalePosition } from './colormaps';
import type { Scale } from '../scene/types';

/** `gray` is `[0,0,0] → [255,255,255]`, so its only content is the ramp position itself. */
function grayAt(t: number): number {
  return Math.round(255 * Math.min(1, Math.max(0, t)));
}

/** `cool` is `[0,255,255] → [255,0,255]`. */
function coolAt(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t));
  return [Math.round(255 * u), Math.round(255 * (1 - u)), 255];
}

const HEAT: Scale = {
  kind: 'heat',
  min: 1,
  mid: 2,
  max: 4,
  truncate: false,
  inverse: false,
  negative: 'hide',
};

describe('sampleColormap', () => {
  it('gray is the identity ramp, which is what the other tests lean on', () => {
    for (const t of [0, 0.25, 1 / 3, 0.5, 0.75, 1]) {
      expect(sampleColormap('gray', t)).toEqual([grayAt(t), grayAt(t), grayAt(t)]);
    }
  });

  it('clamps outside 0..1 rather than extrapolating', () => {
    expect(sampleColormap('gray', -2)).toEqual([0, 0, 0]);
    expect(sampleColormap('gray', 7)).toEqual([255, 255, 255]);
  });
});

describe('scalePosition — §4.2 heat is a two-segment ramp', () => {
  it('linear is (v - lo) / (hi - lo)', () => {
    const s: Scale = { kind: 'linear', lo: -10, hi: 30 };
    expect(scalePosition(s, -10)).toBe(0);
    expect(scalePosition(s, 10)).toBeCloseTo(0.5, 12);
    expect(scalePosition(s, 30)).toBe(1);
  });

  it('min → 0, mid → 0.5, max → 1: full saturation at mid, not at max (§7.6)', () => {
    expect(scalePosition(HEAT, 1)).toBe(0);
    expect(scalePosition(HEAT, 1.5)).toBeCloseTo(0.25, 12);
    expect(scalePosition(HEAT, 2)).toBeCloseTo(0.5, 12);
    expect(scalePosition(HEAT, 3)).toBeCloseTo(0.75, 12);
    expect(scalePosition(HEAT, 4)).toBeCloseTo(1, 12);
  });

  it('is symmetric in |v| — the negative branch is the same ramp, differently coloured', () => {
    for (const v of [1.5, 2, 3, 4]) {
      expect(scalePosition(HEAT, -v)).toBeCloseTo(scalePosition(HEAT, v), 12);
    }
  });

  it('`inverse` reverses the ramp, and nothing else', () => {
    const inv: Scale = { ...HEAT, inverse: true };
    for (const v of [1, 1.5, 2, 3, 4]) {
      expect(scalePosition(inv, v)).toBeCloseTo(1 - scalePosition(HEAT, v), 12);
    }
  });

  it('`truncate` is not a ramp position — above max the ramp is at its end either way', () => {
    expect(scalePosition({ ...HEAT, truncate: true }, 9)).toBe(1);
    expect(scalePosition({ ...HEAT, truncate: false }, 9)).toBe(1);
  });
});

describe('bakeScale — texel centres', () => {
  it('texel i holds the colour of the value at (i + 0.5) / width, which is what NEAREST fetches', () => {
    const baked = bakeScale({ kind: 'linear', lo: 0, hi: 1 }, 'gray');
    expect(baked.width).toBe(256);
    for (const i of [0, 1, 85, 128, 254, 255]) {
      const expected = grayAt((i + 0.5) / 256);
      expect(baked.rgba[i * 4], `texel ${i}`).toBe(expected);
      expect(baked.rgba[i * 4 + 3]).toBe(255);
    }
  });

  it('the round trip a fragment makes — value → texel → colour — is exact for §11’s worked example', () => {
    // §11: a 4×4×4 volume with v = i under `gray` and {linear, lo:0, hi:3} paints rgb(85,85,85).
    const baked = bakeScale({ kind: 'linear', lo: 0, hi: 3 }, 'gray');
    expect(lutTexelOf(baked, 1)).toBe(Math.floor((1 / 3) * 256));
    expect(lutSample(baked, 1)).toEqual([85, 85, 85, 255]);
    expect(lutSample(baked, 0)).toEqual([0, 0, 0, 255]);
    expect(lutSample(baked, 3)).toEqual([255, 255, 255, 255]);
  });

  it('clamps rather than wrapping outside [lo, hi]', () => {
    const baked = bakeScale({ kind: 'linear', lo: 0, hi: 3 }, 'gray');
    expect(lutTexelOf(baked, -100)).toBe(0);
    expect(lutTexelOf(baked, 100)).toBe(255);
  });
});

describe('bakeScale — heat', () => {
  it('spans [-max, max] and is dead below min: that is what makes a heat scale an overlay', () => {
    const baked = bakeScale(HEAT, 'gray');
    expect([baked.lo, baked.hi]).toEqual([-4, 4]);
    expect(lutSample(baked, 0)[3]).toBe(0);
    expect(lutSample(baked, 0.5)[3]).toBe(0);
    // Just inside `min` the ramp is at its foot but the fragment is drawn.
    expect(lutSample(baked, 1.05)[3]).toBe(255);
  });

  it('paints LUT(value) = gray(scalePosition) on the positive branch, to the byte', () => {
    const baked = bakeScale(HEAT, 'gray');
    for (const v of [1.2, 1.5, 2, 2.5, 3, 3.9]) {
      // The texel a fragment of value `v` lands in, and the value that texel was baked for.
      const i = lutTexelOf(baked, v);
      const baked_v = baked.lo + ((i + 0.5) / baked.width) * (baked.hi - baked.lo);
      const expected = grayAt(scalePosition(HEAT, baked_v));
      expect(lutSample(baked, v).slice(0, 3), `v=${v}`).toEqual([expected, expected, expected]);
    }
  });

  it("negative:'hide' drops the negative half; 'mirror' paints it with the positive colormap", () => {
    const hidden = bakeScale(HEAT, 'gray');
    const mirrored = bakeScale({ ...HEAT, negative: 'mirror' }, 'gray');
    for (const v of [-1.5, -2, -3, -4]) {
      expect(lutSample(hidden, v)[3], `hide v=${v}`).toBe(0);
      // Mirrored is the *positive* colormap at the same ramp position — asserted against the ramp,
      // not against `lutSample(mirrored, -v)`: ±v land in two different texels whose centres are not
      // mirror images of each other, so the two samples differ by up to one texel of ramp. That is
      // quantisation, not asymmetry, and asserting equality would be asserting a coincidence.
      const expected = grayAt(scalePosition(HEAT, lutValue(mirrored, v)));
      expect(lutSample(mirrored, v), `mirror v=${v}`).toEqual([expected, expected, expected, 255]);
    }
  });

  it("negative:'separate' bakes 512 texels and a second colormap either side of a dead band", () => {
    const baked = bakeScale({ ...HEAT, negative: 'separate' }, 'gray', 'cool');
    expect(baked.width).toBe(512);
    expect(baked.signed).toBe(true);
    // The dead band: |v| < min is transparent on both sides.
    expect(lutSample(baked, 0.5)[3]).toBe(0);
    expect(lutSample(baked, -0.5)[3]).toBe(0);
    for (const v of [-1.5, -2.5, -3.5]) {
      const i = lutTexelOf(baked, v);
      const bakedV = baked.lo + ((i + 0.5) / baked.width) * (baked.hi - baked.lo);
      const [r, g, b] = coolAt(scalePosition(HEAT, bakedV));
      expect(lutSample(baked, v), `v=${v}`).toEqual([r, g, b, 255]);
    }
    // ...while the positive side still takes the primary colormap.
    const p = lutTexelOf(baked, 3);
    const bakedP = baked.lo + ((p + 0.5) / baked.width) * (baked.hi - baked.lo);
    const grey = grayAt(scalePosition(HEAT, bakedP));
    expect(lutSample(baked, 3)).toEqual([grey, grey, grey, 255]);
  });

  it('`inverse` swaps the ends of the ramp', () => {
    const plain = bakeScale(HEAT, 'gray');
    const inverted = bakeScale({ ...HEAT, inverse: true }, 'gray');
    // The top texel's centre is half a texel below `max`, so the hottest colour a fragment can get
    // is `grayAt(scalePosition(max - half a texel))` — 254, not 255. That half-texel is the whole
    // point of baking at centres, and a test that expected 255 would be asserting the old bug.
    const top = grayAt(scalePosition(HEAT, lutValue(plain, 4)));
    expect(top).toBe(254);
    expect(lutSample(plain, 4)[0]).toBe(top);
    expect(lutSample(inverted, 4)[0]).toBe(grayAt(1 - scalePosition(HEAT, lutValue(plain, 4))));
    expect(lutSample(inverted, 4)[0]).toBeLessThan(8);
  });

  it('`truncate` sets clipMax; without it nothing is clipped (Gmsh SaturateValues)', () => {
    expect(bakeScale(HEAT, 'gray').clipMax).toBe(Number.POSITIVE_INFINITY);
    expect(bakeScale({ ...HEAT, truncate: true }, 'gray').clipMax).toBe(4);
    // A linear scale has no truncate flag at all, so it never clips.
    expect(bakeScale({ kind: 'linear', lo: 0, hi: 1 }, 'gray').clipMax).toBe(
      Number.POSITIVE_INFINITY
    );
  });
});

/** The value the texel a fragment of `v` lands in was baked for. */
function lutValue(baked: ReturnType<typeof bakeScale>, v: number): number {
  const i = lutTexelOf(baked, v);
  return baked.lo + ((i + 0.5) / baked.width) * (baked.hi - baked.lo);
}
