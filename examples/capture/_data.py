"""Where the capture examples get their data.

Everything defaults to `data/ernie/` — git-ignored, filled by `scripts/fetch-data.sh`, described in
`data/README.md`. Set `TETRAVOX_DATA` to point somewhere else with the same layout.

An example that cannot find its data says which files are missing and exits 2. It does not fall back
to a synthetic stand-in: an example that quietly renders something else is worse than one that stops.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))

# Run from a checkout without `pip install -e python/`.
sys.path.insert(0, os.path.join(_REPO, "python"))

DATA = os.environ.get("TETRAVOX_DATA") or os.path.join(_REPO, "data", "ernie")

_join = lambda *parts: os.path.join(DATA, *parts)  # noqa: E731

T1 = _join("m2m_ernie", "T1.nii.gz")
LABELS = _join("m2m_ernie", "segmentation", "labeling.nii.gz")
TISSUES = _join("m2m_ernie", "final_tissues.nii.gz")
ERNIE_MESH = _join("m2m_ernie", "ernie.msh")
PIAL = _join("m2m_ernie", "surfaces", "lh.pial.gii")
NET = _join("m2m_ernie", "eeg_positions", "GSN-HydroCel-185.geo")

FIELD_VOLUME = _join(
    "Simulations", "Thalamus", "TI", "niftis", "grey_Thalamus_TI_subject_TI_max.nii.gz"
)
GREY_MESH = _join("Simulations", "Thalamus", "TI", "mesh", "grey_Thalamus_TI.msh")
TET_MESH = _join("Simulations", "Thalamus", "TI", "mesh", "Thalamus_TI.msh")
VECTOR_MESH = _join(
    "Simulations", "L_Insula", "high_Frequency", "mesh", "ernie_TDCS_1_scalar.msh"
)

# The one sentence about label volumes that keeps coming up.
LUT_NOTE = "interpolating a label volume invents ids that are not in the file."


def require(*paths: str) -> None:
    """Stop with a useful message when the data is not on this machine."""
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        print(
            "missing input files:\n  " + "\n  ".join(missing) + "\n\n"
            "Fill data/ernie/ with:\n"
            "  export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie\n"
            "  scripts/fetch-data.sh",
            file=sys.stderr,
        )
        raise SystemExit(2)


def out_dir(name: str) -> str:
    """`TETRAVOX_EXAMPLE_OUT` or `./out/<name>`, created."""
    base = os.environ.get("TETRAVOX_EXAMPLE_OUT") or os.path.join(os.getcwd(), "out")
    target = os.path.join(base, name)
    os.makedirs(target, exist_ok=True)
    return target


def report(result) -> None:
    """Print what the run produced — the summary the small examples end with."""
    for warning in result.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    result.raise_for_status()
    print(f"ok in {result.timings.get('totalMs', 0)} ms")
    for path in result.files:
        print(f"  {path} ({os.path.getsize(path)} B)")
