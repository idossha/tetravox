//! Every §6.3 call site, behind one cargo feature.
//!
//! `tvx-geom` is still the Phase-0 signature stub: every function in it is `unimplemented!()`, and
//! `tvx-geom` belongs to another agent (AGENTS rule 3), so this crate cannot fill it in. Calling a
//! stub from wasm is not a recoverable error — `unimplemented!()` panics, a panic on
//! `wasm32-unknown-unknown` traps, and a trapped module is poisoned for the life of the worker
//! (§5 rule 8). Eleven of the seventeen §6.5.2 ops route through §6.3, and so does `load_mesh`'s
//! load-time work, so an ungated call would take the *whole* mesh half of the protocol down with
//! it, including ops that only need the parsed `Mesh`.
//!
//! So the call sites live here, written exactly as they will run, behind `--features geom`:
//!
//! * **feature on** — every wrapper is `tvx_geom::<same name>`, one-to-one, no logic of its own.
//! * **feature off** (the default while `tvx-geom` is a stub) — every wrapper returns
//!   `Error::Unsupported`, which reaches the client as a clean `{ code: 'unsupported' }` and leaves
//!   the module alive, and `load_mesh` skips the load-time trio.
//!
//! **The integrator flips `default = ["geom"]` in `crates/tvx-wasm/Cargo.toml` in the same commit
//! that merges a real `tvx-geom`.** `cargo clippy --workspace --all-targets --features geom` keeps
//! the enabled arm compiling in the meantime.

use tvx_core::{BitMask, Error, Field, Plane, ProgressSink, Result};
use tvx_geom::{
    Cut, IsolateCriteria, LabelCentroid, OrientReport, PointLocator, ProbeHit, SurfaceBuffers,
    SurfaceVariant, TetBlocks, TetTopology,
};
use tvx_mesh_io::{ElmField, Mesh};
use tvx_nifti::{Volume, VolumeData};

/// True when this build calls the real `tvx-geom`. The e2e suite reads it through
/// `mesh_surface` on a fixture and skips the geometry specs rather than failing them.
pub const ENABLED: bool = cfg!(feature = "geom");

#[cfg_attr(feature = "geom", allow(dead_code))]
fn unavailable(what: &str) -> Error {
    Error::Unsupported(format!(
        "tvx-geom §6.3 is not built into this module, so `{what}` is unavailable: \
         tvx-geom is still the Phase-0 `unimplemented!()` stub. Rebuild tvx-wasm with \
         `--features geom` once a real tvx-geom has landed (docs/DECISIONS.md)."
    ))
}

/// §6.4: "Morton reorder, `build_tet_blocks` and `build_point_locator` are built here", plus the
/// `OrientReport` `load_mesh`'s meta carries. Tet-side work is skipped for a mesh with no tets —
/// there is nothing to order, block or locate, and `tet_perm` is empty by construction.
pub fn load_time(mesh: &mut Mesh) -> (Option<TetBlocks>, Option<PointLocator>, OrientReport) {
    #[cfg(feature = "geom")]
    {
        let orient = tvx_geom::orient_surface(&mesh.nodes, &mut mesh.tris);
        if mesh.tets.is_empty() {
            return (None, None, orient);
        }
        mesh.tet_perm = tvx_geom::morton_reorder(mesh);
        let blocks = tvx_geom::build_tet_blocks(mesh, 64);
        let locator = tvx_geom::build_point_locator(mesh);
        (Some(blocks), Some(locator), orient)
    }
    #[cfg(not(feature = "geom"))]
    {
        // `read_msh` already emits the identity `tet_perm` (§6.2), so the Gmsh element numbers
        // reconstructed from it are the file's own — correct, merely without spatial locality.
        let _ = mesh;
        (None, None, OrientReport::default())
    }
}

pub fn tag_surfaces(
    mesh: &Mesh,
    variant: SurfaceVariant,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::tag_surfaces(mesh, variant, p)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, variant, p);
        Err(unavailable("tag_surfaces"))
    }
}

pub fn extract_boundary(
    mesh: &Mesh,
    topo: Option<&TetTopology>,
    mask: Option<&BitMask>,
    variant: SurfaceVariant,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::extract_boundary(mesh, topo, mask, variant, p)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, topo, mask, variant, p);
        Err(unavailable("extract_boundary"))
    }
}

pub fn build_topology(mesh: &Mesh, p: &mut dyn ProgressSink) -> Result<TetTopology> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::build_topology(mesh, p)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, p);
        Err(unavailable("build_topology"))
    }
}

pub fn plane_cut(
    mesh: &Mesh,
    blocks: &TetBlocks,
    planes: &[Plane],
    mask: Option<&BitMask>,
) -> Result<Vec<Cut>> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::plane_cut(mesh, blocks, planes, mask)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, blocks, planes, mask);
        Err(unavailable("plane_cut"))
    }
}

pub fn isolate(
    mesh: &Mesh,
    crit: &IsolateCriteria,
    label_volume: Option<&VolumeData>,
    p: &mut dyn ProgressSink,
) -> Result<BitMask> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::isolate(mesh, crit, label_volume, p)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, crit, label_volume, p);
        Err(unavailable("isolate"))
    }
}

pub fn elm_to_node(mesh: &Mesh, field: &ElmField) -> Result<Field> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::elm_to_node(mesh, field)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, field);
        Err(unavailable("elm_to_node"))
    }
}

pub fn node_to_elm(mesh: &Mesh, field: &Field) -> Result<ElmField> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::node_to_elm(mesh, field)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, field);
        Err(unavailable("node_to_elm"))
    }
}

pub fn marching_cubes(
    vol: &Volume,
    vol_index: usize,
    iso: f32,
    smooth: bool,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::marching_cubes(vol, vol_index, iso, smooth, p)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (vol, vol_index, iso, smooth, p);
        Err(unavailable("marching_cubes"))
    }
}

pub fn marching_tets(
    mesh: &Mesh,
    node_field: &[f32],
    iso: f32,
    mask: Option<&BitMask>,
    p: &mut dyn ProgressSink,
) -> Result<SurfaceBuffers> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::marching_tets(mesh, node_field, iso, mask, p)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, node_field, iso, mask, p);
        Err(unavailable("marching_tets"))
    }
}

pub fn surface_contours(mesh: &Mesh, plane: &Plane, mask: Option<&BitMask>) -> Result<Vec<f32>> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::surface_contours(mesh, plane, mask)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, plane, mask);
        Err(unavailable("surface_contours"))
    }
}

pub fn locate_point(
    mesh: &Mesh,
    grid: Option<&PointLocator>,
    p: [f32; 3],
) -> Result<Option<ProbeHit>> {
    #[cfg(feature = "geom")]
    {
        let Some(grid) = grid else {
            return Err(Error::Parse(
                "this mesh has no point locator (no tets)".into(),
            ));
        };
        Ok(tvx_geom::locate_point(mesh, grid, p))
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (mesh, grid, p);
        Err(unavailable("locate_point"))
    }
}

pub fn label_centroids(vol: &Volume, vol_index: usize) -> Result<Vec<LabelCentroid>> {
    #[cfg(feature = "geom")]
    {
        tvx_geom::label_centroids(vol, vol_index)
    }
    #[cfg(not(feature = "geom"))]
    {
        let _ = (vol, vol_index);
        Err(unavailable("label_centroids"))
    }
}
