//! Scratch measurement driver (not a test): prints §6.3 numbers on whatever mesh it is given.
use std::time::Instant;
use tvx_core::NoProgress;

fn main() {
    let path = std::env::args().nth(1).expect("usage: measure <mesh>");
    let bytes = std::fs::read(&path).expect("read");
    let n = bytes.len();
    let t0 = Instant::now();
    let mut mesh = tvx_mesh_io::read_msh(bytes, &mut NoProgress).expect("parse");
    println!("{path}: {n} B parsed in {:?}", t0.elapsed());
    println!(
        "  nodes {} tris {} tets {}",
        mesh.nodes.len(),
        mesh.tris.len(),
        mesh.tets.len()
    );
    let t = Instant::now();
    let rep = tvx_geom::orient_surface(&mesh.nodes, &mut mesh.tris);
    println!("  orient_surface {:?} -> {rep:?}", t.elapsed());
    let t = Instant::now();
    mesh.tet_perm = tvx_geom::morton_reorder(&mut mesh);
    println!("  morton_reorder {:?}", t.elapsed());
    let t = Instant::now();
    let blocks = tvx_geom::build_tet_blocks(&mesh, 64);
    println!(
        "  build_tet_blocks {:?} ({} blocks)",
        t.elapsed(),
        blocks.aabb.len() / 6
    );
    let t = Instant::now();
    let loc = tvx_geom::build_point_locator(&mesh);
    println!("  build_point_locator {:?}", t.elapsed());
    let t = Instant::now();
    let s =
        tvx_geom::tag_surfaces(&mesh, tvx_geom::SurfaceVariant::Indexed, &mut NoProgress).unwrap();
    println!(
        "  tag_surfaces {:?} -> {} tris, {} verts, {} tags",
        t.elapsed(),
        s.owner_elm.len(),
        s.positions.len() / 3,
        s.per_tag.len()
    );
    let c = mesh.bounds;
    let mid = [
        (c.min[0] + c.max[0]) * 0.5,
        (c.min[1] + c.max[1]) * 0.5,
        (c.min[2] + c.max[2]) * 0.5,
    ];
    let t = Instant::now();
    let hit = tvx_geom::locate_point(&mesh, &loc, mid);
    println!(
        "  locate_point(center) {:?} -> {:?}",
        t.elapsed(),
        hit.map(|h| (h.gmsh_elm, h.tag))
    );
}
