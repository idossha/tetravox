#!/usr/bin/env simnibs_python
"""Reference glyph placement, direction and magnitude — the numpy half of §11 rule 0 for `GlyphSpec`.

For one mesh, one plane and one stride, this lists the elements a glyph draw is supposed to sample
and, for each, the three numbers the renderer has to get right:

  * the **centroid** — where the arrow starts (`tet_centroids`: the arithmetic mean of the four node
    positions, §6.3);
  * the **field vector** at that element — which way it points;
  * **|E|** — how long it is, once the scaling model is applied.

Run with the host SimNIBS interpreter (`simnibs.mesh_tools.mesh_io` reads the `.msh`; everything
after that is numpy):

  /Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python scripts/reference/glyphs.py \
      --out packages/engine/test/fixtures/glyph-ref-ernie.json

Defaults reproduce the fixture the `glyphs on real data` e2e loads: `ernie_TDCS_1_scalar.msh`, the
`E` field, tet tag 2 (grey matter), an axial slab at z = 40 mm of half-thickness 0.05 mm, stride 1.

**Why a slab and not a stride over the whole mesh.** The engine's volumetric origins come from
`meshCentroids`, which emits surviving tets in **Morton order** — a spatial order this script has no
business reproducing. A slab is order-free: "every grey-matter tet whose centroid is within 0.05 mm
of z = 40" is one set, whichever order either side walks it in, so the test can assert **set
equality** on the element numbers and then compare each element's three numbers. That is a stronger
claim than sampling and comparing whatever both happened to pick.

The output is a JSON object:

  { "mesh": …, "field": "E", "plane": {"axis": 2, "offset": 40.0, "half": 0.05}, "tags": [2],
    "stride": 1, "count": N,
    "elements": [n, …],                      # ascending Gmsh element numbers
    "centroids": [[x,y,z], …],               # mm, same order
    "vectors":   [[ex,ey,ez], …],
    "magnitudes":[|E|, …],
    "stats": {"min": …, "max": …, "p99": …}  # of |E| over the WHOLE field, which is what the
  }                                          # scaling model normalises to
"""
import argparse
import json
import os
import sys

import numpy as np
from simnibs.mesh_tools import mesh_io

TRI, TET = 2, 4
DEFAULT_MESH = "Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=os.environ.get(
        "TETRAVOX_TESTDATA", "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie"))
    ap.add_argument("--mesh", default=DEFAULT_MESH)
    ap.add_argument("--field", default="E")
    ap.add_argument("--axis", type=int, default=2, help="0 = x, 1 = y, 2 = z")
    ap.add_argument("--offset", type=float, default=40.0, help="plane position, world mm")
    ap.add_argument("--half", type=float, default=0.05, help="slab half-thickness, mm")
    ap.add_argument("--tags", type=int, nargs="*", default=[2], help="tet tags to keep")
    ap.add_argument("--stride", type=int, default=1, help="keep every Nth survivor")
    ap.add_argument("--out", default=None, help="write here instead of stdout")
    a = ap.parse_args()

    path = a.mesh if os.path.isabs(a.mesh) else os.path.join(a.root, a.mesh)
    m = mesh_io.read_msh(path)

    field = None
    for f in m.elmdata:
        if f.field_name == a.field:
            field = f
            break
    if field is None:
        print(f"no element field {a.field!r} in {path}", file=sys.stderr)
        return 2
    values = np.asarray(field.value, dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != 3:
        print(f"{a.field!r} is not a 3-component element field", file=sys.stderr)
        return 2

    # |E| over the whole field: the scaling model normalises to this field's own statistics, and
    # SimNIBS' `FieldStats` for a vector field is of the magnitude (§6.0), so this is the same
    # quantity the engine's `MeshFieldInfo.stats` carries.
    mag_all = np.linalg.norm(values, axis=1)

    is_tet = m.elm.elm_type == TET
    keep = is_tet & np.isin(m.elm.tag1, np.asarray(a.tags))
    # `node_number_list` is 1-based and pads triangles with a 4th entry of -1; the tet rows are full.
    nodes = m.nodes.node_coord[m.elm.node_number_list[keep] - 1]  # (n, 4, 3)
    centroids = nodes.mean(axis=1)

    within = np.abs(centroids[:, a.axis] - a.offset) <= a.half
    idx = np.flatnonzero(keep)[within]
    order = np.argsort(m.elm.elm_number[idx])
    idx = idx[order]
    if a.stride > 1:
        idx = idx[:: a.stride]

    c = centroids[within][order]
    if a.stride > 1:
        c = c[:: a.stride]
    out = {
        "mesh": os.path.relpath(path, a.root),
        "field": a.field,
        "plane": {"axis": a.axis, "offset": a.offset, "half": a.half},
        "tags": list(a.tags),
        "stride": a.stride,
        "count": int(idx.size),
        "elements": [int(v) for v in m.elm.elm_number[idx]],
        "centroids": [[float(v) for v in row] for row in c],
        "vectors": [[float(v) for v in row] for row in values[idx]],
        "magnitudes": [float(v) for v in mag_all[idx]],
        "stats": {
            "min": float(mag_all.min()),
            "max": float(mag_all.max()),
            "p99": float(np.percentile(mag_all, 99.0)),
        },
    }
    text = json.dumps(out)
    if a.out is None:
        print(text)
    else:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        with open(a.out, "w") as fh:
            fh.write(text)
        print(f"{a.out}: {out['count']} elements", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
