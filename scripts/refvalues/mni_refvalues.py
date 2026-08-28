#!/usr/bin/env python
"""Reference values for the MNI coordinate spaces (directed task 8, `spaces.realdata.test.ts`).

Run with SimNIBS's own interpreter — this imports the reference implementation on purpose:

    /Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python scripts/refvalues/mni_refvalues.py

Prints JSON. Takes an optional testdata root, default ``$TETRAVOX_TESTDATA``.

Three things it establishes, all of which the test file quotes:

1. ``subject2mni_coords`` / ``mni2subject_coords`` with ``transformation_type='nonl'`` on five
   landmarks — the numbers ``spaces.realdata.test.ts`` asserts to 1e-3 mm.
2. The two deformation fields' shapes and affines. ``Conform2MNI_nonl.nii.gz`` is on the T1's own
   grid; ``MNI2Conform_nonl.nii.gz`` is on the MNI grid. Both are 4-D with three volumes whose voxel
   values *are* the target-space coordinates (``coordinates_nonlinear``).
3. Whether the affine transforms exist at all. SimNIBS 4's ``charm`` does not write
   ``MNI2conform_6DOF.txt`` / ``MNI2conform_12DOF.txt``; on ernie the 12-DOF call raises
   ``FileNotFoundError``, which is recorded here rather than silently skipped.

The tkr-RAS reference is nibabel's and needs no SimNIBS, so it is printed too and can be reproduced
with plain ``python3``.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import nibabel as nib

LANDMARKS = np.array(
    [
        [0.0, 0.0, 0.0],
        [-40.0, -20.0, 50.0],
        [30.0, 40.0, 10.0],
        [-10.0, -90.0, 0.0],
        [5.0, 20.0, -30.0],
    ]
)


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TETRAVOX_TESTDATA")
    if not root:
        print("set TETRAVOX_TESTDATA or pass the testdata root", file=sys.stderr)
        return 2
    m2m = os.path.join(root, "m2m_ernie")
    out: dict[str, object] = {"m2m": m2m, "landmarks": LANDMARKS.tolist()}

    # -- tkr-RAS (nibabel only) ---------------------------------------------------------------
    from nibabel.freesurfer.mghformat import MGHHeader

    t1 = nib.load(os.path.join(m2m, "T1.nii.gz"))
    mgh = MGHHeader.from_header(t1.header)
    mgh.set_data_shape(t1.shape[:3])
    mgh.set_zooms(t1.header.get_zooms()[:3])
    vox2ras_tkr = np.asarray(mgh.get_vox2ras_tkr(), dtype=float)
    world2tkr = vox2ras_tkr @ np.linalg.inv(t1.affine)
    homog = np.hstack([LANDMARKS, np.ones((len(LANDMARKS), 1))])
    out["T1_affine"] = np.asarray(t1.affine).tolist()
    out["vox2ras_tkr"] = vox2ras_tkr.tolist()
    out["world2tkr"] = world2tkr.tolist()
    out["tkr_of_landmarks"] = (homog @ world2tkr.T)[:, :3].tolist()

    # -- the deformation fields ----------------------------------------------------------------
    for name in ("Conform2MNI_nonl.nii.gz", "MNI2Conform_nonl.nii.gz"):
        path = os.path.join(m2m, "toMNI", name)
        if not os.path.isfile(path):
            out[name] = None
            continue
        img = nib.load(path)
        out[name] = {
            "shape": list(img.shape),
            "dtype": str(img.get_data_dtype()),
            "affine": np.asarray(img.affine).tolist(),
        }

    # -- SimNIBS's own mapping ------------------------------------------------------------------
    from simnibs.utils.transformations import mni2subject_coords, subject2mni_coords

    mni = np.asarray(subject2mni_coords(LANDMARKS, m2m, transformation_type="nonl"))
    out["subject2mni_nonl"] = mni.tolist()
    out["mni2subject_nonl"] = np.asarray(
        mni2subject_coords(mni, m2m, transformation_type="nonl")
    ).tolist()

    for dof in ("6dof", "12dof"):
        try:
            out[f"subject2mni_{dof}"] = np.asarray(
                subject2mni_coords(LANDMARKS, m2m, transformation_type=dof)
            ).tolist()
        except Exception as exc:  # noqa: BLE001 — the absence is the finding
            out[f"subject2mni_{dof}"] = {"error": type(exc).__name__, "message": str(exc)}

    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
