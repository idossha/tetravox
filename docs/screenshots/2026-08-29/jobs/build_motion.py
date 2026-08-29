#!/usr/bin/env python3
"""The motion clips of the 2026-08-29 capture set — a GIF and an MP4 for each.

    scripts/fetch-data.sh && scripts/fetch-public-samples.sh
    export TETRAVOX_DATA="$PWD/data/ernie" TETRAVOX_PUBLIC="$PWD/data/public"
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/2026-08-29/jobs/build_motion.py [name ...]

Eight clips, 560 px wide, 24–48 frames, GIF under 4 MB with an MP4 beside it (the website embeds the
MP4, the README the GIF). The PNG frames a job also writes are deleted afterwards: 300-odd frames of
2 MB each are not a thing to keep in `docs/`.

**Every clip has to loop.** An `orbit` already does — its last frame stops one step short of the
full turn, so frame *n* − 1 and frame 0 are one step apart like every other pair. A sweep and a
tween do not: they end at the far end and the GIF snaps back. So each of those is written as a
**there-and-back**, two actions sharing one `out` through `sequence: "start"` / `"end"`, with the
return leg starting and ending one step inside the outward one — otherwise the turn holds a
duplicate frame at each end, which reads as a stutter rather than a stop. `pingpong_*` below does
that arithmetic once.
"""

from __future__ import annotations

import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SET_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SET_DIR)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from tetravox import Job  # noqa: E402

# The client absolutises `Job(files=…)`, so a scene is built with real paths and the **written**
# document is put back to `${TETRAVOX_DATA}` / `${TETRAVOX_PUBLIC}` by `write_job`.
DATA = os.environ.get("TETRAVOX_DATA") or os.path.join(ROOT, "data", "ernie")
PUB = os.environ.get("TETRAVOX_PUBLIC") or os.path.join(ROOT, "data", "public")
VARS = [(PUB, "${TETRAVOX_PUBLIC}"), (DATA, "${TETRAVOX_DATA}")]
OUT = os.path.join(SET_DIR, "motion")

WIDTH = 560
FPS = 12
COLORS = 64  # GIF palette. One global table, undithered (AUTOMATION §2.5).

# ------------------------------------------------------------------------------------------------
# Scene files and the numbers read off them (nibabel / the mesh's `.msh.opt`).

T1 = f"{DATA}/m2m_ernie/T1.nii.gz"
LABELS = f"{DATA}/m2m_ernie/segmentation/labeling.nii.gz"
ERNIE_MESH = f"{DATA}/m2m_ernie/ernie.msh"
FIELD_VOLUME = f"{DATA}/Simulations/Thalamus/TI/niftis/grey_Thalamus_TI_subject_TI_max.nii.gz"
GREY_MESH = f"{DATA}/Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh"
FIELD_LAYER = "grey_Thalamus_TI_subject_TI_max.nii.gz"
# The centre of the grey-matter field volume's non-zero box — the brain, not the T1's box, which
# reaches 143 mm below it into the neck.
BRAIN_C = (2.3, 11.2, 15.9)

# T1's world bounding box centre — the in-plane origin `center` is measured from (§7.5 planeAnchor).
T1_C = (3.8, 26.7, -16.1)
# `labeling.nii.gz` label 17, the left hippocampus: the zoom's destination, located by the atlas.
HIPPOCAMPUS_L = (-22.8, 5.3, 0.5)

# The grey-matter TI volume over its 702,214 non-zero voxels:
#   p50 0.0810  p90 0.1121  p97 0.1325  p99 0.1529  p99.9 0.1903  max 0.4043 V/m
FIELD_P50, FIELD_P97 = 0.0810, 0.1325

# The 41 intracranial ids of `labeling_LUT.txt`. Outlining *every* label draws the scalp, the skull
# and the eyes over the whole pane — a wash, not an atlas.
INTRACRANIAL = [
    2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 29, 30, 31,
    41, 42, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60, 62, 63, 72, 77, 80, 85,
]

# Tissue tags of `ernie.msh`, named by its `.msh.opt` (the mesh has no `$PhysicalNames`).
WM, GM, CSF, SCALP, COMPACT_BONE, SPONGY_BONE = 1001, 1002, 1003, 1005, 1007, 1008

AMOS_CT = f"{PUB}/amos22-ct/amos_0004_ct.nii.gz"
AMOS_CT_SEG = f"{PUB}/amos22-ct/amos_0004_seg.nii.gz"
AMOS_CT_C = (-3.9, 0.0, 1310.0)
AMOS_ORGANS_3D = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
AMOS_ORGAN_MASS = (9.2, -4.1, 1396.0)

SPINE_CT = f"{PUB}/ctspine1k/volume-covid19-A-0377_ct.nii.gz"
SPINE_CT_SEG = f"{PUB}/ctspine1k/volume-covid19-A-0377_ct_seg.nii.gz"
SPINE_COLUMN = (1.6, -35.2, -74.4)

# The sagittal clip's two ends, as **plane offsets**. The shader keeps `dot(n, p) + offset >= 0`
# with n = +x, so the surviving half is `x >= -offset` and the plane sits at `x = -offset`: +72 is
# the left scalp, -12 is a centimetre past the midline.
CLIP_X_FROM, CLIP_X_TO = 72.0, -12.0
# The cranium's centre, which the clip clip's camera aims at.
HEAD_C = (0.0, 12.0, 30.0)

BONE = {"kind": "linear", "lo": -450, "hi": 1050}
SOFT = {"kind": "linear", "lo": -160, "hi": 240}


# ------------------------------------------------------------------------------------------------
# Helpers


def pan_axial(c, p):
    return [p[0] - c[0], p[1] - c[1]]


def pan_coronal(c, p):
    return [p[0] - c[0], p[2] - c[2]]


def pan_sagittal(c, p):
    return [-(p[1] - c[1]), p[2] - c[2]]


def aim(job, target, distance):
    """Move the 3D camera's target — `set` cannot, and a one-frame tween leaves the scene there."""
    job.tween(
        "_aim", frames=1, gif=False, view="view3d", width=64, height=64,
        to={"target": list(target), "distance": distance},
    )
    return job


def pingpong_sweep(job, out, view, lo, hi, count, **kw):
    """`count` frames out and `count - 2` back: `2*count - 2` frames that loop with no repeat."""
    step = (hi - lo) / (count - 1)
    job.sweep(out, view=view, start=lo, stop=hi, count=count, sequence="start", **kw)
    job.sweep(
        out, view=view, start=hi - step, stop=lo + step, count=count - 2, sequence="end", **kw
    )
    return job


def pingpong_tween(job, out, path_from, path_to, count, state, **kw):
    """The tween equivalent: out and back over one numeric leaf, `2*count - 2` frames.

    `state(value)` turns one number into a tween state, so the two legs cannot drift apart.
    """
    step = 1.0 / (count - 1)

    def lerp(t):
        return path_from + (path_to - path_from) * t

    job.tween(out, frames=count, start=state(path_from), to=state(path_to), sequence="start", **kw)
    job.tween(
        out,
        frames=count - 2,
        start=state(lerp(1 - step)),
        to=state(lerp(step)),
        sequence="end",
        **kw,
    )
    return job


def write_job(name, job):
    text = job.to_json()
    for real, var in VARS:
        text = text.replace(os.path.realpath(real), var).replace(real, var)
    with open(os.path.join(HERE, f"{name}.json"), "w") as fh:
        fh.write(text if text.endswith("\n") else text + "\n")


def run(name, job):
    """Render, then throw the PNG frames away — the GIF and the MP4 are the deliverables."""
    write_job(name, job)
    os.makedirs(OUT, exist_ok=True)
    r = job.run(OUT)
    for w in r.warnings:
        print("   warn:", w)
    r.raise_for_status()
    for png in glob.glob(os.path.join(OUT, "*-[0-9][0-9][0-9][0-9].png")):
        os.remove(png)
    for stray in ("job-result.json",):
        path = os.path.join(OUT, stray)
        if os.path.exists(path):
            os.remove(path)
    gif = os.path.join(OUT, f"{name}.gif")
    size = os.path.getsize(gif) / 1e6 if os.path.exists(gif) else 0.0
    print(f"[ok] {name}: gif {size:.2f} MB")


# `colorbar=False` because a frame action's `include` defaults to the colour bar **on**, and the
# scene's `annotations` do not override a capture's `include`. Only the field clip has a field.
CLIP = dict(
    fps=FPS, format="mp4", colors=COLORS, width=WIDTH, height=WIDTH, colorbar=False
)


# ================================================================================================
# 1. Orbits
# ================================================================================================


def orbit_head_translucent():
    """`ernie.msh` turned about the superior axis: scalp 0.3, skull 0.5, brain opaque."""
    j = Job(files=[ERNIE_MESH], preset="mesh-tissues-translucent", window=(WIDTH, WIDTH))
    j.set(layout="3d-only")
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="view3d", camera="A", distance=290)
    j.orbit("orbit-head-translucent", frames=36, degrees=360, axis="z", **CLIP)
    run("orbit-head-translucent", j)


def orbit_spine_vertebrae():
    """The CTSpine1K vertebra surfaces turning inside the CT's own three planes."""
    j = Job(files=[SPINE_CT, SPINE_CT_SEG], window=(WIDTH, WIDTH))
    # `showIn3D` puts **all three** slice planes in the 3D pane — there is no per-plane switch — and
    # the coronal one alone fills the frame and hides the vertebrae it is meant to sit behind. So the
    # clip is the surfaces on their own.
    j.set(layer="volume-covid19-A-0377_ct.nii.gz", patch={"scale": BONE, "showIn3D": False})
    j.set(
        layer="volume-covid19-A-0377_ct_seg.nii.gz",
        patch={
            # `visible` must stay true: a derived surface is visible only when the volume layer is
            # (`layers/iso3d.ts`), so hiding the label slices hides the vertebrae with them.
            "visible": True,
            "interpolation": "nearest",
            "showIn3D": True,
            "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True},
        },
    )
    j.set(layout="3d-only", cursor=SPINE_COLUMN)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="view3d", camera="A", distance=400)
    j.orbit("orbit-spine-vertebrae", frames=36, degrees=360, axis="z", **CLIP)
    run("orbit-spine-vertebrae", j)


def orbit_abdomen_organs():
    """AMOS22's fifteen organ labels as fifteen surfaces, turning."""
    j = Job(files=[AMOS_CT, AMOS_CT_SEG], window=(WIDTH, WIDTH))
    j.set(layer="amos_0004_ct.nii.gz", patch={"visible": False, "showIn3D": False})
    j.set(
        layer="amos_0004_seg.nii.gz",
        patch={
            "visibleLabels": AMOS_ORGANS_3D,
            "interpolation": "nearest",
            "showIn3D": True,
            "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True},
        },
    )
    j.set(layout="3d-only", cursor=AMOS_ORGAN_MASS)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="view3d", camera="A")
    aim(j, AMOS_ORGAN_MASS, 430)
    j.orbit("orbit-abdomen-organs", frames=36, degrees=360, axis="z", **CLIP)
    run("orbit-abdomen-organs", j)


# ================================================================================================
# 2. Sweeps
# ================================================================================================


def sweep_axial_t1_atlas():
    """Inferior to superior through the T1 with the atlas outlined, and back."""
    j = Job(files=[T1, LABELS], window=(WIDTH, WIDTH))
    j.set(layer="T1.nii.gz", patch={"showIn3D": False})
    j.set(
        layer="labeling.nii.gz",
        patch={
            "labelMode": "outline",
            "outlineWidthPx": 2,
            "opacity": 0.9,
            "interpolation": "nearest",
            "visibleLabels": INTRACRANIAL,
        },
    )
    j.set(layout="1x3", cursor=(0.0, 0.0, 0.0), radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="axial", mm_per_px=0.36, center=pan_axial(T1_C, (0.0, 8.0, 0.0)))
    pingpong_sweep(j, "sweep-axial-t1-atlas", "axial", -45.0, 70.0, 17, **CLIP)
    run("sweep-axial-t1-atlas", j)


def sweep_coronal_abdomen_ct():
    """Front to back through the AMOS22 CT with the organ labels filled, and back."""
    j = Job(files=[AMOS_CT, AMOS_CT_SEG], window=(WIDTH, WIDTH))
    j.set(layer="amos_0004_ct.nii.gz", patch={"scale": SOFT, "showIn3D": False})
    j.set(
        layer="amos_0004_seg.nii.gz",
        patch={"labelMode": "fill", "opacity": 0.55, "interpolation": "nearest"},
    )
    j.set(layout="1x3", cursor=AMOS_ORGAN_MASS, radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="coronal", mm_per_px=0.50, center=pan_coronal(AMOS_CT_C, (7.6, 0.0, 1370.0)))
    # `from`/`to` are millimetres along the **view's normal**, and coronal's normal is -Y, so these
    # run from world y = +25 (the front of the abdominal wall) to y = -55 (behind the kidneys).
    pingpong_sweep(j, "sweep-coronal-abdomen-ct", "coronal", -25.0, 55.0, 17, **CLIP)
    run("sweep-coronal-abdomen-ct", j)


# ================================================================================================
# 3. Tweens
# ================================================================================================


def clip_head_sagittal():
    """A sagittal clip plane driven through the head mesh, with capped cuts, and back.

    The plane is installed by a `set` first: a tween names *leaves* and deep-merges onto what is
    already there, so there has to be a plane for its `offset` to be a leaf of.

    Filmed from the **left**, not from in front. The plane's normal is +x and the shader keeps
    `dot(normal, p) + offset >= 0`, so the material that survives is the right-hand side and the
    capped cut face looks left: an anterior camera sees it edge-on, and the ends of the loop are a
    sliver. From `camera: "L"` the cut face is what fills the frame for every frame of the sweep.
    """
    j = Job(files=[ERNIE_MESH], preset="mesh-tissues-translucent", window=(WIDTH, WIDTH))
    j.set(
        layer="ernie.msh",
        patch={
            "tagStyle": {str(SCALP): {"opacity": 1.0}, str(COMPACT_BONE): {"opacity": 1.0}},
            "clip": {
                "planes": [{"plane": {"normal": [1, 0, 0], "offset": CLIP_X_FROM}, "enabled": True}],
                "caps": True,
            },
        },
    )
    j.set(layout="3d-only")
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="view3d", camera="L", distance=270)
    # The mesh runs 143 mm down into the neck, so the scene's centre is not the head's: aim at the
    # cranium and pull back far enough for the whole cut face to sit inside the 560 px frame.
    aim(j, HEAD_C, 360)

    def state(offset):
        return {
            "layers": [
                {
                    "layer": "ernie.msh",
                    "patch": {"clip": {"planes": [{"plane": {"offset": offset}}]}},
                }
            ]
        }

    # The plane travels from x = -72 (just inside the left scalp, so frame 0 already shows a cap)
    # to x = +12, a centimetre past the midline. `offset = -x`, hence +72 -> -12.
    pingpong_tween(j, "clip-head-sagittal", CLIP_X_FROM, CLIP_X_TO, 25, state, view="view3d", **CLIP)
    run("clip-head-sagittal", j)


def zoom_axial_detail():
    """The axial pane stepping from a whole-head overview into the left hippocampus, and back."""
    j = Job(files=[T1, LABELS], window=(WIDTH, WIDTH))
    j.set(layer="T1.nii.gz", patch={"showIn3D": False})
    j.set(
        layer="labeling.nii.gz",
        patch={
            "labelMode": "outline",
            "outlineWidthPx": 2,
            "opacity": 0.9,
            "interpolation": "nearest",
            "visibleLabels": INTRACRANIAL,
        },
    )
    j.set(layout="1x3", cursor=HIPPOCAMPUS_L, radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": True})

    over = pan_axial(T1_C, (0.0, 8.0, 0.0))
    into = pan_axial(T1_C, HIPPOCAMPUS_L)

    def state(t):
        """`t` runs 0 (overview) to 1 (detail); zoom and pan move together on the same clock."""
        return {
            "views": {
                "axial": {
                    # 0.20 mm/px, not 0.13: the T1 is 1 mm isotropic, and past about 5x the pane is
                    # showing the interpolator rather than the scan.
                    "mmPerPx": 0.40 + (0.20 - 0.40) * t,
                    "center": [
                        over[0] + (into[0] - over[0]) * t,
                        over[1] + (into[1] - over[1]) * t,
                    ],
                }
            }
        }

    pingpong_tween(
        j, "zoom-axial-detail", 0.0, 1.0, 19, state, view="axial", scale_bar=True, **CLIP
    )
    run("zoom-axial-detail", j)


def field_threshold_rise():
    """The simulated field's threshold climbing p50 -> p97 over the T1, and falling back.

    The grey-matter mesh is a **plain surface** here, not a second copy of the field: it is the
    backdrop the 2D overlay is read against, and a mesh left on its defaults paints a flat blue
    slab over both panes (`colorMode` is `tag`, and `fillIn2D` fills the 2D cut).
    """
    j = Job(files=[T1, FIELD_VOLUME, GREY_MESH], preset="ti-field-on-t1", window=(WIDTH, WIDTH))
    j.set(layer="T1.nii.gz", patch={"showColorbar": False, "showIn3D": False})
    j.set(
        layer="grey_Thalamus_TI.msh",
        patch={
            "colorMode": "solid",
            "solidColor": [0.72, 0.72, 0.75, 1],
            "fillIn2D": False,
            "contoursIn2D": False,
            "showColorbar": False,
            "opacity": 1.0,
        },
    )
    j.set(layer=FIELD_LAYER, patch={"showColorbar": True})
    # 2x2 rather than `3d+1`: at 560 px square, `3d+1` gives two 280 x 560 panes and a head is the
    # wrong shape for one. Four 280 x 280 panes each hold a whole head at 0.66 mm/px.
    j.set(layout="2x2", cursor=(0.0, 9.0, 18.0), radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": True, "scaleBar": False})
    for view, pan in (("axial", pan_axial), ("coronal", pan_coronal), ("sagittal", pan_sagittal)):
        j.set(view=view, mm_per_px=0.66, center=pan(T1_C, BRAIN_C))
    j.set(view="view3d", camera="L")
    aim(j, BRAIN_C, 300)

    def state(lo):
        return {"layers": [{"layer": FIELD_LAYER, "patch": {"threshold": {"lo": lo}}}]}

    pingpong_tween(
        j,
        "field-threshold-rise",
        FIELD_P50,
        FIELD_P97,
        15,
        state,
        view="grid",
        # Four T1 panes is the densest frame in the set: 36 frames at 64 colours is 4.15 MB, so this
        # one runs 28 frames at 40 colours to stay under the 4 MB budget.
        **{**CLIP, "colorbar": True, "colors": 40},
    )
    run("field-threshold-rise", j)


CLIPS = {
    "orbit-head-translucent": orbit_head_translucent,
    "orbit-spine-vertebrae": orbit_spine_vertebrae,
    "orbit-abdomen-organs": orbit_abdomen_organs,
    "sweep-axial-t1-atlas": sweep_axial_t1_atlas,
    "sweep-coronal-abdomen-ct": sweep_coronal_abdomen_ct,
    "clip-head-sagittal": clip_head_sagittal,
    "zoom-axial-detail": zoom_axial_detail,
    "field-threshold-rise": field_threshold_rise,
}


if __name__ == "__main__":
    names = sys.argv[1:] or list(CLIPS)
    for n in names:
        if n not in CLIPS:
            sys.exit(f"unknown clip {n!r}; one of {', '.join(CLIPS)}")
    for n in names:
        CLIPS[n]()
