#!/usr/bin/env python3
"""Reference values for §4.3's bounded local reads on the real dataset.

Run with any python3 that has nibabel + numpy:
  python3 scripts/refvalues/voxelbox_refvalues.py [TESTDATA_ROOT] > scripts/refvalues/voxelbox_refvalues.json

TESTDATA_ROOT defaults to $TETRAVOX_TESTDATA, else
/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie.

This is the real-data half of AGENTS.md rule 2 for `packages/engine/src/derived/voxel-box.ts`
(`sampleVoxelBox` / `peakCentroid`). The synthetic half is `testdata/ct_shafts.nii.gz`, whose
expectations `scripts/gen-fixtures.py` writes into `testdata/manifest.json`; this file is the same
two functions re-implemented in numpy over `m2m_ernie/T1.nii.gz`, which is the file that matters:
float32 with a max of exactly 65535, a real (non-diagonal) sform, and 1 mm spacing, so the box's
half-extent is `ceil(radius)` on all three axes and any axis mix-up is invisible in the *shape* and
loud in the *values*.

IMPORTANT, and the same warning `nifti_refvalues.py` carries: scl_slope/scl_inter come from the RAW
348-byte header, never from `nib.load(p).header`, which reports NaN for every file because
`Nifti1Image.from_file_map` hands scaling to the array proxy.

The queries are world millimetres in the volume's own frame. They are deliberately NOT on
half-voxel boundaries: rounding a voxel index is the one place a float32 inverse affine and a
float64 one can legitimately disagree, and a reference whose numbers turn on a tie-break would be
pinning the tie-break rather than the rule.
"""
import gzip
import json
import os
import struct
import sys

import numpy as np
import nibabel as nib

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "TETRAVOX_TESTDATA", "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie"
)

FILE = os.path.join(ROOT, "m2m_ernie", "T1.nii.gz")

OFF_SCL_SLOPE = 112

# ARCHITECTURE.md §4.3: at most this many voxels on an axis, whatever the spacing.
VOXEL_BOX_MAX = 32

# World mm. The first is the volume's own centre; the rest are ordinary intracranial and scalp
# points, chosen off half-voxel boundaries (see the docstring) and spread over all eight octants so
# a sign error in one row of the affine cannot pass.
QUERIES = [
    ("centre", None, 3.0),
    ("intracranial-lps", (-18.3, -22.7, 31.4), 3.0),
    ("intracranial-ras", (21.7, 18.3, 12.9), 3.0),
    ("inferior", (2.3, -9.7, -38.1), 5.0),
    ("scalp", (-58.3, 6.7, 41.9), 2.0),
    ("capped-radius", (0.3, 0.7, 0.9), 60.0),
    ("outside", (1000.0, 0.0, 0.0), 3.0),
]

# Corners and centre of the box, as fractions of its size — five values a transposed or flipped
# window cannot reproduce, unlike a sum.
SPOT_FRACTIONS = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (0.5, 0.5, 0.5)]


def f(x, n=9):
    return round(float(x), n)


def fl(a, n=9):
    return [f(v, n) for v in np.asarray(a).ravel()]


def raw_header(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rb") as fh:
        return fh.read(348)


def box_indices(inv_affine, dims, spacing, world, radius_mm):
    """`sampleVoxelBox`'s window, from the spec: ceil(radius/spacing) per axis, clipped, capped."""
    v = inv_affine @ np.array([world[0], world[1], world[2], 1.0], dtype=np.float64)
    # HALF-UP, matching JavaScript's `Math.round`; `np.rint` is half-to-even.
    c = np.floor(v[:3] + 0.5).astype(np.int64)
    dims = np.asarray(dims, dtype=np.int64)
    if np.any(c < 0) or np.any(c >= dims):
        return None
    half = np.minimum(
        (VOXEL_BOX_MAX - 1) // 2,
        np.ceil(radius_mm / np.abs(np.asarray(spacing, dtype=np.float64))).astype(np.int64),
    )
    lo = np.maximum(0, c - half)
    hi = np.minimum(dims - 1, c + half)
    return lo, hi


def peak_centroid(affine, lo, box):
    """Slicer's rule: weights `clip(v - (max - 0.5*(max-min)), 0)`, centroid in VOXEL indices."""
    mn = float(box.min())
    mx = float(box.max())
    w = np.clip(box - (mx - 0.5 * (mx - mn)), 0.0, None)
    total = float(w.sum())
    if not total > 0.0:
        return None
    idx = np.indices(box.shape).astype(np.float64)
    for a in range(3):
        idx[a] += float(lo[a])
    c = np.array([float((idx[a] * w).sum() / total) for a in range(3)])
    return affine @ np.array([c[0], c[1], c[2], 1.0])


def main():
    if not os.path.exists(FILE):
        print(json.dumps({"error": "not found", "path": FILE}, indent=1))
        return 1

    img = nib.load(FILE)
    raw = np.asarray(img.dataobj.get_unscaled(), dtype=np.float64)
    hdr = raw_header(FILE)
    slope, inter = struct.unpack("<2f", hdr[OFF_SCL_SLOPE : OFF_SCL_SLOPE + 8])
    slope = slope if np.isfinite(slope) and slope != 0 else 1.0
    inter = inter if np.isfinite(inter) else 0.0
    phys = raw * slope + inter

    affine = np.vstack(
        [
            np.array(img.header["srow_x"]),
            np.array(img.header["srow_y"]),
            np.array(img.header["srow_z"]),
            [0, 0, 0, 1],
        ]
    ).astype(np.float64)
    inv = np.linalg.inv(affine)
    dims = list(phys.shape[:3])
    spacing = [float(np.linalg.norm(affine[:3, a])) for a in range(3)]
    centre_world = affine @ np.array(
        [(dims[0] - 1) / 2.0, (dims[1] - 1) / 2.0, (dims[2] - 1) / 2.0, 1.0]
    )

    cases = []
    for name, world, radius in QUERIES:
        w = centre_world[:3] if world is None else np.asarray(world, dtype=np.float64)
        rec = {"name": name, "world": fl(w), "radiusMm": f(radius)}
        win = box_indices(inv, dims, spacing, w, radius)
        if win is None:
            rec["box"] = None
            rec["peakCentroidWorld"] = None
            cases.append(rec)
            continue
        lo, hi = win
        box = phys[lo[0] : hi[0] + 1, lo[1] : hi[1] + 1, lo[2] : hi[2] + 1]
        spots = []
        for fx, fy, fz in SPOT_FRACTIONS:
            o = [
                int(round(fx * (box.shape[0] - 1))),
                int(round(fy * (box.shape[1] - 1))),
                int(round(fz * (box.shape[2] - 1))),
            ]
            spots.append({"offset": o, "value": f(box[o[0], o[1], o[2]])})
        rec["box"] = {
            "ijk0": [int(v) for v in lo],
            "dims": [int(v) for v in box.shape],
            "voxelCount": int(box.size),
            "valueMin": f(box.min()),
            "valueMax": f(box.max()),
            "valueSum": f(box.sum(), 4),
            "spotValues": spots,
        }
        c = peak_centroid(affine, lo, box)
        rec["peakCentroidWorld"] = None if c is None else fl(c[:3])
        cases.append(rec)

    out = {
        "file": "m2m_ernie/T1.nii.gz",
        "bytes": os.path.getsize(FILE),
        "producedBy": "nibabel + numpy (scripts/refvalues/voxelbox_refvalues.py)",
        "conventions": {
            "box": "half-extent ceil(radiusMm / spacing) voxels PER AXIS, clipped to the volume, "
                   "capped at %d voxels on an axis (ARCHITECTURE.md §4.3)" % VOXEL_BOX_MAX,
            "values": "physical = raw * sclSlope + sclInter, applied once, slope from the RAW header",
            "spotValues": "offset is [i, j, k] within the box; i fastest, like VolumeDataset.data",
            "peakCentroid": "weights clip(v - (max - 0.5*(max - min)), 0); centroid in voxel "
                            "indices, then through the affine",
            "rounding": "the query's voxel index is rounded HALF-UP, like JavaScript's Math.round",
        },
        "dims": dims,
        "spacing": fl(spacing),
        "sclSlopeOnDisk": f(slope),
        "sclInterOnDisk": f(inter),
        "affine": [fl(affine[r]) for r in range(4)],
        "cases": cases,
    }
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
