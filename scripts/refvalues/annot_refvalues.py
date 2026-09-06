#!/usr/bin/env python3
"""Reference values for Tetravox's real-data surface-annotation tests.

Run with any python3 that has nibabel:
  python3 scripts/refvalues/annot_refvalues.py [TESTDATA_ROOT] > scripts/refvalues/annot_refvalues.json

Reports, for every `m2m_ernie/segmentation/{lh,rh}.ernie_*.annot`, the vertex count, the colortable
size and names in file order, the raw label range, and how many vertices are unassigned (nibabel's
-1) — plus the vertex count of every hemisphere surface in `m2m_ernie/surfaces/`, which is the
correspondence a `.annot` names and `attachField` checks. Every number comes from
`nib.freesurfer.read_annot` and `nib.load`; nothing is read back out of Tetravox.
"""
import glob
import json
import os
import sys

import nibabel as nib

root = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "TETRAVOX_TESTDATA", "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie"
)
out = {"annots": {}, "surfaces": {}}
for path in sorted(glob.glob(os.path.join(root, "m2m_ernie", "segmentation", "*.annot"))):
    labels, ctab, names = nib.freesurfer.read_annot(path)
    rel = os.path.relpath(path, root)
    out["annots"][rel] = {
        "n": int(labels.shape[0]),
        "nEntries": int(ctab.shape[0]),
        "names": [n.decode() if isinstance(n, bytes) else str(n) for n in names],
        "unassigned": int((labels < 0).sum()),
        "distinctAssigned": int(len(set(int(v) for v in labels if v >= 0))),
    }
for path in sorted(glob.glob(os.path.join(root, "m2m_ernie", "surfaces", "*.gii"))):
    img = nib.load(path)
    pts = [a for a in img.darrays if a.intent == 1008]
    if not pts:
        continue
    rel = os.path.relpath(path, root)
    out["surfaces"][rel] = {"nNodes": int(pts[0].data.shape[0])}
json.dump(out, sys.stdout, indent=2)
sys.stdout.write("\n")
