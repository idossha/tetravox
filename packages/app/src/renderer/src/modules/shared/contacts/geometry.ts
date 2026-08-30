/**
 * The line geometry every implanted contact set shares — PCA fit, spacing, projection, re-spacing.
 *
 * **Generic on purpose.** A depth electrode, a DBS lead and a laser fibre are all "n contacts on a
 * line", and every one of them wants the same four answers: which line, how far off it they are, how
 * evenly they are spaced, and where they would sit if they were even. What is *not* here is which
 * end is the tip and how far apart the contacts of a particular electrode model should be — those
 * are the geometry of one kind of hardware and live with the module that knows it
 * (`modules/seeg/shaft.ts`). See `README.md`.
 *
 * **No eigen solver in the tree.** gl-matrix has none, so the fit is a hand-written cyclic Jacobi
 * rotation over the 3×3 covariance — twelve lines, exact for a symmetric matrix, and it converges in
 * a handful of sweeps for a case this small. numpy's `svd(pts - c)[2][0]` is the reference the
 * fixtures are generated from (`scripts/gen-fixtures.py`, the `seeg` block).
 *
 * **The axis sign is pinned, and it has to be.** An eigenvector is only defined up to sign — numpy's
 * SVD picks whichever LAPACK happens to return — so a fixture comparing this axis against that one
 * would be pinning a tie-break rather than a rule. {@link canonicaliseAxis} makes the component of
 * largest magnitude positive, on both sides of the fixture. Everything a caller actually reads
 * (`rmsMm`, the spacing CV, the pitch, the projected points) is sign-invariant anyway; the ordering
 * `orderAlong` returns is not, which is exactly why the convention exists.
 */

import type { vec3 } from '@tetravox/engine';

/** A line through a point cloud: `centroid + t * axis`. */
export interface LineFit {
  /** The mean of the points. */
  centroid: vec3;
  /** Unit direction, sign-canonicalised (see {@link canonicaliseAxis}). */
  axis: vec3;
  /** Each input point's signed distance along `axis` from `centroid`, in input order. */
  t: number[];
  /** Root-mean-square perpendicular distance to the line, in millimetres. */
  rmsMm: number;
}

/** What a shaft looks like as three numbers. `null` where there is nothing to measure. */
export interface LineMetrics {
  rmsMm: number;
  /** `std(gaps) / mean(gaps)` — population std, like numpy's default. `null` for fewer than 3. */
  spacingCv: number | null;
  /** The **median** observed gap, in millimetres — robust to one missing contact. `null` for < 2. */
  pitchMm: number | null;
}

function subtract(a: vec3, b: vec3): vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: vec3, b: vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The mean position, or `null` for an empty set. */
export function centroidOf(points: readonly vec3[]): vec3 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

/**
 * Flip `axis` so its largest-magnitude component is positive.
 *
 * The one convention that lets a JavaScript fit and a numpy fit be compared number for number. On an
 * exact tie between two components the earlier one decides, so the rule is total.
 */
export function canonicaliseAxis(axis: vec3): vec3 {
  let best = 0;
  for (let i = 1; i < 3; i += 1) {
    if (Math.abs(axis[i] as number) > Math.abs(axis[best] as number)) best = i;
  }
  return (axis[best] as number) < 0 ? [-axis[0], -axis[1], -axis[2]] : [...axis];
}

/**
 * The dominant eigenvector of a symmetric 3×3 matrix, by cyclic Jacobi rotations.
 *
 * `m` is row-major and is not modified. Sweeps stop when every off-diagonal is negligible against
 * the diagonal, or after {@link JACOBI_SWEEPS} of them — the second bound exists so a pathological
 * input cannot spin in a UI thread, and 24 is far past convergence for a 3×3 (five is typical).
 */
const JACOBI_SWEEPS = 24;

export function dominantEigenvector(m: readonly number[]): vec3 {
  const a = [...m];
  // The accumulated rotation, column j of which is eigenvector j.
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const at = (i: number, j: number): number => a[i * 3 + j] as number;
  const set = (i: number, j: number, value: number): void => {
    a[i * 3 + j] = value;
  };

  for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep += 1) {
    let off = 0;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      off += Math.abs(at(p, q));
    }
    // Relative as well as absolute: a covariance over millimetre coordinates has entries in the
    // thousands, and an absolute floor alone would spin out the sweep budget on rotations that are
    // already no-ops.
    const scale = Math.abs(at(0, 0)) + Math.abs(at(1, 1)) + Math.abs(at(2, 2));
    if (off <= 1e-18 || off <= 1e-14 * scale) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = at(p, q);
      if (Math.abs(apq) <= 1e-18) continue;
      const theta = (at(q, q) - at(p, p)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const akp = at(k, p);
        const akq = at(k, q);
        set(k, p, c * akp - s * akq);
        set(k, q, s * akp + c * akq);
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = at(p, k);
        const aqk = at(q, k);
        set(p, k, c * apk - s * aqk);
        set(q, k, s * apk + c * aqk);
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k * 3 + p] as number;
        const vkq = v[k * 3 + q] as number;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }

  let best = 0;
  for (let i = 1; i < 3; i += 1) {
    if (at(i, i) > at(best, best)) best = i;
  }
  return canonicaliseAxis([
    v[0 * 3 + best] as number,
    v[1 * 3 + best] as number,
    v[2 * 3 + best] as number,
  ]);
}

/**
 * The PCA line through `points`, or `null` for fewer than two.
 *
 * `rmsMm` is `sqrt(mean(|p − (c + t·axis)|²))` — Slicer's `_fitLine`, which is the number its Edit
 * panel calls "line-RMS" and the one a user compares between two refits.
 */
export function fitLine(points: readonly vec3[]): LineFit | null {
  if (points.length < 2) return null;
  const centroid = centroidOf(points) as vec3;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const d = subtract(p, centroid);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        cov[i * 3 + j] = (cov[i * 3 + j] as number) + (d[i] as number) * (d[j] as number);
      }
    }
  }
  const axis = dominantEigenvector(cov);
  const t: number[] = [];
  let sq = 0;
  for (const p of points) {
    const d = subtract(p, centroid);
    const along = dot(d, axis);
    t.push(along);
    const rx = d[0] - along * axis[0];
    const ry = d[1] - along * axis[1];
    const rz = d[2] - along * axis[2];
    sq += rx * rx + ry * ry + rz * rz;
  }
  return { centroid, axis, t, rmsMm: Math.sqrt(sq / points.length) };
}

/** numpy's `median`: the middle of the sorted values, or the mean of the two middle ones. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Population standard deviation (`ddof = 0`), matching numpy's default. */
export function standardDeviation(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return Math.sqrt(sq / values.length);
}

/** The gaps between consecutive projections, sorted along the axis. */
export function sortedGaps(t: readonly number[]): number[] {
  const sorted = [...t].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push((sorted[i] as number) - (sorted[i - 1] as number));
  }
  return gaps;
}

/** {@link LineFit} reduced to the three numbers a panel shows. `null` for fewer than two points. */
export function lineMetrics(points: readonly vec3[]): LineMetrics | null {
  const fit = fitLine(points);
  if (fit === null) return null;
  const gaps = sortedGaps(fit.t);
  const mean = gaps.length === 0 ? 0 : gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = standardDeviation(gaps);
  return {
    rmsMm: fit.rmsMm,
    // Two contacts have one gap and therefore no dispersion to report; a CV of exactly 0 there would
    // read as "perfectly spaced" when nothing has been measured at all.
    spacingCv: gaps.length >= 2 && sd !== null && mean !== 0 ? sd / mean : null,
    pitchMm: median(gaps),
  };
}

/** The foot of the perpendicular from `p` onto the line. */
export function projectOntoLine(p: vec3, centroid: vec3, axis: vec3): vec3 {
  const along = dot(subtract(p, centroid), axis);
  return [
    centroid[0] + along * axis[0],
    centroid[1] + along * axis[1],
    centroid[2] + along * axis[2],
  ];
}

/** Indices of `points`, ordered by their projection onto the fitted line (low `t` first). */
export function orderAlong(points: readonly vec3[]): number[] {
  const fit = fitLine(points);
  const order = points.map((_p, i) => i);
  if (fit === null) return order;
  return order.sort((a, b) => (fit.t[a] as number) - (fit.t[b] as number));
}

/**
 * `points.length` positions on the fitted line, evenly spaced at the **median** observed gap and
 * starting at the lowest projection — Slicer's `refitShaft` arithmetic.
 *
 * The result is in **ascending `t` order**, not in the input's order: slot `k` is the `k`-th contact
 * from the low end of the shaft. Which end that is anatomically is not this function's question —
 * the caller pairs the slots with contacts once it has decided which end is the tip.
 *
 * Median rather than mean because a shaft that lost one contact to detection has one gap of twice
 * the pitch, and a mean would stretch every other contact to accommodate it.
 */
export function respaceEven(points: readonly vec3[]): vec3[] | null {
  const fit = fitLine(points);
  if (fit === null) return null;
  const sorted = [...fit.t].sort((a, b) => a - b);
  const step = median(sortedGaps(fit.t)) ?? 0;
  const t0 = sorted[0] as number;
  return points.map((_p, i) => {
    const t = t0 + step * i;
    return [
      fit.centroid[0] + t * fit.axis[0],
      fit.centroid[1] + t * fit.axis[1],
      fit.centroid[2] + t * fit.axis[2],
    ] as vec3;
  });
}

/** Euclidean distance in millimetres. */
export function distanceMm(a: vec3, b: vec3): number {
  const d = subtract(a, b);
  return Math.sqrt(dot(d, d));
}
