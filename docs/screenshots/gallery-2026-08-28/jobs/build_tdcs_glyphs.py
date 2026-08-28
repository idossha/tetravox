#!/usr/bin/env python3
"""The TDCS E-field mesh: field-coloured surface and vector glyphs.

    export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/gallery-2026-08-28/jobs/build_tdcs_glyphs.py

Uses the `plain` preset and sets `colorMode: 'field'` by hand rather than `ti-field-on-t1`: that
preset thresholds the field at its **whole-mesh** p90 (0.598 V/m on this mesh, which includes the
electrodes and gel where |E| peaks at 13 V/m), and the cortical surface's |E| tops out at 0.285 V/m
— so under the preset every surface triangle is below threshold and the 3D pane is empty. Not a
renderer bug (see README); the field renders as soon as the threshold is off.
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

cands = sorted(glob.glob(f"{TD}/Simulations/*/high_Frequency/mesh/*_TDCS_1_scalar.msh"))
mesh = cands[0]
name = os.path.basename(mesh)
field = {"source": "elm", "name": "E", "component": "mag"}

j = Job(files=[mesh], preset="plain")
j.set(layer=name, patch={"colorMode": "field", "field": field, "colormap": "hot", "showColorbar": True})
j.set(view="view3d", camera="L", distance=280)
j.screenshot("tdcs-field-surface-3d-left", view="view3d", width=1400)
j.set(camera="S")
j.screenshot("tdcs-field-surface-3d-superior", view="view3d", width=1400)
j.set(layer=name, patch={"colormap": "viridis"})
j.screenshot("tdcs-field-surface-colormap-viridis", view="view3d", width=1400)

glyph_base = {"field": {"source": "elm", "name": "E"}, "shape": "arrow",
              "colorBy": "magnitude", "color": [1, 1, 1, 1]}
j.set(layer=name, patch={"colorMode": "tag", "opacity": 0.15,
                          "glyphs": {**glyph_base, "subsample": {"everyNth": 400},
                                     "scale": "byMagnitude", "lengthMm": 10.0}})
j.set(camera="L")
j.screenshot("tdcs-vector-glyphs-arrows", view="view3d", width=1400)
j.set(layer=name, patch={"glyphs": {**glyph_base, "shape": "line",
                                     "subsample": {"everyNth": 400},
                                     "scale": "byMagnitude", "lengthMm": 10.0}})
j.screenshot("tdcs-vector-glyphs-lines", view="view3d", width=1400)
j.set(camera="A")
j.screenshot("tdcs-vector-glyphs-anterior", view="view3d", width=1400)

j.write(os.path.join(HERE, "tdcs-vector-field.json"))
r = j.run(OUT)
r.raise_for_status()
print("OK", [os.path.basename(f) for f in r.files])
