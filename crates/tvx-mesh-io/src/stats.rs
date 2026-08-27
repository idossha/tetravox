//! Exact [`FieldStats`] over a field's values (§6.0, §6.1's "no sampling" rule).
//!
//! One O(n) pass finds `[min, max]`; a second fills a 65536-bin histogram over that range, from
//! which the percentiles come and from which the 256-bin display histogram is a straight 256:1
//! fold. Non-finite samples are excluded from every statistic — `partial` fields are NaN-filled by
//! construction (§6.2), and a NaN gap is an absence, not a value.

use tvx_core::{FieldStats, PERCENTILES};

const FINE: usize = 65536;

/// Statistics of `data` interpreted as `n × ncomp` row-major. `ncomp > 1` ⇒ of the **magnitude**
/// (§6.0's `FieldStats` doc).
pub fn field_stats(data: &[f32], ncomp: usize) -> FieldStats {
    field_stats_parts(&[data], ncomp)
}

/// The same, over a field stored in several contiguous pieces — `ElmField` splits by element kind
/// (§6.2) but its `stats` are of the whole field, and concatenating a 5.9 M × 3 field just to
/// measure it would cost 70 MB `[MODEL]`.
pub fn field_stats_parts(parts: &[&[f32]], ncomp: usize) -> FieldStats {
    let ncomp = ncomp.max(1);
    let mut acc = Accumulator::new();
    for part in parts {
        for row in part.chunks_exact(ncomp) {
            acc.push(magnitude(row));
        }
    }
    acc.finish(parts, ncomp)
}

#[inline]
pub fn magnitude(v: &[f32]) -> f32 {
    match v {
        [a] => *a,
        _ => {
            let mut s = 0.0f64;
            for c in v {
                s += (*c as f64) * (*c as f64);
            }
            s.sqrt() as f32
        }
    }
}

struct Accumulator {
    min: f32,
    max: f32,
    sum: f64,
    finite: u64,
}

impl Accumulator {
    fn new() -> Self {
        Accumulator {
            min: f32::INFINITY,
            max: f32::NEG_INFINITY,
            sum: 0.0,
            finite: 0,
        }
    }

    #[inline]
    fn push(&mut self, v: f32) {
        if v.is_finite() {
            if v < self.min {
                self.min = v;
            }
            if v > self.max {
                self.max = v;
            }
            self.sum += v as f64;
            self.finite += 1;
        }
    }

    fn finish(self, parts: &[&[f32]], ncomp: usize) -> FieldStats {
        if self.finite == 0 {
            return FieldStats {
                min: 0.0,
                max: 0.0,
                mean: 0.0,
                percentiles: [0.0; 9],
                histogram: [0; 256],
                histogram_lo: 0.0,
                histogram_hi: 0.0,
            };
        }
        let (min, max) = (self.min, self.max);
        let mean = self.sum / self.finite as f64;
        let span = (max as f64) - (min as f64);
        let scale = if span > 0.0 {
            (FINE as f64) / span
        } else {
            0.0
        };

        let mut fine = vec![0u32; FINE];
        for part in parts {
            for row in part.chunks_exact(ncomp) {
                let v = magnitude(row);
                if !v.is_finite() {
                    continue;
                }
                let bin = if scale == 0.0 {
                    0
                } else {
                    (((v as f64) - (min as f64)) * scale) as usize
                };
                fine[bin.min(FINE - 1)] += 1;
            }
        }

        let percentiles = percentiles_from(&fine, self.finite, min, max, span);

        let mut histogram = [0u32; 256];
        for (i, slot) in histogram.iter_mut().enumerate() {
            *slot = fine[i * 256..(i + 1) * 256].iter().copied().sum();
        }

        FieldStats {
            min,
            max,
            mean,
            percentiles,
            histogram,
            histogram_lo: min,
            histogram_hi: max,
        }
    }
}

fn percentiles_from(fine: &[u32], count: u64, min: f32, max: f32, span: f64) -> [f32; 9] {
    let mut out = [min; 9];
    if span <= 0.0 {
        return [min; 9];
    }
    let step = span / FINE as f64;
    let mut targets: [u64; 9] = [0; 9];
    for (i, p) in PERCENTILES.iter().enumerate() {
        // Nearest-rank over the finite samples, 0-based.
        let r = ((*p as f64) / 100.0 * (count.saturating_sub(1)) as f64).round();
        targets[i] = r.max(0.0) as u64;
    }
    let mut cum: u64 = 0;
    let mut next = 0usize;
    for (bin, c) in fine.iter().enumerate() {
        if *c == 0 {
            continue;
        }
        cum += *c as u64;
        while next < 9 && targets[next] < cum {
            let v = (min as f64) + (bin as f64 + 0.5) * step;
            out[next] = (v as f32).clamp(min, max);
            next += 1;
        }
        if next == 9 {
            break;
        }
    }
    for slot in out.iter_mut().skip(next) {
        *slot = max;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_stats_are_exact_at_the_ends() {
        let data: Vec<f32> = (0..1001).map(|i| i as f32).collect();
        let s = field_stats(&data, 1);
        assert_eq!(s.min, 0.0);
        assert_eq!(s.max, 1000.0);
        assert!((s.mean - 500.0).abs() < 1e-9);
        assert_eq!(s.histogram_lo, 0.0);
        assert_eq!(s.histogram_hi, 1000.0);
        assert_eq!(s.histogram.iter().map(|c| *c as u64).sum::<u64>(), 1001);
        // median of 0..=1000 is 500; a 65536-bin histogram over [0,1000] resolves it well under 1.
        assert!(
            (s.percentiles[4] - 500.0).abs() < 0.5,
            "{}",
            s.percentiles[4]
        );
    }

    #[test]
    fn vector_stats_are_of_the_magnitude() {
        let data = [3.0f32, 4.0, 0.0, 0.0, 0.0, 0.0];
        let s = field_stats(&data, 3);
        assert_eq!(s.min, 0.0);
        assert_eq!(s.max, 5.0);
        assert!((s.mean - 2.5).abs() < 1e-6);
    }

    #[test]
    fn nan_gaps_are_excluded_not_propagated() {
        let data = [1.0f32, f32::NAN, 3.0];
        let s = field_stats(&data, 1);
        assert_eq!(s.min, 1.0);
        assert_eq!(s.max, 3.0);
        assert!((s.mean - 2.0).abs() < 1e-6);
        assert_eq!(s.histogram.iter().map(|c| *c as u64).sum::<u64>(), 2);
    }

    #[test]
    fn an_all_nan_field_degrades_to_zeros_rather_than_nan_bounds() {
        let s = field_stats(&[f32::NAN, f32::NAN], 1);
        assert_eq!((s.min, s.max), (0.0, 0.0));
        assert_eq!(s.mean, 0.0);
    }

    #[test]
    fn a_constant_field_has_a_degenerate_range() {
        let s = field_stats(&[7.0f32; 32], 1);
        assert_eq!((s.min, s.max), (7.0, 7.0));
        assert!(s.percentiles.iter().all(|p| *p == 7.0));
        assert_eq!(s.histogram[0], 32);
    }

    #[test]
    fn an_empty_field_is_all_zero() {
        let s = field_stats(&[], 3);
        assert_eq!((s.min, s.max, s.mean), (0.0, 0.0, 0.0));
    }
}
