#!/usr/bin/env python3
"""Two figures from one app launch: an axial T1 slice, and the left pial surface over it.

Loading is what a launch costs, so a job that wants two pictures asks for both.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import PIAL, T1, out_dir, report, require  # noqa: E402
from tetravox import Job  # noqa: E402

CURSOR = (0.0, 9.0, 18.0)  # world RAS mm — the thalamus
MM_PER_PX = 0.32  # smaller is closer; 0.32 fills a 700 px pane with a 180 mm head


def main() -> None:
    require(T1, PIAL)
    result = (
        Job(files=[T1, PIAL], preset="plain", window=(1400, 900))
        .set(cursor=CURSOR, layout="1x1", view="axial", mm_per_px=MM_PER_PX)
        .set(layer="lh.pial.gii", patch={"visible": False})
        .screenshot("axial.png", view="axial", width=1200, dpi=300, scale_bar=True)
        # The surface over the T1's three planes: `showIn3D` is what puts the slices in the 3D pane,
        # and a surface with no anatomy under it is a shape with nowhere to be.
        .set(layer="lh.pial.gii", patch={"visible": True})
        .set(layer="T1.nii.gz", patch={"showIn3D": True})
        .set(layout="3d-only", view="view3d", camera="L")
        .set(view="view3d", distance=380)
        .screenshot("pial-3d.png", width=1200, dpi=300)
        .run(out_dir("screenshot"))
    )
    report(result)


if __name__ == "__main__":
    main()
