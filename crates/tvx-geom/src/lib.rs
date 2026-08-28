//! `tvx-geom` — surfaces, boundary extraction, Morton order, tet blocks, plane cut, isolation,
//! marching cubes/tets, elm↔node conversion, contours, point location, orientation.
//!
//! This crate is [`docs/ARCHITECTURE.md` §6.3](../../../docs/ARCHITECTURE.md) verbatim; every public
//! signature is **frozen** (§12.3). Phase 0 ships signatures only.
//!
//! Normative rules Phase 1 must honour (§6.3), restated so they are not lost:
//!
//! * **The default 3D representation of a mesh that has surface elements is its own tagged triangles.**
//!   SimNIBS invariant, verified 0 missing / 0 extra on `ernie.msh` (128,614 exterior + 1,048,599
//!   tag-differing interior = 1,177,213) and `ernie-seeg.msh` (202,318 + 2,427,261 = 2,629,579) `[DATA]`.
//!   [`tag_surfaces`] therefore takes **no topology** and does no geometry work beyond grouping and normals.
//! * [`extract_boundary`] serves (a) tri-less tet meshes — `grey_Thalamus_TI.msh` has 1,340,029 tets and
//!   **0 tris** `[DATA]` — and (b) post-isolation / post-clip boundaries.
//! * **Unique faces without a packed key.** Counting sort on the face's *minimum vertex* into an
//!   `n_nodes + 1` count array, then sort within buckets on the remaining `(v1, v2)` pair. A 3×21-bit u64
//!   key aliases distinct faces on `ernie_seeg.msh` (2,301,899 nodes = 22 bits) `[DATA]`, silently merging
//!   them as interior and deleting real boundary faces.
//! * [`build_topology`] is **explicit, awaitable and progress-reporting**; it is called eagerly *after the
//!   first frame*, and only when isolation or clipping needs it — never lazily from inside a drag.
//! * **Spatial locality at load.** [`morton_reorder`] reorders tets by the 30-bit Morton code of their
//!   centroid (3 × 10-bit radix passes); `tet_tags` and every tet-side `elm_fields` entry are permuted with
//!   them. **The UI always reports Gmsh element numbers, never internal indices.**
//! * [`plane_cut`] visits a block iff `|n·c + offset| <= ex·|nx| + ey·|ny| + ez·|nz|`. Output must be
//!   **bit-identical with and without the block index** (§11 "Cut index equivalence").
//! * **[`Cut::edge_mask`] emission rule.** Bit *i* means "the edge opposite vertex *i* is a real element
//!   edge". A 1-3 split emits one triangle, mask `0b111`. A 2-2 split emits quad `(a,b,c,d)` in
//!   cut-polygon order as `(a,b,c)` and `(a,c,d)`; the diagonal `a–c` is opposite `b` (index 1) in the
//!   first ⇒ mask `0b101`, and opposite `d` (index 2) in the second ⇒ mask `0b011`.
//! * [`tag_surfaces`] / [`extract_boundary`] output on a tet mesh is always fully unmasked
//!   (`edge_mask = None`).
//! * **De-indexing, normal generation and any vertex-buffer expansion are geometry**: they happen here,
//!   in the worker, and arrive as transferables. The engine never builds a vertex buffer element-by-element.
//! * **Determinism.** Geometry outputs are byte-identical across native and wasm builds; they use only
//!   `+ − × ÷ sqrt` and integer ops. Any function using a transcendental is marked
//!   `#[doc(hidden)] // non-portable` and excluded from cross-build golden tests. No `HashMap` iteration
//!   order appears in any output.

#![forbid(unsafe_code)]

mod bucket;
mod centroids;
mod cut;
mod fields;
mod isolate;
mod labels;
mod locator;
mod march;
mod morton;
mod normals;
mod surface;
mod util;
mod voxel;

pub use centroids::tet_centroids;
pub use cut::{plane_cut, surface_contours};
pub use fields::{elm_to_node, node_to_elm};
pub use isolate::isolate;
pub use labels::label_centroids;
pub use locator::{build_point_locator, locate_point};
pub use march::{marching_cubes, marching_cubes_label, marching_tets};
pub use morton::{build_tet_blocks, morton_reorder};
pub use normals::{face_normals, orient_surface, vertex_normals};
pub use surface::{build_topology, extract_boundary, tag_surfaces};

use tvx_core::Aabb;

/// Whether a [`SurfaceBuffers`] is index-shared (smooth normals) or de-indexed (face normals, per-corner
/// attributes for the §7.4 barycentric wireframe).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceVariant {
    Indexed,
    Deindexed,
}

/// A contiguous run of one tag inside a [`SurfaceBuffers`], for per-tag draw calls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TagRange {
    pub tag: i32,
    pub first: u32,
    pub count: u32,
}

/// Draw-ready triangle geometry (§6.3). Every array is an owned `Vec`, so wasm-bindgen `.slice()`s it
/// into a fresh transferable ArrayBuffer and the worker transfers `result.buffer` as-is (§6.4).
#[derive(Clone, Debug)]
pub struct SurfaceBuffers {
    pub variant: SurfaceVariant,
    /// 3 per vertex.
    pub positions: Vec<f32>,
    /// 3 per vertex — smooth for [`SurfaceVariant::Indexed`], face for [`SurfaceVariant::Deindexed`].
    pub normals: Vec<f32>,
    /// `Some` iff `Indexed`.
    pub indices: Option<Vec<u32>>,
    /// `Some` iff `Indexed`: vertex → **INTERNAL 0-based node index** (the row in `Mesh::nodes`), which is
    /// what the §7.4 node-field texture is indexed by. **NOT** a Gmsh node number — that is
    /// `Mesh::gmsh_node_numbers`.
    pub node_index: Option<Vec<u32>>,
    /// `Some` iff `Deindexed`: `0|1|2` corner ordinal.
    pub corner: Option<Vec<u8>>,
    /// 1 per triangle: Gmsh element number (§6.2's identity rule when `gmsh_elm_numbers` is `None`).
    pub owner_elm: Vec<u32>,
    /// 1 per triangle.
    pub face_tag: Vec<i32>,
    /// 1 per triangle, low 3 bits; `None` = fully unmasked.
    pub edge_mask: Option<Vec<u8>>,
    /// Ranges into `indices` ([`SurfaceVariant::Indexed`]) or vertices ([`SurfaceVariant::Deindexed`]).
    pub per_tag: Vec<TagRange>,
    pub orient: OrientReport,
    pub bounds: Aabb,
}

/// What [`orient_surface`] found. `open_components > 0` forces `MeshLayer.faceMode: 'both'` (§4.4).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OrientReport {
    pub components: u32,
    pub open_components: u32,
    pub non_manifold_edges: u64,
    pub flipped_components: u32,
}

/// Unique tet faces and their owners. Carries **no** `tet_faces` — nothing consumes it, and it would cost
/// 75.6 MB on ernie `[MODEL]` (§6.3).
#[derive(Clone, Debug)]
pub struct TetTopology {
    pub faces: Vec<[u32; 3]>,
    /// `[-1, _]` in the second slot marks a boundary face.
    pub face_tets: Vec<[i32; 2]>,
}

/// Per-block AABBs over the Morton-ordered tets, for [`plane_cut`]'s reject test. 6 f32 per block:
/// `(cx, cy, cz, ex, ey, ez)` — centre and half-extent.
#[derive(Clone, Debug)]
pub struct TetBlocks {
    /// Block size; default 64.
    pub blk: usize,
    pub aabb: Vec<f32>,
}

/// A uniform grid over tet centroids, backing [`locate_point`].
#[derive(Clone, Debug)]
pub struct PointLocator {
    pub(crate) cell: [f32; 3],
    pub(crate) dims: [u32; 3],
    pub(crate) origin: [f32; 3],
    pub(crate) starts: Vec<u32>,
    pub(crate) items: Vec<u32>,
}

/// Where a cut vertex sits on its parent edge, so the engine can interpolate any node field onto the cap
/// without a second round trip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CutInterp {
    pub n0: u32,
    pub n1: u32,
    pub t: f32,
}

/// One plane's cap geometry (§6.3). With multiple planes, each `Cut` is clipped by the *other* planes.
#[derive(Clone, Debug)]
pub struct Cut {
    /// Index into the `planes` slice.
    pub plane: usize,
    /// 3 per vertex, de-indexed triangles.
    pub positions: Vec<f32>,
    /// 1 per vertex.
    pub interp: Vec<CutInterp>,
    /// 1 per triangle: Gmsh element number.
    pub owner_tet: Vec<u32>,
    /// 1 per triangle.
    pub tag: Vec<i32>,
    /// 1 per triangle, low 3 bits. See the emission rule in the crate docs.
    pub edge_mask: Vec<u8>,
    /// 6 per segment — 2D overlay only (§7.4).
    pub edge_segments: Vec<f32>,
    /// 6 per segment — tag-boundary contours for the 2D overlay.
    pub boundary_segments: Vec<f32>,
}

// --- Isolation criteria. This struct crosses the wasm boundary as JSON (§6.4 `mesh_isolate`), so every
// serde attribute below is part of the frozen contract and pins it to §6.5.1 `IsolateCriteriaT` name for
// name.

/// The isolation predicate, deserialised straight from `JSON.stringify(criteria)` (§6.4, §6.5.1).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolateCriteria {
    pub tags: Option<Vec<i32>>,
    pub field: Option<FieldRange>,
    pub sphere: Option<Sphere>,
    #[serde(rename = "box")]
    pub bbox: Option<Aabb>,
    pub label_volume: Option<LabelVolumeCriteria>,
    pub combine: Combine,
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldRange {
    pub source: FieldSource,
    pub name: String,
    pub component: Component,
    pub lo: f32,
    pub hi: f32,
}

#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(deny_unknown_fields)]
pub struct Sphere {
    pub center: [f32; 3],
    pub radius: f32,
}

/// `"node" | "elm"`.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldSource {
    Node,
    Elm,
}

/// `"mag" | 0 | 1 | 2`.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum Component {
    Mag(MagTag),
    C(u8),
}

#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MagTag {
    Mag,
}

/// `"all" | "any"`.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Combine {
    All,
    Any,
}

/// The label-volume isolation criterion.
///
/// The sample array is **not** part of this struct: it arrives as [`isolate`]'s separate
/// `label_volume` argument, because neither an `ArrayBuffer` nor a `Uint32Array` survives
/// `JSON.stringify`. `dtype` names how to reinterpret those bytes; `labels` is a plain JSON array of
/// numbers. A `dtype`/`dims`/byte-length mismatch is [`tvx_core::Error::Parse`].
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelVolumeCriteria {
    pub dims: [usize; 3],
    /// A §6.5.1 `Mat4x4`: **flat, length 16, column-major**, so `world_to_voxel[12..15]` is the
    /// translation and `world_to_voxel[col * 4 + row]` is element `(row, col)` (§3, matrix layout).
    /// Deliberately not `[[f64; 4]; 4]` — serde reads that only from a nested array-of-arrays, and no
    /// `Mat4x4` on the wire is nested; §6.5's worked example writes these 16 numbers flat.
    pub world_to_voxel: [f64; 16],
    pub dtype: String,
    pub volume_index: usize,
    pub labels: Vec<u32>,
}

/// The whole probe, not an index (§6.3): the ≤ 50 ms hover budget cannot afford a second round trip.
#[derive(Clone, Debug)]
pub struct ProbeHit {
    /// What the UI shows; **ALWAYS** the Gmsh element number (§6.2).
    pub gmsh_elm: u32,
    /// Internal Morton-ordered tet index; never leaves the worker.
    pub tet_index: u32,
    pub tag: i32,
    /// Every node field, barycentrically interpolated at the probe point.
    pub node_values: Vec<(String, Vec<f32>)>,
    /// Every element field, at the containing tet.
    pub elm_values: Vec<(String, Vec<f32>)>,
}

/// Glyph origins for a **volumetric** `GlyphSpec` (§7.4): one point per surviving tet, plus the Gmsh
/// element number that keys the field texture. Not geometry — no triangles, no normals — which is what
/// keeps §7.4's "no new geometry from WASM" true while the unrestricted glyph case still has origins.
///
/// Ordered by the internal Morton index (§6.3's spatial locality), so a strided subsample is spread
/// through the volume rather than clustered by physical tag.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Centroids {
    /// 3 per origin.
    pub positions: Vec<f32>,
    /// 1 per origin: Gmsh element number (§6.2's identity rule when `gmsh_elm_numbers` is `None`).
    pub owner_tet: Vec<u32>,
}

/// One label's centre of mass, for the Phase-2 region panel's jump-to-centroid.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LabelCentroid {
    pub id: u32,
    pub centroid: [f32; 3],
    pub count: u64,
}

// --- load-time (§6.3) and the exported ops (§6.4) are implemented in the modules re-exported at
// the top of this file. The signatures below are frozen (§12.3); each module carries the rules it
// implements in its own header.

#[cfg(test)]
mod tests {
    use super::*;

    /// §6.5.1's worked isolation example, byte for byte, must deserialise into §6.3's `IsolateCriteria`.
    /// This is the test that pins the two sides of the wasm boundary to each other: camelCase members,
    /// `box` kept as `box`, lowercase enum strings, `"mag"` as an untagged variant.
    #[test]
    fn isolate_criteria_parses_the_contract_wire_example() {
        let json = r#"{
            "tags": [2],
            "field": { "source": "elm", "name": "TI_max", "component": "mag", "lo": 0.2, "hi": 0.6 },
            "labelVolume": {
                "dims": [256, 256, 208],
                "worldToVoxel": [0,-1,0,0, 0,0,1,0, 1,0,0,0, 99.737457,-154.1875,143.642273,1],
                "dtype": "u16",
                "volumeIndex": 0,
                "labels": [2, 3]
            },
            "combine": "all"
        }"#;
        let c: IsolateCriteria = serde_json::from_str(json).expect("parses");
        assert_eq!(c.tags.as_deref(), Some(&[2i32][..]));
        assert_eq!(c.combine, Combine::All);
        let f = c.field.expect("field");
        assert_eq!(f.source, FieldSource::Elm);
        assert_eq!(f.component, Component::Mag(MagTag::Mag));
        let lv = c.label_volume.expect("labelVolume");
        assert_eq!(lv.dims, [256, 256, 208]);
        assert_eq!(lv.dtype, "u16");
        assert_eq!(lv.labels, vec![2, 3]);
        // FLAT, length 16, column-major (§3, matrix layout) — the JSON above is copied out of §6.5
        // character for character, so this is the assertion that a nested `[[f64; 4]; 4]` field would
        // fail with `invalid type: integer 0, expected an array of length 4`.
        assert_eq!(
            lv.world_to_voxel,
            [
                0.0, -1.0, 0.0, 0.0, //
                0.0, 0.0, 1.0, 0.0, //
                1.0, 0.0, 0.0, 0.0, //
                99.737457, -154.1875, 143.642273, 1.0,
            ]
        );
        // The translation lives in the LAST FOUR slots, not in every fourth one.
        assert_eq!(
            &lv.world_to_voxel[12..15],
            &[99.737457, -154.1875, 143.642273]
        );
        assert!(c.sphere.is_none() && c.bbox.is_none());
    }

    /// The nested `[[f64; 4]; 4]` spelling this field used to have is not what the wire carries, and a
    /// future "tidy-up" back to it must be red, not silently green (§3, matrix layout).
    #[test]
    fn world_to_voxel_rejects_a_nested_matrix() {
        let json = r#"{
            "labelVolume": {
                "dims": [2, 2, 2],
                "worldToVoxel": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
                "dtype": "u8",
                "volumeIndex": 0,
                "labels": [1]
            },
            "combine": "any"
        }"#;
        let err = serde_json::from_str::<IsolateCriteria>(json).expect_err("nested must not parse");
        assert!(err.to_string().contains("invalid type"), "{err}");
    }

    /// `box` is a Rust keyword, so the field is `bbox` — but the wire name must stay `box` (§6.5.1).
    #[test]
    fn box_criterion_keeps_its_wire_name() {
        let json = r#"{"box": {"min": [0,0,0], "max": [1,2,3]}, "combine": "any"}"#;
        let c: IsolateCriteria = serde_json::from_str(json).expect("parses");
        let b = c.bbox.expect("box");
        assert_eq!(b.max, [1.0, 2.0, 3.0]);
        assert_eq!(c.combine, Combine::Any);
    }

    /// `deny_unknown_fields` is what stops a renamed member from being silently ignored.
    #[test]
    fn unknown_criterion_member_is_rejected() {
        let json = r#"{"combine": "all", "tagz": [1]}"#;
        assert!(serde_json::from_str::<IsolateCriteria>(json).is_err());
    }

    /// `component: 0 | 1 | 2` shares the untagged enum with `"mag"`.
    #[test]
    fn numeric_component_selector() {
        let json =
            r#"{"combine":"any","field":{"source":"node","name":"E","component":2,"lo":0,"hi":1}}"#;
        let c: IsolateCriteria = serde_json::from_str(json).expect("parses");
        assert_eq!(c.field.expect("field").component, Component::C(2));
    }
}
