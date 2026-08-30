#!/usr/bin/env python3
"""Generate Tetravox's synthetic test fixtures and their ground-truth manifest.

    python3 scripts/gen-fixtures.py [--outdir testdata] [--no-verify]
    python3 scripts/gen-fixtures.py --inspect <outdir> <json-out>   # internal, runs under simnibs_python

Requires only python3 + numpy + nibabel for the *writing* half.  The *verification*
half re-executes this file under `simnibs_python` (SimNIBS 4.6) so that every Gmsh
`.msh`, `.stl`, `.ply` and `.obj` number in the manifest comes from an independent
reader — `simnibs.mesh_io.read_msh` and the Gmsh 4.14 Python API — and never from
the writer above it.  NIfTI / GIfTI / FreeSurfer numbers come from nibabel, for the
same reason.  Set `TETRAVOX_SIMNIBS_PYTHON` to point at a different interpreter.

Gmsh 4.1 fixtures are *converted* by that same Gmsh, per ARCHITECTURE.md §6.2:
there is no local v4.1 reference implementation other than Gmsh itself, and SimNIBS
refuses v4.

Everything is deterministic: rerunning the script reproduces the fixtures byte for
byte (`SOURCE_DATE_EPOCH`-free — no timestamps are written anywhere, gzip is called
with `mtime=0`).

The output is `<outdir>/manifest.json`; ARCHITECTURE.md §11 and the Rust
`crates/*/tests/fixtures.rs` read it.  Total fixture payload is kept under 2 MB so
it can be committed.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import numpy as np
import nibabel as nib

SIMNIBS_PYTHON = os.environ.get(
    "TETRAVOX_SIMNIBS_PYTHON",
    "/Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python",
)

# NIfTI-1 single-file header offsets, little-endian (see scripts/refvalues/nifti_refvalues.py).
OFF_DATATYPE, OFF_PIXDIM, OFF_SCL_SLOPE = 70, 76, 112

# NIfTI datatype code -> the §4.3 / §6.5.1 `dtype` string.  Codes the contract rejects by
# name (complex64/128, int64, uint64) are deliberately absent.
DATATYPE_NAMES = {
    2: "u8", 4: "i16", 8: "i32", 16: "f32", 64: "f64",
    128: "rgb24", 256: "i8", 512: "u16", 768: "u32", 2304: "rgba32",
}


# --------------------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------------------


def w(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def gz(data: bytes) -> bytes:
    """Deterministic gzip: no mtime, no filename."""
    co = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
    return co.compress(data) + co.flush()


def f(x, n: int = 9):
    """Round a float for the manifest; keeps the JSON diffable."""
    v = float(x)
    if v != v:
        return "NaN"
    if v in (float("inf"), float("-inf")):
        return "Infinity" if v > 0 else "-Infinity"
    return round(v, n)


def fl(a, n: int = 9):
    return [f(x, n) for x in np.asarray(a).ravel().tolist()]


def mat(m, n: int = 9):
    return [[f(x, n) for x in row] for row in np.asarray(m, dtype=np.float64).tolist()]


def arr_stats(a: np.ndarray) -> dict:
    a = np.asarray(a, dtype=np.float64).ravel()
    finite = a[np.isfinite(a)]
    return {
        "n": int(a.size),
        "nFinite": int(finite.size),
        "min": f(finite.min()) if finite.size else None,
        "max": f(finite.max()) if finite.size else None,
        "mean": f(finite.mean()) if finite.size else None,
        "sum": f(finite.sum()) if finite.size else None,
    }


def quat_to_mat(b: float, c: float, d: float) -> np.ndarray:
    a = float(np.sqrt(max(0.0, 1.0 - (b * b + c * c + d * d))))
    return np.array(
        [
            [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
            [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
            [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - b * b - c * c],
        ],
        dtype=np.float64,
    )


# --------------------------------------------------------------------------------------
# NIfTI fixtures
# --------------------------------------------------------------------------------------

DIMS = (5, 4, 3)  # i fastest; deliberately anisotropic so an index transposition is visible

# A proper rotation (det +1) whose entries are exact in f32, so the qform round-trips
# exactly and the qfac test has a hard expected value.  Same shape as ernie's [DATA].
R_EXACT = np.array([[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64)

# A genuinely oblique rotation for the "sform and qform disagree" fixtures.
_th = np.deg2rad(30.0)
R_OBLIQUE = np.array(
    [
        [np.cos(_th), -np.sin(_th), 0.0],
        [np.sin(_th), np.cos(_th), 0.0],
        [0.0, 0.0, 1.0],
    ],
    dtype=np.float64,
) @ np.array(
    [[1.0, 0.0, 0.0], [0.0, np.cos(_th), -np.sin(_th)], [0.0, np.sin(_th), np.cos(_th)]],
    dtype=np.float64,
)

SPACING = (1.5, 2.0, 3.0)
ORIGIN = (-7.25, 11.5, -3.75)


def affine_from(rot: np.ndarray, spacing=SPACING, origin=ORIGIN, qfac: float = 1.0) -> np.ndarray:
    m = np.eye(4, dtype=np.float64)
    m[:3, 0] = rot[:, 0] * spacing[0]
    m[:3, 1] = rot[:, 1] * spacing[1]
    m[:3, 2] = rot[:, 2] * spacing[2] * qfac
    m[:3, 3] = origin
    return m


def ramp(dims, nvols=1, dtype=np.uint8):
    """Deterministic content, chosen per dtype so every fixture spans a sane range.

    `base = i + 10*j + 100*k + 1000*t` (0..234 for a 5x4x3 volume, i fastest), then:
    unsigned integers store `base * SCALE[dtype]`, signed integers store the same
    biased to straddle zero, and floats store `base * 0.25 - 3.5`.
    """
    nx, ny, nz = dims
    i, j, k = np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing="ij")
    base = (i + 10 * j + 100 * k).astype(np.int64)
    if nvols > 1:
        base = np.stack([base + 1000 * t for t in range(nvols)], axis=-1)
    dt = np.dtype(dtype)
    if dt in (np.dtype(np.float32), np.dtype(np.float64)):
        a = base.astype(np.float64) * 0.25 - 3.5
    elif dt == np.dtype(np.uint8):
        a = base % 256
    elif dt == np.dtype(np.int8):
        a = (base % 235) - 117
    elif dt == np.dtype(np.uint16):
        a = base * 100
    elif dt == np.dtype(np.int16):
        a = base * 100 - 11700
    elif dt == np.dtype(np.uint32):
        a = base * 1000
    elif dt == np.dtype(np.int32):
        a = base * 1000 - 117000
    else:
        raise ValueError(dt)
    return np.ascontiguousarray(a.astype(dt))


SPOTS = [(0, 0, 0), (4, 0, 0), (0, 3, 0), (0, 0, 2), (2, 1, 1), (4, 3, 2), (3, 2, 0), (1, 1, 2)]


def write_nifti(
    path: Path, arr, affine, *, klass=nib.Nifti1Image, gzip_it=False, tweak=None, scl=None
):
    """Write a single-file NIfTI.

    `scl=(slope, inter)` is patched into the header bytes AFTER serialisation.  Handing
    a slope to nibabel instead would make it rescale the samples on write, so the raw
    on-disk data would no longer be the array passed in — the opposite of what §6.1's
    "scaling is never folded" fixture needs to test.
    """
    import io

    img = klass(np.asanyarray(arr), np.asarray(affine, dtype=np.float64))
    hdr = img.header
    hdr.set_sform(np.asarray(affine, dtype=np.float64), code=2)
    hdr.set_qform(np.asarray(affine, dtype=np.float64), code=2)
    if tweak is not None:
        tweak(img)
    fh = nib.FileHolder(fileobj=io.BytesIO())
    img.to_file_map({"header": fh, "image": fh})
    raw = bytearray(fh.fileobj.getvalue())
    if scl is not None:
        assert klass is nib.Nifti1Image, "scl patching is NIfTI-1 only"
        raw[OFF_SCL_SLOPE : OFF_SCL_SLOPE + 8] = struct.pack("<2f", *scl)
    raw = bytes(raw)
    if gzip_it:
        raw = gz(raw)
    w(path, raw)
    return raw



# --------------------------------------------------------------------------------------
# MGH / NRRD / MetaImage fixtures — the "other voxel formats" of §6.1
# --------------------------------------------------------------------------------------

NUMPY_DTYPE_NAMES = {
    "uint8": "u8", "int8": "i8", "uint16": "u16", "int16": "i16", "uint32": "u32",
    "int32": "i32", "float32": "f32", "float64": "f64",
}

# NRRD `type` spellings and MetaImage `ElementType`s, per numpy dtype.
NRRD_TYPES = {
    "uint8": "uchar", "int8": "signed char", "uint16": "ushort", "int16": "short",
    "uint32": "uint", "int32": "int", "float32": "float", "float64": "double",
}
MET_TYPES = {
    "uint8": "MET_UCHAR", "int8": "MET_CHAR", "uint16": "MET_USHORT", "int16": "MET_SHORT",
    "uint32": "MET_UINT", "int32": "MET_INT", "float32": "MET_FLOAT", "float64": "MET_DOUBLE",
}


def write_mgh(path: Path, arr, affine, *, gzip_it=False):
    """FreeSurfer MGH through nibabel, serialised to bytes so the .mgz gzip is deterministic."""
    import io

    img = nib.MGHImage(np.asanyarray(arr), np.asarray(affine, dtype=np.float64))
    fh = nib.FileHolder(fileobj=io.BytesIO())
    img.to_file_map({"image": fh})
    raw = fh.fileobj.getvalue()
    if gzip_it:
        raw = gz(raw)
    w(path, raw)
    return raw


def _ras_to_lps(affine: np.ndarray) -> np.ndarray:
    """The affine an LPS writer must store so that an LPS→RAS reader recovers `affine`."""
    m = np.asarray(affine, dtype=np.float64).copy()
    m[0, :] *= -1
    m[1, :] *= -1
    return m


def write_nrrd(
    path: Path, arr, affine, *, encoding="raw", space="left-posterior-superior",
    kinds=None, content="tetravox fixture", endian="little",
):
    """A hand-written attached-header NRRD.  `arr` is (nx, ny, nz[, nvols]) with i fastest —
    NRRD's first `sizes` axis is the fastest — so the samples are `arr.tobytes(order="F")`.
    The affine is RAS (what the reader must produce); it is written in `space`, so an LPS
    file stores the x/y-negated matrix.  A 4D array puts `nvols` on a trailing `list` axis."""
    arr = np.asarray(arr)
    dims = list(arr.shape)
    ndim = len(dims)
    stored = _ras_to_lps(affine) if space.startswith("left-posterior") else np.asarray(affine)
    dirs = " ".join(
        "(" + ",".join(repr(float(v)) for v in stored[:3, a]) + ")" for a in range(3)
    )
    if ndim == 4:
        dirs += " none"
        kinds = kinds or "domain domain domain list"
    else:
        kinds = kinds or "domain domain domain"
    origin = "(" + ",".join(repr(float(v)) for v in stored[:3, 3]) + ")"
    lines = [
        "NRRD0004",
        "# tetravox synthetic fixture (scripts/gen-fixtures.py)",
        f"content: {content}",
        f"type: {NRRD_TYPES[arr.dtype.name]}",
        f"dimension: {ndim}",
        f"space: {space}",
        "sizes: " + " ".join(str(d) for d in dims),
        f"space directions: {dirs}",
        f"kinds: {kinds}",
        f"encoding: {encoding}",
        f"space origin: {origin}",
        'space units: "mm" "mm" "mm"',
    ]
    if encoding != "ascii":
        lines.insert(9, f"endian: {endian}")
    header = ("\n".join(lines) + "\n\n").encode("ascii")
    flat = arr.ravel(order="F")
    if encoding == "raw":
        data = flat.astype(arr.dtype.newbyteorder("<" if endian == "little" else ">")).tobytes()
    elif encoding == "gzip":
        data = gz(flat.astype(arr.dtype.newbyteorder("<" if endian == "little" else ">")).tobytes())
    elif encoding == "ascii":
        fmt = (lambda v: repr(float(v))) if arr.dtype.kind == "f" else (lambda v: str(int(v)))
        rows = [" ".join(fmt(v) for v in flat[i : i + 16]) for i in range(0, flat.size, 16)]
        data = ("\n".join(rows) + "\n").encode("ascii")
    else:
        raise ValueError(encoding)
    w(path, header + data)


def write_mha(path: Path, arr, affine, *, compressed=False, channels=1, msb=False):
    """A hand-written attached-header MetaImage.  `arr` is (nx, ny, nz[, nvols]) i-fastest for
    scalars, or (nx, ny, nz, channels) for a multi-channel image (channel fastest on disk).
    MetaImage is LPS, so the RAS `affine` is x/y-negated on the way in; `TransformMatrix`
    stores the per-axis direction vectors consecutively (the direction matrix column-major),
    which is what ITK writes and reads."""
    arr = np.asarray(arr)
    if channels > 1:
        assert arr.shape[-1] == channels
        dims = list(arr.shape[:-1])
        flat = np.moveaxis(arr, -1, 0).ravel(order="F")
    else:
        dims = list(arr.shape)
        flat = arr.ravel(order="F")
    ndim = len(dims)
    lps = _ras_to_lps(affine)
    spacing = np.linalg.norm(lps[:3, :3], axis=0)
    direction = lps[:3, :3] / spacing
    if ndim == 4:
        spacing = np.append(spacing, 1.0)
        d4 = np.eye(4)
        d4[:3, :3] = direction
        direction = d4
        offset = np.append(lps[:3, 3], 0.0)
    else:
        offset = lps[:3, 3]
    # column-major: axis a's direction vector is direction[:, a]
    tm = " ".join(repr(float(direction[r, a])) for a in range(ndim) for r in range(ndim))
    data = flat.astype(arr.dtype.newbyteorder(">" if msb else "<")).tobytes()
    lines = [
        "ObjectType = Image",
        f"NDims = {ndim}",
        "BinaryData = True",
        f"BinaryDataByteOrderMSB = {'True' if msb else 'False'}",
        f"CompressedData = {'True' if compressed else 'False'}",
    ]
    if compressed:
        data = zlib.compress(data, 9)
        lines.append(f"CompressedDataSize = {len(data)}")
    lines += [
        f"TransformMatrix = {tm}",
        "Offset = " + " ".join(repr(float(v)) for v in offset),
        "CenterOfRotation = " + " ".join("0" for _ in range(ndim)),
        "AnatomicalOrientation = RAI",
        "ElementSpacing = " + " ".join(repr(float(v)) for v in spacing),
        "DimSize = " + " ".join(str(d) for d in dims),
    ]
    if channels > 1:
        lines.append(f"ElementNumberOfChannels = {channels}")
    lines += [f"ElementType = {MET_TYPES[arr.dtype.name]}", "ElementDataFile = LOCAL"]
    header = ("\n".join(lines) + "\n").encode("ascii")
    w(path, header + data)

# --------------------------------------------------------------------------------------
# the tet mesh: a 2x2x2 lattice of unit cubes, each split into 6 tets
# --------------------------------------------------------------------------------------

CUBE_TETS = [
    (0, 1, 2, 6),
    (0, 2, 3, 6),
    (0, 3, 7, 6),
    (0, 7, 4, 6),
    (0, 4, 5, 6),
    (0, 5, 1, 6),
]
TET_FACES = [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)]  # outward for a positive-volume tet


def build_lattice(n=2, step=10.0, origin=(-10.0, -10.0, -10.0)):
    """Return (nodes, tets, tet_tags, tris, tri_tags).

    Tags: tets with centroid z < mid -> 1, else 2.  Exterior tri of a tag-t tet -> 1000+t;
    the tag-differing interior interface -> 1002.  That is the SimNIBS convention
    (surface tag `1xxx` mirrors volume tag `xxx`, §6.2).
    """
    ax = [origin[0] + step * t for t in range(n + 1)]
    ay = [origin[1] + step * t for t in range(n + 1)]
    az = [origin[2] + step * t for t in range(n + 1)]
    nid = {}
    nodes = []
    for k in range(n + 1):
        for j in range(n + 1):
            for i in range(n + 1):
                nid[(i, j, k)] = len(nodes)
                nodes.append((ax[i], ay[j], az[k]))
    nodes = np.array(nodes, dtype=np.float64)

    mid = origin[2] + step * n / 2.0
    tets, tags = [], []
    for k in range(n):
        for j in range(n):
            for i in range(n):
                corner = [
                    nid[(i, j, k)],
                    nid[(i + 1, j, k)],
                    nid[(i + 1, j + 1, k)],
                    nid[(i, j + 1, k)],
                    nid[(i, j, k + 1)],
                    nid[(i + 1, j, k + 1)],
                    nid[(i + 1, j + 1, k + 1)],
                    nid[(i, j + 1, k + 1)],
                ]
                for t in CUBE_TETS:
                    tet = [corner[c] for c in t]
                    p = nodes[tet]
                    vol = np.dot(np.cross(p[1] - p[0], p[2] - p[0]), p[3] - p[0])
                    if vol < 0:
                        tet[2], tet[3] = tet[3], tet[2]
                    tets.append(tet)
                    tags.append(1 if nodes[tet].mean(axis=0)[2] < mid else 2)
    tets = np.array(tets, dtype=np.int64)
    tet_tags = np.array(tags, dtype=np.int64)

    # exterior faces + tag-differing interior faces (the §6.3 surface invariant)
    owners: dict[tuple, list[tuple[int, tuple]]] = {}
    for ti, tet in enumerate(tets):
        for fa in TET_FACES:
            face = (tet[fa[0]], tet[fa[1]], tet[fa[2]])
            owners.setdefault(tuple(sorted(face)), []).append((ti, face))
    tris, tri_tags = [], []
    n_exterior = n_interface = 0
    for key in sorted(owners):
        lst = owners[key]
        if len(lst) == 1:
            ti, face = lst[0]
            tris.append(face)
            tri_tags.append(1000 + int(tet_tags[ti]))
            n_exterior += 1
        elif len(lst) == 2 and tet_tags[lst[0][0]] != tet_tags[lst[1][0]]:
            lo = lst[0] if tet_tags[lst[0][0]] < tet_tags[lst[1][0]] else lst[1]
            tris.append(lo[1])
            tri_tags.append(1000 + int(max(tet_tags[lst[0][0]], tet_tags[lst[1][0]])))
            n_interface += 1
    tris = np.array(tris, dtype=np.int64)
    tri_tags = np.array(tri_tags, dtype=np.int64)
    return nodes, tets, tet_tags, tris, tri_tags, n_exterior, n_interface


def mesh_fields(nodes, tris, tets):
    """Deterministic node and element fields."""
    nn, ntri, ntet = len(nodes), len(tris), len(tets)
    node_scalar = (nodes[:, 0] * 0.1 + nodes[:, 1] * 0.01 + nodes[:, 2] * 0.001).astype(np.float64)
    node_vector = np.stack(
        [nodes[:, 0] * 0.5, nodes[:, 1] * -0.25, nodes[:, 2] * 0.125], axis=1
    ).astype(np.float64)
    ne = ntri + ntet
    elm_scalar = (np.arange(ne, dtype=np.float64) * 0.5 - 3.0).astype(np.float64)
    elm_vector = np.stack(
        [
            np.arange(ne, dtype=np.float64) * 0.25,
            np.arange(ne, dtype=np.float64) * -0.125 + 1.0,
            np.full(ne, 2.5),
        ],
        axis=1,
    )
    return {
        "node_scalar": (1, node_scalar.reshape(nn, 1)),
        "node_vector": (3, node_vector),
        "elm_scalar": (1, elm_scalar.reshape(ne, 1)),
        "E": (3, elm_vector),
    }


PHYSICAL_NAMES = [
    (3, 1, "Tissue_A"),
    (3, 2, "Tissue_B"),
    (2, 1001, "Tissue_A_surface"),
    (2, 1002, "Tissue_B_surface"),
]


# --------------------------------------------------------------------------------------
# Gmsh .msh v2.2 writers  (SimNIBS's dialect: "2.2 1 8", i32 id + 3xf64, 2 element tags)
# --------------------------------------------------------------------------------------


def _phys_block(names):
    if not names:
        return ""
    out = ["$PhysicalNames", str(len(names))]
    out += [f'{d} {t} "{n}"' for d, t, n in names]
    out.append("$EndPhysicalNames")
    return "\n".join(out) + "\n"


def _data_tags_ascii(name, ncomp, nrec, time_step=0):
    return (
        "1\n"
        f'"{name}"\n'
        "1\n"
        "0.0\n"
        "4\n"
        f"{time_step}\n{ncomp}\n{nrec}\n0\n"
    )


def write_msh_v2_ascii(
    path: Path, nodes, tris, tri_tags, tets, tet_tags, fields, names=PHYSICAL_NAMES,
    node_numbers=None, elm_numbers=None, field_ids=None,
):
    nn = len(nodes)
    node_numbers = np.arange(1, nn + 1) if node_numbers is None else np.asarray(node_numbers)
    ne = len(tris) + len(tets)
    elm_numbers = np.arange(1, ne + 1) if elm_numbers is None else np.asarray(elm_numbers)

    s = ["$MeshFormat", "2.2 0 8", "$EndMeshFormat"]
    out = "\n".join(s) + "\n" + _phys_block(names)
    out += "$Nodes\n%d\n" % nn
    for i in range(nn):
        x, y, z = nodes[i]
        out += "%d %.17g %.17g %.17g\n" % (node_numbers[i], x, y, z)
    out += "$EndNodes\n$Elements\n%d\n" % ne
    for i, tri in enumerate(tris):
        out += "%d 2 2 %d %d %d %d %d\n" % (
            elm_numbers[i], tri_tags[i], tri_tags[i],
            node_numbers[tri[0]], node_numbers[tri[1]], node_numbers[tri[2]],
        )
    for i, tet in enumerate(tets):
        e = i + len(tris)
        out += "%d 4 2 %d %d %d %d %d %d\n" % (
            elm_numbers[e], tet_tags[i], tet_tags[i],
            node_numbers[tet[0]], node_numbers[tet[1]], node_numbers[tet[2]], node_numbers[tet[3]],
        )
    out += "$EndElements\n"

    for name, (ncomp, data) in fields.items():
        is_node = name.startswith("node")
        ids = node_numbers if is_node else elm_numbers
        if field_ids is not None and name in field_ids:
            ids, data = field_ids[name]
        sec = "NodeData" if is_node else "ElementData"
        out += f"${sec}\n" + _data_tags_ascii(name, ncomp, len(ids))
        for idx in range(len(ids)):
            vals = " ".join("%.17g" % v for v in np.atleast_1d(data[idx]))
            out += "%d %s\n" % (ids[idx], vals)
        out += f"$End{sec}\n"
    w(path, out.encode("ascii"))
    return out.encode("ascii")


def write_msh_v2_binary(
    path: Path, nodes, tris, tri_tags, tets, tet_tags, fields, names=PHYSICAL_NAMES,
    node_numbers=None, elm_numbers=None,
):
    nn = len(nodes)
    node_numbers = np.arange(1, nn + 1) if node_numbers is None else np.asarray(node_numbers)
    ne = len(tris) + len(tets)
    elm_numbers = np.arange(1, ne + 1) if elm_numbers is None else np.asarray(elm_numbers)

    buf = bytearray()
    buf += b"$MeshFormat\n2.2 1 8\n"
    buf += struct.pack("<i", 1)
    buf += b"\n$EndMeshFormat\n"
    buf += _phys_block(names).encode("ascii")

    buf += b"$Nodes\n%d\n" % nn
    for i in range(nn):
        buf += struct.pack("<i3d", int(node_numbers[i]), *[float(v) for v in nodes[i]])
    buf += b"$EndNodes\n"

    buf += b"$Elements\n%d\n" % ne
    # tris first, then tets — one block each, 2 tags each (§6.2)
    buf += struct.pack("<3i", 2, len(tris), 2)
    for i, tri in enumerate(tris):
        buf += struct.pack(
            "<6i", int(elm_numbers[i]), int(tri_tags[i]), int(tri_tags[i]),
            int(node_numbers[tri[0]]), int(node_numbers[tri[1]]), int(node_numbers[tri[2]]),
        )
    buf += struct.pack("<3i", 4, len(tets), 2)
    for i, tet in enumerate(tets):
        e = i + len(tris)
        buf += struct.pack(
            "<7i", int(elm_numbers[e]), int(tet_tags[i]), int(tet_tags[i]),
            int(node_numbers[tet[0]]), int(node_numbers[tet[1]]),
            int(node_numbers[tet[2]]), int(node_numbers[tet[3]]),
        )
    buf += b"$EndElements\n"

    for name, (ncomp, data) in fields.items():
        is_node = name.startswith("node")
        ids = node_numbers if is_node else elm_numbers
        sec = b"NodeData" if is_node else b"ElementData"
        buf += b"$" + sec + b"\n" + _data_tags_ascii(name, ncomp, len(ids)).encode("ascii")
        for idx in range(len(ids)):
            vals = [float(v) for v in np.atleast_1d(data[idx])]
            buf += struct.pack("<i%dd" % ncomp, int(ids[idx]), *vals)
        buf += b"$End" + sec + b"\n"
    w(path, bytes(buf))
    return bytes(buf)


MSH_OPT = """// Visualization File Created by SimNIBS
Physical Volume (" Tissue_A",1) = { 1 };
Physical Volume (" Tissue_B",2) = { 2 };
Physical Surface (" Tissue_A",1001) = { 1001 };
Physical Surface (" Tissue_B",1002) = { 1002 };
General.Color.Background = White;
General.Color.Foreground = Black;
General.BackgroundGradient = 0;
General.RotationX = 291.7866150042338;
General.RotationY = 359.3666166267545;
General.RotationZ = 153.1795186816626;
General.VectorType = 1;
General.SmallAxes = 1;
Mesh.AngleSmoothNormals = 180;
Mesh.SmoothNormals = 1;
Mesh.SurfaceEdges = 0;
Mesh.SurfaceFaces = 1;
Mesh.VolumeEdges = 0;
Mesh.VolumeFaces = 0;
Mesh.Color.One = {230, 230, 210};
Mesh.Color.Two = {129, 129, 129};
Mesh.Color.Three = {104, 163, 255};
View[0].CenterGlyphs = 1;
View[0].GlyphLocation = 1;
View[0].VectorType = 1;
View[0].Visible = 1;
View[0].CustomMax = 3.5;
View[0].CustomMin = -1.5;
View[0].SaturateValues = 1;
View[0].RangeType = 2;
View[0].ShowScale = 1;
View[0].ColormapNumber = 2;
Hide "*";
Show {
Volume{2};
Surface{1002};
Curve{1002};
Point{1002};
}
"""

# What read_msh_opt (§6.2) must produce from MSH_OPT. There is no third-party parser for
# `.msh.opt` that yields this structure -- Gmsh applies the file as options rather than
# reporting a tag->colour map -- so this expectation is AUTHORED from the file above and
# from §6.2's rules: `Mesh.Color.<Ordinal>` keys the physical tag of the same ordinal, a
# surface tag `1xxx` inherits volume tag `xxx`'s colour, and `Hide "*"` + `Show {...}`
# decides visibility. Gmsh is still used to prove the file PARSES (see inspect_meshes).
MSH_OPT_EXPECTED = {
    "tagColor": {
        "1": [230, 230, 210, 255],
        "2": [129, 129, 129, 255],
        "1001": [230, 230, 210, 255],
        "1002": [129, 129, 129, 255],
    },
    "tagVisible": {"1": False, "2": True, "1001": False, "1002": True},
    "tagName": {
        "1": " Tissue_A",
        "2": " Tissue_B",
        "1001": " Tissue_A",
        "1002": " Tissue_B",
    },
    "views": [
        {
            "name": None,
            "customMin": -1.5,
            "customMax": 3.5,
            "rangeType": 2,
            "saturateValues": True,
            "colormapNumber": 2,
            "showScale": True,
            "vectorType": 1,
        }
    ],
}

MESH_LUT_SIMNIBS = """#No.\tLabel Name:\t\t\t\tR\tG\tB\tA
1\tTissue_A\t\t\t\t230\t230\t210\t255
2\tTissue_B\t\t\t\t129\t129\t129\t255
1001\tTissue_A_surface\t\t\t104\t163\t255\t255
1002\tTissue_B_surface\t\t\t255\t239\t179\t255
"""


# --------------------------------------------------------------------------------------
# GIfTI / FreeSurfer / STL / PLY / OBJ
# --------------------------------------------------------------------------------------


def surface_patch():
    """A small open triangulated patch: a 4x4 grid of vertices, 18 triangles."""
    n = 4
    xs = np.linspace(-30.0, 30.0, n)
    ys = np.linspace(-20.0, 20.0, n)
    verts, quads = [], []
    for j in range(n):
        for i in range(n):
            x, y = xs[i], ys[j]
            z = 5.0 * np.cos(np.pi * i / (n - 1)) + 2.0 * np.sin(np.pi * j / (n - 1))
            verts.append((x, y, round(float(z), 6)))
    for j in range(n - 1):
        for i in range(n - 1):
            a = j * n + i
            quads.append((a, a + 1, a + n + 1, a + n))
    tris = []
    for a, b, c, d in quads:
        tris.append((a, b, c))
        tris.append((a, c, d))
    return np.array(verts, dtype=np.float64), np.array(tris, dtype=np.int32), np.array(
        quads, dtype=np.int32
    )


GIFTI_XFORM = np.array(
    [[1.0, 0.0, 0.0, 2.5], [0.0, 1.0, 0.0, -4.0], [0.0, 0.0, 1.0, 7.25], [0.0, 0.0, 0.0, 1.0]],
    dtype=np.float64,
)


def write_gifti_surface(path: Path, verts, tris, encoding):
    coord = nib.gifti.GiftiCoordSystem(dataspace=0, xformspace=1, xform=GIFTI_XFORM)  # UNKNOWN->SCANNER_ANAT
    da_p = nib.gifti.GiftiDataArray(
        np.ascontiguousarray(verts, dtype=np.float32),
        intent="NIFTI_INTENT_POINTSET",
        datatype="NIFTI_TYPE_FLOAT32",
        encoding=encoding,
        endian="little",
        coordsys=coord,
    )
    da_t = nib.gifti.GiftiDataArray(
        np.ascontiguousarray(tris, dtype=np.int32),
        intent="NIFTI_INTENT_TRIANGLE",
        datatype="NIFTI_TYPE_INT32",
        encoding=encoding,
        endian="little",
        coordsys=None,
    )
    img = nib.gifti.GiftiImage(darrays=[da_p, da_t])
    w(path, img.to_bytes())


def write_gifti_func(path: Path, values):
    da = nib.gifti.GiftiDataArray(
        np.ascontiguousarray(values, dtype=np.float32),
        intent="NIFTI_INTENT_SHAPE",
        datatype="NIFTI_TYPE_FLOAT32",
        encoding="GZipBase64Binary",
        endian="little",
    )
    w(path, nib.gifti.GiftiImage(darrays=[da]).to_bytes())


GIFTI_LABELS = [
    (0, "Unknown", (0.0, 0.0, 0.0, 0.0)),
    (3, "Alpha", (1.0, 0.0, 0.0, 1.0)),
    (7, "Beta", (0.0, 0.5019607843137255, 0.0, 1.0)),
    (11, "Gamma", (0.0, 0.0, 1.0, 1.0)),
]


def write_gifti_label(path: Path, keys):
    lt = nib.gifti.GiftiLabelTable()
    for key, name, (r, g, b, a) in GIFTI_LABELS:
        lab = nib.gifti.GiftiLabel(key=key, red=r, green=g, blue=b, alpha=a)
        lab.label = name
        lt.labels.append(lab)
    da = nib.gifti.GiftiDataArray(
        np.ascontiguousarray(keys, dtype=np.int32),
        intent="NIFTI_INTENT_LABEL",
        datatype="NIFTI_TYPE_INT32",
        encoding="GZipBase64Binary",
        endian="little",
    )
    img = nib.gifti.GiftiImage(darrays=[da], labeltable=lt)
    w(path, img.to_bytes())


def write_gifti_labelled_surface(path: Path, verts, tris, keys):
    """A GIfTI carrying **geometry and a `<LabelTable>` in one file**.

    `surf.label.gii` is deliberately data-only — it is the "a `.label.gii` is not a surface" case —
    so nothing in `testdata/` could exercise `MeshLayer.colorMode:'label'`, which needs a mesh that
    has both a node label array and triangles to paint.  §6.2 keys `MeshMeta.labelTables` by node-
    field name, and `tvx-mesh-io` names a GIfTI array from its `Name` metadata falling back to the
    short intent, so the label array's field name here is `label`.

    `keys` is chosen (see the caller) so that four of the patch's eighteen triangles have all three
    vertices in one label: `vLabelColor` is an interpolated varying, so only a monochrome triangle
    has a closed-form colour, and those four are what §11's analytic assertion can stand on.
    """
    coord = nib.gifti.GiftiCoordSystem(dataspace=0, xformspace=1, xform=GIFTI_XFORM)
    da_p = nib.gifti.GiftiDataArray(
        np.ascontiguousarray(verts, dtype=np.float32),
        intent="NIFTI_INTENT_POINTSET",
        datatype="NIFTI_TYPE_FLOAT32",
        encoding="GZipBase64Binary",
        endian="little",
        coordsys=coord,
    )
    da_t = nib.gifti.GiftiDataArray(
        np.ascontiguousarray(tris, dtype=np.int32),
        intent="NIFTI_INTENT_TRIANGLE",
        datatype="NIFTI_TYPE_INT32",
        encoding="GZipBase64Binary",
        endian="little",
    )
    da_l = nib.gifti.GiftiDataArray(
        np.ascontiguousarray(keys, dtype=np.int32),
        intent="NIFTI_INTENT_LABEL",
        datatype="NIFTI_TYPE_INT32",
        encoding="GZipBase64Binary",
        endian="little",
    )
    lt = nib.gifti.GiftiLabelTable()
    for key, name, (r, g, b, a) in GIFTI_LABELS:
        lab = nib.gifti.GiftiLabel(key=key, red=r, green=g, blue=b, alpha=a)
        lab.label = name
        lt.labels.append(lab)
    img = nib.gifti.GiftiImage(darrays=[da_p, da_t, da_l], labeltable=lt)
    w(path, img.to_bytes())


def write_stl_ascii(path: Path, verts, tris, name="tetravox"):
    out = [f"solid {name}"]
    for t in tris:
        p = verts[list(t)]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        ln = np.linalg.norm(n)
        n = n / ln if ln > 0 else n
        out.append("  facet normal %.9g %.9g %.9g" % tuple(n))
        out.append("    outer loop")
        for v in p:
            out.append("      vertex %.9g %.9g %.9g" % tuple(v))
        out.append("    endloop")
        out.append("  endfacet")
    out.append(f"endsolid {name}")
    w(path, ("\n".join(out) + "\n").encode("ascii"))


def write_stl_binary(path: Path, verts, tris):
    buf = bytearray(b"tetravox binary stl fixture".ljust(80, b" "))
    buf += struct.pack("<I", len(tris))
    for t in tris:
        p = verts[list(t)]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        ln = np.linalg.norm(n)
        n = n / ln if ln > 0 else n
        buf += struct.pack("<3f", *[float(x) for x in n])
        for v in p:
            buf += struct.pack("<3f", *[float(x) for x in v])
        buf += struct.pack("<H", 0)
    w(path, bytes(buf))


def _ply_header(nv, nf, fmt):
    return (
        "ply\n"
        f"format {fmt} 1.0\n"
        "comment tetravox fixture\n"
        f"element vertex {nv}\n"
        "property float x\nproperty float y\nproperty float z\n"
        f"element face {nf}\n"
        "property list uchar int vertex_indices\n"
        "end_header\n"
    ).encode("ascii")


def write_ply_ascii(path: Path, verts, faces):
    out = _ply_header(len(verts), len(faces), "ascii").decode()
    for v in verts:
        out += "%.9g %.9g %.9g\n" % tuple(v)
    for fc in faces:
        out += "%d %s\n" % (len(fc), " ".join(str(int(i)) for i in fc))
    w(path, out.encode("ascii"))


def write_ply_binary(path: Path, verts, faces):
    buf = bytearray(_ply_header(len(verts), len(faces), "binary_little_endian"))
    for v in verts:
        buf += struct.pack("<3f", *[float(x) for x in v])
    for fc in faces:
        buf += struct.pack("<B", len(fc)) + struct.pack("<%di" % len(fc), *[int(i) for i in fc])
    w(path, bytes(buf))


def write_obj(path: Path, verts, faces):
    out = "# tetravox fixture\n"
    for v in verts:
        out += "v %.9g %.9g %.9g\n" % tuple(v)
    for fc in faces:
        out += "f %s\n" % " ".join(str(int(i) + 1) for i in fc)
    w(path, out.encode("ascii"))


FS_LUT = """# Tetravox fixture LUT - FreeSurferColorLUT.txt format
#No. Label Name:                            R   G   B   A

  0  Unknown                                 0   0   0   0
  3  Alpha                                 255   0   0   0
  7  Beta                                    0 128   0   0
 11  Gamma                                   0   0 255   0
 42  Delta                                 220 190  20   0
"""

VOL_LUT_SIMNIBS = """#No.\tLabel Name:\t\t\t\tR\tG\tB\tA
0\tUnknown\t\t\t\t\t0\t0\t0\t0
1\tWM\t\t\t\t\t230\t230\t210\t255
2\tGM\t\t\t\t\t129\t129\t129\t255
3\tCSF\t\t\t\t\t104\t163\t255\t255
5\tScalp\t\t\t\t\t255\t239\t179\t255
10\tMuscle\t\t\t\t\t255\t166\t133\t255
530\tDeep_label\t\t\t\t20\t180\t90\t255
"""


# --------------------------------------------------------------------------------------
# generation
# --------------------------------------------------------------------------------------


def generate(out: Path) -> dict:
    """Write every fixture. Returns a dict of *writer-side* notes (never ground truth)."""
    out.mkdir(parents=True, exist_ok=True)
    notes: dict = {}

    # ---------------- NIfTI ----------------
    aff_ob = affine_from(R_OBLIQUE)
    aff_ex = affine_from(R_EXACT)
    aff_qfac = affine_from(R_EXACT, qfac=-1.0)

    dt_cases = [
        ("vol_u8", np.uint8, False),
        ("vol_i8", np.int8, False),
        ("vol_u16", np.uint16, False),
        ("vol_i16", np.int16, True),
        ("vol_u32", np.uint32, False),
        ("vol_i32", np.int32, True),
        ("vol_f32", np.float32, True),
        ("vol_f64", np.float64, False),
    ]
    for name, dt, gzip_it in dt_cases:
        arr = ramp(DIMS, dtype=dt)
        ext = ".nii.gz" if gzip_it else ".nii"
        write_nifti(out / f"{name}{ext}", arr, aff_ob, gzip_it=gzip_it)

    # both .nii and .nii.gz of identical content, for the magic-sniff test
    a8 = ramp(DIMS, dtype=np.uint8)
    write_nifti(out / "vol_u8.nii.gz", a8, aff_ob, gzip_it=True)

    # RGB24 / RGBA32
    rgb = np.zeros(DIMS + (3,), dtype=np.uint8)
    rgb[..., 0] = ramp(DIMS, dtype=np.uint8)
    rgb[..., 1] = 255 - ramp(DIMS, dtype=np.uint8)
    rgb[..., 2] = 64
    write_nifti(
        out / "vol_rgb24.nii",
        rgb.view(dtype=np.dtype([("R", "u1"), ("G", "u1"), ("B", "u1")])).reshape(DIMS),
        aff_ob,
    )
    rgba = np.zeros(DIMS + (4,), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = 200
    write_nifti(
        out / "vol_rgba32.nii",
        rgba.view(
            dtype=np.dtype([("R", "u1"), ("G", "u1"), ("B", "u1"), ("A", "u1")])
        ).reshape(DIMS),
        aff_ob,
    )

    # qfac = -1, sform_code = 0 — the only case that catches a missing qfac (§3, ROADMAP)
    def _no_sform(img):
        img.header.set_sform(None, code=0)
        img.header.set_qform(aff_qfac, code=1)

    write_nifti(out / "vol_qfac_neg.nii", ramp(DIMS, dtype=np.int16), aff_qfac, tweak=_no_sform)

    # scl_slope / scl_inter — physical = raw*2.5 - 100, never folded into the samples (§6.1)
    write_nifti(out / "vol_scl.nii", ramp(DIMS, dtype=np.int16), aff_ob, scl=(2.5, -100.0))

    # scl_slope = NaN — the §6.1 guard; no real reference file exercises it
    write_nifti(
        out / "vol_scl_nan.nii", ramp(DIMS, dtype=np.int16), aff_ob,
        scl=(float("nan"), float("nan")),
    )

    # big-endian
    be = nib.Nifti1Image(ramp(DIMS, dtype=np.int16), aff_ob)
    be.header.set_sform(aff_ob, code=2)
    be.header.set_qform(aff_ob, code=2)
    beh = be.header.as_byteswapped(">")
    be = nib.Nifti1Image(ramp(DIMS, dtype=np.int16), aff_ob, beh)
    import io

    fh = nib.FileHolder(fileobj=io.BytesIO())
    be.to_file_map({"header": fh, "image": fh})
    w(out / "vol_bigendian.nii", fh.fileobj.getvalue())

    # NIfTI-2
    write_nifti(
        out / "vol_nifti2.nii",
        ramp(DIMS, dtype=np.float32),
        aff_ob,
        klass=nib.Nifti2Image,
    )

    # 4D
    write_nifti(out / "vol_4d.nii.gz", ramp(DIMS, nvols=3, dtype=np.float32), aff_ob, gzip_it=True)

    # label volumes + sidecar LUTs
    lab_ids = np.array([0, 1, 2, 3, 5, 10, 530], dtype=np.int64)
    lab = lab_ids[(ramp(DIMS, dtype=np.uint8).astype(np.int64) % len(lab_ids))]
    write_nifti(out / "labels_simnibs.nii.gz", lab.astype(np.uint16), aff_ob, gzip_it=True)
    w(out / "labels_simnibs_LUT.txt", VOL_LUT_SIMNIBS.encode("ascii"))

    fs_ids = np.array([0, 3, 7, 11, 42], dtype=np.int64)
    labfs = fs_ids[(ramp(DIMS, dtype=np.uint8).astype(np.int64) % len(fs_ids))]
    write_nifti(out / "labels_freesurfer.nii.gz", labfs.astype(np.int32), aff_ob, gzip_it=True)
    w(out / "labels_freesurfer_LUT.txt", FS_LUT.encode("ascii"))

    # float32 label volume — the is_label heuristic must not look at the dtype (§6.1)
    def _intent(img):
        img.header["intent_code"] = 1002

    write_nifti(
        out / "labels_float32.nii.gz", lab.astype(np.float32), aff_ob, gzip_it=True, tweak=_intent
    )

    # §11's named analytic-pixel fixtures
    ramp4 = np.zeros((4, 4, 4), dtype=np.uint8)
    ramp4[:] = np.arange(4, dtype=np.uint8).reshape(4, 1, 1)
    write_nifti(out / "vol_ramp4.nii", ramp4, np.eye(4))

    asym = np.zeros((8, 8, 8), dtype=np.uint8)
    asym[0:3, 5:8, 5:8] = 255  # -x +y +z octant = LEFT-anterior-superior (§11's orientation test)
    aff_asym = np.eye(4)
    aff_asym[:3, 3] = (-3.5, -3.5, -3.5)
    write_nifti(out / "vol_asym.nii", asym, aff_asym)

    # ---------------- MGH / NRRD / MetaImage (§6.1's other voxel formats) ----------------
    # Same ramps, same oblique affine, so a reader that gets an axis or a sign wrong is caught by
    # the very numbers the NIfTI fixtures already pin.
    write_mgh(out / "vol_u8.mgh", ramp(DIMS, dtype=np.uint8), aff_ob)
    write_mgh(out / "vol_f32.mgz", ramp(DIMS, dtype=np.float32), aff_ex, gzip_it=True)
    write_mgh(out / "vol_i16_4d.mgz", ramp(DIMS, nvols=3, dtype=np.int16), aff_ob, gzip_it=True)

    write_nrrd(out / "vol_u8_raw.nrrd", ramp(DIMS, dtype=np.uint8), aff_ob)
    # a negative diagonal element in the stored (LPS) directions: aff_qfac's third column is
    # negated, and the LPS x/y rows are negated again on the way in
    write_nrrd(
        out / "vol_i16_gzip_lps.nrrd", ramp(DIMS, dtype=np.int16), aff_qfac, encoding="gzip",
        content="i16 gzip LPS",
    )
    write_nrrd(
        out / "vol_f32_ascii.nrrd", ramp(DIMS, dtype=np.float32), aff_ob, encoding="ascii",
        space="right-anterior-superior",
    )
    write_nrrd(out / "vol_4d_list.nrrd", ramp(DIMS, nvols=3, dtype=np.float32), aff_ob)

    write_mha(out / "vol_u8_raw.mha", ramp(DIMS, dtype=np.uint8), aff_ob)
    write_mha(out / "vol_i16_zlib.mha", ramp(DIMS, dtype=np.int16), aff_ob, compressed=True)
    write_mha(out / "vol_rgb.mha", rgb, aff_ex, channels=3)
    notes["voxelFormats"] = {
        "lps": "NRRD (space: left-posterior-superior) and MetaImage store the x/y-negated affine; "
               "the manifest's `affine` is RAS, as the reader must produce it",
    }

    # ---------------- Gmsh .msh ----------------
    nodes, tets, tet_tags, tris, tri_tags, n_ext, n_iface = build_lattice()
    fields = mesh_fields(nodes, tris, tets)
    notes["lattice"] = {
        "nodes": len(nodes),
        "tris": len(tris),
        "tets": len(tets),
        "exteriorFaces": n_ext,
        "tagDifferingInteriorFaces": n_iface,
    }
    write_msh_v2_ascii(out / "mesh_v2_ascii.msh", nodes, tris, tri_tags, tets, tet_tags, fields)
    write_msh_v2_binary(out / "mesh_v2_binary.msh", nodes, tris, tri_tags, tets, tet_tags, fields)
    w(out / "mesh_v2_binary.msh.opt", MSH_OPT.encode("ascii"))
    w(out / "mesh_v2_binary_LUT.txt", MESH_LUT_SIMNIBS.encode("ascii"))

    # tri-less tet mesh — the grey_*.msh case (§6.3): renders empty without extract_boundary
    empty_tris = np.zeros((0, 3), dtype=np.int64)
    tet_only_fields = {
        "elm_scalar": (1, fields["elm_scalar"][1][len(tris):]),
    }
    write_msh_v2_binary(
        out / "mesh_tetonly.msh", nodes, empty_tris, np.zeros(0, dtype=np.int64),
        tets, tet_tags, tet_only_fields, names=[(3, 1, "Tissue_A"), (3, 2, "Tissue_B")],
    )

    # non-contiguous element AND node numbers, plus a field with a gap -> partial/NaN (§6.2)
    ne = len(tris) + len(tets)
    elm_numbers = np.arange(1, ne + 1) * 3 + 7          # 10, 13, 16, ... — never 1..N
    node_numbers = np.arange(1, len(nodes) + 1) * 2 + 100
    gap_ids = elm_numbers[::2]                          # only every other element carries a value
    gap_vals = (np.arange(len(gap_ids), dtype=np.float64) * -1.5 - 1.0).reshape(-1, 1)
    nc_fields = {
        "node_scalar": fields["node_scalar"],
        "elm_scalar": fields["elm_scalar"],
        "elm_gap": (1, gap_vals),
    }
    write_msh_v2_ascii(
        out / "mesh_noncontig.msh", nodes, tris, tri_tags, tets, tet_tags, nc_fields,
        node_numbers=node_numbers, elm_numbers=elm_numbers,
        field_ids={"elm_gap": (gap_ids, gap_vals)},
    )
    notes["noncontig"] = {
        "firstElementNumber": int(elm_numbers[0]),
        "lastElementNumber": int(elm_numbers[-1]),
        "firstNodeNumber": int(node_numbers[0]),
        "gapFieldRecords": int(len(gap_ids)),
    }

    # ---------------- surfaces ----------------
    verts, stris, squads = surface_patch()
    write_gifti_surface(out / "surf_gzipb64.surf.gii", verts, stris, "GZipBase64Binary")
    write_gifti_surface(out / "surf_b64.surf.gii", verts, stris, "Base64Binary")
    write_gifti_surface(out / "surf_ascii.surf.gii", verts, stris, "ASCII")
    write_gifti_func(out / "surf.func.gii", (verts[:, 0] * 0.1 + verts[:, 1] * 0.01))
    write_gifti_label(out / "surf.label.gii", np.array([0, 3, 7, 11], dtype=np.int32)[np.arange(len(verts)) % 4])
    # The one fixture that can be *rendered* in `colorMode:'label'`: geometry + a <LabelTable>.
    # `surface_patch()` triangulates a 4x4 grid as (a, a+1, a+5) and (a, a+5, a+4) for a = 4j + i,
    # j, i in 0..2. Labelling vertices {0, 1, 5} Beta and {10, 14, 15} Gamma leaves the first
    # triangle (0, 1, 5) and the last (10, 15, 14) monochrome, and two Alpha triangles — (2, 3, 7)
    # and (8, 13, 12) — untouched. Those four are the analytic assertions; every other triangle
    # straddles a boundary and is a gradient, which is what `mode:'outline'` is drawn from.
    patch_keys = np.full(len(verts), 3, dtype=np.int32)  # Alpha
    patch_keys[[0, 1, 5]] = 7  # Beta
    patch_keys[[10, 14, 15]] = 11  # Gamma
    write_gifti_labelled_surface(out / "surf_labelled.surf.gii", verts, stris, patch_keys)

    # FreeSurfer
    nib.freesurfer.write_geometry(str(out / "lh.fixture.surf"), verts.astype(np.float64), stris.astype(np.int32))
    nib.freesurfer.write_morph_data(
        str(out / "lh.fixture.curv"), (verts[:, 2] * 0.25).astype(np.float32)
    )
    annot_labels = np.arange(len(verts), dtype=np.int32) % 4
    ctab = np.array(
        [[25, 5, 25, 0, 0], [255, 0, 0, 0, 0], [0, 128, 0, 0, 0], [0, 0, 255, 0, 0]],
        dtype=np.int32,
    )
    ctab[:, 4] = ctab[:, 0] + ctab[:, 1] * 2**8 + ctab[:, 2] * 2**16 + ctab[:, 3] * 2**24
    nib.freesurfer.write_annot(
        str(out / "lh.fixture.annot"),
        annot_labels,
        ctab,
        ["Unknown", "Alpha", "Beta", "Gamma"],
        fill_ctab=False,
    )

    # STL / PLY / OBJ.  PLY and OBJ carry the quad faces that exercise `tri_edge_mask` (§6.2).
    write_stl_ascii(out / "patch_ascii.stl", verts, stris)
    write_stl_binary(out / "patch_binary.stl", verts, stris)
    write_ply_ascii(out / "patch_tri_ascii.ply", verts, stris)
    write_ply_binary(out / "patch_tri_binary.ply", verts, stris)
    write_ply_ascii(out / "patch_quad_ascii.ply", verts, squads)
    write_obj(out / "patch_tri.obj", verts, stris)
    write_obj(out / "patch_quad.obj", verts, squads)

    notes["patch"] = {"vertices": len(verts), "triangles": len(stris), "quads": len(squads)}
    return notes


# --------------------------------------------------------------------------------------
# verification — nibabel side (runs under the generating interpreter)
# --------------------------------------------------------------------------------------


def raw_nifti_header(path: Path) -> bytes:
    op = gzip.open if path.name.endswith(".gz") else open
    with op(path, "rb") as fh:
        return fh.read(544)


def inspect_nifti(path: Path) -> dict:
    img = nib.load(str(path))
    hdr = img.header
    raw = raw_nifti_header(path)
    little = struct.unpack("<i", raw[:4])[0] in (348, 540)
    end = "<" if little else ">"
    sizeof_hdr = struct.unpack(end + "i", raw[:4])[0]
    if sizeof_hdr == 348:
        raw_slope, raw_inter = struct.unpack(end + "2f", raw[OFF_SCL_SLOPE : OFF_SCL_SLOPE + 8])
        raw_pixdim = struct.unpack(end + "8f", raw[OFF_PIXDIM : OFF_PIXDIM + 32])
        raw_dtype = struct.unpack(end + "h", raw[OFF_DATATYPE : OFF_DATATYPE + 2])[0]
    else:  # NIfTI-2: datatype at 12, pixdim at 104 (8 x f64), scl_slope/inter at 176/184
        raw_dtype = struct.unpack(end + "h", raw[12:14])[0]
        raw_pixdim = struct.unpack(end + "8d", raw[104:168])
        raw_slope, raw_inter = struct.unpack(end + "2d", raw[176:192])

    dims = [int(x) for x in hdr.get_data_shape()[:3]]
    nvols = int(np.prod(hdr.get_data_shape()[3:])) if len(hdr.get_data_shape()) > 3 else 1

    # the on-disk affine, chosen the way §3 chooses it
    sform_code = int(hdr["sform_code"])
    qform_code = int(hdr["qform_code"])
    b, c, d = (float(hdr["quatern_b"]), float(hdr["quatern_c"]), float(hdr["quatern_d"]))
    qfac = -1.0 if float(raw_pixdim[0]) < 0 else 1.0
    R = quat_to_mat(b, c, d)
    qm = np.eye(4)
    qm[:3, 0] = R[:, 0] * float(raw_pixdim[1])
    qm[:3, 1] = R[:, 1] * float(raw_pixdim[2])
    qm[:3, 2] = R[:, 2] * float(raw_pixdim[3]) * qfac
    qm[:3, 3] = (float(hdr["qoffset_x"]), float(hdr["qoffset_y"]), float(hdr["qoffset_z"]))
    qm_noqfac = qm.copy()
    qm_noqfac[:3, 2] = R[:, 2] * float(raw_pixdim[3])

    sm = np.vstack([np.array(hdr["srow_x"]), np.array(hdr["srow_y"]), np.array(hdr["srow_z"]),
                    [0, 0, 0, 1]]).astype(np.float64)
    chosen = sm if sform_code > 0 else (qm if qform_code > 0 else np.diag(
        [float(raw_pixdim[1]), float(raw_pixdim[2]), float(raw_pixdim[3]), 1.0]))

    # `np.asanyarray(img.dataobj)` has ALREADY applied scl_slope/scl_inter — using it here and then
    # multiplying by the on-disk slope again scales twice, which is exactly the §6.1 rule this fixture
    # set exists to pin. `get_unscaled()` is the on-disk sample array, for every dtype including the
    # structured RGB24/RGBA32 ones.
    raw_arr = img.dataobj.get_unscaled()
    if raw_arr.dtype.names:  # RGB24 / RGBA32
        comps = [raw_arr[n] for n in raw_arr.dtype.names]
        raw_arr = np.stack(comps, axis=-1)
        phys = raw_arr.astype(np.float64)
    else:
        slope = raw_slope if np.isfinite(raw_slope) and raw_slope != 0 else 1.0
        inter = raw_inter if np.isfinite(raw_inter) else 0.0
        if slope == 1.0 and inter == 0.0:
            slope, inter = 1.0, 0.0
        phys = raw_arr.astype(np.float64) * slope + inter

    spots = []
    for (i, j, k) in SPOTS:
        if i >= dims[0] or j >= dims[1] or k >= dims[2]:
            continue
        for t in range(min(nvols, 3)):
            idx = (i, j, k) if nvols == 1 else (i, j, k, t)
            rv = raw_arr[idx]
            pv = phys[idx]
            spots.append(
                {
                    "voxel": [i, j, k],
                    "volume": t,
                    "raw": (fl(rv) if np.ndim(rv) else f(rv)),
                    "physical": (fl(pv) if np.ndim(pv) else f(pv)),
                    "world": fl(chosen @ np.array([i, j, k, 1.0])),
                }
            )

    is_rgb = int(raw_dtype) in (128, 2304)
    uniq = np.unique(phys[np.isfinite(phys)]) if (phys.size and not is_rgb) else np.array([])
    # §6.1's is_label predicate, minus the intent_code half, which the reader adds.
    integral = (
        None if is_rgb else bool(uniq.size and np.all(uniq == np.round(uniq)) and uniq.min() >= 0)
    )
    rec = {
        "bytes": path.stat().st_size,
        "gzipped": path.name.endswith(".gz"),
        "niftiVersion": 1 if sizeof_hdr == 348 else 2,
        "endian": "little" if little else "big",
        "dims": dims,
        "nvols": nvols,
        "datatypeCode": int(raw_dtype),
        "dtype": DATATYPE_NAMES[int(raw_dtype)],
        # The dtype of the UNSCALED on-disk array — what a §6.1 reader puts in `Volume.data`.
        "numpyDtype": str(img.dataobj.get_unscaled().dtype),
        "affineSource": "sform" if sform_code > 0 else ("qform" if qform_code > 0 else "pixdim"),
        "sclSlopeOnDisk": f(raw_slope),
        "sclInterOnDisk": f(raw_inter),
        "sformCode": sform_code,
        "qformCode": qform_code,
        "pixdim": fl(raw_pixdim),
        "qfac": f(qfac),
        "quatern": [f(b), f(c), f(d)],
        "qoffset": [f(hdr["qoffset_x"]), f(hdr["qoffset_y"]), f(hdr["qoffset_z"])],
        "intentCode": int(hdr["intent_code"]),
        "sformAffine": mat(sm),
        "qformAffine": mat(qm),
        "qformAffineWithoutQfac": mat(qm_noqfac),
        "maxAbsErrorDroppingQfac": f(np.abs(qm - qm_noqfac).max()),
        "maxAbsSformQformDelta": f(np.abs(sm - qm).max()) if sform_code > 0 else None,
        "affine": mat(chosen),
        "spacing": fl(raw_pixdim[1:4]),
        "stats": arr_stats(phys),
        "uniqueCount": None if is_rgb else int(uniq.size),
        "allIntegralNonNegative": integral,
        "spotValues": spots,
    }
    if uniq.size <= 32:
        rec["uniqueValues"] = fl(uniq)
    return rec


# --------------------------------------------------------------------------------------
# verification — the other voxel formats
# --------------------------------------------------------------------------------------

VOXEL_SPOTS = [(0, 0, 0), (4, 0, 0), (0, 3, 0), (0, 0, 2), (2, 1, 1), (4, 3, 2)]


def _voxel_record(path: Path, fmt: str, ground_truth: str, dims, nvols, dtype, affine, spacing,
                  sample) -> dict:
    """`sample(i, j, k, t)` -> raw value (scalar or a component tuple) of one voxel; the
    record's stats come from `sample` over every voxel, so they never touch the writer."""
    affine = np.asarray(affine, dtype=np.float64)
    is_color = dtype in ("rgb24", "rgba32")
    per_vol = []
    for t in range(nvols):
        vals = np.array(
            [sample(i, j, k, t) for k in range(dims[2]) for j in range(dims[1]) for i in range(dims[0])],
            dtype=np.float64,
        )
        per_vol.append(vals.ravel())
    allv = np.concatenate(per_vol)
    spots = []
    for (i, j, k) in VOXEL_SPOTS:
        if i >= dims[0] or j >= dims[1] or k >= dims[2]:
            continue
        for t in range(min(nvols, 3)):
            rv = sample(i, j, k, t)
            spots.append({
                "voxel": [i, j, k], "volume": t,
                "raw": fl(rv) if np.ndim(rv) else f(rv),
                "world": fl(affine @ np.array([i, j, k, 1.0])),
            })
    uniq = np.unique(allv[np.isfinite(allv)]) if not is_color else np.array([])
    return {
        "bytes": path.stat().st_size,
        "format": fmt,
        "groundTruth": ground_truth,
        "dims": [int(d) for d in dims],
        "nvols": int(nvols),
        "dtype": dtype,
        "affine": mat(affine),
        "spacing": fl(spacing),
        "stats": None if is_color else arr_stats(allv),
        "volumeStats": None if is_color else [arr_stats(v) for v in per_vol],
        "uniqueCount": None if is_color else int(uniq.size),
        "allIntegralNonNegative": None if is_color else bool(
            uniq.size and np.all(uniq == np.round(uniq)) and uniq.min() >= 0
        ),
        "spotValues": spots,
    }


def inspect_mgh(path: Path) -> dict:
    img = nib.load(str(path))
    shape = img.shape
    dims = [int(x) for x in shape[:3]]
    nvols = int(shape[3]) if len(shape) > 3 else 1
    data = np.asanyarray(img.dataobj)
    if data.ndim == 3:
        data = data[..., None]
    rec = _voxel_record(
        path, "mgh", f"nibabel {nib.__version__} nib.load (MGHImage.affine)", dims, nvols,
        NUMPY_DTYPE_NAMES[img.get_data_dtype().name], img.affine,
        img.header["delta"], lambda i, j, k, t: data[i, j, k, t],
    )
    hdr = img.header
    rec["goodRASFlag"] = int(hdr["goodRASFlag"])
    rec["Pxyz_c"] = fl(hdr["Pxyz_c"])
    rec["Mdc"] = mat(hdr["Mdc"])
    rec["vox2rasTkr"] = mat(hdr.get_vox2ras_tkr())
    return rec


def inspect_itk_volumes(out: Path) -> dict:
    """Runs under simnibs_python.  SimpleITK is the reference reader for NRRD and MetaImage;
    it loads every image in LPS, and the record stores the RAS affine after negating the x
    and y rows — the one conversion a SimpleITK→nibabel bridge performs."""
    import SimpleITK as sitk

    recs = {}
    for p in sorted(out.glob("*.nrrd")) + sorted(out.glob("*.mha")):
        img = sitk.ReadImage(str(p))
        size = list(img.GetSize())
        ndim = img.GetDimension()
        ncomp = img.GetNumberOfComponentsPerPixel()
        arr = sitk.GetArrayFromImage(img)  # (z,y,x) | (t,z,y,x) | (z,y,x,c)
        dims = size[:3]
        d = np.array(img.GetDirection(), dtype=np.float64).reshape(ndim, ndim)[:3, :3]
        sp = np.array(img.GetSpacing(), dtype=np.float64)[:3]
        org = np.array(img.GetOrigin(), dtype=np.float64)[:3]
        lps = np.eye(4)
        lps[:3, :3] = d * sp[None, :]
        lps[:3, 3] = org
        ras = lps.copy()
        ras[0, :] *= -1
        ras[1, :] *= -1
        base = arr.dtype.name
        if ncomp > 1 and base == "uint8" and ncomp in (3, 4) and p.suffix == ".mha":
            dtype, nvols = ("rgb24" if ncomp == 3 else "rgba32"), 1
            sample = lambda i, j, k, t, a=arr: a[k, j, i, :].tolist()
        elif ncomp > 1:
            # a `kinds: ... list` NRRD: SimpleITK folds the list axis into components
            dtype, nvols = NUMPY_DTYPE_NAMES[base], ncomp
            sample = lambda i, j, k, t, a=arr: a[k, j, i, t]
        elif ndim == 4:
            dtype, nvols = NUMPY_DTYPE_NAMES[base], size[3]
            sample = lambda i, j, k, t, a=arr: a[t, k, j, i]
        else:
            dtype, nvols = NUMPY_DTYPE_NAMES[base], 1
            sample = lambda i, j, k, t, a=arr: a[k, j, i]
        fmt = "nrrd" if p.suffix == ".nrrd" else "metaimage"
        rec = _voxel_record(
            p, fmt,
            f"SimpleITK {sitk.Version_MajorVersion()}.{sitk.Version_MinorVersion()}."
            f"{sitk.Version_PatchVersion()} sitk.ReadImage; LPS -> RAS by negating rows 0 and 1",
            dims, nvols, dtype, ras, sp, sample,
        )
        rec["itk"] = {
            "size": size, "dimension": ndim, "componentsPerPixel": ncomp,
            "direction": fl(img.GetDirection()), "origin": fl(img.GetOrigin()),
            "spacing": fl(img.GetSpacing()), "pixelType": img.GetPixelIDTypeAsString(),
            "lpsAffine": mat(lps),
        }
        recs[p.name] = rec
    return recs


# GIfTI attribute codes -> the strings that appear verbatim in the XML (§6.2).
GIFTI_ENCODING = {1: "ASCII", 2: "Base64Binary", 3: "GZipBase64Binary", 4: "ExternalFileBinary"}
GIFTI_ENDIAN = {1: "BigEndian", 2: "LittleEndian"}
GIFTI_ORDER = {1: "RowMajorOrder", 2: "ColumnMajorOrder"}
GIFTI_XFORM_CODES = {
    0: "NIFTI_XFORM_UNKNOWN", 1: "NIFTI_XFORM_SCANNER_ANAT", 2: "NIFTI_XFORM_ALIGNED_ANAT",
    3: "NIFTI_XFORM_TALAIRACH", 4: "NIFTI_XFORM_MNI_152",
}
GIFTI_DATATYPE = {2: "NIFTI_TYPE_UINT8", 8: "NIFTI_TYPE_INT32", 16: "NIFTI_TYPE_FLOAT32"}


def _code(table, v):
    return table.get(int(v), int(v))


def inspect_gifti(path: Path) -> dict:
    img = nib.load(str(path))
    rec = {"bytes": path.stat().st_size, "arrays": []}
    for da in img.darrays:
        d = np.asarray(da.data)
        entry = {
            "intent": nib.nifti1.intent_codes.label[da.intent],
            "intentCode": int(da.intent),
            "datatypeCode": int(da.datatype),
            "datatype": _code(GIFTI_DATATYPE, da.datatype),
            "encoding": _code(GIFTI_ENCODING, da.encoding),
            "endian": _code(GIFTI_ENDIAN, da.endian),
            "arrayIndexingOrder": _code(GIFTI_ORDER, da.ind_ord),
            "dims": [int(x) for x in d.shape],
            "stats": arr_stats(d),
        }
        if da.coordsys is not None:
            entry["dataSpace"] = _code(GIFTI_XFORM_CODES, da.coordsys.dataspace)
            entry["transformedSpace"] = _code(GIFTI_XFORM_CODES, da.coordsys.xformspace)
            entry["transform"] = mat(da.coordsys.xform)
        if entry["intentCode"] == 1008:  # POINTSET
            entry["bboxUntransformed"] = {"min": fl(d.min(axis=0)), "max": fl(d.max(axis=0))}
            if da.coordsys is not None:
                h = np.hstack([d, np.ones((len(d), 1))]) @ np.asarray(da.coordsys.xform).T
                entry["bboxTransformed"] = {"min": fl(h[:, :3].min(axis=0)), "max": fl(h[:, :3].max(axis=0))}
            entry["first"] = fl(d[0])
            entry["last"] = fl(d[-1])
        if entry["intentCode"] == 1009:  # TRIANGLE
            entry["first"] = [int(x) for x in d[0]]
            entry["last"] = [int(x) for x in d[-1]]
        rec["arrays"].append(entry)
    if img.labeltable is not None and img.labeltable.labels:
        rec["labelTable"] = [
            {
                "key": int(lab.key),
                "name": lab.label,
                "rgba255": [int(round((v or 0.0) * 255)) for v in (lab.red, lab.green, lab.blue, lab.alpha)],
            }
            for lab in img.labeltable.labels
        ]
    return rec


def inspect_fs(out: Path) -> dict:
    rec = {}
    v, t = nib.freesurfer.read_geometry(str(out / "lh.fixture.surf"))
    rec["lh.fixture.surf"] = {
        "bytes": (out / "lh.fixture.surf").stat().st_size,
        "nodes": int(len(v)),
        "tris": int(len(t)),
        "bbox": {"min": fl(v.min(axis=0)), "max": fl(v.max(axis=0))},
        "firstNode": fl(v[0]),
        "lastNode": fl(v[-1]),
        "firstTri": [int(x) for x in t[0]],
        "lastTri": [int(x) for x in t[-1]],
    }
    c = nib.freesurfer.read_morph_data(str(out / "lh.fixture.curv"))
    rec["lh.fixture.curv"] = {
        "bytes": (out / "lh.fixture.curv").stat().st_size,
        "n": int(len(c)),
        "stats": arr_stats(c),
        "first": f(c[0]),
        "last": f(c[-1]),
    }
    lab, ctab, names = nib.freesurfer.read_annot(str(out / "lh.fixture.annot"), orig_ids=False)
    raw_lab, _, _ = nib.freesurfer.read_annot(str(out / "lh.fixture.annot"), orig_ids=True)
    rec["lh.fixture.annot"] = {
        "bytes": (out / "lh.fixture.annot").stat().st_size,
        "n": int(len(lab)),
        "denseLabelRange": [int(lab.min()), int(lab.max())],
        "rawLabelRange": [int(raw_lab.min()), int(raw_lab.max())],
        "denseLabels": [int(x) for x in lab],
        "rawLabels": [int(x) for x in raw_lab],
        "colortable": [
            {
                "denseIndex": i,
                "name": n.decode() if isinstance(n, bytes) else n,
                "rgba255": [int(x) for x in ctab[i, :4]],
                "packedId": int(ctab[i, 4]),
            }
            for i, n in enumerate(names)
        ],
    }
    return rec


# --------------------------------------------------------------------------------------
# verification — SimNIBS / Gmsh side (runs under simnibs_python via --inspect)
# --------------------------------------------------------------------------------------


def inspect_meshes(out: Path) -> dict:
    """Runs under simnibs_python.

    `simnibs.mesh_io.read_msh` is the reference reader for the Gmsh v2.2 files whose
    numbering is contiguous.  The Gmsh 4.14 Python API is the reference for everything
    else: the v4.1 files (SimNIBS refuses v4, §6.2), the non-contiguous-numbering file
    (SimNIBS's reader renumbers it and then refuses its fields — the exact trap §6.2
    warns about), and STL/PLY/OBJ.
    """
    import numpy as np  # noqa: F811  (fresh interpreter)
    from simnibs import mesh_io
    import gmsh

    class G:
        """`with G(path) as g:` — one initialised Gmsh session with `path` merged."""

        def __init__(self, path=None):
            self.path = path

        def __enter__(self):
            gmsh.initialize()
            gmsh.option.setNumber("General.Terminal", 0)
            if self.path is not None:
                gmsh.merge(str(self.path))
            return gmsh

        def __exit__(self, *a):
            gmsh.finalize()
            return False

    # ---------------- SimNIBS reader ----------------

    def simnibs_rec(p: Path) -> dict:
        m = mesh_io.read_msh(str(p))
        el = m.elm.elm_type
        ntri, ntet = int((el == 2).sum()), int((el == 4).sum())
        tri_tags = m.elm.tag1[el == 2]
        tet_tags = m.elm.tag1[el == 4]
        rec = {
            "reader": "simnibs.mesh_io.read_msh",
            "bytes": p.stat().st_size,
            "nodes": int(m.nodes.nr),
            "tris": ntri,
            "tets": ntet,
            "elements": int(m.elm.nr),
            "hasTris": ntri > 0,
            "bbox": {
                "min": fl(m.nodes.node_coord.min(axis=0)),
                "max": fl(m.nodes.node_coord.max(axis=0)),
            },
            "triTagCounts": {str(int(t)): int((tri_tags == t).sum()) for t in np.unique(tri_tags)},
            "tetTagCounts": {str(int(t)): int((tet_tags == t).sum()) for t in np.unique(tet_tags)},
            "trisFirst": bool(np.all(el[:ntri] == 2)) if ntri else True,
            "firstNode": fl(m.nodes.node_coord[0]),
            "lastNode": fl(m.nodes.node_coord[-1]),
            "firstElementNodes": [int(x) for x in m.elm.node_number_list[0] if x > 0],
            "lastElementNodes": [int(x) for x in m.elm.node_number_list[-1] if x > 0],
            "fields": [],
        }
        for name, fld in m.field.items():
            d = np.asarray(fld.value, dtype=np.float64)
            ncomp = int(d.shape[1]) if d.ndim > 1 else 1
            rec["fields"].append(
                {
                    "name": name,
                    "source": "node" if type(fld).__name__ == "NodeData" else "elm",
                    "ncomp": ncomp,
                    "n": int(d.shape[0]),
                    "stats": arr_stats(d),
                    "magnitudeStats": arr_stats(np.linalg.norm(d, axis=1)) if ncomp > 1 else None,
                    "first": fl(np.atleast_1d(d[0])),
                    "last": fl(np.atleast_1d(d[-1])),
                }
            )
        rec["fields"].sort(key=lambda x: x["name"])
        return rec

    # ---------------- Gmsh reader ----------------

    NPT = {1: 2, 2: 3, 3: 4, 4: 4, 15: 1}  # gmsh element type -> nodes per element

    def gmsh_rec(p: Path, *, views=True, connectivity=False) -> dict:
        with G(p) as g:
            ntags, ncoord, _ = g.model.mesh.getNodes()
            ntags = np.asarray(ntags, dtype=np.int64)
            coords = np.asarray(ncoord, dtype=np.float64).reshape(-1, 3)
            order = np.argsort(ntags)
            etypes, etags, enodes = g.model.mesh.getElements()
            per = {}
            for et, tg in zip(etypes, etags):
                per[int(et)] = per.get(int(et), 0) + len(tg)
            allt = (
                np.concatenate([np.asarray(t, dtype=np.int64) for t in etags])
                if len(etags)
                else np.zeros(0, dtype=np.int64)
            )
            rec = {
                "reader": "gmsh %s python api" % g.option.getString("General.Version"),
                "bytes": p.stat().st_size,
                "nodes": int(len(ntags)),
                "elementsByGmshType": {str(k): int(v) for k, v in sorted(per.items())},
                "bbox": {"min": fl(coords.min(axis=0)), "max": fl(coords.max(axis=0))}
                if len(coords)
                else None,
                "nodeNumbers": {
                    "first": int(ntags[order][0]) if ntags.size else None,
                    "last": int(ntags[order][-1]) if ntags.size else None,
                    "contiguousFrom1": bool(
                        ntags.size and np.array_equal(np.sort(ntags), np.arange(1, ntags.size + 1))
                    ),
                },
                "elementNumbers": {
                    "first": int(allt.min()) if allt.size else None,
                    "last": int(allt.max()) if allt.size else None,
                    "count": int(allt.size),
                    "contiguousFrom1": bool(
                        allt.size and np.array_equal(np.sort(allt), np.arange(1, allt.size + 1))
                    ),
                    "sorted": [int(x) for x in np.sort(allt)[:6]],
                },
            }
            if ntags.size:
                rec["firstNodeByNumber"] = fl(coords[order][0])
                rec["lastNodeByNumber"] = fl(coords[order][-1])

            # physical-group tag census: Gmsh maps the v2 `tag1` onto physical groups.
            counts = {2: {}, 3: {}}
            names = []
            for dim, tag in g.model.getPhysicalGroups():
                names.append([int(dim), int(tag), g.model.getPhysicalName(dim, tag)])
                n = 0
                for ent in g.model.getEntitiesForPhysicalGroup(dim, tag):
                    ets, ets_tags, _ = g.model.mesh.getElements(dim, int(ent))
                    n += sum(len(t) for t in ets_tags)
                counts.setdefault(int(dim), {})[str(int(tag))] = int(n)
            rec["physicalNames"] = sorted(names)
            rec["physicalTagCountsDim2"] = counts.get(2, {})
            rec["physicalTagCountsDim3"] = counts.get(3, {})

            if connectivity:
                conn = {}
                for et, nd in zip(etypes, enodes):
                    npt = NPT.get(int(et))
                    if npt:
                        nd = np.asarray(nd, dtype=np.int64)
                        conn[str(int(et))] = {
                            "first": [int(x) for x in nd[:npt]],
                            "last": [int(x) for x in nd[-npt:]],
                        }
                rec["connectivity1Based"] = conn

            if views:
                rec["fields"] = []
                for vt in g.view.getTags():
                    name = g.view.option.getString(vt, "Name")
                    dtypes, dtags, data, _time, ncomp = g.view.getModelData(vt, 0)
                    dtags = np.asarray(dtags, dtype=np.int64)
                    vals = np.asarray([np.asarray(d, dtype=np.float64) for d in data])
                    rec["fields"].append(
                        {
                            "name": name,
                            "source": "node" if dtypes == "NodeData" else "elm",
                            "gmshDataType": dtypes,
                            "ncomp": int(ncomp),
                            "n": int(len(dtags)),
                            "stats": arr_stats(vals),
                            "magnitudeStats": arr_stats(np.linalg.norm(vals, axis=1))
                            if int(ncomp) > 1
                            else None,
                            "idRange": [int(dtags.min()), int(dtags.max())] if dtags.size else None,
                            "firstIds": [int(x) for x in dtags[:4]],
                            "first": fl(np.atleast_1d(vals[0])),
                            "last": fl(np.atleast_1d(vals[-1])),
                        }
                    )
                rec["fields"].sort(key=lambda x: x["name"])
            return rec

    def convert(src: Path, dst: Path, version: float, binary: int, with_views: bool) -> None:
        with G(src) as g:
            g.option.setNumber("Mesh.MshFileVersion", version)
            g.option.setNumber("Mesh.Binary", binary)
            # Mesh.SaveAll=1 would make Gmsh write the *elementary* entity tag as the v2.2
            # `tag1` and drop every physical tag, so the converted files would come back
            # with a single tag 0.  Every element here belongs to a physical group.
            g.option.setNumber("Mesh.SaveAll", 0)
            g.write(str(dst))
            if with_views:
                # Without this Gmsh re-writes the WHOLE mesh in front of every appended
                # view, and the file ends up with one duplicate copy of $Nodes/$Elements
                # per field.
                g.option.setNumber("PostProcessing.SaveMesh", 0)
                for vt in g.view.getTags():
                    g.view.write(vt, str(dst), append=True)

    res: dict = {"msh": {}, "surfaces": {}}

    # --- Gmsh v4.1 (ascii + binary) and a Gmsh-written v2.2 binary.  ARCHITECTURE.md §6.2:
    #     there is no local v4.1 reference implementation but Gmsh itself.
    src = out / "mesh_v2_ascii.msh"
    convert(src, out / "mesh_v41_ascii.msh", 4.1, 0, True)
    convert(src, out / "mesh_v41_binary.msh", 4.1, 1, True)
    convert(src, out / "mesh_v2_binary_gmsh.msh", 2.2, 1, True)

    for name in ["mesh_v2_ascii.msh", "mesh_v2_binary.msh", "mesh_tetonly.msh"]:
        rec = simnibs_rec(out / name)
        rec["gmsh"] = gmsh_rec(out / name, connectivity=True)
        res["msh"][name] = rec

    for name in [
        "mesh_noncontig.msh",
        "mesh_v41_ascii.msh",
        "mesh_v41_binary.msh",
        "mesh_v2_binary_gmsh.msh",
    ]:
        res["msh"][name] = gmsh_rec(out / name, connectivity=True)

    # cross-check the v4.1 files through a second, independent reader: convert each back
    # to v2.2 with Gmsh and read THAT with SimNIBS.
    for name in ["mesh_v41_ascii.msh", "mesh_v41_binary.msh"]:
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "roundtrip.msh"
            convert(out / name, tmp, 2.2, 0, False)
            rt = simnibs_rec(tmp)
        res["msh"][name]["roundTripToV22ReadBySimnibs"] = {
            k: rt[k]
            for k in ("nodes", "tris", "tets", "bbox", "triTagCounts", "tetTagCounts", "hasTris")
        }

    # Prove the .msh.opt is syntactically valid Gmsh and that a few of its values survive
    # a real parse.  Gmsh applies an .opt file as *options*, so this checks the values, not
    # the tag->colour mapping (that expectation is MSH_OPT_EXPECTED, authored from §6.2).
    with G(out / "mesh_v2_ascii.msh") as g:
        g.merge(str(out / "mesh_v2_binary.msh.opt"))
        res["mshOptParsedByGmsh"] = {
            "Mesh.Color.One": [int(x) for x in g.option.getColor("Mesh.Color.One")],
            "Mesh.Color.Two": [int(x) for x in g.option.getColor("Mesh.Color.Two")],
            "Mesh.SurfaceFaces": f(g.option.getNumber("Mesh.SurfaceFaces")),
            "Mesh.VolumeFaces": f(g.option.getNumber("Mesh.VolumeFaces")),
            "View[0].CustomMin": f(g.option.getNumber("View[0].CustomMin")),
            "View[0].CustomMax": f(g.option.getNumber("View[0].CustomMax")),
            "View[0].RangeType": f(g.option.getNumber("View[0].RangeType")),
            "View[0].ColormapNumber": f(g.option.getNumber("View[0].ColormapNumber")),
            "View[0].SaturateValues": f(g.option.getNumber("View[0].SaturateValues")),
            "View[0].ShowScale": f(g.option.getNumber("View[0].ShowScale")),
            "View[0].VectorType": f(g.option.getNumber("View[0].VectorType")),
        }

    for name in [
        "patch_ascii.stl",
        "patch_binary.stl",
        "patch_tri_ascii.ply",
        "patch_tri_binary.ply",
        "patch_quad_ascii.ply",
        "patch_tri.obj",
        "patch_quad.obj",
    ]:
        res["surfaces"][name] = gmsh_rec(out / name, views=False, connectivity=True)

    # STL carries no shared vertices: Gmsh WELDS coincident ones, so `nodes` above is the
    # welded count.  A reader that does not weld sees 3 vertices per facet.
    for name in ("patch_ascii.stl", "patch_binary.stl"):
        r = res["surfaces"][name]
        r["weldedNodes"] = r.pop("nodes")
        r["unweldedVertices"] = 3 * int(r["elementsByGmshType"]["2"])
        r["readerNote"] = (
            "STL has no vertex table. Gmsh welds coincident vertices (weldedNodes); a "
            "non-welding reader produces unweldedVertices instead. Either is contract-legal "
            "for read_stl (§6.2); the triangle count and the bbox are the invariants."
        )

    # Gmsh's PLY reader keeps only the first three indices of an n-gon face, so it reports
    # 9 triangles and drops the vertex only the 4th corner referenced.  The same 9 quads
    # over the same 16 vertices ARE read correctly from patch_quad.obj, so that file is the
    # cross-check for the quad PLY.
    q = res["surfaces"]["patch_quad_ascii.ply"]
    q["readerNote"] = (
        "Gmsh 4.14's PLY reader truncates each quad to its first three indices, so the "
        "numbers above are Gmsh's, NOT what a correct reader must produce. The file holds "
        "the same 16 vertices and 9 quads as patch_quad.obj; use that entry (Gmsh reads OBJ "
        "n-gons correctly, element type 3) as the expectation for read_ply."
    )
    q["expectedFromEquivalentObj"] = {
        k: res["surfaces"]["patch_quad.obj"][k]
        for k in ("nodes", "elementsByGmshType", "bbox", "connectivity1Based")
    }
    return res


# --------------------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------------------

SCHEMA = {
    "version": 1,
    "description": (
        "Ground truth for the committed synthetic fixtures in testdata/. "
        "Every number here was produced by an INDEPENDENT reader — nibabel for NIfTI/GIfTI/"
        "FreeSurfer (MGH/MGZ included), SimpleITK for NRRD/MetaImage (loaded in LPS, stored here as "
        "RAS), simnibs.mesh_io.read_msh for Gmsh v2.2, the Gmsh 4.14 Python API for Gmsh "
        "v4.1 and for STL/PLY/OBJ — never by the writer in scripts/gen-fixtures.py. Regenerate "
        "with `python3 scripts/gen-fixtures.py`."
    ),
    "conventions": {
        "affine": "4x4 row-major [row][col]; maps voxel (i,j,k,1) -> world RAS mm (ARCHITECTURE.md §3)",
        "voxelOrder": "i fastest, then j, then k, then volume index",
        "spotValues": "raw = on-disk sample; physical = raw*sclSlope+sclInter (never folded, §6.1)",
        "colors": "rgba255 = 0..255 bytes, the §4.1 wire form",
        "meshElementNumbers": "1-based Gmsh element numbers (§6.2); tris are the first block",
        "gmshElementTypes": "2 = tri3, 4 = tet4, 3 = quad4 (n-gon, exercises tri_edge_mask)",
        "nonFinite": '"NaN" / "Infinity" / "-Infinity" appear as JSON strings',
    },
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--inspect", nargs=2, metavar=("OUTDIR", "JSON"))
    args = ap.parse_args()

    if args.inspect:
        out = Path(args.inspect[0])
        result = inspect_meshes(out)
        result["voxelFormats"] = inspect_itk_volumes(out)
        Path(args.inspect[1]).write_text(json.dumps(result))
        return 0

    repo = Path(__file__).resolve().parent.parent
    out = Path(args.outdir) if args.outdir else repo / "testdata"
    notes = generate(out)
    print(f"wrote fixtures to {out}", file=sys.stderr)
    if args.no_verify:
        return 0

    manifest = dict(SCHEMA)
    manifest["writerNotes"] = notes
    manifest["volumes"] = {}
    for p in sorted(out.glob("*.nii")) + sorted(out.glob("*.nii.gz")):
        manifest["volumes"][p.name] = inspect_nifti(p)
    manifest["voxelFormats"] = {
        p.name: inspect_mgh(p) for p in sorted(out.glob("*.mgh")) + sorted(out.glob("*.mgz"))
    }
    manifest["gifti"] = {p.name: inspect_gifti(p) for p in sorted(out.glob("*.gii"))}
    manifest["freesurfer"] = inspect_fs(out)

    tmp = out / ".mesh-inspect.json"
    subprocess.run(
        [SIMNIBS_PYTHON, str(Path(__file__).resolve()), "--inspect", str(out), str(tmp)],
        check=True,
    )
    mesh = json.loads(tmp.read_text())
    tmp.unlink()
    manifest["voxelFormats"].update(mesh.pop("voxelFormats"))
    manifest.update(mesh)

    manifest["sidecars"] = {
        "mesh_v2_binary.msh.opt": {
            "bytes": (out / "mesh_v2_binary.msh.opt").stat().st_size,
            "appliesTo": ["mesh_v2_ascii.msh", "mesh_v2_binary.msh"],
            "groundTruth": "authored (see MSH_OPT_EXPECTED in scripts/gen-fixtures.py)",
            "expected": MSH_OPT_EXPECTED,
        },
        "mesh_v2_binary_LUT.txt": {
            "bytes": (out / "mesh_v2_binary_LUT.txt").stat().st_size,
            "format": "simnibs",
            "groundTruth": "authored",
            "expected": [
                {"id": 1, "name": "Tissue_A", "rgba255": [230, 230, 210, 255]},
                {"id": 2, "name": "Tissue_B", "rgba255": [129, 129, 129, 255]},
                {"id": 1001, "name": "Tissue_A_surface", "rgba255": [104, 163, 255, 255]},
                {"id": 1002, "name": "Tissue_B_surface", "rgba255": [255, 239, 179, 255]},
            ],
        },
        "labels_simnibs_LUT.txt": {
            "bytes": (out / "labels_simnibs_LUT.txt").stat().st_size,
            "format": "simnibs",
            "appliesTo": ["labels_simnibs.nii.gz", "labels_float32.nii.gz"],
            "groundTruth": "authored",
            "expected": [
                {"id": 0, "name": "Unknown", "rgba255": [0, 0, 0, 0]},
                {"id": 1, "name": "WM", "rgba255": [230, 230, 210, 255]},
                {"id": 2, "name": "GM", "rgba255": [129, 129, 129, 255]},
                {"id": 3, "name": "CSF", "rgba255": [104, 163, 255, 255]},
                {"id": 5, "name": "Scalp", "rgba255": [255, 239, 179, 255]},
                {"id": 10, "name": "Muscle", "rgba255": [255, 166, 133, 255]},
                {"id": 530, "name": "Deep_label", "rgba255": [20, 180, 90, 255]},
            ],
        },
        "labels_freesurfer_LUT.txt": {
            "bytes": (out / "labels_freesurfer_LUT.txt").stat().st_size,
            "format": "freesurfer",
            "appliesTo": ["labels_freesurfer.nii.gz"],
            "groundTruth": "authored",
            "expected": [
                {"id": 0, "name": "Unknown", "rgba255": [0, 0, 0, 0]},
                {"id": 3, "name": "Alpha", "rgba255": [255, 0, 0, 0]},
                {"id": 7, "name": "Beta", "rgba255": [0, 128, 0, 0]},
                {"id": 11, "name": "Gamma", "rgba255": [0, 0, 255, 0]},
                {"id": 42, "name": "Delta", "rgba255": [220, 190, 20, 0]},
            ],
        },
    }
    manifest["notGenerated"] = [
        {
            "what": "a mesh with >= 2**21 nodes for §11's face-key-width test",
            "why": (
                "2,097,152 nodes is ~25 MB of coordinates and ~100 MB of tets; there is no "
                "encoding of it that fits the 2 MB committed-fixture budget."
            ),
            "instead": (
                "crates/tvx-geom/tests/fixtures.rs::big_node_count_mesh() builds one in memory "
                "at test time (a k x k x 1 grid of shared-vertex tets), and the real-data test "
                "uses m2m_ernie/ernie_seeg.msh (2,301,899 nodes, 22 bits) per AGENTS.md."
            ),
        },
        {
            "what": "a two-file .hdr/.img NIfTI",
            "why": "§6.1 rejects it by name (Error::Unsupported(\"two-file NIfTI\")); "
                   "no valid fixture is needed to assert a rejection.",
            "instead": "the Rust test truncates vol_u8.nii's magic to `ni1\\0` in memory.",
        },
        {
            "what": "a detached-header NRRD (.nhdr) or MetaImage (.mhd), or a bzip2 NRRD",
            "why": "§6.1 rejects them by name; the byte-slice signature has no sibling-file "
                   "access and bzip2 is not a dependency.",
            "instead": "the Rust tests rewrite an attached fixture's header in memory.",
        },
        {
            "what": "GIfTI ExternalFileBinary",
            "why": "§6.2 rejects it by name; the byte-slice signature has no sibling-file access.",
            "instead": "the Rust test rewrites surf_ascii.surf.gii's Encoding attribute in memory.",
        },
    ]
    total = sum(
        p.stat().st_size
        for p in out.iterdir()
        if p.is_file() and p.suffix not in (".json", ".md")
    )
    manifest["totalFixtureBytes"] = total

    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(f"manifest: {out / 'manifest.json'}  ({total} bytes of fixtures)", file=sys.stderr)
    if total > 2 * 1024 * 1024:
        print("ERROR: fixtures exceed the 2 MB budget", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
