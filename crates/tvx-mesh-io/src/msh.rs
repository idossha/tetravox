//! Gmsh `.msh` v2.2 (ascii + binary, SimNIBS's `2.2 1 8` dialect **and** stock Gmsh's) and v4.1
//! (ascii + binary). ARCHITECTURE.md §6.2 is normative; each rule it states is implemented here
//! and named in a comment at the point it bites.

use std::collections::BTreeMap;

use tvx_core::{Aabb, Error, Field, Phase, ProgressSink, Result};

use crate::stats::field_stats_parts;
use crate::util::{parse_err, str_of, trim, unquote, IdMap, Reader};
use crate::{ElmField, Mesh};

const TRI3: u32 = 2;
const TET4: u32 = 4;

/// Marks a tet in `Build::elm_ids`. Element numbers are `<= u32::MAX` by §6.2, so bit 63 is free
/// and the kind costs no second array — which matters at 15.8 M elements (`ernie-seeg.msh`).
const TET_FLAG: u64 = 1 << 63;

/// Nodes per Gmsh element type, for the skip arithmetic of §6.2. `None` = a type whose stride we
/// do not know, which in a binary file is fatal because the records cannot be stepped over.
fn nodes_per_type(t: u32) -> Option<usize> {
    Some(match t {
        1 => 2,
        2 => 3,
        3 => 4,
        4 => 4,
        5 => 8,
        6 => 6,
        7 => 5,
        8 => 3,
        9 => 6,
        10 => 9,
        11 => 10,
        12 => 27,
        13 => 18,
        14 => 14,
        15 => 1,
        16 => 8,
        17 => 20,
        18 => 15,
        19 => 13,
        20 => 9,
        21 => 10,
        22 => 12,
        23 => 15,
        24 => 15,
        25 => 21,
        26 => 4,
        27 => 5,
        28 => 6,
        29 => 20,
        30 => 35,
        31 => 56,
        92 => 64,
        93 => 125,
        _ => return None,
    })
}

fn oom(what: &str) -> Error {
    Error::OutOfMemory(format!("{what} section is larger than this address space"))
}

/// A `$NodeData` / `$ElementData` header. Tag counts are variable (§6.2): SimNIBS writes 1/1/4,
/// Gmsh adds a second string tag naming an interpolation scheme.
struct DataHeader {
    name: String,
    ncomp: usize,
    nrec: usize,
}

fn read_data_header(r: &mut Reader, binary: bool, what: &str) -> Result<DataHeader> {
    let n_string = r.usize_tok()?;
    let mut name = String::new();
    for i in 0..n_string {
        // A string tag is a quoted string that may contain spaces: a line, not a token.
        r.skip_ws();
        let line = r.line()?;
        if i == 0 {
            name = unquote(line);
        }
    }
    let n_real = r.usize_tok()?;
    for _ in 0..n_real {
        let _ = r.f64_tok()?;
    }
    let n_int = r.usize_tok()?;
    if n_int < 3 {
        return Err(parse_err(format!(
            "{what} {name:?}: expected at least 3 integer tags, got {n_int}"
        )));
    }
    let mut ints = Vec::with_capacity(n_int);
    for _ in 0..n_int {
        ints.push(r.i64_tok()?);
    }
    // §6.2: integer_tags[0] is the time-step index; more than one step is unsupported.
    if ints[0] > 1 {
        return Err(Error::Unsupported(format!(
            "{what} {name:?}: multiple time steps (step index {})",
            ints[0]
        )));
    }
    let ncomp = usize::try_from(ints[1])
        .map_err(|_| parse_err(format!("{what} {name:?}: bad component count {}", ints[1])))?;
    if !matches!(ncomp, 1 | 3 | 9) {
        return Err(Error::Unsupported(format!(
            "{what} {name:?}: {ncomp} components (1, 3 or 9 only)"
        )));
    }
    let nrec = usize::try_from(ints[2])
        .map_err(|_| parse_err(format!("{what} {name:?}: bad record count {}", ints[2])))?;
    if binary {
        // The payload starts on the line after the last integer tag.
        let _ = r.line()?;
    }
    Ok(DataHeader { name, ncomp, nrec })
}

#[derive(Default)]
struct Build {
    nodes: Vec<[f32; 3]>,
    node_ids: Vec<u64>,
    node_map: Option<IdMap>,
    tris: Vec<[u32; 3]>,
    tri_tags: Vec<i32>,
    tets: Vec<[u32; 4]>,
    tet_tags: Vec<i32>,
    /// File order, tets flagged with [`TET_FLAG`]; rewritten into (tris then tets) order by
    /// [`Build::finish_elements`].
    elm_ids: Vec<u64>,
    saw_tet: bool,
    interleaved: bool,
    elm_map: Option<IdMap>,
    skipped: BTreeMap<u32, u64>,
    physical_names: Vec<(i32, String)>,
    node_fields: Vec<Field>,
    elm_fields: Vec<ElmField>,
    min: [f32; 3],
    max: [f32; 3],
    /// v4.1 only: `(dim, entity tag) → first physical tag`.
    entity_physical: BTreeMap<(i32, i32), i32>,
}

impl Build {
    fn new() -> Self {
        Build {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
            ..Default::default()
        }
    }

    #[inline]
    fn push_node(&mut self, id: u64, x: f64, y: f64, z: f64) {
        let v = [x as f32, y as f32, z as f32];
        for ((c, lo), hi) in v.iter().zip(self.min.iter_mut()).zip(self.max.iter_mut()) {
            if *c < *lo {
                *lo = *c;
            }
            if *c > *hi {
                *hi = *c;
            }
        }
        self.nodes.push(v);
        self.node_ids.push(id);
    }

    fn finish_nodes(&mut self) {
        let map = IdMap::build(&self.node_ids);
        if map.is_identity() {
            self.node_ids = Vec::new();
        }
        self.node_map = Some(map);
    }

    #[inline]
    fn node_index(&self, id: u64) -> Result<u32> {
        self.node_map
            .as_ref()
            .and_then(|m| m.get(id))
            .ok_or_else(|| parse_err(format!("element references undefined node {id}")))
    }

    #[inline]
    fn check_elm_number(&self, id: u64) -> Result<()> {
        if id > u32::MAX as u64 {
            // §6.2: `owner_elm` is u32; refuse at parse time, never truncate.
            return Err(Error::Unsupported(format!(
                "element numbers exceed u32 (found {id})"
            )));
        }
        Ok(())
    }

    #[inline]
    fn push_tri(&mut self, id: u64, v: [u32; 3], tag: i32) {
        if self.saw_tet {
            self.interleaved = true;
        }
        self.tris.push(v);
        self.tri_tags.push(tag);
        self.elm_ids.push(id);
    }

    #[inline]
    fn push_tet(&mut self, id: u64, v: [u32; 4], tag: i32) {
        self.saw_tet = true;
        self.tets.push(v);
        self.tet_tags.push(tag);
        self.elm_ids.push(id | TET_FLAG);
    }

    fn finish_elements(&mut self) {
        if self.interleaved {
            // §6.2 defines `gmsh_elm_numbers` in (tris then tets) order; a file that interleaves
            // its blocks must still come out in contract order.
            let mut tri_ids = Vec::with_capacity(self.tris.len());
            let mut tet_ids = Vec::with_capacity(self.tets.len());
            for id in self.elm_ids.iter() {
                if id & TET_FLAG != 0 {
                    tet_ids.push(id & !TET_FLAG);
                } else {
                    tri_ids.push(*id);
                }
            }
            tri_ids.append(&mut tet_ids);
            self.elm_ids = tri_ids;
        } else {
            for id in self.elm_ids.iter_mut() {
                *id &= !TET_FLAG;
            }
        }
        // §6.2's fast path: `IdMap::build` recognises `1..N` in (tris then tets) order, and then
        // `gmsh_elm_numbers` is `None` and costs nothing instead of 47.2 MB on ernie `[MODEL]`.
        let map = IdMap::build(&self.elm_ids);
        if map.is_identity() {
            self.elm_ids = Vec::new();
        }
        self.elm_map = Some(map);
    }

    fn bounds(&self) -> Aabb {
        if self.nodes.is_empty() {
            Aabb {
                min: [0.0; 3],
                max: [0.0; 3],
            }
        } else {
            Aabb {
                min: self.min,
                max: self.max,
            }
        }
    }

    fn into_mesh(mut self) -> Mesh {
        let bounds = self.bounds();
        let n_tets = self.tets.len();
        let node_numbers = (!self.node_ids.is_empty()).then(|| std::mem::take(&mut self.node_ids));
        let elm_numbers = (!self.elm_ids.is_empty()).then(|| std::mem::take(&mut self.elm_ids));
        Mesh {
            nodes: self.nodes,
            tris: self.tris,
            tri_tags: self.tri_tags,
            tets: self.tets,
            tet_tags: self.tet_tags,
            // §6.2: `read_msh` never triangulates an n-gon, so the engine takes its
            // constant-attribute fast path.
            tri_edge_mask: None,
            node_fields: self.node_fields,
            elm_fields: self.elm_fields,
            physical_names: self.physical_names,
            gmsh_node_numbers: node_numbers,
            gmsh_elm_numbers: elm_numbers,
            // `tet_perm` is Morton order → file row (§6.3); the reader emits the identity and
            // `tvx_geom::morton_reorder` replaces it.
            tet_perm: (0..n_tets as u32).collect(),
            skipped: self.skipped.into_iter().collect(),
            bounds,
        }
    }
}

/// §6.2's `read_msh`, minus the ownership dance the public wrapper does.
pub fn read(bytes: &[u8], p: &mut dyn ProgressSink) -> Result<Mesh> {
    let total = bytes.len() as u64;
    let mut r = Reader::new(bytes);
    p.report(Phase::Parse, 0, total);

    let head = trim(r.nonblank_line()?);
    if head != b"$MeshFormat" {
        return Err(parse_err(format!(
            "not a Gmsh .msh file: first section is {:?}",
            String::from_utf8_lossy(head)
        )));
    }
    let fmt = trim(r.line()?);
    let mut it = str_of(fmt)?.split_whitespace();
    let version = it.next().unwrap_or("").to_string();
    let file_type: i32 = it.next().unwrap_or("0").parse().unwrap_or(0);
    let data_size: usize = it.next().unwrap_or("8").parse().unwrap_or(8);
    let binary = file_type == 1;
    if data_size != 8 {
        return Err(Error::Unsupported(format!(
            "Gmsh data-size {data_size} (only 8 occurs in practice)"
        )));
    }
    if binary {
        let one = r.i32_le()?;
        if one != 1 {
            return Err(Error::Unsupported(
                "big-endian Gmsh binary (.msh endianness marker is not 1)".to_string(),
            ));
        }
    }
    let end = trim(r.nonblank_line()?);
    if end != b"$EndMeshFormat" {
        return Err(parse_err(format!(
            "expected $EndMeshFormat, got {:?}",
            String::from_utf8_lossy(end)
        )));
    }

    let v4 = match version.split('.').next().unwrap_or("2") {
        "2" => false,
        "4" => true,
        other => {
            return Err(Error::Unsupported(format!(
                "Gmsh .msh version {other} (2.2 and 4.1 are supported)"
            )))
        }
    };
    if v4 && !version.starts_with("4.1") {
        return Err(Error::Unsupported(format!(
            "Gmsh .msh version {version} (4.1 is the supported v4 dialect)"
        )));
    }

    let mut b = Build::new();

    loop {
        r.skip_ws();
        if r.eof() {
            break;
        }
        if p.aborted() {
            return Err(Error::Cancelled);
        }
        p.report(Phase::Parse, r.pos as u64, total);
        let name = trim(r.line()?).to_vec();
        if name.is_empty() {
            continue;
        }
        if !name.starts_with(b"$") {
            return Err(parse_err(format!(
                "expected a section header, got {:?}",
                String::from_utf8_lossy(&name)
            )));
        }
        match name.as_slice() {
            b"$PhysicalNames" => read_physical_names(&mut r, &mut b)?,
            b"$Entities" if v4 => read_entities_v4(&mut r, &mut b, binary)?,
            b"$Nodes" => {
                if v4 {
                    read_nodes_v4(&mut r, &mut b, binary, p, total)?;
                } else {
                    read_nodes_v2(&mut r, &mut b, binary, p, total)?;
                }
                b.finish_nodes();
                expect_end(&mut r, b"$EndNodes")?;
            }
            b"$Elements" => {
                if v4 {
                    read_elements_v4(&mut r, &mut b, binary, p, total)?;
                } else {
                    read_elements_v2(&mut r, &mut b, binary, p, total)?;
                }
                b.finish_elements();
                expect_end(&mut r, b"$EndElements")?;
            }
            b"$NodeData" => {
                read_node_data(&mut r, &mut b, binary, p, total)?;
                expect_end(&mut r, b"$EndNodeData")?;
            }
            b"$ElementData" => {
                read_element_data(&mut r, &mut b, binary, p, total)?;
                expect_end(&mut r, b"$EndElementData")?;
            }
            _ => {
                // Every other section — `$InterpolationScheme`, `$Periodic`, `$ElementNodeData`,
                // `$GhostElements`, `$Comments` — is skipped whole.
                let mut endm = b"$End".to_vec();
                endm.extend_from_slice(&name[1..]);
                r.skip_past(&endm)?;
            }
        }
    }

    p.report(Phase::Parse, total, total);
    Ok(b.into_mesh())
}

fn expect_end(r: &mut Reader, want: &[u8]) -> Result<()> {
    // SimNIBS writes no newline before `$End*`; Gmsh writes one (§6.2 — both dialects are
    // committed fixtures), so the separator is optional whitespace either way.
    let got = trim(r.nonblank_line()?);
    if got != want {
        return Err(parse_err(format!(
            "expected {:?}, got {:?}",
            String::from_utf8_lossy(want),
            String::from_utf8_lossy(got)
        )));
    }
    Ok(())
}

fn read_physical_names(r: &mut Reader, b: &mut Build) -> Result<()> {
    let n = r.usize_tok()?;
    for _ in 0..n {
        r.skip_ws();
        let line = trim(r.line()?);
        // `dim tag "name"` — the name may contain spaces, so only the first two fields are tokens.
        let mut it = str_of(line)?.splitn(3, char::is_whitespace);
        let _dim = it.next().unwrap_or("");
        let tag = it
            .next()
            .and_then(|t| t.trim().parse::<i32>().ok())
            .ok_or_else(|| parse_err("bad $PhysicalNames entry"))?;
        let name = unquote(it.next().unwrap_or("").as_bytes());
        b.physical_names.push((tag, name));
    }
    expect_end(r, b"$EndPhysicalNames")
}

// -------------------------------------------------------------------------------------------
// v2.2
// -------------------------------------------------------------------------------------------

fn read_nodes_v2(
    r: &mut Reader,
    b: &mut Build,
    binary: bool,
    p: &mut dyn ProgressSink,
    total: u64,
) -> Result<()> {
    let n = r.usize_tok()?;
    b.nodes.reserve_exact(n);
    b.node_ids.reserve_exact(n);
    if binary {
        let _ = r.line()?; // the newline after the ascii count
                           // §6.2: `i32 id + 3×f64`, one packed run of `n × 28` bytes.
        let data = r.take(n.checked_mul(28).ok_or_else(|| oom("$Nodes"))?)?;
        for (i, rec) in data.chunks_exact(28).enumerate() {
            let id = i32::from_le_bytes(rec[0..4].try_into().unwrap()) as u32 as u64;
            let x = f64::from_le_bytes(rec[4..12].try_into().unwrap());
            let y = f64::from_le_bytes(rec[12..20].try_into().unwrap());
            let z = f64::from_le_bytes(rec[20..28].try_into().unwrap());
            b.push_node(id, x, y, z);
            if i % (1 << 20) == 0 {
                p.report(Phase::Parse, r.pos as u64, total);
            }
        }
    } else {
        for _ in 0..n {
            let id = r.u64_tok()?;
            let x = r.f64_tok()?;
            let y = r.f64_tok()?;
            let z = r.f64_tok()?;
            b.push_node(id, x, y, z);
        }
    }
    Ok(())
}

fn read_elements_v2(
    r: &mut Reader,
    b: &mut Build,
    binary: bool,
    p: &mut dyn ProgressSink,
    total: u64,
) -> Result<()> {
    let n = r.usize_tok()?;
    b.elm_ids.reserve(n);
    if binary {
        let _ = r.line()?; // the newline after the ascii count
        let mut done = 0usize;
        while done < n {
            let elm_type = r.i32_le()? as u32;
            let count = r.i32_le()?;
            let n_tags = r.i32_le()?;
            if count < 0 || n_tags < 0 {
                return Err(parse_err("negative $Elements block header"));
            }
            let (count, n_tags) = (count as usize, n_tags as usize);
            let npt = nodes_per_type(elm_type).ok_or_else(|| {
                Error::Unsupported(format!("gmsh element type {elm_type} in a binary .msh"))
            })?;
            // §6.2's skip arithmetic: `count × (1 + n_tags + nodes_per_type) × 4` bytes.
            // (SimNIBS's own reader hard-codes 2 tags into a 3 — this does not.)
            let words = 1 + n_tags + npt;
            let bytes = count
                .checked_mul(words)
                .and_then(|w| w.checked_mul(4))
                .ok_or_else(|| oom("$Elements"))?;
            let data = r.take(bytes)?;
            match elm_type {
                TRI3 => {
                    b.tris.reserve(count);
                    b.tri_tags.reserve(count);
                    for rec in data.chunks_exact(words * 4) {
                        let id = le_i32(rec, 0) as u32 as u64;
                        b.check_elm_number(id)?;
                        let tag = if n_tags > 0 { le_i32(rec, 1) } else { 0 };
                        let base = 1 + n_tags;
                        let v = [
                            b.node_index(le_i32(rec, base) as u32 as u64)?,
                            b.node_index(le_i32(rec, base + 1) as u32 as u64)?,
                            b.node_index(le_i32(rec, base + 2) as u32 as u64)?,
                        ];
                        b.push_tri(id, v, tag);
                    }
                }
                TET4 => {
                    b.tets.reserve(count);
                    b.tet_tags.reserve(count);
                    for rec in data.chunks_exact(words * 4) {
                        let id = le_i32(rec, 0) as u32 as u64;
                        b.check_elm_number(id)?;
                        let tag = if n_tags > 0 { le_i32(rec, 1) } else { 0 };
                        let base = 1 + n_tags;
                        let v = [
                            b.node_index(le_i32(rec, base) as u32 as u64)?,
                            b.node_index(le_i32(rec, base + 1) as u32 as u64)?,
                            b.node_index(le_i32(rec, base + 2) as u32 as u64)?,
                            b.node_index(le_i32(rec, base + 3) as u32 as u64)?,
                        ];
                        b.push_tet(id, v, tag);
                    }
                }
                // §6.2: everything else is counted into `skipped`, never an error.
                _ => *b.skipped.entry(elm_type).or_insert(0) += count as u64,
            }
            done += count;
            p.report(Phase::Parse, r.pos as u64, total);
            if p.aborted() {
                return Err(Error::Cancelled);
            }
        }
    } else {
        for _ in 0..n {
            let id = r.u64_tok()?;
            b.check_elm_number(id)?;
            let elm_type = r.u64_tok()? as u32;
            let n_tags = r.usize_tok()?;
            let mut tag = 0i32;
            for k in 0..n_tags {
                let t = r.i64_tok()?;
                if k == 0 {
                    tag = t as i32;
                }
            }
            let npt = nodes_per_type(elm_type)
                .ok_or_else(|| Error::Unsupported(format!("gmsh element type {elm_type}")))?;
            match elm_type {
                TRI3 => {
                    let v = [
                        b.node_index(r.u64_tok()?)?,
                        b.node_index(r.u64_tok()?)?,
                        b.node_index(r.u64_tok()?)?,
                    ];
                    b.push_tri(id, v, tag);
                }
                TET4 => {
                    let v = [
                        b.node_index(r.u64_tok()?)?,
                        b.node_index(r.u64_tok()?)?,
                        b.node_index(r.u64_tok()?)?,
                        b.node_index(r.u64_tok()?)?,
                    ];
                    b.push_tet(id, v, tag);
                }
                _ => {
                    for _ in 0..npt {
                        let _ = r.token()?;
                    }
                    *b.skipped.entry(elm_type).or_insert(0) += 1;
                }
            }
        }
    }
    Ok(())
}

#[inline]
fn le_i32(rec: &[u8], word: usize) -> i32 {
    i32::from_le_bytes(rec[word * 4..word * 4 + 4].try_into().unwrap())
}

// -------------------------------------------------------------------------------------------
// v4.1
// -------------------------------------------------------------------------------------------

fn read_entities_v4(r: &mut Reader, b: &mut Build, binary: bool) -> Result<()> {
    let counts = if binary {
        [r.u64_le()?, r.u64_le()?, r.u64_le()?, r.u64_le()?]
    } else {
        [r.u64_tok()?, r.u64_tok()?, r.u64_tok()?, r.u64_tok()?]
    };
    for (dim, count) in counts.iter().enumerate() {
        for _ in 0..*count {
            let tag = if binary { r.i32_le()? } else { r.i32_tok()? };
            // A point carries 3 coordinates; every other entity a 6-value bounding box.
            let ncoord = if dim == 0 { 3 } else { 6 };
            for _ in 0..ncoord {
                let _ = if binary { r.f64_le()? } else { r.f64_tok()? };
            }
            let n_phys = if binary { r.u64_le()? } else { r.u64_tok()? };
            let mut first = None;
            for _ in 0..n_phys {
                let t = if binary { r.i32_le()? } else { r.i32_tok()? };
                if first.is_none() {
                    first = Some(t);
                }
            }
            if dim > 0 {
                let n_bnd = if binary { r.u64_le()? } else { r.u64_tok()? };
                for _ in 0..n_bnd {
                    let _ = if binary { r.i32_le()? } else { r.i32_tok()? };
                }
            }
            b.entity_physical
                .insert((dim as i32, tag), first.unwrap_or(tag));
        }
    }
    expect_end(r, b"$EndEntities")
}

fn read_nodes_v4(
    r: &mut Reader,
    b: &mut Build,
    binary: bool,
    p: &mut dyn ProgressSink,
    total: u64,
) -> Result<()> {
    let (nblocks, nnodes) = if binary {
        let v = (r.u64_le()?, r.u64_le()?, r.u64_le()?, r.u64_le()?);
        (v.0 as usize, v.1 as usize)
    } else {
        let v = (r.usize_tok()?, r.usize_tok()?, r.u64_tok()?, r.u64_tok()?);
        (v.0, v.1)
    };
    b.nodes.reserve_exact(nnodes);
    b.node_ids.reserve_exact(nnodes);
    let mut ids: Vec<u64> = Vec::new();
    for _ in 0..nblocks {
        let (dim, _tag, parametric, count) = if binary {
            (r.i32_le()?, r.i32_le()?, r.i32_le()?, r.u64_le()? as usize)
        } else {
            (r.i32_tok()?, r.i32_tok()?, r.i32_tok()?, r.usize_tok()?)
        };
        // A v4.1 node block is the tag run first, then the coordinate run — not interleaved.
        ids.clear();
        ids.reserve(count);
        if binary {
            let data = r.take(count.checked_mul(8).ok_or_else(|| oom("$Nodes"))?)?;
            for c in data.chunks_exact(8) {
                ids.push(u64::from_le_bytes(c.try_into().unwrap()));
            }
        } else {
            for _ in 0..count {
                ids.push(r.u64_tok()?);
            }
        }
        // Parametric blocks append `dim` extra coordinates per node (§6.2's v4.1 bullet).
        let extra = if parametric != 0 {
            dim.max(0) as usize
        } else {
            0
        };
        let per = 3 + extra;
        if binary {
            let data = r.take(
                count
                    .checked_mul(per * 8)
                    .ok_or_else(|| oom("$Nodes coordinates"))?,
            )?;
            for (i, rec) in data.chunks_exact(per * 8).enumerate() {
                let x = f64::from_le_bytes(rec[0..8].try_into().unwrap());
                let y = f64::from_le_bytes(rec[8..16].try_into().unwrap());
                let z = f64::from_le_bytes(rec[16..24].try_into().unwrap());
                b.push_node(ids[i], x, y, z);
            }
        } else {
            for id in ids.iter() {
                let x = r.f64_tok()?;
                let y = r.f64_tok()?;
                let z = r.f64_tok()?;
                for _ in 0..extra {
                    let _ = r.f64_tok()?;
                }
                b.push_node(*id, x, y, z);
            }
        }
        p.report(Phase::Parse, r.pos as u64, total);
    }
    Ok(())
}

fn read_elements_v4(
    r: &mut Reader,
    b: &mut Build,
    binary: bool,
    p: &mut dyn ProgressSink,
    total: u64,
) -> Result<()> {
    let (nblocks, nelms) = if binary {
        let v = (r.u64_le()?, r.u64_le()?, r.u64_le()?, r.u64_le()?);
        (v.0 as usize, v.1 as usize)
    } else {
        let v = (r.usize_tok()?, r.usize_tok()?, r.u64_tok()?, r.u64_tok()?);
        (v.0, v.1)
    };
    b.elm_ids.reserve(nelms);
    for _ in 0..nblocks {
        let (dim, ent, elm_type, count) = if binary {
            (
                r.i32_le()?,
                r.i32_le()?,
                r.i32_le()? as u32,
                r.u64_le()? as usize,
            )
        } else {
            (
                r.i32_tok()?,
                r.i32_tok()?,
                r.u64_tok()? as u32,
                r.usize_tok()?,
            )
        };
        // v4.1 elements carry no tags of their own: the tag is the entity's first physical tag,
        // which is what makes the v2.2 and v4.1 encodings of one mesh agree element for element.
        let tag = b.entity_physical.get(&(dim, ent)).copied().unwrap_or(ent);
        let npt = nodes_per_type(elm_type)
            .ok_or_else(|| Error::Unsupported(format!("gmsh element type {elm_type}")))?;
        let words = 1 + npt;
        let keep = elm_type == TRI3 || elm_type == TET4;
        if keep {
            if elm_type == TRI3 {
                b.tris.reserve(count);
                b.tri_tags.reserve(count);
            } else {
                b.tets.reserve(count);
                b.tet_tags.reserve(count);
            }
        }
        if binary {
            let data = r.take(
                count
                    .checked_mul(words * 8)
                    .ok_or_else(|| oom("$Elements"))?,
            )?;
            if keep {
                for rec in data.chunks_exact(words * 8) {
                    let w =
                        |k: usize| u64::from_le_bytes(rec[k * 8..k * 8 + 8].try_into().unwrap());
                    let id = w(0);
                    b.check_elm_number(id)?;
                    if elm_type == TRI3 {
                        let v = [
                            b.node_index(w(1))?,
                            b.node_index(w(2))?,
                            b.node_index(w(3))?,
                        ];
                        b.push_tri(id, v, tag);
                    } else {
                        let v = [
                            b.node_index(w(1))?,
                            b.node_index(w(2))?,
                            b.node_index(w(3))?,
                            b.node_index(w(4))?,
                        ];
                        b.push_tet(id, v, tag);
                    }
                }
            } else {
                *b.skipped.entry(elm_type).or_insert(0) += count as u64;
            }
        } else {
            for _ in 0..count {
                let id = r.u64_tok()?;
                b.check_elm_number(id)?;
                match elm_type {
                    TRI3 => {
                        let v = [
                            b.node_index(r.u64_tok()?)?,
                            b.node_index(r.u64_tok()?)?,
                            b.node_index(r.u64_tok()?)?,
                        ];
                        b.push_tri(id, v, tag);
                    }
                    TET4 => {
                        let v = [
                            b.node_index(r.u64_tok()?)?,
                            b.node_index(r.u64_tok()?)?,
                            b.node_index(r.u64_tok()?)?,
                            b.node_index(r.u64_tok()?)?,
                        ];
                        b.push_tet(id, v, tag);
                    }
                    _ => {
                        for _ in 0..npt {
                            let _ = r.token()?;
                        }
                        *b.skipped.entry(elm_type).or_insert(0) += 1;
                    }
                }
            }
        }
        p.report(Phase::Parse, r.pos as u64, total);
        if p.aborted() {
            return Err(Error::Cancelled);
        }
    }
    Ok(())
}

// -------------------------------------------------------------------------------------------
// $NodeData / $ElementData — identical in v2.2 and v4.1
// -------------------------------------------------------------------------------------------

fn read_node_data(
    r: &mut Reader,
    b: &mut Build,
    binary: bool,
    p: &mut dyn ProgressSink,
    total: u64,
) -> Result<()> {
    let h = read_data_header(r, binary, "$NodeData")?;
    let n = b.nodes.len();
    let mut data = vec![f32::NAN; n * h.ncomp];
    let mut filled = 0usize;
    let map = b.node_map.as_ref();
    each_record(r, binary, h.ncomp, h.nrec, p, total, |id, vals| {
        // §6.2: scatter by id; positional order is not guaranteed and is wrong for cropped meshes.
        if let Some(row) = map.and_then(|m| m.get(id)) {
            let base = row as usize * h.ncomp;
            data[base..base + h.ncomp].copy_from_slice(vals);
            filled += 1;
        }
    })?;
    let stats = field_stats_parts(&[&data], h.ncomp);
    b.node_fields.push(Field {
        name: h.name,
        ncomp: h.ncomp,
        data,
        units: None,
        // §6.2: gaps are NaN and `partial = true`.
        partial: filled < n,
        stats,
    });
    Ok(())
}

fn read_element_data(
    r: &mut Reader,
    b: &mut Build,
    binary: bool,
    p: &mut dyn ProgressSink,
    total: u64,
) -> Result<()> {
    let h = read_data_header(r, binary, "$ElementData")?;
    let n_tris = b.tris.len();
    let n_tets = b.tets.len();
    let mut tri = vec![f32::NAN; n_tris * h.ncomp];
    let mut tet = vec![f32::NAN; n_tets * h.ncomp];
    let mut filled = 0usize;
    let map = b.elm_map.as_ref();
    each_record(r, binary, h.ncomp, h.nrec, p, total, |id, vals| {
        if let Some(row) = map.and_then(|m| m.get(id)) {
            let row = row as usize;
            let (buf, base) = if row < n_tris {
                (&mut tri, row * h.ncomp)
            } else {
                (&mut tet, (row - n_tris) * h.ncomp)
            };
            buf[base..base + h.ncomp].copy_from_slice(vals);
            filled += 1;
        }
    })?;
    let stats = field_stats_parts(&[&tri, &tet], h.ncomp);
    b.elm_fields.push(ElmField {
        name: h.name,
        ncomp: h.ncomp,
        tri,
        tet,
        units: None,
        partial: filled < n_tris + n_tets,
        stats,
    });
    Ok(())
}

/// Streams `nrec` records of `i32 id + ncomp×f64`, narrowing to f32 **as it goes** (§6.2: never
/// "read all f64 then map").
fn each_record(
    r: &mut Reader,
    binary: bool,
    ncomp: usize,
    nrec: usize,
    p: &mut dyn ProgressSink,
    total: u64,
    mut sink: impl FnMut(u64, &[f32]),
) -> Result<()> {
    let mut vals = vec![0f32; ncomp];
    if binary {
        let stride = 4 + 8 * ncomp;
        let data = r.take(nrec.checked_mul(stride).ok_or_else(|| oom("field data"))?)?;
        for (i, rec) in data.chunks_exact(stride).enumerate() {
            let id = i32::from_le_bytes(rec[0..4].try_into().unwrap()) as u32 as u64;
            for (c, slot) in vals.iter_mut().enumerate() {
                let o = 4 + c * 8;
                *slot = f64::from_le_bytes(rec[o..o + 8].try_into().unwrap()) as f32;
            }
            sink(id, &vals);
            if i % (1 << 20) == 0 {
                p.report(Phase::Parse, r.pos as u64, total);
                if p.aborted() {
                    return Err(Error::Cancelled);
                }
            }
        }
    } else {
        for _ in 0..nrec {
            let id = r.u64_tok()?;
            for slot in vals.iter_mut() {
                *slot = r.f64_tok()? as f32;
            }
            sink(id, &vals);
        }
    }
    Ok(())
}
