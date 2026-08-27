//! `tvx-core` — shared types for every other Tetravox crate.
//!
//! This crate is [`docs/ARCHITECTURE.md` §6.0](../../../docs/ARCHITECTURE.md) verbatim. Every public
//! signature here is **frozen** (§12.3): changing one requires editing `docs/ARCHITECTURE.md` in the
//! same commit and appending a line to `docs/DECISIONS.md`.
//!
//! Crate dependency direction (no cycles, §6):
//! `tvx-core` ← `tvx-nifti` ← `tvx-geom`; `tvx-core` ← `tvx-mesh-io` ← `tvx-geom`; `tvx-wasm` ← all four.
//!
//! Phase 0 ships signatures only; bodies are `unimplemented!("phase 1")`.

#![forbid(unsafe_code)]

/// A half-space. **Keep side: `normal·x + offset >= 0`** (§6.0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    pub normal: [f32; 3],
    pub offset: f32,
}

/// A packed bit set, one bit per element (§6.0). Used as the isolation mask that
/// `surface` / `boundary` / `cut` / `marchingTets` take by `maskId` (§6.5.2).
#[derive(Clone, Debug)]
pub struct BitMask {
    #[allow(dead_code)] // phase 1
    bits: Vec<u64>,
    #[allow(dead_code)] // phase 1
    len: usize,
}

#[allow(clippy::len_without_is_empty)] // §6.0 fixes the public surface; `is_empty` is not part of it.
impl BitMask {
    pub fn new_all(len: usize, value: bool) -> Self {
        unimplemented!("phase 1: {len} {value}")
    }
    pub fn get(&self, i: usize) -> bool {
        unimplemented!("phase 1: {i}")
    }
    pub fn set(&mut self, i: usize, v: bool) {
        unimplemented!("phase 1: {i} {v}")
    }
    pub fn count_ones(&self) -> usize {
        unimplemented!("phase 1")
    }
    pub fn len(&self) -> usize {
        unimplemented!("phase 1")
    }
    pub fn as_bytes(&self) -> &[u8] {
        unimplemented!("phase 1")
    }
    pub fn from_bytes(len: usize, bytes: &[u8]) -> Result<Self> {
        unimplemented!("phase 1: {} {}", len, bytes.len())
    }
}

/// Exact statistics of a scalar array, in **physical** units (§6.1: slope/inter already applied).
///
/// Computed by one O(n) pass into a 65536-bin histogram over `[min, max]`; the 256-bin display
/// histogram is derived from it. No sampling — sampling is not deterministic (§6.1).
#[derive(Clone, Debug)]
pub struct FieldStats {
    pub min: f32,
    pub max: f32,
    pub mean: f64,
    /// 0.1, 1, 2, 5, 50, 95, 98, 99, 99.9 — fixed order, see [`PERCENTILES`].
    pub percentiles: [f32; 9],
    pub histogram: [u32; 256],
    pub histogram_lo: f32,
    pub histogram_hi: f32,
}

/// The fixed percentile ladder of [`FieldStats::percentiles`] (§6.0).
pub const PERCENTILES: [f32; 9] = [0.1, 1.0, 2.0, 5.0, 50.0, 95.0, 98.0, 99.0, 99.9];

/// A node-indexed field (§6.0). Element-indexed fields are `tvx_mesh_io::ElmField`.
#[derive(Clone, Debug)]
pub struct Field {
    pub name: String,
    /// 1 | 3 | 9
    pub ncomp: usize,
    /// `n * ncomp`, row-major.
    pub data: Vec<f32>,
    pub units: Option<String>,
    /// True when the file left gaps; those are filled with `f32::NAN` (§6.2).
    pub partial: bool,
    /// Of the magnitude when `ncomp > 1`.
    pub stats: FieldStats,
}

/// One entry of a [`LabelTable`]. **Colour is RGBA 0..255** — the 0..1 float form lives on the
/// TypeScript side only, converted at the single point named in §4.1.
#[derive(Clone, Debug)]
pub struct LabelEntry {
    pub id: u32,
    pub name: String,
    pub color: [u8; 4],
}

/// Keyed by id, never indexed by id — SimNIBS/FreeSurfer ids are sparse and reach 530 `[DATA]` (§4.2).
#[derive(Clone, Debug, Default)]
pub struct LabelTable {
    pub entries: Vec<LabelEntry>,
}

impl LabelTable {
    pub fn get(&self, id: u32) -> Option<&LabelEntry> {
        unimplemented!("phase 1: {id}")
    }
    /// `FreeSurferColorLUT.txt`.
    pub fn parse_freesurfer(text: &str) -> Result<Self> {
        unimplemented!("phase 1: {}", text.len())
    }
    /// SimNIBS `#No.\tLabel Name:\tR G B A`.
    pub fn parse_simnibs(text: &str) -> Result<Self> {
        unimplemented!("phase 1: {}", text.len())
    }
    /// ITK-SNAP label description file.
    pub fn parse_itksnap(text: &str) -> Result<Self> {
        unimplemented!("phase 1: {}", text.len())
    }
    /// `id r g b [a] [name]`.
    pub fn parse_generic(text: &str) -> Result<Self> {
        unimplemented!("phase 1: {}", text.len())
    }
}

/// Axis-aligned bounding box in world millimetres (§3).
///
/// `Deserialize` because §6.3's `IsolateCriteria.box` is an `Option<Aabb>` deserialised straight from
/// the §6.5.1 wire form `{ min, max }`.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct Aabb {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// The crate-wide error type (§6.0). Maps 1:1 onto the protocol's `ErrorCode` (§6.5).
#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("parse: {0}")]
    Parse(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("io: {0}")]
    Io(String),
    #[error("out of memory: {0}")]
    OutOfMemory(String),
    #[error("cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Progress + cancellation (§6.0).
///
/// `tvx-wasm` implements it over a `js_sys::Function`, with `aborted()` returning `false`
/// unconditionally — there is no `SharedArrayBuffer` to poll (§1, §5 rule 6), so wasm cancellation is
/// `worker.terminate()`. `aborted()` exists for the native/CLI build, which can flip a real `AtomicBool`.
/// [`NoProgress`] is the no-op implementation.
pub trait ProgressSink {
    fn report(&mut self, phase: Phase, done: u64, total: u64);
    fn aborted(&self) -> bool;
}

/// Load/compute phase, mirrored on the wire as protocol `Phase` and in the engine as `LoadPhase`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Read,
    Inflate,
    Parse,
    Topology,
    Index,
    Upload,
}

/// The no-op [`ProgressSink`]: `report` does nothing, `aborted` is always `false`.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoProgress;

impl ProgressSink for NoProgress {
    fn report(&mut self, _phase: Phase, _done: u64, _total: u64) {}
    fn aborted(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §6.0 pins the percentile ladder and its order; `FieldStats::percentiles` is indexed by it.
    #[test]
    fn percentile_ladder_is_the_frozen_one() {
        assert_eq!(
            PERCENTILES,
            [0.1, 1.0, 2.0, 5.0, 50.0, 95.0, 98.0, 99.0, 99.9]
        );
    }

    #[test]
    fn no_progress_never_aborts() {
        let mut p = NoProgress;
        p.report(Phase::Parse, 1, 2);
        assert!(!p.aborted());
    }

    #[test]
    fn error_messages_match_the_contract() {
        assert_eq!(Error::Cancelled.to_string(), "cancelled");
        assert_eq!(Error::Parse("x".into()).to_string(), "parse: x");
        assert_eq!(Error::Unsupported("x".into()).to_string(), "unsupported: x");
        assert_eq!(Error::Io("x".into()).to_string(), "io: x");
        assert_eq!(
            Error::OutOfMemory("x".into()).to_string(),
            "out of memory: x"
        );
    }
}
