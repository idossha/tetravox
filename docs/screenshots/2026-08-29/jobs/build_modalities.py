#!/usr/bin/env python3
"""Non-brain stills for the 2026-08-29 capture set — hero, modalities, features.

    scripts/fetch-public-samples.sh                     # data/public/, ~190 MB
    export TETRAVOX_PUBLIC="$PWD/data/public"
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/2026-08-29/jobs/build_modalities.py [name ...]

Every job document is written next to this file with `${TETRAVOX_PUBLIC}` paths, so a committed job
runs on any checkout that has fetched the samples.

**The framing is explicit, never `reset`.** `reset` fits one axis of a pane and leaves black on the
other, and on a CT whose field of view is the scanner bore rather than the patient it leaves the body
small in the middle. So each shot names its own `mmPerPx` (the mm a pane covers, divided by its pixel
width) and its own `center`, computed from the numbers below by `pan_*` — the volume's world bounding
box and the centroid of the structure the shot is about, read off the files with nibabel, not by eye.

The pane bases, from `packages/engine/src/view/geometry.ts` (`sliceBasis`), are what make `center`
computable rather than a fiddle:

| view | screen right | screen up | `center` |
|---|---|---|---|
| axial | +X (patient right) | +Y (anterior) | `[dx, dy]` |
| coronal | +X | +Z (superior) | `[dx, dz]` |
| sagittal | −Y (posterior) | +Z | `[-dy, dz]` |

`d` is measured from the **scene bounding box centre**, which is the pane's in-plane origin (§7.5's
`planeAnchor`), not from the cursor.

**Why the single-pane shots set `1x3` and not `1x1`.** A screenshot's `view` selects a pane of the
*current layout* (`Engine.paneRect`), and a job has no way to say which slice a `1x1` shows —
`layoutCells('1x1', …)` takes the shell's active view, which only a click sets, so `1x1` is always
the axial one and `view: "sagittal"` silently photographs it. `1x3` has all three panes, and giving
a screenshot **both** `width` and `height` renders the chosen one at exactly that size, so the
output is a single pane of the shape the shot wants.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SET_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SET_DIR)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from tetravox import Job  # noqa: E402

# The Python client absolutises `Job(files=...)`, so the scene is built with the real paths and the
# **written** document is de-absolutised back to `${TETRAVOX_PUBLIC}` by `write_job` — a committed job
# that names one machine's home directory is a job nobody else can run.
PUB = os.environ.get("TETRAVOX_PUBLIC") or os.path.join(ROOT, "data", "public")
PUB_VAR = "${TETRAVOX_PUBLIC}"
HERO = os.path.join(SET_DIR, "hero")
MOD = os.path.join(SET_DIR, "modalities")
FEAT = os.path.join(SET_DIR, "features")

# ------------------------------------------------------------------------------------------------
# Hounsfield windows, as `scale` on the CT layer. W/L in the radiologist's units.
BONE = {"kind": "linear", "lo": -450, "hi": 1050}  # W1500 / L300
SOFT = {"kind": "linear", "lo": -160, "hi": 240}  # W400  / L40
LUNG = {"kind": "linear", "lo": -1350, "hi": 150}  # W1500 / L-600

# ------------------------------------------------------------------------------------------------
# Geometry read off the files (nibabel: world bbox of the volume, centroid of the labelled voxels).
# `C` is the scene bounding box centre — the in-plane origin every `center` below is measured from.

AMOS_CT = f"{PUB}/amos22-ct/amos_0004_ct.nii.gz"
AMOS_CT_SEG = f"{PUB}/amos22-ct/amos_0004_seg.nii.gz"
AMOS_CT_C = (-3.9, 0.0, 1310.0)  # bbox 400 x 400 x 385 mm, 0.78 x 0.78 x 5 mm voxels
AMOS_CT_ORGANS = (7.6, -4.7, 1420.3)  # centroid of labels 1..15
AMOS_CT_LIVER = (45.0, -0.4, 1450.0)  # label 6
# The thoraco-abdominal organs, without the pelvic pair (14 bladder, 15 prostate/uterus).
ABDOMEN_ORGANS_3D = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
# Where that set actually *looks* like it is: the aorta and IVC trail 200 mm below everything else as
# a 6 mm tube, so the bounding box of labels 1..13 is not what a camera should be pointed at.
AMOS_CT_ORGAN_MASS = (9.2, -4.1, 1396.0)

AMOS_MR = f"{PUB}/amos22-mri/amos_0555_mri.nii.gz"
AMOS_MR_SEG = f"{PUB}/amos22-mri/amos_0555_seg.nii.gz"
AMOS_MR_C = (-3.0, 0.7, 73.3)  # bbox 399 x 321 x 213 mm
AMOS_MR_ORGANS = (31.9, 9.6, 94.6)

SPINE_CT = f"{PUB}/ctspine1k/volume-covid19-A-0377_ct.nii.gz"
SPINE_CT_SEG = f"{PUB}/ctspine1k/volume-covid19-A-0377_ct_seg.nii.gz"
SPINE_CT_C = (-3.8, 0.1, -67.5)  # bbox 379 x 379 x 250 mm
SPINE_COLUMN = (1.6, -35.2, -74.4)  # centroid of the vertebra labels (T2..T11 here)

CHEST_CT = f"{PUB}/niivue-images/CT_Abdo.nii.gz"
CHEST_CT_C = (-36.7, 0.7, 9.3)  # bbox 379 x 264 x 381 mm, isotropic 1.49 mm

SPINE_MR = f"{PUB}/totalsegmentator-mr/s0375/mri.nii.gz"
SPINE_MR_SEG = f"{PUB}/totalsegmentator-mr/s0375/seg.nii.gz"
SPINE_MR_C = (13.2, -9.6, 36.6)  # 14 sagittal slices, 0.67 mm in plane
SPINE_MR_COLUMN = (11.8, -10.9, 72.4)  # label 19 `vertebrae`

PELVIS_MR = f"{PUB}/totalsegmentator-mr/s0132/mri.nii.gz"
PELVIS_MR_SEG = f"{PUB}/totalsegmentator-mr/s0132/seg.nii.gz"
PELVIS_MR_C = (-22.5, -50.9, -127.6)

BODY_MR = f"{PUB}/totalsegmentator-mr/s0175/mri.nii.gz"
BODY_MR_SEG = f"{PUB}/totalsegmentator-mr/s0175/seg.nii.gz"
BODY_MR_C = (0.6, 0.6, -328.0)  # 1077 mm of subject along Z

# MRI has no Hounsfield scale, so a window is per file: p2..p98 of the volume, rounded.
MR_SCALE = {"amos": (0, 340), "s0375": (0, 340), "s0132": (0, 230), "s0175": (0, 340)}


def lin(lo: float, hi: float) -> dict:
    return {"kind": "linear", "lo": lo, "hi": hi}


# ------------------------------------------------------------------------------------------------
# `center` from a world point


def pan_axial(c, p):
    return [p[0] - c[0], p[1] - c[1]]


def pan_coronal(c, p):
    return [p[0] - c[0], p[2] - c[2]]


def pan_sagittal(c, p):
    return [-(p[1] - c[1]), p[2] - c[2]]


PAN = {"axial": pan_axial, "coronal": pan_coronal, "sagittal": pan_sagittal}


def frame(job, c, spec):
    """Point each pane at its own world point at its own zoom — the explicit alternative to `reset`.

    `spec` is `{view: (mmPerPx, point)}`. Per pane rather than one number for all three because the
    three planes of a body CT are not the same shape: an abdominal axial is 380 mm of patient, the
    matching sagittal is 260 mm of patient plus 60 mm of scanner table.
    """
    for v, (mm, p) in spec.items():
        job.set(view=v, mm_per_px=mm, center=PAN[v](c, p))
    return job


# The 3D camera's *target* is the scene bounding box centre, and `set` cannot move it: `reset` refits
# the whole box and `camera` only rotates. A one-frame `tween` can — `to.target` is part of a tween's
# state, and "a tween leaves the scene where it ended" — so `aim` is a move, not a capture, and its
# single throwaway frame is deleted by `run`. It is what puts a 200 mm organ block that sits 90 mm
# above the middle of a 385 mm scan in the middle of the 3D pane.
AIM = "_aim"


def aim(job, target, distance):
    job.tween(
        AIM,
        frames=1,
        gif=False,
        view="view3d",
        width=64,
        height=64,
        to={"target": list(target), "distance": distance},
    )
    return job


def write_job(name, job):
    """The document as committed: real paths swapped back for `${TETRAVOX_PUBLIC}`."""
    text = job.to_json()
    text = text.replace(os.path.realpath(PUB), PUB_VAR).replace(PUB, PUB_VAR)
    with open(os.path.join(HERE, f"{name}.json"), "w") as fh:
        fh.write(text if text.endswith("\n") else text + "\n")


def run(name, job, out_dir):
    write_job(name, job)
    os.makedirs(out_dir, exist_ok=True)
    r = job.run(out_dir)
    for stray in (f"{AIM}-0000.png",):
        path = os.path.join(out_dir, stray)
        if os.path.exists(path):
            os.remove(path)
    for w in r.warnings:
        print("   warn:", w)
    r.raise_for_status()
    print(f"[ok] {name}: {len(r.files)} files -> {os.path.relpath(out_dir, ROOT)}")


# ================================================================================================
# 1. AMOS22 CT 0004 — the abdomen. Hero 2x2, the soft-window pane, the labels, the organ surfaces.
# ================================================================================================
#
# 15 organs, 5 mm slices. The 2x2 is framed on the organ block rather than on the volume: the CT's
# field of view is 400 mm of scanner bore around a 330 mm patient, and half of `reset` is table.


def abdomen_ct():
    j = Job(files=[AMOS_CT, AMOS_CT_SEG], window=(1400, 900))
    j.set(layer="amos_0004_ct.nii.gz", patch={"scale": SOFT, "showIn3D": False})
    j.set(
        layer="amos_0004_seg.nii.gz",
        patch={"labelMode": "fill", "opacity": 0.55, "interpolation": "nearest"},
    )
    j.set(layout="2x2", cursor=AMOS_CT_ORGANS, radiological=False)
    j.set(annotations={"crosshair": True, "colorbar": False, "scaleBar": False})
    frame(
        j,
        AMOS_CT_C,
        {
            "axial": (0.46, (7.6, -5.0, 1420.3)),
            "coronal": (0.54, (7.6, -4.7, 1380.0)),
            # Sagittal is narrowed and moved anteriorly to keep the scanner table (y ~ -155, the
            # white arc under the patient in the axial pane) out of the frame.
            "sagittal": (0.42, (7.6, 20.0, 1400.0)),
        },
    )
    # The organs as surfaces, with the CT's own planes out of the 3D pane so the anatomy is the
    # segmentation rather than three grey squares.
    j.set(
        layer="amos_0004_seg.nii.gz",
        patch={
            # Bladder and prostate (14, 15) sit 240 mm below the rest of the set, so a 3D pane that
            # frames all fifteen frames mostly empty pelvis. They are absent from the slices these
            # shots show, so narrowing costs nothing on screen.
            "visibleLabels": ABDOMEN_ORGANS_3D,
            "showIn3D": True,
            "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True},
        },
    )
    j.set(view="view3d", camera="A")
    aim(j, AMOS_CT_ORGAN_MASS, 340)
    j.screenshot("hero-abdomen-ct-2x2", view="grid", width=1400, height=900, crosshair=True, colorbar=False)
    run("hero-abdomen-ct", j, HERO)


def abdomen_ct_panes():
    j = Job(files=[AMOS_CT, AMOS_CT_SEG], window=(1000, 700))
    j.set(layer="amos_0004_ct.nii.gz", patch={"scale": SOFT, "showIn3D": False})
    j.set(layer="amos_0004_seg.nii.gz", patch={"visible": False})
    j.set(layout="1x3", cursor=AMOS_CT_ORGANS, radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    # 900 x 630 px at 0.30 mm/px is 270 x 189 mm around a 252 x 154 mm patient — and it leaves the
    # scanner table (the white arc at y = -155) outside the frame.
    j.set(view="axial", mm_per_px=0.30, center=pan_axial(AMOS_CT_C, (7.6, -8.0, 1420.3)))
    j.screenshot(
        "mod-abdomen-ct-soft-axial", view="axial", width=900, height=630, colorbar=False
    )
    j.set(
        layer="amos_0004_seg.nii.gz",
        patch={
            "visible": True,
            "labelMode": "outline",
            "outlineWidthPx": 2,
            "opacity": 1.0,
            "interpolation": "nearest",
        },
    )
    j.screenshot(
        "mod-abdomen-ct-labels-axial", view="axial", width=900, height=630, colorbar=False
    )
    # `feat-isosurface-organs-abdomen` and `mod-abdomen-ct-labels-3d` are the same idea from two
    # cameras: the label volume's per-region marching cubes, no brain in sight.
    j.set(
        layer="amos_0004_seg.nii.gz",
        patch={
            # Bladder and prostate (14, 15) sit 240 mm below the rest of the set, so a 3D pane that
            # frames all fifteen frames mostly empty pelvis. They are absent from the slices these
            # shots show, so narrowing costs nothing on screen.
            "visibleLabels": ABDOMEN_ORGANS_3D,
            "showIn3D": True,
            "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True},
        },
    )
    j.set(layout="3d-only")
    j.set(view="view3d", camera="A")
    aim(j, AMOS_CT_ORGAN_MASS, 400)
    j.screenshot(
        "mod-abdomen-ct-labels-3d", view="view3d", width=900, height=760, colorbar=False
    )
    run("mod-abdomen-ct", j, MOD)


def abdomen_organs_iso():
    j = Job(files=[AMOS_CT, AMOS_CT_SEG], window=(1000, 900))
    j.set(layer="amos_0004_ct.nii.gz", patch={"scale": SOFT, "showIn3D": False, "visible": False})
    j.set(
        layer="amos_0004_seg.nii.gz",
        patch={
            "visibleLabels": ABDOMEN_ORGANS_3D,
            "showIn3D": True,
            "interpolation": "nearest",
            "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True},
        },
    )
    j.set(layout="3d-only", cursor=AMOS_CT_ORGANS)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="view3d", camera="1")
    aim(j, AMOS_CT_ORGAN_MASS, 430)
    j.screenshot(
        "feat-isosurface-organs-abdomen", view="view3d", width=900, height=900, colorbar=False
    )
    run("feat-isosurface-organs-abdomen", j, FEAT)


# ================================================================================================
# 2. CTSpine1K A-0377 — the spine. Hero 2x2, the bone-window sagittal, the labels, the surfaces.
# ================================================================================================


def spine_ct():
    j = Job(files=[SPINE_CT, SPINE_CT_SEG], window=(1400, 900))
    j.set(layer="volume-covid19-A-0377_ct.nii.gz", patch={"scale": BONE, "showIn3D": False})
    j.set(
        layer="volume-covid19-A-0377_ct_seg.nii.gz",
        patch={"labelMode": "fill", "opacity": 0.7, "interpolation": "nearest"},
    )
    j.set(layout="2x2", cursor=SPINE_COLUMN, radiological=False)
    j.set(annotations={"crosshair": True, "colorbar": False, "scaleBar": False})
    frame(
        j,
        SPINE_CT_C,
        {
            "axial": (0.48, SPINE_COLUMN),
            "coronal": (0.48, (1.6, -35.2, -70.0)),
            "sagittal": (0.34, (1.6, -20.0, -70.0)),
        },
    )
    j.set(
        layer="volume-covid19-A-0377_ct_seg.nii.gz",
        patch={"showIn3D": True, "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True}},
    )
    j.set(view="view3d", camera="A", distance=460)
    j.screenshot("hero-spine-ct-2x2", view="grid", width=1400, height=900, crosshair=True, colorbar=False)
    run("hero-spine-ct", j, HERO)


def spine_ct_panes():
    j = Job(files=[SPINE_CT, SPINE_CT_SEG], window=(760, 900))
    j.set(layer="volume-covid19-A-0377_ct.nii.gz", patch={"scale": BONE, "showIn3D": False})
    j.set(layer="volume-covid19-A-0377_ct_seg.nii.gz", patch={"visible": False})
    j.set(layout="1x3", cursor=SPINE_COLUMN, radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": True})
    j.set(view="sagittal", mm_per_px=0.30, center=pan_sagittal(SPINE_CT_C, (1.6, -25.0, -70.0)))
    j.screenshot("mod-spine-ct-sagittal", view="sagittal", width=760, height=900, scale_bar=True, colorbar=False)
    j.set(
        layer="volume-covid19-A-0377_ct_seg.nii.gz",
        patch={
            "visible": True,
            "labelMode": "both",
            "outlineWidthPx": 2,
            "opacity": 0.75,
            "interpolation": "nearest",
        },
    )
    j.screenshot("mod-spine-ct-labels-sagittal", view="sagittal", width=760, height=900, scale_bar=True, colorbar=False)
    j.set(
        layer="volume-covid19-A-0377_ct_seg.nii.gz",
        patch={"showIn3D": True, "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True}},
    )
    j.set(layout="3d-only")
    j.set(view="view3d", camera="L", distance=470)
    j.screenshot("mod-spine-ct-labels-3d", view="view3d", width=760, height=900, colorbar=False)
    run("mod-spine-ct", j, MOD)


# ================================================================================================
# 3. niivue CT_Abdo — the chest, in a lung window. Overview and the lung bases.
# ================================================================================================


def chest_ct():
    j = Job(files=[CHEST_CT], window=(1400, 900))
    # The 3D pane is the body surface, not the three slice planes: a plane seen face-on in the 3D
    # pane only repeats the 2D one next to it. -300 HU is the fat/air boundary, so the surface is
    # the skin — `iso3d` on a scalar volume is a level, not a region.
    j.set(
        layer="CT_Abdo.nii.gz",
        patch={
            "scale": LUNG,
            "showIn3D": False,
            "iso3d": {
                "enabled": True,
                "iso": -300,
                "color": [0.82, 0.72, 0.64, 1],
                "opacity": 1.0,
                "smooth": True,
                "faceMode": "cull",
            },
        },
    )
    j.set(layout="2x2", cursor=(-36.7, -20.0, 60.0), radiological=False)
    j.set(annotations={"crosshair": True, "colorbar": False, "scaleBar": False})
    frame(
        j,
        CHEST_CT_C,
        {
            "axial": (0.55, (-36.7, -10.0, 30.0)),
            "coronal": (0.55, (-36.7, -10.0, 30.0)),
            "sagittal": (0.40, (-36.7, -10.0, 30.0)),
        },
    )
    j.set(view="view3d", camera="A", distance=600)
    j.screenshot("mod-chest-ct-lung-2x2", view="grid", width=1400, height=900, crosshair=True, colorbar=False)
    run("mod-chest-ct-lung", j, MOD)


def chest_ct_zoom():
    j = Job(files=[CHEST_CT], window=(1000, 800))
    j.set(layer="CT_Abdo.nii.gz", patch={"scale": LUNG, "showIn3D": False})
    j.set(layout="1x3", cursor=(-36.7, -30.0, -20.0), radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": True})
    # 0.22 mm/px on a 1.49 mm isotropic CT is about 7x the voxel — past that the pane is showing
    # the interpolator rather than the scan. 2.5x the overview's 0.55, on the left lung base.
    j.set(view="coronal", mm_per_px=0.22, center=pan_coronal(CHEST_CT_C, (-105.0, -30.0, -10.0)))
    j.screenshot("mod-chest-ct-lung-zoom", view="coronal", width=900, height=800, scale_bar=True, colorbar=False)
    run("mod-chest-ct-lung-zoom", j, MOD)


# ================================================================================================
# 4. AMOS22 MRI 0555 — the same 15 organs on a T1-weighted abdomen MRI.
# ================================================================================================


def abdomen_mri():
    lo, hi = MR_SCALE["amos"]
    j = Job(files=[AMOS_MR, AMOS_MR_SEG], window=(1000, 700))
    j.set(layer="amos_0555_mri.nii.gz", patch={"scale": lin(lo, hi), "showIn3D": False})
    j.set(layer="amos_0555_seg.nii.gz", patch={"visible": False})
    j.set(layout="1x3", cursor=AMOS_MR_ORGANS, radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="coronal", mm_per_px=0.40, center=pan_coronal(AMOS_MR_C, (-3.0, 9.6, 73.3)))
    j.screenshot(
        "mod-abdomen-mri-t1-coronal", view="coronal", width=900, height=540, colorbar=False
    )
    run("mod-abdomen-mri-t1", j, MOD)


def abdomen_mri_labels():
    lo, hi = MR_SCALE["amos"]
    j = Job(files=[AMOS_MR, AMOS_MR_SEG], window=(1400, 900))
    j.set(layer="amos_0555_mri.nii.gz", patch={"scale": lin(lo, hi), "showIn3D": False})
    j.set(
        layer="amos_0555_seg.nii.gz",
        patch={"labelMode": "fill", "opacity": 0.55, "interpolation": "nearest"},
    )
    j.set(layout="2x2", cursor=AMOS_MR_ORGANS, radiological=False)
    j.set(annotations={"crosshair": True, "colorbar": False, "scaleBar": False})
    frame(
        j,
        AMOS_MR_C,
        {
            "axial": (0.50, AMOS_MR_ORGANS),
            "coronal": (0.50, AMOS_MR_ORGANS),
            "sagittal": (0.44, (31.9, 0.0, 80.0)),
        },
    )
    j.set(
        layer="amos_0555_seg.nii.gz",
        patch={"showIn3D": True, "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True}},
    )
    j.set(view="view3d", camera="A", distance=380)
    j.screenshot("mod-abdomen-mri-labels-2x2", view="grid", width=1400, height=900, crosshair=True, colorbar=False)
    run("mod-abdomen-mri-labels", j, MOD)


# ================================================================================================
# 5. TotalSegmentator-MR — lumbar spine MRI, the pelvis, and a whole body.
# ================================================================================================


def spine_mri():
    lo, hi = MR_SCALE["s0375"]
    j = Job(files=[SPINE_MR, SPINE_MR_SEG], window=(760, 880))
    j.set(layer="s0375/mri.nii.gz", patch={"scale": lin(lo, hi), "showIn3D": False})
    j.set(layer="s0375/seg.nii.gz", patch={"visible": False})
    j.set(layout="1x3", cursor=SPINE_MR_COLUMN, radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": True})
    j.set(view="sagittal", mm_per_px=0.34, center=pan_sagittal(SPINE_MR_C, (11.8, -10.9, 36.6)))
    j.screenshot("mod-spine-mri-sagittal", view="sagittal", width=760, height=900, scale_bar=True, colorbar=False)
    j.set(
        layer="s0375/seg.nii.gz",
        patch={
            "visible": True,
            "labelMode": "fill",
            "opacity": 0.5,
            "interpolation": "nearest",
        },
    )
    j.screenshot("mod-spine-mri-labels-sagittal", view="sagittal", width=760, height=900, scale_bar=True, colorbar=False)
    run("mod-spine-mri", j, MOD)


# The pelvis shot is the hips, the sacrum and the gluteal/iliopsoas muscles — the whole 26-structure
# set at once is a ball of colour, so the surfaces are narrowed with `visibleLabels` (which is what
# `iso3dLabels` reads).
PELVIS_LABELS = [16, 18, 19, 20, 26, 27, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 48, 49]


def pelvis_mri():
    j = Job(files=[PELVIS_MR, PELVIS_MR_SEG], window=(1000, 900))
    j.set(layer="s0132/mri.nii.gz", patch={"visible": False, "showIn3D": False})
    j.set(
        layer="s0132/seg.nii.gz",
        patch={
            "visibleLabels": PELVIS_LABELS,
            "showIn3D": True,
            "interpolation": "nearest",
            "iso3d": {"enabled": True, "opacity": 1.0, "smooth": True},
        },
    )
    j.set(layout="3d-only", cursor=(-22.5, -50.9, -127.6))
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": False})
    j.set(view="view3d", camera="1", distance=480)
    j.screenshot("mod-pelvis-mri-labels-3d", view="view3d", width=900, height=810, colorbar=False)
    run("mod-pelvis-mri", j, MOD)


def wholebody_mri():
    lo, hi = MR_SCALE["s0175"]
    j = Job(files=[BODY_MR, BODY_MR_SEG], window=(620, 1400))
    j.set(layer="s0175/mri.nii.gz", patch={"scale": lin(lo, hi), "showIn3D": False})
    j.set(
        layer="s0175/seg.nii.gz",
        patch={"labelMode": "fill", "opacity": 0.45, "interpolation": "nearest"},
    )
    j.set(layout="1x3", cursor=(0.0, -15.0, -330.0), radiological=False)
    j.set(annotations={"crosshair": False, "colorbar": False, "scaleBar": True})
    j.set(view="coronal", mm_per_px=0.76, center=pan_coronal(BODY_MR_C, (0.0, 0.0, -337.0)))
    j.screenshot("mod-wholebody-mri-coronal", view="coronal", width=620, height=1400, scale_bar=True, colorbar=False)
    run("mod-wholebody-mri", j, MOD)


SHOTS = {
    "hero-abdomen-ct": abdomen_ct,
    "hero-spine-ct": spine_ct,
    "mod-abdomen-ct": abdomen_ct_panes,
    "feat-isosurface-organs-abdomen": abdomen_organs_iso,
    "mod-spine-ct": spine_ct_panes,
    "mod-chest-ct-lung": chest_ct,
    "mod-chest-ct-lung-zoom": chest_ct_zoom,
    "mod-abdomen-mri-t1": abdomen_mri,
    "mod-abdomen-mri-labels": abdomen_mri_labels,
    "mod-spine-mri": spine_mri,
    "mod-pelvis-mri": pelvis_mri,
    "mod-wholebody-mri": wholebody_mri,
}


if __name__ == "__main__":
    names = sys.argv[1:] or list(SHOTS)
    for n in names:
        if n not in SHOTS:
            sys.exit(f"unknown shot {n!r}; one of {', '.join(SHOTS)}")
    for n in names:
        SHOTS[n]()
