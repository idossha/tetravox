//! The four [`LabelTable`](crate::LabelTable) parsers of §6.0.
//!
//! All four are whitespace-tolerant line parsers over the same shape — an integer id, a name and
//! three or four colour channels — differing only in where the name sits and how alpha is spelled.
//! Blank lines and `#` comments are skipped everywhere; a line that does not parse is skipped rather
//! than fatal, because every LUT in the wild carries trailing notes. A file that yields **no** entries
//! at all is [`Error::Parse`](crate::Error::Parse) — that is a wrong-format file, not an empty table.

use crate::{Error, LabelEntry, LabelTable, Result};

/// Strip a `#` comment and surrounding whitespace; `None` when nothing is left.
fn content(line: &str) -> Option<&str> {
    let s = match line.find('#') {
        Some(i) => &line[..i],
        None => line,
    }
    .trim();
    (!s.is_empty()).then_some(s)
}

fn u8_channel(tok: &str) -> Option<u8> {
    // Channels are written as integers everywhere except ITK-SNAP's alpha, which has its own path.
    tok.parse::<i64>().ok().map(|v| v.clamp(0, 255) as u8)
}

fn finish(entries: Vec<LabelEntry>, what: &str) -> Result<LabelTable> {
    if entries.is_empty() {
        return Err(Error::Parse(format!("{what}: no label entries")));
    }
    Ok(LabelTable { entries })
}

/// `id name r g b [a]` — the shape shared by `FreeSurferColorLUT.txt` and SimNIBS's
/// `#No.\tLabel Name:\tR G B A`.
///
/// Alpha is taken **verbatim** when present and defaults to 255 when the line stops at blue.
/// FreeSurfer writes 0 in that column and means "transparency", but §6.0 fixes `LabelEntry::color`
/// as RGBA 0..255 and the manifest's authored expectation for `labels_freesurfer_LUT.txt` is
/// `[255, 0, 0, 0]` — the column as written. Re-interpreting it here would contradict that fixture.
/// (`tvx-mesh-io`'s `.annot` reader does invert it, because a FreeSurfer *colortable* is a different
/// container with a documented transparency field — see `docs/DECISIONS.md`.)
fn parse_id_name_rgba(text: &str, what: &str) -> Result<LabelTable> {
    let mut entries = Vec::new();
    for line in text.lines() {
        let Some(s) = content(line) else { continue };
        let mut it = s.split_whitespace();
        let (Some(id), Some(name), Some(r), Some(g), Some(b)) =
            (it.next(), it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(id), Some(r), Some(g), Some(b)) = (
            id.parse::<u32>(),
            u8_channel(r),
            u8_channel(g),
            u8_channel(b),
        ) else {
            continue;
        };
        let a = it.next().and_then(u8_channel).unwrap_or(255);
        entries.push(LabelEntry {
            id,
            name: name.to_string(),
            color: [r, g, b, a],
        });
    }
    finish(entries, what)
}

pub(crate) fn freesurfer(text: &str) -> Result<LabelTable> {
    parse_id_name_rgba(text, "freesurfer LUT")
}

pub(crate) fn simnibs(text: &str) -> Result<LabelTable> {
    parse_id_name_rgba(text, "simnibs LUT")
}

/// ITK-SNAP: `IDX R G B A VIS MSH "LABEL"`, with alpha a 0..1 float and the name quoted.
pub(crate) fn itksnap(text: &str) -> Result<LabelTable> {
    let mut entries = Vec::new();
    for line in text.lines() {
        // A quoted label may legitimately contain a '#', so the comment strip is by first column.
        let s = line.trim();
        if s.is_empty() || s.starts_with('#') {
            continue;
        }
        // Split the quoted name off the back, then read seven numbers off the front.
        let (nums, name) = match s.find('"') {
            Some(q) => {
                let rest = &s[q + 1..];
                let end = rest.find('"').unwrap_or(rest.len());
                (&s[..q], rest[..end].to_string())
            }
            None => continue,
        };
        let f: Vec<&str> = nums.split_whitespace().collect();
        if f.len() < 5 {
            continue;
        }
        let (Ok(id), Some(r), Some(g), Some(b)) = (
            f[0].parse::<u32>(),
            u8_channel(f[1]),
            u8_channel(f[2]),
            u8_channel(f[3]),
        ) else {
            continue;
        };
        // Alpha is 0..1 in this format; 1 means opaque, not "colour channel 1".
        let a = f[4]
            .parse::<f64>()
            .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
            .unwrap_or(255);
        entries.push(LabelEntry {
            id,
            name,
            color: [r, g, b, a],
        });
    }
    finish(entries, "itksnap LUT")
}

/// `id r g b [a] [name]` — colour first, optional trailing name (§6.0).
///
/// The ambiguity is the fifth token: it is alpha when it parses as an integer, otherwise the name.
pub(crate) fn generic(text: &str) -> Result<LabelTable> {
    let mut entries = Vec::new();
    for line in text.lines() {
        let Some(s) = content(line) else { continue };
        let f: Vec<&str> = s.split_whitespace().collect();
        if f.len() < 4 {
            continue;
        }
        let (Ok(id), Some(r), Some(g), Some(b)) = (
            f[0].parse::<u32>(),
            u8_channel(f[1]),
            u8_channel(f[2]),
            u8_channel(f[3]),
        ) else {
            continue;
        };
        let (a, name_at) = match f.get(4).and_then(|t| u8_channel(t)) {
            Some(a) => (a, 5),
            None => (255, 4),
        };
        entries.push(LabelEntry {
            id,
            name: f[name_at..].join(" "),
            color: [r, g, b, a],
        });
    }
    finish(entries, "generic LUT")
}
