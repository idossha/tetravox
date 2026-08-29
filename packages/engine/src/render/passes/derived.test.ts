/**
 * `modelNormal` — the slice normal the glyph shader projects the field with, in the dataset's own
 * space (`GlyphSpec.in2D`). Wrong here and a rotated mesh would lose a component that is *not* the
 * out-of-slice one, drawing arrows that point where the field does not.
 */

import { describe, expect, it } from 'vitest';
import { modelNormal } from './derived';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('modelNormal', () => {
  it('is the world normal itself under the identity transform', () => {
    expect(modelNormal(IDENTITY, [0, 0, 1])).toEqual([0, 0, 1]);
    expect(modelNormal(IDENTITY, [0, 1, 0])).toEqual([0, 1, 0]);
  });

  it('undoes a rotation: a mesh turned 90° about Z sees the world X normal as its own −Y', () => {
    // Column-major, columns are the images of the model axes: x → +y, y → −x — so world +x is model −y.
    const rotZ90 = new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
    const n = modelNormal(rotZ90, [1, 0, 0]);
    expect(n[0]).toBeCloseTo(0);
    expect(n[1]).toBeCloseTo(-1);
    expect(n[2]).toBeCloseTo(0);
  });

  it('ignores the translation and comes back unit-length under a uniform scale', () => {
    const scaled = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 5, 5, 1]);
    expect(modelNormal(scaled, [0, 0, 1])).toEqual([0, 0, 1]);
  });
});
