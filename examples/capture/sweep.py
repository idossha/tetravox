#!/usr/bin/env python3
"""An axial sweep through the TI field over the T1: PNG frames, a GIF and an MP4.

`ti-field-on-t1` picks its own threshold and scale off the field's distribution, so the numbers are
the data's rather than this file's.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import FIELD_VOLUME, T1, out_dir, report, require  # noqa: E402
from tetravox import Job  # noqa: E402

FROM_Z, TO_Z, FRAMES = -10.0, 46.0, 32  # world RAS mm, inclusive of both ends


def main() -> None:
    require(T1, FIELD_VOLUME)
    result = (
        Job(files=[T1, FIELD_VOLUME], preset="ti-field-on-t1", window=(1200, 1200))
        .set(layout="1x1", view="axial", mm_per_px=0.32)
        .sweep(
            "ti-axial",
            view="axial",
            start=FROM_Z,
            stop=TO_Z,
            count=FRAMES,
            fps=12,
            width=640,
            colors=64,  # a shared, undithered palette: consecutive slices must not shimmer
            format="mp4",
        )
        .run(out_dir("sweep"))
    )
    report(result)


if __name__ == "__main__":
    main()
