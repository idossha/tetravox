#!/usr/bin/env python3
"""A turntable of the head mesh: one full turn, as a GIF and an MP4.

The orbit stops one step short of 360°, so the GIF loops without holding the same frame twice, and
the camera is put back where it started afterwards.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import ERNIE_MESH, out_dir, report, require  # noqa: E402
from tetravox import Job  # noqa: E402

FRAMES, DEGREES = 36, 360


def main() -> None:
    require(ERNIE_MESH)
    result = (
        Job(files=[ERNIE_MESH], preset="mesh-tissues-translucent", window=(900, 900))
        # `L` — eye on −X, superior up — and `z` is superior in RAS, so superior stays up all the
        # way round rather than the head rolling over halfway.
        .set(layout="3d-only", view="view3d", camera="L")
        .orbit(
            "head-orbit",
            frames=FRAMES,
            degrees=DEGREES,
            axis="z",
            fps=12,
            width=360,
            colors=32,  # a smooth-shaded surface has no fine colour detail to lose
            format="mp4",
        )
        .run(out_dir("orbit"))
    )
    report(result)


if __name__ == "__main__":
    main()
