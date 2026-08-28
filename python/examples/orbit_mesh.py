#!/usr/bin/env python3
"""A turntable of the head mesh: 24 frames of a full turn, as a GIF and an MP4.

The orbit stops one step short of 360°, so the GIF loops without holding the same picture for two
frames — and the camera is put back where it started, so anything after this in the job photographs
the scene as it was set up.
"""

from __future__ import annotations

import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import ERNIE_MSH, out_dir, report, require  # noqa: E402
from tetravox import Job  # noqa: E402


def main() -> None:
    require(ERNIE_MSH)
    result = (
        Job(files=[ERNIE_MSH], preset="mesh-tissues-translucent", window=(900, 900))
        .set(layout="3d-only", camera="A", view="view3d")
        .orbit(
            "head-orbit",
            frames=24,
            degrees=360,
            axis="z",
            fps=12,
            width=320,
            # 32 colours rather than 256: a smooth-shaded 3D surface has no fine colour detail to
            # lose. Together with 24 frames at 320 px this is what keeps the GIF under 2 MB — the
            # difference between a file a README can carry and one it cannot. The MP4 beside it is
            # a tenth the size at full resolution, which is what to reach for when size matters.
            colors=32,
            format="mp4",
        )
        .run(out_dir("orbit_mesh"))
    )
    report(result)


if __name__ == "__main__":
    main()
