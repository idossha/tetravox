#!/usr/bin/env python3
"""Vector-glyph captures for the TDCS E-field mesh.

Split out from build_gallery.py: MeshLayer colorMode:'field' renders fully
black in the 3D pane for ernie_TDCS_1_scalar.msh (confirmed: the same mesh
with the default tag/solid colour mode renders correctly, and the field's
own colour-bar statistics compute correctly — only the field-coloured
surface geometry itself does not draw). That looks like an app rendering
bug scoped to MeshLayer colorMode:'field' on this mesh; not fixed here per
the task's "do not modify app source" constraint. Glyphs (which read
meshCentroids independently of the surface colour pass) render fine, so
this script captures those instead of the broken field-coloured surface.
"""
import os
import sys
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
GALLERY_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(GALLERY_DIR)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from tetravox import Job  # noqa: E402

TD = os.environ["TETRAVOX_TESTDATA"]
OUT = GALLERY_DIR
JOBS = os.path.join(OUT, "jobs")

cands = glob.glob(f"{TD}/Simulations/*/high_Frequency/mesh/*_TDCS_1_scalar.msh")
mesh = cands[0]
name = os.path.basename(mesh)

j = Job(files=[mesh], preset="plain")
glyph_base = {"field": {"source": "elm", "name": "E"}, "shape": "arrow",
              "colorBy": "magnitude", "color": [1, 1, 1, 1]}
j.set(layer=name, patch={"glyphs": {**glyph_base, "subsample": {"everyNth": 400},
                                     "scale": "byMagnitude", "lengthMm": 10.0},
                          "opacity": 0.15})
j.set(view="view3d", camera="L", distance=280)
j.screenshot("tdcs-vector-glyphs-arrows", view="view3d", width=1400)
j.set(layer=name, patch={"glyphs": {**glyph_base, "shape": "line",
                                     "subsample": {"everyNth": 400},
                                     "scale": "byMagnitude", "lengthMm": 10.0}})
j.screenshot("tdcs-vector-glyphs-lines", view="view3d", width=1400)
j.set(view="view3d", camera="A", distance=280)
j.screenshot("tdcs-vector-glyphs-anterior", view="view3d", width=1400)

j.write(os.path.join(JOBS, "tdcs-vector-field.json"))
r = j.run(OUT)
r.raise_for_status()
print("OK", [os.path.basename(f) for f in r.files])
