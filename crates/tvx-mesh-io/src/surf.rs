//! STL, PLY and OBJ (§6.2).
//!
//! `read_stl` emits `tri_edge_mask = None` — an STL is triangles all the way down. `read_ply` and
//! `read_obj` fan-triangulate n-gons and **must** emit a matching mask so the barycentric
//! wireframe does not draw the invented diagonal.

use tvx_core::Result;

use crate::gifti::bounds_of;
use crate::util::{parse_err, str_of, trim, unsupported, Reader, VertexWelder};
use crate::Mesh;

/// Fan-triangulate one n-gon and append the §6.2/§6.3 edge mask.
///
/// Bit `i` of the mask is set when edge `i` — the edge **opposite corner `i`** — is a real edge of
/// the original polygon. For a quad `(a,b,c,d)` the fan is `(a,b,c) + (a,c,d)`: the diagonal `a–c`
/// is opposite `b` in the first triangle (bit 1 clear ⇒ `0b101`) and opposite `d` in the second
/// (bit 2 clear ⇒ `0b011`).
pub fn fan(poly: &[u32], tris: &mut Vec<[u32; 3]>, mask: &mut Vec<u8>) {
    if poly.len() < 3 {
        return;
    }
    let last = poly.len() - 3;
    for k in 0..=last {
        tris.push([poly[0], poly[k + 1], poly[k + 2]]);
        let mut m = 0b001u8; // edge (v_{k+1}, v_{k+2}) is always a polygon edge
        if k == last {
            m |= 0b010; // the closing edge (v_{n-1}, v_0)
        }
        if k == 0 {
            m |= 0b100; // the opening edge (v_0, v_1)
        }
        mask.push(m);
    }
}

fn finish(nodes: Vec<[f32; 3]>, tris: Vec<[u32; 3]>, mask: Option<Vec<u8>>) -> Result<Mesh> {
    for t in &tris {
        for i in t {
            if *i as usize >= nodes.len() {
                return Err(parse_err(format!(
                    "face references vertex {i} of {}",
                    nodes.len()
                )));
            }
        }
    }
    let tri_tags = vec![0i32; tris.len()];
    Ok(Mesh {
        bounds: bounds_of(&nodes),
        nodes,
        tris,
        tri_tags,
        tets: Vec::new(),
        tet_tags: Vec::new(),
        tri_edge_mask: mask,
        node_fields: Vec::new(),
        elm_fields: Vec::new(),
        physical_names: Vec::new(),
        gmsh_node_numbers: None,
        gmsh_elm_numbers: None,
        tet_perm: Vec::new(),
        skipped: Vec::new(),
    })
}

/// `Some(mask)` only when at least one face really was an n-gon (§6.2: a fully unmasked mesh takes
/// the engine's constant-attribute fast path instead).
fn mask_if_used(mask: Vec<u8>, saw_ngon: bool) -> Option<Vec<u8>> {
    saw_ngon.then_some(mask)
}

// -------------------------------------------------------------------------------------------
// STL
// -------------------------------------------------------------------------------------------

/// A binary STL is exactly `84 + 50 × count` bytes. Testing that is more reliable than the
/// `solid` prefix, which binary writers also emit.
fn stl_is_binary(bytes: &[u8]) -> bool {
    if bytes.len() < 84 {
        return false;
    }
    let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    match count.checked_mul(50).and_then(|n| n.checked_add(84)) {
        Some(want) => want == bytes.len(),
        None => false,
    }
}

pub fn read_stl(bytes: &[u8]) -> Result<Mesh> {
    // STL has no vertex table; §6.2 leaves the policy open and the manifest accepts either. An
    // exact-bits weld never merges two points the writer meant to keep apart, and it is what
    // gives the surface shared normals.
    let mut w = VertexWelder::default();
    let mut tris = Vec::new();
    if stl_is_binary(bytes) {
        let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
        let body = &bytes[84..];
        tris.reserve(count);
        for f in body.chunks_exact(50) {
            let mut v = [0u32; 3];
            for (k, slot) in v.iter_mut().enumerate() {
                let o = 12 + k * 12;
                *slot = w.insert([
                    f32::from_le_bytes(f[o..o + 4].try_into().unwrap()),
                    f32::from_le_bytes(f[o + 4..o + 8].try_into().unwrap()),
                    f32::from_le_bytes(f[o + 8..o + 12].try_into().unwrap()),
                ]);
            }
            tris.push(v);
        }
    } else {
        let text = str_of(bytes)?;
        let mut pending: Vec<u32> = Vec::with_capacity(3);
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("vertex") {
                let mut it = rest.split_whitespace();
                let mut v = [0f32; 3];
                for slot in v.iter_mut() {
                    *slot = it
                        .next()
                        .and_then(|t| t.parse::<f32>().ok())
                        .ok_or_else(|| parse_err(format!("bad STL vertex line {line:?}")))?;
                }
                pending.push(w.insert(v));
            } else if line.starts_with("endloop") {
                if pending.len() >= 3 {
                    // An ascii STL loop is a triangle; anything longer is malformed, but fanning
                    // it is friendlier than refusing the file.
                    let mut mask = Vec::new();
                    fan(&pending, &mut tris, &mut mask);
                }
                pending.clear();
            }
        }
    }
    // §6.2: read_stl emits None.
    finish(w.nodes, tris, None)
}

// -------------------------------------------------------------------------------------------
// PLY
// -------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum PlyType {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl PlyType {
    fn parse(s: &str) -> Option<PlyType> {
        Some(match s {
            "char" | "int8" => PlyType::I8,
            "uchar" | "uint8" => PlyType::U8,
            "short" | "int16" => PlyType::I16,
            "ushort" | "uint16" => PlyType::U16,
            "int" | "int32" => PlyType::I32,
            "uint" | "uint32" => PlyType::U32,
            "float" | "float32" => PlyType::F32,
            "double" | "float64" => PlyType::F64,
            _ => return None,
        })
    }
    fn size(self) -> usize {
        match self {
            PlyType::I8 | PlyType::U8 => 1,
            PlyType::I16 | PlyType::U16 => 2,
            PlyType::I32 | PlyType::U32 | PlyType::F32 => 4,
            PlyType::F64 => 8,
        }
    }
    fn read(self, r: &mut Reader, big: bool) -> Result<f64> {
        let b = r.take(self.size())?;
        macro_rules! n {
            ($t:ty, $w:expr) => {{
                let a: [u8; $w] = b.try_into().unwrap();
                (if big {
                    <$t>::from_be_bytes(a)
                } else {
                    <$t>::from_le_bytes(a)
                }) as f64
            }};
        }
        Ok(match self {
            PlyType::I8 => b[0] as i8 as f64,
            PlyType::U8 => b[0] as f64,
            PlyType::I16 => n!(i16, 2),
            PlyType::U16 => n!(u16, 2),
            PlyType::I32 => n!(i32, 4),
            PlyType::U32 => n!(u32, 4),
            PlyType::F32 => n!(f32, 4),
            PlyType::F64 => n!(f64, 8),
        })
    }
}

struct PlyProperty {
    name: String,
    ty: PlyType,
    /// `Some(count type)` for `property list <count> <item> …`.
    list: Option<PlyType>,
}

struct PlyElement {
    name: String,
    count: usize,
    props: Vec<PlyProperty>,
}

pub fn read_ply(bytes: &[u8]) -> Result<Mesh> {
    let mut r = Reader::new(bytes);
    if trim(r.line()?) != b"ply" {
        return Err(parse_err("not a PLY file"));
    }
    let mut format = String::new();
    let mut elements: Vec<PlyElement> = Vec::new();
    loop {
        let line = trim(r.line()?);
        let s = str_of(line)?.trim();
        if s == "end_header" {
            break;
        }
        let mut it = s.split_whitespace();
        match it.next() {
            Some("format") => format = it.next().unwrap_or("").to_string(),
            Some("comment") | Some("obj_info") | None => {}
            Some("element") => {
                let name = it.next().unwrap_or("").to_string();
                let count = it
                    .next()
                    .and_then(|t| t.parse::<usize>().ok())
                    .ok_or_else(|| parse_err(format!("bad PLY element line {s:?}")))?;
                elements.push(PlyElement {
                    name,
                    count,
                    props: Vec::new(),
                });
            }
            Some("property") => {
                let e = elements
                    .last_mut()
                    .ok_or_else(|| parse_err("PLY property before any element"))?;
                let first = it.next().unwrap_or("");
                if first == "list" {
                    let count_ty = PlyType::parse(it.next().unwrap_or(""))
                        .ok_or_else(|| parse_err(format!("bad PLY list count type in {s:?}")))?;
                    let item_ty = PlyType::parse(it.next().unwrap_or(""))
                        .ok_or_else(|| parse_err(format!("bad PLY list item type in {s:?}")))?;
                    e.props.push(PlyProperty {
                        name: it.next().unwrap_or("").to_string(),
                        ty: item_ty,
                        list: Some(count_ty),
                    });
                } else {
                    let ty = PlyType::parse(first)
                        .ok_or_else(|| parse_err(format!("bad PLY property type in {s:?}")))?;
                    e.props.push(PlyProperty {
                        name: it.next().unwrap_or("").to_string(),
                        ty,
                        list: None,
                    });
                }
            }
            Some(_) => {}
        }
    }

    let (ascii, big) = match format.as_str() {
        "ascii" => (true, false),
        "binary_little_endian" => (false, false),
        "binary_big_endian" => (false, true),
        other => return Err(unsupported(format!("PLY format {other:?}"))),
    };

    let mut nodes: Vec<[f32; 3]> = Vec::new();
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let mut mask: Vec<u8> = Vec::new();
    let mut saw_ngon = false;
    let mut poly: Vec<u32> = Vec::new();

    for e in &elements {
        let is_vertex = e.name == "vertex";
        let is_face = e.name == "face";
        if is_vertex {
            nodes.reserve_exact(e.count);
        } else if is_face {
            tris.reserve(e.count);
        }
        for _ in 0..e.count {
            let mut xyz = [0f64; 3];
            poly.clear();
            for prop in &e.props {
                match prop.list {
                    None => {
                        let v = if ascii {
                            r.f64_tok()?
                        } else {
                            prop.ty.read(&mut r, big)?
                        };
                        if is_vertex {
                            match prop.name.as_str() {
                                "x" => xyz[0] = v,
                                "y" => xyz[1] = v,
                                "z" => xyz[2] = v,
                                _ => {}
                            }
                        }
                    }
                    Some(count_ty) => {
                        let n = if ascii {
                            r.u64_tok()? as usize
                        } else {
                            count_ty.read(&mut r, big)? as usize
                        };
                        for _ in 0..n {
                            let v = if ascii {
                                r.f64_tok()?
                            } else {
                                prop.ty.read(&mut r, big)?
                            };
                            if is_face && prop.name.starts_with("vertex_") {
                                poly.push(v as u32);
                            }
                        }
                    }
                }
            }
            if is_vertex {
                nodes.push([xyz[0] as f32, xyz[1] as f32, xyz[2] as f32]);
            } else if is_face && poly.len() >= 3 {
                if poly.len() > 3 {
                    saw_ngon = true;
                }
                fan(&poly, &mut tris, &mut mask);
            }
        }
    }

    finish(nodes, tris, mask_if_used(mask, saw_ngon))
}

// -------------------------------------------------------------------------------------------
// OBJ
// -------------------------------------------------------------------------------------------

pub fn read_obj(bytes: &[u8]) -> Result<Mesh> {
    let text = str_of(bytes)?;
    let mut nodes: Vec<[f32; 3]> = Vec::new();
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let mut mask: Vec<u8> = Vec::new();
    let mut saw_ngon = false;
    let mut poly: Vec<u32> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        match it.next() {
            Some("v") => {
                let mut v = [0f32; 3];
                for slot in v.iter_mut() {
                    *slot = it
                        .next()
                        .and_then(|t| t.parse::<f32>().ok())
                        .ok_or_else(|| parse_err(format!("bad OBJ vertex line {line:?}")))?;
                }
                nodes.push(v);
            }
            Some("f") => {
                poly.clear();
                for tok in it {
                    // `v`, `v/vt`, `v//vn`, `v/vt/vn` — only the first field is the position.
                    let first = tok.split('/').next().unwrap_or("");
                    let idx: i64 = first
                        .parse()
                        .map_err(|_| parse_err(format!("bad OBJ face index {tok:?}")))?;
                    // OBJ indices are 1-based, and negative means "counted back from the end".
                    let zero = if idx > 0 {
                        idx - 1
                    } else if idx < 0 {
                        nodes.len() as i64 + idx
                    } else {
                        return Err(parse_err("OBJ face index 0 (indices are 1-based)"));
                    };
                    if zero < 0 || zero as usize >= nodes.len() {
                        return Err(parse_err(format!(
                            "OBJ face index {idx} out of range ({} vertices so far)",
                            nodes.len()
                        )));
                    }
                    poly.push(zero as u32);
                }
                if poly.len() >= 3 {
                    if poly.len() > 3 {
                        saw_ngon = true;
                    }
                    fan(&poly, &mut tris, &mut mask);
                }
            }
            _ => {}
        }
    }

    finish(nodes, tris, mask_if_used(mask, saw_ngon))
}

/// Cheap sniffs, used by `sniff` (§6.2).
pub fn looks_like_ply(bytes: &[u8]) -> bool {
    bytes.starts_with(b"ply\n") || bytes.starts_with(b"ply\r\n")
}

pub fn looks_like_stl(bytes: &[u8]) -> bool {
    stl_is_binary(bytes) || bytes.starts_with(b"solid")
}

pub fn looks_like_obj(bytes: &[u8]) -> bool {
    // An OBJ has no magic; recognise it by its first meaningful line being a v/vn/vt/f/g/o/mtllib.
    let head = &bytes[..bytes.len().min(4096)];
    let Ok(text) = std::str::from_utf8(head) else {
        return false;
    };
    let mut saw_v = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let kw = line.split_whitespace().next().unwrap_or("");
        match kw {
            "v" => saw_v = true,
            "vn" | "vt" | "vp" | "g" | "o" | "s" | "usemtl" | "mtllib" => {}
            "f" => return saw_v,
            _ => return false,
        }
    }
    saw_v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quad_fans_into_the_masks_the_contract_names() {
        let mut tris = Vec::new();
        let mut mask = Vec::new();
        fan(&[0, 1, 2, 3], &mut tris, &mut mask);
        assert_eq!(tris, vec![[0, 1, 2], [0, 2, 3]]);
        assert_eq!(mask, vec![0b101, 0b011]);
    }

    #[test]
    fn a_triangle_is_fully_unmasked() {
        let mut tris = Vec::new();
        let mut mask = Vec::new();
        fan(&[7, 8, 9], &mut tris, &mut mask);
        assert_eq!(tris, vec![[7, 8, 9]]);
        assert_eq!(mask, vec![0b111]);
    }

    #[test]
    fn a_pentagon_masks_only_its_two_invented_diagonals() {
        let mut tris = Vec::new();
        let mut mask = Vec::new();
        fan(&[0, 1, 2, 3, 4], &mut tris, &mut mask);
        assert_eq!(tris, vec![[0, 1, 2], [0, 2, 3], [0, 3, 4]]);
        // 3 triangles × 3 edges = 9 half-edges; 5 are polygon edges, and the two diagonals appear
        // twice each, so exactly 4 bits are clear.
        assert_eq!(mask, vec![0b101, 0b001, 0b011]);
        let set: u32 = mask.iter().map(|m| m.count_ones()).sum();
        assert_eq!(set, 5);
    }

    #[test]
    fn obj_negative_indices_count_back_from_the_end() {
        let src = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n";
        let m = read_obj(src.as_bytes()).unwrap();
        assert_eq!(m.tris, vec![[0, 1, 2]]);
        assert!(m.tri_edge_mask.is_none());
    }

    #[test]
    fn a_binary_stl_is_detected_by_its_exact_length() {
        let mut b = vec![0u8; 84];
        b[80..84].copy_from_slice(&2u32.to_le_bytes());
        b.extend(std::iter::repeat_n(0u8, 100));
        assert!(stl_is_binary(&b));
        b.push(0);
        assert!(!stl_is_binary(&b));
    }
}
