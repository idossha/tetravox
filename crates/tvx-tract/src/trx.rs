//! TRX: a zip of raw arrays, read forward. Zip order is not fixed, so an array met before what it
//! depends on (`header.json`, then `offsets`) is deferred to a later pass; at most three are needed.

use std::collections::BTreeSet;

use flate2::{Decompress, FlushDecompress, Status};
use tvx_core::{Error, Result};

use crate::builder::Builder;
use crate::{Keep, LoadOptions, TractGroup, Tractogram};

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;
const ZIP64_END: u32 = 0x0606_4b50;
/// Fields are `f32` (§6.3.1), which holds every integer up to this and not all beyond it.
const F32_EXACT_INT: f64 = 16_777_216.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dtype {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F16,
    F32,
    F64,
}

impl Dtype {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "int8" => Self::I8,
            "uint8" => Self::U8,
            "int16" => Self::I16,
            "uint16" => Self::U16,
            "int32" => Self::I32,
            "uint32" => Self::U32,
            "int64" => Self::I64,
            "uint64" => Self::U64,
            "float16" => Self::F16,
            "float32" => Self::F32,
            "float64" => Self::F64,
            _ => return None,
        })
    }
    fn is_int(self) -> bool {
        !matches!(self, Self::F16 | Self::F32 | Self::F64)
    }
    fn width(self) -> usize {
        match self {
            Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 | Self::F16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::I64 | Self::U64 | Self::F64 => 8,
        }
    }
    #[inline]
    fn f64_at(self, b: &[u8]) -> f64 {
        match self {
            Self::I8 => f64::from(b[0] as i8),
            Self::U8 => f64::from(b[0]),
            Self::I16 => f64::from(i16::from_le_bytes([b[0], b[1]])),
            Self::U16 => f64::from(u16::from_le_bytes([b[0], b[1]])),
            Self::F16 => half_to_f64(u16::from_le_bytes([b[0], b[1]])),
            Self::I32 => f64::from(i32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            Self::U32 => f64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            Self::F32 => f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            Self::I64 => i64::from_le_bytes(b[..8].try_into().expect("8 bytes")) as f64,
            Self::U64 => u64::from_le_bytes(b[..8].try_into().expect("8 bytes")) as f64,
            Self::F64 => f64::from_le_bytes(b[..8].try_into().expect("8 bytes")),
        }
    }
}

fn half_to_f64(h: u16) -> f64 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = i32::from((h >> 10) & 0x1f);
    let frac = f64::from(h & 0x3ff);
    sign * match exp {
        0 => frac * 2f64.powi(-24),
        31 => {
            if frac == 0.0 {
                f64::INFINITY
            } else {
                f64::NAN
            }
        }
        _ => (1.0 + frac / 1024.0) * 2f64.powi(exp - 15),
    }
}

/// `dir/name.3.float32` → `(name, 3, F32)`.
fn parse_array_name(file: &str) -> Option<(String, usize, Dtype)> {
    let (stem, dt) = file.rsplit_once('.')?;
    let dtype = Dtype::parse(dt)?;
    if let Some((name, n)) = stem.rsplit_once('.') {
        if let Ok(ncomp) = n.parse::<usize>() {
            return Some((name.to_string(), ncomp.max(1), dtype));
        }
    }
    Some((stem.to_string(), 1, dtype))
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Role {
    Skip,
    Header,
    Offsets(Dtype),
    Positions(Dtype, usize),
    Dpv(String, usize, Dtype),
    Dps(String, usize, Dtype),
    Group(String, Dtype),
}

fn role_of(name: &str) -> Role {
    if name == "header.json" {
        return Role::Header;
    }
    if name.ends_with('/') {
        return Role::Skip;
    }
    match name.split_once('/') {
        None => match parse_array_name(name) {
            Some((stem, _, d)) if stem == "offsets" => Role::Offsets(d),
            Some((stem, n, d)) if stem == "positions" => Role::Positions(d, n),
            _ => Role::Skip,
        },
        Some(("dpv", f)) if !f.contains('/') => {
            parse_array_name(f).map_or(Role::Skip, |(n, c, d)| Role::Dpv(n, c, d))
        }
        Some(("dps", f)) if !f.contains('/') => {
            parse_array_name(f).map_or(Role::Skip, |(n, c, d)| Role::Dps(n, c, d))
        }
        Some(("groups", f)) if !f.contains('/') => {
            parse_array_name(f).map_or(Role::Skip, |(n, _, d)| Role::Group(n, d))
        }
        _ => Role::Skip,
    }
}

/// Where the decoded bytes of the current entry go.
enum Sink {
    Discard,
    Buffer(Vec<u8>),
    Array(ArraySink),
}

/// Fixed-width elements routed by point or streamline index through the kept set.
struct ArraySink {
    dtype: Dtype,
    ncomp: usize,
    carry: Vec<u8>,
    elem: u64,
    /// Destination field indices (one per component), or `None` for positions.
    fields: Option<Vec<usize>>,
    per_streamline: bool,
    cursor: usize,
    name: String,
    /// An integer above 2^24 was rounded on its way to `f32`.
    rounded: bool,
}

enum Body {
    Raw,
    Inflate(Box<Decompress>),
}

enum Stage {
    Signature,
    Local(Vec<u8>),
    Entry {
        left: Option<u64>,
        body: Body,
        sink: Sink,
        role: Role,
        name: String,
    },
    /// After a streamed entry: its data descriptor has no fixed shape, so scan to the next record.
    Resync,
    Tail,
}

pub(crate) struct TrxParser {
    options: LoadOptions,
    pass: u32,
    stage: Stage,
    sig: Vec<u8>,
    b: Builder,
    keep: Option<Keep>,
    nb_vertices: u64,
    nb_streamlines: u64,
    /// Source point ranges of the kept streamlines, ascending.
    kept_ranges: Vec<(u64, u64)>,
    kept_mask: Vec<u32>,
    offsets_seen: bool,
    positions_done: bool,
    done: BTreeSet<String>,
    deferred: u32,
    saw_local: bool,
    got_points: u64,
    /// Field entries this reader has no place for, reported in `notes`.
    unread: Vec<String>,
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().expect("4 bytes"))
}
fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().expect("8 bytes"))
}

impl TrxParser {
    pub fn new(options: LoadOptions) -> Self {
        Self {
            options,
            pass: 0,
            stage: Stage::Signature,
            sig: Vec::with_capacity(4),
            b: Builder::new(),
            keep: None,
            nb_vertices: 0,
            nb_streamlines: 0,
            kept_ranges: Vec::new(),
            kept_mask: Vec::new(),
            offsets_seen: false,
            positions_done: false,
            done: BTreeSet::new(),
            deferred: 0,
            saw_local: false,
            got_points: 0,
            unread: Vec::new(),
        }
    }

    pub fn push(&mut self, mut chunk: &[u8]) -> Result<()> {
        while !chunk.is_empty() {
            let stage = std::mem::replace(&mut self.stage, Stage::Tail);
            match stage {
                Stage::Tail => {
                    return Ok(());
                }
                Stage::Signature => {
                    let take = (4 - self.sig.len()).min(chunk.len());
                    self.sig.extend_from_slice(&chunk[..take]);
                    chunk = &chunk[take..];
                    if self.sig.len() < 4 {
                        self.stage = Stage::Signature;
                        return Ok(());
                    }
                    let sig = u32_at(&self.sig, 0);
                    self.sig.clear();
                    match sig {
                        LOCAL => {
                            self.saw_local = true;
                            self.stage = Stage::Local(Vec::with_capacity(26));
                        }
                        CENTRAL | END | ZIP64_END => self.stage = Stage::Tail,
                        _ if !self.saw_local => {
                            return Err(Error::Parse("not a TRX file: no zip signature".into()));
                        }
                        other => {
                            return Err(Error::Parse(format!(
                                "unexpected zip record {other:#010x} in a TRX file"
                            )));
                        }
                    }
                }
                Stage::Local(mut buf) => {
                    // 26 fixed bytes after the signature, then name + extra.
                    let need = if buf.len() < 26 {
                        26
                    } else {
                        26 + usize::from(u16_at(&buf, 22)) + usize::from(u16_at(&buf, 24))
                    };
                    let take = (need - buf.len()).min(chunk.len());
                    buf.extend_from_slice(&chunk[..take]);
                    chunk = &chunk[take..];
                    if buf.len() >= 26 {
                        let full =
                            26 + usize::from(u16_at(&buf, 22)) + usize::from(u16_at(&buf, 24));
                        if buf.len() == full {
                            self.stage = self.open_entry(&buf)?;
                            continue;
                        }
                    }
                    self.stage = Stage::Local(buf);
                }
                Stage::Entry {
                    left,
                    body,
                    sink,
                    role,
                    name,
                } => {
                    chunk = self.entry(left, body, sink, role, name, chunk)?;
                }
                Stage::Resync => {
                    let mut hit = false;
                    while let Some((&byte, rest)) = chunk.split_first() {
                        chunk = rest;
                        self.sig.push(byte);
                        if self.sig.len() > 4 {
                            self.sig.remove(0);
                        }
                        if self.sig.len() == 4
                            && matches!(u32_at(&self.sig, 0), LOCAL | CENTRAL | END | ZIP64_END)
                        {
                            hit = true;
                            break;
                        }
                    }
                    if !hit {
                        self.stage = Stage::Resync;
                        return Ok(());
                    }
                    match u32_at(&self.sig, 0) {
                        LOCAL => self.stage = Stage::Local(Vec::with_capacity(26)),
                        _ => self.stage = Stage::Tail,
                    }
                    self.sig.clear();
                }
            }
        }
        Ok(())
    }

    fn open_entry(&mut self, h: &[u8]) -> Result<Stage> {
        let flags = u16_at(h, 2);
        let method = u16_at(h, 4);
        let mut csize = u64::from(u32_at(h, 14));
        let name_len = usize::from(u16_at(h, 22));
        let extra_len = usize::from(u16_at(h, 24));
        let name = String::from_utf8_lossy(&h[26..26 + name_len]).into_owned();
        let usize32 = u32_at(h, 18);
        let extra = &h[26 + name_len..26 + name_len + extra_len];
        let mut at = 0;
        while at + 4 <= extra.len() {
            let id = u16_at(extra, at);
            let len = usize::from(u16_at(extra, at + 2));
            if id == 1 && at + 4 + len <= extra.len() {
                let mut p = at + 4;
                if usize32 == u32::MAX && p + 8 <= at + 4 + len {
                    p += 8;
                }
                if csize == u64::from(u32::MAX) && p + 8 <= at + 4 + len {
                    csize = u64_at(extra, p);
                }
            }
            at += 4 + len;
        }
        let streamed = flags & 0x8 != 0;
        if streamed && method == 0 {
            return Err(Error::Unsupported(format!(
                "TRX entry {name} is stored with a data descriptor, so its end cannot be found reading forward"
            )));
        }
        let body = match method {
            0 => Body::Raw,
            8 => Body::Inflate(Box::new(Decompress::new(false))),
            other => {
                return Err(Error::Unsupported(format!(
                    "TRX entry {name} uses zip method {other}; stored and deflated are supported"
                )));
            }
        };
        let role = role_of(&name);
        if role == Role::Skip
            && self.pass == 0
            && !name.ends_with('/')
            && ["dpv/", "dps/", "dpg/", "groups/"]
                .iter()
                .any(|p| name.starts_with(p))
        {
            self.unread.push(name.clone());
        }
        let sink = self.sink_for(&role, &name)?;
        let left = if streamed { None } else { Some(csize) };
        Ok(Stage::Entry {
            left,
            body,
            sink,
            role,
            name,
        })
    }

    fn sink_for(&mut self, role: &Role, name: &str) -> Result<Sink> {
        if self.done.contains(name) {
            return Ok(Sink::Discard);
        }
        Ok(match role {
            Role::Skip => Sink::Discard,
            Role::Header => Sink::Buffer(Vec::new()),
            Role::Offsets(_) => {
                if self.keep.is_none() {
                    self.deferred += 1;
                    return Ok(Sink::Discard);
                }
                Sink::Buffer(Vec::new())
            }
            Role::Positions(d, n) => {
                if *n != 3 {
                    return Err(Error::Parse(format!(
                        "TRX positions have {n} components, expected 3"
                    )));
                }
                if !self.offsets_seen {
                    self.deferred += 1;
                    return Ok(Sink::Discard);
                }
                self.b.positions.reserve(self.kept_points() as usize * 3);
                Sink::Array(ArraySink {
                    dtype: *d,
                    ncomp: 3,
                    carry: Vec::new(),
                    elem: 0,
                    fields: None,
                    per_streamline: false,
                    cursor: 0,
                    name: name.to_string(),
                    rounded: false,
                })
            }
            Role::Dpv(field, n, d) => {
                if !self.offsets_seen {
                    self.deferred += 1;
                    return Ok(Sink::Discard);
                }
                let fields = self.add_fields(field, *n, false);
                Sink::Array(ArraySink {
                    dtype: *d,
                    ncomp: *n,
                    carry: Vec::new(),
                    elem: 0,
                    fields: Some(fields),
                    per_streamline: false,
                    cursor: 0,
                    name: name.to_string(),
                    rounded: false,
                })
            }
            Role::Dps(field, n, d) => {
                if self.keep.is_none() {
                    self.deferred += 1;
                    return Ok(Sink::Discard);
                }
                let fields = self.add_fields(field, *n, true);
                Sink::Array(ArraySink {
                    dtype: *d,
                    ncomp: *n,
                    carry: Vec::new(),
                    elem: 0,
                    fields: Some(fields),
                    per_streamline: true,
                    cursor: 0,
                    name: name.to_string(),
                    rounded: false,
                })
            }
            Role::Group(_, _) => {
                if self.keep.is_none() {
                    self.deferred += 1;
                    return Ok(Sink::Discard);
                }
                Sink::Buffer(Vec::new())
            }
        })
    }

    fn add_fields(&mut self, name: &str, ncomp: usize, dps: bool) -> Vec<usize> {
        let list = if dps {
            &mut self.b.streamline_fields
        } else {
            &mut self.b.vertex_fields
        };
        (0..ncomp)
            .map(|c| {
                let n = if ncomp == 1 {
                    name.to_string()
                } else {
                    format!("{name}[{c}]")
                };
                list.push((n, Vec::new()));
                list.len() - 1
            })
            .collect()
    }

    fn kept_points(&self) -> u64 {
        self.kept_ranges.iter().map(|r| r.1).sum()
    }

    fn entry<'a>(
        &mut self,
        left: Option<u64>,
        body: Body,
        mut sink: Sink,
        role: Role,
        name: String,
        chunk: &'a [u8],
    ) -> Result<&'a [u8]> {
        match body {
            Body::Raw => {
                let left = left.expect("a stored entry has a size");
                let take = left.min(chunk.len() as u64) as usize;
                self.feed(&mut sink, &chunk[..take])?;
                let rest = &chunk[take..];
                let left = left - take as u64;
                if left == 0 {
                    self.close_entry(sink, &role, &name)?;
                    self.stage = Stage::Signature;
                } else {
                    self.stage = Stage::Entry {
                        left: Some(left),
                        body: Body::Raw,
                        sink,
                        role,
                        name,
                    };
                }
                Ok(rest)
            }
            Body::Inflate(mut z) => {
                let mut rest = chunk;
                let mut left = left;
                let mut out = vec![0u8; 1 << 18];
                loop {
                    let window = match left {
                        Some(l) => &rest[..l.min(rest.len() as u64) as usize],
                        None => rest,
                    };
                    let (i0, o0) = (z.total_in(), z.total_out());
                    let status = z
                        .decompress(window, &mut out, FlushDecompress::None)
                        .map_err(|e| Error::Parse(format!("TRX entry {name}: {e}")))?;
                    let used = (z.total_in() - i0) as usize;
                    let made = (z.total_out() - o0) as usize;
                    self.feed(&mut sink, &out[..made])?;
                    rest = &rest[used..];
                    if let Some(l) = &mut left {
                        *l -= used as u64;
                    }
                    if status == Status::StreamEnd {
                        self.close_entry(sink, &role, &name)?;
                        let Some(l) = left else {
                            self.stage = Stage::Resync;
                            return Ok(rest);
                        };
                        if l > 0 {
                            self.stage = Stage::Entry {
                                left: Some(l),
                                body: Body::Raw,
                                sink: Sink::Discard,
                                role: Role::Skip,
                                name,
                            };
                        } else {
                            self.stage = Stage::Signature;
                        }
                        return Ok(rest);
                    }
                    if used == 0 && made == 0 {
                        if left == Some(0) {
                            return Err(Error::Parse(format!("TRX entry {name} ends mid-stream")));
                        }
                        self.stage = Stage::Entry {
                            left,
                            body: Body::Inflate(z),
                            sink,
                            role,
                            name,
                        };
                        return Ok(rest);
                    }
                }
            }
        }
    }

    fn feed(&mut self, sink: &mut Sink, bytes: &[u8]) -> Result<()> {
        match sink {
            Sink::Discard => Ok(()),
            Sink::Buffer(v) => {
                v.extend_from_slice(bytes);
                Ok(())
            }
            Sink::Array(a) => self.feed_array(a, bytes),
        }
    }

    fn feed_array(&mut self, a: &mut ArraySink, mut bytes: &[u8]) -> Result<()> {
        let width = a.dtype.width() * a.ncomp;
        if !a.carry.is_empty() {
            let take = (width - a.carry.len()).min(bytes.len());
            a.carry.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if a.carry.len() < width {
                return Ok(());
            }
            let rec = std::mem::take(&mut a.carry);
            self.element(a, &rec);
        }
        let mut it = bytes.chunks_exact(width);
        for rec in it.by_ref() {
            self.element(a, rec);
        }
        a.carry.extend_from_slice(it.remainder());
        Ok(())
    }

    #[inline]
    fn element(&mut self, a: &mut ArraySink, rec: &[u8]) {
        let i = a.elem;
        a.elem += 1;
        let kept = if a.per_streamline {
            let keep = self.keep.expect("known before dps are read");
            keep.keep(i)
        } else {
            while let Some(&(start, len)) = self.kept_ranges.get(a.cursor) {
                if i >= start + len {
                    a.cursor += 1;
                } else {
                    break;
                }
            }
            matches!(self.kept_ranges.get(a.cursor), Some(&(start, _)) if i >= start)
        };
        if !kept {
            return;
        }
        let w = a.dtype.width();
        match &a.fields {
            None => {
                for c in 0..3 {
                    self.b.positions.push(a.dtype.f64_at(&rec[c * w..]) as f32);
                }
                self.got_points += 1;
            }
            Some(fields) => {
                let list = if a.per_streamline {
                    &mut self.b.streamline_fields
                } else {
                    &mut self.b.vertex_fields
                };
                for (c, f) in fields.iter().enumerate() {
                    let value = a.dtype.f64_at(&rec[c * w..]);
                    a.rounded |= a.dtype.is_int() && value.abs() > F32_EXACT_INT;
                    list[*f].1.push(value as f32);
                }
            }
        }
    }

    fn close_entry(&mut self, sink: Sink, role: &Role, name: &str) -> Result<()> {
        match sink {
            Sink::Discard => {}
            Sink::Buffer(bytes) => {
                match role {
                    Role::Header => self.read_header(&bytes)?,
                    Role::Offsets(d) => self.read_offsets(&bytes, *d)?,
                    Role::Group(group, d) => self.read_group(group, *d, &bytes),
                    _ => {}
                }
                self.done.insert(name.to_string());
            }
            Sink::Array(a) => {
                if !a.carry.is_empty() {
                    return Err(Error::Parse(format!(
                        "TRX entry {} is not a whole number of elements",
                        a.name
                    )));
                }
                let expected = if a.per_streamline {
                    self.nb_streamlines
                } else {
                    self.nb_vertices
                };
                if a.elem != expected {
                    return Err(Error::Parse(format!(
                        "TRX entry {} has {} elements; header.json implies {expected}",
                        a.name, a.elem
                    )));
                }
                if a.fields.is_none() {
                    self.positions_done = true;
                }
                if a.rounded {
                    self.b.notes.push(format!(
                        "TRX entry {} holds integers above 2^24; they are rounded here, so nearby ids can merge",
                        a.name
                    ));
                }
                self.done.insert(name.to_string());
            }
        }
        Ok(())
    }

    fn read_header(&mut self, bytes: &[u8]) -> Result<()> {
        let v: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|e| Error::Parse(format!("TRX header.json: {e}")))?;
        let need = |k: &str| {
            v.get(k).and_then(serde_json::Value::as_u64).ok_or_else(|| {
                Error::Parse(format!(
                    "TRX header.json has no {k}, so the file cannot be read"
                ))
            })
        };
        self.nb_vertices = need("NB_VERTICES")?;
        self.nb_streamlines = need("NB_STREAMLINES")?;
        if v.get("VOXEL_TO_RASMM").is_none() || v.get("DIMENSIONS").is_none() {
            self.b.notes.push(
                "TRX header.json has no VOXEL_TO_RASMM or DIMENSIONS; positions are RAS mm by the format's definition".into(),
            );
        }
        self.b.header_json = String::from_utf8_lossy(bytes).into_owned();
        self.b.source_streamlines = self.nb_streamlines;
        self.b.source_points = self.nb_vertices;
        let keep = Keep::new(self.options, self.nb_vertices);
        self.kept_mask = (0..self.nb_streamlines)
            .filter(|i| keep.keep(*i))
            .map(|i| i as u32)
            .collect();
        self.keep = Some(keep);
        Ok(())
    }

    fn read_offsets(&mut self, bytes: &[u8], d: Dtype) -> Result<()> {
        let w = d.width();
        let n = bytes.len() / w;
        let s = self.nb_streamlines as usize;
        if n != s && n != s + 1 {
            return Err(Error::Parse(format!(
                "TRX offsets has {n} entries for {s} streamlines; expected {s} or {}",
                s + 1
            )));
        }
        let at = |i: usize| -> u64 {
            if i < n {
                d.f64_at(&bytes[i * w..]) as u64
            } else {
                self.nb_vertices
            }
        };
        let mut ranges = Vec::with_capacity(self.kept_mask.len());
        let mut count: u32 = 0;
        for &source in &self.kept_mask {
            let (a, b) = (at(source as usize), at(source as usize + 1));
            if b < a || b > self.nb_vertices {
                return Err(Error::Parse(format!(
                    "TRX offsets are not monotonic at streamline {source}"
                )));
            }
            ranges.push((a, b - a));
            count = count
                .checked_add((b - a) as u32)
                .ok_or_else(|| Error::OutOfMemory("more than 2^32 kept points".into()))?;
            self.b.offsets.push(count);
            self.b.source_index.push(source);
        }
        self.kept_ranges = ranges;
        self.offsets_seen = true;
        Ok(())
    }

    fn read_group(&mut self, name: &str, d: Dtype, bytes: &[u8]) {
        let w = d.width();
        let mut held: Vec<u32> = bytes
            .chunks_exact(w)
            .filter_map(|b| {
                let source = d.f64_at(b) as u32;
                self.kept_mask.binary_search(&source).ok().map(|i| i as u32)
            })
            .collect();
        held.sort_unstable();
        held.dedup();
        let id = self.b.groups.len() as u32;
        self.b.groups.push(TractGroup {
            id,
            name: name.to_string(),
            streamlines: held,
            color: None,
        });
    }

    pub fn end_pass(&mut self) -> Result<bool> {
        if !self.saw_local {
            return Err(Error::Parse(
                "not a TRX file: empty or no zip entries".into(),
            ));
        }
        if matches!(
            self.stage,
            Stage::Entry { .. } | Stage::Local(_) | Stage::Resync
        ) {
            return Err(Error::Parse(
                "TRX zip ends inside an entry: truncated".into(),
            ));
        }
        self.pass += 1;
        let again = self.deferred > 0;
        if again && self.pass >= 3 {
            return Err(Error::Parse(
                "TRX has no offsets or header.json to resolve its arrays".into(),
            ));
        }
        if again {
            self.deferred = 0;
            self.stage = Stage::Signature;
            self.sig.clear();
            return Ok(true);
        }
        if self.keep.is_none() {
            return Err(Error::Parse("TRX has no header.json".into()));
        }
        if !self.offsets_seen {
            return Err(Error::Parse("TRX has no offsets array".into()));
        }
        if !self.positions_done {
            return Err(Error::Parse("TRX has no positions array".into()));
        }
        Ok(false)
    }

    pub fn finish(mut self) -> Result<Tractogram> {
        if !self.unread.is_empty() {
            let shown = self.unread.iter().take(5).cloned().collect::<Vec<_>>();
            let more = self.unread.len() - shown.len();
            let tail = if more > 0 {
                format!(" and {more} more")
            } else {
                String::new()
            };
            self.b
                .notes
                .push(format!("TRX entries not read: {}{tail}", shown.join(", ")));
        }
        Ok(self.b.finish())
    }
}
