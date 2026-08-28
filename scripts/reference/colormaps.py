"""§7.6's colormaps and the `Scale` LUT bake, in Python — **reading the engine's own tables**.

The two renderers must share *data*, never code. So this module does not carry a second copy of
the 15 colormaps: it parses `packages/engine/src/color/colormaps.ts` and lifts `TABLES` and
`POSITIONS` out of it verbatim. A stop edited in the TypeScript moves this renderer on the next
run, and a hand-transcribed table that drifted by one 8-bit level — the exact failure a reference
implementation exists to catch — cannot happen.

Everything else here is an *independent* implementation of §7.6 / §4.2 from the prose:
`scalePosition`, the texel-centre bake, the `NEAREST` texel selection and `heat`'s `clipMax`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

# scripts/reference/colormaps.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
COLORMAPS_TS = REPO_ROOT / "packages" / "engine" / "src" / "color" / "colormaps.ts"

# §7.6 / §4.1's frozen `ColormapName` union, in declaration order.
EXPECTED_NAMES = (
    "gray",
    "viridis",
    "plasma",
    "inferno",
    "magma",
    "cividis",
    "turbo",
    "jet",
    "hot",
    "cool",
    "bone",
    "coolwarm",
    "bwr",
    "freesurfer-heat",
    "blue-cyan",
)


def _object_literal(src: str, decl: str) -> str:
    """The `{ ... }` that follows `decl` in `src`, by brace matching."""
    at = src.index(decl)
    start = src.index("{", at)
    depth = 0
    for i in range(start, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
    raise ValueError(f"unbalanced braces after {decl!r}")


def _ts_object_to_json(text: str) -> dict:
    """A TS object literal of plain data -> JSON. Comments, bare keys, trailing commas."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    text = text.replace("'", '"')
    text = re.sub(r'([{,]\s*)([A-Za-z_$][\w$-]*)\s*:', r'\1"\2":', text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return json.loads(text)


def load_tables(path: Path = COLORMAPS_TS) -> tuple[dict[str, list], dict[str, list]]:
    """`(TABLES, POSITIONS)` as read out of the engine's TypeScript source."""
    src = path.read_text(encoding="utf-8")
    tables = _ts_object_to_json(_object_literal(src, "const TABLES"))
    positions = _ts_object_to_json(_object_literal(src, "const POSITIONS"))
    return tables, positions


TABLES, POSITIONS = load_tables()


def sample_colormap(name: str, t: float) -> tuple[int, int, int]:
    """§7.6's `sampleColormap`: piecewise-linear over the stops, RGB 0..255, `t` clamped."""
    stops = TABLES[name]
    pos = POSITIONS.get(name) or [i / (len(stops) - 1) for i in range(len(stops))]
    u = 0.0 if t <= 0 else 1.0 if t >= 1 else float(t)
    i = 0
    while i < len(pos) - 2 and u > pos[i + 1]:
        i += 1
    a, b = stops[i], stops[i + 1] if i + 1 < len(stops) else stops[i]
    p0, p1 = pos[i], pos[i + 1] if i + 1 < len(pos) else 1.0
    f = (u - p0) / (p1 - p0) if p1 > p0 else 0.0
    return tuple(int(round(a[c] + (b[c] - a[c]) * f)) for c in range(3))  # type: ignore[return-value]


# ---------------------------------------------------------------------------------------------
# §4.2's Scale
# ---------------------------------------------------------------------------------------------


def scale_position(scale: dict, v: float) -> float:
    """§4.2/§7.6's `scalePosition` — the 0..1 position a value takes before the colormap.

    `heat` is the two-segment FreeSurfer ramp: `min..mid` covers the lower half of the colormap and
    `mid..max` the upper half, so the overlay saturates at `mid`. `inverse` reverses the ramp
    (`t -> 1 - t`); it is a property of the colours, so it applies to both branches.
    """
    if scale["kind"] == "linear":
        d = scale["hi"] - scale["lo"]
        return 0.0 if d == 0 else (v - scale["lo"]) / d
    lo, mid, hi = scale["min"], scale["mid"], scale["max"]
    a = abs(v)
    if a <= lo:
        t = 0.0
    elif a <= mid:
        t = (0.5 * (a - lo) / (mid - lo)) if mid > lo else 0.5
    elif a <= hi:
        t = (0.5 + 0.5 * (a - mid) / (hi - mid)) if hi > mid else 1.0
    else:
        t = 1.0
    return 1.0 - t if scale.get("inverse") else t


@dataclass(frozen=True)
class BakedLut:
    """§7.6's `BakedLut`: the texture the slice shader samples, plus what rides beside it."""

    rgba: np.ndarray  # (width, 4) uint8
    width: int
    lo: float
    hi: float
    signed: bool
    clip_max: float


def bake_scale(scale: dict, colormap: str, negative_colormap: str = "blue-cyan") -> BakedLut:
    """§7.6's `bakeScale`, baked at **texel centres** `(i + 0.5) / width`.

    That is the value a `NEAREST` fetch at texel `i` actually represents; baking at
    `i / (width - 1)` offsets every texel by up to half a texel and makes an analytic assertion
    argue with the driver's rounding instead of with the rendering.
    """
    separate = scale["kind"] == "heat" and scale.get("negative") == "separate"
    width = 512 if separate else 256
    rgba = np.zeros((width, 4), dtype=np.uint8)
    lo = scale["lo"] if scale["kind"] == "linear" else -scale["max"]
    hi = scale["hi"] if scale["kind"] == "linear" else scale["max"]

    for i in range(width):
        u = (i + 0.5) / width
        v = lo + u * (hi - lo)
        alpha = 255
        if scale["kind"] == "linear":
            rgb = sample_colormap(colormap, scale_position(scale, v))
        else:
            t = scale_position(scale, v)
            if v < 0:
                mode = scale.get("negative", "mirror")
                if mode == "hide":
                    rgb, alpha = (0, 0, 0), 0
                elif mode == "mirror":
                    rgb = sample_colormap(colormap, t)
                else:
                    rgb = sample_colormap(negative_colormap, t)
            else:
                rgb = sample_colormap(colormap, t)
            # The dead band around zero: below `min` a heat scale contributes nothing, which is
            # what makes it an overlay. One rule for all three negative modes.
            if abs(v) < scale["min"]:
                alpha = 0
        rgba[i, 0], rgba[i, 1], rgba[i, 2], rgba[i, 3] = rgb[0], rgb[1], rgb[2], alpha

    clip_max = (
        scale["max"] if scale["kind"] == "heat" and scale.get("truncate") else float("inf")
    )
    return BakedLut(rgba=rgba, width=width, lo=float(lo), hi=float(hi), signed=separate,
                    clip_max=float(clip_max))


def lut_texel_of(baked: BakedLut, v: np.ndarray | float) -> np.ndarray:
    """The texel a value lands in: `min(width - 1, floor(clamp(t, 0, 1) * width))`.

    This is the **shader's** arithmetic — `texture(uLut, vec2(clamp(t,0,1), 0.5))` with `NEAREST`
    on a `width x 1` texture — done on the CPU.
    """
    t = (np.asarray(v, dtype=np.float64) - baked.lo) / max(1e-20, baked.hi - baked.lo)
    c = np.clip(t, 0.0, 1.0)
    return np.minimum(baked.width - 1, np.floor(c * baked.width).astype(np.int64))


def lut_sample(baked: BakedLut, v: np.ndarray | float) -> np.ndarray:
    """RGBA 0..255 for `v` (any shape), before the layer's own opacity."""
    return baked.rgba[lut_texel_of(baked, v)]


# ---------------------------------------------------------------------------------------------
# Label LUTs (§7.6) — the `id name r g b [a]` shape SimNIBS and FreeSurfer share
# ---------------------------------------------------------------------------------------------


def parse_label_lut(path: str | Path) -> dict[int, tuple[int, int, int, int]]:
    """`#No.\\tLabel Name:\\tR G B A` -> `{id: (r, g, b, a)}`.

    Alpha is taken **verbatim** when present and defaults to 255 when the line stops at blue —
    `crates/tvx-core/src/lut.rs`'s rule, including its refusal to reinterpret FreeSurfer's 0.
    Unparseable lines are skipped, because every LUT in the wild carries trailing notes.
    """
    table: dict[int, tuple[int, int, int, int]] = {}
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.split("#", 1)[0].strip()
        if not s:
            continue
        f = s.split()
        if len(f) < 5:
            continue
        try:
            ident = int(f[0])
            r, g, b = (min(255, max(0, int(f[i]))) for i in (2, 3, 4))
        except ValueError:
            continue
        a = 255
        if len(f) >= 6:
            try:
                a = min(255, max(0, int(f[5])))
            except ValueError:
                a = 255
        table[ident] = (r, g, b, a)
    return table


def fallback_label_color(i: int) -> tuple[float, float, float, float]:
    """§7.6's glasbey-like fallback — `layers/volume.ts`'s golden-ratio hue rotation, 0..1."""
    h = (i * 0.618033988749895) % 1
    s = 0.55 + (i % 3) * 0.15
    v = 0.75 + (i % 2) * 0.2

    def k(n: float) -> float:
        return (n + h * 6) % 6

    def f(n: float) -> float:
        return v - v * s * max(0.0, min(min(k(n), 4 - k(n)), 1.0))

    return (f(5), f(3), f(1), 1.0)


def build_label_palette(
    ids: Sequence[int],
    table: dict[int, tuple[int, int, int, int]] | None,
    visible: Sequence[int] | None = None,
    label_opacity: dict[int, float] | None = None,
    label_colors: dict[int, Sequence[float]] | None = None,
) -> np.ndarray:
    """§7.3's `N x 1 RGBA8` palette, indexed by **dense** index — `palette[k]` is `ids[k]`'s colour.

    `visibleLabels` zeroes a label's alpha and `labelOpacity` scales it, exactly as
    `buildLabelPalette` does, so the outline/fill code below needs no branch for either.
    """
    vis = None if visible is None else set(int(v) for v in visible)
    pal = np.zeros((len(ids), 4), dtype=np.uint8)
    for k, ident in enumerate(ids):
        ident = int(ident)
        override = None if label_colors is None else label_colors.get(ident)
        if override is not None:
            c = tuple(float(x) for x in override)
        elif table is not None and ident in table:
            c = tuple(x / 255.0 for x in table[ident])
        elif ident == 0:
            c = (0.0, 0.0, 0.0, 0.0)
        else:
            c = fallback_label_color(k)
        hidden = vis is not None and ident not in vis
        op = 0.0 if hidden else float((label_opacity or {}).get(ident, 1.0))
        pal[k, 0] = round(c[0] * 255)
        pal[k, 1] = round(c[1] * 255)
        pal[k, 2] = round(c[2] * 255)
        pal[k, 3] = round(c[3] * 255 * min(1.0, max(0.0, op)))
    return pal
