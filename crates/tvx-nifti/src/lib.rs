//! `tvx-nifti` — voxel volume readers (NIfTI-1/2, FreeSurfer MGH/MGZ, NRRD, MetaImage), exact
//! statistics, GPU payload selection.
//!
//! This crate is [`docs/ARCHITECTURE.md` §6.1](../../../docs/ARCHITECTURE.md) verbatim; every public
//! signature is **frozen** (§12.3).
//!
//! Every reader — [`read_nifti`], [`read_mgh`], [`read_nrrd`], [`read_metaimage`], and
//! [`read_volume`] which sniffs and dispatches — produces the same [`Volume`], so the stats, the
//! `is_label` heuristic, the GPU payload ladder and the affine conventions below are shared by
//! construction (`common::finish`).
//!
//! Rules that §6.1 states and this crate implements:
//!
//! * `.nii` / `.nii.gz` by magic sniff, little- **and** big-endian. Accepted datatypes: uint8, int8,
//!   uint16, int16, uint32, int32, float32, float64, RGB24, RGBA32.
//!   [`tvx_core::Error::Unsupported`] *by name* for complex64/128, int64 (1024), uint64 (1280); two-file
//!   `ni1` (`.hdr`/`.img`) is `Error::Unsupported("two-file NIfTI …")`.
//! * MGH/MGZ is big-endian with a 284-byte header and nibabel's centre-based affine; NRRD and
//!   MetaImage are read with attached headers only (`.nhdr` / `.mhd` are `Unsupported` by name) and
//!   converted from their LPS space to RAS. Each carries `scl_slope/inter = (1, 0)`, `cal_* = 0`,
//!   `intent_code = 0`, and every parsed header field in `header_json`.
//! * **Scaling is never folded into the samples.** Apply slope/inter only when
//!   `slope.is_finite() && slope != 0.0 && inter.is_finite() && (slope != 1.0 || inter != 0.0)`;
//!   otherwise normalise to `(1.0, 0.0)`. It is carried in [`GpuPayload::scale`] / [`GpuPayload::offset`]
//!   and applied as `v = raw*scale + offset` in the fragment shader and in the probe path.
//! * **`is_label`** = all sample values integral ∧ min ≥ 0 ∧ (`intent_code == 1002` ∨ (unique count ≤ 4096 ∧
//!   (unique count ≤ 255 ∨ piecewise constant: ≥ 50 % of adjacent non-background sample pairs equal))).
//!   **The dtype must not be part of the test**: `segmentation/labeling.nii.gz` is float32 with 57
//!   integral unique values spanning 0…530 `[DATA]` and is a genuine atlas.
//! * The affine comes from sform when `sform_code > 0`, else the qform with **`qfac` applied to the third
//!   column only**, else `diag(pixdim[1..4], 1)` (§3).
//! * Volumes whose `max(dims) > caps.max_3d` fail loudly at load with a downsample offer — never a
//!   silently incomplete texture at draw time.
//!
//! Two things §6.1 leaves implicit, resolved here once so that every row of the ladder reads the same
//! way (both recorded in `docs/DECISIONS.md`):
//!
//! * **`want_linear` gates the label rows.** Rows 1–2 are the `NEAREST` rows, and §6.1 says
//!   `want_linear` is false exactly when the layer is a label or `interpolation === 'nearest'`. A
//!   scalar volume whose samples happen to be small non-negative integers therefore satisfies
//!   `is_label` — `vol_u8.nii` does, with 60 unique values in 0…234 — but still takes its dtype's row
//!   when the caller asks for linear filtering.
//! * **The normalised rows store a code, not a unit interval.** §6.1 row 4 fixes
//!   `scale = (max−min)/65535`, `offset = min`, which is only dimensionally consistent if the value the
//!   shader multiplies is the stored integer code `0..=65535` rather than GL's normalised `[0,1]` read.
//!   Rows 3, 6, 7 and 8 follow the same shape with their own full-scale code (255 for `R8`). `R32F`
//!   (rows 5/9) carries physical units directly, and the `R8UI`/`R16UI` label rows carry a dense index;
//!   all three set `scale = 1`, `offset = 0`.

#![forbid(unsafe_code)]

mod common;
mod format;
mod header;
mod metaimage;
mod mgh;
mod nrrd;
mod payload;
mod read;
mod scan;
mod stats;

pub use format::{read_volume, sniff_volume, VolumeFormat};
pub use metaimage::read_metaimage;
pub use mgh::read_mgh;
pub use nrrd::read_nrrd;
pub use read::read_nifti;

use tvx_core::{FieldStats, NoProgress, Result};

/// On-disk sample type (§6.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataType {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    F32,
    F64,
    Rgb24,
    Rgba32,
}

/// The raw samples, **as they are on disk** — `scl_slope`/`scl_inter` are not applied (§6.1).
#[derive(Clone, Debug)]
pub enum VolumeData {
    U8(Vec<u8>),
    I8(Vec<i8>),
    U16(Vec<u16>),
    I16(Vec<i16>),
    U32(Vec<u32>),
    I32(Vec<i32>),
    F32(Vec<f32>),
    F64(Vec<f64>),
    Rgb24(Vec<u8>),
    Rgba32(Vec<u8>),
}

/// A parsed voxel volume (§6.1) — the same struct from every reader.
#[derive(Clone, Debug)]
pub struct Volume {
    pub dims: [usize; 3],
    pub nvols: usize,
    /// Voxel index `(i,j,k,1)` → world RAS millimetres.
    ///
    /// **Row-major**, indexed `affine[row][col]` (§3, matrix layout): `affine[0]` is the first *row*, and
    /// `affine[0][3] / affine[1][3] / affine[2][3]` is the translation — the same layout as
    /// `testdata/manifest.json`'s `affine` and nibabel's `img.affine`. The wire form
    /// `VolumeMeta.affine: Mat4x4` (§6.5.1) is the **transpose**: flat, length 16, column-major, with the
    /// translation in slots 12–14. Whoever builds it writes `w[col * 4 + row] = affine[row][col]`.
    pub affine: [[f64; 4]; 4],
    pub spacing: [f64; 3],
    pub datatype: DataType,
    /// RAW samples; slope/inter NOT applied.
    pub data: VolumeData,
    /// Normalised to `(1.0, 0.0)` when inapplicable (§6.1).
    pub scl_slope: f32,
    pub scl_inter: f32,
    pub cal_min: f32,
    pub cal_max: f32,
    pub intent_code: i16,
    pub intent_name: String,
    pub descrip: String,
    pub xyz_units: Units,
    pub is_label: bool,
    /// Every raw header field, for the UI header panel.
    pub header_json: String,
}

/// The bytes that go straight into a GL 3D texture, plus how to get back to physical units (§6.1).
#[derive(Clone, Debug)]
pub struct GpuPayload {
    pub format: GpuFormat,
    pub bytes: Vec<u8>,
    pub scale: f32,
    pub offset: f32,
    pub filterable: bool,
}

/// GPU scalar formats of the §6.1 selection ladder.
///
/// `R16F` is a fallback only, never the default: half-float has an 11-bit mantissa, so even normalised
/// into `[0,1]` it delivers ~2048 distinct levels in the top binade against `R16`'s 65536 uniform ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuFormat {
    R8,
    R8Ui,
    R16,
    R16Ui,
    R16F,
    R32F,
    Rgba8,
}

/// The subset of engine `Capabilities` (§7.1) that the format ladder branches on. Travels in the op
/// args from `probeCapabilities()` on the UI thread (§6.5.2).
#[derive(Clone, Copy, Debug)]
pub struct GpuCaps {
    pub float_linear: bool,
    pub norm16: bool,
    pub max_3d: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Units {
    pub space: SpaceUnit,
    pub time: TimeUnit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpaceUnit {
    Unknown,
    Meter,
    Millimeter,
    Micron,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeUnit {
    Unknown,
    Second,
    Millisecond,
    Microsecond,
    Hz,
    Ppm,
    Rads,
}

/// Sorted unique label ids plus the id → dense-index remap the `R8UI`/`R16UI` ladder rows need.
/// `dense_of[id] -> index`; ids above 65535 dense indices are [`tvx_core::Error::Unsupported`].
#[derive(Clone, Debug)]
pub struct LabelIndex {
    pub ids: Vec<u32>,
    pub dense_of: Vec<u32>,
}

impl Volume {
    /// Exact statistics of volume `vol`, in **physical** units (§6.1).
    ///
    /// The signature carries no [`tvx_core::ProgressSink`], so an out-of-range `vol` yields an
    /// all-zero [`FieldStats`] rather than a panic — the caller has `nvols` to check against.
    pub fn stats(&self, vol: usize) -> FieldStats {
        stats::field_stats(self, vol, &mut NoProgress).unwrap_or(FieldStats {
            min: 0.0,
            max: 0.0,
            mean: 0.0,
            percentiles: [0.0; 9],
            histogram: [0; 256],
            histogram_lo: 0.0,
            histogram_hi: 0.0,
        })
    }
    pub fn label_index(&self, vol: usize) -> Result<LabelIndex> {
        payload::label_index(self, vol, &mut NoProgress)
    }
    /// The §6.1 selection ladder, first match wins. `want_linear` is false when the layer is a label
    /// or `interpolation === 'nearest'`.
    pub fn gpu_payload(&self, vol: usize, caps: &GpuCaps, want_linear: bool) -> Result<GpuPayload> {
        payload::gpu_payload(self, vol, caps, want_linear)
    }
    /// Physical units. Probes are served from the UI thread's retained `data` array (§4.3), so this
    /// exists for the native/CLI build only (§6.4).
    pub fn sample_nearest(&self, vol: usize, world: [f32; 3]) -> Option<f32> {
        payload::sample_nearest(self, vol, world)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_format_ladder_variants_exist() {
        // The seven formats §6.1's ladder can select. `R16F` is present but is never row 1..10's default.
        let all = [
            GpuFormat::R8,
            GpuFormat::R8Ui,
            GpuFormat::R16,
            GpuFormat::R16Ui,
            GpuFormat::R16F,
            GpuFormat::R32F,
            GpuFormat::Rgba8,
        ];
        assert_eq!(all.len(), 7);
        assert_ne!(GpuFormat::R16, GpuFormat::R16F);
    }

    #[test]
    fn accepted_datatypes_are_the_ten_of_the_contract() {
        let all = [
            DataType::U8,
            DataType::I8,
            DataType::U16,
            DataType::I16,
            DataType::U32,
            DataType::I32,
            DataType::F32,
            DataType::F64,
            DataType::Rgb24,
            DataType::Rgba32,
        ];
        assert_eq!(all.len(), 10);
    }
}
