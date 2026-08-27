//! FreeSurfer binary surfaces, `curv` and `.annot` (§6.2). Everything here is **big-endian**.
//!
//! The triangle file's magic is `0xFFFFFE`; the two quad files (`0xFFFFFF` old, `0xFFFFFD` new)
//! are read as well and fan-triangulated, so they carry a `tri_edge_mask`. `read_fs_annot` remaps
//! packed-RGB annotation values to **dense 0..N−1** at parse time and returns the colortable with
//! `LabelEntry::id` holding the original packed id — a 256×1 LUT cannot address a value like
//! 16,711,680 (§6.2, §7.6).

use std::collections::HashMap;

use tvx_core::{Field, LabelEntry, LabelTable, Result};

use crate::gifti::bounds_of;
use crate::stats::field_stats;
use crate::util::{parse_err, unsupported, Reader};
use crate::Mesh;

pub const TRIANGLE_MAGIC: u32 = 0xFF_FF_FE;
pub const QUAD_MAGIC: u32 = 0xFF_FF_FF;
pub const NEW_QUAD_MAGIC: u32 = 0xFF_FF_FD;
/// `curv`'s "new format" marker — numerically the same as [`QUAD_MAGIC`], which is harmless
/// because §6.2 gives surfaces and curvature two separate entry points.
pub const CURV_NEW_MAGIC: u32 = 0xFF_FF_FF;

/// True when the first three bytes are one of the surface magics.
pub fn looks_like_surface(bytes: &[u8]) -> bool {
    if bytes.len() < 3 {
        return false;
    }
    let m = (bytes[0] as u32) << 16 | (bytes[1] as u32) << 8 | bytes[2] as u32;
    m == TRIANGLE_MAGIC || m == QUAD_MAGIC || m == NEW_QUAD_MAGIC
}

pub fn read_surface(bytes: &[u8]) -> Result<Mesh> {
    let mut r = Reader::new(bytes);
    let magic = r.u24_be()?;
    match magic {
        TRIANGLE_MAGIC => read_triangle_file(&mut r),
        QUAD_MAGIC | NEW_QUAD_MAGIC => read_quad_file(&mut r, magic == NEW_QUAD_MAGIC),
        other => Err(unsupported(format!(
            "FreeSurfer surface magic 0x{other:06X}"
        ))),
    }
}

fn read_triangle_file(r: &mut Reader) -> Result<Mesh> {
    // A creation stamp line, then a blank line, then the counts.
    let _stamp = r.line()?;
    let _blank = r.line()?;
    let vnum = r.i32_be()?;
    let fnum = r.i32_be()?;
    if vnum < 0 || fnum < 0 {
        return Err(parse_err("negative counts in a FreeSurfer surface"));
    }
    let (vnum, fnum) = (vnum as usize, fnum as usize);
    let mut nodes = Vec::with_capacity(vnum);
    let coords = r.take(
        vnum.checked_mul(12)
            .ok_or_else(|| parse_err("huge surface"))?,
    )?;
    for c in coords.chunks_exact(12) {
        nodes.push([
            f32::from_be_bytes(c[0..4].try_into().unwrap()),
            f32::from_be_bytes(c[4..8].try_into().unwrap()),
            f32::from_be_bytes(c[8..12].try_into().unwrap()),
        ]);
    }
    let mut tris = Vec::with_capacity(fnum);
    let faces = r.take(
        fnum.checked_mul(12)
            .ok_or_else(|| parse_err("huge surface"))?,
    )?;
    for c in faces.chunks_exact(12) {
        tris.push([
            i32::from_be_bytes(c[0..4].try_into().unwrap()) as u32,
            i32::from_be_bytes(c[4..8].try_into().unwrap()) as u32,
            i32::from_be_bytes(c[8..12].try_into().unwrap()) as u32,
        ]);
    }
    Ok(mesh_of(nodes, tris, None))
}

fn read_quad_file(r: &mut Reader, new_format: bool) -> Result<Mesh> {
    let vnum = r.u24_be()? as usize;
    let fnum = r.u24_be()? as usize;
    let mut nodes = Vec::with_capacity(vnum);
    for _ in 0..vnum {
        if new_format {
            nodes.push([r.f32_be()?, r.f32_be()?, r.f32_be()?]);
        } else {
            // The old quad file stores hundredths of a millimetre as int16.
            let mut v = [0f32; 3];
            for slot in v.iter_mut() {
                let raw = r.take(2)?;
                *slot = i16::from_be_bytes([raw[0], raw[1]]) as f32 / 100.0;
            }
            nodes.push(v);
        }
    }
    let mut tris = Vec::with_capacity(fnum * 2);
    let mut mask = Vec::with_capacity(fnum * 2);
    let mut quad = [0u32; 4];
    for _ in 0..fnum {
        for slot in quad.iter_mut() {
            *slot = r.u24_be()?;
        }
        crate::surf::fan(&quad, &mut tris, &mut mask);
    }
    Ok(mesh_of(nodes, tris, Some(mask)))
}

fn mesh_of(nodes: Vec<[f32; 3]>, tris: Vec<[u32; 3]>, mask: Option<Vec<u8>>) -> Mesh {
    let tri_tags = vec![0i32; tris.len()];
    Mesh {
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
    }
}

pub fn read_curv(bytes: &[u8]) -> Result<Field> {
    let mut r = Reader::new(bytes);
    let magic = r.u24_be()?;
    let data: Vec<f32> = if magic == CURV_NEW_MAGIC {
        let vnum = r.i32_be()?;
        let _fnum = r.i32_be()?;
        let vals = r.i32_be()?;
        if vnum < 0 || vals < 1 {
            return Err(parse_err("bad FreeSurfer curv header"));
        }
        let n = (vnum as usize)
            .checked_mul(vals as usize)
            .ok_or_else(|| parse_err("huge curv"))?;
        let raw = r.take(n.checked_mul(4).ok_or_else(|| parse_err("huge curv"))?)?;
        raw.chunks_exact(4)
            .map(|c| f32::from_be_bytes(c.try_into().unwrap()))
            .collect()
    } else {
        // The old format has no magic: the first three bytes are the vertex count.
        let vnum = magic as usize;
        let _fnum = r.u24_be()?;
        let raw = r.take(vnum.checked_mul(2).ok_or_else(|| parse_err("huge curv"))?)?;
        raw.chunks_exact(2)
            .map(|c| i16::from_be_bytes([c[0], c[1]]) as f32 / 100.0)
            .collect()
    };
    let stats = field_stats(&data, 1);
    Ok(Field {
        name: "curv".to_string(),
        ncomp: 1,
        data,
        units: None,
        partial: false,
        stats,
    })
}

pub fn read_annot(bytes: &[u8]) -> Result<(Field, LabelTable)> {
    let mut r = Reader::new(bytes);
    let n = r.i32_be()?;
    if n < 0 {
        return Err(parse_err("negative vertex count in a FreeSurfer .annot"));
    }
    let n = n as usize;
    let mut raw_labels = vec![0i32; n];
    let pairs = r.take(n.checked_mul(8).ok_or_else(|| parse_err("huge annot"))?)?;
    for c in pairs.chunks_exact(8) {
        let vtx = i32::from_be_bytes(c[0..4].try_into().unwrap());
        let lab = i32::from_be_bytes(c[4..8].try_into().unwrap());
        // The vertex index is explicit and need not be in order.
        if vtx >= 0 && (vtx as usize) < n {
            raw_labels[vtx as usize] = lab;
        }
    }

    let mut table = LabelTable::default();
    if r.remaining() >= 4 {
        let tag = r.i32_be()?;
        if tag == 1 {
            table = read_colortable(&mut r)?;
        }
    }

    // §6.2/§7.6: remap the packed-RGB values to dense 0..N−1 at parse time. Everything not in the
    // colortable — FreeSurfer's `-1`, and the `0` that means "no label" — becomes dense index 0.
    let dense_of: HashMap<u32, u32> = table
        .entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id, i as u32))
        .collect();
    let data: Vec<f32> = raw_labels
        .iter()
        .map(|l| *dense_of.get(&(*l as u32)).unwrap_or(&0) as f32)
        .collect();
    let stats = field_stats(&data, 1);
    Ok((
        Field {
            name: "annot".to_string(),
            ncomp: 1,
            data,
            units: None,
            partial: false,
            stats,
        },
        table,
    ))
}

fn read_colortable(r: &mut Reader) -> Result<LabelTable> {
    let version = r.i32_be()?;
    let mut table = LabelTable::default();
    if version > 0 {
        // The original format: `version` is the entry count.
        let n = version as usize;
        let flen = r.i32_be()?.max(0) as usize;
        let _fname = r.take(flen)?;
        for _ in 0..n {
            let len = r.i32_be()?.max(0) as usize;
            let name = cstr(r.take(len)?);
            table.entries.push(entry(r, name)?);
        }
    } else if version == -2 {
        let _maxstruct = r.i32_be()?;
        let flen = r.i32_be()?.max(0) as usize;
        let _fname = r.take(flen)?;
        let n = r.i32_be()?.max(0) as usize;
        let mut by_index: Vec<(i32, LabelEntry)> = Vec::with_capacity(n);
        for _ in 0..n {
            let structure = r.i32_be()?;
            let len = r.i32_be()?.max(0) as usize;
            let name = cstr(r.take(len)?);
            by_index.push((structure, entry(r, name)?));
        }
        // Dense index order is structure-index order, which is also the file order in practice.
        by_index.sort_by_key(|(i, _)| *i);
        table.entries = by_index.into_iter().map(|(_, e)| e).collect();
    } else {
        return Err(unsupported(format!(
            "FreeSurfer .annot colortable version {version}"
        )));
    }
    Ok(table)
}

fn entry(r: &mut Reader, name: String) -> Result<LabelEntry> {
    let red = r.i32_be()?;
    let green = r.i32_be()?;
    let blue = r.i32_be()?;
    let transparency = r.i32_be()?;
    // The annotation value packed into the per-vertex array (§6.2's "packed RGB").
    let id = (red as u32 & 0xFF) | ((green as u32 & 0xFF) << 8) | ((blue as u32 & 0xFF) << 16);
    Ok(LabelEntry {
        id,
        name,
        color: [
            red.clamp(0, 255) as u8,
            green.clamp(0, 255) as u8,
            blue.clamp(0, 255) as u8,
            // FreeSurfer stores *transparency*; §4.1's wire form is alpha.
            255u8.saturating_sub(transparency.clamp(0, 255) as u8),
        ],
    })
}

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packed_id_is_r_plus_g_shifted_plus_b_shifted() {
        let mut r = Reader::new(&[
            0, 0, 0, 25, // r
            0, 0, 0, 5, // g
            0, 0, 0, 25, // b
            0, 0, 0, 0, // transparency
        ]);
        let e = entry(&mut r, "Unknown".into()).unwrap();
        assert_eq!(e.id, 25 + 5 * 256 + 25 * 65536);
        assert_eq!(e.id, 1_639_705);
        assert_eq!(e.color, [25, 5, 25, 255]);
    }

    #[test]
    fn the_three_surface_magics_are_recognised() {
        assert!(looks_like_surface(&[0xFF, 0xFF, 0xFE]));
        assert!(looks_like_surface(&[0xFF, 0xFF, 0xFF]));
        assert!(looks_like_surface(&[0xFF, 0xFF, 0xFD]));
        assert!(!looks_like_surface(&[0xFF, 0xFF, 0x00]));
        assert!(!looks_like_surface(b"pl"));
    }
}
