#!/usr/bin/env python3
"""Reference values for Tetravox's real-data MGZ test (`crates/tvx-nifti/tests/realdata.rs`).

Run with any python3 that has nibabel + numpy:
  python3 scripts/refvalues/mgz_refvalues.py [MGZ_PATH] > scripts/refvalues/mgz_refvalues.json

MGZ_PATH defaults to $TETRAVOX_MGZ, else nibabel's own `tests/data/test.mgz` inside the SimNIBS
environment (the only .mgz on the reference machine). The test skips when TETRAVOX_MGZ is unset,
and skips with a message when the file it points at is not the one this JSON describes.

Every number comes from nibabel: `MGHImage.affine`, `header['delta']`, `header.get_vox2ras_tkr()`
and the array itself. Nothing was read back out of the Rust reader.
"""
import json
import os
import sys

import numpy as np
import nibabel as nib

DEFAULT = (
    "/Users/idohaber/Applications/SimNIBS-4.6/simnibs_env/lib/python3.11/site-packages/"
    "nibabel/tests/data/test.mgz"
)
path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TETRAVOX_MGZ", DEFAULT)

img = nib.load(path)
hdr = img.header
data = np.asanyarray(img.dataobj).astype(np.float64)
if data.ndim == 3:
    data = data[..., None]
dims = [int(d) for d in img.shape[:3]]
nvols = int(img.shape[3]) if len(img.shape) > 3 else 1

spots = []
for ijk in [(0, 0, 0), (dims[0] - 1, 0, 0), (0, dims[1] - 1, 0), (0, 0, dims[2] - 1),
            (dims[0] // 2, dims[1] // 2, dims[2] // 2), (dims[0] - 1, dims[1] - 1, dims[2] - 1)]:
    for t in range(min(nvols, 2)):
        spots.append({
            "voxel": list(ijk), "volume": t,
            "raw": float(data[ijk + (t,)]),
            "world": (img.affine @ np.array(list(ijk) + [1.0])).tolist(),
        })

out = {
    "file": os.path.basename(path),
    "bytes": os.path.getsize(path),
    "nibabel": nib.__version__,
    "dims": dims,
    "nvols": nvols,
    "dtype": str(img.get_data_dtype()),
    "typeCode": int(hdr["type"]),
    "goodRASFlag": int(hdr["goodRASFlag"]),
    "delta": [float(x) for x in hdr["delta"]],
    "affine": img.affine.tolist(),
    "vox2rasTkr": hdr.get_vox2ras_tkr().tolist(),
    "volumeStats": [
        {"min": float(data[..., t].min()), "max": float(data[..., t].max()),
         "mean": float(data[..., t].mean())}
        for t in range(nvols)
    ],
    "spotValues": spots,
}
json.dump(out, sys.stdout, indent=1)
sys.stdout.write("\n")
