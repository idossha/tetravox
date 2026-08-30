//! MEDIT / INRIA `.mesh` (§6.2), ASCII only. `Vertices`, `Triangles` and `Tetrahedra` are read;
//! each record's trailing **reference integer becomes the element tag** (`tri_tags` /
//! `tet_tags`) and is also kept as the one-component `ElmField` `medit:ref` (the name meshio
//! uses), through the shared tag-array rule in `cells.rs`. `Edges`, `Quadrilaterals`, `Hexahedra`, `Prisms` and `Pyramids` are counted into
//! `Mesh::skipped` under their Gmsh element-type codes (1, 3, 5, 6, 7); every other block is
//! skipped silently. The binary `.meshb` dialect is `Error::Unsupported`.

use tvx_core::Result;

use crate::cells::Assembly;
use crate::util::{parse_err, str_of, trim, unsupported, Reader};
use crate::Mesh;

pub fn looks_like(bytes: &[u8]) -> bool {
    trim(&bytes[..bytes.len().min(256)]).starts_with(b"MeshVersionFormatted")
}

/// A `.meshb` starts with the `MeshVersionFormatted` keyword code (1) as a native i32, then the
/// version (1..4) as another.
pub fn looks_like_binary(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    let code = i32::from_le_bytes(bytes[0..4].try_into().unwrap());
    let ver = i32::from_le_bytes(bytes[4..8].try_into().unwrap());
    let code_be = i32::from_be_bytes(bytes[0..4].try_into().unwrap());
    let ver_be = i32::from_be_bytes(bytes[4..8].try_into().unwrap());
    (code == 1 && (1..=4).contains(&ver)) || (code_be == 1 && (1..=4).contains(&ver_be))
}

/// Blocks with one record per line; the count follows the keyword (same line or next).
fn count(r: &mut Reader) -> Result<usize> {
    let n = r.usize_tok()?;
    r.line()?; // the rest of the count's line
    Ok(n)
}

pub fn read(bytes: &[u8]) -> Result<Mesh> {
    if looks_like_binary(bytes) {
        return Err(unsupported("binary MEDIT (.meshb)"));
    }
    let mut r = Reader::new(bytes);
    let mut dim = 3usize;
    let mut a = Assembly::default();
    // One reference per kept cell, in file order — pushed beside every add_polygon / add_tet.
    let mut refs: Vec<f32> = Vec::new();
    let mut saw_header = false;
    while !r.eof() {
        r.skip_ws();
        if r.eof() {
            break;
        }
        if r.b[r.pos] == b'#' {
            r.line()?;
            continue;
        }
        let kw = str_of(r.token()?)?;
        match kw {
            "MeshVersionFormatted" => {
                r.token()?;
                saw_header = true;
            }
            "Dimension" => {
                dim = r.usize_tok()?;
                if dim != 2 && dim != 3 {
                    return Err(unsupported(format!("MEDIT Dimension {dim}")));
                }
            }
            "Vertices" => {
                let n = count(&mut r)?;
                a.nodes.reserve_exact(n);
                for _ in 0..n {
                    let mut v = [0f32; 3];
                    for slot in v.iter_mut().take(dim) {
                        *slot = r.f64_tok()? as f32;
                    }
                    r.token()?; // vertex reference
                    a.nodes.push(v);
                }
            }
            "Triangles" => {
                let n = count(&mut r)?;
                for _ in 0..n {
                    let t = [index(&mut r)?, index(&mut r)?, index(&mut r)?];
                    refs.push(r.i32_tok()? as f32);
                    a.add_polygon(&t);
                }
            }
            "Tetrahedra" => {
                let n = count(&mut r)?;
                for _ in 0..n {
                    let t = [
                        index(&mut r)?,
                        index(&mut r)?,
                        index(&mut r)?,
                        index(&mut r)?,
                    ];
                    refs.push(r.i32_tok()? as f32);
                    a.add_tet(t);
                }
            }
            "Edges" | "Quadrilaterals" | "Hexahedra" | "Prisms" | "Pyramids" => {
                let code = match kw {
                    "Edges" => 1,
                    "Quadrilaterals" => 3,
                    "Hexahedra" => 5,
                    "Prisms" => 6,
                    _ => 7,
                };
                let n = count(&mut r)?;
                for _ in 0..n {
                    r.line()?;
                }
                a.skip_uncounted(code, n as u64);
            }
            "End" => break,
            _ if !saw_header => {
                return Err(parse_err(format!(
                    "not a MEDIT mesh (first keyword {kw:?})"
                )));
            }
            _ => {
                // Corners, RequiredVertices, Ridges, Normals, Tangents, SubDomain…: a count
                // then one record per line.
                if let Ok(n) = count(&mut r) {
                    for _ in 0..n {
                        if r.eof() {
                            break;
                        }
                        r.line()?;
                    }
                }
            }
        }
    }
    if !saw_header {
        return Err(parse_err("not a MEDIT mesh (no MeshVersionFormatted)"));
    }
    // `medit:ref` is a tag name (§6.2's rule), so this fills tri_tags / tet_tags as well.
    a.push_cell_field("medit:ref", 1, &refs);
    a.finish()
}

/// A 1-based MEDIT vertex index → 0-based.
fn index(r: &mut Reader) -> Result<u32> {
    let i = r.i64_tok()?;
    if i < 1 || i > u32::MAX as i64 {
        return Err(parse_err(format!(
            "MEDIT vertex index {i} (indices are 1-based)"
        )));
    }
    Ok((i - 1) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tvx_core::Error;

    const SRC: &str = "MeshVersionFormatted 2\nDimension\n3\n# comment\nVertices\n5\n\
0 0 0 0\n1 0 0 0\n0 1 0 0\n0 0 1 0\n1 1 1 0\nEdges\n1\n1 2 9\nTriangles\n1\n1 2 3 1002\n\
Tetrahedra\n2\n1 2 3 4 2\n1 2 3 5 3\nEnd\n";

    #[test]
    fn references_become_tags_and_edges_are_counted() {
        let m = read(SRC.as_bytes()).unwrap();
        assert_eq!(m.nodes.len(), 5);
        assert_eq!(m.tris, vec![[0, 1, 2]]);
        assert_eq!(m.tri_tags, vec![1002]);
        assert_eq!(m.tets, vec![[0, 1, 2, 3], [0, 1, 2, 4]]);
        assert_eq!(m.tet_tags, vec![2, 3]);
        assert_eq!(m.skipped, vec![(1, 1)]);
        assert_eq!(m.elm_fields[0].name, "medit:ref");
        assert_eq!(m.elm_fields[0].tet, vec![2.0, 3.0]);
        assert!(m.tri_edge_mask.is_none());
        assert!(looks_like(SRC.as_bytes()));
    }

    #[test]
    fn a_bad_index_is_refused() {
        let src = SRC.replace("1 2 3 5 3\n", "1 2 3 6 3\n");
        assert!(matches!(read(src.as_bytes()), Err(Error::Parse(_))));
        let src = SRC.replace("1 2 3 5 3\n", "0 2 3 5 3\n");
        assert!(matches!(read(src.as_bytes()), Err(Error::Parse(_))));
    }

    #[test]
    fn meshb_is_unsupported() {
        let mut b = 1i32.to_le_bytes().to_vec();
        b.extend_from_slice(&2i32.to_le_bytes());
        b.extend_from_slice(&[0u8; 32]);
        assert!(looks_like_binary(&b));
        assert!(matches!(read(&b), Err(Error::Unsupported(_))));
    }
}
