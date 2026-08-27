//! Sidecar LUT text → [`tvx_core::LabelTable`].
//!
//! §6.4's table says "sidecar LUT text is parsed **in the worker** as part of `load_volume` /
//! `load_mesh`, from their `lut_bytes` argument": the worker fetches `LoadSource.sidecars.lut`
//! (§6.5.1) and the crates never touch the filesystem. This module is that parse.
//!
//! **Temporary.** §6.0 declares `LabelTable::parse_freesurfer` / `parse_simnibs` /
//! `parse_itksnap` / `parse_generic`, and they are still Phase-0 `unimplemented!()` stubs in
//! `tvx-core`, a crate this agent does not own (AGENTS rule 3). Rather than trap the module on
//! every LUT-bearing dataset, the worker parses the text itself. **The integrator should delete
//! this file and call `LabelTable::parse_*` once `tvx-core` lands** — see `docs/DECISIONS.md`.
//!
//! One tolerant parser covers the three text shapes, because the op table gives the worker no
//! format hint: `lut` is a role, not a type (§6.5.1).
//!
//! * FreeSurfer `FreeSurferColorLUT.txt` — `id name R G B A`, whitespace-aligned.
//! * SimNIBS `#No.\tLabel Name:\tR G B A` — the same columns, tab-padded.
//! * ITK-SNAP label descriptions — `IDX R G B A VIS MSH "LABEL"`, detected by the quoted name.
//! * generic `id r g b [a] [name]`.

use tvx_core::{Error, LabelEntry, LabelTable, Result};

/// Parse LUT text. Blank lines and `#` comments are skipped; a line that cannot be read as an
/// entry is skipped too, so a header row never fails the load.
pub fn parse(text: &str) -> Result<LabelTable> {
    let mut entries: Vec<LabelEntry> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        if let Some(e) = parse_line(line) {
            entries.push(e);
        }
    }
    if entries.is_empty() {
        return Err(Error::Parse("LUT has no entries".into()));
    }
    entries.sort_by_key(|e| e.id);
    entries.dedup_by_key(|e| e.id);
    Ok(LabelTable { entries })
}

fn parse_line(line: &str) -> Option<LabelEntry> {
    if line.ends_with('"') {
        return parse_itksnap_line(line);
    }
    let tok: Vec<&str> = line.split_whitespace().collect();
    if tok.len() < 4 {
        return None;
    }
    let id: u32 = tok[0].parse().ok()?;

    // §6.0 `parse_generic`: "id r g b [a] [name]" — colour first. Recognised by three integers
    // straight after the id, which a FreeSurfer/SimNIBS row (whose second column is the name)
    // never has.
    if is_int(tok[1]) && is_int(tok[2]) && is_int(tok[3]) {
        let (alpha, name_at) = if tok.len() >= 5 && is_int(tok[4]) {
            (int_u8(tok[4])?, 5)
        } else {
            (255, 4)
        };
        return Some(LabelEntry {
            id,
            name: tok[name_at..].join(" "),
            color: [int_u8(tok[1])?, int_u8(tok[2])?, int_u8(tok[3])?, alpha],
        });
    }

    // FreeSurfer / SimNIBS: "id name… r g b [a]" — the colour is always the tail.
    let (rgb_at, alpha) = if tok.len() >= 6 && tok[tok.len() - 4..].iter().all(|t| is_int(t)) {
        (tok.len() - 4, int_u8(tok[tok.len() - 1])?)
    } else if tok.len() >= 5 && tok[tok.len() - 3..].iter().all(|t| is_int(t)) {
        (tok.len() - 3, 255)
    } else {
        return None;
    };
    Some(LabelEntry {
        id,
        name: tok[1..rgb_at].join(" "),
        color: [
            int_u8(tok[rgb_at])?,
            int_u8(tok[rgb_at + 1])?,
            int_u8(tok[rgb_at + 2])?,
            alpha,
        ],
    })
}

fn is_int(t: &str) -> bool {
    t.parse::<i64>().is_ok()
}

fn int_u8(t: &str) -> Option<u8> {
    Some(clamp_u8(t.parse::<i64>().ok()?))
}

/// `IDX -R- -G- -B- -A-- VIS MSH "LABEL"`. ITK-SNAP's alpha is a 0..1 float.
fn parse_itksnap_line(line: &str) -> Option<LabelEntry> {
    let q = line.find('"')?;
    let name = line[q + 1..line.len() - 1].to_string();
    let tok: Vec<&str> = line[..q].split_whitespace().collect();
    if tok.len() < 5 {
        return None;
    }
    let id: u32 = tok[0].parse().ok()?;
    let r = clamp_u8(tok[1].parse::<i64>().ok()?);
    let g = clamp_u8(tok[2].parse::<i64>().ok()?);
    let b = clamp_u8(tok[3].parse::<i64>().ok()?);
    let a: f64 = tok[4].parse().ok()?;
    let a = if a <= 1.0 { a * 255.0 } else { a };
    Some(LabelEntry {
        id,
        name,
        color: [r, g, b, clamp_u8(a.round() as i64)],
    })
}

fn clamp_u8(v: i64) -> u8 {
    v.clamp(0, 255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_simnibs_shape() {
        let t = parse("#No.\tLabel Name:\t\tR\tG\tB\tA\n0\tUnknown\t\t\t0\t0\t0\t0\n1\tWM\t\t\t230\t230\t210\t255\n").unwrap();
        assert_eq!(t.entries.len(), 2);
        assert_eq!(t.entries[1].id, 1);
        assert_eq!(t.entries[1].name, "WM");
        assert_eq!(t.entries[1].color, [230, 230, 210, 255]);
    }

    #[test]
    fn reads_the_freesurfer_shape_including_a_zero_alpha() {
        let t = parse("# comment\n  3  Alpha   255   0   0   0\n 42 Delta 220 190 20 0\n").unwrap();
        assert_eq!(t.entries[0].color, [255, 0, 0, 0]);
        assert_eq!(t.entries[1].id, 42);
        assert_eq!(t.entries[1].name, "Delta");
    }

    #[test]
    fn reads_an_itksnap_quoted_name_and_its_0_to_1_alpha() {
        let t = parse("    1   255    0    0        1  1  1    \"Left kidney\"\n").unwrap();
        assert_eq!(t.entries[0].name, "Left kidney");
        assert_eq!(t.entries[0].color, [255, 0, 0, 255]);
    }

    #[test]
    fn entries_come_back_sorted_and_deduplicated() {
        let t = parse("7 b 0 0 0 255\n3 a 1 1 1 255\n7 c 2 2 2 255\n").unwrap();
        assert_eq!(t.entries.iter().map(|e| e.id).collect::<Vec<_>>(), [3, 7]);
        assert_eq!(t.entries[1].name, "b");
    }

    #[test]
    fn a_table_with_nothing_readable_is_a_parse_error() {
        assert!(parse("# only a header\n\n").is_err());
    }
}
