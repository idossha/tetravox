"""NIfTI reading for the reference renderer — §3's affine model and §6.1's raw-sample rule.

Two things here are deliberately *not* delegated to nibabel:

* **the affine**, which is §3's contract (sform, else qform with `qfac` on the third column only,
  else `diag(pixdim)`), built here from the raw header so the reference proves the rule rather than
  inheriting it from another library's reading of it;
* **`scl_slope` / `scl_inter`**, which are read from the raw 348/540-byte header. `nib.load(p).header`
  reports NaN for both — `Nifti1Image.from_file_map` calls `set_slope_inter(None, None)` after
  handing scaling to the array proxy — and §6.1 needs the on-disk values, which are never folded
  into the samples.

nibabel is used only to decompress and unpack the sample array (`dataobj.get_unscaled()`), which is
exactly the "independent reader" role §11 gives it.
"""

from __future__ import annotations

import gzip
import struct
from dataclasses import dataclass
from pathlib import Path

import nibabel as nib
import numpy as np

# NIfTI-1 (348-byte) header offsets.
N1 = dict(
    dim=40, intent_code=68, datatype=70, bitpix=72, pixdim=76, scl_slope=112, scl_inter=116,
    cal_max=124, cal_min=128, descrip=148, qform_code=252, sform_code=254, quatern=256,
    qoffset=268, srow=280,
)
# NIfTI-2 (540-byte) header offsets.
N2 = dict(
    dim=16, intent_code=504, datatype=12, bitpix=14, pixdim=104, scl_slope=176, scl_inter=184,
    cal_max=192, cal_min=200, descrip=240, qform_code=344, sform_code=348, quatern=352,
    qoffset=376, srow=400,
)


def _read_head(path: Path, n: int = 560) -> bytes:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        with gzip.open(path, "rb") as fh:
            return fh.read(n)
    return raw[:n]


@dataclass(frozen=True)
class RawHeader:
    """The header fields §3 and §6.1 reason about, straight off disk."""

    nifti2: bool
    swap: bool
    dims: tuple[int, ...]
    pixdim: tuple[float, ...]
    scl_slope: float
    scl_inter: float
    qform_code: int
    sform_code: int
    quatern: tuple[float, float, float]
    qoffset: tuple[float, float, float]
    srow: tuple[tuple[float, float, float, float], ...]
    intent_code: int
    descrip: str


def read_raw_header(path: str | Path) -> RawHeader:
    head = _read_head(Path(path))
    sizeof = struct.unpack("<i", head[:4])[0]
    nifti2 = sizeof in (540, 0x1C020000) or struct.unpack("<i", head[:4])[0] == 540
    # Sniff: NIfTI-1 sizeof_hdr is 348, NIfTI-2 is 540, either endianness.
    swap = False
    for order in ("<", ">"):
        v = struct.unpack(order + "i", head[:4])[0]
        if v in (348, 540):
            swap = order == ">"
            nifti2 = v == 540
            break
    else:
        raise ValueError(f"{path}: not a NIfTI header (sizeof_hdr={sizeof})")
    o = N2 if nifti2 else N1
    e = ">" if swap else "<"
    itype, ftype, fsz = ("q", "d", 8) if nifti2 else ("h", "f", 4)

    def ints(off: int, n: int) -> tuple[int, ...]:
        sz = 8 if nifti2 else 2
        return struct.unpack(f"{e}{n}{itype}", head[off : off + n * sz])

    def floats(off: int, n: int) -> tuple[float, ...]:
        return struct.unpack(f"{e}{n}{ftype}", head[off : off + n * fsz])

    dim = ints(o["dim"], 8)
    pixdim = floats(o["pixdim"], 8)
    # `intent_code`, `qform_code`, `sform_code` are i16 in NIfTI-1 and i32 in NIfTI-2.
    csz, cfmt = (4, "i") if nifti2 else (2, "h")

    def code(off: int) -> int:
        return struct.unpack(f"{e}{cfmt}", head[off : off + csz])[0]

    srow = floats(o["srow"], 12)
    return RawHeader(
        nifti2=nifti2,
        swap=swap,
        dims=tuple(int(d) for d in dim),
        pixdim=tuple(float(p) for p in pixdim),
        scl_slope=float(floats(o["scl_slope"], 1)[0]),
        scl_inter=float(floats(o["scl_inter"], 1)[0]),
        qform_code=code(o["qform_code"]),
        sform_code=code(o["sform_code"]),
        quatern=tuple(float(x) for x in floats(o["quatern"], 3)),  # type: ignore[arg-type]
        qoffset=tuple(float(x) for x in floats(o["qoffset"], 3)),  # type: ignore[arg-type]
        srow=(srow[0:4], srow[4:8], srow[8:12]),
        intent_code=code(o["intent_code"]),
        descrip=head[o["descrip"] : o["descrip"] + 80].split(b"\x00")[0].decode(
            "ascii", "replace"
        ),
    )


def affine_from_header(h: RawHeader) -> np.ndarray:
    """§3's affine, in source order. Returns a 4x4 row-major `voxel -> world mm` matrix.

    1. `sform` when `sform_code > 0`;
    2. else the **qform**, with `qfac = (pixdim[0] < 0 ? -1 : +1)` applied to the **third column
       only** — dropping it moves `m2m_ernie/T1.nii.gz`'s third column from `(1,0,0)` to `(-1,0,0)`,
       2.0 mm/voxel and an A/P flip;
    3. else `diag(pixdim[1..3], 1)`.
    """
    m = np.eye(4, dtype=np.float64)
    if h.sform_code > 0:
        m[0, :] = h.srow[0]
        m[1, :] = h.srow[1]
        m[2, :] = h.srow[2]
        return m
    if h.qform_code > 0:
        b, c, d = h.quatern
        a = np.sqrt(max(0.0, 1.0 - b * b - c * c - d * d))
        r = np.array(
            [
                [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
                [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
                [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - b * b - c * c],
            ],
            dtype=np.float64,
        )
        qfac = -1.0 if h.pixdim[0] < 0 else 1.0
        m[:3, 0] = r[:, 0] * h.pixdim[1]
        m[:3, 1] = r[:, 1] * h.pixdim[2]
        m[:3, 2] = r[:, 2] * h.pixdim[3] * qfac
        m[:3, 3] = h.qoffset
        return m
    m[0, 0], m[1, 1], m[2, 2] = h.pixdim[1], h.pixdim[2], h.pixdim[3]
    return m


def normalise_scaling(slope: float, inter: float) -> tuple[float, float]:
    """§6.1: apply slope/inter only when they are finite, non-zero and not the identity."""
    if (
        np.isfinite(slope)
        and slope != 0.0
        and np.isfinite(inter)
        and (slope != 1.0 or inter != 0.0)
    ):
        return float(slope), float(inter)
    return 1.0, 0.0


@dataclass
class Volume:
    """One loaded volume: **raw** samples plus everything §7.3's fragment needs."""

    path: str
    dims: tuple[int, int, int]
    nvols: int
    affine: np.ndarray  # 4x4 row-major, voxel -> world mm
    inv_affine: np.ndarray
    raw: np.ndarray  # (i, j, k) or (i, j, k, t), i fastest — RAW, unscaled
    scl_slope: float
    scl_inter: float
    is_label: bool
    header: RawHeader

    def frame(self, index: int = 0) -> np.ndarray:
        return self.raw if self.raw.ndim == 3 else self.raw[..., index]

    def physical(self, index: int = 0) -> np.ndarray:
        return self.frame(index).astype(np.float64) * self.scl_slope + self.scl_inter


def is_label_volume(physical: np.ndarray, intent_code: int) -> bool:
    """§6.1's rule: all values integral, min >= 0, and (`intent_code == 1002` or <= 4096 uniques).

    **The dtype is not part of the test** — `m2m_ernie/segmentation/labeling.nii.gz` is float32 with
    57 integral unique values and is a genuine atlas.
    """
    if physical.size == 0:
        return False
    finite = np.isfinite(physical)
    if not finite.all():
        return False
    if float(physical.min()) < 0:
        return False
    if not np.all(physical == np.rint(physical)):
        return False
    if intent_code == 1002:
        return True
    return int(np.unique(physical).size) <= 4096


def percentiles(values: np.ndarray, qs=(0.1, 1, 2, 5, 50, 95, 98, 99, 99.9)) -> dict[str, float]:
    """§6.1's percentiles: **one O(n) pass into a 65536-bin histogram over `[min, max]`**.

    Not `np.percentile`. The contract fixes the estimator, and the two disagree on exactly the data
    that matters: `T1.nii.gz` is more than half zeros, so a linear-interpolating estimator returns
    `p2 = 0` while the histogram returns its bin's **lower edge**, `-0.782` — which is the number on
    the colour bar of every Phase-1 golden, and therefore the window an engine screenshot was taken
    with. A reference renderer that picked the other one would differ by a whole 8-bit level across
    the darkest third of the image, with no way to tell which of the two was at fault.
    """
    v = np.asarray(values, dtype=np.float64).ravel()
    lo, hi = float(v.min()), float(v.max())
    if not (hi > lo):
        return {str(q): lo for q in qs}
    bins = 65536
    width = (hi - lo) / bins
    idx = np.minimum(((v - lo) / width).astype(np.int64), bins - 1)
    hist = np.bincount(idx, minlength=bins)
    cum = np.cumsum(hist)
    out: dict[str, float] = {}
    for q in qs:
        target = q / 100.0 * v.size
        b = int(np.searchsorted(cum, target, side="left"))
        out[str(q)] = lo + min(b, bins - 1) * width
    return out


def default_window(values: np.ndarray) -> tuple[float, float]:
    """`scene/defaults.ts`'s `defaultWindow`: `p2 .. p98`, with the min/max fallback."""
    p = percentiles(values, (2, 98))
    lo, hi = p["2"], p["98"]
    if hi > lo:
        return lo, hi
    mn, mx = float(np.min(values)), float(np.max(values))
    return mn, (mx if mx > mn else mn + 1.0)


def load_volume(path: str | Path, force_label: bool | None = None) -> Volume:
    """Load a NIfTI: raw samples from nibabel, affine and scaling from the raw header."""
    path = Path(path)
    h = read_raw_header(path)
    img = nib.load(str(path))
    raw = np.asarray(img.dataobj.get_unscaled())
    slope, inter = normalise_scaling(h.scl_slope, h.scl_inter)
    if raw.ndim == 2:
        raw = raw[..., None]
    dims = tuple(int(x) for x in raw.shape[:3])
    nvols = int(np.prod(raw.shape[3:])) if raw.ndim > 3 else 1
    if raw.ndim > 4:
        raw = raw.reshape(dims + (nvols,))
    affine = affine_from_header(h)
    phys0 = raw[..., 0].astype(np.float64) if raw.ndim == 4 else raw.astype(np.float64)
    phys0 = phys0 * slope + inter
    label = is_label_volume(phys0, h.intent_code) if force_label is None else force_label
    return Volume(
        path=str(path),
        dims=dims,  # type: ignore[arg-type]
        nvols=nvols,
        affine=affine,
        inv_affine=np.linalg.inv(affine),
        raw=raw,
        scl_slope=slope,
        scl_inter=inter,
        is_label=label,
        header=h,
    )
