//! `tvx-tract` — precomputed tractograms (ARCHITECTURE.md §6.3.1). Every format is a push parser, so a
//! file larger than wasm32's address space can still be scanned and only kept points are retained.
#![forbid(unsafe_code)]

mod builder;
mod gpu;
mod tck;
mod trk;
mod trx;

use tvx_core::{Aabb, Error, FieldStats, Result};

pub use gpu::{gpu_geometry, tangents_into, GpuGeometry};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TractFormat {
    Trx,
    Tck,
    Trk,
}

impl TractFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "trx" => Some(Self::Trx),
            "tck" => Some(Self::Tck),
            "trk" => Some(Self::Trk),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trx => "trx",
            Self::Tck => "tck",
            Self::Trk => "trk",
        }
    }
}

/// By extension, tolerating a transport `.gz`.
pub fn format_for_name(name: &str) -> Option<TractFormat> {
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".gz").unwrap_or(&lower);
    TractFormat::parse(stem.rsplit('.').next()?)
}

#[derive(Clone, Copy, Debug)]
pub struct LoadOptions {
    /// `None` keeps everything.
    pub max_points: Option<u64>,
    pub seed: u32,
}

#[derive(Clone, Debug)]
pub struct TractField {
    pub name: String,
    pub values: Vec<f32>,
    pub units: Option<String>,
    pub stats: FieldStats,
    pub nan_count: u64,
    pub builtin: bool,
    pub categorical: bool,
    pub sampled: bool,
}

#[derive(Clone, Debug)]
pub struct TractGroup {
    pub id: u32,
    pub name: String,
    /// Held indices, ascending.
    pub streamlines: Vec<u32>,
    pub color: Option<[u8; 3]>,
}

#[derive(Clone, Debug)]
pub struct Tractogram {
    /// 3/point, world RAS mm.
    pub positions: Vec<f32>,
    /// S + 1.
    pub offsets: Vec<u32>,
    /// S: this streamline's index in the file.
    pub source_index: Vec<u32>,
    pub source_streamlines: u64,
    pub source_points: u64,
    pub vertex_fields: Vec<TractField>,
    pub streamline_fields: Vec<TractField>,
    pub groups: Vec<TractGroup>,
    pub bounds: Aabb,
    pub notes: Vec<String>,
    pub header_json: String,
    pub fingerprint: String,
}

impl Tractogram {
    pub fn n_streamlines(&self) -> usize {
        self.source_index.len()
    }
    pub fn n_points(&self) -> usize {
        self.positions.len() / 3
    }
}

/// `fmix32(index ^ seed) < p · 2³²`: uniform, metric-neutral, deterministic and nested (§6.3.1).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Keep {
    threshold: u64,
    seed: u32,
}

impl Keep {
    pub(crate) fn new(options: LoadOptions, estimated_points: u64) -> Self {
        let threshold = match options.max_points {
            Some(cap) if estimated_points > cap => {
                ((cap as f64 / estimated_points as f64) * 4_294_967_296.0).ceil() as u64
            }
            _ => 1u64 << 32,
        };
        Self {
            threshold,
            seed: options.seed,
        }
    }

    #[inline]
    pub(crate) fn keep(&self, index: u64) -> bool {
        let mut h = (index ^ (index >> 32)) as u32 ^ self.seed;
        h ^= h >> 16;
        h = h.wrapping_mul(0x85eb_ca6b);
        h ^= h >> 13;
        h = h.wrapping_mul(0xc2b2_ae35);
        h ^= h >> 16;
        u64::from(h) < self.threshold
    }
}

pub(crate) enum Parser {
    Tck(tck::TckParser),
    Trk(trk::TrkParser),
    Trx(Box<trx::TrxParser>),
}

/// Feeds a parser and hashes the bytes on their first pass.
pub struct Loader {
    parser: Parser,
    hash: tvx_core::fingerprint::Streaming,
    pass: u32,
    seen: u64,
    total_len: u64,
}

impl Loader {
    pub fn new(format: TractFormat, total_len: u64, options: LoadOptions) -> Result<Self> {
        let parser = match format {
            TractFormat::Tck => Parser::Tck(tck::TckParser::new(total_len, options)),
            TractFormat::Trk => Parser::Trk(trk::TrkParser::new(total_len, options)),
            TractFormat::Trx => Parser::Trx(Box::new(trx::TrxParser::new(options))),
        };
        Ok(Self {
            parser,
            hash: tvx_core::fingerprint::Streaming::new(total_len),
            pass: 0,
            seen: 0,
            total_len,
        })
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<()> {
        if self.pass == 0 {
            self.hash.update(chunk);
            self.seen += chunk.len() as u64;
        }
        match &mut self.parser {
            Parser::Tck(p) => p.push(chunk),
            Parser::Trk(p) => p.push(chunk),
            Parser::Trx(p) => p.push(chunk),
        }
    }

    /// `true` asks for the file from the start once more.
    pub fn end_pass(&mut self) -> Result<bool> {
        if self.pass == 0 && self.seen != self.total_len {
            return Err(Error::Parse(format!(
                "expected {} bytes and read {}: the file changed or the length was wrong",
                self.total_len, self.seen
            )));
        }
        self.pass += 1;
        match &mut self.parser {
            Parser::Tck(p) => p.end().map(|()| false),
            Parser::Trk(p) => p.end().map(|()| false),
            Parser::Trx(p) => p.end_pass(),
        }
    }

    pub fn finish(self) -> Result<Tractogram> {
        let mut t = match self.parser {
            Parser::Tck(p) => p.finish(),
            Parser::Trk(p) => p.finish(),
            Parser::Trx(p) => p.finish(),
        }?;
        t.fingerprint = self.hash.finish();
        Ok(t)
    }
}

/// Convenience over [`Loader`] for a whole file in memory: native tools and tests.
pub fn load_bytes(format: TractFormat, bytes: &[u8], options: LoadOptions) -> Result<Tractogram> {
    let mut loader = Loader::new(format, bytes.len() as u64, options)?;
    loop {
        for chunk in bytes.chunks(1 << 16) {
            loader.push(chunk)?;
        }
        if !loader.end_pass()? {
            return loader.finish();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleOp {
    Value,
    Magnitude,
    Dot,
    AbsDot,
    AbsCross,
}

impl SampleOp {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "value" => Some(Self::Value),
            "magnitude" => Some(Self::Magnitude),
            "dot" => Some(Self::Dot),
            "abs-dot" => Some(Self::AbsDot),
            "abs-cross" => Some(Self::AbsCross),
            _ => None,
        }
    }
    pub fn needs_tangent(self) -> bool {
        matches!(self, Self::Dot | Self::AbsDot | Self::AbsCross)
    }
}

/// NaN in `v`, or a zero tangent on an op that reads one, is NaN out.
pub fn reduce_vector(op: SampleOp, v: [f32; 3], t: [f32; 3]) -> f32 {
    let dot = || {
        f64::from(v[0]) * f64::from(t[0])
            + f64::from(v[1]) * f64::from(t[1])
            + f64::from(v[2]) * f64::from(t[2])
    };
    if op.needs_tangent() && t == [0.0; 3] {
        return f32::NAN;
    }
    match op {
        SampleOp::Value | SampleOp::Magnitude => {
            let s = v.iter().map(|c| f64::from(*c) * f64::from(*c)).sum::<f64>();
            s.sqrt() as f32
        }
        SampleOp::Dot => dot() as f32,
        SampleOp::AbsDot => dot().abs() as f32,
        SampleOp::AbsCross => {
            let (a, b) = (v.map(f64::from), t.map(f64::from));
            let c = [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ];
            (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt() as f32
        }
    }
}

/// A field's statistics with non-finite samples excluded, and how many there were.
pub fn make_field(name: String, values: Vec<f32>, units: Option<String>) -> TractField {
    let stats = tvx_mesh_io::field_stats(&values, 1);
    let nan_count = values.iter().filter(|v| !v.is_finite()).count() as u64;
    TractField {
        name,
        values,
        units,
        stats,
        nan_count,
        builtin: false,
        categorical: false,
        sampled: false,
    }
}
