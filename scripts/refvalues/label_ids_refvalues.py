#!/usr/bin/env python3
"""The label ids of three real atlases, for §7.6's FreeSurfer safety test (`labelNames.test.ts`).

nibabel reads each file and numpy takes the unique values, so the ids share no code with the engine.

    python3 scripts/refvalues/label_ids_refvalues.py > scripts/refvalues/label_ids_refvalues.json

Takes the datasets root as argv[1], defaulting to ~/datasets/000/derivatives.
"""

import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "datasets/000/derivatives"
FILES = {
    "aseg": "qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_desc-aseg_dseg.nii.gz",
    "dseg": "qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_dseg.nii.gz",
    "finalTissues": "SimNIBS/sub-ernie/m2m_ernie/final_tissues.nii.gz",
}

out = {}
for key, rel in FILES.items():
    ids = np.unique(np.asanyarray(nib.load(ROOT / rel).dataobj))
    out[key] = {"file": rel, "ids": [int(i) for i in ids]}
json.dump(out, sys.stdout, indent=1)
print()
