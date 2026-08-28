"""A stdlib RGBA8 PNG writer.

Deliberately not Pillow: the reference renderer's whole value is that it shares nothing with the
engine but the data, and its only hard dependencies should be the ones `AGENTS.md` already names
(numpy, nibabel, scipy). Sixty lines of `zlib` + `struct` is cheaper than a fourth dependency, and
the output is byte-deterministic.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str | Path, rgba: np.ndarray) -> None:
    """Write an `(H, W, 4)` uint8 array as an 8-bit RGBA PNG, filter type 0 on every row."""
    a = np.ascontiguousarray(rgba, dtype=np.uint8)
    if a.ndim != 3 or a.shape[2] != 4:
        raise ValueError(f"expected (H, W, 4) uint8, got {a.shape}")
    h, w = a.shape[0], a.shape[1]
    rows = np.concatenate([np.zeros((h, 1), np.uint8), a.reshape(h, w * 4)], axis=1)
    body = zlib.compress(rows.tobytes(), 9)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", body)
        + _chunk(b"IEND", b"")
    )
    Path(path).write_bytes(png)


def read_png(path: str | Path) -> np.ndarray:
    """Read back an 8-bit RGBA PNG written by {@link write_png} (filter 0 only). For the tests."""
    raw = Path(path).read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, hdr = 8, b"", None
    while pos < len(raw):
        (n,) = struct.unpack(">I", raw[pos : pos + 4])
        tag = raw[pos + 4 : pos + 8]
        data = raw[pos + 8 : pos + 8 + n]
        if tag == b"IHDR":
            hdr = struct.unpack(">IIBBBBB", data)
        elif tag == b"IDAT":
            idat += data
        pos += 12 + n
    if hdr is None:
        raise ValueError("no IHDR")
    w, h, depth, colour = hdr[0], hdr[1], hdr[2], hdr[3]
    if (depth, colour) != (8, 6):
        raise ValueError(f"expected 8-bit RGBA, got depth={depth} colour={colour}")
    flat = np.frombuffer(zlib.decompress(idat), dtype=np.uint8).reshape(h, w * 4 + 1)
    if flat[:, 0].any():
        raise ValueError("this reader handles filter type 0 only")
    return flat[:, 1:].reshape(h, w, 4)
