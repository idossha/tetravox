#!/usr/bin/env python3
"""An axial sweep through the T1 as a GIF (and an MP4, if ffmpeg is about).

`count` rather than `step`, because "twenty-four frames" is what a figure caption needs and
"every 5 mm" is what the range happens to make that. Leave `start`/`stop` out entirely and the app
covers the scene's own extent along the view normal, which is the right default when a script does
not know the subject.
"""

from __future__ import annotations

import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import T1, out_dir, report, require  # noqa: E402
from tetravox import Job  # noqa: E402


def main() -> None:
    require(T1)
    result = (
        Job(files=[T1], preset="plain", window=(900, 900))
        .set(layout="1x1", view="axial", mm_per_px=0.32)
        .sweep(
            "axial-sweep",
            view="axial",
            # Through the brain rather than through the whole scanner box: the default range is the
            # volume's own extent, which for this T1 is 255 mm around a 180 mm head, so a default
            # sweep opens on a few empty slices. `start`/`stop` are millimetres in world RAS.
            start=-50,
            stop=70,
            count=24,
            fps=12,
            width=600,
            format="mp4",
            crosshair=False,
        )
        .run(out_dir("sweep_axial_gif"))
    )
    report(result)


if __name__ == "__main__":
    main()
