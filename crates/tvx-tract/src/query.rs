//! What a tractogram's worker answers after load: scalars, per-streamline style, probes, written fields.

use std::collections::BTreeMap;

use tvx_core::{Error, Result};

use crate::{make_field, TractField, Tractogram};

const NEUTRAL: [u8; 3] = [128, 128, 128];

pub struct ScalarU16 {
    /// One per point; 65535 is NaN.
    pub values: Vec<u16>,
    pub lo: f32,
    pub hi: f32,
}

/// `vertex` is one per point; `streamline` is expanded to its points, so both are one shader path.
pub fn scalar_u16(t: &Tractogram, per_streamline: bool, name: &str) -> Result<ScalarU16> {
    let list = if per_streamline {
        &t.streamline_fields
    } else {
        &t.vertex_fields
    };
    let f = list
        .iter()
        .find(|f| f.name == name)
        .ok_or_else(|| Error::Parse(format!("this tractogram has no field {name}")))?;
    let (lo, hi) = (f.stats.min, f.stats.max);
    let span = f64::from(hi) - f64::from(lo);
    let code = |v: f32| -> u16 {
        if !v.is_finite() {
            65535
        } else if span > 0.0 {
            ((f64::from(v) - f64::from(lo)) / span * 65534.0).round() as u16
        } else {
            0
        }
    };
    let values = if per_streamline {
        let mut out = Vec::with_capacity(t.n_points());
        for (s, w) in t.offsets.windows(2).enumerate() {
            let c = code(f.values[s]);
            out.extend(std::iter::repeat_n(c, (w[1] - w[0]) as usize));
        }
        out
    } else {
        f.values.iter().map(|v| code(*v)).collect()
    };
    Ok(ScalarU16 { values, lo, hi })
}

#[derive(Clone, Debug, Default)]
pub struct StyleSpec {
    pub filter: Option<(String, Option<f32>, Option<f32>)>,
    pub group_field: Option<String>,
    pub visible_groups: Option<Vec<i64>>,
}

#[derive(Clone, Debug)]
pub struct GroupRow {
    pub id: i64,
    pub name: String,
    pub count: u32,
    pub color: [u8; 3],
}

pub struct Style {
    /// 4/streamline: group rgb, alpha 255 when visible.
    pub rgba: Vec<u8>,
    pub visible: Vec<bool>,
    pub visible_streamlines: u32,
    pub groups: Vec<GroupRow>,
}

/// Evenly spread, deterministic hues: a group's colour must not depend on what else is loaded.
fn palette(i: u64) -> [u8; 3] {
    let h = (i as f64 * 0.618_033_988_749_895).fract() * 6.0;
    let (v, s) = (0.95, 0.70);
    let c = v * s;
    let x = c * (1.0 - ((h % 2.0) - 1.0).abs());
    let (r, g, b) = match h as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [r + m, g + m, b + m].map(|u| (u * 255.0).round() as u8)
}

pub fn style(t: &Tractogram, spec: &StyleSpec) -> Result<Style> {
    let s = t.n_streamlines();
    let mut rgba = vec![0u8; s * 4];
    let mut member: Vec<Option<i64>> = vec![None; s];
    let mut visible = vec![true; s];
    let mut groups = Vec::new();
    let allowed = spec.visible_groups.as_ref();

    if let Some(field) = &spec.group_field {
        let f = t
            .streamline_fields
            .iter()
            .find(|f| &f.name == field && f.categorical)
            .ok_or_else(|| {
                Error::Parse(format!("{field} is not a categorical streamline field"))
            })?;
        let mut counts: BTreeMap<i64, u32> = BTreeMap::new();
        for (i, v) in f.values.iter().enumerate() {
            let id = *v as i64;
            member[i] = Some(id);
            *counts.entry(id).or_default() += 1;
            if let Some(a) = allowed {
                visible[i] = a.contains(&id);
            }
        }
        groups = counts
            .into_iter()
            .map(|(id, count)| GroupRow {
                id,
                name: format!("{field} {id}"),
                count,
                color: palette(id.unsigned_abs()),
            })
            .collect();
    } else if !t.groups.is_empty() {
        if allowed.is_some() {
            visible.fill(false);
        }
        for g in &t.groups {
            let id = i64::from(g.id);
            let shown = allowed.is_none_or(|a| a.contains(&id));
            for &i in &g.streamlines {
                let i = i as usize;
                if member[i].is_none() {
                    member[i] = Some(id);
                }
                if shown {
                    visible[i] = true;
                }
            }
            groups.push(GroupRow {
                id,
                name: g.name.clone(),
                count: g.streamlines.len() as u32,
                color: g.color.unwrap_or_else(|| palette(u64::from(g.id))),
            });
        }
    }

    if let Some((name, lo, hi)) = &spec.filter {
        let f = t
            .streamline_fields
            .iter()
            .find(|f| &f.name == name)
            .ok_or_else(|| {
                Error::Parse(format!("this tractogram has no streamline field {name}"))
            })?;
        for (i, v) in f.values.iter().enumerate() {
            let inside = v.is_finite() && lo.is_none_or(|b| *v >= b) && hi.is_none_or(|b| *v <= b);
            visible[i] = visible[i] && inside;
        }
    }

    let by_id: BTreeMap<i64, [u8; 3]> = groups.iter().map(|g| (g.id, g.color)).collect();
    let mut visible_streamlines = 0;
    for i in 0..s {
        let c = member[i]
            .and_then(|id| by_id.get(&id).copied())
            .unwrap_or(NEUTRAL);
        rgba[i * 4..i * 4 + 3].copy_from_slice(&c);
        rgba[i * 4 + 3] = if visible[i] { 255 } else { 0 };
        visible_streamlines += u32::from(visible[i]);
    }
    Ok(Style {
        rgba,
        visible,
        visible_streamlines,
        groups,
    })
}

#[derive(Clone, Debug)]
pub struct ProbeHit {
    /// Held index, then the file's own.
    pub held: u32,
    pub streamline: u32,
    /// Index within the streamline.
    pub vertex: u32,
    pub world: [f32; 3],
    pub distance_mm: f32,
    pub vertex_fields: Vec<(String, f32, Option<String>)>,
    pub streamline_fields: Vec<(String, f32, Option<String>)>,
    pub groups: Vec<String>,
}

/// Nearest point within `radius_mm`, over one held streamline or every visible one.
pub fn probe(
    t: &Tractogram,
    visible: Option<&[bool]>,
    world: [f32; 3],
    radius_mm: f32,
    only: Option<u32>,
) -> Option<ProbeHit> {
    let mut best: Option<(u32, usize, f32)> = None;
    let mut limit = radius_mm * radius_mm;
    let mut scan = |s: u32, w: &[u32]| {
        let b = &t.streamline_boxes[s as usize];
        let mut gap = 0.0f32;
        for c in 0..3 {
            let d = (b[c] - world[c]).max(world[c] - b[c + 3]).max(0.0);
            gap += d * d;
        }
        if gap > limit {
            return;
        }
        for i in w[0] as usize..w[1] as usize {
            let p = &t.positions[i * 3..i * 3 + 3];
            let d = [p[0] - world[0], p[1] - world[1], p[2] - world[2]];
            let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            if d2 <= limit {
                limit = d2;
                best = Some((s, i, d2));
            }
        }
    };
    if let Some(s) = only {
        let w = t.offsets.get(s as usize..s as usize + 2)?;
        scan(s, w);
    } else {
        for (s, w) in t.offsets.windows(2).enumerate() {
            if visible.is_none_or(|v| v[s]) {
                scan(s as u32, w);
            }
        }
    }
    let (s, i, d2) = best?;
    let row = |f: &TractField, at: usize| (f.name.clone(), f.values[at], f.units.clone());
    Some(ProbeHit {
        held: s,
        streamline: t.source_index[s as usize],
        vertex: i as u32 - t.offsets[s as usize],
        world: [
            t.positions[i * 3],
            t.positions[i * 3 + 1],
            t.positions[i * 3 + 2],
        ],
        distance_mm: d2.sqrt(),
        vertex_fields: t.vertex_fields.iter().map(|f| row(f, i)).collect(),
        streamline_fields: t
            .streamline_fields
            .iter()
            .map(|f| row(f, s as usize))
            .collect(),
        groups: t
            .groups
            .iter()
            .filter(|g| g.streamlines.binary_search(&s).is_ok())
            .map(|g| g.name.clone())
            .collect(),
    })
}

/// One chunk of a field being written. `first == 0` starts it, replacing any field of that name;
/// `done` computes the statistics and returns the finished row.
pub fn write_field_chunk<'a>(
    t: &'a mut Tractogram,
    name: &str,
    units: Option<String>,
    first: usize,
    values: &[f32],
    done: bool,
) -> Result<Option<&'a TractField>> {
    let n = t.n_points();
    if first + values.len() > n {
        return Err(Error::Parse(format!(
            "field chunk ends at {} but the tractogram holds {n} points",
            first + values.len()
        )));
    }
    if first == 0 {
        t.vertex_fields.retain(|f| f.name != name);
        t.vertex_fields
            .push(make_field(name.to_string(), vec![f32::NAN; n], units));
    }
    let i = t
        .vertex_fields
        .iter()
        .position(|f| f.name == name)
        .ok_or_else(|| Error::Parse(format!("field chunk for {name} before its start")))?;
    t.vertex_fields[i].values[first..first + values.len()].copy_from_slice(values);
    if !done {
        return Ok(None);
    }
    let f = &mut t.vertex_fields[i];
    let mut finished = make_field(
        std::mem::take(&mut f.name),
        std::mem::take(&mut f.values),
        f.units.take(),
    );
    finished.sampled = true;
    *f = finished;
    Ok(Some(&t.vertex_fields[i]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{load_bytes, LoadOptions, TractFormat};

    fn sample() -> Tractogram {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/tract_f32_stored.trx"
        ));
        load_bytes(
            TractFormat::Trx,
            &bytes.unwrap(),
            LoadOptions {
                max_points: None,
                seed: 0,
            },
        )
        .unwrap()
    }

    #[test]
    fn a_scalar_is_quantised_over_its_own_range_and_nan_is_the_sentinel() {
        let mut t = sample();
        let s = scalar_u16(&t, false, "along").unwrap();
        assert_eq!(s.values[0], 0, "the minimum");
        assert_eq!((s.lo, s.hi), (-10.0, 10.0));
        assert_eq!(s.values[20], 65534, "the maximum");
        t.vertex_fields[0].values[3] = f32::NAN;
        t.vertex_fields[0].stats = tvx_mesh_io::field_stats(&t.vertex_fields[0].values, 1);
        assert_eq!(scalar_u16(&t, false, "along").unwrap().values[3], 65535);
        let w = scalar_u16(&t, true, "weight").unwrap();
        assert_eq!(w.values.len(), t.n_points());
        assert_eq!(w.values[0], 0);
        assert_eq!(w.values[43], 65534);
    }

    #[test]
    fn style_combines_filter_and_groups_on_whole_streamlines() {
        let t = sample();
        let by_filter = style(
            &t,
            &StyleSpec {
                filter: Some(("length_mm".into(), Some(15.0), None)),
                ..StyleSpec::default()
            },
        )
        .unwrap();
        assert_eq!(by_filter.visible, vec![true, false, false, false]);
        assert_eq!(by_filter.visible_streamlines, 1);

        let groups = style(
            &t,
            &StyleSpec {
                visible_groups: Some(vec![t
                    .groups
                    .iter()
                    .find(|g| g.name == "left")
                    .unwrap()
                    .id
                    .into()]),
                ..StyleSpec::default()
            },
        )
        .unwrap();
        assert_eq!(
            groups.visible,
            vec![true, false, true, false],
            "a streamline in no shown group hides"
        );

        let cat = style(
            &t,
            &StyleSpec {
                group_field: Some("edge_id".into()),
                visible_groups: Some(vec![7]),
                ..StyleSpec::default()
            },
        )
        .unwrap();
        assert_eq!(cat.visible, vec![true, true, false, false]);
        assert_eq!(
            cat.groups
                .iter()
                .map(|g| (g.id, g.count))
                .collect::<Vec<_>>(),
            vec![(-1, 1), (7, 2), (9, 1)]
        );
        assert_eq!(cat.rgba[0..3], cat.rgba[4..7], "one group, one colour");
        assert_ne!(cat.rgba[0..3], cat.rgba[8..11]);
        assert!(style(
            &t,
            &StyleSpec {
                group_field: Some("weight".into()),
                ..StyleSpec::default()
            }
        )
        .is_err());
    }

    #[test]
    fn a_probe_finds_the_nearest_visible_vertex_with_every_value() {
        let t = sample();
        let hit = probe(&t, None, [0.2, 0.1, 0.0], 2.0, None).unwrap();
        assert_eq!((hit.streamline, hit.vertex), (0, 10));
        assert!((hit.distance_mm - (0.05f32).sqrt()).abs() < 1e-5);
        assert_eq!(
            hit.vertex_fields.iter().find(|f| f.0 == "along").unwrap().1,
            0.0
        );
        assert_eq!(
            hit.streamline_fields
                .iter()
                .find(|f| f.0 == "weight")
                .unwrap()
                .1,
            0.5
        );
        assert_eq!(hit.groups, vec!["left".to_string()]);
        assert!(probe(&t, None, [50.0, 50.0, 50.0], 2.0, None).is_none());
        let hidden = [false, true, true, true];
        assert_eq!(
            probe(&t, Some(&hidden), [0.2, 0.1, 0.0], 2.0, None)
                .unwrap()
                .streamline,
            1
        );
        assert_eq!(
            probe(&t, None, [0.2, 0.1, 0.0], 50.0, Some(2))
                .unwrap()
                .streamline,
            2
        );
    }

    #[test]
    fn written_chunks_replace_a_field_and_stats_exclude_nan() {
        let mut t = sample();
        let n = t.n_points();
        let mut a = vec![1.0f32; n];
        a[0] = f32::NAN;
        assert!(
            write_field_chunk(&mut t, "s", Some("V/m".into()), 0, &a[..10], false)
                .unwrap()
                .is_none()
        );
        let f = write_field_chunk(&mut t, "s", None, 10, &a[10..], true)
            .unwrap()
            .unwrap();
        assert_eq!((f.nan_count, f.stats.min, f.stats.max), (1, 1.0, 1.0));
        assert!(f.sampled);
        assert_eq!(f.units.as_deref(), Some("V/m"));
        write_field_chunk(&mut t, "s", None, 0, &a, true).unwrap();
        assert_eq!(t.vertex_fields.iter().filter(|f| f.name == "s").count(), 1);
        assert!(write_field_chunk(&mut t, "s", None, n, &[1.0], true).is_err());
    }
}
