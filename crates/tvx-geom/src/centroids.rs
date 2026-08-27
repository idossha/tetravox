//! `tet_centroids` (§6.3) — glyph origins for a **volumetric** `GlyphSpec` (§7.4).
//!
//! §7.4 draws vector glyphs as "one instanced draw … with per-instance origin/direction/magnitude.
//! **No new geometry from WASM.**" Origins still have to come from somewhere, and for two of the
//! three cases they already do: a *surface* glyph reads `SurfacePayload.positions` + `owner_elm`, and
//! a *cut-plane-restricted* glyph reads `CutPayload.positions` + `owner_tet`. The unrestricted case
//! — glyphs on interior tets with no cut plane active, which is what `ernie_TDCS_1_scalar.msh`'s `E`
//! field over 5,900,498 elements invites — had no source at all: no §6.5.2 op returned element
//! centroids or bulk node positions.
//!
//! This is that source, and it is deliberately *not* geometry: one point per tet, no triangles, no
//! normals, no vertex-buffer expansion. The engine binds `positions` as an instance attribute and
//! `owner_tet` as the key into its field texture.
//!
//! Rules, normative (§6.3):
//!
//! * The centroid of a tet is the **arithmetic mean of its four node positions** — `+` and `÷` only,
//!   so it is bit-identical on wasm32 and native like every other §6.3 output.
//! * Tets are visited in **Morton order** (the internal index, §6.3's "spatial locality at load"), so
//!   a strided subsample is spatially spread rather than clustered by physical tag — which is what
//!   makes `stride` a usable density control instead of a way to light up one tissue.
//! * `owner_tet` is the **Gmsh element number** (§6.2), the same number `CutPayload.owner_tet` and
//!   `ProbeHit.gmsh_elm` carry, so one field texture indexes all three.
//! * `tags` and `mask` filter **first**; `stride` then keeps every `stride`-th *surviving* tet, so the
//!   count is `ceil(surviving / stride)` and a small tag still gets glyphs. Filtering after striding
//!   would make a 1-in-64 sample of a 4 %-of-the-mesh tag almost always empty.
//! * `stride = 0` is `Error::Parse`. `stride = 1` is every surviving tet.

use tvx_core::{BitMask, Error, Result};
use tvx_mesh_io::Mesh;

use crate::util::tet_gmsh_number;
use crate::Centroids;

/// Per-tet glyph origins (§6.3). See the module header for the rules this implements.
pub fn tet_centroids(
    mesh: &Mesh,
    mask: Option<&BitMask>,
    stride: usize,
    tags: Option<&[i32]>,
) -> Result<Centroids> {
    if stride == 0 {
        return Err(Error::Parse("centroid stride 0; expected >= 1".into()));
    }
    // A tag list that names nothing on this mesh is an empty answer, not an error: the engine
    // derives it from `tagStyle` visibility, and hiding every tissue is a legitimate state.
    let keep_tag = |t: i32| tags.is_none_or(|list| list.contains(&t));

    let mut out = Centroids {
        positions: Vec::new(),
        owner_tet: Vec::new(),
    };
    let mut surviving = 0usize;
    for (j, tet) in mesh.tets.iter().enumerate() {
        if mask.is_some_and(|m| !m.get(j)) {
            continue;
        }
        if !keep_tag(mesh.tet_tags[j]) {
            continue;
        }
        let take = surviving.is_multiple_of(stride);
        surviving += 1;
        if !take {
            continue;
        }
        let (a, b, c, d) = (
            mesh.nodes[tet[0] as usize],
            mesh.nodes[tet[1] as usize],
            mesh.nodes[tet[2] as usize],
            mesh.nodes[tet[3] as usize],
        );
        for k in 0..3 {
            out.positions.push((a[k] + b[k] + c[k] + d[k]) / 4.0);
        }
        out.owner_tet.push(tet_gmsh_number(mesh, j));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tvx_mesh_io::Mesh;

    /// Four tets sharing the unit corner, with known centroids: node 0 at the origin and one tet per
    /// axis triple, so each centroid is a quarter of the sum of its own corners.
    fn mesh_of(tets: Vec<[u32; 4]>, tet_tags: Vec<i32>) -> Mesh {
        Mesh {
            nodes: vec![
                [0.0, 0.0, 0.0],
                [4.0, 0.0, 0.0],
                [0.0, 4.0, 0.0],
                [0.0, 0.0, 4.0],
                [4.0, 4.0, 4.0],
            ],
            tris: Vec::new(),
            tri_tags: Vec::new(),
            tets,
            tet_tags,
            tri_edge_mask: None,
            node_fields: Vec::new(),
            elm_fields: Vec::new(),
            physical_names: Vec::new(),
            gmsh_node_numbers: None,
            gmsh_elm_numbers: None,
            tet_perm: Vec::new(),
            skipped: Vec::new(),
            bounds: tvx_core::Aabb {
                min: [0.0; 3],
                max: [4.0; 3],
            },
            label_table: None,
        }
    }

    fn four_tets() -> Mesh {
        mesh_of(
            vec![[0, 1, 2, 3], [1, 2, 3, 4], [0, 1, 2, 4], [0, 1, 3, 4]],
            vec![1, 1, 2, 2],
        )
    }

    #[test]
    fn a_centroid_is_the_mean_of_the_four_corners() {
        let m = four_tets();
        let c = tet_centroids(&m, None, 1, None).expect("centroids");
        assert_eq!(c.owner_tet.len(), 4);
        assert_eq!(c.positions.len(), 12);
        // Tet 0 = (0,0,0) (4,0,0) (0,4,0) (0,0,4) ⇒ (1,1,1).
        assert_eq!(&c.positions[0..3], &[1.0, 1.0, 1.0]);
        // Tet 1 = (4,0,0) (0,4,0) (0,0,4) (4,4,4) ⇒ (2,2,2).
        assert_eq!(&c.positions[3..6], &[2.0, 2.0, 2.0]);
    }

    /// §6.2's identity rule: with no `gmsh_elm_numbers` and no tris, tet `j` is element `j + 1`.
    #[test]
    fn owner_tet_is_the_gmsh_element_number() {
        let m = four_tets();
        let c = tet_centroids(&m, None, 1, None).expect("centroids");
        assert_eq!(c.owner_tet, vec![1, 2, 3, 4]);
    }

    #[test]
    fn stride_keeps_every_nth_surviving_tet() {
        let m = four_tets();
        for (stride, want) in [(1usize, 4usize), (2, 2), (3, 2), (4, 1), (9, 1)] {
            let c = tet_centroids(&m, None, stride, None).expect("centroids");
            assert_eq!(c.owner_tet.len(), want, "stride {stride}");
            assert_eq!(c.positions.len(), want * 3, "stride {stride}");
        }
        // Every count is ceil(surviving / stride), and the first survivor is always taken.
        assert_eq!(
            tet_centroids(&m, None, 3, None)
                .expect("centroids")
                .owner_tet,
            vec![1, 4]
        );
    }

    #[test]
    fn tags_filter_before_stride() {
        let m = four_tets();
        let two = tet_centroids(&m, None, 1, Some(&[2])).expect("centroids");
        assert_eq!(two.owner_tet, vec![3, 4]);
        // …and striding a filtered set still yields glyphs, which is the whole point of the order.
        let strided = tet_centroids(&m, None, 2, Some(&[2])).expect("centroids");
        assert_eq!(strided.owner_tet, vec![3]);
        // A tag nobody has is empty, not an error.
        let none = tet_centroids(&m, None, 1, Some(&[99])).expect("centroids");
        assert!(none.owner_tet.is_empty() && none.positions.is_empty());
    }

    #[test]
    fn the_isolation_mask_filters_too() {
        let m = four_tets();
        let mut mask = BitMask::new_all(4, false);
        mask.set(1, true);
        mask.set(3, true);
        let c = tet_centroids(&m, Some(&mask), 1, None).expect("centroids");
        assert_eq!(c.owner_tet, vec![2, 4]);
        // Mask and tags combine: tet 3 is the only tag-2 tet in the mask.
        let both = tet_centroids(&m, Some(&mask), 1, Some(&[2])).expect("centroids");
        assert_eq!(both.owner_tet, vec![4]);
    }

    #[test]
    fn stride_zero_is_a_parse_error() {
        let m = four_tets();
        let err = tet_centroids(&m, None, 0, None).expect_err("stride 0");
        assert!(matches!(err, Error::Parse(_)), "{err}");
    }

    #[test]
    fn a_mesh_with_no_tets_is_empty_rather_than_an_error() {
        let m = mesh_of(Vec::new(), Vec::new());
        let c = tet_centroids(&m, None, 1, None).expect("centroids");
        assert!(c.positions.is_empty() && c.owner_tet.is_empty());
    }
}
