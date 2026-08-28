#!/usr/bin/env python3
"""Reference contour geometry for `surface_contours` (directed task 12).

nibabel reads `lh.pial.gii`; numpy intersects every triangle with three axis-aligned planes through
the surface's own bounding-box centre — **the ernie cursor**, which is where a freshly opened scene
puts it (`scene/defaults.ts` fits to the dataset bounds). The intersection is written out verbatim,
6 floats per segment, so a Rust test can assert §6.3's `surface_contours` against a reference that
shares no code with it: this file is nibabel + numpy, that one is `crates/tvx-geom/src/cut.rs`.

    python3 scripts/refvalues/contour_refvalues.py > scripts/refvalues/contour_refvalues.json

Takes an optional testdata root as `argv[1]`, defaulting to `$TETRAVOX_TESTDATA` and then to the
path AGENTS.md names.

**The plane convention is the engine's**, not "z = c": a `Plane` is `normal` plus `offset` with the
point test `dot(normal, p) + offset`, so the axial plane through `z = c` is `offset = -c`. Getting
that sign wrong is the one way to produce a plausible-looking reference for the wrong plane.
"""

import json
import os
import sys

import nibabel as nib
import numpy as np

DEFAULT_ROOT = "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie"
SURFACE = "m2m_ernie/surfaces/lh.pial.gii"


def read_surface(path):
    """Vertices in **scanner** mm and triangles, the way the engine sees them.

    Both `lh.*.gii` in the reference dataset carry `DataSpace = NIFTI_XFORM_UNKNOWN` /
    `TransformedSpace = NIFTI_XFORM_SCANNER_ANAT` with an identity xform (AGENTS.md), so the
    pointset is already world mm; the transform is applied anyway rather than assumed away.
    """
    img = nib.load(path)
    pts = img.get_arrays_from_intent("NIFTI_INTENT_POINTSET")[0]
    tris = img.get_arrays_from_intent("NIFTI_INTENT_TRIANGLE")[0]
    verts = np.asarray(pts.data, dtype=np.float64)
    cs = pts.coordsys
    if cs is not None and cs.xform is not None:
        m = np.asarray(cs.xform, dtype=np.float64)
        if not np.allclose(m, np.eye(4)):
            verts = verts @ m[:3, :3].T + m[:3, 3]
    return verts, np.asarray(tris.data, dtype=np.int64)


def contour(verts, tris, normal, offset):
    """Every triangle's intersection with `dot(normal, p) + offset = 0`, 6 floats per segment.

    Vectorised over triangles, and deliberately the same rule as `surface_contours`: a vertex
    exactly on the plane counts as **non-negative**, so a triangle with one vertex on the plane and
    two below yields no segment rather than a degenerate one, and a shared edge is not emitted twice.
    """
    p = verts[tris]                                    # (T, 3, 3)
    d = p @ np.asarray(normal, dtype=np.float64) + offset
    side = d >= 0.0
    crossing = ~(side.all(axis=1) | (~side).all(axis=1))
    p, d = p[crossing], d[crossing]
    out = []
    for k in range(3):
        a, b = k, (k + 1) % 3
        hit = side[crossing][:, a] != side[crossing][:, b]
        t = (d[hit, a] / (d[hit, a] - d[hit, b]))[:, None]
        out.append((hit, p[hit, a] + (p[hit, b] - p[hit, a]) * t))
    # Two of the three edges cross, per triangle; collect them in edge order.
    n = p.shape[0]
    first = np.full((n, 3), np.nan)
    second = np.full((n, 3), np.nan)
    filled = np.zeros(n, dtype=np.int64)
    for hit, pts in out:
        idx = np.flatnonzero(hit)
        take_first = filled[idx] == 0
        first[idx[take_first]] = pts[take_first]
        second[idx[~take_first]] = pts[~take_first]
        filled[idx] += 1
    keep = filled == 2
    return np.concatenate([first[keep], second[keep]], axis=1)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TETRAVOX_TESTDATA", DEFAULT_ROOT)
    verts, tris = read_surface(os.path.join(root, SURFACE))
    centre = (verts.min(axis=0) + verts.max(axis=0)) * 0.5

    planes = {
        "axial": ([0.0, 0.0, 1.0], -centre[2]),
        "coronal": ([0.0, 1.0, 0.0], -centre[1]),
        "sagittal": ([1.0, 0.0, 0.0], -centre[0]),
    }
    result = {
        "file": SURFACE,
        "nodes": int(verts.shape[0]),
        "tris": int(tris.shape[0]),
        "cursor": [float(c) for c in centre],
        "planes": {},
    }
    for name, (normal, offset) in planes.items():
        seg = contour(verts, tris, normal, offset)
        length = float(np.linalg.norm(seg[:, 3:] - seg[:, :3], axis=1).sum())
        entry = {
            "normal": normal,
            "offset": float(offset),
            "segments": int(seg.shape[0]),
            "totalLengthMm": length,
        }
        # **Only the axial plane's geometry is committed.** The endpoint test needs the reference
        # segments, and three planes of them is a megabyte of JSON in the tree; the other two carry
        # the segment count and the total length, which is the whole of the length assertion and
        # enough to catch a plane-convention or a winding regression. 3 decimals is 1 µm — two
        # orders below the 0.1 mm the endpoint test asserts.
        if name == "axial":
            entry["seg"] = [[round(float(v), 3) for v in row] for row in seg]
        result["planes"][name] = entry
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
