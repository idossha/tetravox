#!/usr/bin/env python3
"""Reference totals for the real-data scan test, from numpy reading the raw files (no Tetravox parser).

    python3 scripts/refvalues/tract_refvalues.py /Users/idohaber/datasets/000 > scripts/refvalues/tract_refvalues.json

The TCK body is read as float32 triplets: a NaN ends a streamline, inf ends the file. `sum_x` adds the
float32 x values as float64 in file order. `sift2_weights.txt` is `np.loadtxt` in float32, as the scan
parses it. Cross-check by hand with MRtrix: `tckinfo -count` and `tckstats -output count`.
"""

import json
import re
import sys
from pathlib import Path

import numpy as np


def main() -> None:
    root = Path(sys.argv[1])
    mr = root / "derivatives/ti-toolbox/tract_validation/mrtrix_ref"
    path = mr / "tracks_ifod2_200k.tck"
    head = path.read_bytes()[:1 << 16].split(b"\nEND\n")[0].decode()
    offset = int(re.search(r"^file: \. (\d+)$", head, re.M).group(1))
    assert "datatype: Float32LE" in head
    body = np.memmap(path, dtype="<f4", mode="r", offset=offset).reshape(-1, 3)
    end = int(np.argmax(np.isinf(body[:, 0])))
    x = np.asarray(body[:end, 0], dtype=np.float32)
    nan = np.isnan(x)
    finite = x[~nan]
    weights = np.loadtxt(mr / "sift2_weights.txt", dtype=np.float32, comments="#").ravel()
    assert weights.size == int(nan.sum())
    print(json.dumps({
        "generated": "2026-11-05",
        "reader": "numpy over the raw TCK body; np.loadtxt for the weights",
        "tck_200k": {
            "streamlines": int(nan.sum()),
            "points": int(finite.size),
            "sum_x": float(np.sum(finite.astype(np.float64))),
            "sum_sift2": float(np.sum(weights.astype(np.float64))),
        },
    }, indent=2))


if __name__ == "__main__":
    main()
