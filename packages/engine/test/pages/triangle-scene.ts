/**
 * The numbers behind the §11 analytic triangle, in a module with **no side effects** so both the page
 * bundle (`pages/triangle.ts`, in the browser) and the spec (`e2e/triangle.spec.ts`, in node) import the
 * same values. A test that re-types its fixture's constants is asserting a transcription.
 *
 * Chosen so the arithmetic is exact:
 * * 256x256 with no CSS scaling at `deviceScaleFactor: 1` ⇒ canvas pixel `(x, y)` is golden-PNG pixel
 *   `(x, y)`, and a pixel centre maps to clip space as `(x + 0.5) / 128 - 1`.
 * * Both colours are exact 8-bit values (`k / 255`), so the readback is the integer written here with no
 *   rounding argument. Nothing converts sRGB on the default framebuffer.
 */

export const CANVAS_SIZE = 256;

/** Clip-space vertices, counter-clockwise. */
export const TRIANGLE_CLIP: readonly (readonly [number, number])[] = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.0, 0.5],
];

/** Exact 8-bit RGBA the page clears to. */
export const CLEAR_RGBA: readonly [number, number, number, number] = [32, 64, 96, 255];

/** Exact 8-bit RGBA the triangle is filled with. */
export const TRIANGLE_RGBA: readonly [number, number, number, number] = [200, 30, 90, 255];

/** Pixel centre -> clip space, for a `CANVAS_SIZE`-wide viewport. */
export function toClip(pixel: number): number {
  return ((pixel + 0.5) / CANVAS_SIZE) * 2 - 1;
}

/**
 * Is a top-left-origin canvas pixel's centre inside {@link TRIANGLE_CLIP}? Half-plane test, winding
 * agnostic, so the expected colour of any pixel is *derived* rather than remembered.
 */
export function insideTriangle(x: number, y: number): boolean {
  const px = toClip(x);
  const py = toClip(CANVAS_SIZE - 1 - y);
  const [a, b, c] = TRIANGLE_CLIP;
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error('TRIANGLE_CLIP must have three vertices');
  }
  const side = (p: readonly [number, number], q: readonly [number, number]): number =>
    (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]);
  const s0 = side(a, b);
  const s1 = side(b, c);
  const s2 = side(c, a);
  return (s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0);
}
