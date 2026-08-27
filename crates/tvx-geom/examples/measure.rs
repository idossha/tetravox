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

    // The three rows `docs/benchmarks/phase1.md` attributes to this command but that it did not
    // produce until now. Without them the doc's own promise — "every number here can be traced to
    // the command that produced it" — was false for a third of the table.
    let t = Instant::now();
    let b = tvx_geom::extract_boundary(
        &mesh,
        None,
        None,
        tvx_geom::SurfaceVariant::Indexed,
        &mut NoProgress,
    )
    .unwrap();
    println!(
        "  extract_boundary(topo = None) {:?} -> {} tris",
        t.elapsed(),
        b.owner_elm.len()
    );

    let degenerate = tvx_geom::build_tet_blocks(&mesh, mesh.tets.len().max(1));
    let axial = tvx_core::Plane {
        normal: [0.0, 0.0, 1.0],
        offset: -mid[2],
    };
    let k = 1.0f32 / 3.0f32.sqrt();
    let oblique = tvx_core::Plane {
        normal: [k, k, k],
        offset: -(mid[0] * k + mid[1] * k + mid[2] * k),
    };
    for (name, plane) in [("axial", &axial), ("oblique", &oblique)] {
        // Best of 5: one run measures the allocator's mood as much as the kernel.
        let mut best = std::time::Duration::MAX;
        let mut tris = 0;
        for _ in 0..5 {
            let t = Instant::now();
            let c = tvx_geom::plane_cut(&mesh, &blocks, std::slice::from_ref(plane), None).unwrap();
            best = best.min(t.elapsed());
            tris = c[0].owner_tet.len();
        }
        let mut worst = std::time::Duration::MAX;
        for _ in 0..3 {
            let t = Instant::now();
            tvx_geom::plane_cut(&mesh, &degenerate, std::slice::from_ref(plane), None).unwrap();
            worst = worst.min(t.elapsed());
        }
        println!(
            "  plane_cut {name} through the bbox centre: {best:?} indexed / {worst:?} degenerate -> {tris} cap tris"
        );
    }
}
