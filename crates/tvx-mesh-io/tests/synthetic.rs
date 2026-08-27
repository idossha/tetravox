//! Hand-built inputs for the §6.2 paths no committed fixture reaches: an element type that has to
//! be *skipped* (and skipped by the right number of bytes), a file whose tet block precedes its
//! tri block, a multi-time-step data section, a FreeSurfer quad file, and a big-endian PLY.
//!
//! These are deliberately tiny and written inline: the point is that the byte layout is visible
//! next to the assertion, so a reader that drifts cannot be "fixed" by regenerating a fixture.

use tvx_core::{Error, NoProgress};
use tvx_mesh_io::{read_fs_surface, read_msh, read_ply, sniff};

/// Four nodes: the origin and the three unit points.
const NODES_V2_ASCII: &str = "\
$MeshFormat
2.2 0 8
$EndMeshFormat
$Nodes
4
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
$EndNodes
";

#[test]
fn an_unsupported_element_type_is_counted_not_fatal() {
    // Type 1 is a 2-node line and type 15 a 1-node point: §6.2 keeps only 2 and 4, and counts the
    // rest into `skipped` rather than failing.
    let src = format!(
        "{NODES_V2_ASCII}$Elements
4
1 4 2 7 7 1 2 3 4
2 1 2 5 5 1 2
3 15 2 6 6 1
4 2 2 9 9 1 2 3
$EndElements
"
    );
    let m = read_msh(src.into_bytes(), &mut NoProgress).unwrap();
    assert_eq!(m.tris.len(), 1);
    assert_eq!(m.tets.len(), 1);
    assert_eq!(m.tri_tags, vec![9]);
    assert_eq!(m.tet_tags, vec![7]);
    assert_eq!(m.skipped, vec![(1, 1), (15, 1)]);
}

#[test]
fn a_tet_block_before_the_tri_block_still_yields_tris_then_tets() {
    // §6.2 defines `gmsh_elm_numbers` in (tris then tets) order regardless of file order, and the
    // numbering here is not the identity, so the array must actually be materialised.
    let src = format!(
        "{NODES_V2_ASCII}$Elements
2
11 4 2 7 7 1 2 3 4
12 2 2 9 9 1 2 3
$EndElements
"
    );
    let m = read_msh(src.into_bytes(), &mut NoProgress).unwrap();
    let nums = m.gmsh_elm_numbers.as_ref().expect("not the identity");
    assert_eq!(nums, &vec![12, 11], "the tri's number comes first");
    assert_eq!(m.tris.len(), 1);
    assert_eq!(m.tets.len(), 1);
}

#[test]
fn element_data_scatters_by_id_across_the_two_kinds() {
    let src = format!(
        "{NODES_V2_ASCII}$Elements
2
11 4 2 7 7 1 2 3 4
12 2 2 9 9 1 2 3
$EndElements
$ElementData
1
\"only_the_tri\"
1
0.0
3
0
1
1
12 4.5
$EndElementData
"
    );
    let m = read_msh(src.into_bytes(), &mut NoProgress).unwrap();
    let f = &m.elm_fields[0];
    assert_eq!(f.name, "only_the_tri");
    assert_eq!(f.tri, vec![4.5]);
    assert_eq!(f.tet.len(), 1);
    // §6.2: a gap is NaN and sets `partial`.
    assert!(f.tet[0].is_nan());
    assert!(f.partial);
    assert_eq!(f.stats.min, 4.5);
    assert_eq!(f.stats.max, 4.5);
}

#[test]
fn more_than_one_time_step_is_refused() {
    let src = format!(
        "{NODES_V2_ASCII}$Elements
1
1 2 2 9 9 1 2 3
$EndElements
$ElementData
1
\"t\"
1
0.0
3
2
1
1
1 1.0
$EndElementData
"
    );
    match read_msh(src.into_bytes(), &mut NoProgress) {
        Err(Error::Unsupported(m)) => assert!(m.contains("time step"), "got {m:?}"),
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

/// The v2 **binary** skip §6.2 spells out: `count × (1 + n_tags + nodes_per_type) × 4` bytes.
/// SimNIBS's own reader hard-codes 2 tags into a 3, so this block uses **3** tags and an 8-node
/// hexahedron — a reader that copies SimNIBS is off by `count × 4` bytes and loses the tri.
#[test]
fn the_binary_block_skip_uses_the_blocks_own_tag_count() {
    let mut b: Vec<u8> = Vec::new();
    b.extend_from_slice(b"$MeshFormat\n2.2 1 8\n");
    b.extend_from_slice(&1i32.to_le_bytes());
    b.extend_from_slice(b"\n$EndMeshFormat\n$Nodes\n8\n");
    for i in 0..8i32 {
        b.extend_from_slice(&(i + 1).to_le_bytes());
        for k in 0..3 {
            let v = ((i >> k) & 1) as f64;
            b.extend_from_slice(&v.to_le_bytes());
        }
    }
    // SimNIBS's dialect: no newline before `$End*`.
    b.extend_from_slice(b"$EndNodes\n$Elements\n2\n");
    // One hexahedron (type 5, 8 nodes) with THREE tags, then one triangle with two.
    b.extend_from_slice(&5i32.to_le_bytes());
    b.extend_from_slice(&1i32.to_le_bytes());
    b.extend_from_slice(&3i32.to_le_bytes());
    for w in [1i32, 100, 101, 102, 1, 2, 3, 4, 5, 6, 7, 8] {
        b.extend_from_slice(&w.to_le_bytes());
    }
    b.extend_from_slice(&2i32.to_le_bytes());
    b.extend_from_slice(&1i32.to_le_bytes());
    b.extend_from_slice(&2i32.to_le_bytes());
    for w in [2i32, 9, 9, 1, 2, 3] {
        b.extend_from_slice(&w.to_le_bytes());
    }
    b.extend_from_slice(b"$EndElements\n");

    let m = read_msh(b, &mut NoProgress).unwrap();
    assert_eq!(m.nodes.len(), 8);
    assert_eq!(
        m.skipped,
        vec![(5, 1)],
        "the hexahedron is counted, not read"
    );
    assert_eq!(
        m.tris,
        vec![[0, 1, 2]],
        "and the triangle after it is intact"
    );
    assert_eq!(m.tri_tags, vec![9]);
}

#[test]
fn a_freesurfer_quad_file_is_fan_triangulated_with_a_mask() {
    let mut b: Vec<u8> = vec![0xFF, 0xFF, 0xFF]; // QUAD_FILE_MAGIC
    let u24 = |v: u32| [(v >> 16) as u8, (v >> 8) as u8, v as u8];
    b.extend_from_slice(&u24(4)); // vertices
    b.extend_from_slice(&u24(1)); // quads
    for v in [[0i16, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]] {
        for c in v {
            b.extend_from_slice(&c.to_be_bytes());
        }
    }
    for i in 0..4u32 {
        b.extend_from_slice(&u24(i));
    }

    let m = read_fs_surface(b).unwrap();
    assert_eq!(m.nodes.len(), 4);
    // The old quad file stores hundredths of a millimetre.
    assert_eq!(m.nodes[1], [1.0, 0.0, 0.0]);
    assert_eq!(m.tris, vec![[0, 1, 2], [0, 2, 3]]);
    assert_eq!(
        m.tri_edge_mask.as_deref(),
        Some(&[0b101u8, 0b011][..]),
        "the invented diagonal must not be drawn"
    );
}

#[test]
fn a_big_endian_binary_ply_reads_the_same_as_its_ascii_twin() {
    let ascii = b"ply\n\
format ascii 1.0\n\
element vertex 3\n\
property float x\n\
property float y\n\
property float z\n\
element face 1\n\
property list uchar int vertex_indices\n\
end_header\n\
0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n"
        .to_vec();

    let mut be: Vec<u8> = b"ply\n\
format binary_big_endian 1.0\n\
element vertex 3\n\
property float x\n\
property float y\n\
property float z\n\
element face 1\n\
property list uchar int vertex_indices\n\
end_header\n"
        .to_vec();
    for v in [[0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
        for c in v {
            be.extend_from_slice(&c.to_be_bytes());
        }
    }
    be.push(3);
    for i in 0..3i32 {
        be.extend_from_slice(&i.to_be_bytes());
    }

    let a = read_ply(ascii).unwrap();
    let b = read_ply(be).unwrap();
    assert_eq!(a.nodes, b.nodes);
    assert_eq!(a.tris, b.tris);
    assert_eq!(a.tris, vec![[0, 1, 2]]);
    assert!(a.tri_edge_mask.is_none() && b.tri_edge_mask.is_none());
}

#[test]
fn a_ply_with_extra_vertex_properties_still_finds_xyz() {
    // Colours and normals are common and must not shift the coordinate reads.
    let src = b"ply\n\
format ascii 1.0\n\
element vertex 3\n\
property float x\n\
property float y\n\
property float z\n\
property uchar red\n\
property uchar green\n\
property uchar blue\n\
element face 1\n\
property list uchar int vertex_indices\n\
end_header\n\
0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n3 0 1 2\n"
        .to_vec();
    let m = read_ply(src).unwrap();
    assert_eq!(
        m.nodes,
        vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    );
}

#[test]
fn sniff_names_what_it_could_not_recognise() {
    match sniff(b"not a mesh at all\n", None) {
        Err(Error::Unsupported(m)) => assert!(m.contains("unrecognised"), "got {m:?}"),
        other => panic!("expected Unsupported, got {other:?}"),
    }
    // …but an extension hint rescues a format with no magic of its own.
    assert_eq!(
        sniff(b"nothing recognisable", Some("obj")).unwrap(),
        tvx_mesh_io::Format::Obj
    );
}
