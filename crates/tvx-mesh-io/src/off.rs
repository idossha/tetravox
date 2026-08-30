//! Object File Format (§6.2): `OFF` / `NOFF` / `COFF` / `4OFF` / `nOFF` and their combinations,
//! counts on the header line or the next, `#` comments, n-gon faces fanned with a `tri_edge_mask`.

use tvx_core::Result;

use crate::cells::Assembly;
use crate::util::{parse_err, str_of, unsupported};
use crate::Mesh;

/// `[ST][C][N][4][n]OFF` — the header keyword with its optional flag prefixes.
fn header_flags(word: &str) -> Option<(bool, bool)> {
    let mut s = word;
    if !s.ends_with("OFF") {
        return None;
    }
    s = &s[..s.len() - 3];
    let st = s.starts_with("ST");
    if st {
        s = &s[2..];
    }
    let c = s.starts_with('C');
    if c {
        s = &s[1..];
    }
    let n = s.starts_with('N');
    if n {
        s = &s[1..];
    }
    let four = s.starts_with('4');
    if four {
        s = &s[1..];
    }
    let ndim = s.starts_with('n');
    if ndim {
        s = &s[1..];
    }
    s.is_empty().then_some((four, ndim))
}

fn first_word(bytes: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(&bytes[..bytes.len().min(512)]).ok()?;
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .and_then(|l| l.split_whitespace().next())
}

pub fn looks_like(bytes: &[u8]) -> bool {
    first_word(bytes).is_some_and(|w| header_flags(w).is_some())
}

pub fn read(bytes: &[u8]) -> Result<Mesh> {
    let text = str_of(bytes)?;
    let mut lines = text
        .lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| !l.is_empty());
    let head = lines.next().ok_or_else(|| parse_err("empty OFF file"))?;
    let mut words = head.split_whitespace();
    let kw = words.next().unwrap_or("");
    let (homogeneous, ndim) =
        header_flags(kw).ok_or_else(|| parse_err(format!("not an OFF file (header {kw:?})")))?;
    let mut rest: Vec<&str> = words.collect();
    let mut dim = 3usize;
    if ndim {
        // `nOFF` is followed by the vertex dimension, on the header line or the next.
        if rest.is_empty() {
            rest = lines.next().unwrap_or("").split_whitespace().collect();
        }
        dim = rest
            .first()
            .and_then(|t| t.parse().ok())
            .ok_or_else(|| parse_err("nOFF without a dimension"))?;
        rest.remove(0);
        if dim < 2 {
            return Err(unsupported(format!("nOFF dimension {dim}")));
        }
    }
    if rest.is_empty() {
        rest = lines.next().unwrap_or("").split_whitespace().collect();
    }
    let count = |i: usize| -> Result<usize> {
        rest.get(i)
            .and_then(|t| t.parse::<usize>().ok())
            .ok_or_else(|| parse_err(format!("bad OFF count line {:?}", rest.join(" "))))
    };
    let (nv, nf) = (count(0)?, count(1)?);
    let ncoord = dim.min(3);

    let mut a = Assembly::default();
    a.nodes.reserve_exact(nv);
    for _ in 0..nv {
        let line = lines
            .next()
            .ok_or_else(|| parse_err("OFF vertex list ended early"))?;
        let mut it = line.split_whitespace();
        let mut v = [0f32; 3];
        for slot in v.iter_mut().take(ncoord) {
            *slot = it
                .next()
                .and_then(|t| t.parse::<f32>().ok())
                .ok_or_else(|| parse_err(format!("bad OFF vertex line {line:?}")))?;
        }
        let mut it = it.skip(dim.saturating_sub(3));
        if homogeneous {
            let w = it
                .next()
                .and_then(|t| t.parse::<f32>().ok())
                .ok_or_else(|| parse_err(format!("bad 4OFF vertex line {line:?}")))?;
            if w != 0.0 {
                for x in v.iter_mut() {
                    *x /= w;
                }
            }
        }
        a.nodes.push(v);
    }
    let mut poly: Vec<u32> = Vec::new();
    for _ in 0..nf {
        let line = lines
            .next()
            .ok_or_else(|| parse_err("OFF face list ended early"))?;
        let mut it = line.split_whitespace();
        let n: usize = it
            .next()
            .and_then(|t| t.parse().ok())
            .ok_or_else(|| parse_err(format!("bad OFF face line {line:?}")))?;
        poly.clear();
        for _ in 0..n {
            let i: u32 = it
                .next()
                .and_then(|t| t.parse().ok())
                .ok_or_else(|| parse_err(format!("bad OFF face line {line:?}")))?;
            poly.push(i);
        }
        // Trailing colour values are ignored.
        a.add_polygon(&poly);
    }
    // Faces with fewer than 3 corners were counted under the polygon code; OFF has no edge
    // list of its own worth reporting.
    a.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tvx_core::Error;

    #[test]
    fn plain_off_with_a_quad() {
        let src = "OFF\n# comment\n4 1 0\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n4 0 1 2 3\n";
        let m = read(src.as_bytes()).unwrap();
        assert_eq!(m.nodes.len(), 4);
        assert_eq!(m.tris, vec![[0, 1, 2], [0, 2, 3]]);
        assert_eq!(m.tri_edge_mask.as_deref(), Some(&[0b101, 0b011][..]));
        assert!(looks_like(src.as_bytes()));
    }

    #[test]
    fn counts_on_the_header_line_and_extra_columns() {
        let src = "COFF 3 1 0\n0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n3 0 1 2 128 128 128\n";
        let m = read(src.as_bytes()).unwrap();
        assert_eq!(m.tris, vec![[0, 1, 2]]);
        assert!(m.tri_edge_mask.is_none());
        assert!(looks_like(b"NOFF\n"));
        assert!(!looks_like(b"OFFSET\n"));
    }

    #[test]
    fn an_index_past_the_vertex_count_is_refused() {
        let src = "OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 3\n";
        assert!(matches!(read(src.as_bytes()), Err(Error::Parse(_))));
    }
}
