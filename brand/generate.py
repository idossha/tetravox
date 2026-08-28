#!/usr/bin/env python3
"""Generate every Tetravox brand asset from exact geometry.

Nothing here is traced. The mark is a cube (the voxel) with one corner sliced
off, and the tetrahedron (the finite element) that came out of that corner,
rotated and lifted clear of the socket. Both solids are real polyhedra in 3D;
this script projects them isometrically, hides the back faces, and shades each
visible face by a fixed Lambert term, so every coordinate in the SVG is
computed rather than drawn by hand. Edit the constants at the top and re-run.

    python3 brand/generate.py            # write brand/ + exports
    python3 brand/generate.py --svg      # SVGs only, no PNG/ICNS/ICO
    python3 brand/generate.py --regen-wordmark FONT.ttf

Only the last mode needs a third-party package (fontTools); it re-derives the
baked-in `Tetravox` letter outlines and rewrites this file's WORDMARK block.
Everything else runs on the standard library. PNG rasterisation shells out to
`rsvg-convert`, `.icns` to `iconutil` (macOS), and `.ico` is written by the
tiny writer at the bottom of this file (PIL if present, otherwise by hand).
"""

from __future__ import annotations

import argparse
import math
import re
import shutil
import struct
import subprocess
from pathlib import Path

# ------------------------------------------------------------------------------------------------
# Palette — two hues from packages/app/src/renderer/src/theme/tokens.ts, no neon.
# ------------------------------------------------------------------------------------------------

#: The cube. Graphite, the app's `bg`/`panel`/`lineStrong` family.
GRAPHITE_DARK = "#313846"
GRAPHITE_LIGHT = "#6f7889"

#: The tetrahedron. The one accent, `#3b5ba9` on white / `#93aae2` on graphite.
ACCENT_DARK = "#3b5ba9"
ACCENT_LIGHT = "#a8bcea"

#: Inside the cut. Darker than any lit face, so the socket reads as a cavity —
#: but not black: a black wedge this large stops being a hole and becomes a
#: second silhouette competing with the cube's.
CAVITY = "#252c39"

#: The seam between two facets. One value for every edge in the mark, dark
#: enough to survive a 16 px downsample without turning into mud.
SEAM = "#1b2029"

#: Ink for the monochrome variant and the wordmark.
INK = "#15181d"

#: The wordmark's ink on a dark ground. GitHub renders a README on `#0d1117`, where
#: `INK` is invisible — the mark survives (it carries its own graphite and accent),
#: the type does not. Same geometry, one colour swapped; near-white rather than pure
#: white so the letters do not out-glare the mark beside them.
INK_ON_DARK = "#eef1f6"

#: The macOS-style icon plate.
PLATE_DARK = "#1b1f26"
PLATE_LIGHT = "#2b313b"

# ------------------------------------------------------------------------------------------------
# Geometry constants.
# ------------------------------------------------------------------------------------------------

#: How far down each of the three edges at the near corner the cut plane bites.
#: Larger = a bigger tetrahedron and a bigger socket.
CUT = 0.56

#: Rotation of the freed tetrahedron about the vertical axis, degrees. A corner
#: tetrahedron seen down the cube diagonal projects to a flat triangle with no
#: interior edges — it stops reading as a solid. Turning it off that axis brings
#: the silhouette and one interior edge back.
TET_SPIN = 0.0

#: Tilt of the tetrahedron about the screen horizontal, degrees.
TET_TILT = 0.0

#: How far the tetrahedron is lifted out of the socket, in cube edge lengths.
TET_LIFT = 0.45

#: Uniform scale on the tetrahedron. Slightly over 1 so the freed element reads
#: as the subject of the mark rather than as debris.
TET_SCALE = 1.20

#: Direction the light comes from, in cube axes. Mostly overhead, biased to the
#: right-hand face, so top > right > left and the two solids share one sun.
LIGHT = (0.30, 0.12, 1.0)

#: Canvas. The mark is fitted into this box with MARK_PAD on every side.
SIZE = 256.0
MARK_PAD = 14.0

#: Hairline between adjacent faces. Keyed to the canvas, so it scales.
STROKE = SIZE / 256.0 * 1.6

# ------------------------------------------------------------------------------------------------
# Linear algebra. Small enough that numpy would be a dependency for nothing.
# ------------------------------------------------------------------------------------------------

Vec = tuple[float, float, float]


def sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def scale(a: Vec, k: float) -> Vec:
    return (a[0] * k, a[1] * k, a[2] * k)


def cross(a: Vec, b: Vec) -> Vec:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(a: Vec) -> Vec:
    n = math.sqrt(dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n)


def rot_z(v: Vec, deg: float) -> Vec:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return (v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2])


# ------------------------------------------------------------------------------------------------
# Isometric camera.
# ------------------------------------------------------------------------------------------------

#: True isometric: the eye sits on the cube diagonal, so the three cube axes
#: project 120 degrees apart and all three edge lengths come out equal.
VIEW = norm((1.0, 1.0, 1.0))
RIGHT = norm(cross((0.0, 0.0, 1.0), VIEW))  # screen +x
UP = cross(VIEW, RIGHT)  # screen +y, before the SVG flip


def project(p: Vec) -> tuple[float, float]:
    """World point -> SVG point, y already flipped."""
    return (dot(p, RIGHT), -dot(p, UP))


def rot_screen_x(v: Vec, deg: float) -> Vec:
    """Rotate about the screen horizontal — the axis that tilts a solid towards
    or away from the viewer without twisting its silhouette."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    x, y, z = dot(v, RIGHT), dot(v, UP), dot(v, VIEW)
    y2, z2 = y * c - z * s, y * s + z * c
    return add(add(scale(RIGHT, x), scale(UP, y2)), scale(VIEW, z2))


# ------------------------------------------------------------------------------------------------
# Solids. A face is a list of vertices wound counter-clockwise seen from outside.
# ------------------------------------------------------------------------------------------------


def orient(faces: list[list[Vec]]) -> list[list[Vec]]:
    """Force every face of a convex solid to wind counter-clockwise from outside.

    Getting a winding wrong by hand is silent — the face simply vanishes into the
    back-face cull — so the windings above are not trusted. Each face is flipped
    if its normal points at the solid's centroid instead of away from it.
    """
    pts = [v for f in faces for v in f]
    n = len(pts)
    centre = (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n, sum(p[2] for p in pts) / n)
    out = []
    for f in faces:
        mid = (
            sum(p[0] for p in f) / len(f),
            sum(p[1] for p in f) / len(f),
            sum(p[2] for p in f) / len(f),
        )
        out.append(f if dot(face_normal(f), sub(mid, centre)) > 0 else list(reversed(f)))
    return out


def face_normal(face: list[Vec]) -> Vec:
    return norm(cross(sub(face[1], face[0]), sub(face[2], face[0])))


def front_facing(face: list[Vec]) -> bool:
    return dot(face_normal(face), VIEW) > 1e-9


def depth(face: list[Vec]) -> float:
    """Painter's-algorithm key: how far along the view axis the face sits."""
    return sum(dot(v, VIEW) for v in face) / len(face)


def cut_cube(t: float) -> tuple[list[list[Vec]], list[Vec]]:
    """The unit cube with the corner at (1,1,1) sliced off.

    Returns the cube's own faces and, separately, the triangular cut face, so
    the caller can paint the cut as a cavity rather than as a lit surface.
    """
    a: Vec = (1 - t, 1.0, 1.0)
    b: Vec = (1.0, 1 - t, 1.0)
    c: Vec = (1.0, 1.0, 1 - t)
    o = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0)]
    p = [(0.0, 0.0, 1.0), (1.0, 0.0, 1.0), (0.0, 1.0, 1.0)]
    faces: list[list[Vec]] = [
        [p[0], p[1], b, a, p[2]],  # z = 1, pentagon
        [o[0], o[3], o[2], o[1]],  # z = 0
        [p[1], o[1], o[2], c, b],  # x = 1, pentagon
        [p[0], p[2], o[3], o[0]],  # x = 0
        [p[2], a, c, o[2], o[3]],  # y = 1, pentagon
        [p[0], o[0], o[1], p[1]],  # y = 0
    ]
    return orient(faces), [a, b, c]


def freed_tet(t: float) -> list[list[Vec]]:
    """The corner piece the cut removed, spun, tilted, scaled and lifted."""
    v: Vec = (1.0, 1.0, 1.0)
    pts = [v, (1 - t, 1.0, 1.0), (1.0, 1 - t, 1.0), (1.0, 1.0, 1 - t)]
    centre = scale((sum(p[0] for p in pts), sum(p[1] for p in pts), sum(p[2] for p in pts)), 0.25)

    def place(p: Vec) -> Vec:
        q = scale(sub(p, centre), TET_SCALE)
        q = rot_z(q, TET_SPIN)
        q = rot_screen_x(q, TET_TILT)
        return add(add(q, centre), (0.0, 0.0, TET_LIFT))

    w, x, y, z = (place(p) for p in pts)
    # Wound so every normal points out of the solid.
    return orient([[w, y, x], [w, z, y], [w, x, z], [x, y, z]])


# ------------------------------------------------------------------------------------------------
# Shading and SVG assembly.
# ------------------------------------------------------------------------------------------------


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))  # type: ignore[return-value]


def mix(dark: str, light: str, k: float) -> str:
    """Lerp in sRGB. Both ends are already muted, so no gamma games are needed
    to keep the midpoint out of neon territory."""
    d, l = hex_to_rgb(dark), hex_to_rgb(light)
    return "#%02x%02x%02x" % tuple(round(d[i] + (l[i] - d[i]) * k) for i in range(3))


def lambert(face: list[Vec]) -> float:
    """Flat shading term in [0, 1]. Ambient floor of 0.18 so no face goes black."""
    k = dot(face_normal(face), norm(LIGHT))
    return 0.18 + 0.82 * max(0.0, k)


class Fitter:
    """Maps projected units into the canvas, preserving aspect and centring."""

    def __init__(self, pts: list[tuple[float, float]], size: float, pad: float) -> None:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        self.k = (size - 2 * pad) / max(w, h)
        self.dx = pad + (size - 2 * pad - w * self.k) / 2 - min(xs) * self.k
        self.dy = pad + (size - 2 * pad - h * self.k) / 2 - min(ys) * self.k

    def __call__(self, p: Vec) -> tuple[float, float]:
        x, y = project(p)
        return (x * self.k + self.dx, y * self.k + self.dy)


def poly(
    fit: Fitter,
    face: list[Vec],
    fill: str,
    stroke: str,
    opacity: float | None = None,
) -> str:
    pts = " ".join("%.3f,%.3f" % fit(v) for v in face)
    op = f' fill-opacity="{opacity:.2f}"' if opacity is not None else ""
    return (
        f'  <polygon points="{pts}" fill="{fill}"{op} stroke="{stroke}" '
        f'stroke-width="{STROKE:.3f}" stroke-linejoin="round"/>'
    )


def mark_body(mono: bool, size: float = SIZE, pad: float = MARK_PAD) -> str:
    """The shared drawing routine: one cut cube, one socket, one freed tet."""
    cube, socket = cut_cube(CUT)
    tet = freed_tet(CUT)

    visible_cube = [f for f in cube if front_facing(f)]
    visible_tet = [f for f in tet if front_facing(f)]
    fit = Fitter(
        [project(v) for f in visible_cube + visible_tet + [socket] for v in f], size, pad
    )

    out: list[str] = []
    if mono:
        # One ink, one seam colour. Two things differ from the colour mark, and
        # both are forced by having no hue to separate the solids with:
        #
        #  * The seam is the paper, not a darker ink. At 16 px a dark hairline
        #    between two dark facets fills in and the facets silt together.
        #  * The socket is *lighter* than the tetrahedron, inverting the colour
        #    mark. There, hue tells the dark cavity apart from the dark blue
        #    element; here they would merge into one blob directly under the
        #    tet's apex, which is exactly where the mark has to stay readable.
        seam = "#ffffff"
        for f in sorted(visible_cube, key=depth):
            out.append(poly(fit, f, INK, seam, 0.12 + 0.16 * lambert(f)))
        out.append(poly(fit, socket, INK, seam, 0.40))
        for f in sorted(visible_tet, key=depth):
            out.append(poly(fit, f, INK, seam, 0.66 + 0.34 * lambert(f)))
    else:
        for f in sorted(visible_cube, key=depth):
            out.append(poly(fit, f, mix(GRAPHITE_DARK, GRAPHITE_LIGHT, lambert(f)), SEAM))
        out.append(poly(fit, socket, CAVITY, SEAM))
        for f in sorted(visible_tet, key=depth):
            out.append(poly(fit, f, mix(ACCENT_DARK, ACCENT_LIGHT, lambert(f)), SEAM))
    return "\n".join(out)


HEADER = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" '
    'width="{w:g}" height="{h:g}" role="img" aria-label="{label}">\n'
    "  <title>{label}</title>\n"
)


def svg_mark(mono: bool = False) -> str:
    label = "Tetravox"
    return (
        HEADER.format(w=SIZE, h=SIZE, label=label)
        + mark_body(mono)
        + "\n</svg>\n"
    )


def svg_plate(radius_ratio: float = 0.2237, inset: float = 0.0, pad: float = 0.12) -> str:
    """The macOS-style plate: a rounded square on a 1024 grid.

    Apple's macOS icon grid puts a 824 x 824 rounded square inside a 1024 box
    (so 100 px of clear space on each side) with a corner radius of 0.2237 of
    the square's side. Those two ratios are what `inset` and `radius_ratio`
    carry; the mark then sits inside the square with its own margin, `pad`.

    `pad` is the one knob the favicon turns down: at 16 px the app-icon margin
    leaves the mark about ten pixels wide and it goes to mush, so the favicon
    plate has no outer inset and a much tighter margin than the dock icon does.
    """
    box = SIZE
    side = box * (1 - 2 * inset)
    x0 = box * inset
    r = side * radius_ratio
    body = mark_body(False, size=side, pad=side * pad)
    return (
        HEADER.format(w=box, h=box, label="Tetravox")
        + f'  <defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{PLATE_LIGHT}"/>'
        f'<stop offset="1" stop-color="{PLATE_DARK}"/></linearGradient></defs>\n'
        f'  <rect x="{x0:.3f}" y="{x0:.3f}" width="{side:.3f}" height="{side:.3f}" '
        f'rx="{r:.3f}" ry="{r:.3f}" fill="url(#p)"/>\n'
        f'  <g transform="translate({x0:.3f},{x0:.3f})">\n'
        + body
        + "\n  </g>\n</svg>\n"
    )


# ------------------------------------------------------------------------------------------------
# Wordmark. Outlines are baked in below so this script has no font dependency;
# --regen-wordmark rewrites them from a variable Jost (SIL OFL 1.1).
# ------------------------------------------------------------------------------------------------

# WORDMARK-BEGIN
WORDMARK_PATH = "M7.5 591.2H192.5V0.0H311.2V591.2H496.2V700.0H7.5Z M761.2-10.0Q840.8-10.0 898.0 21.2Q955.2 52.5 991.5 114.5L898.2 152.2Q876.5 115.2 843.5 97.0Q810.5 78.8 766.2 78.8Q724.2 78.8 694.9 97.0Q665.5 115.2 650.4 149.9Q635.2 184.5 635.5 233.8Q636.2 284.0 651.4 318.0Q666.5 352.0 695.1 369.8Q723.8 387.5 765.0 387.5Q799.2 387.5 824.6 372.5Q850.0 357.5 864.4 330.8Q878.8 304.0 878.8 267.2Q878.8 260.2 875.5 249.9Q872.2 239.5 868.5 233.5L902.0 279.5H590.5V205.0H994.5Q995.0 209.2 995.4 218.0Q995.8 226.8 995.8 235.2Q995.8 308.8 968.6 361.4Q941.5 414.0 890.2 442.0Q839.0 470.0 766.2 470.0Q693.2 470.0 639.1 440.4Q585.0 410.8 555.4 356.9Q525.8 303.0 525.8 230.0Q525.8 158.0 555.0 104.1Q584.2 50.2 637.5 20.1Q690.8-10.0 761.2-10.0Z M1024.0 460.0V365.0H1285.2V460.0ZM1101.5 620.0V0.0H1207.8V620.0Z M1454.2 460.0H1346.8V0.0H1454.2ZM1590.8 344.5 1643.5 436.0Q1627.8 454.5 1605.8 462.5Q1583.8 470.5 1558.8 470.5Q1524.2 470.5 1491.6 445.4Q1459.0 420.2 1438.6 377.6Q1418.2 335.0 1418.2 280.0L1454.2 258.8Q1454.2 291.8 1461.8 316.5Q1469.2 341.2 1486.2 355.0Q1503.2 368.8 1530.0 368.8Q1550.0 368.8 1563.2 362.6Q1576.5 356.5 1590.8 344.5Z M1774.2 142.8Q1774.2 164.5 1784.5 179.9Q1794.8 195.2 1816.0 203.8Q1837.2 212.2 1871.2 212.2Q1910.2 212.2 1945.1 202.1Q1980.0 192.0 2010.5 170.2V225.2Q2001.5 236.0 1979.9 249.5Q1958.2 263.0 1924.8 273.1Q1891.2 283.2 1844.8 283.2Q1759.0 283.2 1711.8 243.5Q1664.5 203.8 1664.5 137.0Q1664.5 90.0 1686.8 57.1Q1709.0 24.2 1745.9 7.1Q1782.8-10.0 1825.5-10.0Q1866.0-10.0 1904.4 4.6Q1942.8 19.2 1968.1 48.9Q1993.5 78.5 1993.5 122.5L1977.5 182.5Q1977.5 148.0 1961.5 122.8Q1945.5 97.5 1919.0 84.1Q1892.5 70.8 1860.0 70.8Q1835.2 70.8 1815.8 79.0Q1796.2 87.2 1785.2 103.6Q1774.2 120.0 1774.2 142.8ZM1740.0 340.0Q1750.5 347.2 1770.8 357.6Q1791.0 368.0 1819.4 375.6Q1847.8 383.2 1880.2 383.2Q1901.2 383.2 1919.2 379.1Q1937.2 375.0 1950.4 366.1Q1963.5 357.2 1970.5 342.9Q1977.5 328.5 1977.5 307.2V0.0H2083.8V327.5Q2083.8 373.8 2059.1 405.6Q2034.5 437.5 1990.9 454.4Q1947.2 471.2 1890.5 471.2Q1826.0 471.2 1776.8 453.0Q1727.5 434.8 1696.0 415.8Z M2127.8 460.0 2366.5-42.5 2605.2 460.0H2486.5L2366.5 163.0L2246.5 460.0Z M2625.8 230.0Q2625.8 159.8 2658.4 105.4Q2691.0 51.0 2747.2 20.5Q2803.5-10.0 2873.8-10.0Q2944.8-10.0 3000.6 20.5Q3056.5 51.0 3089.1 105.4Q3121.8 159.8 3121.8 230.0Q3121.8 301.2 3089.1 355.2Q3056.5 409.2 3000.6 439.8Q2944.8 470.2 2873.8 470.2Q2803.5 470.2 2747.2 439.8Q2691.0 409.2 2658.4 355.2Q2625.8 301.2 2625.8 230.0ZM2736.8 230.0Q2736.8 273.0 2754.9 305.9Q2773.0 338.8 2804.0 357.0Q2835.0 375.2 2873.8 375.2Q2912.5 375.2 2943.5 357.0Q2974.5 338.8 2992.6 305.9Q3010.8 273.0 3010.8 230.0Q3010.8 187.0 2992.6 154.5Q2974.5 122.0 2943.5 103.5Q2912.5 85.0 2873.8 85.0Q2835.0 85.0 2804.0 103.5Q2773.0 122.0 2754.9 154.5Q2736.8 187.0 2736.8 230.0Z M3477.8 460.0 3377.5 315.8 3277.8 460.0H3154.0L3319.8 236.8L3144.0 0.0H3267.8L3377.5 157.8L3487.8 0.0H3609.0L3434.2 236.8L3599.0 460.0Z"
WORDMARK_WIDTH = 3609.0
WORDMARK_ASCENT = 700.0
WORDMARK_DESCENT = 375.0
# WORDMARK-END


def svg_wordmark(dark: bool = False) -> str:
    """Mark on the left, `Tetravox` set in outlines on the right.

    `dark=True` is the same file with the type in `INK_ON_DARK` — every coordinate
    is identical, so the light and dark PNGs are interchangeable inside a
    `<picture>` and swapping themes does not move the header by a pixel.
    """
    if not WORDMARK_PATH:
        raise SystemExit("wordmark outlines are empty — run --regen-wordmark FONT.ttf first")
    cap = SIZE * 0.46  # cap height of the type, relative to the mark's box
    k = cap / WORDMARK_ASCENT
    gap = SIZE * 0.20
    tx = SIZE + gap
    total_w = tx + WORDMARK_WIDTH * k
    baseline = SIZE / 2 + cap / 2
    return (
        HEADER.format(w=round(total_w, 3), h=SIZE, label="Tetravox")
        + mark_body(False)
        + f'\n  <g transform="translate({tx:.3f},{baseline:.3f}) scale({k:.6f},{-k:.6f})" '
        f'fill="{INK_ON_DARK if dark else INK}">\n    <path d="{WORDMARK_PATH}"/>\n  </g>\n</svg>\n'
    )


def regen_wordmark(font_path: str) -> None:
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    font = TTFont(font_path)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": 500}, updateFontNames=False)
    upem = font["head"].unitsPerEm
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    kern_units = -0.012 * upem  # a touch of negative tracking; geometric sans sets wide

    pen_out: list[str] = []
    x = 0.0
    for ch in "Tetravox":
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: f"{v:.1f}")
        gs[name].draw(pen)
        d = pen.getCommands()
        if d:
            pen_out.append(_translate_path(d, x, 0.0))
        x += gs[name].width + kern_units

    cap_height = font["OS/2"].sCapHeight if hasattr(font["OS/2"], "sCapHeight") else upem * 0.7
    path = " ".join(p for p in pen_out if p)
    src = Path(__file__).read_text()
    block = (
        "# WORDMARK-BEGIN\n"
        f'WORDMARK_PATH = "{path}"\n'
        f"WORDMARK_WIDTH = {x - kern_units:.1f}\n"
        f"WORDMARK_ASCENT = {cap_height:.1f}\n"
        f"WORDMARK_DESCENT = {abs(font['OS/2'].sTypoDescender):.1f}\n"
        "# WORDMARK-END"
    )
    src = re.sub(r"# WORDMARK-BEGIN\n.*?# WORDMARK-END", block, src, flags=re.S)
    Path(__file__).write_text(src)
    print(f"wordmark outlines regenerated from {font_path} ({len(path)} chars)")


def _translate_path(d: str, dx: float, dy: float) -> str:
    """Shift an absolute SVG path by (dx, dy).

    fontTools' SVGPathPen emits absolute commands only, and only M/L/Q/C/Z, so
    a translation is a pure per-coordinate add — no arc endpoint parametrisation
    to worry about. H and V are the one wrinkle: they carry a single coordinate,
    and which axis it belongs to depends on the command.
    """
    args = {"M": 2, "L": 2, "Q": 4, "C": 6, "Z": 0, "H": 1, "V": 1}
    tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", d)
    out: list[str] = []
    i = 0
    cmd = "M"
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i].upper()
            out.append(cmd)
            i += 1
            if cmd == "Z":
                continue
        n = args[cmd]
        for j in range(n):
            axis = dy if (cmd == "V" or (cmd != "H" and j % 2)) else dx
            v = float(tokens[i + j]) + axis
            out.append(f"{v:.1f}")
        i += n
    # Join tightly: a minus sign is its own separator, so only positives need a
    # space in front of them.
    text = ""
    for tok in out:
        if tok.isalpha() or not text or text[-1].isalpha() or tok.startswith("-"):
            text += tok
        else:
            text += " " + tok
    return text


# ------------------------------------------------------------------------------------------------
# Raster exports.
# ------------------------------------------------------------------------------------------------


def rasterise(svg: Path, png: Path, width: int, height: int | None = None) -> None:
    """Render an SVG to PNG. `height=None` keeps the SVG's aspect ratio."""
    png.parent.mkdir(parents=True, exist_ok=True)
    if shutil.which("rsvg-convert"):
        cmd = ["rsvg-convert", "-w", str(width)]
        if height is not None:
            cmd += ["-h", str(height)]
        subprocess.run(cmd + ["-o", str(png), str(svg)], check=True)
        return
    try:
        import cairosvg  # type: ignore

        cairosvg.svg2png(
            url=str(svg), write_to=str(png), output_width=width, output_height=height
        )
        return
    except ImportError:
        pass
    raise SystemExit("no rasteriser: install librsvg (rsvg-convert) or cairosvg")


def write_icns(iconset_src: Path, out: Path) -> None:
    if not shutil.which("iconutil"):
        print("  (skipping .icns — iconutil is macOS-only)")
        return
    subprocess.run(["iconutil", "-c", "icns", "-o", str(out), str(iconset_src)], check=True)


def write_ico(frames: list[tuple[int, Path]], out: Path) -> None:
    """ICO container around PNG-compressed images.

    Every Windows since Vista reads PNG-in-ICO, which is why this needs no BMP
    encoder and no image library at all: the frames are already PNG bytes on
    disk. The one trap is the directory entry's width/height byte — it is a
    *byte*, and 256 is written as 0, which is the documented encoding for it.
    """
    blobs = [(size, path.read_bytes()) for size, path in frames]
    header = struct.pack("<HHH", 0, 1, len(blobs))
    entries = b""
    offset = 6 + 16 * len(blobs)
    for size, data in blobs:
        byte = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", byte, byte, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    out.write_bytes(header + entries + b"".join(d for _, d in blobs))


def png_size(path: Path) -> tuple[int, int]:
    """Read an IHDR without decoding, to assert an export came out right."""
    b = path.read_bytes()
    assert b[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", b[16:24])


# ------------------------------------------------------------------------------------------------
# Entry point.
# ------------------------------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
BUILD = ROOT / "packages" / "app" / "build"
WEB = ROOT / "website" / "public"
DOCS = ROOT / "docs" / "media"

LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
ICO_SIZES = [16, 32, 48, 64, 128, 256]
ICNS_SIZES = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2),
              (512, 1), (512, 2)]


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print(f"  {path.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--svg", action="store_true", help="write SVGs only")
    ap.add_argument("--regen-wordmark", metavar="FONT.ttf")
    args = ap.parse_args()

    if args.regen_wordmark:
        regen_wordmark(args.regen_wordmark)
        return

    print("svg")
    mark = BRAND / "tetravox-mark.svg"
    plate = BRAND / "tetravox-plate.svg"
    write(mark, svg_mark(mono=False))
    write(BRAND / "tetravox-mark-mono.svg", svg_mark(mono=True))
    write(BRAND / "tetravox-wordmark.svg", svg_wordmark())
    write(BRAND / "tetravox-wordmark-dark.svg", svg_wordmark(dark=True))
    write(plate, svg_plate(inset=100 / 1024))
    write(WEB / "logo.svg", svg_mark(mono=False))
    # The favicon is the plate: a bare mark at 16 px has no ground to sit on and
    # dissolves into whatever the browser paints behind the tab strip.
    write(WEB / "favicon.svg", svg_plate(inset=0.0, radius_ratio=0.20, pad=0.055))
    favicon_src = BRAND / ".favicon-src.svg"
    favicon_src.write_text(svg_plate(inset=0.0, radius_ratio=0.20, pad=0.055))

    if args.svg:
        return

    print("png")
    rasterise(plate, BUILD / "icon.png", 1024, 1024)
    assert png_size(BUILD / "icon.png") == (1024, 1024)
    print(f"  {(BUILD / 'icon.png').relative_to(ROOT)}")

    for size in LINUX_SIZES:
        rasterise(plate, BUILD / "icons" / f"{size}x{size}.png", size, size)
    print(f"  {(BUILD / 'icons').relative_to(ROOT)}/*.png {LINUX_SIZES}")

    rasterise(favicon_src, WEB / "favicon.png", 180, 180)
    print(f"  {(WEB / 'favicon.png').relative_to(ROOT)}")

    # The README header is the wordmark, not the bare mark, and it is not square
    # — height follows from the SVG's own aspect ratio.
    rasterise(BRAND / "tetravox-wordmark.svg", DOCS / "logo.png", 1200)
    print(f"  {(DOCS / 'logo.png').relative_to(ROOT)} {png_size(DOCS / 'logo.png')}")
    # The dark-theme twin. README.md picks between the two with `<picture>` +
    # `prefers-color-scheme`, which GitHub honours.
    rasterise(BRAND / "tetravox-wordmark-dark.svg", DOCS / "logo-dark.png", 1200)
    print(f"  {(DOCS / 'logo-dark.png').relative_to(ROOT)} {png_size(DOCS / 'logo-dark.png')}")

    print("ico")
    frames_dir = BRAND / ".ico-frames"
    frames_dir.mkdir(exist_ok=True)
    frames = []
    for size in ICO_SIZES:
        png = frames_dir / f"{size}.png"
        rasterise(plate, png, size, size)
        frames.append((size, png))
    write_ico(frames, BUILD / "icon.ico")
    print(f"  {(BUILD / 'icon.ico').relative_to(ROOT)} {ICO_SIZES}")

    print("icns")
    iconset = BRAND / ".tetravox.iconset"
    shutil.rmtree(iconset, ignore_errors=True)
    iconset.mkdir()
    for base, multiplier in ICNS_SIZES:
        suffix = "" if multiplier == 1 else "@2x"
        png = iconset / f"icon_{base}x{base}{suffix}.png"
        rasterise(plate, png, base * multiplier, base * multiplier)
    write_icns(iconset, BUILD / "icon.icns")
    print(f"  {(BUILD / 'icon.icns').relative_to(ROOT)}")

    shutil.rmtree(frames_dir)
    shutil.rmtree(iconset)
    favicon_src.unlink()


if __name__ == "__main__":
    main()
