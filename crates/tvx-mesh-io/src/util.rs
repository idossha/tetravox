//! Byte/text scanning helpers shared by the readers, plus the id → index map every
//! scatter-by-id path in §6.2 needs.

use byteorder::{BigEndian, ByteOrder, LittleEndian};
use std::collections::HashMap;
use tvx_core::{Error, Result};

pub fn parse_err(msg: impl Into<String>) -> Error {
    Error::Parse(msg.into())
}

pub fn unsupported(msg: impl Into<String>) -> Error {
    Error::Unsupported(msg.into())
}

/// A cursor over a byte slice that can read both the ascii and the binary halves of the
/// mixed-mode formats (`.msh`, `.ply`, `.stl`) without copying.
pub struct Reader<'a> {
    pub b: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Reader { b, pos: 0 }
    }

    pub fn eof(&self) -> bool {
        self.pos >= self.b.len()
    }

    pub fn remaining(&self) -> usize {
        self.b.len().saturating_sub(self.pos)
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.remaining() < n {
            return Err(parse_err(format!(
                "unexpected end of file: wanted {n} bytes at offset {}, {} left",
                self.pos,
                self.remaining()
            )));
        }
        let s = &self.b[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    /// The rest of the current line, without its `\n` or a trailing `\r`. Consumes the newline.
    pub fn line(&mut self) -> Result<&'a [u8]> {
        if self.eof() {
            return Err(parse_err("unexpected end of file: wanted a line"));
        }
        let start = self.pos;
        let end = match self.b[start..].iter().position(|c| *c == b'\n') {
            Some(i) => start + i,
            None => self.b.len(),
        };
        self.pos = (end + 1).min(self.b.len());
        let mut s = &self.b[start..end];
        if s.last() == Some(&b'\r') {
            s = &s[..s.len() - 1];
        }
        Ok(s)
    }

    /// The next non-blank line, trimmed. Blank lines are what separates a Gmsh binary blob from
    /// its `$End…` marker in Gmsh's own dialect but not in SimNIBS's (§6.2).
    pub fn nonblank_line(&mut self) -> Result<&'a [u8]> {
        loop {
            let l = trim(self.line()?);
            if !l.is_empty() {
                return Ok(l);
            }
        }
    }

    pub fn skip_ws(&mut self) {
        while let Some(c) = self.b.get(self.pos) {
            if matches!(c, b' ' | b'\t' | b'\r' | b'\n') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    /// The next whitespace-delimited token.
    pub fn token(&mut self) -> Result<&'a [u8]> {
        self.skip_ws();
        if self.eof() {
            return Err(parse_err("unexpected end of file: wanted a token"));
        }
        let start = self.pos;
        while let Some(c) = self.b.get(self.pos) {
            if matches!(c, b' ' | b'\t' | b'\r' | b'\n') {
                break;
            }
            self.pos += 1;
        }
        Ok(&self.b[start..self.pos])
    }

    pub fn u64_tok(&mut self) -> Result<u64> {
        let t = self.token()?;
        parse_u64(t)
    }

    pub fn i64_tok(&mut self) -> Result<i64> {
        let t = self.token()?;
        str_of(t)?
            .parse::<i64>()
            .map_err(|e| parse_err(format!("bad integer {:?}: {e}", str_of(t).unwrap_or("?"))))
    }

    pub fn i32_tok(&mut self) -> Result<i32> {
        let v = self.i64_tok()?;
        i32::try_from(v).map_err(|_| parse_err(format!("integer {v} does not fit i32")))
    }

    pub fn usize_tok(&mut self) -> Result<usize> {
        let v = self.u64_tok()?;
        usize::try_from(v).map_err(|_| parse_err(format!("count {v} does not fit usize")))
    }

    pub fn f64_tok(&mut self) -> Result<f64> {
        let t = self.token()?;
        parse_f64(t)
    }

    pub fn i32_le(&mut self) -> Result<i32> {
        Ok(LittleEndian::read_i32(self.take(4)?))
    }

    pub fn u64_le(&mut self) -> Result<u64> {
        Ok(LittleEndian::read_u64(self.take(8)?))
    }

    pub fn f64_le(&mut self) -> Result<f64> {
        Ok(LittleEndian::read_f64(self.take(8)?))
    }

    pub fn i32_be(&mut self) -> Result<i32> {
        Ok(BigEndian::read_i32(self.take(4)?))
    }

    pub fn f32_be(&mut self) -> Result<f32> {
        Ok(BigEndian::read_f32(self.take(4)?))
    }

    /// FreeSurfer's 3-byte big-endian integer (surface headers).
    pub fn u24_be(&mut self) -> Result<u32> {
        let b = self.take(3)?;
        Ok((b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32)
    }

    /// Move past the next occurrence of `needle` (and one optional trailing newline).
    pub fn skip_past(&mut self, needle: &[u8]) -> Result<()> {
        let at = find(&self.b[self.pos..], needle).ok_or_else(|| {
            parse_err(format!(
                "missing {:?}",
                std::str::from_utf8(needle).unwrap_or("?")
            ))
        })?;
        self.pos += at + needle.len();
        if self.b.get(self.pos) == Some(&b'\n') {
            self.pos += 1;
        }
        Ok(())
    }
}

pub fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        match hay[i..=hay.len() - needle.len()]
            .iter()
            .position(|c| *c == first)
        {
            Some(off) => {
                let at = i + off;
                if &hay[at..at + needle.len()] == needle {
                    return Some(at);
                }
                i = at + 1;
            }
            None => return None,
        }
    }
    None
}

pub fn trim(s: &[u8]) -> &[u8] {
    let mut a = 0;
    let mut b = s.len();
    while a < b && matches!(s[a], b' ' | b'\t' | b'\r' | b'\n') {
        a += 1;
    }
    while b > a && matches!(s[b - 1], b' ' | b'\t' | b'\r' | b'\n') {
        b -= 1;
    }
    &s[a..b]
}

pub fn str_of(s: &[u8]) -> Result<&str> {
    std::str::from_utf8(s).map_err(|e| parse_err(format!("not utf-8: {e}")))
}

pub fn parse_u64(t: &[u8]) -> Result<u64> {
    str_of(t)?.parse::<u64>().map_err(|e| {
        parse_err(format!(
            "bad unsigned integer {:?}: {e}",
            str_of(t).unwrap_or("?")
        ))
    })
}

pub fn parse_f64(t: &[u8]) -> Result<f64> {
    let s = str_of(t)?;
    s.parse::<f64>()
        .map_err(|e| parse_err(format!("bad float {s:?}: {e}")))
}

/// Strip one layer of `"` from a Gmsh string tag.
pub fn unquote(s: &[u8]) -> String {
    let t = trim(s);
    let t = if t.len() >= 2 && t[0] == b'"' && t[t.len() - 1] == b'"' {
        &t[1..t.len() - 1]
    } else {
        t
    };
    String::from_utf8_lossy(t).into_owned()
}

/// `file id → 0-based row`. Built once per file; §6.2's fast path is `Identity`, which every
/// reference `.msh` takes `[DATA]` and which costs no memory at all.
pub enum IdMap {
    /// `id == row + 1` for every row.
    Identity(usize),
    /// A dense table over `[min, max]`, `u32::MAX` where there is no row.
    Dense {
        min: u64,
        table: Vec<u32>,
    },
    Sparse(HashMap<u64, u32>),
}

impl IdMap {
    /// `ids[row]` is the file id of `row`. Chooses the cheapest representation that fits.
    pub fn build(ids: &[u64]) -> IdMap {
        if ids.iter().enumerate().all(|(i, id)| *id == i as u64 + 1) {
            return IdMap::Identity(ids.len());
        }
        let (min, max) = ids
            .iter()
            .fold((u64::MAX, 0u64), |(lo, hi), id| (lo.min(*id), hi.max(*id)));
        let span = max.saturating_sub(min).saturating_add(1);
        // A dense table is worth it while it stays within a small multiple of the payload.
        if span <= (ids.len() as u64).saturating_mul(4).saturating_add(4096)
            && span <= u32::MAX as u64
        {
            let mut table = vec![u32::MAX; span as usize];
            for (row, id) in ids.iter().enumerate() {
                table[(id - min) as usize] = row as u32;
            }
            IdMap::Dense { min, table }
        } else {
            IdMap::Sparse(
                ids.iter()
                    .enumerate()
                    .map(|(r, id)| (*id, r as u32))
                    .collect(),
            )
        }
    }

    #[inline]
    pub fn get(&self, id: u64) -> Option<u32> {
        match self {
            IdMap::Identity(n) => {
                if id >= 1 && id <= *n as u64 {
                    Some((id - 1) as u32)
                } else {
                    None
                }
            }
            IdMap::Dense { min, table } => {
                if id < *min {
                    return None;
                }
                match table.get((id - min) as usize) {
                    Some(&u32::MAX) | None => None,
                    Some(&r) => Some(r),
                }
            }
            IdMap::Sparse(m) => m.get(&id).copied(),
        }
    }

    pub fn is_identity(&self) -> bool {
        matches!(self, IdMap::Identity(_))
    }
}

/// Welds coincident vertices by their exact bit pattern. Used by the formats with no vertex table
/// (STL) — an exact-bits weld never merges two points the writer meant to keep apart.
#[derive(Default)]
pub struct VertexWelder {
    map: HashMap<[u32; 3], u32>,
    pub nodes: Vec<[f32; 3]>,
}

impl VertexWelder {
    pub fn insert(&mut self, v: [f32; 3]) -> u32 {
        let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
        match self.map.get(&key) {
            Some(&i) => i,
            None => {
                let i = self.nodes.len() as u32;
                self.map.insert(key, i);
                self.nodes.push(v);
                i
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_drop_carriage_returns_and_tokens_span_newlines() {
        let mut r = Reader::new(b"one\r\ntwo\n  3 4\n");
        assert_eq!(r.line().unwrap(), b"one");
        assert_eq!(r.line().unwrap(), b"two");
        assert_eq!(r.u64_tok().unwrap(), 3);
        assert_eq!(r.u64_tok().unwrap(), 4);
    }

    #[test]
    fn find_matches_the_whole_needle_not_just_its_first_byte() {
        assert_eq!(find(b"a$Endb$EndNodes", b"$EndNodes"), Some(6));
        assert_eq!(find(b"aaa", b"aab"), None);
        assert_eq!(find(b"", b"x"), None);
    }

    #[test]
    fn id_map_picks_identity_dense_and_sparse() {
        assert!(IdMap::build(&[1, 2, 3]).is_identity());
        let dense = IdMap::build(&[10, 13, 16]);
        assert!(matches!(dense, IdMap::Dense { .. }));
        assert_eq!(dense.get(13), Some(1));
        assert_eq!(dense.get(11), None);
        assert_eq!(dense.get(1), None);
        let sparse = IdMap::build(&[1, 1_000_000_000]);
        assert!(matches!(sparse, IdMap::Sparse(_)));
        assert_eq!(sparse.get(1_000_000_000), Some(1));
    }

    #[test]
    fn identity_map_rejects_out_of_range_ids() {
        let m = IdMap::build(&[1, 2, 3]);
        assert_eq!(m.get(0), None);
        assert_eq!(m.get(4), None);
        assert_eq!(m.get(3), Some(2));
    }

    #[test]
    fn welding_is_by_exact_bits() {
        let mut w = VertexWelder::default();
        assert_eq!(w.insert([1.0, 2.0, 3.0]), 0);
        assert_eq!(w.insert([1.0, 2.0, 3.0]), 0);
        assert_eq!(w.insert([1.0, 2.0, 3.000001]), 1);
        assert_eq!(w.nodes.len(), 2);
    }

    #[test]
    fn unquote_strips_one_layer() {
        assert_eq!(unquote(b"\"TI_max\""), "TI_max");
        assert_eq!(unquote(b" bare "), "bare");
    }
}
