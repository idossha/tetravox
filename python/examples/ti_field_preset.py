#!/usr/bin/env python3
"""The `ti-field-on-t1` preset: a TI simulation over the subject's own T1.

No thresholds are typed here on purpose. The preset reads the field's own distribution and puts the
threshold at its 90th percentile and the heat scale's top at its 99.9th — numbers that are different
for every simulation, which is exactly why a hard-coded 0.2 V/m would render an empty pane on one
subject and a solid block on the next.

The second half shows what a preset is *for*: it is a starting point, and `set(patch=...)` reaches any
layer property from there, in the app's own vocabulary.
"""

from __future__ import annotations

import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import T1, TI_MAX, out_dir, report, require  # noqa: E402
from tetravox import Job  # noqa: E402


def main() -> None:
    require(T1, TI_MAX)
    result = (
        Job(files=[T1, TI_MAX], preset="ti-field-on-t1", window=(1400, 900))
        # `mm_per_px` frames the head: the scene default of 0.5 covers 350 mm on a 700 px pane.
        .set(cursor=(0, -18, 8), view="axial", mm_per_px=0.3)
        .screenshot("ti-grid.png", width=1400)
        .screenshot("ti-axial.png", view="axial", width=800, dpi=300, crosshair=False)
        # The preset chose `hot`; this is what overriding one of its choices looks like.
        .set(layer="Thalamus_TI_subject_TI_max.nii.gz", patch={"colormap": "viridis", "opacity": 0.7})
        .screenshot("ti-axial-viridis.png", view="axial", width=800, crosshair=False)
        .run(out_dir("ti_field_preset"))
    )
    report(result)


if __name__ == "__main__":
    main()
