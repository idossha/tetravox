/* Synthetic parsed Gmsh post-processing view — the `.geo` / `.pos` fixture for
   `tvx_mesh_io::read_geo_view` (docs/ARCHITECTURE.md §6.2, directed task 6).

   Hand-written, not generated: the point of the file is to carry one of every primitive the
   reader claims to support, in the exact SimNIBS dialect (empty unspaced view name on the first
   view) plus the spellings a generic writer uses (spaces, comments, scientific notation, a
   second named view). Its expected values live in testdata/manifest.json. */
View""{
SP(1, 2, 3){10};
SP(-1.5e-2, +2.0, 3.){20};
T3(1, 2, 8, 0){"E001"};
T3(-1.5e-2, 2.0, 8, 0){"E002"};
SL(0, 1e2, 0, 0, 0, 0){1, 2};
ST(0, 1, 0, 0, 0, 1, 0, 0, 0){10, 20, 30};
SQ(0, 1, 1, 0, 0, 0, 1, 1, 5, 5, 5, 5){1, 2, 3, 4};
VP(0, 0, 0){3, 4, 0};
SS(0,0,0,0, 0,0,0,0, 0,0,0,0){1,2,3,4};
};
View "second" {
  // a second view in the same file
  SP(9, 9, 9){0.5};
};
