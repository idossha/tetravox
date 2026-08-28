// A Gmsh GEOMETRY script, not a post-processing view. `read_geo_view` must reject this with
// `Error::Unsupported` naming `Point(` — reading it as an empty view would look like corruption.
lc = 1e-2;
Point(1) = {0, 0, 0, lc};
Point(2) = {1, 0, 0, lc};
Line(1) = {1, 2};
Physical Surface(1) = {1};
