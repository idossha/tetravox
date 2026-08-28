/**
 * `test/e2e/mesh-support.ts`'s arithmetic, tested without a browser.
 *
 * The E-MESH specs decide §11's "the cap pixel is **exactly** the tag colour" with
 * {@link solveShading}, so the solver is itself an expectation-producing thing and gets the same
 * treatment as the shader it judges: a claim about it is arithmetic, not a previous run. It lives
 * under `test/unit/` because `test/e2e/**` is Playwright's and vitest does not collect it.
 */

import { describe, expect, it } from 'vitest';

import { solveShading } from '../e2e/mesh-support';

/** §7.4's headlight, in bytes: `clamp(c·s + spec, 0, 255)`, which is what an 8-bit target stores. */
function shade(c: readonly number[], s: number, spec: number): number[] {
  return c.map((v) => Math.min(255, Math.max(0, Math.round(v * s + spec))));
}

describe('solveShading', () => {
  it('accepts a colour that is exactly itself, lit', () => {
    const c = [104, 163, 255];
    const solved = solveShading(c, shade(c, 0.7, 12));
    expect(solved.feasible).toBe(true);
    expect(solved.s).toBeCloseTo(0.7, 1);
  });

  it('accepts a **saturated** channel, which is what an unclamped model rejects', () => {
    // `Compact_bone` from `m2m_ernie/ernie.msh.opt`, at a fragment facing the eye: red is already
    // at the ceiling before the specular term, so `c·s + t` is 273 where the framebuffer says 255.
    const bone = [255, 239, 179];
    const px = shade(bone, 0.98, 23);
    expect(px[0]).toBe(255); // the precondition this test exists for
    expect(solveShading(bone, px).feasible).toBe(true);

    // The same pixel under a model that forgets the clamp: it puts an upper bound of 256 on a
    // channel whose true value is 273, which no `s` in range can satisfy. This is the regression.
    let anyFits = false;
    for (let s = 0.05; s <= 1.02; s += 0.001) {
      let lo = 0;
      let hi = 70;
      for (let k = 0; k < 3; k += 1) {
        lo = Math.max(lo, px[k]! - 1 - bone[k]! * s);
        hi = Math.min(hi, px[k]! + 1 - bone[k]! * s);
      }
      if (hi >= lo) anyFits = true;
    }
    expect(anyFits, 'the unclamped model has no solution for this correctly-rendered pixel').toBe(
      false
    );
  });

  it('accepts a channel at the floor for the same reason', () => {
    const c = [0, 40, 80];
    const px = shade(c, 0.5, 0);
    expect(px[0]).toBe(0);
    expect(solveShading(c, px).feasible).toBe(true);
  });

  it('still rejects a pixel that is not this colour, lit', () => {
    // `Blood` (204, 0, 0) can never produce a pixel with more green than red under a scalar `s` and
    // a channel-independent additive `t`.
    expect(solveShading([204, 0, 0], [60, 180, 60]).feasible).toBe(false);
    // …and a saturated red does not buy the wrong colour a pass: the other two channels still bind.
    expect(solveShading([204, 0, 0], [255, 180, 60]).feasible).toBe(false);
  });

  it('refuses a negative diffuse scale and a subtractive specular', () => {
    // `t` is a specular term: it adds. A "fit" that needs −40 is a fit to a different colour.
    expect(solveShading([200, 200, 200], [160, 160, 160], { tMin: 0 }).feasible).toBe(true);
    expect(solveShading([200, 200, 200], [160, 160, 160], { sMin: 0.9, sMax: 1.02 }).feasible).toBe(
      false
    );
  });
});
