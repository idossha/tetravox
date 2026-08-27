//! Exact statistics and the unique-value scan (ARCHITECTURE.md §6.1, §6.0 `FieldStats`).
//!
//! §6.1: "one O(n) pass into a 65536-bin histogram over `[min, max]` gives the percentiles (exact
//! for integer dtypes, ≤ 1/65536 relative error for float); the 256-bin display histogram is derived
//! from it. No sampling — sampling is not deterministic."
//!
//! Two refinements the contract's accuracy claim requires, spelled out because they are the whole
//! reason the integer case is *exact*:
//!
//! * When every physical sample is integral and `max - min <= 65535`, the fine histogram is one bin
//!   **per integer**, so a percentile is an exact data value rather than a bin edge. This covers
//!   every label volume and every 8/16-bit scalar, and `vol_scl.nii`'s ±29,350 physical range.
//! * Otherwise the 65536 bins are uniform over `[min, max]` and a percentile is reported as its
//!   bin's **lower edge** — always ≤ the true value, by less than `(max - min) / 65536`.
//!
//! A percentile is the *nearest-rank* one (numpy's `method='inverted_cdf'`): the `ceil(p/100 · n)`-th
//! smallest finite sample.

use tvx_core::{FieldStats, Phase, ProgressSink, Result, PERCENTILES};

use crate::scan::{for_each, Scan};
use crate::Volume;

/// The fine histogram's bin count in the general (non-integral) case.
const FINE_BINS: usize = 65536;

/// The widest integral span that may be given one bin per integer. Equal to `FINE_BINS - 1`, so the
/// exact path never costs more memory than the general one.
const MAX_EXACT_SPAN: f64 = (FINE_BINS - 1) as f64;

/// The widest integral span the unique-value bitset will cover: 2^24 ids = 2 MB of bits. Sparse
/// atlases reach id 530 `[DATA]`; anything past 16.7 M is not a label volume.
const MAX_UNIQUE_SPAN: f64 = (1u64 << 24) as f64;

/// How a physical value maps to a fine-histogram bin, and back.
#[derive(Clone, Copy)]
pub(crate) struct Binning {
    pub min: f64,
    pub span: f64,
    pub nbins: usize,
    /// One bin per integer — the exact path.
    pub integral: bool,
}

impl Binning {
    pub fn of(s: &Scan) -> Binning {
        let span = s.span();
        if span <= 0.0 {
            return Binning {
                min: s.min,
                span: 0.0,
                nbins: 1,
                integral: true,
            };
        }
        if s.all_integral && span <= MAX_EXACT_SPAN {
            Binning {
                min: s.min,
                span,
                nbins: span as usize + 1,
                integral: true,
            }
        } else {
            Binning {
                min: s.min,
                span,
                nbins: FINE_BINS,
                integral: false,
            }
        }
    }

    pub fn bin(&self, x: f64) -> usize {
        if self.span <= 0.0 {
            return 0;
        }
        let b = if self.integral {
            (x - self.min) as usize
        } else {
            ((x - self.min) / self.span * FINE_BINS as f64) as usize
        };
        b.min(self.nbins - 1)
    }

    /// The smallest physical value that lands in `b`. Exact on the integral path.
    pub fn value(&self, b: usize) -> f64 {
        if self.span <= 0.0 {
            return self.min;
        }
        if self.integral {
            self.min + b as f64
        } else {
            self.min + b as f64 * self.span / FINE_BINS as f64
        }
    }
}

pub(crate) fn field_stats(v: &Volume, vol: usize, p: &mut dyn ProgressSink) -> Result<FieldStats> {
    let s = Scan::of(v, Some(vol), p)?;
    let empty = FieldStats {
        min: s.min as f32,
        max: s.max as f32,
        mean: s.mean(),
        percentiles: [0.0; 9],
        histogram: [0; 256],
        histogram_lo: s.min as f32,
        histogram_hi: s.max as f32,
    };
    if s.finite == 0 {
        return Ok(empty);
    }

    let b = Binning::of(&s);
    let mut fine = vec![0u64; b.nbins];
    for_each(v, Some(vol), p, |x| {
        if x.is_finite() {
            fine[b.bin(x)] += 1;
        }
    })?;

    // Nearest-rank percentiles, one cumulative walk for all nine.
    let mut percentiles = [0f32; 9];
    let total = s.finite;
    let wanted: Vec<u64> = PERCENTILES
        .iter()
        .map(|q| {
            let k = (*q as f64 / 100.0 * total as f64).ceil() as u64;
            k.clamp(1, total)
        })
        .collect();
    let mut cum = 0u64;
    let mut next = 0usize;
    for (i, c) in fine.iter().enumerate() {
        cum += c;
        while next < wanted.len() && cum >= wanted[next] {
            percentiles[next] = b.value(i) as f32;
            next += 1;
        }
        if next == wanted.len() {
            break;
        }
    }
    // A cumulative count can only fall short through rounding; pin the tail to the maximum.
    for q in percentiles.iter_mut().skip(next) {
        *q = s.max as f32;
    }

    // §4.2's 256-bin display histogram, derived from the fine one.
    let mut histogram = [0u32; 256];
    for (i, c) in fine.iter().enumerate() {
        if *c == 0 {
            continue;
        }
        let d = if b.span <= 0.0 {
            0
        } else {
            (((b.value(i) - b.min) / b.span * 256.0) as usize).min(255)
        };
        histogram[d] = histogram[d].saturating_add((*c).min(u32::MAX as u64) as u32);
    }

    p.report(Phase::Index, total, total);
    Ok(FieldStats {
        percentiles,
        histogram,
        ..empty
    })
}

/// The sorted distinct integral values of `vol`, or `None` when there are more than `limit` of them
/// (or when their span is too wide to be a label volume at all).
///
/// `min`/`max` come from a completed [`Scan`] whose `all_integral` is true.
pub(crate) fn unique_ids(
    v: &Volume,
    vol: Option<usize>,
    min: f64,
    max: f64,
    limit: usize,
    p: &mut dyn ProgressSink,
) -> Result<Option<Vec<u32>>> {
    let span = max - min;
    if !(0.0..=MAX_UNIQUE_SPAN).contains(&span) || min < 0.0 || max > u32::MAX as f64 {
        return Ok(None);
    }
    let n = span as usize + 1;
    let mut seen = vec![false; n];
    let mut count = 0usize;
    let mut overflow = false;
    for_each(v, vol, p, |x| {
        if overflow || !x.is_finite() {
            return;
        }
        let i = (x - min) as usize;
        if !seen[i] {
            seen[i] = true;
            count += 1;
            if count > limit {
                overflow = true;
            }
        }
    })?;
    if overflow {
        return Ok(None);
    }
    let base = min as u32;
    Ok(Some(
        seen.iter()
            .enumerate()
            .filter(|(_, s)| **s)
            .map(|(i, _)| base + i as u32)
            .collect(),
    ))
}

/// `Some(count)` when the distinct integral values number at most `limit`.
pub(crate) fn unique_count_at_most(
    v: &Volume,
    vol: Option<usize>,
    min: f64,
    max: f64,
    limit: usize,
    p: &mut dyn ProgressSink,
) -> Result<Option<usize>> {
    Ok(unique_ids(v, vol, min, max, limit, p)?.map(|ids| ids.len()))
}
