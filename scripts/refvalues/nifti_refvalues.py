#!/usr/bin/env python3
"""Reference values for Tetravox real-data NIfTI tests.

Run with any python3 that has nibabel + numpy:
  python3 scripts/refvalues/nifti_refvalues.py [TESTDATA_ROOT]

TESTDATA_ROOT defaults to $TETRAVOX_TESTDATA, else
/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie.

Emits JSON on stdout. The numbers in AGENTS.md "Test data" are this output.

IMPORTANT: scl_slope/scl_inter are read from the RAW on-disk header bytes, not
from `nib.load(p).header`. `Nifti1Image.from_file_map` calls
`header.set_slope_inter(None, None)` after handing the scaling to the array
proxy, so the in-memory header reports NaN for every file regardless of what is
on disk. Reading the in-memory header is how one gets the false claim that these
volumes have a NaN slope.
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

FILES = [
    ("m2m_ernie", "T1.nii.gz"),
    ("m2m_ernie", "final_tissues.nii.gz"),
    ("m2m_ernie", "label_prep", "T1_upsampled.nii.gz"),
    ("m2m_ernie", "label_prep", "tissue_labeling_upsampled.nii.gz"),
    ("m2m_ernie", "segmentation", "labeling.nii.gz"),
    ("Simulations", "Thalamus", "TI", "niftis", "Thalamus_TI_subject_TI_max.nii.gz"),
]

# NIfTI-1 single-file header field offsets (little-endian).
OFF_DATATYPE, OFF_PIXDIM, OFF_SCL_SLOPE, OFF_SCL_INTER = 70, 76, 112, 116


def raw_header(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rb") as fh:
        return fh.read(348)


def r(x, n=6):
    return round(float(x), n)


def qform_from_header(h):
    """Rebuild the qform exactly as the NIfTI-1 spec defines it, qfac included."""
    b, c, d = float(h["quatern_b"]), float(h["quatern_c"]), float(h["quatern_d"])
    a = np.sqrt(max(0.0, 1.0 - (b * b + c * c + d * d)))
    R = np.array([
        [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
        [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
        [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - b * b - c * c],
    ])
    qfac = -1.0 if float(h["pixdim"][0]) < 0 else 1.0
    sx, sy, sz = (float(v) for v in h["pixdim"][1:4])
    M = np.eye(4)
    M[:3, 0] = R[:, 0] * sx
    M[:3, 1] = R[:, 1] * sy
    M[:3, 2] = R[:, 2] * sz * qfac
    M[:3, 3] = [float(h["qoffset_x"]), float(h["qoffset_y"]), float(h["qoffset_z"])]
    return M


def summary(path):
    img = nib.load(path)
    h = img.header
    rb = raw_header(path)
    dims = [int(v) for v in h.get_data_shape()]
    aff = img.affine
    corner = [d - 1 for d in dims[:3]]
    p0 = aff @ np.array([0.0, 0.0, 0.0, 1.0])
    p1 = aff @ np.array([float(corner[0]), float(corner[1]), float(corner[2]), 1.0])
    d = np.asanyarray(img.dataobj)  # physical units (slope/inter applied)
    disk_dtype = h.get_data_dtype()

    q = qform_from_header(h)
    q_no_qfac = q.copy()
    q_no_qfac[:3, 2] *= -1.0

    out = {
        "path": os.path.relpath(path, ROOT),
        "bytes": os.path.getsize(path),
        "dims": dims,
        "dtype_code": struct.unpack_from("<h", rb, OFF_DATATYPE)[0],
        "dtype": str(disk_dtype),
        "pixdim": [r(v) for v in struct.unpack_from("<8f", rb, OFF_PIXDIM)],
        "qfac": -1 if struct.unpack_from("<f", rb, OFF_PIXDIM)[0] < 0 else 1,
        "sform_code": int(h["sform_code"]),
        "qform_code": int(h["qform_code"]),
        "scl_slope_on_disk": r(struct.unpack_from("<f", rb, OFF_SCL_SLOPE)[0]),
        "scl_inter_on_disk": r(struct.unpack_from("<f", rb, OFF_SCL_INTER)[0]),
        "intent_code": int(h["intent_code"]),
        "affine": [[r(v) for v in row] for row in aff.tolist()],
        "world_of_voxel_000": [r(v) for v in p0[:3].tolist()],
        "far_voxel": corner,
        "world_of_far_voxel": [r(v) for v in p1[:3].tolist()],
        "qform_equals_sform": bool(np.abs(q - aff).max() < 1e-4),
        "qform_max_abs_err": r(float(np.abs(q - aff).max())),
        "qform_without_qfac_max_abs_err": r(float(np.abs(q_no_qfac - aff).max())),
        "min": r(np.nanmin(d)),
        "max": r(np.nanmax(d)),
    }
    if np.issubdtype(disk_dtype, np.integer):
        u = np.unique(np.asarray(img.dataobj.get_unscaled(), dtype=np.int64))
        out["n_unique_raw"] = int(u.size)
        if u.size <= 64:
            out["unique_raw"] = [int(v) for v in u.tolist()]
    return out


def main():
    res = {"root": ROOT, "volumes": []}
    for parts in FILES:
        p = os.path.join(ROOT, *parts)
        if os.path.exists(p):
            res["volumes"].append(summary(p))
    json.dump(res, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
