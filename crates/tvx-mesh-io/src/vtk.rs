//! VTK legacy `.vtk` (§6.2): `DATASET POLYDATA` and `DATASET UNSTRUCTURED_GRID`, ASCII and BINARY.
//!
//! **Binary payloads are big-endian regardless of host** — that is the legacy format's rule, and
//! every `float`/`int` blob after a keyword line is decoded with [`Num::decode`]`(…, big = true)`.
//! Cell types 5 / 7 / 8 / 9 (triangle, polygon, pixel, quad) become `tris` (n-gons fanned with a
//! `tri_edge_mask`), 10 (tetra) becomes `tets`, everything else is counted into `Mesh::skipped`
//! under its **VTK** cell-type code. The VTK 9 `CELLS` layout (`OFFSETS` + `CONNECTIVITY`
//! sub-arrays) is accepted beside the classic `count, i0, i1, …` stream.

use tvx_core::{Phase, ProgressSink, Result};

use crate::cells::{
    narrow, to_indices, to_points, Assembly, NamedArray, Num, VTK_POLY_LINE, VTK_POLY_VERTEX,
    VTK_TRIANGLE_STRIP,
};
use crate::util::{parse_err, str_of, trim, unsupported, Reader};
use crate::Mesh;

pub fn looks_like(bytes: &[u8]) -> bool {
    trim(&bytes[..bytes.len().min(64)]).starts_with(b"# vtk DataFile")
}

struct Vtk<'a> {
    r: Reader<'a>,
    binary: bool,
}

impl<'a> Vtk<'a> {
    /// The rest of the current keyword line as whitespace-separated words.
    fn args(&mut self) -> Result<Vec<String>> {
        let l = self.r.line()?;
        Ok(str_of(l)?.split_whitespace().map(str::to_string).collect())
    }

    fn peek_token(&mut self) -> Option<&'a [u8]> {
        let save = self.r.pos;
        let t = self.r.token().ok();
        self.r.pos = save;
        t
    }

    /// `n` values of `ty`. ASCII values are tokens; BINARY ones are a big-endian blob that
    /// starts right after the keyword line and is followed by one newline.
    fn values(&mut self, ty: Num, n: usize) -> Result<Vec<f64>> {
        if self.binary {
            let raw = self.r.take(
                n.checked_mul(ty.size())
                    .ok_or_else(|| parse_err("VTK array size overflow"))?,
            )?;
            let v = ty.decode_all(raw, n, true)?;
            if self.r.b.get(self.r.pos) == Some(&b'\n') {
                self.r.pos += 1;
            }
            Ok(v)
        } else {
            let mut v = Vec::with_capacity(n);
            for _ in 0..n {
                v.push(self.r.f64_tok()?);
            }
            Ok(v)
        }
    }

    fn num_type(&self, word: Option<&String>) -> Result<Num> {
        let w = word.map(String::as_str).unwrap_or("");
        Num::parse(w).ok_or_else(|| unsupported(format!("VTK data type {w:?}")))
    }

    /// A `KEYWORD n size` cell block in either layout → (cell connectivities).
    ///
    /// Classic: `size` ints of `count, i0 … i_{count−1}` repeated `n` times. VTK 9: `n` is the
    /// offsets length (`n_cells + 1`) and `size` the connectivity length, each in its own
    /// `OFFSETS` / `CONNECTIVITY` sub-array.
    fn cell_block(&mut self, args: &[String]) -> Result<Vec<Vec<u32>>> {
        let n = arg_usize(args, 0)?;
        let size = arg_usize(args, 1)?;
        if self.peek_token() == Some(b"OFFSETS") {
            self.r.token()?;
            let a = self.args()?;
            let ty = self.num_type(a.first())?;
            let offsets = to_indices(&self.values(ty, n)?)?;
            let kw = self.r.token()?;
            if kw != b"CONNECTIVITY" {
                return Err(parse_err("VTK OFFSETS without CONNECTIVITY"));
            }
            let a = self.args()?;
            let ty = self.num_type(a.first())?;
            let conn = to_indices(&self.values(ty, size)?)?;
            let mut cells = Vec::with_capacity(n.saturating_sub(1));
            for w in offsets.windows(2) {
                let (a, b) = (w[0] as usize, w[1] as usize);
                if a > b || b > conn.len() {
                    return Err(parse_err(format!(
                        "VTK offsets {a}..{b} exceed connectivity"
                    )));
                }
                cells.push(conn[a..b].to_vec());
            }
            Ok(cells)
        } else {
            let flat = to_indices(&self.values(Num::I32, size)?)?;
            let mut cells = Vec::with_capacity(n);
            let mut at = 0usize;
            for _ in 0..n {
                let count = *flat
                    .get(at)
                    .ok_or_else(|| parse_err("VTK cell stream ended early"))?
                    as usize;
                let end = at + 1 + count;
                if end > flat.len() {
                    return Err(parse_err("VTK cell stream ended early"));
                }
                cells.push(flat[at + 1..end].to_vec());
                at = end;
            }
            Ok(cells)
        }
    }

    /// One attribute array of a `POINT_DATA` / `CELL_DATA` section, or `None` when `kw` is not
    /// an attribute keyword. Returns `(name, ncomp, values)`.
    fn attribute(&mut self, kw: &[u8], n: usize) -> Result<Option<Vec<NamedArray>>> {
        Ok(Some(match kw {
            b"SCALARS" => {
                let a = self.args()?;
                let name = arg_str(&a, 0)?;
                let ty = self.num_type(a.get(1))?;
                let ncomp = a
                    .get(2)
                    .map(|s| s.parse::<usize>())
                    .transpose()
                    .map_err(|e| parse_err(format!("bad SCALARS component count: {e}")))?;
                let ncomp = ncomp.unwrap_or(1).max(1);
                // `LOOKUP_TABLE default` follows on its own line.
                if self.peek_token() == Some(b"LOOKUP_TABLE") {
                    self.r.token()?;
                    self.args()?;
                }
                let v = self.values(ty, n * ncomp)?;
                vec![(name, ncomp, narrow(&v))]
            }
            b"VECTORS" | b"NORMALS" => {
                let a = self.args()?;
                let name = arg_str(&a, 0)?;
                let ty = self.num_type(a.get(1))?;
                let v = self.values(ty, n * 3)?;
                vec![(name, 3, narrow(&v))]
            }
            b"TENSORS" => {
                let a = self.args()?;
                let name = arg_str(&a, 0)?;
                let ty = self.num_type(a.get(1))?;
                let v = self.values(ty, n * 9)?;
                vec![(name, 9, narrow(&v))]
            }
            b"TEXTURE_COORDINATES" => {
                let a = self.args()?;
                let dim = arg_usize(&a, 1)?;
                let ty = self.num_type(a.get(2))?;
                self.values(ty, n * dim)?;
                Vec::new()
            }
            b"COLOR_SCALARS" => {
                let a = self.args()?;
                let ncomp = arg_usize(&a, 1)?;
                let ty = if self.binary { Num::U8 } else { Num::F32 };
                self.values(ty, n * ncomp)?;
                Vec::new()
            }
            b"LOOKUP_TABLE" => {
                let a = self.args()?;
                let size = arg_usize(&a, 1)?;
                let ty = if self.binary { Num::U8 } else { Num::F32 };
                self.values(ty, size * 4)?;
                Vec::new()
            }
            b"FIELD" => self.field(Some(n))?,
            _ => return Ok(None),
        }))
    }

    /// `FIELD name k` then `k` × `name ncomp ntuples type` arrays. With `rows = Some(n)` an
    /// array whose tuple count differs from `n` is read and dropped.
    fn field(&mut self, rows: Option<usize>) -> Result<Vec<NamedArray>> {
        let a = self.args()?;
        let k = arg_usize(&a, 1)?;
        let mut out = Vec::new();
        for _ in 0..k {
            let name = str_of(self.r.token()?)?.to_string();
            let a = self.args()?;
            let ncomp = arg_usize(&a, 0)?.max(1);
            let ntuples = arg_usize(&a, 1)?;
            let ty = self.num_type(a.get(2))?;
            let v = self.values(ty, ncomp * ntuples)?;
            self.skip_metadata()?;
            if rows.is_none_or(|n| n == ntuples) {
                out.push((name, ncomp, narrow(&v)));
            }
        }
        Ok(out)
    }

    /// VTK ≥ 8 writes `METADATA` / `INFORMATION k` / … blocks after arrays, ended by a blank
    /// line. Skip one if it is next.
    fn skip_metadata(&mut self) -> Result<()> {
        if self.peek_token() == Some(b"METADATA") {
            self.r.token()?;
            self.r.line()?;
            while !self.r.eof() {
                if trim(self.r.line()?).is_empty() {
                    break;
                }
            }
        }
        Ok(())
    }
}

fn arg_str(a: &[String], i: usize) -> Result<String> {
    a.get(i)
        .cloned()
        .ok_or_else(|| parse_err(format!("VTK keyword line is missing argument {i}")))
}

fn arg_usize(a: &[String], i: usize) -> Result<usize> {
    arg_str(a, i)?
        .parse::<usize>()
        .map_err(|e| parse_err(format!("bad VTK count: {e}")))
}

pub fn read(bytes: &[u8], p: &mut dyn ProgressSink) -> Result<Mesh> {
    let total = bytes.len() as u64;
    p.report(Phase::Parse, 0, total);
    let mut v = Vtk {
        r: Reader::new(bytes),
        binary: false,
    };
    let head = trim(v.r.line()?);
    if !head.starts_with(b"# vtk DataFile") {
        return Err(parse_err(
            "not a VTK legacy file (no `# vtk DataFile` header)",
        ));
    }
    v.r.line()?; // title
    match trim(v.r.nonblank_line()?) {
        b"ASCII" => v.binary = false,
        b"BINARY" => v.binary = true,
        other => {
            return Err(parse_err(format!(
                "VTK file type {:?} is neither ASCII nor BINARY",
                String::from_utf8_lossy(other)
            )))
        }
    }

    let mut a = Assembly::default();
    let mut polydata = false;
    // `POINT_DATA n` / `CELL_DATA n` set which table the attributes that follow belong to.
    let mut section: Option<(bool, usize)> = None;
    let mut n_cells_declared = 0usize;
    // UNSTRUCTURED_GRID: `CELLS` may precede or follow `CELL_TYPES`.
    let mut pending_cells: Option<Vec<Vec<u32>>> = None;
    let mut pending_types: Option<Vec<u32>> = None;

    while !v.r.eof() {
        v.r.skip_ws();
        if v.r.eof() {
            break;
        }
        let kw = v.r.token()?;
        p.report(Phase::Parse, v.r.pos as u64, total);
        match kw {
            b"DATASET" => {
                let a2 = v.args()?;
                match a2.first().map(String::as_str) {
                    Some("POLYDATA") => polydata = true,
                    Some("UNSTRUCTURED_GRID") => polydata = false,
                    other => {
                        return Err(unsupported(format!(
                            "VTK DATASET {}; only POLYDATA and UNSTRUCTURED_GRID are read",
                            other.unwrap_or("?")
                        )))
                    }
                }
            }
            b"POINTS" => {
                let a2 = v.args()?;
                let n = arg_usize(&a2, 0)?;
                let ty = v.num_type(a2.get(1))?;
                a.nodes = to_points(&v.values(ty, n * 3)?)?;
                v.skip_metadata()?;
            }
            b"POLYGONS" if polydata => {
                let a2 = v.args()?;
                for c in v.cell_block(&a2)? {
                    a.add_polygon(&c);
                }
            }
            b"VERTICES" | b"LINES" | b"TRIANGLE_STRIPS" if polydata => {
                let code = match kw {
                    b"VERTICES" => VTK_POLY_VERTEX,
                    b"LINES" => VTK_POLY_LINE,
                    _ => VTK_TRIANGLE_STRIP,
                };
                let a2 = v.args()?;
                let n = v.cell_block(&a2)?.len();
                for _ in 0..n {
                    a.drop(code);
                }
            }
            b"CELLS" => {
                let a2 = v.args()?;
                pending_cells = Some(v.cell_block(&a2)?);
            }
            b"CELL_TYPES" => {
                let a2 = v.args()?;
                let n = arg_usize(&a2, 0)?;
                pending_types = Some(to_indices(&v.values(Num::I32, n)?)?);
            }
            b"POINT_DATA" => {
                let a2 = v.args()?;
                section = Some((true, arg_usize(&a2, 0)?));
            }
            b"CELL_DATA" => {
                let a2 = v.args()?;
                n_cells_declared = arg_usize(&a2, 0)?;
                section = Some((false, n_cells_declared));
            }
            b"FIELD" if section.is_none() => {
                // Global field data before the dataset: read and discard.
                v.field(None)?;
            }
            b"METADATA" => {
                v.r.pos -= kw.len();
                v.skip_metadata()?;
            }
            other => {
                let Some((is_point, n)) = section else {
                    return Err(parse_err(format!(
                        "unexpected VTK keyword {:?}",
                        String::from_utf8_lossy(other)
                    )));
                };
                let Some(arrays) = v.attribute(other, n)? else {
                    return Err(parse_err(format!(
                        "unexpected VTK attribute keyword {:?}",
                        String::from_utf8_lossy(other)
                    )));
                };
                if let (Some(cells), Some(types)) = (pending_cells.take(), pending_types.take()) {
                    commit_cells(&mut a, cells, types)?;
                }
                for (name, ncomp, values) in arrays {
                    if is_point {
                        if values.len() != a.nodes.len() * ncomp {
                            return Err(parse_err(format!(
                                "VTK point array {name:?} holds {} values for {} points × {ncomp}",
                                values.len(),
                                a.nodes.len()
                            )));
                        }
                        a.push_point_field(&name, ncomp, values);
                    } else {
                        if values.len() != a.refs.len() * ncomp {
                            return Err(parse_err(format!(
                                "VTK cell array {name:?} holds {} values for {} cells × {ncomp}",
                                values.len(),
                                a.refs.len()
                            )));
                        }
                        a.push_cell_field(&name, ncomp, &values);
                    }
                }
                v.skip_metadata()?;
            }
        }
    }
    match (pending_cells, pending_types) {
        (Some(cells), Some(types)) => commit_cells(&mut a, cells, types)?,
        (Some(_), None) => return Err(parse_err("VTK CELLS without CELL_TYPES")),
        _ => {}
    }
    if n_cells_declared != 0 && n_cells_declared != a.refs.len() {
        return Err(parse_err(format!(
            "VTK CELL_DATA declares {n_cells_declared} cells, the dataset has {}",
            a.refs.len()
        )));
    }
    p.report(Phase::Parse, total, total);
    a.finish()
}

fn commit_cells(a: &mut Assembly, cells: Vec<Vec<u32>>, types: Vec<u32>) -> Result<()> {
    if cells.len() != types.len() {
        return Err(parse_err(format!(
            "VTK CELLS has {} cells but CELL_TYPES has {}",
            cells.len(),
            types.len()
        )));
    }
    for (c, t) in cells.iter().zip(types) {
        a.add_vtk_cell(t, c);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tvx_core::{Error, NoProgress};

    const ASCII_UG: &str = "# vtk DataFile Version 3.0\ntitle\nASCII\nDATASET UNSTRUCTURED_GRID\n\
POINTS 5 float\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 1 1\n\
CELLS 3 14\n4 0 1 2 3\n3 0 1 2\n4 0 1 2 4\nCELL_TYPES 3\n10\n5\n10\n\
CELL_DATA 3\nSCALARS material int 1\nLOOKUP_TABLE default\n2 1002 3\n\
POINT_DATA 5\nSCALARS s float\nLOOKUP_TABLE default\n1 2 3 4 5\nVECTORS v float\n\
1 0 0\n0 1 0\n0 0 1\n1 1 0\n0 1 1\n";

    #[test]
    fn ascii_unstructured_grid_with_tags_and_fields() {
        let m = read(ASCII_UG.as_bytes(), &mut NoProgress).unwrap();
        assert_eq!(m.nodes.len(), 5);
        assert_eq!(m.tets, vec![[0, 1, 2, 3], [0, 1, 2, 4]]);
        assert_eq!(m.tris, vec![[0, 1, 2]]);
        assert_eq!(m.tet_tags, vec![2, 3]);
        assert_eq!(m.tri_tags, vec![1002]);
        assert!(m.tri_edge_mask.is_none());
        assert_eq!(m.elm_fields[0].name, "material");
        assert_eq!(m.node_fields.len(), 2);
        assert_eq!(m.node_fields[1].ncomp, 3);
        assert_eq!(m.node_fields[0].stats.max, 5.0);
    }

    #[test]
    fn an_unsupported_cell_type_is_counted_not_fatal() {
        let src = ASCII_UG.replace("CELL_TYPES 3\n10\n5\n10\n", "CELL_TYPES 3\n10\n12\n10\n");
        let m = read(src.as_bytes(), &mut NoProgress).unwrap();
        assert_eq!(m.skipped, vec![(12, 1)]);
        assert!(m.tris.is_empty());
        assert_eq!(m.tets.len(), 2);
        assert_eq!(m.elm_fields[0].tet, vec![2.0, 3.0]);
    }

    #[test]
    fn an_index_past_the_point_count_is_a_parse_error() {
        let src = ASCII_UG.replace("4 0 1 2 4\n", "4 0 1 2 9\n");
        assert!(matches!(
            read(src.as_bytes(), &mut NoProgress),
            Err(Error::Parse(_))
        ));
    }

    #[test]
    fn vtk9_offsets_connectivity_layout() {
        let src = "# vtk DataFile Version 5.1\nt\nASCII\nDATASET UNSTRUCTURED_GRID\n\
POINTS 4 double\n0 0 0 1 0 0 0 1 0 0 0 1\nCELLS 3 7\nOFFSETS vtktypeint64\n0 4 7\n\
CONNECTIVITY vtktypeint64\n0 1 2 3 0 1 2\nCELL_TYPES 2\n10 5\n";
        let m = read(src.as_bytes(), &mut NoProgress).unwrap();
        assert_eq!(m.tets, vec![[0, 1, 2, 3]]);
        assert_eq!(m.tris, vec![[0, 1, 2]]);
    }

    #[test]
    fn binary_is_big_endian_and_truncation_is_a_parse_error() {
        let mut b =
            b"# vtk DataFile Version 3.0\nt\nBINARY\nDATASET POLYDATA\nPOINTS 4 float\n".to_vec();
        for x in [0f32, 0., 0., 1., 0., 0., 1., 1., 0., 0., 1., 0.] {
            b.extend_from_slice(&x.to_be_bytes());
        }
        b.extend_from_slice(b"\nPOLYGONS 1 5\n");
        for i in [4i32, 0, 1, 2, 3] {
            b.extend_from_slice(&i.to_be_bytes());
        }
        b.push(b'\n');
        let m = read(&b, &mut NoProgress).unwrap();
        assert_eq!(m.nodes[3], [0.0, 1.0, 0.0]);
        assert_eq!(m.tris, vec![[0, 1, 2], [0, 2, 3]]);
        assert_eq!(m.tri_edge_mask.as_deref(), Some(&[0b101, 0b011][..]));
        // Chop the last index off the polygon stream.
        let short = &b[..b.len() - 5];
        assert!(matches!(read(short, &mut NoProgress), Err(Error::Parse(_))));
    }

    #[test]
    fn polydata_vertices_and_lines_are_counted_into_skipped() {
        let src = "# vtk DataFile Version 3.0\nt\nASCII\nDATASET POLYDATA\nPOINTS 3 float\n\
0 0 0 1 0 0 0 1 0\nVERTICES 1 2\n1 0\nLINES 1 3\n2 0 1\nPOLYGONS 1 4\n3 0 1 2\n\
CELL_DATA 3\nSCALARS c float\nLOOKUP_TABLE default\n5 6 7\n";
        let m = read(src.as_bytes(), &mut NoProgress).unwrap();
        assert_eq!(m.tris.len(), 1);
        assert_eq!(m.skipped, vec![(VTK_POLY_VERTEX, 1), (VTK_POLY_LINE, 1)]);
        // Cell data rows are in VERTICES, LINES, POLYGONS order.
        assert_eq!(m.elm_fields[0].tri, vec![7.0]);
    }

    #[test]
    fn a_structured_dataset_is_unsupported() {
        let src = "# vtk DataFile Version 3.0\nt\nASCII\nDATASET STRUCTURED_POINTS\n";
        assert!(matches!(
            read(src.as_bytes(), &mut NoProgress),
            Err(Error::Unsupported(_))
        ));
    }
}
