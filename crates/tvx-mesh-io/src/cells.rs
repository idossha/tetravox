//! Shared assembly for the general-purpose volume formats (§6.2: VTK legacy, VTK XML, MEDIT, OFF):
//! a cell census by type, cell-data splitting into `ElmField { tri, tet }`, the tag-array rule and
//! the final index validation every reader here runs before it hands out a [`Mesh`].

use std::collections::BTreeMap;

use tvx_core::Field;

use crate::gifti::bounds_of;
use crate::surf::fan;
use crate::util::parse_err;
use crate::{field_stats, field_stats_parts, ElmField, Mesh};

/// VTK cell types (`vtkCellType.h`). The kept set is triangle, polygon, pixel, quad → `tris` and
/// tetra → `tets`; everything else is counted into `Mesh::skipped` under its **VTK** code.
pub const VTK_POLY_VERTEX: u32 = 2;
pub const VTK_POLY_LINE: u32 = 4;
pub const VTK_TRIANGLE: u32 = 5;
pub const VTK_TRIANGLE_STRIP: u32 = 6;
pub const VTK_POLYGON: u32 = 7;
pub const VTK_PIXEL: u32 = 8;
pub const VTK_QUAD: u32 = 9;
pub const VTK_TETRA: u32 = 10;

/// Where one file cell landed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellRef {
    /// `count` consecutive triangles starting at `first` (1 for a triangle, `n − 2` for a fanned
    /// n-gon — the cell's data value is replicated onto each).
    Tris {
        first: u32,
        count: u32,
    },
    Tet(u32),
    Dropped,
}

/// A mesh under construction. Cells arrive in file order; `refs` remembers where each went so
/// cell data can be split by kind afterwards.
#[derive(Default)]
pub struct Assembly {
    pub nodes: Vec<[f32; 3]>,
    pub tris: Vec<[u32; 3]>,
    pub tets: Vec<[u32; 4]>,
    pub mask: Vec<u8>,
    pub saw_ngon: bool,
    pub refs: Vec<CellRef>,
    pub skipped: BTreeMap<u32, u64>,
    pub node_fields: Vec<Field>,
    pub elm_fields: Vec<ElmField>,
    pub tri_tags: Option<Vec<i32>>,
    pub tet_tags: Option<Vec<i32>>,
}

impl Assembly {
    /// One cell of VTK type `ty` over `conn`. Never fails: an unknown type is counted, and a
    /// malformed connectivity (a triangle with 2 points) is dropped under the same code.
    pub fn add_vtk_cell(&mut self, ty: u32, conn: &[u32]) {
        match ty {
            VTK_TRIANGLE | VTK_POLYGON | VTK_QUAD if conn.len() >= 3 => self.add_polygon(conn),
            VTK_PIXEL if conn.len() == 4 => {
                // A pixel is ordered (0,1) / (2,3) row-wise, not around the boundary.
                self.add_polygon(&[conn[0], conn[1], conn[3], conn[2]]);
            }
            VTK_TETRA if conn.len() == 4 => {
                self.refs.push(CellRef::Tet(self.tets.len() as u32));
                self.tets.push([conn[0], conn[1], conn[2], conn[3]]);
            }
            other => self.drop(other),
        }
    }

    /// A polygon; fan-triangulated with a `tri_edge_mask` when it is not a triangle.
    pub fn add_polygon(&mut self, poly: &[u32]) {
        if poly.len() < 3 {
            self.drop(VTK_POLYGON);
            return;
        }
        let first = self.tris.len() as u32;
        if poly.len() > 3 {
            self.saw_ngon = true;
        }
        fan(poly, &mut self.tris, &mut self.mask);
        self.refs.push(CellRef::Tris {
            first,
            count: (poly.len() - 2) as u32,
        });
    }

    pub fn add_tet(&mut self, t: [u32; 4]) {
        self.refs.push(CellRef::Tet(self.tets.len() as u32));
        self.tets.push(t);
    }

    /// Count one dropped cell of type `ty` (§6.2: counted, never an error).
    pub fn drop(&mut self, ty: u32) {
        self.refs.push(CellRef::Dropped);
        *self.skipped.entry(ty).or_insert(0) += 1;
    }

    /// Count `n` dropped cells of type `ty` that carry no cell-data rows (a legacy POLYDATA's
    /// `VERTICES` / `LINES` / `TRIANGLE_STRIPS` *do* carry rows — use [`Assembly::drop`] for those).
    pub fn skip_uncounted(&mut self, ty: u32, n: u64) {
        if n > 0 {
            *self.skipped.entry(ty).or_insert(0) += n;
        }
    }

    /// A node-indexed array → `node_fields`.
    pub fn push_point_field(&mut self, name: &str, ncomp: usize, values: Vec<f32>) {
        let stats = field_stats(&values, ncomp);
        self.node_fields.push(Field {
            name: name.to_string(),
            ncomp,
            data: values,
            units: None,
            partial: false,
            stats,
        });
    }

    /// A cell-indexed array (one row per file cell, in `refs` order) → `elm_fields`, split by
    /// element kind. A fanned n-gon's row is replicated onto each of its triangles; a dropped
    /// cell's row vanishes. When the array is named like a tag array (see [`is_tag_name`]) it
    /// **also** becomes `tri_tags` / `tet_tags` — the first such array wins.
    pub fn push_cell_field(&mut self, name: &str, ncomp: usize, values: &[f32]) {
        let ncomp = ncomp.max(1);
        let mut tri = Vec::with_capacity(self.tris.len() * ncomp);
        let mut tet = Vec::with_capacity(self.tets.len() * ncomp);
        for (r, row) in self.refs.iter().zip(values.chunks_exact(ncomp)) {
            match r {
                CellRef::Tris { count, .. } => {
                    for _ in 0..*count {
                        tri.extend_from_slice(row);
                    }
                }
                CellRef::Tet(_) => tet.extend_from_slice(row),
                CellRef::Dropped => {}
            }
        }
        // A short array (fewer rows than cells) leaves NaN gaps and is `partial`, as in §6.2.
        let partial = values.len() / ncomp < self.refs.len();
        tri.resize(self.tris.len() * ncomp, f32::NAN);
        tet.resize(self.tets.len() * ncomp, f32::NAN);
        if ncomp == 1 && self.tri_tags.is_none() && self.tet_tags.is_none() && is_tag_name(name) {
            self.tri_tags = Some(tri.iter().map(|v| as_tag(*v)).collect());
            self.tet_tags = Some(tet.iter().map(|v| as_tag(*v)).collect());
        }
        let stats = field_stats_parts(&[&tri, &tet], ncomp);
        self.elm_fields.push(ElmField {
            name: name.to_string(),
            ncomp,
            tri,
            tet,
            units: None,
            partial,
            stats,
        });
    }

    /// Validate every index against the node count and build the [`Mesh`].
    pub fn finish(self) -> crate::Result<Mesh> {
        let n = self.nodes.len();
        for t in &self.tris {
            for i in t {
                if *i as usize >= n {
                    return Err(parse_err(format!("triangle references node {i} of {n}")));
                }
            }
        }
        for t in &self.tets {
            for i in t {
                if *i as usize >= n {
                    return Err(parse_err(format!("tetrahedron references node {i} of {n}")));
                }
            }
        }
        let n_tets = self.tets.len();
        let tri_tags = self.tri_tags.unwrap_or_else(|| vec![0; self.tris.len()]);
        let tet_tags = self.tet_tags.unwrap_or_else(|| vec![0; n_tets]);
        Ok(Mesh {
            bounds: bounds_of(&self.nodes),
            nodes: self.nodes,
            tris: self.tris,
            tri_tags,
            tets: self.tets,
            tet_tags,
            // §6.2: `Some` only when an n-gon really occurred.
            tri_edge_mask: self.saw_ngon.then_some(self.mask),
            node_fields: self.node_fields,
            elm_fields: self.elm_fields,
            physical_names: Vec::new(),
            gmsh_node_numbers: None,
            gmsh_elm_numbers: None,
            // Identity, like `read_msh`; `tvx_geom::morton_reorder` replaces it (§6.3).
            tet_perm: (0..n_tets as u32).collect(),
            skipped: self.skipped.into_iter().collect(),
            label_table: None,
        })
    }
}

/// The cell-array names that double as element tags, compared case-insensitively:
/// `material`, `tag`, `tags`, `region`, `label`, `labels`, `gmsh:physical`, `elementtag`,
/// `elem_tags`, `medit:ref`, `ref`.
pub fn is_tag_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "material"
            | "tag"
            | "tags"
            | "region"
            | "label"
            | "labels"
            | "gmsh:physical"
            | "elementtag"
            | "elem_tags"
            | "medit:ref"
            | "ref"
    )
}

fn as_tag(v: f32) -> i32 {
    if v.is_finite() {
        v.round().clamp(i32::MIN as f32, i32::MAX as f32) as i32
    } else {
        0
    }
}

/// The scalar element types of the VTK family (legacy names and XML names), with their widths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Num {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
}

impl Num {
    pub fn parse(s: &str) -> Option<Num> {
        Some(match s {
            "char" | "Int8" => Num::I8,
            "unsigned_char" | "bit" | "UInt8" => Num::U8,
            "short" | "Int16" => Num::I16,
            "unsigned_short" | "UInt16" => Num::U16,
            "int" | "Int32" => Num::I32,
            "unsigned_int" | "UInt32" => Num::U32,
            // VTK writes `long` as 8 bytes on every 64-bit host (vtkTypeInt64 is the wire type).
            "long" | "vtktypeint64" | "Int64" | "vtkIdType" => Num::I64,
            "unsigned_long" | "vtktypeuint64" | "UInt64" => Num::U64,
            "float" | "Float32" => Num::F32,
            "double" | "Float64" => Num::F64,
            _ => return None,
        })
    }

    pub fn size(self) -> usize {
        match self {
            Num::I8 | Num::U8 => 1,
            Num::I16 | Num::U16 => 2,
            Num::I32 | Num::U32 | Num::F32 => 4,
            Num::I64 | Num::U64 | Num::F64 => 8,
        }
    }

    /// Decode one value from exactly `self.size()` bytes.
    pub fn decode(self, b: &[u8], big: bool) -> f64 {
        macro_rules! n {
            ($t:ty, $w:expr) => {{
                let a: [u8; $w] = b[..$w].try_into().unwrap();
                (if big {
                    <$t>::from_be_bytes(a)
                } else {
                    <$t>::from_le_bytes(a)
                }) as f64
            }};
        }
        match self {
            Num::I8 => b[0] as i8 as f64,
            Num::U8 => b[0] as f64,
            Num::I16 => n!(i16, 2),
            Num::U16 => n!(u16, 2),
            Num::I32 => n!(i32, 4),
            Num::U32 => n!(u32, 4),
            Num::I64 => n!(i64, 8),
            Num::U64 => n!(u64, 8),
            Num::F32 => n!(f32, 4),
            Num::F64 => n!(f64, 8),
        }
    }

    /// Decode `n` values from a raw block; `Err` when the block is short.
    pub fn decode_all(self, raw: &[u8], n: usize, big: bool) -> crate::Result<Vec<f64>> {
        let want = n
            .checked_mul(self.size())
            .ok_or_else(|| parse_err("array size overflow"))?;
        if raw.len() < want {
            return Err(parse_err(format!(
                "truncated binary array: wanted {want} bytes, have {}",
                raw.len()
            )));
        }
        Ok(raw[..want]
            .chunks_exact(self.size())
            .map(|c| self.decode(c, big))
            .collect())
    }
}

/// `(name, ncomp, row-major values)` — one decoded attribute array.
pub type NamedArray = (String, usize, Vec<f32>);

/// Narrow a decoded array to f32 for a field payload.
pub fn narrow(v: &[f64]) -> Vec<f32> {
    v.iter().map(|x| *x as f32).collect()
}

/// A decoded index array → `u32`, rejecting negatives and anything past `u32::MAX`.
pub fn to_indices(v: &[f64]) -> crate::Result<Vec<u32>> {
    v.iter()
        .map(|x| {
            if *x < 0.0 || *x > u32::MAX as f64 || x.fract() != 0.0 {
                Err(parse_err(format!("bad connectivity index {x}")))
            } else {
                Ok(*x as u32)
            }
        })
        .collect()
}

/// Points from a flat `x y z x y z …` array.
pub fn to_points(v: &[f64]) -> crate::Result<Vec<[f32; 3]>> {
    if !v.len().is_multiple_of(3) {
        return Err(parse_err(format!(
            "point array holds {} values, not a multiple of 3",
            v.len()
        )));
    }
    Ok(v.chunks_exact(3)
        .map(|c| [c[0] as f32, c[1] as f32, c[2] as f32])
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_data_follows_the_cells_through_fanning_and_dropping() {
        let mut a = Assembly {
            nodes: vec![[0.0; 3]; 6],
            ..Default::default()
        };
        a.add_vtk_cell(VTK_QUAD, &[0, 1, 2, 3]); // 2 tris
        a.add_vtk_cell(3, &[0, 1]); // VTK_LINE, dropped
        a.add_vtk_cell(VTK_TETRA, &[0, 1, 2, 4]);
        a.add_vtk_cell(VTK_TRIANGLE, &[1, 2, 5]);
        a.push_cell_field("material", 1, &[7.0, 8.0, 9.0, 10.0]);
        let m = a.finish().unwrap();
        assert_eq!(m.tris.len(), 3);
        assert_eq!(m.tets.len(), 1);
        assert_eq!(m.skipped, vec![(3, 1)]);
        assert_eq!(m.tri_edge_mask.as_deref(), Some(&[0b101, 0b011, 0b111][..]));
        assert_eq!(m.elm_fields[0].tri, vec![7.0, 7.0, 10.0]);
        assert_eq!(m.elm_fields[0].tet, vec![9.0]);
        assert_eq!(m.tri_tags, vec![7, 7, 10]);
        assert_eq!(m.tet_tags, vec![9]);
    }

    #[test]
    fn an_out_of_range_index_is_a_parse_error() {
        let mut a = Assembly {
            nodes: vec![[0.0; 3]; 3],
            ..Default::default()
        };
        a.add_vtk_cell(VTK_TRIANGLE, &[0, 1, 3]);
        assert!(matches!(a.finish(), Err(tvx_core::Error::Parse(_))));
    }

    #[test]
    fn a_pixel_is_reordered_before_fanning() {
        let mut a = Assembly {
            nodes: vec![[0.0; 3]; 4],
            ..Default::default()
        };
        a.add_vtk_cell(VTK_PIXEL, &[0, 1, 2, 3]);
        assert_eq!(a.tris, vec![[0, 1, 3], [0, 3, 2]]);
    }

    #[test]
    fn big_endian_decoding() {
        assert_eq!(Num::F32.decode(&1.5f32.to_be_bytes(), true), 1.5);
        assert_eq!(Num::I32.decode(&(-7i32).to_be_bytes(), true), -7.0);
        assert_eq!(Num::I64.decode(&(-7i64).to_le_bytes(), false), -7.0);
        assert!(Num::F64.decode_all(&[0u8; 8], 2, true).is_err());
    }
}
