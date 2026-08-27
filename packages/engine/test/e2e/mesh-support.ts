/**
 * Shared arithmetic for the E-MESH §11 specs. **Not a spec** — Playwright collects `*.spec.ts` only.
 *
 * Everything here is geometry and algebra a test can check by hand, so no expectation in a
 * `mesh-*.spec.ts` is ever a recorded value.
 *
 * ## The fixture, and the camera every spec looks at it with
 *
 * `testdata/mesh_v2_binary.msh` is the committed 3×3×3 lattice (`scripts/gen-fixtures.py`): 27 nodes
 * at every combination of x, y, z ∈ {−10, 0, +10}, 48 tets tagged 1 / 2 by the sign of z, and 56
 * triangles tagged 1001 (24) / 1002 (32). Its fields are deterministic functions of the geometry:
 *
 * * `node_scalar = 0.1·x + 0.01·y + 0.001·z` — **affine in world position**, so its barycentric
 *   interpolation over any triangle is that same function of the *fragment's* world point. That is
 *   what makes a node-field pixel predictable without knowing which triangle covers it.
 * * `elm_scalar = 0.5·row − 3` over the 0-based element rows, tri block first (rows 0…55).
 * * `node_vector`, `E` — unused here.
 *
 * {@link FRONT_FACE_CAMERA} puts the eye on −X looking at +X with screen-up +Z, so the pane is filled
 * by the cube's `x = −10` face, and {@link facePixelToWorld} inverts the projection exactly.
 */

/** The scene page's canvas, and therefore the pane in a `3d-only` layout. */
export const PANE = 768;

/** Distance from the eye to the cube's `x = −10` face. */
const FACE_DISTANCE = 31 - 10;
/** `tan(fovY / 2)`, from the field of view below. */
const TAN_HALF_FOV = 15 / 31;

/** Half the world extent the pane covers **at the front face**, in mm: 21 · 15/31. */
export const FACE_HALF_MM = FACE_DISTANCE * TAN_HALF_FOV;

/**
 * Eye on −X looking towards +X, screen-up = +Z.
 *
 * The quaternion is the one whose rotation matrix has third column (−1, 0, 0) — the "back" axis §7.5
 * puts the eye along — and second column (0, 0, 1) — screen-up: R = [[0,0,−1],[−1,0,0],[0,1,0]],
 * q = (0.5, −0.5, −0.5, 0.5). Screen-right is therefore world −Y.
 */
export const FRONT_FACE_CAMERA = {
  target: [0, 0, 0] as [number, number, number],
  distance: 31,
  rotation: [0.5, -0.5, -0.5, 0.5] as [number, number, number, number],
  fovYDeg: (2 * Math.atan(TAN_HALF_FOV) * 180) / Math.PI,
  orthographic: false,
  near: 1,
  far: 200,
};

/** The same camera from +X, so the cube's `x = +10` face fills the pane instead. */
export const BACK_FACE_CAMERA = {
  ...FRONT_FACE_CAMERA,
  // Third column (+1, 0, 0), second column (0, 0, 1): R = [[0,0,1],[1,0,0],[0,1,0]], q = (.5,.5,.5,.5).
  rotation: [0.5, 0.5, 0.5, 0.5] as [number, number, number, number],
};

/**
 * The world point a pane pixel sees on the cube's `x = ∓10` face, top-left origin.
 *
 * Screen-right is world −Y and screen-down is world −Z under {@link FRONT_FACE_CAMERA}; under
 * {@link BACK_FACE_CAMERA} screen-right is world +Y. Both share the vertical mapping.
 */
export function facePixelToWorld(
  px: number,
  py: number,
  face: 'front' | 'back' = 'front'
): [number, number, number] {
  const half = FACE_HALF_MM;
  const z = ((PANE / 2 - py) / (PANE / 2)) * half;
  const y = ((px - PANE / 2) / (PANE / 2)) * half * (face === 'front' ? -1 : 1);
  return [face === 'front' ? -10 : 10, y, z];
}

/** The fixture's `node_scalar`, verbatim from `scripts/gen-fixtures.py`. */
export function nodeScalarAt(world: readonly [number, number, number]): number {
  return world[0] * 0.1 + world[1] * 0.01 + world[2] * 0.001;
}

/**
 * §7.4's headlight, solved out of a measured pixel.
 *
 * The shader computes `P = C·s + t` at a fragment, where `s = ambient + (1 − ambient)·diff` and
 * `t = spec` depend only on `dot(n, v)` — **the same scalar for all three channels of one pixel**.
 * Three equations in two unknowns, so fitting a candidate base colour `C` and reading the residual
 * is a real assertion: it says the pixel is that colour, scaled and offset by a scalar, and nothing
 * else. No ambient or specular constant from the shader appears in any expectation.
 */
export function fitShading(
  c: readonly number[],
  p: readonly number[]
): { s: number; t: number; residual: number } {
  const cm = ((c[0] ?? 0) + (c[1] ?? 0) + (c[2] ?? 0)) / 3;
  const pm = ((p[0] ?? 0) + (p[1] ?? 0) + (p[2] ?? 0)) / 3;
  let num = 0;
  let den = 0;
  for (let k = 0; k < 3; k += 1) {
    num += ((c[k] ?? 0) - cm) * ((p[k] ?? 0) - pm);
    den += ((c[k] ?? 0) - cm) ** 2;
  }
  const s = den > 0 ? num / den : 0;
  const t = pm - s * cm;
  let residual = 0;
  for (let k = 0; k < 3; k += 1) {
    residual = Math.max(residual, Math.abs((p[k] ?? 0) - ((c[k] ?? 0) * s + t)));
  }
  return { s, t, residual };
}

/** A plausible headlight fit: a diffuse term in (0, 1] and an additive specular that adds. */
export function isPlausibleShading(f: { s: number; t: number }): boolean {
  return f.s > 0.05 && f.s <= 1.02 && f.t > -1.5 && f.t < 70;
}

/** The window a modelled channel may miss its measured byte by: 8-bit rounding, plus one f32 ulp. */
const CHANNEL_TOLERANCE = 1;

export interface ShadingSolution {
  /** Some `(s, t)` in range reproduces **every** channel of `p` from `c` to within the tolerance. */
  feasible: boolean;
  /** The scale at the widest feasible point (meaningless when `feasible` is false). */
  s: number;
  t: number;
  /** `max_s (upper(s) − lower(s))`, in bytes. Non-negative exactly when feasible. */
  slack: number;
}

/**
 * The same claim as {@link fitShading}, decided **exactly** instead of by least squares.
 *
 * `fitShading` regresses `s` and `t` and then looks at the residual, which is the right diagnostic
 * and the wrong decision procedure: the slope of a two-point regression through quantised bytes is
 * only as well determined as the colour's channel spread. Tet tag 1 of the fixture LUT is
 * (230, 230, 210) — a 20-byte spread — so a pixel that is *exactly* `0.778 · c` rounds to
 * (179, 179, 163), whose best-fit line is `s = 0.80, t = −5`. The residual is 0.00 and the intercept
 * is nonsense. §11 asks for the LUT colour to be asserted on the 0..255 wire value, and near-grey
 * tissue colours are exactly what a real LUT is full of, so the test cannot be limited to saturated
 * colours.
 *
 * The exact question is a feasibility one: **does there exist** a diffuse scale `s` and an additive
 * specular `t`, in the ranges a headlight can produce, with `|c_k·s + t − p_k| ≤ 1` for all three
 * channels? Each channel is a band in `(s, t)`; `lower(s)` is a max of affine functions and
 * `upper(s)` a min of them, so `upper − lower` is concave and a ternary search finds its maximum.
 * Non-negative there means feasible, and nothing weaker than "this colour, lit" satisfies it — the
 * wrong tag's colour fails on the first two channels alone.
 */
export function solveShading(
  c: readonly number[],
  p: readonly number[],
  opts: { tol?: number; sMin?: number; sMax?: number; tMin?: number; tMax?: number } = {}
): ShadingSolution {
  const h = opts.tol ?? CHANNEL_TOLERANCE;
  const sMin = opts.sMin ?? 0.05;
  const sMax = opts.sMax ?? 1.02;
  const tMin = opts.tMin ?? 0;
  const tMax = opts.tMax ?? 70;
  const bounds = (s: number): { lo: number; hi: number } => {
    let lo = tMin;
    let hi = tMax;
    for (let k = 0; k < 3; k += 1) {
      const base = (c[k] ?? 0) * s;
      lo = Math.max(lo, (p[k] ?? 0) - h - base);
      hi = Math.min(hi, (p[k] ?? 0) + h - base);
    }
    return { lo, hi };
  };
  const width = (s: number): number => {
    const b = bounds(s);
    return b.hi - b.lo;
  };
  let a = sMin;
  let b = sMax;
  for (let i = 0; i < 200; i += 1) {
    const m1 = a + (b - a) / 3;
    const m2 = b - (b - a) / 3;
    if (width(m1) < width(m2)) a = m1;
    else b = m2;
  }
  const s = (a + b) / 2;
  const win = bounds(s);
  return { feasible: win.hi >= win.lo, s, t: (win.lo + win.hi) / 2, slack: win.hi - win.lo };
}

/** The default `Scene.background`, as the bytes `readPixels` reports. */
export const BACKGROUND: readonly [number, number, number, number] = [
  Math.round(0.04 * 255),
  Math.round(0.05 * 255),
  Math.round(0.07 * 255),
  255,
];

export function isBackground(px: readonly number[], tol = 2): boolean {
  return px.every((v, i) => Math.abs(v - (BACKGROUND[i] ?? 0)) <= tol);
}

// ---------------------------------------------------------------------------------------------
// §7.4's clip planes and caps
// ---------------------------------------------------------------------------------------------

/**
 * The exact inverse of {@link facePixelToWorld}, for **any** world point rather than only the front
 * face: where a world point lands on the pane under {@link FRONT_FACE_CAMERA}, top-left origin.
 *
 * The camera is a perspective one at `(−31, 0, 0)` looking along `+X`, screen-up `+Z`, screen-right
 * `−Y`, so the depth of a point is `x + 31` and the two screen offsets are its `y` and `z` divided
 * by `tan(fovY/2) · depth`. That is the whole projection — a cap test needs it because a cap lies on
 * a plane the camera does not face head-on, and there is no "face" to invert.
 */
export function worldToFacePixel(p: readonly [number, number, number]): [number, number] {
  const depth = p[0] + 31;
  const u = -p[1] / (TAN_HALF_FOV * depth);
  const w = p[2] / (TAN_HALF_FOV * depth);
  return [PANE / 2 + u * (PANE / 2), PANE / 2 - w * (PANE / 2)];
}

/**
 * The **cap plane** used by every clip spec: `(x + y)/√2 + 1 = 0`, i.e. keep `x + y ≥ −√2`.
 *
 * Three properties, all deliberate:
 *
 * * **No lattice node lies on it.** The fixture's nodes have `x + y ∈ {−20, −10, 0, 10, 20}`, and a
 *   plane through a node produces degenerate zero-length interpolations — a cut that is *correct*
 *   but whose triangles have no area to assert a pixel on.
 * * **The cap is not head-on.** `n · v ≈ 0.705` at the pane centre rather than 1, so the headlight's
 *   `ambient + (1 − ambient)·diff` term is ≈ 0.78 and a bright tag colour (230, 230, 210) lands at
 *   (179, 179, 164) instead of saturating to white. A saturated pixel carries no colour to assert.
 * * **Its tag boundary is the pane's horizontal centre line.** Tet tags split on `z = 0` (the
 *   fixture tags by centroid `z`), and every point of the plane with `z = 0` projects to screen
 *   `z`-offset 0 whatever its depth. So "above the middle is tag 2, below is tag 1" is exact.
 */
export const CAP_PLANE = {
  normal: [Math.SQRT1_2, Math.SQRT1_2, 0] as [number, number, number],
  offset: 1,
};

/** Where the {@link CAP_PLANE} cap sits along the pane's centre column, in world mm. */
export function capPointAtPaneY(py: number): [number, number, number] {
  // The centre column is the ray `y = 0`, so the plane reduces to `x = −√2` there.
  const x = -Math.SQRT2;
  const depth = x + 31;
  const z = ((PANE / 2 - py) / (PANE / 2)) * TAN_HALF_FOV * depth;
  return [x, 0, z];
}

/** Squared distance from a pane point to a pane segment — the cap-diagonal test's clearance. */
export function pointSegmentDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number]
): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}
