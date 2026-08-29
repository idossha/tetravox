//! One linear walk over a volume's samples **in physical units** (`v = raw*slope + inter`), shared
//! by `stats`, `label_index`, `gpu_payload` and the `is_label` test.
//!
//! The raw samples themselves are never rewritten (ARCHITECTURE.md §6.1); scaling is applied here,
//! on the way past, and carried separately in `GpuPayload{scale, offset}`.

use std::cell::Cell;

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
    ($src:expr, $lo:expr, $hi:expr, $slope:expr, $inter:expr, $p:expr, $f:expr, $stop:expr) => {{
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
            if $stop() {
                break;
            }
        }
    }};
}

/// Feed every physical sample of `vol` to `f`, in storage order, stopping at the first chunk
/// boundary past which `stop` is true. `f` and `stop` communicate through shared `Cell`s, which is
/// why neither takes `&mut` state.
pub(crate) fn for_each_while<F: Fn(f64), S: Fn() -> bool>(
    v: &Volume,
    vol: Option<usize>,
    p: &mut dyn ProgressSink,
    f: F,
    stop: S,
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
        VolumeData::U8(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::I8(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::U16(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::I16(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::U32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::I32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::F32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::F64(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::Rgb24(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
        VolumeData::Rgba32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, stop),
    }
    Ok(())
}

/// Feed every physical sample of `vol` to `f`, in storage order. Separate from
/// [`for_each_while`] so the hot paths — `stats`, `gpu_payload` — take a plain `FnMut` with no
/// interior-mutability check per sample.
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
    let go = || false;
    match &v.data {
        VolumeData::U8(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::I8(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::U16(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::I16(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::U32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::I32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::F32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::F64(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::Rgb24(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
        VolumeData::Rgba32(d) => walk_slice!(d, lo, hi, slope, inter, p, f, go),
    }
    Ok(())
}

/// §6.1's `is_label` first pass — all samples integral, finite and non-negative — with an early
/// exit. `T1.nii.gz` fails it on its first negative voxel, so an anatomical scan never pays for a
/// full extra walk at load (§9.1 row 1). Returns the physical `(min, max)` when it passes.
pub(crate) fn integral_range(
    v: &Volume,
    vol: Option<usize>,
    p: &mut dyn ProgressSink,
) -> Result<Option<(f64, f64)>> {
    let ok = Cell::new(true);
    let n = Cell::new(0u64);
    let min = Cell::new(f64::INFINITY);
    let max = Cell::new(f64::NEG_INFINITY);
    for_each_while(
        v,
        vol,
        p,
        |x| {
            if !ok.get() {
                return;
            }
            if !x.is_finite() || x < 0.0 || x != x.trunc() {
                ok.set(false);
                return;
            }
            n.set(n.get() + 1);
            if x < min.get() {
                min.set(x);
            }
            if x > max.get() {
                max.set(x);
            }
        },
        || !ok.get(),
    )?;
    Ok((ok.get() && n.get() > 0).then(|| (min.get(), max.get())))
}

/// §6.1's `is_label` second pass, for volumes with more than 255 distinct values: the fraction of
/// adjacent same-row sample pairs, at least one of which is non-zero, whose **raw** samples are
/// equal. A label map is piecewise constant — every interior voxel of a region equals its
/// neighbour — so this sits near 1; an intensity image with hundreds of grey levels changes value
/// almost every voxel and sits near 0. Background-to-background pairs are excluded so a scan with a
/// large zero field outside the body does not score as constant. Returns 0 when no pair qualifies.
pub(crate) fn run_agreement(v: &Volume, vol: Option<usize>) -> f64 {
    let Some((lo, hi)) = range(v, vol) else {
        return 0.0;
    };
    let row = v.dims[0];
    if row < 2 {
        return 0.0;
    }
    macro_rules! agree {
        ($d:expr) => {{
            let (mut same, mut pairs) = (0u64, 0u64);
            for r in $d[lo..hi].chunks_exact(row) {
                for w in r.windows(2) {
                    let (a, b) = (w[0] as f64, w[1] as f64);
                    if a == 0.0 && b == 0.0 {
                        continue;
                    }
                    pairs += 1;
                    if a == b {
                        same += 1;
                    }
                }
            }
            if pairs == 0 {
                0.0
            } else {
                same as f64 / pairs as f64
            }
        }};
    }
    match &v.data {
        VolumeData::U8(d) => agree!(d),
        VolumeData::I8(d) => agree!(d),
        VolumeData::U16(d) => agree!(d),
        VolumeData::I16(d) => agree!(d),
        VolumeData::U32(d) => agree!(d),
        VolumeData::I32(d) => agree!(d),
        VolumeData::F32(d) => agree!(d),
        VolumeData::F64(d) => agree!(d),
        VolumeData::Rgb24(_) | VolumeData::Rgba32(_) => 0.0,
    }
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
