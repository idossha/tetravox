//! TrackVis TRK: 1000-byte header, `voxmm` points. World is nibabel's `get_affine_trackvis_to_rasmm`.

use tvx_core::{Error, Result};

use crate::builder::Builder;
use crate::{Keep, LoadOptions, Tractogram};

const HEADER: usize = 1000;

enum Stage {
    Header(Vec<u8>),
    Count,
    Points(u64),
    Props,
}

pub(crate) struct TrkParser {
    total_len: u64,
    options: LoadOptions,
    stage: Stage,
    carry: Vec<u8>,
    big: bool,
    ns: usize,
    np: usize,
    m: [[f64; 4]; 3],
    keep: Option<Keep>,
    b: Builder,
    index: u64,
    kept: bool,
    declared: i64,
    done: bool,
}

/// `(name, components)` per nibabel's `decode_value_from_name`, with anything unclaimed anonymous.
fn value_names(slots: &[u8], total: usize, stem: &str) -> Vec<String> {
    let mut out = Vec::with_capacity(total);
    for slot in slots.chunks_exact(20).take(10) {
        if slot[0] == 0 {
            break;
        }
        let trimmed = {
            let end = slot.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
            &slot[..end]
        };
        let mut parts = trimmed.split(|b| *b == 0);
        let name = String::from_utf8_lossy(parts.next().unwrap_or(&[])).into_owned();
        let size = parts
            .next()
            .and_then(|s| std::str::from_utf8(s).ok()?.parse::<usize>().ok())
            .unwrap_or(1);
        if out.len() + size > total {
            break;
        }
        if size == 1 {
            out.push(name);
        } else {
            for i in 0..size {
                out.push(format!("{name}[{i}]"));
            }
        }
    }
    while out.len() < total {
        out.push(format!("{stem}_{}", out.len()));
    }
    out
}

/// `(output axis, sign)` per input axis, as nibabel's `io_orientation`.
fn orientation(m: &[[f64; 4]; 4]) -> [(usize, f64); 3] {
    let mut r = [[0.0f64; 3]; 3];
    for col in 0..3 {
        let n = (0..3)
            .map(|row| m[row][col] * m[row][col])
            .sum::<f64>()
            .sqrt();
        for row in 0..3 {
            r[row][col] = if n > 0.0 { m[row][col] / n } else { 0.0 };
        }
    }
    let mut out = [(0usize, 1.0f64); 3];
    for (col, slot) in out.iter_mut().enumerate() {
        let mut best = 0;
        for row in 1..3 {
            if r[row][col].abs() > r[best][col].abs() {
                best = row;
            }
        }
        *slot = (best, if r[best][col] < 0.0 { -1.0 } else { 1.0 });
        r[best] = [0.0; 3];
    }
    out
}

fn axcodes(order: &[u8; 3]) -> Option<[(usize, f64); 3]> {
    let mut out = [(0usize, 1.0f64); 3];
    for (i, c) in order.iter().enumerate() {
        out[i] = match c.to_ascii_uppercase() {
            b'R' => (0, 1.0),
            b'L' => (0, -1.0),
            b'A' => (1, 1.0),
            b'P' => (1, -1.0),
            b'S' => (2, 1.0),
            b'I' => (2, -1.0),
            _ => return None,
        };
    }
    Some(out)
}

fn mul(a: &[[f64; 4]; 4], b: &[[f64; 4]; 4]) -> [[f64; 4]; 4] {
    let mut o = [[0.0; 4]; 4];
    for (r, row) in o.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = (0..4).map(|k| a[r][k] * b[k][c]).sum();
        }
    }
    o
}

const I4: [[f64; 4]; 4] = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
];

impl TrkParser {
    pub fn new(total_len: u64, options: LoadOptions) -> Self {
        Self {
            total_len,
            options,
            stage: Stage::Header(Vec::with_capacity(HEADER)),
            carry: Vec::new(),
            big: false,
            ns: 0,
            np: 0,
            m: [[0.0; 4]; 3],
            keep: None,
            b: Builder::new(),
            index: 0,
            kept: false,
            declared: 0,
            done: false,
        }
    }

    fn i16_at(&self, h: &[u8], at: usize) -> i16 {
        let b = [h[at], h[at + 1]];
        if self.big {
            i16::from_be_bytes(b)
        } else {
            i16::from_le_bytes(b)
        }
    }
    fn i32_at(&self, h: &[u8], at: usize) -> i32 {
        let b: [u8; 4] = h[at..at + 4].try_into().expect("4 bytes");
        if self.big {
            i32::from_be_bytes(b)
        } else {
            i32::from_le_bytes(b)
        }
    }
    fn f32_at(&self, h: &[u8], at: usize) -> f32 {
        let b: [u8; 4] = h[at..at + 4].try_into().expect("4 bytes");
        if self.big {
            f32::from_be_bytes(b)
        } else {
            f32::from_le_bytes(b)
        }
    }

    fn header(&mut self, h: &[u8]) -> Result<()> {
        if &h[..5] != b"TRACK" {
            return Err(Error::Parse("not a TRK file: no TRACK magic".into()));
        }
        let le = i32::from_le_bytes(h[996..1000].try_into().expect("4 bytes"));
        let be = i32::from_be_bytes(h[996..1000].try_into().expect("4 bytes"));
        self.big = match (le, be) {
            (1000, _) => false,
            (_, 1000) => true,
            _ => return Err(Error::Parse(format!("TRK hdr_size is {le}, expected 1000"))),
        };
        let version = self.i32_at(h, 992);
        if !(1..=2).contains(&version) {
            return Err(Error::Unsupported(format!("TRK version {version}")));
        }
        let dims = [self.i16_at(h, 6), self.i16_at(h, 8), self.i16_at(h, 10)];
        let vox = [self.f32_at(h, 12), self.f32_at(h, 16), self.f32_at(h, 20)];
        self.ns = self.i16_at(h, 36).max(0) as usize;
        self.np = self.i16_at(h, 238).max(0) as usize;

        let mut v2r = [[0.0f64; 4]; 4];
        for (r, row) in v2r.iter_mut().enumerate() {
            for (c, cell) in row.iter_mut().enumerate() {
                *cell = f64::from(self.f32_at(h, 440 + (r * 4 + c) * 4));
            }
        }
        let placed =
            version == 2 && v2r[3][3] != 0.0 && v2r[..3].iter().flatten().any(|v| *v != 0.0);
        if !placed {
            return Err(Error::Parse(format!(
                "cannot place this TRK file: version {version} with no vox_to_ras, so its points have no world position"
            )));
        }
        if vox.iter().any(|v| !v.is_finite() || *v <= 0.0) {
            return Err(Error::Parse(format!(
                "TRK voxel_size {vox:?} is not positive"
            )));
        }

        let mut scale = I4;
        let mut half = I4;
        for c in 0..3 {
            scale[c][c] = 1.0 / f64::from(vox[c]);
            half[c][3] = -0.5;
        }
        let affine = mul(&half, &scale);

        let order: [u8; 3] = h[948..951].try_into().expect("3 bytes");
        let header_ornt = if order[0] == 0 {
            self.b
                .notes
                .push("TRK voxel_order is empty: assumed LPS, TrackVis's default".into());
            axcodes(b"LPS").expect("valid")
        } else {
            axcodes(&order).ok_or_else(|| {
                Error::Parse(format!(
                    "TRK voxel_order {:?} is not an axis code",
                    String::from_utf8_lossy(&order)
                ))
            })?
        };
        let affine_ornt = orientation(&v2r);
        // nibabel's `ornt_transform(header, affine)` then `inv_ornt_aff(..., dimensions)`.
        let mut transform = [(0usize, 1.0f64); 3];
        for (end_in, (end_out, end_flip)) in affine_ornt.iter().enumerate() {
            for (start_in, (start_out, start_flip)) in header_ornt.iter().enumerate() {
                if end_out == start_out {
                    let flip = if start_flip == end_flip { 1.0 } else { -1.0 };
                    transform[start_in] = (end_in, flip);
                    break;
                }
            }
        }
        let mut undo_reorder = [[0.0f64; 4]; 4];
        for (r, row) in undo_reorder.iter_mut().enumerate().take(3) {
            row[transform[r].0] = 1.0;
        }
        undo_reorder[3][3] = 1.0;
        let mut undo_flip = I4;
        for r in 0..3 {
            let flip = transform[r].1;
            undo_flip[r][r] = flip;
            let centre = -(f64::from(dims[r]) - 1.0) / 2.0;
            undo_flip[r][3] = flip * centre - centre;
        }
        let m = mul(&mul(&mul(&v2r, &undo_flip), &undo_reorder), &affine);
        self.m = [m[0], m[1], m[2]];

        let scalars = value_names(&h[38..238], self.ns, "scalar");
        let props = value_names(&h[240..440], self.np, "property");
        self.b.vertex_fields = scalars.into_iter().map(|n| (n, Vec::new())).collect();
        self.b.streamline_fields = props.into_iter().map(|n| (n, Vec::new())).collect();

        self.declared = i64::from(self.i32_at(h, 988));
        let body = self.total_len.saturating_sub(HEADER as u64);
        let per_point = 12 + 4 * self.ns as u64;
        let per_track = 4 + 4 * self.np as u64;
        let estimate = body.saturating_sub(self.declared.max(0) as u64 * per_track) / per_point;
        self.keep = Some(Keep::new(self.options, estimate));
        self.b.header_json = serde_json::json!({
            "version": version, "dimensions": dims, "voxel_size": vox,
            "voxel_order": String::from_utf8_lossy(&order).trim_end_matches('\0'),
            "vox_to_ras": v2r, "n_count": self.declared,
        })
        .to_string();
        Ok(())
    }

    fn f(&self, r: &[u8], i: usize) -> f32 {
        let b: [u8; 4] = r[i * 4..i * 4 + 4].try_into().expect("4 bytes");
        if self.big {
            f32::from_be_bytes(b)
        } else {
            f32::from_le_bytes(b)
        }
    }

    fn record_size(&self) -> usize {
        match self.stage {
            Stage::Header(_) => HEADER,
            Stage::Count => 4,
            Stage::Points(_) => 12 + 4 * self.ns,
            Stage::Props => 4 * self.np,
        }
    }

    fn record(&mut self, r: &[u8]) -> Result<()> {
        match self.stage {
            Stage::Header(_) => {
                self.header(r)?;
                self.stage = Stage::Count;
            }
            Stage::Count => {
                let b: [u8; 4] = r.try_into().expect("4 bytes");
                let n = if self.big {
                    i32::from_be_bytes(b)
                } else {
                    i32::from_le_bytes(b)
                };
                if n < 0 {
                    return Err(Error::Parse(format!("TRK streamline with {n} points")));
                }
                self.kept = self.keep.expect("set").keep(self.index);
                self.b.source_points += n as u64;
                self.stage = if n > 0 {
                    Stage::Points(n as u64)
                } else if self.np > 0 {
                    Stage::Props
                } else {
                    self.close();
                    Stage::Count
                };
            }
            Stage::Points(left) => {
                if self.kept {
                    let v = [self.f(r, 0), self.f(r, 1), self.f(r, 2)].map(f64::from);
                    for row in &self.m {
                        let w = row[0] * v[0] + row[1] * v[1] + row[2] * v[2] + row[3];
                        self.b.positions.push(w as f32);
                    }
                    for s in 0..self.ns {
                        let value = self.f(r, 3 + s);
                        self.b.vertex_fields[s].1.push(value);
                    }
                }
                self.stage = if left > 1 {
                    Stage::Points(left - 1)
                } else if self.np > 0 {
                    Stage::Props
                } else {
                    self.close();
                    Stage::Count
                };
            }
            Stage::Props => {
                if self.kept {
                    for p in 0..self.np {
                        let value = self.f(r, p);
                        self.b.streamline_fields[p].1.push(value);
                    }
                }
                self.close();
                self.stage = Stage::Count;
            }
        }
        Ok(())
    }

    fn close(&mut self) {
        if self.kept {
            self.b.close_kept(self.index);
        }
        self.index += 1;
        self.b.source_streamlines += 1;
    }

    pub fn push(&mut self, mut chunk: &[u8]) -> Result<()> {
        if let Stage::Header(buf) = &mut self.stage {
            let take = (HEADER - buf.len()).min(chunk.len());
            buf.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if buf.len() < HEADER {
                return Ok(());
            }
            let h = std::mem::take(buf);
            self.record(&h)?;
        }
        while !chunk.is_empty() {
            let size = self.record_size();
            if !self.carry.is_empty() || chunk.len() < size {
                let take = (size - self.carry.len()).min(chunk.len());
                self.carry.extend_from_slice(&chunk[..take]);
                chunk = &chunk[take..];
                if self.carry.len() == size {
                    let r = std::mem::take(&mut self.carry);
                    self.record(&r)?;
                }
            } else {
                let (r, rest) = chunk.split_at(size);
                self.record(r)?;
                chunk = rest;
            }
        }
        Ok(())
    }

    pub fn end(&mut self) -> Result<()> {
        if self.done {
            return Ok(());
        }
        self.done = true;
        if matches!(self.stage, Stage::Header(_)) {
            return Err(Error::Parse(
                "TRK file is shorter than its 1000-byte header".into(),
            ));
        }
        let partial = !matches!(self.stage, Stage::Count) || !self.carry.is_empty();
        if partial {
            let last = *self.b.offsets.last().expect("starts with 0") as usize;
            self.b.positions.truncate(last * 3);
            let s = self.b.source_index.len();
            for (_, v) in &mut self.b.vertex_fields {
                v.truncate(last);
            }
            for (_, v) in &mut self.b.streamline_fields {
                v.truncate(s);
            }
            self.b.notes.push(format!(
                "TRK ends inside a streamline: kept the {} complete ones",
                self.b.source_streamlines
            ));
        } else if self.declared > 0 && self.declared as u64 != self.b.source_streamlines {
            self.b.notes.push(format!(
                "TRK header declares {} streamlines; the file holds {}",
                self.declared, self.b.source_streamlines
            ));
        }
        Ok(())
    }

    pub fn finish(self) -> Result<Tractogram> {
        Ok(self.b.finish())
    }
}
