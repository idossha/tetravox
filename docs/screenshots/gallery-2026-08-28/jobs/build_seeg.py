#!/usr/bin/env python3
"""sEEG leads (m2m_ernie-seeg) and a FreeSurfer binary surface (MNE's fsaverage lh.pial).

    export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/gallery-2026-08-28/jobs/build_seeg.py

`ernie-seeg.msh` is the sEEG head mesh (electrode tags in the 101/501/... ranges, >2^21 nodes) and
`ernie_seeg_views.pos` is the Gmsh post-processing view SimNIBS writes for the contacts. Both open
through the ordinary mesh path. `.annot` / `.curv` do NOT open (see README) so only the surface is
shown for FreeSurfer.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GALLERY_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(GALLERY_DIR)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from tetravox import Job  # noqa: E402

TD = os.environ["TETRAVOX_TESTDATA"]
SEEG = f"{TD}/m2m_ernie-seeg"
FSAVG = os.environ.get("FSAVERAGE", "/Users/idohaber/mne_data/MNE-fsaverage-data/fsaverage")

j = Job(files=[f"{TD}/m2m_ernie/T1.nii.gz", f"{SEEG}/ernie-seeg.msh", f"{SEEG}/ernie_seeg_views.pos"],
        preset="mesh-tissues-translucent")
j.set(view="view3d", camera="R", distance=280)
j.screenshot("seeg-leads-mesh-3d-right", view="view3d", width=1400)
j.set(view="axial", cursor=(40, 8, -1), mm_per_px=0.35)
j.screenshot("seeg-leads-contacts-axial", view="axial", width=1400)
j.write(os.path.join(HERE, "seeg-leads.json"))
r = j.run(GALLERY_DIR)
r.raise_for_status()
print("[ok] seeg-leads", [os.path.basename(f) for f in r.files])

if os.path.exists(f"{FSAVG}/surf/lh.pial"):
    j = Job(files=[f"{FSAVG}/surf/lh.pial"], preset="plain")
    j.set(view="view3d", camera="L", reset=True)
    j.screenshot("freesurfer-binary-pial-3d", view="view3d", width=1400)
    j.write(os.path.join(HERE, "freesurfer-pial.json"))
    r = j.run(GALLERY_DIR)
    r.raise_for_status()
    print("[ok] freesurfer-pial", [os.path.basename(f) for f in r.files])
else:
    print("[skip] no fsaverage at", FSAVG)
