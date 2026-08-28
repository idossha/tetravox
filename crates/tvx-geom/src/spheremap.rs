//! `nearest_vertex` and `sphere_map` (§6.3) — the two surface lookups behind the coordinate bar's
//! surface spaces (directed task 8e).
//!
//! Two different problems, deliberately solved two different ways.
//!
//! # `nearest_vertex` — brute force, on purpose
//!
//! "Which vertex did I click?" is **one** query per pick, against a mesh that already costs
//! hundreds of megabytes. A spatial index over `Mesh::nodes` would be 3.4 MB on `ernie.msh`
//! (847,165 nodes) and 9.2 MB on `ernie-seeg.msh` (2,323,873) that nothing else reads, built at
//! load time for a feature the user may never touch — against a linear scan that is 245,762
//! `(dx² + dy² + dz²)` evaluations for `lh.central.gii`, i.e. sub-millisecond, and well inside §8's
//! ≤ 50 ms mesh-hover budget. Measured native release `[M2Max]`: **0.31 ms** on `lh.central.gii`'s
//! 245,762 nodes. The index is the wrong trade until something wants it every frame.
//!
//! Ties break to the **lowest index**, which is what makes the result deterministic (§6.3) across
//! native and wasm: the comparison is a strict `<`, so an exactly-equidistant second candidate
//! never displaces the first.
//!
//! # `sphere_map` — a uniform grid with an exact expanding-ring stop
//!
//! This one is 245,762 queries against 163,842 targets. Brute force is 4.0e10 distance
//! evaluations; extrapolated from the 50-vertex brute force `tests/real_data.rs` runs as its check,
//! that is **~50 s** native release and far worse in wasm `[M2Max]` — which is why §6.3's other
//! structures exist and why this one does too.
//!
//! **Both surfaces are spheres, but not the same sphere, and normalising is a correctness
//! requirement rather than a tidiness one.** `m2m_ernie/surfaces/lh.sphere.reg.gii` has radius
//! 1.0000000 ± 8.2e-8; FreeSurfer's `fsaverage/surf/lh.sphere` has radius 99.9923 … 100.0080
//! `[DATA]`. On *exactly* concentric spheres a raw Euclidean nearest-neighbour would be harmless —
//! `|a − b|² = r² + R² − 2rR·cos θ` is monotone in the angle θ, so the Euclidean argmin would be the
//! angular argmin. The fsaverage sphere is not exactly a sphere. Differentiating that expression in
//! `R` gives `2R − 2r·cos θ ≈ 200`, so the 0.0157 spread in `R` moves `|a − b|²` by ~3.1, while the
//! angular term `2rR(1 − cos θ)` at the ~0.003 chord that separates true neighbours is ~9e-4. The
//! radius noise is **three orders of magnitude larger than the signal**, and the raw argmin is
//! consequently a different vertex almost every time: measured on this pair, raw vs normalised
//! disagree on all seven sampled vertices — subject vertex 0 maps to fsaverage 40,188 (chord
//! 0.00183) normalised and to 161,546 raw, which is nowhere near it `[DATA]`.
//!
//! So both sides are **normalised to the unit sphere first** and the lookup is a nearest-neighbour
//! there: radius-independent, and the reported distance is a chord on the unit sphere (≈ the angle
//! in radians), which is a quantity a reader can check. `tests/real_data.rs` pins the normalised
//! answers against an independent nibabel + numpy brute force and records the raw answers it
//! rejects.
//!
//! The structure is a uniform grid over the unit cube `[-1, 1]³`, bucketing the *target* directions.
//! A query scans rings of cells outward from its own cell and stops when the best distance found so
//! far is no larger than the distance from the query point to the boundary of the scanned box — an
//! **exact** stop, not a heuristic radius, so the result is bit-identical to brute force. On a
//! sphere the occupied cells are a shell, so at `G = 64` (cell 0.03125, against fsaverage ico7's
//! ~0.0155 mean unit-sphere edge) a typical query finishes at ring 1 having looked at a few hundred
//! candidates instead of 163,842.
//!
//! Measured `[M2Max]`, native release, single-threaded: `lh.sphere.reg.gii` (245,762) →
//! `fsaverage/lh.sphere` (163,842) in **42 ms**, grid build included — against the ~50 s brute
//! force, i.e. ~1,200x, and against the 5 s the caller budgets. No threads (AGENTS rule 8), no
//! allocation inside the query loop, no `HashMap` anywhere (§6.3's determinism rule).

/// Grid resolution per axis over `[-1, 1]³`. See the module header for why 64.
const GRID: usize = 64;

/// The vertex of `mesh_nodes` nearest `p`, as `(index, coordinate)`, or `None` for an empty mesh.
///
/// Ties break to the lowest index (strict `<`), which is what makes this deterministic.
pub fn nearest_vertex(nodes: &[[f32; 3]], p: [f32; 3]) -> Option<(u32, [f32; 3])> {
    let mut best = f32::INFINITY;
    let mut best_i = usize::MAX;
    for (i, n) in nodes.iter().enumerate() {
        let dx = n[0] - p[0];
        let dy = n[1] - p[1];
        let dz = n[2] - p[2];
        let d = dx * dx + dy * dy + dz * dz;
        if d < best {
            best = d;
            best_i = i;
        }
    }
    (best_i != usize::MAX).then(|| (best_i as u32, nodes[best_i]))
}

/// Normalise to the unit sphere. A zero-length vector (a degenerate sphere file) stays at the
/// origin rather than becoming `NaN`; it then matches whatever target is nearest the centre, which
/// is meaningless but finite — and `NaN` would poison every comparison in the query loop.
fn unit(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l > 0.0 {
        [v[0] / l, v[1] / l, v[2] / l]
    } else {
        [0.0, 0.0, 0.0]
    }
}

/// A uniform bucket grid over `[-1, 1]³` holding unit-length target directions.
struct DirGrid {
    /// `GRID³ + 1` prefix sums, CSR style — the same `starts`/`items` shape as [`crate::PointLocator`].
    starts: Vec<u32>,
    items: Vec<u32>,
    dirs: Vec<[f32; 3]>,
}

const CELL: f32 = 2.0 / GRID as f32;

fn cell_of(x: f32) -> usize {
    let q = ((x + 1.0) / CELL).floor();
    if q <= 0.0 {
        0
    } else if q >= (GRID - 1) as f32 {
        GRID - 1
    } else {
        q as usize
    }
}

impl DirGrid {
    fn build(target: &[[f32; 3]]) -> Self {
        let dirs: Vec<[f32; 3]> = target.iter().copied().map(unit).collect();
        let ncells = GRID * GRID * GRID;
        let index_of = |d: [f32; 3]| -> usize {
            (cell_of(d[2]) * GRID + cell_of(d[1])) * GRID + cell_of(d[0])
        };
        let mut starts = vec![0u32; ncells + 1];
        for d in &dirs {
            starts[index_of(*d) + 1] += 1;
        }
        for i in 0..ncells {
            starts[i + 1] += starts[i];
        }
        let mut items = vec![0u32; dirs.len()];
        let mut cur = starts.clone();
        for (i, d) in dirs.iter().enumerate() {
            let c = index_of(*d);
            items[cur[c] as usize] = i as u32;
            cur[c] += 1;
        }
        Self {
            starts,
            items,
            dirs,
        }
    }

    /// Nearest target direction to `q` (already unit length), by expanding rings with an exact stop.
    fn nearest(&self, q: [f32; 3]) -> u32 {
        let cx = cell_of(q[0]) as i64;
        let cy = cell_of(q[1]) as i64;
        let cz = cell_of(q[2]) as i64;

        let mut best = f32::INFINITY;
        let mut best_i = 0u32;
        let mut r: i64 = 0;
        loop {
            // Ring `r`: every cell whose Chebyshev distance from the centre cell is exactly `r`.
            // Ring 0 is the centre cell itself.
            for z in (cz - r)..=(cz + r) {
                if z < 0 || z >= GRID as i64 {
                    continue;
                }
                for y in (cy - r)..=(cy + r) {
                    if y < 0 || y >= GRID as i64 {
                        continue;
                    }
                    for x in (cx - r)..=(cx + r) {
                        if x < 0 || x >= GRID as i64 {
                            continue;
                        }
                        let on_ring = (x - cx).abs() == r
                            || (y - cy).abs() == r
                            || (z - cz).abs() == r;
                        if !on_ring {
                            continue;
                        }
                        let ci = (z as usize * GRID + y as usize) * GRID + x as usize;
                        let (a, b) = (self.starts[ci] as usize, self.starts[ci + 1] as usize);
                        for &j in &self.items[a..b] {
                            let d = self.dirs[j as usize];
                            let dx = d[0] - q[0];
                            let dy = d[1] - q[1];
                            let dz = d[2] - q[2];
                            let dd = dx * dx + dy * dy + dz * dz;
                            if dd < best {
                                best = dd;
                                best_i = j;
                            }
                        }
                    }
                }
            }

            // The exact stop. The cells scanned so far cover the axis-aligned box
            // `[-1 + (c - r)·CELL, -1 + (c + r + 1)·CELL]` per axis; anything not yet scanned is
            // outside it, hence at least `margin` away, where `margin` is the distance from `q` to
            // the nearest face of that box. When `best <= margin²` no unscanned point can win, and
            // the answer is bit-identical to brute force.
            //
            // An axis whose scanned range has already run off the end of the grid imposes **no**
            // constraint — there are no target points out there to be missed — so it contributes
            // `INFINITY`, not a clamped and therefore tiny margin. Clamping instead was a real bug,
            // not a subtlety: `cell_of` pins `|x| > 0.96875` into the edge cell, ~9 % of unit-sphere
            // queries have such a coordinate, and for those the margin never grew, so the loop ran
            // every ring to `r = 64`. Measured cost of the clamped version on the ernie→fsaverage
            // pair: **34.1 s**, against 0.29 s here `[M2Max]`.
            let margin = {
                let m = |c: i64, v: f32| -> f32 {
                    let lo_i = c - r;
                    let hi_i = c + r + 1;
                    let a = if lo_i <= 0 {
                        f32::INFINITY
                    } else {
                        v - (-1.0 + lo_i as f32 * CELL)
                    };
                    let b = if hi_i >= GRID as i64 {
                        f32::INFINITY
                    } else {
                        (-1.0 + hi_i as f32 * CELL) - v
                    };
                    a.min(b)
                };
                m(cx, q[0]).min(m(cy, q[1])).min(m(cz, q[2]))
            };
            if best.is_finite() && (margin.is_infinite() || best <= margin * margin) {
                return best_i;
            }
            r += 1;
            // The whole grid is scanned by `r = GRID`; past that there is nothing left to find and
            // `best` is the brute-force answer whether or not the margin test ever passed (it does
            // not for a query whose grid box has swallowed the whole cube).
            if r > GRID as i64 {
                return best_i;
            }
        }
    }
}

/// For every vertex of `source`, the index of the nearest vertex of `target` **on the unit sphere**.
///
/// Both slices are the node arrays of registered spherical surfaces — a subject's `sphere.reg` and
/// an fsaverage `sphere`. Neither radius matters: both sides are normalised first (see the module
/// header). The result has `source.len()` entries; an empty `target` gives an empty result, because
/// there is no vertex to name.
pub fn sphere_map(source: &[[f32; 3]], target: &[[f32; 3]]) -> Vec<u32> {
    if target.is_empty() || source.is_empty() {
        return Vec::new();
    }
    let grid = DirGrid::build(target);
    source.iter().map(|&s| grid.nearest(unit(s))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic pseudo-sphere: `n` points spread by the golden-angle spiral, which needs
    /// `sin`/`cos` — fine in a **test**, where §6.3's determinism rule is about outputs that cross
    /// builds, not about how a fixture is generated.
    fn spiral(n: usize, radius: f32) -> Vec<[f32; 3]> {
        let ga = std::f64::consts::PI * (3.0 - 5.0f64.sqrt());
        (0..n)
            .map(|i| {
                let z = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
                let r = (1.0 - z * z).max(0.0).sqrt();
                let t = ga * i as f64;
                [
                    (r * t.cos()) as f32 * radius,
                    (r * t.sin()) as f32 * radius,
                    z as f32 * radius,
                ]
            })
            .collect()
    }

    fn brute(source: &[[f32; 3]], target: &[[f32; 3]]) -> Vec<u32> {
        source
            .iter()
            .map(|s| {
                let q = unit(*s);
                let mut best = f32::INFINITY;
                let mut bi = 0u32;
                for (j, t) in target.iter().enumerate() {
                    let d = unit(*t);
                    let dd = (d[0] - q[0]).powi(2) + (d[1] - q[1]).powi(2) + (d[2] - q[2]).powi(2);
                    if dd < best {
                        best = dd;
                        bi = j as u32;
                    }
                }
                bi
            })
            .collect()
    }

    /// The grid must agree with brute force on **every** vertex, not on a sample: the expanding-ring
    /// stop is exact, so a single disagreement is a bug in the margin test, not a tolerance.
    #[test]
    fn grid_agrees_with_brute_force_on_every_vertex() {
        let target = spiral(4_001, 100.0);
        let source = spiral(1_777, 1.0);
        assert_eq!(sphere_map(&source, &target), brute(&source, &target));
    }

    /// The radii are deliberately mismatched in the fixture above (1 vs 100) because the real files
    /// are (§6.3 / the module header). Scaling either side must not move a single answer.
    #[test]
    fn the_map_is_independent_of_either_radius() {
        let source = spiral(901, 1.0);
        let a = sphere_map(&source, &spiral(2_003, 100.0));
        let b = sphere_map(&source, &spiral(2_003, 1.0));
        let c = sphere_map(&spiral(901, 57.0), &spiral(2_003, 100.0));
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    /// A source vertex that *is* a target vertex must map to itself — the identity case a
    /// registration reduces to when the two spheres are the same mesh.
    #[test]
    fn identical_spheres_map_to_the_identity() {
        let s = spiral(2_500, 100.0);
        let map = sphere_map(&s, &s);
        assert_eq!(map, (0..2_500u32).collect::<Vec<_>>());
    }

    #[test]
    fn empty_inputs_are_empty_results_not_panics() {
        assert!(sphere_map(&[], &spiral(10, 1.0)).is_empty());
        assert!(sphere_map(&spiral(10, 1.0), &[]).is_empty());
    }

    #[test]
    fn nearest_vertex_finds_the_exact_node_and_breaks_ties_low() {
        let nodes = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]];
        assert_eq!(nearest_vertex(&nodes, [0.9, 0.0, 0.0]).unwrap().0, 1);
        assert_eq!(nearest_vertex(&nodes, [0.0, 5.0, 0.0]).unwrap().0, 0);
        // Equidistant from 1 and 2: the lower index wins, and it must keep winning.
        assert_eq!(nearest_vertex(&nodes, [0.0, 1.0, 0.0]).unwrap().0, 0);
        let two = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]];
        assert_eq!(nearest_vertex(&two, [0.0, 0.0, 0.0]).unwrap().0, 0);
        assert_eq!(
            nearest_vertex(&nodes, [0.9, 0.0, 0.0]).unwrap().1,
            [1.0, 0.0, 0.0]
        );
        assert!(nearest_vertex(&[], [0.0, 0.0, 0.0]).is_none());
    }
}
