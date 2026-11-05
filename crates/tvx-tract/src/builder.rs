//! What every format produces: kept streamlines in world RAS mm, plus the fields finished once.

use std::collections::BTreeSet;

use tvx_core::Aabb;

use crate::{make_field, TractField, TractGroup, Tractogram};

const MAX_CATEGORIES: usize = 4096;

#[derive(Default)]
pub(crate) struct Builder {
    pub positions: Vec<f32>,
    pub offsets: Vec<u32>,
    pub source_index: Vec<u32>,
    pub source_streamlines: u64,
    pub source_points: u64,
    pub vertex_fields: Vec<(String, Vec<f32>)>,
    pub streamline_fields: Vec<(String, Vec<f32>)>,
    pub groups: Vec<TractGroup>,
    pub notes: Vec<String>,
    pub header_json: String,
}

impl Builder {
    pub fn new() -> Self {
        Self {
            offsets: vec![0],
            ..Self::default()
        }
    }

    /// Closes a kept streamline whose points are already in `positions`.
    pub fn close_kept(&mut self, source: u64) {
        self.offsets.push((self.positions.len() / 3) as u32);
        self.source_index.push(source as u32);
    }

    pub fn finish(mut self) -> Tractogram {
        let bounds = bounds_of(&self.positions);
        let lengths = lengths_of(&self.positions, &self.offsets);
        let mut streamline_fields: Vec<TractField> = self
            .streamline_fields
            .drain(..)
            .map(|(name, values)| {
                let mut f = make_field(name, values, None);
                f.categorical = is_categorical(&f.values);
                f
            })
            .collect();
        if !streamline_fields.iter().any(|f| f.name == "length_mm") {
            let mut f = make_field("length_mm".into(), lengths, Some("mm".into()));
            f.builtin = true;
            streamline_fields.push(f);
        }
        let streamline_boxes = self
            .offsets
            .windows(2)
            .map(|w| {
                let b = bounds_of(&self.positions[w[0] as usize * 3..w[1] as usize * 3]);
                [b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]]
            })
            .collect();
        Tractogram {
            streamline_boxes,
            positions: self.positions,
            offsets: self.offsets,
            source_index: self.source_index,
            source_streamlines: self.source_streamlines,
            source_points: self.source_points,
            vertex_fields: self
                .vertex_fields
                .into_iter()
                .map(|(name, values)| make_field(name, values, None))
                .collect(),
            streamline_fields,
            groups: self.groups,
            bounds,
            notes: self.notes,
            header_json: self.header_json,
            fingerprint: String::new(),
        }
    }
}

fn bounds_of(positions: &[f32]) -> Aabb {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in positions.chunks_exact(3) {
        for c in 0..3 {
            min[c] = min[c].min(p[c]);
            max[c] = max[c].max(p[c]);
        }
    }
    if positions.is_empty() {
        min = [0.0; 3];
        max = [0.0; 3];
    }
    Aabb { min, max }
}

fn lengths_of(positions: &[f32], offsets: &[u32]) -> Vec<f32> {
    offsets
        .windows(2)
        .map(|w| {
            let pts = &positions[w[0] as usize * 3..w[1] as usize * 3];
            let mut sum = 0.0f64;
            for (a, b) in pts.chunks_exact(3).zip(pts.chunks_exact(3).skip(1)) {
                let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]].map(f64::from);
                sum += (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            }
            sum as f32
        })
        .collect()
}

fn is_categorical(values: &[f32]) -> bool {
    let mut seen = BTreeSet::new();
    for v in values {
        if !v.is_finite() || v.fract() != 0.0 {
            return false;
        }
        seen.insert(*v as i64);
        if seen.len() > MAX_CATEGORIES {
            return false;
        }
    }
    !values.is_empty()
}
