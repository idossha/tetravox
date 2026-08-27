//! [`FieldStats`] for a **derived** array — the one case the crates cannot pre-compute.
//!
//! `Field`/`ElmField` already carry `stats` "of the magnitude when `ncomp > 1`" (§6.0), so
//! `mesh_field` with `component: 'mag'` and every `elmToNode` result reuse the crate's own numbers
//! verbatim. Only `component: 0 | 1 | 2` produces an array nothing has seen before, and this is
//! its stats pass.
//!
//! The method is §6.1's, so a component's percentiles are computed the same way a volume's are: one
//! O(n) pass for min/max/mean, one into a 65536-bin histogram over `[min, max]`, nearest-rank
//! percentiles out of it, and the 256-bin display histogram summed down from the same bins. No
//! sampling. Non-finite samples (a `partial` field's `NaN` gaps, §6.2) are excluded from every
//! statistic, exactly as they are excluded from the range.

use tvx_core::{FieldStats, PERCENTILES};

const FINE: usize = 65536;

/// Exact statistics of `v`, ignoring non-finite samples.
pub fn of(v: &[f32]) -> FieldStats {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum = 0.0f64;
    let mut n = 0u64;
    for x in v {
        if x.is_finite() {
            if *x < min {
                min = *x;
            }
            if *x > max {
                max = *x;
            }
            sum += f64::from(*x);
            n += 1;
        }
    }
    if n == 0 {
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
    let mean = sum / n as f64;

    if min == max {
        let mut histogram = [0u32; 256];
        histogram[0] = n.min(u64::from(u32::MAX)) as u32;
        return FieldStats {
            min,
            max,
            mean,
            percentiles: [min; 9],
            histogram,
            histogram_lo: min,
            histogram_hi: max,
        };
    }

    let lo = f64::from(min);
    let span = f64::from(max) - lo;
    let mut fine = vec![0u32; FINE];
    for x in v {
        if x.is_finite() {
            let t = (f64::from(*x) - lo) / span * (FINE as f64);
            let b = (t as usize).min(FINE - 1);
            fine[b] = fine[b].saturating_add(1);
        }
    }

    // Nearest-rank: the smallest bin whose cumulative count reaches ceil(p/100 * n). The value
    // reported is the bin's lower edge, within span/65536 of the true order statistic (§6.1).
    let mut percentiles = [0.0f32; 9];
    let mut cum = 0u64;
    let mut bin = 0usize;
    for (i, p) in PERCENTILES.iter().enumerate() {
        let rank = ((f64::from(*p) / 100.0) * n as f64).ceil().max(1.0) as u64;
        while bin < FINE && cum + u64::from(fine[bin]) < rank {
            cum += u64::from(fine[bin]);
            bin += 1;
        }
        let b = bin.min(FINE - 1);
        percentiles[i] = (lo + span * (b as f64) / (FINE as f64)) as f32;
    }
    percentiles[8] = percentiles[8].min(max);

    let mut histogram = [0u32; 256];
    for (i, h) in histogram.iter_mut().enumerate() {
        let mut acc = 0u32;
        for f in &fine[i * 256..(i + 1) * 256] {
            acc = acc.saturating_add(*f);
        }
        *h = acc;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ramp_has_exact_min_max_mean_and_a_full_histogram() {
        let v: Vec<f32> = (0..1000).map(|i| i as f32).collect();
        let s = of(&v);
        assert_eq!(s.min, 0.0);
        assert_eq!(s.max, 999.0);
        assert!((s.mean - 499.5).abs() < 1e-9);
        assert_eq!(s.histogram.iter().map(|x| u64::from(*x)).sum::<u64>(), 1000);
        // 50th percentile of 0..999 is the 500th value = 499 (nearest-rank, inverted CDF).
        assert!((s.percentiles[4] - 499.0).abs() <= 999.0 / 65536.0 + 1e-3);
    }

    #[test]
    fn non_finite_samples_are_excluded_from_every_statistic() {
        let v = [1.0f32, f32::NAN, 3.0, f32::INFINITY];
        let s = of(&v);
        assert_eq!((s.min, s.max), (1.0, 3.0));
        assert_eq!(s.mean, 2.0);
        assert_eq!(s.histogram.iter().map(|x| u64::from(*x)).sum::<u64>(), 2);
    }

    #[test]
    fn a_constant_array_reports_that_constant_at_every_percentile() {
        let s = of(&[7.5f32; 16]);
        assert_eq!((s.min, s.max), (7.5, 7.5));
        assert!(s.percentiles.iter().all(|p| *p == 7.5));
        assert_eq!(s.histogram[0], 16);
    }

    #[test]
    fn an_empty_or_all_nan_array_is_all_zero_rather_than_a_panic() {
        assert_eq!(of(&[]).max, 0.0);
        assert_eq!(of(&[f32::NAN, f32::NAN]).mean, 0.0);
    }
}
