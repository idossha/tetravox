#!/usr/bin/env python3
"""Build `docs/media/showcase.mp4` — the ~100-second tour of Tetravox.

Run it:

    pip install -e python/            # the `tetravox` client, standard library only
    scripts/fetch-data.sh             # puts the reference subject in data/ernie/
    pnpm wasm && pnpm --filter @tetravox/app build
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python examples/capture/showcase.py

Nothing here is hand-edited afterwards. The script writes six job documents, hands them to the app,
and stitches the frames with ffmpeg; the app renders offscreen through the same `Engine` calls a user
makes with the mouse, so every picture in the film is a picture the product produces.

**How to read it.** One function per shot, in the order they appear on screen. Each opens with the
numbers that shot is about — a zoom, a threshold, a rotation — so changing the film means changing a
constant, not unpicking a graph. Every shot calls `story(...)` with its caption and its frame count;
that one list is the caption burn-in, the timings, and `docs/media/SHOWCASE.md`, so those three
cannot drift apart.

**Six jobs, not one, for two different reasons.** The film opens on the *interface* — panels,
toolbar, tissue table — and the layer panel shows every layer that is loaded, so a tour of the
seven-layer film scene would be a panel scrolled somewhere arbitrary: the two tour jobs get small
scenes of their own, `window.panels: true`, and `view="window"` captures. The four acts are separate
jobs for a reason about the disk rather than the film — see `build_acts`. ffmpeg concatenates the
six with the title and end cards and burns the captions on.

Outputs, all under `docs/media/`: `showcase.mp4`, `showcase-preview.gif`, `SHOWCASE.md`. The PNG
frames and the job documents stay in the work directory (`--work`, default
`/tmp/tetravox-showcase`); each act's frames are deleted as soon as its MP4 exists, so the peak is
about 900 MB rather than the 3 GB the whole film would be.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _data import (  # noqa: E402
    ERNIE_MESH,
    FIELD_VOLUME,
    GREY_MESH,
    LABELS,
    LUT_NOTE,
    NET,
    T1,
    TET_MESH,
    VECTOR_MESH,
    require,
)
from tetravox import Job  # noqa: E402

# ================================================================================================
# 1. The film's fixed quantities
# ================================================================================================

FPS = 30
WIDTH, HEIGHT = 1920, 1080

# Two cards of dead air, at the two ends. Long enough to read one line, short enough not to be a
# title sequence.
TITLE_SECONDS = 3.0
END_SECONDS = 3.0

TITLE_TEXT = "Tetravox"
TITLE_SUB = "volumes, meshes and simulated fields, in one viewer"
END_TEXT = "Everything above came out of one script"
END_SUB = "examples/capture/showcase.py  -  docs/AUTOMATION.md"

# ------------------------------------------------------------------------------------------------
# Numbers read off the data, not typed in from taste. Reproduce them with nibabel:
#
#   lab = nib.load(LABELS); L = np.asarray(lab.dataobj)
#   nib.affines.apply_affine(lab.affine, np.argwhere(np.isin(L, [10, 49])).mean(0))
#
# The cursor is the centroid of the two thalamic labels, rounded — the target of the simulation the
# field volume comes from, located the way the atlas locates it rather than by eye.
CURSOR_THALAMUS = (0.0, 9.0, 18.0)
# The brainstem's centroid (label 16), for the shot that turns it into a surface.
CURSOR_BRAINSTEM = (1.6, -0.5, -19.3)

# The grey-matter TI volume's own distribution over its 702,214 non-zero voxels:
#   p50 0.0810   p90 0.1121   p95 0.1239   p99 0.1529   p99.9 0.1903   max 0.4043  V/m
# The heat scale runs p90 → p99 → p99.9 and the threshold falls from p99.9 to p90. p99.9 rather than
# the maximum, for the reason the `ti-field-on-t1` preset gives: the field peaks four times its own
# p99.9 in a handful of voxels, and a max-anchored scale paints the whole cortex in the bottom
# colour.
FIELD_P90, FIELD_P99, FIELD_P999 = 0.1121, 0.1529, 0.1903

# Atlas label ids (`labeling_LUT.txt`).
BRAIN_STEM = 16
L_THALAMUS, R_THALAMUS = 10, 49
# The 41 intracranial ids. A filled atlas *without* this list is `Background` and `Skin` painted
# over the whole pane — a wash, not an atlas.
INTRACRANIAL = (
    2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 29, 30, 31,
    41, 42, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60, 62, 63, 72, 77, 80, 85,
)

# Tissue tags of the head model's surfaces (`ernie.msh.opt` names them).
WM, GM, CSF, SCALP, EYES, COMPACT_BONE, SPONGY_BONE, BLOOD, MUSCLE, ELECTRODE = (
    1001,
    1002,
    1003,
    1005,
    1006,
    1007,
    1008,
    1009,
    1010,
    1099,
)
ALL_TAGS = (WM, GM, CSF, SCALP, EYES, COMPACT_BONE, SPONGY_BONE, BLOOD, MUSCLE, ELECTRODE)

# The thinnest line the mesh renderer draws: `render/passes/mesh.ts` clamps the uniform at
# `max(0.5, edgeWidthPx)`, so 0.5 px is the floor and asking for less changes nothing.
THINNEST_EDGE_PX = 0.5

# Chrome. The convention badge is never optional (ARCHITECTURE §8); the rest is per shot.
CHROME_2D = dict(crosshair=True, colorbar=True, orientation_labels=True, corner_info=True, scale_bar=True)
CHROME_3D = dict(crosshair=False, colorbar=True, orientation_labels=True, corner_info=True, scale_bar=False)


# ================================================================================================
# 2. The storyboard — one list, three uses
# ================================================================================================

STORYBOARD: list[dict] = []


def story(shot: str, caption: str, frames: int, note: str = "") -> int:
    """Record a shot, and return its frame count so a caller can pass it straight to a tween.

    `caption` is burned into the film under this shot; `note` is the storyboard's own column and
    says *why* the numbers are what they are. Frames are what turns one into a timestamp.
    """
    STORYBOARD.append({"shot": shot, "caption": caption, "frames": frames, "note": note})
    return frames


def timeline() -> list[dict]:
    """The storyboard with `start` / `end` seconds, on the finished film's clock.

    The title card is before every shot, which is the whole of the arithmetic: the shots are in the
    order they are appended, and the frame counts are exact because every action is a fixed number
    of frames.
    """
    out = []
    t = TITLE_SECONDS
    for entry in STORYBOARD:
        seconds = entry["frames"] / FPS
        out.append({**entry, "start": t, "end": t + seconds})
        t += seconds
    return out


def total_seconds() -> float:
    return TITLE_SECONDS + sum(e["frames"] for e in STORYBOARD) / FPS + END_SECONDS


# ================================================================================================
# 3. The UI tour — two short jobs with the panels on
# ================================================================================================
#
# `view="window"` photographs the whole window rather than the engine's canvas, and
# `Job(panels=True)` is what puts anything in it worth photographing. Two scenes rather than one,
# because the layer panel lists every loaded layer top-down: the *last* file opened is the top
# layer and the one whose controls are on screen. Tour A puts the atlas there, tour B the head mesh,
# and each is what that half of the tour is about.

def tour_regions(work: str) -> str:
    """The interface, on a label volume: layer panel, region list, coordinate bar, header."""
    zoom_from, zoom_to = 0.42, 0.30
    cursor_from = (0.0, 9.0, 44.0)

    job = Job(files=[T1, ERNIE_MESH, LABELS], window=(WIDTH, HEIGHT), panels=True)
    job.set(layer="ernie.msh", patch={"visible": False})
    job.set(layout="2x2", cursor=cursor_from, radiological=False)
    job.set(layer="T1.nii.gz", patch={"visible": True, "colormap": "gray", "showIn3D": True})
    job.set(
        layer="labeling.nii.gz",
        patch={
            "visible": True,
            "opacity": 0.55,
            "labelMode": "outline",
            "outlineWidthPx": 2,
            "interpolation": "nearest",
        },
    )
    job.set(active="labeling.nii.gz")
    for view in ("axial", "coronal", "sagittal"):
        job.set(view=view, mm_per_px=zoom_from)

    # A slow descent to the thalamus. Everything in the window moves with it — three panes, the 3D
    # planes, the coordinate bar's RAS readout and the per-layer value rows on the right — which is
    # the one claim a tour of this interface has to make.
    job.tween(
        "tour",
        sequence="start",
        gif=False,
        view="window",
        width=WIDTH,
        height=HEIGHT,
        fps=FPS,
        ease="inOut",
        frames=story(
            "T0",
            "One cursor drives every pane, the 3D planes and the readouts",
            105,
            "`view=\"window\"` with `window.panels: true`: the real interface, not the engine's canvas.",
        ),
        to={"cursor": list(CURSOR_THALAMUS)},
    )
    # Then the region panel does its own job: 57 labels, searchable, each with its own visibility.
    job.tween(
        "tour",
        sequence="end",
        format="mp4",
        gif=False,
        view="window",
        width=WIDTH,
        height=HEIGHT,
        fps=FPS,
        ease="inOut",
        frames=story(
            "T1",
            "57 atlas regions, each with its own visibility and colour",
            105,
            "The label panel is the layer panel's region list — the same rows a job patches by id.",
        ),
        to={
            "views": {v: {"mmPerPx": zoom_to} for v in ("axial", "coronal", "sagittal")},
            "layers": [{"layer": "labeling.nii.gz", "patch": {"opacity": 0.95}}],
        },
    )
    return job.write(os.path.join(work, "tour-regions.job.json"))


def tour_tissues(work: str) -> str:
    """The same interface on the head mesh, so the tissue table is the panel on screen."""
    distance_from, distance_to = 620.0, 430.0
    orbit_degrees = -26.0

    job = Job(files=[T1, LABELS, ERNIE_MESH], window=(WIDTH, HEIGHT), panels=True)
    job.set(layer="labeling.nii.gz", patch={"visible": False})
    job.set(layout="3d+1", cursor=CURSOR_THALAMUS, radiological=False)
    job.set(layer="T1.nii.gz", patch={"visible": True, "colormap": "gray", "showIn3D": False})
    job.set(
        layer="ernie.msh",
        patch={
            "visible": True,
            "colorMode": "tag",
            "faceMode": "cull",
            "tagStyle": {str(tag): {"visible": True, "opacity": 1.0} for tag in ALL_TAGS},
        },
    )
    job.set(active="ernie.msh")
    job.set(view="view3d", camera="L")
    job.set(view="view3d", distance=distance_from)

    job.tween(
        "tour",
        sequence="start",
        gif=False,
        view="window",
        width=WIDTH,
        height=HEIGHT,
        fps=FPS,
        ease="inOut",
        frames=story(
            "T2",
            "A head model arrives named and coloured, one row per tissue",
            90,
            "The tissue table is read out of `ernie.msh.opt`; nothing here was typed in.",
        ),
        to={"distance": distance_to, "target": [0.0, 16.0, 8.0]},
    )
    # Scalp and bone to glass, from the table's own opacity sliders, while the camera turns.
    job.tween(
        "tour",
        sequence="end",
        format="mp4",
        gif=False,
        view="window",
        width=WIDTH,
        height=HEIGHT,
        fps=FPS,
        ease="inOut",
        orbit={"degrees": orbit_degrees, "axis": "z"},
        frames=story(
            "T3",
            "Each tissue has its own opacity — the head goes to glass",
            90,
            "Per-tag, not per-layer: one mesh is part glass and part solid in a single draw.",
        ),
        to={
            "layers": [
                {
                    "layer": "ernie.msh",
                    "patch": {
                        "tagStyle": {
                            str(SCALP): {"opacity": 0.18},
                            str(COMPACT_BONE): {"opacity": 0.34},
                            str(SPONGY_BONE): {"opacity": 0.34},
                            str(CSF): {"opacity": 0.26},
                            str(MUSCLE): {"opacity": 0.2},
                        }
                    },
                }
            ]
        },
    )
    return job.write(os.path.join(work, "tour-tissues.job.json"))


# ================================================================================================
# 4. The film proper — one job, seven layers, panels off
# ================================================================================================


def _shot(job: Job, *, first: bool = False, last: bool = False, chrome: dict, **kwargs) -> Job:
    """One tween into the act's frame sequence.

    Every shot in an act writes into one sequence and only the last action encodes, because a minute
    of video is not one camera move and a per-action encode cannot express a dozen shots that have to
    become one file (`docs/AUTOMATION.md` §2.3). `first` and `last` are written out at the two shots
    that are them rather than inferred, so reordering shots is a diff a reader can check.
    """
    return job.tween(
        "showcase",
        sequence="start" if first else "end" if last else "continue",
        gif=False,
        format="mp4" if last else None,
        width=WIDTH,
        height=HEIGHT,
        fps=FPS,
        ease="inOut",
        **chrome,
        **kwargs,
    )


# ---- Act A: the anatomy -------------------------------------------------------------------------


def act_a_anatomy(job: Job) -> None:
    """T1 in a 2×2 grid, and two slow sweeps through it."""
    zoom_from, zoom_to = 0.62, 0.30  # mm per pixel; 0.30 fills a 960 px pane with a 180 mm head
    axial_from_z, axial_to_z = -28.0, 58.0  # world RAS mm — chin to vertex, inside the brain
    coronal_from_y, coronal_to_y = -72.0, 46.0

    job.set(layout="2x2", cursor=(0.0, 9.0, axial_from_z), radiological=False)
    job.set(layer="T1.nii.gz", patch={"visible": True, "colormap": "gray", "showIn3D": True})
    for view in ("axial", "coronal", "sagittal"):
        job.set(view=view, mm_per_px=zoom_from)
    job.set(view="view3d", camera="L")
    job.set(view="view3d", distance=470)

    _shot(
        job,
        first=True,
        chrome=CHROME_2D,
        # The 3D pane starts at preset `L`, where the sagittal plane is face-on and the other two are
        # edge-on — a duplicate of the pane beside it. Turning 35° about `z` over the same frames
        # opens all three out into a ¾ without the head ever rolling.
        orbit={"degrees": -35, "axis": "z"},
        frames=story(
            "A1",
            "A T1 in three planes — and the same three planes in 3D",
            90,
            "Anterior up in the axial pane, superior up in the other two, `NEU` in every corner. "
            "The 3D pane turns 35° off left-lateral so its three planes are not edge-on.",
        ),
        to={"views": {v: {"mmPerPx": zoom_to} for v in ("axial", "coronal", "sagittal")}},
    )
    _shot(
        job,
        chrome=CHROME_2D,
        frames=story(
            "A2",
            "An axial sweep, inferior to superior",
            240,
            "A cursor tween rather than a `sweep` action: a sweep captures the one pane it steps, "
            "and this shot is about the other three following it.",
        ),
        to={"cursor": [0.0, 9.0, axial_to_z]},
    )
    job.set(cursor=(0.0, coronal_from_y, 18.0))
    _shot(
        job,
        chrome=CHROME_2D,
        frames=story(
            "A3",
            "…and a coronal sweep, posterior to anterior",
            240,
            "The axial pane's slice holds still and only its crosshair moves — the cursor-sync "
            "claim, visible.",
        ),
        to={"cursor": [0.0, coronal_to_y, 18.0]},
    )
    _shot(
        job,
        last=True,
        chrome=CHROME_2D,
        frames=story("A4", "", 30, "A held frame on the thalamus: the cut into Act B."),
        to={"cursor": list(CURSOR_THALAMUS)},
    )


# ---- Act B: the atlas, and one region as a surface -----------------------------------------------


def act_b_atlas(job: Job) -> None:
    """`labeling.nii.gz` filled and outlined, then the brainstem as a real isosurface."""
    fill_opacity = 0.35  # low: a filled atlas at 1.0 is a colouring book, not an overlay
    stem_colour = [1.0, 0.55, 0.15, 1.0]  # the colour it is *changed* to; its own is slate blue
    stem_settled_opacity = 0.45
    orbit_degrees = 60.0
    plane_from_z, plane_to_z = 42.0, -46.0  # the T1 axial plane, driven down through the brainstem

    # Act B opens where Act A closed. Written out rather than inherited: each act is its own job
    # over a freshly loaded scene (see `build_acts`).
    job.set(layout="2x2", cursor=CURSOR_THALAMUS, radiological=False)
    job.set(layer="T1.nii.gz", patch={"showIn3D": True})
    for view in ("axial", "coronal", "sagittal"):
        job.set(view=view, mm_per_px=0.30)
    job.set(view="view3d", camera="L")
    job.set(view="view3d", distance=470)
    job.set(
        layer="labeling.nii.gz",
        patch={
            "visible": True,
            "opacity": 0.0,
            "labelMode": "both",
            "outlineWidthPx": 2,
            "interpolation": "nearest",
            "labelColors": {},
            "visibleLabels": list(INTRACRANIAL),
            "selectedLabels": [],
        },
    )
    _shot(
        job,
        first=True,
        chrome=CHROME_2D,
        frames=story(
            "B1",
            "An atlas over it — filled low, and outlined",
            90,
            "`labelMode: both`, over the 41 intracranial ids — filled, `Background` and `Skin` "
            f"are a wash over the whole pane. Interpolation is `nearest`: {LUT_NOTE}",
        ),
        to={"layers": [{"layer": "labeling.nii.gz", "patch": {"opacity": fill_opacity}}]},
    )

    # One region, as geometry. The engine runs marching cubes per visible label at `id − 0.5` in the
    # LUT's own colour — the volume layer's 3D-surface switch, not a second file.
    job.set(layout="3d+1", cursor=CURSOR_BRAINSTEM)
    job.set(view="view3d", camera="L")
    job.set(view="view3d", distance=260)
    job.set(layer="T1.nii.gz", patch={"showIn3D": False})
    job.set(
        layer="labeling.nii.gz",
        patch={
            "opacity": 0.55,
            "visibleLabels": [BRAIN_STEM],
            "selectedLabels": [],
            "iso3d": {
                "enabled": True,
                "iso": 0.5,
                "color": [0.47, 0.62, 0.69, 1.0],
                "opacity": 0.0,
                "smooth": True,
                "faceMode": "cull",
            },
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        frames=story(
            "B2",
            "One region as a 3D surface: the brainstem",
            90,
            "Marching cubes over the label volume itself. It is stair-stepped because that is the "
            "real surface of a 1 mm label map; `smooth` shades it, it does not move a vertex.",
        ),
        to={
            # The camera's target is the scene's centre until something moves it, and the brainstem
            # is 30 mm below and behind that — off-centre and small in the frame otherwise.
            "target": list(CURSOR_BRAINSTEM),
            "distance": 190,
            "layers": [{"layer": "labeling.nii.gz", "patch": {"iso3d": {"opacity": 1.0}}}],
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        orbit={"degrees": orbit_degrees, "axis": "z"},
        frames=story(
            "B3",
            "Turned in 3D, with the axial slice beside it",
            120,
            "`3d+1`: the pane on the right is the anatomy the surface came out of.",
        ),
        to={"distance": 165},
    )
    _shot(
        job,
        chrome=CHROME_3D,
        frames=story(
            "B4",
            "Its colour is the region's own — until you change it",
            60,
            "A `labelColors` entry is four numbers, so a tween walks the colour rather than cutting "
            "to it.",
        ),
        to={
            "layers": [
                {
                    "layer": "labeling.nii.gz",
                    "patch": {"labelColors": {str(BRAIN_STEM): stem_colour}},
                }
            ]
        },
    )
    job.set(layer="T1.nii.gz", patch={"showIn3D": True})
    job.set(cursor=(1.6, -0.5, plane_from_z))
    _shot(
        job,
        last=True,
        chrome=CHROME_3D,
        frames=story(
            "B5",
            "Opacity down, and a T1 plane driven through it",
            170,
            "An isosurface has no clip plane of its own (that is the mesh layer's control, Act D) — "
            "the plane here is the T1's own axial slice with `showIn3D` on, which is the honest "
            "way to cut a surface in this scene.",
        ),
        to={
            "cursor": [1.6, -0.5, plane_to_z],
            "layers": [
                {
                    "layer": "labeling.nii.gz",
                    "patch": {"iso3d": {"opacity": stem_settled_opacity}},
                }
            ],
        },
    )


# ---- Act C: the thalamus, and the simulated field ------------------------------------------------


def act_c_field(job: Job) -> None:
    """Solo the two thalami, then bring the TI field in over them and move its threshold."""
    zoom_wide, zoom_close = 0.30, 0.17  # mm per pixel
    field_opacity = 0.92
    coronal_from_y, coronal_to_y = 30.0, -12.0
    surface_orbit = 42.0

    job.set(layer="labeling.nii.gz", patch={"iso3d": {"enabled": False, "iso": 0.5, "color": [0.47, 0.62, 0.69, 1.0], "opacity": 1.0, "smooth": True, "faceMode": "cull"}})
    job.set(layout="2x2", cursor=CURSOR_THALAMUS)
    job.set(layer="T1.nii.gz", patch={"showIn3D": True})
    job.set(
        layer="labeling.nii.gz",
        patch={
            "visible": True,
            "opacity": 0.95,
            "labelMode": "outline",
            "outlineWidthPx": 2,
            "visibleLabels": [L_THALAMUS, R_THALAMUS],
            "labelColors": {
                str(L_THALAMUS): [1.0, 1.0, 1.0, 1.0],
                str(R_THALAMUS): [0.0, 0.9, 1.0, 1.0],
            },
        },
    )
    for view in ("axial", "coronal", "sagittal"):
        job.set(view=view, mm_per_px=zoom_wide)
    _shot(
        job,
        first=True,
        chrome=CHROME_2D,
        frames=story(
            "C1",
            "Solo two regions — left and right thalamus — and zoom in",
            90,
            "`visibleLabels: [10, 49]` with a colour each. The sagittal pane deliberately stays "
            "wide, so there is always one frame of context.",
        ),
        to={
            "views": {
                "axial": {"mmPerPx": zoom_close},
                "coronal": {"mmPerPx": zoom_close},
            }
        },
    )

    # The field, thresholded to its own top 0.1 % before it is even visible, so the first thing on
    # screen is the focus rather than a wash.
    job.set(
        layer="grey_Thalamus_TI_subject_TI_max.nii.gz",
        patch={
            "visible": True,
            "opacity": 0.0,
            "colormap": "hot",
            "showColorbar": True,
            "interpolation": "linear",
            "scale": {
                "kind": "heat",
                "min": FIELD_P90,
                "mid": FIELD_P99,
                "max": FIELD_P999,
                "truncate": False,
                "inverse": False,
                "negative": "hide",
            },
            "threshold": {
                "lo": FIELD_P999,
                "hi": 1e9,
                "symmetric": False,
                "mode": "hide",
                "softEdge": 0.0,
            },
        },
    )
    _shot(
        job,
        chrome=CHROME_2D,
        frames=story(
            "C2",
            "A simulated TI field over it, with its colour bar",
            90,
            f"Heat scale {FIELD_P90:.3f} / {FIELD_P99:.3f} / {FIELD_P999:.3f} V/m — the volume's own "
            "p90, p99 and p99.9 over its non-zero voxels.",
        ),
        to={
            "layers": [
                {"layer": "grey_Thalamus_TI_subject_TI_max.nii.gz", "patch": {"opacity": field_opacity}}
            ]
        },
    )
    _shot(
        job,
        chrome=CHROME_2D,
        frames=story(
            "C3",
            f"One number moving: the threshold, p99.9 to p90 "
            f"({FIELD_P999:.3f} -> {FIELD_P90:.3f} V/m)",
            120,
            "The field grows out of its hottest core instead of appearing whole — which is what a "
            "threshold slider does, at 30 fps.",
        ),
        to={
            "layers": [
                {
                    "layer": "grey_Thalamus_TI_subject_TI_max.nii.gz",
                    "patch": {"threshold": {"lo": FIELD_P90}},
                }
            ]
        },
    )
    job.set(cursor=(0.0, coronal_from_y, 18.0))
    _shot(
        job,
        chrome=CHROME_2D,
        frames=story(
            "C4",
            "Coronal, through the focus",
            90,
            "The field is a volume like any other: it slices, it thresholds, it has a colour bar.",
        ),
        to={"cursor": [0.0, coronal_to_y, 18.0]},
    )

    # The same field on the grey-matter surface, with the T1's planes underneath it for context.
    job.set(layer="grey_Thalamus_TI_subject_TI_max.nii.gz", patch={"visible": False})
    job.set(layer="labeling.nii.gz", patch={"visible": False})
    job.set(layout="3d-only")
    job.set(cursor=CURSOR_THALAMUS)
    job.set(view="view3d", camera="L")
    job.set(view="view3d", distance=400)
    job.set(
        layer="grey_Thalamus_TI.msh",
        patch={
            "visible": True,
            "colorMode": "field",
            "showColorbar": True,
            "colormap": "hot",
            "faceMode": "cull",
            "flatShading": False,
            "field": {"source": "elm", "name": "TI_max", "component": "mag"},
            "scale": {"kind": "linear", "lo": 0.0, "hi": FIELD_P999},
        },
    )
    _shot(
        job,
        last=True,
        chrome=CHROME_3D,
        orbit={"degrees": surface_orbit, "axis": "z"},
        frames=story(
            "C5",
            "The same field on the grey-matter surface, over the T1 planes",
            120,
            "A field shot with no anatomy under it is a colour cloud. `showIn3D` puts the three T1 "
            "slices in the 3D pane, so the surface has somewhere to be.",
        ),
        to={"distance": 340, "target": [0.0, 14.0, 12.0]},
    )


# ---- Act D: the head model ----------------------------------------------------------------------


def act_d_mesh(job: Job) -> None:
    """847,165 nodes and 4.7 M tetrahedra: transparency, clip planes, edges, the field on the cut."""
    fly_from, fly_to = 760.0, 440.0
    glass = {SCALP: 0.20, COMPACT_BONE: 0.42, SPONGY_BONE: 0.42, CSF: 0.30, MUSCLE: 0.25, EYES: 0.6}
    axial_cut_from, axial_cut_to = 130.0, CURSOR_THALAMUS[2]
    coronal_cut_from, coronal_cut_to = -110.0, 26.0
    cap_distance = 235.0
    edge_thick_px = 2.4
    field_scale_hi = 0.30  # V/m; fixed, so the colour bar prints a number instead of counting
    # V/m, over grey matter only. 0.15 rather than the field's top: at 0.30 the first frame of the
    # shot is empty, and a shot that opens on nothing reads as a bug.
    isolate_from, isolate_to = 0.15, 0.085

    job.set(layer="grey_Thalamus_TI.msh", patch={"visible": False})
    job.set(layer="T1.nii.gz", patch={"showIn3D": False})
    job.set(layout="3d-only")
    job.set(cursor=CURSOR_THALAMUS)
    job.set(view="view3d", camera="L")
    job.set(view="view3d", distance=fly_from)
    job.set(
        layer="Thalamus_TI.msh",
        patch={
            "visible": True,
            "colorMode": "tag",
            "showColorbar": False,
            "faceMode": "cull",
            "flatShading": False,
            "edges": {"surface": False, "caps": False},
            "edgeWidthPx": THINNEST_EDGE_PX,
            "clip": {"planes": [], "caps": True, "capColorMode": "tag"},
            "isolate": None,
            "glyphs": None,
            "tagStyle": {str(tag): {"visible": True, "opacity": 1.0} for tag in ALL_TAGS},
        },
    )
    _shot(
        job,
        first=True,
        chrome=CHROME_3D,
        frames=story(
            "D1",
            "The head model — 847,165 nodes, 4.7 million tetrahedra",
            75,
            "`Thalamus_TI.msh` is `ernie.msh` carrying `TI_max` on every element, which is why the "
            "tissue table, the clip caps and the field colouring all belong to one layer.",
        ),
        to={"distance": fly_to, "target": [0.0, 18.0, 4.0]},
    )
    _shot(
        job,
        chrome=CHROME_3D,
        orbit={"degrees": -30, "axis": "z"},
        frames=story(
            "D2",
            "Transparency per tissue tag, not per layer",
            90,
            "The brain underneath keeps its colour: the transparent sheets are drawn after the "
            "opaque ones and blended once.",
        ),
        to={
            "layers": [
                {
                    "layer": "Thalamus_TI.msh",
                    "patch": {"tagStyle": {str(t): {"opacity": o} for t, o in glass.items()}},
                }
            ]
        },
    )

    job.set(
        layer="Thalamus_TI.msh",
        patch={
            "clip": {
                "planes": [
                    {"plane": {"normal": [0, 0, 1], "offset": axial_cut_from}, "enabled": True}
                ],
                "caps": True,
                "capColorMode": "tag",
            }
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        orbit={"degrees": 44, "axis": "y"},
        frames=story(
            "D3",
            "An axial clip plane, descending — the cut is capped, not hollow",
            100,
            "Every clipped tetrahedron contributes an exact cap polygon, coloured by the tissue the "
            "plane passes through. The +44° about `y` is how you come to look *into* the cut "
            "without rolling the head.",
        ),
        to={
            "layers": [
                {"layer": "Thalamus_TI.msh", "patch": {"clip": {"planes": [{"plane": {"offset": axial_cut_to}}]}}}
            ]
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        frames=story(
            "D4",
            "",
            55,
            "In to the cap — aimed at the cut, not at the head's centre, and the scalp and bone go "
            "from glass to nearly gone. At 0.20 they still cover the cap, and the next two shots "
            "are about what is *on* the cap.",
        ),
        to={
            "distance": cap_distance,
            "target": [0.0, 22.0, axial_cut_to],
            "layers": [
                {
                    "layer": "Thalamus_TI.msh",
                    "patch": {
                        "tagStyle": {
                            str(SCALP): {"opacity": 0.05},
                            str(COMPACT_BONE): {"opacity": 0.1},
                            str(SPONGY_BONE): {"opacity": 0.1},
                            str(CSF): {"opacity": 0.08},
                        }
                    },
                }
            ],
        },
    )

    job.set(layer="Thalamus_TI.msh", patch={"edges": {"surface": False, "caps": True}, "edgeWidthPx": THINNEST_EDGE_PX})
    _shot(
        job,
        chrome=CHROME_3D,
        frames=story(
            "D5",
            "Edge lines — the tetrahedra themselves",
            45,
            f"Screen-space width, so a line is the same weight at any zoom; up to {edge_thick_px} px "
            "to make the point.",
        ),
        to={"layers": [{"layer": "Thalamus_TI.msh", "patch": {"edgeWidthPx": edge_thick_px}}]},
    )
    _shot(
        job,
        chrome=CHROME_3D,
        frames=story(
            "D6",
            f"…and back to {THINNEST_EDGE_PX} px, the thinnest line the renderer draws",
            55,
            "`render/passes/mesh.ts` clamps the uniform at `max(0.5, edgeWidthPx)`: 0.5 is the "
            "floor, and asking for less changes nothing.",
        ),
        to={
            "distance": 430,
            "target": [0.0, 18.0, 4.0],
            "layers": [{"layer": "Thalamus_TI.msh", "patch": {"edgeWidthPx": THINNEST_EDGE_PX}}],
        },
    )

    # The field on the cut. The T1's axial plane sits exactly on the clip plane (the cursor is at
    # z = 18 and so is the cut), so the slice is the context and the cap is the result.
    job.set(layer="T1.nii.gz", patch={"showIn3D": True})
    job.set(
        layer="Thalamus_TI.msh",
        patch={
            "edges": {"surface": False, "caps": False},
            "colorMode": "field",
            "flatShading": True,
            "showColorbar": True,
            "field": {"source": "elm", "name": "TI_max", "component": "mag"},
            "colormap": "jet",
            "clip": {
                "planes": [{"plane": {"normal": [0, 0, 1], "offset": axial_cut_to}, "enabled": True}],
                "caps": True,
                "capColorMode": "inherit",
            },
            "scale": {"kind": "linear", "lo": 0.0, "hi": field_scale_hi},
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        orbit={"degrees": -26, "axis": "z"},
        frames=story(
            "D7",
            "TI_max on the cut, over the T1's own axial slice",
            90,
            "`capColorMode: inherit` — the caps carry the field rather than the tissue, which is the "
            "whole reason to cut. The T1's axial plane is on the same z as the clip plane, so the "
            "anatomy and the result are the same picture.",
        ),
        to={"distance": 300, "target": [0.0, 18.0, axial_cut_to]},
    )

    job.set(cursor=(0.0, coronal_cut_from, 18.0))
    job.set(
        layer="Thalamus_TI.msh",
        patch={
            "clip": {
                "planes": [
                    {"plane": {"normal": [0, 1, 0], "offset": coronal_cut_from}, "enabled": True}
                ],
                "caps": True,
                "capColorMode": "inherit",
            }
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        frames=story(
            "D8",
            "A coronal cut, driven front to back with the cursor",
            100,
            "The plane's offset and the T1's coronal slice move together, so the section and the "
            "anatomy at that section are the same picture.",
        ),
        to={
            "cursor": [0.0, coronal_cut_to, 18.0],
            "layers": [
                {
                    "layer": "Thalamus_TI.msh",
                    "patch": {"clip": {"planes": [{"plane": {"offset": coronal_cut_to}}]}},
                }
            ],
        },
    )

    job.set(
        layer="Thalamus_TI.msh",
        patch={
            "isolate": {
                "tags": [2],
                "combine": "all",
                "field": {"source": "elm", "name": "TI_max", "component": "mag", "lo": isolate_from, "hi": 10.0},
            },
            "clip": {"planes": [], "caps": True, "capColorMode": "inherit"},
            "scale": {"kind": "linear", "lo": isolate_to, "hi": 0.22},
            "tagStyle": {str(tag): {"visible": True, "opacity": 1.0} for tag in ALL_TAGS},
        },
    )
    _shot(
        job,
        last=True,
        chrome=CHROME_3D,
        orbit={"degrees": 34, "axis": "z"},
        frames=story(
            "D9",
            f"Isolate: grey matter above {isolate_to:.3f} V/m",
            90,
            "A mask over elements, not a new file — the field colouring and the caps keep working "
            "on what is left. The cloud is diffuse because that is what a TI field in grey matter "
            "is.",
        ),
        to={
            "distance": 330,
            "target": [0.0, 16.0, 14.0],
            "layers": [
                {"layer": "Thalamus_TI.msh", "patch": {"isolate": {"field": {"lo": isolate_to}}}}
            ],
        },
    )

def act_e_vectors(job: Job) -> None:
    """The vector field as arrows, the electrode net, and the closing turn.

    Its own job, and its own act, for the same disk reason `build_acts` gives — and it splits at a
    cut the film already had: D10 changes the camera preset outright, so nothing is lost by starting
    a fresh scene here.
    """
    glyph_from_mm, glyph_to_mm = 0.2, 10.0
    electrode_from_mm, electrode_to_mm = 0.1, 4.0
    turntable_frames = 150

    job.set(layout="3d-only")
    job.set(cursor=CURSOR_THALAMUS)
    job.set(layer="T1.nii.gz", patch={"showIn3D": True})
    job.set(layer="Thalamus_TI.msh", patch={"visible": False})
    job.set(view="view3d", camera="S")
    job.set(view="view3d", distance=285)
    job.set(
        layer="ernie_TDCS_1_scalar.msh",
        patch={
            "visible": True,
            "colorMode": "tag",
            "showColorbar": True,
            "colormap": "cool",
            "tagStyle": {str(tag): {"visible": False, "opacity": 1.0} for tag in ALL_TAGS},
            "clip": {
                "planes": [{"plane": {"normal": [0, 0, -1], "offset": 18.0}, "enabled": True}],
                "caps": False,
                "capColorMode": "tag",
            },
            "glyphs": {
                "field": {"source": "elm", "name": "E"},
                "shape": "arrow",
                "origins": "volume",
                "subsample": {"everyNth": 30},
                "scale": {
                    "mode": "log",
                    "lengthMm": glyph_from_mm,
                    "normalizeTo": "p99",
                    "logFloor": 0.05,
                },
                "lengthMm": glyph_from_mm,
                "colorBy": "magnitude",
                "color": [1, 1, 1, 1],
                "clipToCutPlane": False,
                "onCutPlaneOnly": True,
                "cutSlabMm": 4.0,
                "headProportion": 0.3,
            },
        },
    )
    _shot(
        job,
        first=True,
        chrome=CHROME_3D,
        orbit={"degrees": 24, "axis": "z"},
        frames=story(
            "D10",
            "The E field as arrows, one per tetrahedron on the cut",
            100,
            "One origin per tet, every 30th, in a 4 mm slab. Log length above a 0.05 V/m floor: "
            "linear, the scalp's 3.8 V/m rim makes every intracranial arrow sub-pixel. Seen from "
            "above, anterior up, over the T1's own axial slice.",
        ),
        to={
            "target": [0.0, 18.0, 18.0],
            "layers": [
                {
                    "layer": "ernie_TDCS_1_scalar.msh",
                    "patch": {"glyphs": {"scale": {"lengthMm": glyph_to_mm}, "lengthMm": glyph_to_mm}},
                }
            ],
        },
    )

    # The net, and the closing turn.
    job.set(layer="ernie_TDCS_1_scalar.msh", patch={"visible": False})
    job.set(layer="T1.nii.gz", patch={"showIn3D": False})
    job.set(view="view3d", camera="L")
    job.set(view="view3d", distance=450)
    job.set(
        layer="Thalamus_TI.msh",
        patch={
            "visible": True,
            "colorMode": "tag",
            "isolate": None,
            "flatShading": False,
            "showColorbar": False,
            "clip": {"planes": [], "caps": True, "capColorMode": "tag"},
            "tagStyle": {str(tag): {"visible": True, "opacity": 1.0} for tag in ALL_TAGS},
        },
    )
    job.set(
        layer="GSN-HydroCel-185.geo",
        patch={
            "visible": True,
            "shape": "sphere",
            "radiusMm": electrode_from_mm,
            "showLabels": False,
            "valueMode": "solid",
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        orbit={"degrees": 26, "axis": "z"},
        frames=story(
            "D11",
            "183 electrodes of a GSN HydroCel net, on the scalp",
            70,
            "Labels off: 183 of them at once is a wall of text, and the panel is where you find one "
            "by name.",
        ),
        to={
            "layers": [
                {"layer": "GSN-HydroCel-185.geo", "patch": {"radiusMm": electrode_to_mm}}
            ]
        },
    )
    job.set(
        layer="Thalamus_TI.msh",
        patch={
            "tagStyle": {
                str(SCALP): {"visible": True, "opacity": 0.22},
                str(COMPACT_BONE): {"visible": True, "opacity": 0.45},
                str(SPONGY_BONE): {"visible": True, "opacity": 0.45},
                str(CSF): {"visible": True, "opacity": 0.32},
            }
        },
    )
    _shot(
        job,
        chrome=CHROME_3D,
        frames=story("D12", "", 30, "Recentre, so the turntable does not swing a cropped neck."),
        to={"distance": 470, "target": [0.0, 16.0, 0.0]},
    )
    job.orbit(
        "showcase",
        sequence="end",
        degrees=360,
        frames=story(
            "D13",
            "One full turn, and back where it started",
            turntable_frames,
            "`z` is superior in RAS and the camera started at preset `L`, so superior stays up for "
            "all 360°. The last frame stops one step short, so it loops.",
        ),
        axis="z",
        fps=FPS,
        width=WIDTH,
        height=HEIGHT,
        format="mp4",
        **CHROME_3D,
    )


ACTS = (
    ("a-anatomy", lambda job: act_a_anatomy(job)),
    ("b-atlas", lambda job: act_b_atlas(job)),
    ("c-field", lambda job: act_c_field(job)),
    ("d-mesh", lambda job: act_d_mesh(job)),
    ("e-vectors", lambda job: act_e_vectors(job)),
)


def build_acts(work: str) -> list[tuple[str, str]]:
    """One job document per act, in order.

    Four jobs rather than one, for a reason that is about the disk and not about the film: 2,540
    frames of 1920×1080 PNG is about 3 GB, and they all have to exist at once for ffmpeg's image2
    demuxer to read them back. Per act, the peak is the largest act — a third of that — and the
    script deletes each act's frames as soon as its MP4 exists. The cost is reloading the scene
    four times, which is a few seconds each.

    It is why every act opens by setting the state it needs rather than inheriting it: an act is a
    fresh scene, and a shot that depended on what the previous act left behind would render
    something else the moment the film is re-cut.
    """
    written = []
    for name, build in ACTS:
        job = Job(
            files=[T1, FIELD_VOLUME, LABELS, GREY_MESH, TET_MESH, VECTOR_MESH, NET],
            window=(WIDTH, HEIGHT),
        )
        # Everything off but the T1; each act turns on what it needs.
        for layer in (
            "grey_Thalamus_TI_subject_TI_max.nii.gz",
            "labeling.nii.gz",
            "grey_Thalamus_TI.msh",
            "Thalamus_TI.msh",
            "ernie_TDCS_1_scalar.msh",
            "GSN-HydroCel-185.geo",
        ):
            job.set(layer=layer, patch={"visible": False})
        job.set(layer="T1.nii.gz", patch={"visible": True, "colormap": "gray", "showIn3D": False})
        build(job)
        written.append((name, job.write(os.path.join(work, f"{name}.job.json"))))
    return written


# ================================================================================================
# 5. Running the jobs
# ================================================================================================


def run_job_file(job_path: str, out_dir: str) -> str:
    """Run one job document through the app and return the MP4 it wrote.

    The client's `run()` builds and runs in one call; here the document is already on disk (it is
    the record of what the film asked for), so the app is invoked directly with the same argv.
    """
    from tetravox.runner import _extra_args, find_app

    app = find_app(None)
    args = _extra_args()
    os.makedirs(out_dir, exist_ok=True)
    env = dict(os.environ)
    # Frames, not seconds, decide how long this takes: ~2,900 of them at 1920×1080. The 600 s
    # default is for a job that makes a figure.
    env.setdefault("TETRAVOX_JOB_TIMEOUT_MS", "7200000")
    cmd = [app, *args, "--job", job_path, "--out", out_dir]
    print(f"$ {' '.join(cmd)}")
    completed = subprocess.run(cmd, env=env)
    result_path = os.path.join(out_dir, "job-result.json")
    if not os.path.exists(result_path):
        raise SystemExit(f"the app wrote no job-result.json (exit {completed.returncode})")
    result = json.loads(open(result_path).read())
    for warning in result.get("warnings", []):
        print(f"  warning: {warning}", file=sys.stderr)
    if not result.get("ok"):
        for error in result.get("errors", []):
            print(f"  error: {error}", file=sys.stderr)
        raise SystemExit("job failed")
    mp4 = [f for f in result.get("outputs", [])[-1].get("files", []) if f.endswith(".mp4")]
    if not mp4:
        raise SystemExit("the job wrote no MP4 — is ffmpeg on PATH?")
    print(f"  {mp4[0]}  ({result['timings']['totalMs'] / 1000:.0f} s)")
    return os.path.join(out_dir, mp4[0])


# ================================================================================================
# 6. Titles, captions, and the two files that ship
# ================================================================================================

FFMPEG = os.environ.get("TETRAVOX_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"

# A system font, so this runs on a machine with nothing installed. First one that exists wins.
# Captions are deliberately ASCII: `Helvetica.ttc` has no `→` and PIL draws a missing glyph as a
# hollow box, which is a worse caption than "->". The storyboard page, which is Markdown and not a
# font, keeps the arrows.
FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)

CARD_BACKGROUND = "0x0d1117"


def font() -> str:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    raise SystemExit("no system font found for the captions; set one in FONT_CANDIDATES")


def ffmpeg(*args: str) -> None:
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def card(path: str, seconds: float) -> str:
    """A flat colour clip. The words go on in the caption pass, with everything else's."""
    ffmpeg(
        "-f", "lavfi",
        "-i", f"color=c={CARD_BACKGROUND}:s={WIDTH}x{HEIGHT}:r={FPS}",
        "-t", f"{seconds}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        path,
    )
    return path


def has_drawtext() -> bool:
    """Whether this ffmpeg was built with `drawtext` (it needs libfreetype, and many are not).

    Homebrew's ffmpeg 8.1 is not, which is why there is a second path below rather than an
    instruction to go and rebuild ffmpeg.
    """
    listing = subprocess.run(
        [FFMPEG, "-hide_banner", "-filters"], capture_output=True, text=True
    ).stdout
    return " drawtext " in listing


def caption_layers() -> list[dict]:
    """Every piece of text in the film, with the seconds it is on screen.

    One list, whichever way it is drawn: the shot captions come straight off the storyboard, and the
    four card lines are the only text that is centred.
    """
    total = total_seconds()
    layers = [
        dict(text=TITLE_TEXT, size=96, place="center", dy=-60, box=False,
             start=0.25, end=TITLE_SECONDS),
        dict(text=TITLE_SUB, size=36, place="center", dy=70, box=False,
             start=0.6, end=TITLE_SECONDS),
        dict(text=END_TEXT, size=54, place="center", dy=-40, box=False,
             start=total - END_SECONDS + 0.25, end=total),
        dict(text=END_SUB, size=32, place="center", dy=50, box=False,
             start=total - END_SECONDS + 0.5, end=total),
    ]
    # Shot captions: bottom-left, in a subtle box, held for the shot minus a short tail so two
    # neighbouring captions never overlap across a cut.
    for entry in timeline():
        if not entry["caption"]:
            continue
        layers.append(
            dict(text=entry["caption"], size=38, place="bottom-left", dy=0, box=True,
                 start=entry["start"] + 0.15, end=entry["end"] - 0.15)
        )
    return layers


CAPTION_MARGIN = 64  # px from the left edge and up from the bottom
CAPTION_PAD = 22  # the box's border around the text


def burn_with_drawtext(source: str, target: str, work: str, layers: list[dict]) -> None:
    """The direct path: one `drawtext` per line, reading its words from a file.

    From a file rather than inline because a filtergraph splits on `,` and `:` — a caption saying
    "p99.9 → p90 (0.190 → 0.112 V/m)" would need three levels of escaping, and the one that gets it
    wrong fails as a missing caption rather than as an error.
    """
    text_dir = os.path.join(work, "captions")
    os.makedirs(text_dir, exist_ok=True)
    filters = []
    for index, layer in enumerate(layers):
        path = os.path.join(text_dir, f"{index:02d}.txt")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(layer["text"])
        if layer["place"] == "center":
            x, y = "(w-tw)/2", f"(h-th)/2{layer['dy']:+d}"
        else:
            x, y = str(CAPTION_MARGIN), f"h-th-{CAPTION_MARGIN + 8}"
        parts = [
            f"drawtext=fontfile={font()}",
            f"textfile={path}",
            "fontcolor=white",
            f"fontsize={layer['size']}",
            f"x={x}",
            f"y={y}",
            f"enable='between(t\\,{layer['start']:.3f}\\,{layer['end']:.3f})'",
        ]
        if layer["box"]:
            parts += ["box=1", "boxcolor=black@0.55", f"boxborderw={CAPTION_PAD}"]
        filters.append(":".join(parts))
    script = os.path.join(work, "captions.filter")
    with open(script, "w", encoding="utf-8") as handle:
        handle.write(",".join(filters))
    ffmpeg(
        "-i", source,
        "-filter_complex_script", script,
        "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        target,
    )


def burn_with_overlays(source: str, target: str, work: str, layers: list[dict]) -> None:
    """The fallback: draw the captions here and lay a single track of them over the film.

    Same font, same box, same positions — the picture is the one `drawtext` would have drawn. It
    needs Pillow, which is the one dependency in this directory and only on this path.

    **One** overlay, not one per caption. Thirty-five looped image inputs composited separately is
    correct and unusably slow (hours, at 1080p); instead the timeline is cut at every point where
    the visible text changes, each interval is rendered to one transparent frame, and those frames
    become a single concat input — so ffmpeg composites one layer and decodes about seventy PNGs.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:  # pragma: no cover - depends on the machine
        raise SystemExit(
            "this ffmpeg has no `drawtext` filter (it needs libfreetype), so the captions have to "
            "be drawn here instead — `pip install Pillow`, or install an ffmpeg built with it."
        )

    png_dir = os.path.join(work, "captions")
    os.makedirs(png_dir, exist_ok=True)

    def render(active: list[dict], path: str) -> None:
        image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        for layer in active:
            face = ImageFont.truetype(font(), layer["size"])
            left, top, right, bottom = draw.textbbox((0, 0), layer["text"], font=face)
            width, height = right - left, bottom - top
            if layer["place"] == "center":
                x = (WIDTH - width) // 2
                y = (HEIGHT - height) // 2 + layer["dy"]
            else:
                x = CAPTION_MARGIN
                y = HEIGHT - height - CAPTION_MARGIN - 8
            if layer["box"]:
                draw.rectangle(
                    [
                        x - CAPTION_PAD,
                        y - CAPTION_PAD,
                        x + width + CAPTION_PAD,
                        y + height + CAPTION_PAD,
                    ],
                    fill=(0, 0, 0, 140),
                )
            draw.text((x - left, y - top), layer["text"], font=face, fill=(255, 255, 255, 255))
        image.save(path)

    # Cut the film wherever any caption appears or disappears; between two cuts the frame is
    # constant, which is what makes one image per interval enough.
    cuts = sorted({0.0, total_seconds()} | {t for l in layers for t in (l["start"], l["end"])})
    entries = []
    for index, (begin, stop) in enumerate(zip(cuts, cuts[1:])):
        if stop - begin < 1.0 / FPS:
            continue
        middle = (begin + stop) / 2
        active = [l for l in layers if l["start"] <= middle < l["end"]]
        path = os.path.join(png_dir, f"{index:03d}.png")
        render(active, path)
        entries.append((path, stop - begin))

    listing = os.path.join(work, "captions.concat")
    with open(listing, "w", encoding="utf-8") as handle:
        handle.write("ffconcat version 1.0\n")
        for path, seconds in entries:
            handle.write(f"file '{path}'\nduration {seconds:.4f}\n")
        # The concat demuxer drops the last entry's duration unless the file is named twice.
        handle.write(f"file '{entries[-1][0]}'\n")

    ffmpeg(
        "-i", source,
        "-f", "concat", "-safe", "0", "-i", listing,
        "-filter_complex",
        f"[1:v]fps={FPS},format=rgba[caps];[0:v][caps]overlay=0:0:shortest=1,format=yuv420p[v]",
        "-map", "[v]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "21",
        "-movflags", "+faststart",
        target,
    )


def burn_captions(source: str, target: str, work: str) -> None:
    """Burn the storyboard's captions and the two cards' words into one pass."""
    layers = caption_layers()
    if has_drawtext():
        burn_with_drawtext(source, target, work, layers)
    else:
        print("  ffmpeg has no drawtext filter — drawing the captions with Pillow instead")
        burn_with_overlays(source, target, work, layers)


def concat(parts: list[str], target: str, work: str) -> None:
    """Join the cards, the tour and the film. Re-encoded, because the parts came from two encoders."""
    listing = os.path.join(work, "concat.txt")
    with open(listing, "w", encoding="utf-8") as handle:
        for part in parts:
            handle.write(f"file '{part}'\n")
    ffmpeg(
        "-f", "concat", "-safe", "0", "-i", listing,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-r", str(FPS),
        target,
    )


# The preview GIF has a hard 8 MB budget and a GIF's size is not predictable from its inputs, so the
# settings are tried in order and the first one under budget wins. Each step gives up either frame
# rate or width — never colour depth below 32, where a brain starts to band.
GIF_LADDER = (
    dict(fps=6, width=640, colors=64),
    dict(fps=5, width=600, colors=64),
    dict(fps=5, width=560, colors=48),
    dict(fps=4, width=520, colors=48),
    dict(fps=4, width=480, colors=32),
)
GIF_BUDGET = 8 * 1024 * 1024


def preview_gif(source: str, target: str) -> None:
    for settings in GIF_LADDER:
        chain = (
            f"fps={settings['fps']},scale={settings['width']}:-2:flags=lanczos,"
            f"split[a][b];[a]palettegen=max_colors={settings['colors']}[p];"
            "[b][p]paletteuse=dither=none"
        )
        ffmpeg("-i", source, "-filter_complex", chain, "-loop", "0", target)
        size = os.path.getsize(target)
        print(f"  gif {settings} → {size / 1e6:.1f} MB")
        if size <= GIF_BUDGET:
            return
    raise SystemExit("could not get the preview GIF under 8 MB")


# ================================================================================================
# 7. The storyboard page
# ================================================================================================


def write_showcase_md(path: str, mp4: str, gif: str) -> None:
    rows = []
    for entry in timeline():
        minutes, seconds = divmod(entry["start"], 60)
        stamp = f"{int(minutes)}:{seconds:04.1f}"
        caption = entry["caption"] or "*(held frame)*"
        rows.append(
            f"| {stamp} | **{entry['shot']}** | {caption} | {entry['frames']} | {entry['note']} |"
        )
    body = "\n".join(rows)
    text = f"""# The showcase video — storyboard

<!-- Generated by examples/capture/showcase.py. Edit the script, not this file. -->

`showcase.mp4` is {WIDTH}×{HEIGHT}, {FPS} fps, **{total_seconds():.1f} s**, H.264 / yuv420p,
{os.path.getsize(mp4) / 1e6:.1f} MB. `showcase-preview.gif` is the same film, {os.path.getsize(gif) / 1e6:.1f} MB.

Neither is hand-edited. [`examples/capture/showcase.py`](../../examples/capture/showcase.py) writes
six job documents, the app renders them offscreen through the same `Engine` calls a user makes with
the mouse ([`docs/AUTOMATION.md`](../AUTOMATION.md)), and ffmpeg joins them and burns the captions
below. The table *is* the caption track: it is the same list the script draws from, so a caption on
screen and a row here cannot disagree.

```sh
scripts/fetch-data.sh                     # data/ernie/, ~906 MB, git-ignored
pip install -e python/
pnpm wasm && pnpm --filter @tetravox/app build
export TETRAVOX_APP="$PWD/node_modules/.bin/electron" TETRAVOX_APP_ARGS="$PWD/packages/app"
python examples/capture/showcase.py
```

## The scene

Six jobs, in fact. The **tour** is two of them — T0–T1 on the atlas and T2–T3 on the head mesh —
each three files, `window.panels: true`, and `view: "window"` captures, so what is on screen is the
actual interface: the layer panel, the region list, the tissue table, the toolbar, the coordinate bar
and the per-layer readouts. Two jobs rather than one because the layer panel lists every layer the
scene loaded, top-down, and the *last* file opened is the one whose controls are on screen: one job
puts the atlas there and the other the mesh.

The **film** (A1–D13) is the other four jobs, over the same seven layers, with the panels off and
every frame off the engine's canvas. Four rather than one for a reason about the disk and not about
the film: 2,540 frames of 1920×1080 PNG is about 3 GB, and they all have to exist at once for
ffmpeg's image2 demuxer to read them back. Per act the peak is a quarter of that, and each act's
frames go as soon as its MP4 exists. It is also why every act opens by setting the state it needs
rather than inheriting it — an act is a fresh scene.

| Layer | Used for |
|---|---|
| `T1.nii.gz` | the anatomy, in 2D and — with `showIn3D` — as three planes in the 3D pane |
| `grey_Thalamus_TI_subject_TI_max.nii.gz` | the TI field as a volume: the heat overlay and its threshold |
| `labeling.nii.gz` (+ `_LUT.txt`) | the atlas, the brainstem isosurface, and the thalamus solo |
| `grey_Thalamus_TI.msh` | the same field on the grey-matter surface |
| `Thalamus_TI.msh` (+ `.msh.opt`) | the head model **and** its `TI_max` element field |
| `ernie_TDCS_1_scalar.msh` | the vector field `E`, for the glyphs |
| `GSN-HydroCel-185.geo` | 183 electrodes |

Everything comes from `data/ernie/` — see [`data/README.md`](../../data/README.md), and
`scripts/fetch-data.sh` to fill it.

## Orientation

Checked by reading extracted frames, not by trusting the code:

* **Axial: anterior up, neurological.** `A` on the top edge, `L` on the left, `NEU` in the corner.
  The convention badge is in every frame and is not optional (ARCHITECTURE §8).
* **Coronal and sagittal: superior up.** `S` top, `I` bottom.
* **3D starts left-lateral** — camera preset `L`, eye on −X, superior up — and moves by eased orbits
  about a world axis from there. Nothing is upside-down, and the two interior shots are behind a
  real clip plane with real caps rather than a camera pushed through a wall.

## Shot list

`t` is the start of each shot on the finished film's clock, the title card included.

| t | Shot | Caption | Frames | Why these numbers |
|---|---|---|---:|---|
{body}

## What is not in it

* **No `.annot` parcellation.** The subject has DK40, a2009s and HCP-MMP1, but only as per-vertex
  surface annotations, and the file dialog does not open one — so the film uses the volumetric atlas
  the subject really has.
* **No clip plane through the brainstem surface.** `IsosurfaceLayer` has no `clip`; that control
  belongs to the mesh layer, and Act D is where it is shown. B5 drives the T1's own axial plane
  through the surface instead, which is a thing the app can actually do.
* **No oblique slice and no measurement tool.** Both are real features and both would have earned a
  shot; the film was already at the top of its length budget.
"""
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


# ================================================================================================
# 8. main
# ================================================================================================


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", default="/tmp/tetravox-showcase", help="where frames and jobs go")
    parser.add_argument("--out", default=None, help="where the MP4/GIF/Markdown go (default docs/media)")
    parser.add_argument("--jobs-only", action="store_true", help="write the job documents and stop")
    args = parser.parse_args()

    require(T1, FIELD_VOLUME, LABELS, GREY_MESH, TET_MESH, VECTOR_MESH, NET, ERNIE_MESH)
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out = args.out or os.path.join(repo, "docs", "media")
    os.makedirs(args.work, exist_ok=True)
    os.makedirs(out, exist_ok=True)

    jobs = [
        ("tour-regions", tour_regions(args.work)),
        ("tour-tissues", tour_tissues(args.work)),
        *build_acts(args.work),
    ]
    for name, path in jobs:
        print(f"job: {path}")
    print(f"storyboard: {len(STORYBOARD)} shots, {total_seconds():.1f} s")
    if args.jobs_only:
        return

    parts = []
    for name, path in jobs:
        out_dir = os.path.join(args.work, name)
        parts.append(run_job_file(path, out_dir))
        # The frames have done their job the moment the MP4 exists, and 1920×1080 PNGs are ~1.2 MB
        # each. Dropping them here is what keeps the peak at one act rather than at the whole film.
        for entry in os.listdir(out_dir):
            if entry.endswith(".png"):
                os.remove(os.path.join(out_dir, entry))

    title = card(os.path.join(args.work, "title.mp4"), TITLE_SECONDS)
    ending = card(os.path.join(args.work, "end.mp4"), END_SECONDS)
    joined = os.path.join(args.work, "joined.mp4")
    concat([title, *parts, ending], joined, args.work)

    mp4 = os.path.join(out, "showcase.mp4")
    burn_captions(joined, mp4, args.work)
    gif = os.path.join(out, "showcase-preview.gif")
    preview_gif(mp4, gif)
    write_showcase_md(os.path.join(out, "SHOWCASE.md"), mp4, gif)

    print(f"\n{mp4}  {os.path.getsize(mp4) / 1e6:.1f} MB")
    print(f"{gif}  {os.path.getsize(gif) / 1e6:.1f} MB")
    print(f"{os.path.join(out, 'SHOWCASE.md')}")


if __name__ == "__main__":
    main()
