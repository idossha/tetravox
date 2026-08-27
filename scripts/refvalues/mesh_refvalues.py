#!/usr/bin/env simnibs_python
"""Reference values for Tetravox real-data mesh tests.

Run with the host SimNIBS interpreter:
  /Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python \
      scripts/refvalues/mesh_refvalues.py [TESTDATA_ROOT]

TESTDATA_ROOT defaults to $TETRAVOX_TESTDATA, else
/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie.

Emits JSON on stdout. The numbers in AGENTS.md "Test data" are this output.
"""
import json
import os
import sys
from collections import Counter

import numpy as np
from simnibs.mesh_tools import mesh_io

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "TETRAVOX_TESTDATA", "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie"
)

# Gmsh element type codes as used by SimNIBS: 2 = tri3, 4 = tet4.
TRI, TET = 2, 4


def mesh_summary(path, with_tags=True, with_fields=True, with_bbox=True):
    m = mesh_io.read_msh(path)
    et = m.elm.elm_type
    tags = m.elm.tag1
    out = {
        "path": os.path.relpath(path, ROOT),
        "bytes": os.path.getsize(path),
        "nodes": int(m.nodes.nr),
        "elements": int(m.elm.nr),
        "tris": int(np.count_nonzero(et == TRI)),
        "tets": int(np.count_nonzero(et == TET)),
    }
    if with_tags:
        out["tri_tags"] = {int(k): int(v) for k, v in sorted(Counter(tags[et == TRI].tolist()).items())}
        out["tet_tags"] = {int(k): int(v) for k, v in sorted(Counter(tags[et == TET].tolist()).items())}
    if with_bbox:
        n = m.nodes.node_coord
        out["bbox_min"] = [round(float(v), 6) for v in n.min(axis=0)]
        out["bbox_max"] = [round(float(v), 6) for v in n.max(axis=0)]
    if with_fields:
        fields = []
        for name, f in m.field.items():
            d = np.asarray(f.value)
            ncomp = int(d.shape[1]) if d.ndim > 1 else 1
            entry = {
                "name": name,
                "kind": "elmdata" if isinstance(f, mesh_io.ElementData) else "nodedata",
                "n": int(d.shape[0]),
                "ncomp": ncomp,
                "min": float(np.nanmin(d)),
                "max": float(np.nanmax(d)),
            }
            if ncomp == 3:
                mag = np.linalg.norm(d, axis=1)
                entry["mag_min"] = float(np.nanmin(mag))
                entry["mag_max"] = float(np.nanmax(mag))
            fields.append(entry)
        out["fields"] = fields
    return out


# gifti_encoding / gifti_endian / gifti_index_order / NIFTI_XFORM code tables
ENC = {1: "ASCII", 2: "Base64Binary", 3: "GZipBase64Binary", 4: "ExternalFileBinary"}
END = {1: "BigEndian", 2: "LittleEndian"}
ORD = {1: "RowMajorOrder", 2: "ColumnMajorOrder"}
XFM = {0: "NIFTI_XFORM_UNKNOWN", 1: "NIFTI_XFORM_SCANNER_ANAT",
       2: "NIFTI_XFORM_ALIGNED_ANAT", 3: "NIFTI_XFORM_TALAIRACH", 4: "NIFTI_XFORM_MNI_152"}


def gii_summary(path):
    import nibabel as nib
    g = nib.load(path)
    pts = g.agg_data("pointset")
    tri = g.agg_data("triangle")
    arrays = []
    for da in g.darrays:
        arrays.append({
            "intent": int(da.intent),
            "encoding": ENC.get(int(da.encoding), int(da.encoding)),
            "endian": END.get(int(da.endian), int(da.endian)),
            "index_order": ORD.get(int(da.ind_ord), int(da.ind_ord)),
            "dtype": str(da.data.dtype),
            "shape": [int(v) for v in da.data.shape],
            "dataspace": None if da.coordsys is None else XFM.get(int(da.coordsys.dataspace)),
            "xformspace": None if da.coordsys is None else XFM.get(int(da.coordsys.xformspace)),
        })
    return {
        "path": os.path.relpath(path, ROOT),
        "bytes": os.path.getsize(path),
        "nodes": int(pts.shape[0]),
        "tris": int(tri.shape[0]),
        "arrays": arrays,
        "bbox_min": [round(float(v), 6) for v in pts.min(axis=0)],
        "bbox_max": [round(float(v), 6) for v in pts.max(axis=0)],
    }


def annot_summary(path):
    import nibabel as nib
    lab, ctab, names = nib.freesurfer.read_annot(path)
    return {
        "path": os.path.relpath(path, ROOT),
        "bytes": os.path.getsize(path),
        "nodes": int(lab.size),
        "n_labels": len(names),
        "label_min": int(lab.min()),
        "label_max": int(lab.max()),
        "colortable_shape": [int(v) for v in ctab.shape],
    }


def main():
    j = lambda *p: os.path.join(ROOT, *p)
    res = {"root": ROOT, "meshes": [], "surfaces": [], "annots": []}

    res["meshes"].append(mesh_summary(j("m2m_ernie", "ernie.msh")))
    res["meshes"].append(mesh_summary(j("Simulations", "Thalamus", "TI", "mesh", "Thalamus_TI.msh")))
    res["meshes"].append(mesh_summary(j("Simulations", "Thalamus", "TI", "mesh", "grey_Thalamus_TI.msh")))
    # 492 MB / 497 MB SEEG meshes: node counts only (tag census is expensive but cheap enough here).
    for p in (j("m2m_ernie", "ernie_seeg.msh"), j("m2m_ernie-seeg", "ernie-seeg.msh")):
        if os.path.exists(p):
            res["meshes"].append(mesh_summary(p, with_tags=True, with_fields=False, with_bbox=True))
    # Largest non-SEEG mesh (420 MB) and the only reference file with a vector field: the GlyphSpec /
    # component:0|1|2 / electrode-palette test case. The same file exists under every Simulations/*/;
    # L_Insula is the one AGENTS.md pins.
    p = j("Simulations", "L_Insula", "high_Frequency", "mesh", "ernie_TDCS_1_scalar.msh")
    if os.path.exists(p):
        res["meshes"].append(mesh_summary(p))

    for s in ("lh.central.gii", "lh.pial.gii"):
        res["surfaces"].append(gii_summary(j("m2m_ernie", "surfaces", s)))

    res["annots"] = [annot_summary(j("m2m_ernie", "segmentation", "lh.ernie_DK40.annot"))]

    json.dump(res, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
