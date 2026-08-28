"""Where the examples get their data.

Every example runs against the reference subject the repository's tests use, so the pictures in
`docs/screenshots/directed-2026-08-28/` can be reproduced by anyone who has it:

    export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
    python python/examples/screenshot_t1_mesh.py

Point `TETRAVOX_TESTDATA` at any SimNIBS subject directory and the examples follow, since every path
below is derived from it rather than hard-coded. An example that cannot find its data says so and
exits 2 — it does not fall back to a synthetic stand-in, because an example that quietly renders
something else is worse than one that stops.
"""

from __future__ import annotations

import os
import sys

# Run from a checkout without `pip install -e python/`: put the package's own directory on the path.
# An installed copy shadows nothing — this only ever adds the directory the examples already live in.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.environ.get("TETRAVOX_TESTDATA", "")

T1 = os.path.join(ROOT, "m2m_ernie", "T1.nii.gz")
ERNIE_MSH = os.path.join(ROOT, "m2m_ernie", "ernie.msh")
LABELS = os.path.join(ROOT, "m2m_ernie", "segmentation", "labeling.nii.gz")
TI_MAX = os.path.join(
    ROOT, "Simulations", "Thalamus", "TI", "niftis", "Thalamus_TI_subject_TI_max.nii.gz"
)


def require(*paths: str) -> None:
    """Stop with a useful message when the reference data is not on this machine."""
    if not ROOT:
        print(
            "TETRAVOX_TESTDATA is not set — point it at a SimNIBS subject directory, e.g.\n"
            "  export TETRAVOX_TESTDATA=/data/derivatives/SimNIBS/sub-ernie",
            file=sys.stderr,
        )
        raise SystemExit(2)
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        print("missing input files:\n  " + "\n  ".join(missing), file=sys.stderr)
        raise SystemExit(2)


def out_dir(name: str) -> str:
    """`TETRAVOX_EXAMPLE_OUT` or `./out/<name>`, created."""
    base = os.environ.get("TETRAVOX_EXAMPLE_OUT") or os.path.join(os.getcwd(), "out")
    target = os.path.join(base, name)
    os.makedirs(target, exist_ok=True)
    return target


def report(result) -> None:
    """Print what the run produced — the same summary every example ends with."""
    for warning in result.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    result.raise_for_status()
    total = result.timings.get("totalMs", 0)
    print(f"ok in {total} ms")
    for path in result.files:
        print(f"  {path} ({os.path.getsize(path)} B)")
