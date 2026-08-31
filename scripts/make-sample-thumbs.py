#!/usr/bin/env python3
"""Render the sample-data thumbnails from the full-resolution screenshot masters.

The in-app Sample Data dialog's cards are the one copy of these stills; the
website's Sample data page gets them from `website/scripts/sample-data.mjs`,
which copies this directory into `website/public/samples/`. They are derived
from the masters under `docs/screenshots/<set>/`, never re-encoded from an
already-compressed copy — a 480 px thumbnail is visibly soft on the website's
cards, which are read at ~340 CSS px on a Retina display.

Usage:  python3 scripts/make-sample-thumbs.py [--set 2026-08-29]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# sample id -> master, relative to docs/screenshots/<set>/
MASTERS = {
    "ernie-t1": "brain/brain-t1-2x2.png",
    "ernie-tissues": "brain/brain-tissues-2x2.png",
    "ernie-pial": "brain/brain-t1-pial-both.png",
    "ernie-eeg": "brain/brain-t1-eeg.png",
    "ernie-ti": "brain/brain-mesh-ti-max-2x2.png",
    "totalseg-ct": "modalities/mod-abdomen-ct-labels-3d.png",
    "amos-ct": "hero/hero-abdomen-ct-2x2.png",
    "amos-mri": "modalities/mod-abdomen-mri-labels-2x2.png",
    "ct-abdo": "modalities/mod-chest-ct-lung-2x2.png",
    "spine-ct": "hero/hero-spine-ct-2x2.png",
}

# 1200 px is the sweet spot for both consumers: the app dialog's cards are a few
# hundred CSS px, and the website re-encodes these to WebP for a card read at
# ~340 CSS px, so 1200 is still better than 3x there while keeping the bundled
# JPEGs to ~150 kB each. 4:2:0 chroma subsampling is off because these stills
# carry saturated label colours on thin structures.
TARGETS = ((Path("packages/app/src/renderer/src/assets/samples"), 1200, 86),)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--set", default="2026-08-29", help="screenshot set under docs/screenshots")
    args = ap.parse_args()

    src_dir = ROOT / "docs/screenshots" / args.set
    missing = [m for m in MASTERS.values() if not (src_dir / m).is_file()]
    if missing:
        raise SystemExit(f"missing masters under {src_dir}:\n  " + "\n  ".join(missing))

    for out_rel, width, quality in TARGETS:
        out_dir = ROOT / out_rel
        out_dir.mkdir(parents=True, exist_ok=True)
        for sample, master in MASTERS.items():
            im = Image.open(src_dir / master).convert("RGB")
            if im.width > width:
                height = round(im.height * width / im.width)
                im = im.resize((width, height), Image.LANCZOS)
            out = out_dir / f"{sample}.jpg"
            im.save(out, "JPEG", quality=quality, subsampling=0, optimize=True, progressive=True)
            print(f"{out.relative_to(ROOT)}  {im.width}x{im.height}  {out.stat().st_size // 1024} kB")


if __name__ == "__main__":
    main()
