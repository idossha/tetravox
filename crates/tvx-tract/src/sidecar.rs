//! Per-point and per-streamline data kept beside a tractogram rather than in it (§6.3.1): MRtrix `.tsf`,
//! and text tables such as `tcksift2` weights or `tck2connectome -out_assignments`. Both are read
//! forward, because a `.tsf` can be larger than the budgeted tractogram it belongs to.

use std::collections::VecDeque;

use tvx_core::{Error, Result};

use crate::builder::is_categorical;
use crate::{make_field, TractField, Tractogram};

const MAX_HEADER: usize = 1 << 24;
/// A row wider than this is not per-streamline columns, it is a row of something else.
const MAX_COLUMNS: usize = 64;

/// Does this name attach to a tractogram, and how. `.txt`, `.csv` and `.tsv` are too generic to claim
/// from File ▸ Open, so only the panel's Attach file… reads them.
pub fn is_tract_sidecar_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".tsf") || n.ends_with(".txt") || n.ends_with(".csv") || n.ends_with(".tsv")
}

pub struct Attached {
    /// True when `fields` hold one value per point.
    pub per_point: bool,
    pub fields: Vec<TractField>,
    pub notes: Vec<String>,
}

fn stem_of(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base.rsplit_once('.').map_or(base, |(s, _)| s).to_string()
}

enum TsfStage {
    Header(Vec<u8>),
    Skip(u64),
    Body,
    Done,
}

struct Tsf {
    stage: TsfStage,
    big: bool,
    double: bool,
    carry: Vec<u8>,
    timestamp: Option<String>,
    /// Non-empty streamlines finished, which is the index a tractogram gives them.
    index: u64,
    open: u64,
    points: u64,
    empty: u64,
    cursor: usize,
    values: Vec<f32>,
    /// A scan's lockstep read: points not yet delivered go in `values`, and lengths of streamlines
    /// that finished but are not yet delivered here, rather than being placed through `source_index`.
    lockstep: Option<VecDeque<u32>>,
}

struct Table {
    token: Vec<u8>,
    comment: bool,
    /// Tokens of the current row while it could still be a header.
    first: Vec<String>,
    names: Option<Vec<String>>,
    values: Vec<f32>,
    rows: u64,
    width: Option<usize>,
    in_row: usize,
    uneven: bool,
}

enum Kind {
    Tsf(Box<Tsf>),
    Table(Box<Table>),
}

pub struct SidecarLoader {
    name: String,
    kind: Kind,
}

impl SidecarLoader {
    pub fn new(name: &str, t: &Tractogram) -> Result<Self> {
        if !is_tract_sidecar_name(name) {
            return Err(Error::Unsupported(format!(
                "{name} is not a track scalar file or a text table"
            )));
        }
        let kind = if name.to_ascii_lowercase().ends_with(".tsf") {
            Kind::Tsf(Box::new(Tsf {
                stage: TsfStage::Header(Vec::new()),
                big: false,
                double: false,
                carry: Vec::new(),
                timestamp: None,
                index: 0,
                open: 0,
                points: 0,
                empty: 0,
                cursor: 0,
                values: vec![f32::NAN; t.n_points()],
                lockstep: None,
            }))
        } else {
            Kind::Table(Box::new(Table {
                token: Vec::new(),
                comment: false,
                first: Vec::new(),
                names: None,
                values: Vec::new(),
                rows: 0,
                width: None,
                in_row: 0,
                uneven: false,
            }))
        };
        Ok(Self {
            name: name.to_string(),
            kind,
        })
    }

    pub fn push(&mut self, t: &Tractogram, chunk: &[u8]) -> Result<()> {
        match &mut self.kind {
            Kind::Tsf(p) => p.push(&self.name, t, chunk),
            Kind::Table(p) => p.push(&self.name, chunk),
        }
    }

    pub fn finish(self, t: &Tractogram) -> Result<Attached> {
        match self.kind {
            Kind::Tsf(p) => p.finish(&self.name, t),
            Kind::Table(p) => p.finish(&self.name, t),
        }
    }

    /// For a scan: a `.tsf` is read in step with the tractogram, retaining nothing delivered.
    pub(crate) fn for_scan(name: &str, t: &Tractogram) -> Result<Self> {
        let mut loader = Self::new(name, t)?;
        if let Kind::Tsf(p) = &mut loader.kind {
            p.values = Vec::new();
            p.lockstep = Some(VecDeque::new());
        }
        Ok(loader)
    }

    pub(crate) fn is_lockstep(&self) -> bool {
        matches!(self.kind, Kind::Tsf(_))
    }

    /// The field a lockstep `.tsf` delivers.
    pub(crate) fn field_name(&self) -> String {
        stem_of(&self.name)
    }

    /// Can a `.tsf` still finish fewer than `streamlines` non-empty streamlines?
    pub(crate) fn lockstep_short(&self, streamlines: usize) -> bool {
        match &self.kind {
            Kind::Tsf(p) => {
                !matches!(p.stage, TsfStage::Done)
                    && p.lockstep.as_ref().map_or(0, VecDeque::len) < streamlines
            }
            Kind::Table(_) => false,
        }
    }

    /// The next streamlines' values, each length checked the way a load checks it.
    pub(crate) fn lockstep_take(&mut self, first_source: u64, lengths: &[u32]) -> Result<Vec<f32>> {
        let Kind::Tsf(p) = &mut self.kind else {
            return Err(Error::Parse(format!("{} is not per-point", self.name)));
        };
        let queue = p.lockstep.as_mut().expect("for_scan");
        let mut points = 0usize;
        for (i, want) in lengths.iter().enumerate().filter(|(_, n)| **n > 0) {
            let source = first_source + i as u64;
            let Some(got) = queue.pop_front() else {
                return Err(Error::Parse(format!(
                    "{} ends before streamline {source}: it was not made from this tractogram",
                    self.name
                )));
            };
            if got != *want {
                return Err(Error::Parse(format!(
                    "{} has {got} values for streamline {source}, which has {want} points: it was not made from this tractogram",
                    self.name
                )));
            }
            points += got as usize;
        }
        Ok(p.values.drain(..points).collect())
    }

    /// A scan's end: nothing may be left over, and nothing may be cut short.
    pub(crate) fn lockstep_finish(&self) -> Result<()> {
        if let Kind::Tsf(p) = &self.kind {
            if p.open > 0 || p.lockstep.as_ref().is_some_and(|q| !q.is_empty()) {
                return Err(Error::Parse(format!(
                    "{} holds more values than this tractogram has points: it was not made from this tractogram",
                    self.name
                )));
            }
        }
        Ok(())
    }

    /// A table's columns over every streamline in the file, not only the held ones.
    pub(crate) fn finish_whole(self, t: &Tractogram) -> Result<Vec<(String, Vec<f32>)>> {
        match self.kind {
            Kind::Table(p) => p.finish_whole(&self.name, t),
            Kind::Tsf(_) => Ok(Vec::new()),
        }
    }
}

impl Tsf {
    fn header(&mut self, name: &str, buf: &[u8]) -> Result<u64> {
        let text = String::from_utf8_lossy(buf);
        let mut lines = text.lines();
        if lines.next().map(str::trim_end) != Some("mrtrix track scalars") {
            return Err(Error::Parse(format!(
                "{name} is not a track scalar file: no `mrtrix track scalars` magic"
            )));
        }
        let mut offset = None;
        let mut datatype = None;
        for line in lines {
            let Some((k, v)) = line.split_once(':') else {
                continue;
            };
            let (k, v) = (k.trim(), v.trim());
            match k {
                "datatype" => datatype = Some(v.to_string()),
                "timestamp" => self.timestamp = Some(v.to_string()),
                "file" => {
                    let mut it = v.split_whitespace();
                    if it.next() != Some(".") {
                        return Err(Error::Unsupported(format!(
                            "{name} keeps its data in a separate file (`file: {v}`)"
                        )));
                    }
                    offset = it.next().and_then(|o| o.parse::<u64>().ok());
                }
                _ => {}
            }
        }
        (self.double, self.big) = match datatype.as_deref() {
            Some("Float32LE") => (false, false),
            Some("Float32BE") => (false, true),
            Some("Float64LE") => (true, false),
            Some("Float64BE") => (true, true),
            other => {
                return Err(Error::Unsupported(format!(
                    "{name} has datatype {}",
                    other.unwrap_or("(none)")
                )))
            }
        };
        offset.ok_or_else(|| Error::Parse(format!("{name} has no `file: . <offset>`")))
    }

    fn close(&mut self, name: &str, t: &Tractogram) -> Result<()> {
        if self.open == 0 {
            self.empty += 1;
            return Ok(());
        }
        if let Some(queue) = &mut self.lockstep {
            queue.push_back(self.open as u32);
            self.index += 1;
            self.open = 0;
            return Ok(());
        }
        if t.source_index.get(self.cursor).map(|i| u64::from(*i)) == Some(self.index) {
            let (a, b) = (t.offsets[self.cursor], t.offsets[self.cursor + 1]);
            if u64::from(b - a) != self.open {
                return Err(Error::Parse(format!(
                    "{name} has {} values for streamline {}, which has {} points: it was not made from this tractogram",
                    self.open,
                    self.index,
                    b - a
                )));
            }
            self.cursor += 1;
        }
        self.index += 1;
        self.open = 0;
        Ok(())
    }

    fn value(&mut self, name: &str, t: &Tractogram, v: f64) -> Result<()> {
        if v.is_nan() {
            return self.close(name, t);
        }
        if v.is_infinite() {
            if self.open > 0 {
                self.close(name, t)?;
            }
            self.stage = TsfStage::Done;
            return Ok(());
        }
        if self.lockstep.is_some() {
            self.values.push(v as f32);
            self.open += 1;
            self.points += 1;
            return Ok(());
        }
        if t.source_index.get(self.cursor).map(|i| u64::from(*i)) == Some(self.index) {
            let at = u64::from(t.offsets[self.cursor]) + self.open;
            match self.values.get_mut(at as usize) {
                Some(slot) if at < u64::from(t.offsets[self.cursor + 1]) => *slot = v as f32,
                _ => {
                    return Err(Error::Parse(format!(
                        "{name} has more values for streamline {} than it has points: it was not made from this tractogram",
                        self.index
                    )))
                }
            }
        }
        self.open += 1;
        self.points += 1;
        Ok(())
    }

    fn body(&mut self, name: &str, t: &Tractogram, mut chunk: &[u8]) -> Result<()> {
        let width = if self.double { 8 } else { 4 };
        if !self.carry.is_empty() {
            let take = (width - self.carry.len()).min(chunk.len());
            self.carry.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if self.carry.len() < width {
                return Ok(());
            }
            let rec = std::mem::take(&mut self.carry);
            let v = self.decode(&rec);
            self.value(name, t, v)?;
        }
        let mut it = chunk.chunks_exact(width);
        for rec in it.by_ref() {
            if matches!(self.stage, TsfStage::Done) {
                return Ok(());
            }
            let v = self.decode(rec);
            self.value(name, t, v)?;
        }
        if !matches!(self.stage, TsfStage::Done) {
            self.carry.extend_from_slice(it.remainder());
        }
        Ok(())
    }

    #[inline]
    fn decode(&self, r: &[u8]) -> f64 {
        if self.double {
            let b: [u8; 8] = r[..8].try_into().expect("8 bytes");
            if self.big {
                f64::from_be_bytes(b)
            } else {
                f64::from_le_bytes(b)
            }
        } else {
            let b: [u8; 4] = r[..4].try_into().expect("4 bytes");
            f64::from(if self.big {
                f32::from_be_bytes(b)
            } else {
                f32::from_le_bytes(b)
            })
        }
    }

    fn push(&mut self, name: &str, t: &Tractogram, mut chunk: &[u8]) -> Result<()> {
        loop {
            match &mut self.stage {
                TsfStage::Done => return Ok(()),
                TsfStage::Header(buf) => {
                    let before = buf.len();
                    buf.extend_from_slice(chunk);
                    if buf.len() > MAX_HEADER {
                        return Err(Error::Parse(format!("{name}: header exceeds 16 MiB")));
                    }
                    let Some(end) = buf.windows(5).position(|w| w == b"\nEND\n").map(|e| e + 1)
                    else {
                        return Ok(());
                    };
                    let header = std::mem::take(buf);
                    let offset = self.header(name, &header[..end])?;
                    let have = before + chunk.len();
                    if (have as u64) >= offset {
                        chunk = &chunk[(offset as usize).saturating_sub(before)..];
                        self.stage = TsfStage::Body;
                    } else {
                        self.stage = TsfStage::Skip(offset - have as u64);
                        return Ok(());
                    }
                }
                TsfStage::Skip(left) => {
                    let take = (*left).min(chunk.len() as u64);
                    *left -= take;
                    chunk = &chunk[take as usize..];
                    if *left > 0 {
                        return Ok(());
                    }
                    self.stage = TsfStage::Body;
                }
                TsfStage::Body => return self.body(name, t, chunk),
            }
        }
    }

    fn finish(self, name: &str, t: &Tractogram) -> Result<Attached> {
        if self.open > 0 {
            return Err(Error::Parse(format!(
                "{name} ends inside streamline {}: truncated",
                self.index
            )));
        }
        if self.index != t.source_streamlines || self.points != t.source_points {
            return Err(Error::Parse(format!(
                "{name} holds {} streamlines and {} points; this tractogram holds {} and {}",
                self.index, self.points, t.source_streamlines, t.source_points
            )));
        }
        let mut notes = Vec::new();
        let tract_stamp = serde_json::from_str::<Vec<(String, String)>>(&t.header_json)
            .ok()
            .and_then(|h| {
                h.into_iter()
                    .find(|(k, _)| k == "timestamp")
                    .map(|(_, v)| v)
            });
        if let (Some(a), Some(b)) = (&self.timestamp, &tract_stamp) {
            if a != b {
                notes.push(format!(
                    "{name} has a different timestamp from this tractogram, though every streamline's length matches"
                ));
            }
        }
        Ok(Attached {
            per_point: true,
            fields: vec![make_field(stem_of(name), self.values, None)],
            notes,
        })
    }
}

impl Table {
    fn token(&mut self, name: &str) -> Result<()> {
        if self.token.is_empty() {
            return Ok(());
        }
        let text = std::str::from_utf8(&self.token).unwrap_or("");
        let parsed = text.parse::<f32>().ok();
        let in_first_row = self.rows == 0 && self.names.is_none();
        if in_first_row {
            self.first.push(text.to_string());
        } else {
            let v = parsed.ok_or_else(|| {
                Error::Parse(format!(
                    "{name} has `{text}` on data row {}, which is not a number",
                    self.rows + 1
                ))
            })?;
            self.values.push(v);
        }
        self.in_row += 1;
        self.token.clear();
        Ok(())
    }

    fn end_row(&mut self, name: &str) -> Result<()> {
        self.token(name)?;
        if self.in_row == 0 {
            return Ok(());
        }
        if self.rows == 0 && self.names.is_none() {
            let numbers: Option<Vec<f32>> =
                self.first.iter().map(|s| s.parse::<f32>().ok()).collect();
            match numbers {
                Some(v) => self.values.extend(v),
                None => {
                    self.names = Some(std::mem::take(&mut self.first));
                    self.in_row = 0;
                    return Ok(());
                }
            }
            self.first.clear();
        }
        match self.width {
            None => self.width = Some(self.in_row),
            Some(w) if w != self.in_row => self.uneven = true,
            _ => {}
        }
        self.rows += 1;
        self.in_row = 0;
        Ok(())
    }

    fn push(&mut self, name: &str, chunk: &[u8]) -> Result<()> {
        for &b in chunk {
            if self.comment {
                self.comment = b != b'\n';
                continue;
            }
            match b {
                b'\n' => self.end_row(name)?,
                b'#' if self.token.is_empty() && self.in_row == 0 => self.comment = true,
                b' ' | b'\t' | b',' | b'\r' | b';' => self.token(name)?,
                _ => self.token.push(b),
            }
        }
        Ok(())
    }

    /// `(columns, one value per row)`, refusing a shape that does not fit `s` streamlines.
    fn shape(&mut self, name: &str, s: u64) -> Result<(usize, bool)> {
        self.end_row(name)?;
        if self.uneven {
            return Err(Error::Parse(format!(
                "{name} has rows of different lengths; per-point values belong in a .tsf (MRtrix: `tcksample out.tsf`)"
            )));
        }
        let width = self.width.unwrap_or(0) as u64;
        let columns = if self.rows == 1 && width == s {
            1
        } else if self.rows == s && (1..=MAX_COLUMNS as u64).contains(&width) {
            width as usize
        } else {
            return Err(Error::Parse(format!(
                "{name} has {} rows of {width}; a tractogram of {s} streamlines needs one value or one row per streamline",
                self.rows
            )));
        };
        Ok((columns, self.rows == s))
    }

    fn label(&self, name: &str, columns: usize, c: usize) -> String {
        let stem = stem_of(name);
        match self.names.as_ref().filter(|n| n.len() == columns) {
            Some(n) => n[c].clone(),
            None if columns == 1 => stem,
            None => format!("{stem}[{c}]"),
        }
    }

    fn finish_whole(mut self, name: &str, t: &Tractogram) -> Result<Vec<(String, Vec<f32>)>> {
        let s = t.source_streamlines as usize;
        let (columns, by_row) = self.shape(name, t.source_streamlines)?;
        if !by_row {
            return Ok(vec![(self.label(name, 1, 0), self.values)]);
        }
        Ok((0..columns)
            .map(|c| {
                let values = (0..s).map(|i| self.values[i * columns + c]).collect();
                (self.label(name, columns, c), values)
            })
            .collect())
    }

    fn finish(mut self, name: &str, t: &Tractogram) -> Result<Attached> {
        let (columns, by_row) = self.shape(name, t.source_streamlines)?;
        let held = t.n_streamlines();
        let fields = (0..columns)
            .map(|c| {
                let label = self.label(name, columns, c);
                let mut out = Vec::with_capacity(held);
                for i in &t.source_index {
                    let i = *i as usize;
                    out.push(self.values[if by_row { i * columns + c } else { i }]);
                }
                let mut f = make_field(label, out, None);
                f.categorical = is_categorical(&f.values);
                f
            })
            .collect();
        Ok(Attached {
            per_point: false,
            fields,
            notes: Vec::new(),
        })
    }
}

/// Put an attached file's fields on the tractogram, replacing any of the same name.
pub fn apply_attached(t: &mut Tractogram, a: Attached) {
    let list = if a.per_point {
        &mut t.vertex_fields
    } else {
        &mut t.streamline_fields
    };
    for f in a.fields {
        list.retain(|x| x.name != f.name);
        list.push(f);
    }
    for n in a.notes {
        if !t.notes.contains(&n) {
            t.notes.push(n);
        }
    }
}

/// A caller's per-streamline values (one per held streamline), replacing any field of that name.
pub fn set_streamline_field<'a>(
    t: &'a mut Tractogram,
    name: &str,
    values: Vec<f32>,
    units: Option<String>,
) -> Result<&'a TractField> {
    if values.len() != t.n_streamlines() {
        return Err(Error::Parse(format!(
            "{} values for a tractogram holding {} streamlines",
            values.len(),
            t.n_streamlines()
        )));
    }
    let mut f = make_field(name.to_string(), values, units);
    f.categorical = is_categorical(&f.values);
    t.streamline_fields.retain(|x| x.name != name);
    t.streamline_fields.push(f);
    Ok(t.streamline_fields.last().expect("just pushed"))
}

/// Removes a field by name; a built-in stays, because a file's own arrays do not depend on a caller.
pub fn remove_field(t: &mut Tractogram, per_streamline: bool, name: &str) {
    let list = if per_streamline {
        &mut t.streamline_fields
    } else {
        &mut t.vertex_fields
    };
    list.retain(|f| f.name != name || f.builtin);
}

/// A bounded read of one field.
pub fn field_values<'a>(
    t: &'a Tractogram,
    per_streamline: bool,
    name: &str,
    first: usize,
    count: usize,
) -> Result<&'a [f32]> {
    let list = if per_streamline {
        &t.streamline_fields
    } else {
        &t.vertex_fields
    };
    let f = list
        .iter()
        .find(|f| f.name == name)
        .ok_or_else(|| Error::Parse(format!("this tractogram has no field {name}")))?;
    f.values.get(first..first + count).ok_or_else(|| {
        Error::Parse(format!(
            "{name} holds {} values; asked for {first}..{}",
            f.values.len(),
            first + count
        ))
    })
}
