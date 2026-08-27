//! One linear walk over a volume's samples **in physical units** (`v = raw*slope + inter`), shared
//! by `stats`, `label_index`, `gpu_payload` and the `is_label` test.
//!
//! The raw samples themselves are never rewritten (ARCHITECTURE.md §6.1); scaling is applied here,
//! on the way past, and carried separately in `GpuPayload{scale, offset}`.

use tvx_core::{Error, Phase, ProgressSink, Result};

use crate::{Volume, VolumeData};

/// Progress is reported (and cancellation polled) once per this many samples.
const CHUNK: usize = 1 << 20;

/// The half-open sample range covered by `vol`: one volume, or all of them when `vol` is `None`.
/// For the colour types a "sample" is one 8-bit component, matching §4.2's scalar-only stats model.
fn range(v: &Volume, vol: Option<usize>) -> Option<(usize, usize)> {
    let per = v.dims[0] * v.dims[1] * v.dims[2];
    let comps = match v.datatype {
        crate::DataType::Rgb24 => 3,
        crate::DataType::Rgba32 => 4,
        _ => 1,
    };
    match vol {
        None => Some((0, per * v.nvols * comps)),
        Some(i) if i < v.nvols => Some((i * per * comps, (i + 1) * per * comps)),
        Some(_) => None,
    }
}

macro_rules! walk_slice {
    ($src:expr, $lo:expr, $hi:expr, $slope:expr, $inter:expr, $p:expr, $f:expr) => {{
        let mut i = $lo;
        while i < $hi {
            let end = (i + CHUNK).min($hi);
            for s in &$src[i..end] {
                $f((*s as f64) * $slope + $inter);
            }
            i = end;
            $p.report(Phase::Index, (i - $lo) as u64, ($hi - $lo) as u64);
            if $p.aborted() {
                return Err(Error::Cancelled);
            }
        }
    }};
}

/// Feed every physical sample of `vol` to `f`, in storage order.
pub(crate) fn for_each<F: FnMut(f64)>(
    v: &Volume,
    vol: Option<usize>,
    p: &mut dyn ProgressSink,
    mut f: F,
) -> Result<()> {
    let Some((lo, hi)) = range(v, vol) else {
        return Err(Error::Parse(format!(
            "volume index {} is out of range (nvols = {})",
            vol.unwrap_or(0),
            v.nvols
        )));
    };
    let (slope, inter) = (v.scl_slope as f64, v.scl_inter as f64);
    match &v.data {
        VolumeData::U8(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::I8(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::U16(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::I16(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::U32(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::I32(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::F32(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::F64(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::Rgb24(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
        VolumeData::Rgba32(d) => walk_slice!(d, lo, hi, slope, inter, p, f),
    }
    Ok(())
}

/// What one pass over the physical samples learns. `min`/`max` ignore non-finite samples.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Scan {
    pub min: f64,
    pub max: f64,
    pub sum: f64,
    pub finite: u64,
    pub total: u64,
    pub all_integral: bool,
    pub any_nonfinite: bool,
}

impl Scan {
    pub fn of(v: &Volume, vol: Option<usize>, p: &mut dyn ProgressSink) -> Result<Scan> {
        let mut s = Scan {
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            sum: 0.0,
            finite: 0,
            total: 0,
            all_integral: true,
            any_nonfinite: false,
        };
        for_each(v, vol, p, |x| {
            s.total += 1;
            if !x.is_finite() {
                s.any_nonfinite = true;
                s.all_integral = false;
                return;
            }
            s.finite += 1;
            s.sum += x;
            if x < s.min {
                s.min = x;
            }
            if x > s.max {
                s.max = x;
            }
            if s.all_integral && x != x.trunc() {
                s.all_integral = false;
            }
        })?;
        if s.finite == 0 {
            s.min = 0.0;
            s.max = 0.0;
            s.all_integral = false;
        }
        Ok(s)
    }

    pub fn span(&self) -> f64 {
        self.max - self.min
    }

    pub fn mean(&self) -> f64 {
        if self.finite == 0 {
            0.0
        } else {
            self.sum / self.finite as f64
        }
    }
}
