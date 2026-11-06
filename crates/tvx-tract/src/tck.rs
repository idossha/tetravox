//! MRtrix TCK: `key: value` header to `END`, float triplets, NaN between streamlines, inf at the end.

use tvx_core::{Error, Result};

use crate::builder::Builder;
use crate::{Keep, LoadOptions, Tractogram};

const MAX_HEADER: usize = 1 << 24;

enum Stage {
    Header(Vec<u8>),
    Skip(u64),
    Body,
    Done,
}

pub(crate) struct TckParser {
    total_len: u64,
    options: LoadOptions,
    stage: Stage,
    big: bool,
    double: bool,
    carry: Vec<u8>,
    keep: Option<Keep>,
    pub(crate) b: Builder,
    index: u64,
    open_points: u64,
    terminated: bool,
    declared: Option<u64>,
    empty: u64,
}

impl TckParser {
    pub fn new(total_len: u64, options: LoadOptions) -> Self {
        Self {
            total_len,
            options,
            stage: Stage::Header(Vec::new()),
            big: false,
            double: false,
            carry: Vec::new(),
            keep: None,
            b: Builder::new(),
            index: 0,
            open_points: 0,
            terminated: false,
            declared: None,
            empty: 0,
        }
    }

    fn header(&mut self, text: &[u8], end: usize) -> Result<u64> {
        let text = String::from_utf8_lossy(&text[..end]).into_owned();
        let mut lines = text.lines();
        if lines.next().map(str::trim_end) != Some("mrtrix tracks") {
            return Err(Error::Parse(
                "not a TCK file: no `mrtrix tracks` magic".into(),
            ));
        }
        let mut offset = None;
        let mut datatype = None;
        let mut kept: Vec<serde_json::Value> = Vec::new();
        for line in lines {
            let Some((k, v)) = line.split_once(':') else {
                continue;
            };
            let (k, v) = (k.trim(), v.trim());
            match k {
                "datatype" => datatype = Some(v.to_string()),
                "count" => self.declared = v.parse().ok(),
                "file" => {
                    let mut it = v.split_whitespace();
                    if it.next() != Some(".") {
                        return Err(Error::Unsupported(format!(
                            "TCK data in a separate file (`file: {v}`)"
                        )));
                    }
                    offset = it.next().and_then(|o| o.parse::<u64>().ok());
                }
                _ => {}
            }
            kept.push(serde_json::json!([k, v]));
        }
        let dt = datatype.ok_or_else(|| Error::Parse("TCK header has no `datatype`".into()))?;
        (self.double, self.big) = match dt.as_str() {
            "Float32LE" => (false, false),
            "Float32BE" => (false, true),
            "Float64LE" => (true, false),
            "Float64BE" => (true, true),
            other => {
                return Err(Error::Unsupported(format!("TCK datatype {other}")));
            }
        };
        let offset =
            offset.ok_or_else(|| Error::Parse("TCK header has no `file: . <offset>`".into()))?;
        self.b.header_json = serde_json::Value::Array(kept).to_string();
        let width = if self.double { 24 } else { 12 };
        let estimate = self.total_len.saturating_sub(offset) / width;
        self.keep = Some(Keep::new(self.options, estimate));
        Ok(offset)
    }

    fn triplet(&mut self, x: f64, y: f64, z: f64) {
        if x.is_nan() {
            self.empty += u64::from(self.open_points == 0);
            self.close();
        } else if x.is_infinite() {
            self.close();
            self.terminated = true;
            self.stage = Stage::Done;
        } else {
            let keep = self.keep.expect("set before the body");
            if keep.keep(self.index) {
                self.b
                    .positions
                    .extend_from_slice(&[x as f32, y as f32, z as f32]);
            }
            self.open_points += 1;
        }
    }

    fn close(&mut self) {
        if self.open_points == 0 {
            return;
        }
        let keep = self.keep.expect("set before the body");
        if keep.keep(self.index) {
            self.b.close_kept(self.index);
        }
        self.index += 1;
        self.b.source_points += self.open_points;
        self.b.source_streamlines += 1;
        self.open_points = 0;
    }

    fn body(&mut self, mut chunk: &[u8]) {
        let width = if self.double { 24 } else { 12 };
        if !self.carry.is_empty() {
            let need = width - self.carry.len();
            let take = need.min(chunk.len());
            self.carry.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if self.carry.len() < width {
                return;
            }
            let rec = std::mem::take(&mut self.carry);
            self.record(&rec);
        }
        let mut it = chunk.chunks_exact(width);
        for rec in it.by_ref() {
            if matches!(self.stage, Stage::Done) {
                return;
            }
            self.record(rec);
        }
        if !matches!(self.stage, Stage::Done) {
            self.carry.extend_from_slice(it.remainder());
        }
    }

    #[inline]
    fn record(&mut self, r: &[u8]) {
        let v = |i: usize| -> f64 {
            if self.double {
                let b: [u8; 8] = r[i * 8..i * 8 + 8].try_into().expect("8 bytes");
                if self.big {
                    f64::from_be_bytes(b)
                } else {
                    f64::from_le_bytes(b)
                }
            } else {
                let b: [u8; 4] = r[i * 4..i * 4 + 4].try_into().expect("4 bytes");
                f64::from(if self.big {
                    f32::from_be_bytes(b)
                } else {
                    f32::from_le_bytes(b)
                })
            }
        };
        let (x, y, z) = (v(0), v(1), v(2));
        self.triplet(x, y, z);
    }

    pub fn push(&mut self, mut chunk: &[u8]) -> Result<()> {
        loop {
            match &mut self.stage {
                Stage::Done => return Ok(()),
                Stage::Header(buf) => {
                    let before = buf.len();
                    buf.extend_from_slice(chunk);
                    if buf.len() > MAX_HEADER {
                        return Err(Error::Parse("TCK header exceeds 16 MiB".into()));
                    }
                    let Some(at) = find_end(buf) else {
                        return Ok(());
                    };
                    let buf = std::mem::take(buf);
                    let offset = self.header(&buf, at)?;
                    let consumed_here = (offset as usize).saturating_sub(before);
                    if consumed_here <= chunk.len() {
                        chunk = &chunk[consumed_here..];
                        self.stage = Stage::Body;
                    } else {
                        self.stage = Stage::Skip((consumed_here - chunk.len()) as u64);
                        return Ok(());
                    }
                }
                Stage::Skip(n) => {
                    if (chunk.len() as u64) < *n {
                        *n -= chunk.len() as u64;
                        return Ok(());
                    }
                    chunk = &chunk[*n as usize..];
                    self.stage = Stage::Body;
                }
                Stage::Body => {
                    self.body(chunk);
                    return Ok(());
                }
            }
        }
    }

    pub fn end(&mut self) -> Result<()> {
        if let Stage::Header(_) | Stage::Skip(_) = self.stage {
            return Err(Error::Parse("TCK file ends before its data".into()));
        }
        if !self.terminated {
            if self.open_points > 0 {
                // A streamline with no separator is not known to be complete: roll it back.
                let keep = self.keep.expect("set before the body");
                if keep.keep(self.index) {
                    let last = *self.b.offsets.last().expect("starts with 0") as usize;
                    self.b.positions.truncate(last * 3);
                }
                self.open_points = 0;
            }
            self.b.notes.push(format!(
                "TCK has no end marker: truncated? kept the {} complete streamlines",
                self.b.source_streamlines
            ));
        }
        if self.empty > 0 {
            self.b.notes.push(format!(
                "TCK has {} empty streamlines, which are dropped; indices here count the others",
                self.empty
            ));
        }
        let found = self.b.source_streamlines;
        if let Some(count) = self
            .declared
            .filter(|c| *c != found && *c != found + self.empty)
        {
            self.b.notes.push(format!(
                "TCK header says count {count}; the file holds {found} streamlines, which is what is shown"
            ));
        }
        Ok(())
    }

    pub fn finish(self) -> Result<Tractogram> {
        Ok(self.b.finish())
    }
}

fn find_end(buf: &[u8]) -> Option<usize> {
    buf.windows(5)
        .position(|w| w == b"\nEND\n" || w == b"\nEND\r")
        .map(|i| i + 5)
}
