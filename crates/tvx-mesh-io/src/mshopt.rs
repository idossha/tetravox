//! The `<mesh>.msh.opt` sidecar (§6.2): `Physical Volume(" GM",2)` declarations,
//! `Mesh.Color.<Ordinal>` carousel entries, `View[n]` blocks and Gmsh's `Hide`/`Show` statements.
//!
//! §6.2's colour rule is implemented here in full, including **surface tag `1xxx` inherits the
//! colour of volume tag `1xxx − 1000`** — which is why `m2m_ernie/ernie.msh.opt`'s
//! `Mesh.Color.Three` colours tag 3 *and* tag 1003 while the file names neither.

use tvx_core::Result;

use crate::util::{str_of, trim};
use crate::{MshOptions, MshView};

/// Gmsh's colour carousel is addressed by an English ordinal; SimNIBS writes `Mesh.Color.<N>` for
/// tissue tag `N` `[DATA]`.
const ORDINALS: [&str; 19] = [
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
];

fn ordinal_index(name: &str) -> Option<i32> {
    ORDINALS
        .iter()
        .position(|o| *o == name)
        .map(|i| i as i32 + 1)
}

#[derive(Default)]
struct Parsed {
    /// Tags declared by a `Physical …(…, tag)` statement, in declaration order.
    declared: Vec<i32>,
    /// The names those statements carry, same order. §6.2 lists `.msh.opt` as a source of tag
    /// names, but [`MshOptions`] has no field for them — see [`read_names`].
    names: Vec<(i32, String)>,
    carousel: Vec<(i32, [u8; 4])>,
    visible: Vec<(i32, bool)>,
    views: Vec<MshView>,
}

pub fn read(bytes: &[u8]) -> Result<MshOptions> {
    let text = String::from_utf8_lossy(bytes);
    let mut p = Parsed::default();
    let mut show_block: Option<bool> = None;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(visible) = show_block {
            // Inside a `Show { … }` / `Hide { … }` body: `Volume{2};`, `Surface{1002};`, …
            if line.starts_with('}') {
                show_block = None;
                continue;
            }
            if let Some(tag) = entity_tag(line) {
                set_visible(&mut p, tag, visible);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("Physical ") {
            declare_physical(&mut p, rest);
            continue;
        }
        for (kw, visible) in [("Show", true), ("Hide", false)] {
            if let Some(rest) = line.strip_prefix(kw) {
                let rest = rest.trim();
                if rest.starts_with('"') {
                    // `Hide "*";` / `Show "*";` — every declared tag at once.
                    let all = rest.contains('*');
                    if all {
                        let declared = p.declared.clone();
                        for tag in declared {
                            set_visible(&mut p, tag, visible);
                        }
                    }
                } else if rest.starts_with('{') {
                    let body = rest.trim_start_matches('{');
                    if let Some(tag) = entity_tag(body) {
                        set_visible(&mut p, tag, visible);
                    }
                    if !body.contains('}') {
                        show_block = Some(visible);
                    }
                }
                break;
            }
        }
        if let Some((key, value)) = split_assignment(line) {
            if let Some(ord) = key.strip_prefix("Mesh.Color.") {
                if let (Some(tag), Some(rgba)) = (ordinal_index(ord), parse_color(value)) {
                    p.carousel.push((tag, rgba));
                }
            } else if let Some(rest) = key.strip_prefix("View[") {
                parse_view(&mut p, rest, value);
            }
        }
    }

    // §6.2's ordering, applied: a tag takes its own carousel colour, and a `1xxx` surface tag
    // falls back to volume tag `1xxx − 1000`.
    let mut tag_color = Vec::new();
    for tag in &p.declared {
        let direct = p.carousel.iter().find(|(t, _)| t == tag).map(|(_, c)| *c);
        let inherited = || {
            if *tag > 1000 {
                p.carousel
                    .iter()
                    .find(|(t, _)| *t == *tag - 1000)
                    .map(|(_, c)| *c)
            } else {
                None
            }
        };
        if let Some(c) = direct.or_else(inherited) {
            tag_color.push((*tag, c));
        }
    }

    Ok(MshOptions {
        tag_color,
        tag_visible: p.visible,
        views: p.views,
    })
}

fn set_visible(p: &mut Parsed, tag: i32, visible: bool) {
    match p.visible.iter_mut().find(|(t, _)| *t == tag) {
        Some(slot) => slot.1 = visible,
        None => p.visible.push((tag, visible)),
    }
}

/// `Volume{2};` → 2. Also matches `Surface`, `Curve`, `Point` — a `.msh.opt` names one tag in all
/// four dimensions and the tag, not the dimension, is what §6.2 keys on.
fn entity_tag(s: &str) -> Option<i32> {
    let s = s.trim();
    let open = s.find('{')?;
    let close = s[open..].find('}')? + open;
    s[open + 1..close].trim().parse::<i32>().ok()
}

/// `Volume (" Tissue_A",1) = { 1 };` — the leading `Physical ` is already stripped.
fn declare_physical(p: &mut Parsed, rest: &str) {
    let Some(open) = rest.find('(') else { return };
    let Some(close) = rest[open..].find(')').map(|i| i + open) else {
        return;
    };
    let inner = &rest[open + 1..close];
    let Some(comma) = inner.rfind(',') else {
        return;
    };
    let Ok(tag) = inner[comma + 1..].trim().parse::<i32>() else {
        return;
    };
    // SimNIBS keeps the leading space of `(" GM",2)`; the name is preserved verbatim and the
    // caller trims, because trimming here would silently disagree with `$PhysicalNames`.
    let name = unquote_str(inner[..comma].trim());
    if !p.declared.contains(&tag) {
        p.declared.push(tag);
        p.names.push((tag, name));
    }
}

/// The tag names a `.msh.opt` carries.
///
/// §6.2's name ladder ends at `<mesh>.msh.opt`, and for `m2m_ernie/ernie.msh` that sidecar is the
/// **only** source — the mesh itself has no `$PhysicalNames` `[DATA]`. [`MshOptions`] has no field
/// for them, so this is an **additive** entry point rather than a change to a frozen signature
/// (`docs/DECISIONS.md`, 2026-08-27).
pub fn read_names(bytes: &[u8]) -> Result<Vec<(i32, String)>> {
    let text = String::from_utf8_lossy(bytes);
    let mut p = Parsed::default();
    for raw in text.lines() {
        if let Some(rest) = raw.trim().strip_prefix("Physical ") {
            declare_physical(&mut p, rest);
        }
    }
    Ok(p.names)
}

fn split_assignment(line: &str) -> Option<(&str, &str)> {
    let eq = line.find('=')?;
    let key = line[..eq].trim();
    let mut value = line[eq + 1..].trim();
    value = value.strip_suffix(';').unwrap_or(value).trim();
    Some((key, value))
}

fn parse_color(value: &str) -> Option<[u8; 4]> {
    let v = value.trim();
    let v = v.strip_prefix('{')?.strip_suffix('}')?;
    let mut out = [0u8, 0, 0, 255];
    let mut n = 0;
    for part in v.split(',') {
        let x: f64 = part.trim().parse().ok()?;
        if n < 4 {
            out[n] = x.clamp(0.0, 255.0).round() as u8;
        }
        n += 1;
    }
    if n < 3 {
        return None;
    }
    Some(out)
}

/// `0].CustomMax` + `3.5` — the leading `View[` is already stripped.
fn parse_view(p: &mut Parsed, rest: &str, value: &str) {
    let Some(close) = rest.find(']') else { return };
    let Ok(idx) = rest[..close].trim().parse::<usize>() else {
        return;
    };
    let key = rest[close..]
        .trim_start_matches(']')
        .trim_start_matches('.');
    while p.views.len() <= idx {
        p.views.push(MshView::default());
    }
    let v = &mut p.views[idx];
    let num = || value.trim().parse::<f64>().ok();
    match key {
        "Name" => v.name = Some(unquote_str(value)),
        "CustomMin" => v.custom_min = num().map(|x| x as f32),
        "CustomMax" => v.custom_max = num().map(|x| x as f32),
        "RangeType" => v.range_type = num().map(|x| x as i32),
        "SaturateValues" => v.saturate_values = num().map(|x| x != 0.0),
        "ColormapNumber" => v.colormap_number = num().map(|x| x as i32),
        "ShowScale" => v.show_scale = num().map(|x| x != 0.0),
        "VectorType" => v.vector_type = num().map(|x| x as i32),
        _ => {}
    }
}

fn unquote_str(s: &str) -> String {
    let t = str_of(trim(s.as_bytes())).unwrap_or("");
    t.trim_matches('"').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = r#"// Visualization File Created by SimNIBS
Physical Volume (" A",1) = { 1 };
Physical Surface (" A",1001) = { 1001 };
Mesh.Color.One = {10, 20, 30};
Mesh.Color.Three = {1, 2, 3};
View[0].CustomMin = -1.5;
Hide "*";
Show {
Volume{1};
}
"#;

    #[test]
    fn a_surface_tag_inherits_the_volume_tags_colour() {
        let o = read(SRC.as_bytes()).unwrap();
        assert_eq!(
            o.tag_color,
            vec![(1, [10, 20, 30, 255]), (1001, [10, 20, 30, 255])]
        );
        // `Mesh.Color.Three` names no declared tag, so it colours nothing.
        assert!(!o.tag_color.iter().any(|(t, _)| *t == 3));
    }

    #[test]
    fn hide_star_then_show_leaves_one_tag_visible() {
        let o = read(SRC.as_bytes()).unwrap();
        let vis = |t: i32| o.tag_visible.iter().find(|(k, _)| *k == t).map(|(_, v)| *v);
        assert_eq!(vis(1), Some(true));
        assert_eq!(vis(1001), Some(false));
    }

    #[test]
    fn a_view_key_lands_in_the_right_slot() {
        let o = read(SRC.as_bytes()).unwrap();
        assert_eq!(o.views.len(), 1);
        assert_eq!(o.views[0].custom_min, Some(-1.5));
        assert_eq!(o.views[0].custom_max, None);
    }

    #[test]
    fn an_empty_sidecar_is_not_an_error() {
        let o = read(b"").unwrap();
        assert!(o.tag_color.is_empty() && o.tag_visible.is_empty() && o.views.is_empty());
    }
}
