#!/usr/bin/env python3
"""Independent nibabel/NumPy tensor reference, §6.1/§7.3 (2026-09-19).

Run with SimNIBS Python. Writes synthetic references to testdata/tensors.json and,
when TETRAVOX_TESTDATA is set, tensor_refvalues.json beside this script.
No product code is imported. Physical components come from nibabel's scaled proxy.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import nibabel as nib
import numpy as np


def reference(path: Path, points: list[list[int]], order: str) -> dict:
    image = nib.load(path)
    data = np.asarray(image.dataobj).reshape((*image.shape[:3], 6), order="F")
    rotation = image.affine[:3, :3].copy()
    rotation /= np.linalg.norm(rotation, axis=0)
    if np.linalg.det(rotation) > 0:
        rotation[:, 0] *= -1
    spots = []
    for point in points:
        c = data[tuple(point)].astype(np.float64)
        if order == "nifti":
            c = c[[0, 1, 3, 2, 4, 5]]
        matrix = c[[0, 1, 2, 1, 3, 4, 2, 4, 5]].reshape(3, 3)
        eigenvalues, eigenvectors = np.linalg.eigh(matrix)
        valid = bool(np.all(np.isfinite(eigenvalues)) and np.all(eigenvalues > 0))
        rec = {"voxel": point, "valid": valid, "components": c.tolist()}
        if valid:
            fa = float(np.sqrt(1.5 * np.sum((eigenvalues - eigenvalues.mean()) ** 2)
                               / np.sum(eigenvalues ** 2)))
            world = rotation @ eigenvectors
            shape = world @ np.diag(1 / np.maximum(eigenvalues / eigenvalues[-1], 0.02) ** 2) @ world.T
            rgb = np.full(3, 166) if fa < 1e-6 else np.rint(255 * np.abs(world[:, -1])).astype(int)
            rec.update(fa=fa, metric=shape[np.triu_indices(3)].tolist(), rgb=rgb.tolist())
        spots.append(rec)
    return {"reader": f"nibabel {nib.__version__}; numpy.linalg.eigh {np.__version__}",
            "file": path.name, "order": order, "basis": "fsl", "affine": image.affine.tolist(),
            "dims": list(image.shape[:3]), "spots": spots}


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    fixtures = ["tensor_fsl.nii.gz", "tensor_symmatrix.nii.gz", "tensor_scaled.nii.gz"]
    refs = [reference(root / "testdata" / name, [[x, 2, 2] for x in [2, 3, 5, 6, 7, 8]],
                      "nifti" if "symmatrix" in name else "fsl") for name in fixtures]
    (root / "testdata/tensors.json").write_text(json.dumps(refs, indent=2) + "\n")
    data_root = os.environ.get("TETRAVOX_TESTDATA")
    if data_root:
        path = Path(data_root) / "m2m_ernie/DTI_coregT1_tensor.nii.gz"
        points = [[i, j, k] for i in [96, 128, 160] for j in [96, 128, 160] for k in [80, 104, 128]]
        ref = reference(path, points, "fsl")
        t1 = nib.load(Path(data_root) / "m2m_ernie/T1.nii.gz")
        ref["t1Affine"] = t1.affine.tolist()
        ref["t1Dims"] = list(t1.shape)
        Path(__file__).with_suffix(".json").write_text(json.dumps(ref, indent=2) + "\n")


if __name__ == "__main__":
    main()
