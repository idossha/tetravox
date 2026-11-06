#!/usr/bin/env python3
"""Compare what Tetravox's tractogram parsers and samplers answer with independent readers.

    python3 scripts/reference/tract_reference.py --data <Dataset 000> --out <scratch dir>

Reads the data, writes only under --out. `crates/tvx-tract/examples/sample_dump.rs` is the same parser
and sampler code the worker runs. References: nibabel.streamlines for geometry, scipy map_coordinates
(order=1) with tangents recomputed here for a volume, and the fields a tractogram's own producer stored
for a mesh. Prints one JSON document.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import nibabel as nib
import numpy as np
from nibabel.streamlines import Tractogram, TrkFile
from scipy.ndimage import map_coordinates


def dump(tract: Path, budget: str, out: Path, *jobs: str) -> None:
    subprocess.run(
        ["target/release/examples/sample_dump", str(tract), budget, str(out), *jobs], check=True
    )


def f32(path: Path) -> np.ndarray:
    return np.fromfile(path, dtype="<f4")


def stats(a: np.ndarray, b: np.ndarray) -> dict:
    """Agreement of two per-point arrays. NaN must be NaN in both."""
    na, nb = np.isnan(a), np.isnan(b)
    both = ~na & ~nb
    d = np.abs(a[both] - b[both])
    return {
        "points": int(a.size),
        "compared": int(both.sum()),
        "nan_only_ours": int((na & ~nb).sum()),
        "nan_only_reference": int((nb & ~na).sum()),
        "max_abs_diff": float(d.max()) if d.size else None,
        "rms_diff": float(np.sqrt(np.mean(d**2))) if d.size else None,
        "p99_abs_diff": float(np.percentile(d, 99)) if d.size else None,
        "frac_above_1e-4": float(np.mean(d > 1e-4)) if d.size else None,
        "reference_median": float(np.nanmedian(b)),
    }


def tangents(p: np.ndarray, offsets: np.ndarray) -> np.ndarray:
    t = np.zeros_like(p, dtype=np.float64)
    q = p.astype(np.float64)
    for a, b in zip(offsets[:-1], offsets[1:]):
        if b - a < 2:
            continue
        t[a] = q[a + 1] - q[a]
        t[b - 1] = q[b - 1] - q[b - 2]
        t[a + 1 : b - 1] = q[a + 2 : b] - q[a : b - 2]
    n = np.linalg.norm(t, axis=1, keepdims=True)
    return np.divide(t, n, out=np.zeros_like(t), where=n > 0)


def voxels(img, p: np.ndarray) -> np.ndarray:
    return nib.affines.apply_affine(np.linalg.inv(img.affine), p.astype(np.float64)).T


def generic(data: Path, out: Path) -> dict:
    mr = data / "derivatives/ti-toolbox/tract_validation/mrtrix_ref"
    work = out / "generic"
    dump(
        mr / "tracks_ifod2_200k.tck", "8000000", work,
        "volume", str(mr / "fa.nii.gz"), "value", "-", "fa",
        "volume", str(mr / "v1.nii.gz"), "abs-dot", "-", "v1_absdot",
    )  # fmt: skip
    p = f32(work / "positions.f32").reshape(-1, 3)
    offsets = np.fromfile(work / "offsets.u32", dtype="<u4")
    res: dict = {"points": int(len(p)), "streamlines": int(len(offsets) - 1)}

    t = tangents(p, offsets)
    res["tangent_max_abs_diff"] = float(np.abs(t - f32(work / "tangents.f32").reshape(-1, 3)).max())

    fa = nib.load(mr / "fa.nii.gz")
    ref = map_coordinates(
        np.asarray(fa.dataobj, dtype=np.float64), voxels(fa, p), order=1, mode="constant", cval=np.nan
    )
    res["fa_vs_scipy"] = stats(f32(work / "fa.f32"), ref.astype("float32"))

    v1 = nib.load(mr / "v1.nii.gz")
    data_v = np.asarray(v1.dataobj, dtype=np.float64)
    ijk = voxels(v1, p)
    comp = np.stack(
        [map_coordinates(data_v[..., c], ijk, order=1, mode="constant", cval=np.nan) for c in range(3)],
        axis=1,
    )
    res["v1_absdot_vs_scipy"] = stats(
        f32(work / "v1_absdot.f32"), np.abs((comp * t).sum(axis=1)).astype("float32")
    )
    return res


def trk_overlay(data: Path, out: Path) -> dict:
    """A TRK made from the TCK by nibabel must land on the TCK's own points."""
    mr = data / "derivatives/ti-toolbox/tract_validation/mrtrix_ref"
    work = out / "trk"
    work.mkdir(parents=True, exist_ok=True)
    fa = nib.load(mr / "fa.nii.gz")
    tck = nib.streamlines.load(mr / "tracks_ifod2_200k.tck", lazy_load=True)
    lines = []
    for s in tck.streamlines:
        lines.append(np.asarray(s, dtype=np.float32))
        if len(lines) == 2000:
            break
    tractogram = Tractogram(lines, affine_to_rasmm=np.eye(4))
    path = work / "subset.trk"
    header = {
        "dimensions": fa.shape[:3],
        "voxel_sizes": fa.header.get_zooms()[:3],
        "voxel_to_rasmm": fa.affine,
        "voxel_order": "".join(nib.aff2axcodes(fa.affine)),
    }
    TrkFile(tractogram, header=header).save(path)
    tck_path = work / "subset.tck"
    nib.streamlines.save(Tractogram(lines, affine_to_rasmm=np.eye(4)), tck_path)
    dump(path, "all", work / "from_trk")
    dump(tck_path, "all", work / "from_tck")
    a = f32(work / "from_trk/positions.f32")
    b = f32(work / "from_tck/positions.f32")
    want = np.concatenate(lines).ravel()
    return {
        "streamlines": len(lines),
        "trk_vs_nibabel_tck_max_mm": float(np.abs(a - want).max()),
        "tck_vs_nibabel_tck_max_mm": float(np.abs(b - want).max()),
        "voxel_order": header["voxel_order"],
    }


def ti(data: Path, out: Path) -> dict:
    sim = data / "derivatives/SimNIBS/sub-CHN/Simulations/thalamus"
    work = out / "ti"
    dump(
        data / "derivatives/ti-toolbox/tract_validation/thalamus_tract/thalamocortical_lh.trx", "all", work,
        "mesh", str(sim / "TI/mesh/thalamus_TI.msh"), "value", "elm:TI_max", "TI_max",
        "mesh", str(sim / "high_Frequency/mesh/CHN_TDCS_1_scalar.msh"), "abs-dot", "elm:E", "E_absdot",
    )  # fmt: skip
    res: dict = {}
    res["TI_max_vs_dpv_ti_max"] = stats(f32(work / "TI_max.f32"), f32(work / "dpv_ti_max.f32"))
    res["E_absdot_vs_abs_dpv_e1_par"] = stats(
        f32(work / "E_absdot.f32"), np.abs(f32(work / "dpv_e1_par.f32"))
    )
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    subprocess.run(
        ["cargo", "build", "--release", "-p", "tvx-tract", "--example", "sample_dump"], check=True
    )
    print(
        json.dumps(
            {"generic": generic(a.data, a.out), "trk": trk_overlay(a.data, a.out), "ti": ti(a.data, a.out)},
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
