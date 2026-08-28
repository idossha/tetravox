#!/usr/bin/env python3
"""Build a synthetic HU **CT** from `sub-ernie`'s `final_tissues.nii.gz`.

The reference dataset has no CT, and the viewer has to be exercised on one: a volume whose affine
does **not** match `T1.nii.gz`'s (so world-space compositing is doing real work rather than
agreeing by accident), whose values are signed HU carried by `scl_inter` (so §6.1's "scaling is
never folded" is exercised end to end), and which contains thin, very bright metal (so the format
ladder, the threshold and the window are all under load at once).

What it makes, from the segmentation and its LUT:

* **HU per tissue** — air −1000, scalp 40, compact bone 1200, spongy bone 300, CSF 15, GM 37,
  WM 30, blood 45, eyes 20, muscle 50 — then Gaussian noise σ ≈ 15 HU.
* **Two SEEG-like electrodes**: 1.3 mm-diameter, ~3000 HU contacts strung along two straight
  trajectories, each of which starts deep and leaves the head **through the skull** (the entry
  point is found by marching outward until the segmentation reads air, so the bone crossing is a
  property of the geometry, not an assumption).
* **A different grid**: 0.7 mm isotropic, rotated ≈5° about an oblique axis, with an origin offset
  by a non-integer number of voxels. Its affine shares no column with T1's.
* **Two encodings of the same volume**: `ct_hu_uint16.nii.gz` — uint16 with `scl_slope = 1`,
  `scl_inter = −1024`, the scanner convention — and `ct_hu_int16.nii.gz`, int16 with no scaling.
  A reader that folds slope/inter, or that ignores them, disagrees with the other file, and the
  pair is the test.

Deterministic: one fixed seed, one pass, byte-identical across runs.

    python3 scripts/reference/make_ct.py                     # -> testdata/generated/
    python3 scripts/reference/make_ct.py --spacing 1.0 --out /tmp/ct
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import struct
from dataclasses import dataclass
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

from niftiref import load_volume

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_M2M = Path(
    "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie/m2m_ernie"
)
DEFAULT_OUT = REPO_ROOT / "testdata" / "generated"

SEED = 20260827

# NIfTI-1 header offsets we patch after nibabel has serialised (see `write_nifti_raw`).
OFF_SCL_SLOPE, OFF_SCL_INTER, OFF_DESCRIP = 112, 116, 148

#: HU by `final_tissues` label id. Ids and names come from `final_tissues_LUT.txt`; label 4
#: ("Bone", a merged class SimNIBS's charm segmentation splits into 7/8) does not occur in ernie
#: but is mapped anyway so the table is total over the LUT.
TISSUE_HU: dict[int, float] = {
    0: -1000.0,  # air / background
    1: 30.0,  # White-Matter
    2: 37.0,  # Gray-Matter
    3: 15.0,  # CSF
    4: 800.0,  # Bone (merged; absent in ernie)
    5: 40.0,  # Scalp
    6: 20.0,  # Eye_balls
    7: 1200.0,  # Compact_bone
    8: 300.0,  # Spongy_bone
    9: 45.0,  # Blood
    10: 50.0,  # Muscle
    11: 100.0,  # Cartilage
    12: -100.0,  # Fat
}

NOISE_SIGMA = 15.0
METAL_HU = 3000.0
CONTACT_DIAMETER_MM = 1.3
CONTACT_LENGTH_MM = 2.0
CONTACT_PITCH_MM = 3.5
CONTACTS_PER_LEAD = 10


# ---------------------------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------------------------


def rotation_matrix(axis, deg: float) -> np.ndarray:
    """Rodrigues, for the ≈5° tilt that keeps the CT grid off T1's."""
    k = np.asarray(axis, dtype=np.float64)
    k = k / np.linalg.norm(k)
    a = np.deg2rad(deg)
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(a) * kx + (1 - np.cos(a)) * (kx @ kx)


@dataclass
class Grid:
    """A target voxel grid: `affine` (voxel -> world mm) and `dims`."""

    affine: np.ndarray
    dims: tuple[int, int, int]

    def world_of_slab(self, k: int) -> np.ndarray:
        """World mm of every voxel of slab `k`, shape `(ni, nj, 3)`."""
        ni, nj, _ = self.dims
        i = np.arange(ni, dtype=np.float64)[:, None]
        j = np.arange(nj, dtype=np.float64)[None, :]
        a = self.affine
        w = np.empty((ni, nj, 3), dtype=np.float64)
        for c in range(3):
            w[..., c] = a[c, 0] * i + a[c, 1] * j + a[c, 2] * k + a[c, 3]
        return w


def ct_grid(world_corners: np.ndarray, spacing: float, tilt_deg: float, margin: float) -> Grid:
    """A rotated, offset, isotropic grid that covers `world_corners`.

    The origin is offset by a deliberately non-integer number of voxels, so no CT voxel centre
    coincides with a T1 one and the resampling in the viewer cannot be right by accident.
    """
    r = rotation_matrix([1.0, 2.0, 3.0], tilt_deg)
    g = world_corners @ r  # = (R^T world)^T, coordinates in the rotated frame
    gmin = g.min(axis=0) - margin
    gmax = g.max(axis=0) + margin
    # A sub-voxel, irrational-looking shift of the origin, fixed for determinism.
    gmin = gmin - np.array([0.31, 0.17, 0.23])
    dims = tuple(int(np.ceil((gmax[c] - gmin[c]) / spacing)) + 1 for c in range(3))
    affine = np.eye(4)
    affine[:3, :3] = r * spacing
    affine[:3, 3] = r @ gmin
    return Grid(affine=affine, dims=dims)  # type: ignore[arg-type]


def march_to_air(labels: np.ndarray, inv_affine: np.ndarray, start, direction, step=0.5,
                 max_mm=250.0, run=8) -> np.ndarray:
    """March from `start` along `direction` until the segmentation reads air and stays air.

    Returns the first world point outside the head. `run` consecutive air samples guard against
    stopping in an internal air cavity (the sinuses read 0 too).
    """
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    p = np.asarray(start, dtype=np.float64)
    air = 0
    t = 0.0
    while t < max_mm:
        t += step
        q = p + d * t
        v = inv_affine[:3, :3] @ q + inv_affine[:3, 3]
        idx = np.rint(v).astype(int)
        if np.any(idx < 0) or np.any(idx >= labels.shape):
            return q
        air = air + 1 if labels[idx[0], idx[1], idx[2]] == 0 else 0
        if air >= run:
            return p + d * (t - (run - 1) * step)
    return p + d * max_mm


def tissues_along(labels: np.ndarray, inv_affine: np.ndarray, a, b, step=0.5) -> list[int]:
    """The sequence of distinct tissue ids a segment passes through — the bone-crossing evidence."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = max(2, int(np.linalg.norm(b - a) / step))
    seq: list[int] = []
    for t in np.linspace(0.0, 1.0, n):
        q = a + (b - a) * t
        v = inv_affine[:3, :3] @ q + inv_affine[:3, 3]
        idx = np.rint(v).astype(int)
        if np.any(idx < 0) or np.any(idx >= labels.shape):
            continue
        lab = int(labels[idx[0], idx[1], idx[2]])
        if not seq or seq[-1] != lab:
            seq.append(lab)
    return seq


@dataclass
class Lead:
    """One SEEG lead: a straight trajectory and the contacts strung along it."""

    name: str
    tip: np.ndarray  # deepest contact centre, world mm
    entry: np.ndarray  # where the trajectory leaves the head, world mm
    contacts: list[tuple[np.ndarray, np.ndarray]]  # (start, end) of each cylinder
    tissues: list[int]


def build_lead(name: str, tip, direction, labels, inv_affine) -> Lead:
    """Place `CONTACTS_PER_LEAD` cylinders from `tip` back along `direction` toward the entry."""
    tip = np.asarray(tip, dtype=np.float64)
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    entry = march_to_air(labels, inv_affine, tip, d)
    contacts = []
    for c in range(CONTACTS_PER_LEAD):
        s = tip + d * (c * CONTACT_PITCH_MM)
        contacts.append((s, s + d * CONTACT_LENGTH_MM))
    return Lead(
        name=name,
        tip=tip,
        entry=entry,
        contacts=contacts,
        tissues=tissues_along(labels, inv_affine, tip, entry),
    )


def stamp_contacts(vol: np.ndarray, grid: Grid, leads: list[Lead], sub: int = 3) -> int:
    """Rasterise every contact cylinder into `vol` at {@link METAL_HU}.

    A 1.3 mm contact is barely wider than a 0.7 mm voxel, so a centre-in-cylinder test would drop
    half of them and quantise the rest into a staircase. Each voxel's coverage is estimated on a
    `sub^3` lattice instead and the value is mixed `(1 - f) * tissue + f * 3000`, which is what a
    scanner's partial volume does — voxels fully inside a contact still read exactly 3000 HU, so a
    "find the metal" threshold test has an exact number to find.

    Returns the number of voxels with any metal in them.
    """
    radius = CONTACT_DIAMETER_MM / 2.0
    inv = np.linalg.inv(grid.affine)
    offs = (np.arange(sub) + 0.5) / sub - 0.5
    sub_offsets = np.array([[a, b, c] for a in offs for b in offs for c in offs])
    total = 0
    for lead in leads:
        for start, end in lead.contacts:
            axis = end - start
            length = float(np.linalg.norm(axis))
            axis = axis / length
            # Voxel-space bounding box of the cylinder, padded by one voxel.
            pts = np.array([start, end])
            vox = pts @ inv[:3, :3].T + inv[:3, 3]
            pad = radius / min(np.linalg.norm(grid.affine[:3, c]) for c in range(3)) + 2.0
            lo = np.maximum(np.floor(vox.min(axis=0) - pad).astype(int), 0)
            hi = np.minimum(np.ceil(vox.max(axis=0) + pad).astype(int) + 1, grid.dims)
            if np.any(hi <= lo):
                continue
            ii, jj, kk = (np.arange(lo[c], hi[c], dtype=np.float64) for c in range(3))
            gi, gj, gk = np.meshgrid(ii, jj, kk, indexing="ij")
            a = grid.affine
            w = np.stack(
                [a[c, 0] * gi + a[c, 1] * gj + a[c, 2] * gk + a[c, 3] for c in range(3)], axis=-1
            )
            cover = np.zeros(w.shape[:3], dtype=np.float32)
            for off in sub_offsets:
                rel = w + (grid.affine[:3, :3] @ off) - start
                along = rel @ axis
                radial = np.linalg.norm(rel - along[..., None] * axis, axis=-1)
                cover += (radial <= radius) & (along >= 0.0) & (along <= length)
            cover /= len(sub_offsets)
            block = vol[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]]
            np.copyto(block, (1.0 - cover) * block + cover * np.float32(METAL_HU))
            total += int((cover > 0).sum())
    return total


# ---------------------------------------------------------------------------------------------
# writing
# ---------------------------------------------------------------------------------------------


def write_nifti_raw(path: Path, data: np.ndarray, affine: np.ndarray, *, slope: float,
                    inter: float, descrip: str) -> None:
    """Write a NIfTI-1 whose samples stay **raw**.

    `scl_slope` / `scl_inter` are patched into the serialised header bytes rather than handed to
    nibabel, which would otherwise rescale the array on write — the opposite of what §6.1's
    "scaling is never folded" needs from a fixture.
    """
    img = nib.Nifti1Image(np.asanyarray(data), np.asarray(affine, dtype=np.float64))
    img.header.set_sform(np.asarray(affine, dtype=np.float64), code=2)
    img.header.set_qform(np.asarray(affine, dtype=np.float64), code=2)
    img.header.set_xyzt_units("mm")
    fh = nib.FileHolder(fileobj=io.BytesIO())
    img.to_file_map({"header": fh, "image": fh})
    raw = bytearray(fh.fileobj.getvalue())
    raw[OFF_SCL_SLOPE : OFF_SCL_SLOPE + 8] = struct.pack("<2f", slope, inter)
    d = descrip.encode("ascii")[:79]
    raw[OFF_DESCRIP : OFF_DESCRIP + 80] = d + b"\x00" * (80 - len(d))
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime 0 so the gzip stream — and therefore the file — is byte-identical across runs.
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6, mtime=0) as gzf:
        gzf.write(bytes(raw))
    path.write_bytes(buf.getvalue())


# ---------------------------------------------------------------------------------------------
# the build
# ---------------------------------------------------------------------------------------------


def label_to_hu(labels: np.ndarray) -> np.ndarray:
    """`final_tissues` ids -> HU, via {@link TISSUE_HU}. Unknown ids fall back to air."""
    top = max(int(labels.max()), max(TISSUE_HU)) + 1
    table = np.full(top, TISSUE_HU[0], dtype=np.float32)
    for ident, hu in TISSUE_HU.items():
        if ident < top:
            table[ident] = hu
    return table[labels.astype(np.int64)]


def build(m2m: Path, out: Path, spacing: float, tilt_deg: float, margin: float) -> dict:
    tissues = load_volume(m2m / "final_tissues.nii.gz")
    labels = np.rint(tissues.physical(0)).astype(np.int16)
    hu_t1 = label_to_hu(labels)

    # The grid: the head's world bounding box, rotated and offset.
    occupied = np.argwhere(labels > 0)
    lo, hi = occupied.min(axis=0).astype(float), occupied.max(axis=0).astype(float)
    corners = np.array(
        [[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    )
    world_corners = corners @ tissues.affine[:3, :3].T + tissues.affine[:3, 3]
    grid = ct_grid(world_corners, spacing, tilt_deg, margin)

    # Two trajectories. The tips sit deep (near the mid-sagittal thalamic region and in the left
    # frontal white matter); the directions point out through the temporal and frontal skull, and
    # `build_lead` finds the entry by marching until the segmentation reads air.
    centre = world_corners.mean(axis=0)
    leads = [
        build_lead(
            "L-temporal",
            centre + np.array([-6.0, -6.0, 4.0]),
            np.array([-1.0, 0.15, 0.25]),
            labels,
            tissues.inv_affine,
        ),
        build_lead(
            "R-frontal",
            centre + np.array([14.0, 6.0, -2.0]),
            np.array([0.55, 0.8, 0.25]),
            labels,
            tissues.inv_affine,
        ),
    ]

    ni, nj, nk = grid.dims
    ct = np.empty(grid.dims, dtype=np.float32)
    inv_t1 = tissues.inv_affine
    for k in range(nk):
        w = grid.world_of_slab(k)
        v = w @ inv_t1[:3, :3].T + inv_t1[:3, 3]
        ct[:, :, k] = ndimage.map_coordinates(
            hu_t1,
            [v[..., 0].ravel(), v[..., 1].ravel(), v[..., 2].ravel()],
            order=1,
            mode="constant",
            cval=TISSUE_HU[0],
        ).reshape(ni, nj)

    rng = np.random.default_rng(SEED)
    ct += rng.standard_normal(size=grid.dims, dtype=np.float32) * np.float32(NOISE_SIGMA)
    metal_voxels = stamp_contacts(ct, grid, leads)

    # Nearest-neighbour tissue ids on the CT grid, for the per-tissue statistics only.
    tissue_on_ct = np.empty(grid.dims, dtype=np.int16)
    for k in range(nk):
        w = grid.world_of_slab(k)
        v = w @ inv_t1[:3, :3].T + inv_t1[:3, 3]
        tissue_on_ct[:, :, k] = ndimage.map_coordinates(
            labels,
            [v[..., 0].ravel(), v[..., 1].ravel(), v[..., 2].ravel()],
            order=0,
            mode="constant",
            cval=0,
        ).reshape(ni, nj)

    out.mkdir(parents=True, exist_ok=True)
    # Round **once**, then encode twice. Rounding `ct` and `ct + 1024` separately would let a tie
    # land differently in the two files and leave them 1 HU apart for no reason anyone could name.
    hu = np.rint(ct)
    stored_u16 = np.clip(hu + 1024.0, 0, 65535).astype(np.uint16)
    write_nifti_raw(
        out / "ct_hu_uint16.nii.gz", stored_u16, grid.affine, slope=1.0, inter=-1024.0,
        descrip="synthetic CT (HU)",
    )
    stored_i16 = np.clip(hu, -32768, 32767).astype(np.int16)
    write_nifti_raw(
        out / "ct_hu_int16.nii.gz", stored_i16, grid.affine, slope=1.0, inter=0.0,
        descrip="synthetic CT (HU)",
    )

    report = {
        "spacing": spacing,
        "tiltDeg": tilt_deg,
        "dims": list(grid.dims),
        "affine": np.round(grid.affine, 6).tolist(),
        "t1Affine": np.round(tissues.affine, 6).tolist(),
        "seed": SEED,
        "noiseSigma": NOISE_SIGMA,
        "metalVoxels": metal_voxels,
        "hu": {
            "min": float(ct.min()),
            "max": float(ct.max()),
            "mean": float(ct.mean()),
            "p1": float(np.percentile(ct, 1)),
            "p50": float(np.percentile(ct, 50)),
            "p99": float(np.percentile(ct, 99)),
            "above1500": int((ct > 1500).sum()),
        },
        "perTissue": {},
        "leads": [],
        "files": {
            "uint16": {
                "path": str(out / "ct_hu_uint16.nii.gz"),
                "dtype": "uint16",
                "sclSlope": 1.0,
                "sclInter": -1024.0,
                "storedMin": int(stored_u16.min()),
                "storedMax": int(stored_u16.max()),
                # The scanner convention has no code below -1024 HU, so the noise floor clips
                # there. The int16 copy does not, which is the one difference between the files.
                "clippedBelowMinus1024": int((ct < -1024.0).sum()),
            },
            "int16": {
                "path": str(out / "ct_hu_int16.nii.gz"),
                "dtype": "int16",
                "sclSlope": 1.0,
                "sclInter": 0.0,
                "storedMin": int(stored_i16.min()),
                "storedMax": int(stored_i16.max()),
            },
        },
    }
    for ident, hu in sorted(TISSUE_HU.items()):
        sel = (tissue_on_ct == ident) & (ct < 1500)
        n = int(sel.sum())
        if n == 0:
            continue
        vals = ct[sel]
        report["perTissue"][str(ident)] = {
            "nominalHu": hu,
            "voxels": n,
            "mean": float(vals.mean()),
            "std": float(vals.std()),
        }
    for lead in leads:
        report["leads"].append(
            {
                "name": lead.name,
                "tip": np.round(lead.tip, 3).tolist(),
                "entry": np.round(lead.entry, 3).tolist(),
                "lengthMm": round(float(np.linalg.norm(lead.entry - lead.tip)), 3),
                "contacts": len(lead.contacts),
                "tissueSequence": lead.tissues,
                "crossesBone": any(t in (4, 7, 8) for t in lead.tissues),
            }
        )
    (out / "ct_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def _print_report(r: dict) -> None:
    print(f"grid           : {r['dims']} @ {r['spacing']} mm, tilt {r['tiltDeg']}°")
    print(f"affine         : {r['affine'][0]}")
    print(f"                 {r['affine'][1]}")
    print(f"                 {r['affine'][2]}")
    hu = r["hu"]
    print(
        f"HU             : min {hu['min']:.1f}  p1 {hu['p1']:.1f}  p50 {hu['p50']:.1f}  "
        f"p99 {hu['p99']:.1f}  max {hu['max']:.1f}  mean {hu['mean']:.1f}"
    )
    print(f"metal voxels   : {r['metalVoxels']} stamped, {hu['above1500']} above 1500 HU")
    print("expected HU per tissue (nominal -> measured on the CT grid, metal excluded):")
    for ident, s in r["perTissue"].items():
        print(
            f"  {ident:>3}  nominal {s['nominalHu']:>8.1f}   mean {s['mean']:>8.1f} "
            f"+/- {s['std']:>6.1f}   n = {s['voxels']}"
        )
    for lead in r["leads"]:
        print(
            f"lead {lead['name']:<12} {lead['contacts']} contacts, "
            f"{lead['lengthMm']} mm to entry, crosses bone: {lead['crossesBone']}"
        )
        print(f"  tissue sequence tip -> entry: {lead['tissueSequence']}")
    for kind, f in r["files"].items():
        print(
            f"{kind:<7}        : {f['path']}  ({f['dtype']}, scl_slope {f['sclSlope']}, "
            f"scl_inter {f['sclInter']}, stored {f['storedMin']}..{f['storedMax']})"
        )
        if "clippedBelowMinus1024" in f:
            print(f"                 {f['clippedBelowMinus1024']} voxels clip at -1024 HU")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--m2m", type=Path, default=DEFAULT_M2M, help="m2m_ernie directory (read-only)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--spacing", type=float, default=0.7)
    ap.add_argument("--tilt", type=float, default=5.0, help="grid rotation in degrees")
    ap.add_argument("--margin", type=float, default=6.0, help="mm of air around the head")
    args = ap.parse_args(argv)
    if not (args.m2m / "final_tissues.nii.gz").exists():
        raise SystemExit(f"{args.m2m}/final_tissues.nii.gz not found")
    _print_report(build(args.m2m, args.out, args.spacing, args.tilt, args.margin))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
