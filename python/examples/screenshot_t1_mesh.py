#!/usr/bin/env python3
"""Two figures from one job: an axial T1 slice, and the head mesh in 3D.

The point of the example is that both come out of a *single* app launch. Loading `ernie.msh` is 184 MB
and about a second of parsing, so a script that wanted six figures and launched six times would spend
most of its run re-reading the same file; a job is a list of actions over one loaded scene.
"""

from __future__ import annotations

import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import ERNIE_MSH, T1, out_dir, report, require  # noqa: E402
from tetravox import Job  # noqa: E402


def main() -> None:
    require(T1, ERNIE_MSH)
    result = (
        Job(files=[T1, ERNIE_MSH], preset="mesh-tissues-translucent", window=(1400, 900))
        # A slice through the thalamus, with the crosshair off: a figure does not want the cursor in
        # it, and `include` is per-screenshot rather than a mode the whole job is in.
        .set(cursor=(0, -18, 8), layout="1x1", view="axial", mm_per_px=0.3)
        .screenshot("t1-axial.png", view="axial", width=800, dpi=300, crosshair=False)
        # …and the head, from the left, with the scalp and skull translucent (the preset's doing).
        .set(layout="3d-only", camera="L", view="view3d", distance=330)
        .screenshot("head-3d.png", view="view3d", width=700, dpi=300)
        .run(out_dir("screenshot_t1_mesh"))
    )
    report(result)


if __name__ == "__main__":
    main()
