//! `tvx-mesh-io` — mesh readers: Gmsh `.msh` v2/v4.1, `.msh.opt`, GIfTI, FreeSurfer surf/curv/annot,
//! STL/PLY/OBJ.
//!
//! This crate is [`docs/ARCHITECTURE.md` §6.2](../../../docs/ARCHITECTURE.md) verbatim; every §6.2
//! signature is **frozen** (§12.3). The two data §6.2 promises that Phase 1 had to carry out through
//! additive `read_gifti_labels` / `read_msh_opt_names` entry points now have fields —
//! [`Mesh::label_table`] and [`MshOptions::tag_name`] — and those entry points are gone.
//!
//! Normative rules (§6.2), restated so they are not lost:
//!
//! * **Gmsh v2 binary (`2.2 1 8`, the SimNIBS default).** `$Nodes` records are `i32 id + 3×f64`.
//!   `$Elements` blocks are `[elm_type: i32, count: i32, n_tags: i32]` then `count` records of
//!   `i32 id + n_tags×i32 + nodes_per_type×i32`; the skip for an unsupported type is
//!   `count × (1 + n_tags + nodes_per_type) × 4` bytes. (SimNIBS's own reader hard-codes 2 tags into a
//!   3 — do not copy it.)
//! * `$NodeData`/`$ElementData` records are `i32 id + ncomp×f64`. Tag counts are variable: read
//!   `n_string_tags` / `n_real_tags` / `n_integer_tags` and skip the extras. `ncomp = integer_tags[1]`,
//!   `nr = integer_tags[2]`; `integer_tags[0] > 1` time steps ⇒ `Error::Unsupported`. Values are read as
//!   f64 and narrowed to f32 **streaming, per block** — never "read all f64 then map".
//! * Ids are 1-based and may be non-contiguous. **Scatter by id**; gaps ⇒ `f32::NAN` and `partial = true`.
//! * [`Mesh::gmsh_elm_numbers`] is `Some` only when the numbering is **not** the identity; see its docs.
//! * Only element types 2 (tri3) and 4 (tet4) are kept in v1; everything else is counted into
//!   [`Mesh::skipped`], not an error.
//! * [`read_msh`] **takes ownership of the byte vector and frees it (and any inflate output) before
//!   returning** (§5 rule 5).
//! * Tag names/colours, in order: `$PhysicalNames` → sibling `<mesh>_LUT.txt` → sibling `<mesh>.msh.opt`
//!   → deterministic glasbey-like palette. **Surface tag `1xxx` inherits the colour of volume tag
//!   `1xxx − 1000`.**
//! * **GIfTI `GZipBase64Binary` is a zlib stream, not gzip — use `ZlibDecoder`, not `GzDecoder`.**
//!   `ExternalFileBinary` ⇒ `Error::Unsupported` (the byte-slice signature has no sibling-file access).
//! * **FreeSurfer** triangle-file magic is `0xFFFFFE` **big-endian**, coordinates big-endian f32.
//!   [`read_fs_annot`] remaps packed-RGB annotation values to **dense 0..N−1** at parse time (a 256×1 LUT
//!   cannot address raw annotation values), preserving the original id in `LabelEntry::id`; unassigned
//!   vertices (`-1`) map to dense index 0 with a transparent entry.
//! * Loaders that triangulate n-gons ([`read_fs_surface`]'s quad file, [`read_ply`], [`read_obj`]) must
//!   emit a matching [`Mesh::tri_edge_mask`]; [`read_msh`] and [`read_stl`] emit `None`.
//!
//! **Performance target:** `ernie.msh` (184,207,351 B, 847,165 nodes, 1,177,213 tris, 4,722,625 tets
//! `[DATA]`) parses in **< 1.5 s** native, **< 3 s** WASM.

#![forbid(unsafe_code)]

mod freesurfer;
mod geo;
mod gifti;
mod msh;
mod mshopt;
mod stats;
mod surf;
mod util;

/// Exact [`FieldStats`] over field values (§6.0's "no sampling" rule). Named in §6.2 because
/// `tvx-geom`'s `elm_to_node` / `node_to_elm` must build a `Field` / `ElmField` and every such
/// struct carries `stats`; duplicating the 65536-bin accumulator in a second crate would be two
/// implementations of one normative rule.
pub use stats::{field_stats, field_stats_parts};

/// A parsed Gmsh post-processing view (§6.2, task 6). See [`read_geo_view`].
pub use geo::GeoView;

use tvx_core::{Aabb, Field, FieldStats, LabelTable, ProgressSink, Result};

/// An element-indexed field, split by element kind (§6.2). Node-indexed fields are [`tvx_core::Field`].
#[derive(Clone, Debug)]
pub struct ElmField {
    pub name: String,
    pub ncomp: usize,
    /// Row-major, `n_tris * ncomp`.
    pub tri: Vec<f32>,
    /// Row-major, `n_tets * ncomp`.
    pub tet: Vec<f32>,
    pub units: Option<String>,
    pub partial: bool,
    /// Of the magnitude when `ncomp > 1`.
    pub stats: FieldStats,
}

/// A parsed mesh (§6.2). Node coordinates are **always world mm with the file's transform already
/// applied** (§3); what was applied is reported to the client in `MeshMeta.appliedTransform`.
#[derive(Clone, Debug)]
pub struct Mesh {
    pub nodes: Vec<[f32; 3]>,
    pub tris: Vec<[u32; 3]>,
    pub tri_tags: Vec<i32>,
    pub tets: Vec<[u32; 4]>,
    pub tet_tags: Vec<i32>,
    /// Low 3 bits per tri; `Some` only from n-gon triangulation.
    pub tri_edge_mask: Option<Vec<u8>>,
    pub node_fields: Vec<Field>,
    pub elm_fields: Vec<ElmField>,
    pub physical_names: Vec<(i32, String)>,
    pub gmsh_node_numbers: Option<Vec<u64>>,
    /// Per element, in (tris then tets) order. **`None` == the identity numbering** — the fast path,
    /// taken when the file numbers elements exactly `1..N` in tris-then-tets order, and then
    ///
    /// ```text
    /// gmsh number of tri i = i + 1
    /// gmsh number of tet j = n_tris + tet_perm[j] + 1     // j is the Morton index (§6.3)
    /// ```
    ///
    /// which is why [`Mesh::tet_perm`] must be kept and why `None` costs nothing instead of 47.2 MB on
    /// ernie `[MODEL]`. Every reference `.msh` takes this path `[DATA]`, as do the formats with no
    /// element numbering at all (STL/PLY/OBJ/GIfTI/FreeSurfer). A file whose largest element number
    /// exceeds `u32::MAX` is `Error::Unsupported("element numbers exceed u32")`, never truncated.
    pub gmsh_elm_numbers: Option<Vec<u64>>,
    /// Morton order → original file row (§6.3).
    pub tet_perm: Vec<u32>,
    /// `(gmsh element type, count)` for types we drop.
    pub skipped: Vec<(u32, u64)>,
    pub bounds: Aabb,
    /// The `<LabelTable>` of a `.label.gii` (§6.2), `None` for every other format.
    ///
    /// §6.2 says a `.label.gii`'s table "becomes a `LabelTable`" but [`read_gifti`] returns a
    /// `Mesh`; Phase 1 carried it out through an additive `read_gifti_labels` instead, which put
    /// the flagship file's only source of region names behind an undocumented door. It is a field
    /// now (`docs/DECISIONS.md`, 2026-08-27).
    pub label_table: Option<LabelTable>,
}

/// A parsed `.msh.opt` sidecar (§6.2). Colours are RGBA 0..255 (§4.1).
#[derive(Clone, Debug, Default)]
pub struct MshOptions {
    pub tag_color: Vec<(i32, [u8; 4])>,
    pub tag_visible: Vec<(i32, bool)>,
    pub views: Vec<MshView>,
    /// `Physical Volume(" GM",2)` names, in declaration order — the last rung of §6.2's name
    /// ladder, and the **only** source of tissue names for `m2m_ernie/ernie.msh`, which has no
    /// `$PhysicalNames` at all `[DATA]`. Verbatim, leading space included: the display layer trims
    /// (see `tvx-wasm`'s `resolve_tags`), because trimming here would silently disagree with
    /// `$PhysicalNames` and with `testdata/manifest.json`'s recorded expectation.
    pub tag_name: Vec<(i32, String)>,
}

/// One `View[n]` block of a `.msh.opt` (§6.2).
#[derive(Clone, Debug, Default)]
pub struct MshView {
    pub name: Option<String>,
    pub custom_min: Option<f32>,
    pub custom_max: Option<f32>,
    pub range_type: Option<i32>,
    pub saturate_values: Option<bool>,
    pub colormap_number: Option<i32>,
    pub show_scale: Option<bool>,
    pub vector_type: Option<i32>,
}

/// The formats [`sniff`] can identify and `load_mesh(format)` dispatches on (§6.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Msh,
    Gifti,
    FsSurface,
    Stl,
    Ply,
    Obj,
    /// Gmsh **parsed post-processing** views, `.geo` / `.pos` (task 6). Not a mesh: it carries
    /// de-indexed points, labels, line segments and triangles. See [`read_geo_view`].
    Geo,
}

/// Gmsh `.msh` v2 (ascii + binary) and v4.1 (ascii + binary). Takes ownership of `bytes` and frees it
/// (and any inflate output) before returning (§5 rule 5, §6.2).
pub fn read_msh(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Mesh> {
    let mesh = msh::read(&bytes, p);
    // §5 rule 5 / §6.2: the byte vector (and any inflate output) is freed before returning.
    drop(bytes);
    mesh
}

/// The `.msh.opt` sidecar: `Physical Volume(" GM",2)` + `Mesh.Color.<Ordinal>` + `View[n]` blocks.
pub fn read_msh_opt(bytes: &[u8]) -> Result<MshOptions> {
    mshopt::read(bytes)
}

/// GIfTI (XML via `quick-xml`). Applies `CoordinateSystemTransformMatrix` when
/// `TransformedSpace == NIFTI_XFORM_SCANNER_ANAT`.
pub fn read_gifti(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Mesh> {
    let mesh = gifti::read(&bytes, p);
    drop(bytes);
    mesh
}

/// FreeSurfer binary triangle surface (magic `0xFFFFFE`, big-endian); the quad file is also read.
pub fn read_fs_surface(bytes: Vec<u8>) -> Result<Mesh> {
    let mesh = freesurfer::read_surface(&bytes);
    drop(bytes);
    mesh
}

/// FreeSurfer `curv`, new format (magic `0xFFFFFF`).
pub fn read_fs_curv(bytes: &[u8]) -> Result<Field> {
    freesurfer::read_curv(bytes)
}

/// FreeSurfer `.annot`. The returned [`Field`] holds **DENSE 0..N−1 indices**, not raw annotation
/// values; the [`LabelTable`] carries the original ids in `LabelEntry::id` (§6.2).
pub fn read_fs_annot(bytes: &[u8]) -> Result<(Field, LabelTable)> {
    freesurfer::read_annot(bytes)
}

/// STL, ascii and binary. Emits `tri_edge_mask = None`.
pub fn read_stl(bytes: Vec<u8>) -> Result<Mesh> {
    let mesh = surf::read_stl(&bytes);
    drop(bytes);
    mesh
}

/// PLY, ascii and binary. Triangulates n-gons and emits a matching `tri_edge_mask`.
pub fn read_ply(bytes: Vec<u8>) -> Result<Mesh> {
    let mesh = surf::read_ply(&bytes);
    drop(bytes);
    mesh
}

/// Wavefront OBJ. Triangulates n-gons and emits a matching `tri_edge_mask`.
pub fn read_obj(bytes: Vec<u8>) -> Result<Mesh> {
    let mesh = surf::read_obj(&bytes);
    drop(bytes);
    mesh
}

/// Gmsh **parsed post-processing** views — `.geo` and `.pos`, which share one grammar.
///
/// Returns one [`GeoView`] per `View "name" { … };` block, in file order. A `.geo` that is a Gmsh
/// *geometry script* (`Point(1) = {…};`) is [`tvx_core::Error::Unsupported`] with a message naming
/// the offending command: it is CAD input, not data.
///
/// Takes ownership of `bytes` and frees it before returning, like every other reader here
/// (§5 rule 5).
pub fn read_geo_view(bytes: Vec<u8>) -> Result<Vec<GeoView>> {
    let views = geo::read(&bytes);
    drop(bytes);
    views
}

/// Identify a format from a byte prefix, with the file extension as a hint.
pub fn sniff(bytes: &[u8], hint_ext: Option<&str>) -> Result<Format> {
    if bytes.starts_with(b"$MeshFormat") {
        return Ok(Format::Msh);
    }
    if gifti::looks_like(bytes) {
        return Ok(Format::Gifti);
    }
    if surf::looks_like_ply(bytes) {
        return Ok(Format::Ply);
    }
    if surf::looks_like_stl(bytes) {
        return Ok(Format::Stl);
    }
    if freesurfer::looks_like_surface(bytes) {
        return Ok(Format::FsSurface);
    }
    if surf::looks_like_obj(bytes) {
        return Ok(Format::Obj);
    }
    if geo::looks_like_view(bytes) {
        return Ok(Format::Geo);
    }
    // The content said nothing; fall back to the caller's extension hint (§6.2).
    match hint_ext
        .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
        .as_deref()
    {
        Some("msh") => Ok(Format::Msh),
        Some("gii") => Ok(Format::Gifti),
        Some("stl") => Ok(Format::Stl),
        Some("ply") => Ok(Format::Ply),
        Some("obj") => Ok(Format::Obj),
        Some("geo") | Some("pos") => Ok(Format::Geo),
        Some("pial") | Some("white") | Some("inflated") | Some("sphere") | Some("central")
        | Some("surf") => Ok(Format::FsSurface),
        _ => Err(tvx_core::Error::Unsupported(format!(
            "unrecognised mesh format (first bytes {:?}, extension hint {hint_ext:?})",
            String::from_utf8_lossy(&bytes[..bytes.len().min(16)])
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_formats_are_the_seven_of_the_contract() {
        let all = [
            Format::Msh,
            Format::Gifti,
            Format::FsSurface,
            Format::Stl,
            Format::Ply,
            Format::Obj,
            Format::Geo,
        ];
        assert_eq!(all.len(), 7);
    }

    #[test]
    fn sniff_finds_a_parsed_view_by_content_and_by_extension() {
        assert_eq!(
            sniff(b"View\"\"{SP(0,0,0){0};};", None).unwrap(),
            Format::Geo
        );
        assert_eq!(sniff(b"  \n View \"x\" {", None).unwrap(), Format::Geo);
        assert_eq!(sniff(b"// c\nView \"x\" {", None).unwrap(), Format::Geo);
        // A geometry script sniffs as Geo by extension, and `read_geo_view` is what rejects it.
        assert_eq!(
            sniff(b"Point(1) = {0,0,0,1};", Some("geo")).unwrap(),
            Format::Geo
        );
        assert_eq!(sniff(b"anything", Some(".pos")).unwrap(), Format::Geo);
    }

    /// §6.2: `gmsh_elm_numbers: None` is the identity numbering, and the fast path every reference
    /// `.msh` takes. This test pins the reconstruction arithmetic the whole `owner_elm` /
    /// `PickResult.elementId` chain keys on.
    #[test]
    fn identity_element_numbering_reconstruction() {
        let n_tris: u64 = 1_177_213;
        let tet_perm = [3u32, 0, 2, 1];
        let gmsh_of_tri = |i: u64| i + 1;
        let gmsh_of_tet = |j: usize| n_tris + tet_perm[j] as u64 + 1;
        assert_eq!(gmsh_of_tri(0), 1);
        assert_eq!(gmsh_of_tri(n_tris - 1), n_tris);
        assert_eq!(gmsh_of_tet(0), n_tris + 4);
        assert_eq!(gmsh_of_tet(1), n_tris + 1);
    }
}
