#!/usr/bin/env python3
"""Reference values for §7.4's element isolation on the real data (owner: E-MESH).

The one number `test/e2e/mesh-real.spec.ts` cannot compute for itself: how many tets of
`Thalamus_TI.msh` are grey matter (tet tag 2) **and** carry `TI_max` at or above the 90th
percentile of `TI_max` over grey matter. The engine's answer is
`Engine.meshIsolation(layer).visibleTets`, straight out of §6.5.2; this script's answer comes from
SimNIBS's own reader and numpy, so agreement means the isolation predicate is right rather than
self-consistent.

Two details that decide the last few tets, and are therefore not incidental:

* **float32.** `tvx-mesh-io` stores an `$ElementData` field as `f32` and `IsolateCriteria.field.lo`
  is an `f32`, while the `.msh` carries `double`. The percentile and the comparison are both taken
  after casting to `float32`, or the two sides disagree on a handful of tets straddling the cut.
* **`>=`, not `>`.** §6.3's predicate is `v >= lo && v <= hi` — inclusive at both ends.

Run:

    /Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python \\
        scripts/refvalues/mesh_isolate_refvalues.py [testdata_root]

Prints JSON. Default root is `$TETRAVOX_TESTDATA`.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from simnibs.mesh_tools import mesh_io

GM_TAG = 2
FIELD = "TI_max"
PERCENTILE = 90.0


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TETRAVOX_TESTDATA", "")
    if not root:
        print(json.dumps({"error": "no testdata root"}))
        return 1
    path = os.path.join(root, "Simulations/Thalamus/TI/mesh/Thalamus_TI.msh")
    m = mesh_io.read_msh(path)

    is_tet = m.elm.elm_type == 4
    tet_tags = m.elm.tag1[is_tet]
    field = next(f for f in m.elmdata if f.field_name == FIELD)
    # `mesh_io` returns the whole element block (tris first); the tet half is what §6.3 indexes.
    values = np.asarray(field.value, dtype=np.float64).reshape(-1)[is_tet].astype(np.float32)

    gm = tet_tags == GM_TAG
    gm_values = values[gm]
    # `np.percentile` interpolates in float64; the threshold that crosses the wire is an f32.
    lo = np.float32(np.percentile(gm_values.astype(np.float64), PERCENTILE))

    out = {
        "file": path,
        "field": FIELD,
        "gmTag": GM_TAG,
        "percentile": PERCENTILE,
        "tets": int(is_tet.sum()),
        "gmTets": int(gm.sum()),
        # Emitted as the exact f32 the spec must send: `float(np.float32(x))` is the f64 that
        # round-trips back to the same f32, which is what JSON carries.
        "lo": float(lo),
        "visibleTets": int(np.count_nonzero(gm & (values >= lo))),
        # The same count without the tag term, so a spec that drops `combine: "all"` fails loudly
        # instead of passing on a coincidence.
        "visibleTetsFieldOnly": int(np.count_nonzero(values >= lo)),
        "gmFieldMin": float(gm_values.min()),
        "gmFieldMax": float(gm_values.max()),
    }
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
